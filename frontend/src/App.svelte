<!--
  RENEX — Root App Component (Svelte 5 + Runes)
  Phase 1A.6 Migration in progress.

  Layout (Desktop):
   ┌──────┬──────────────┬─────────────────────────┐
   │ Icon │ Inbox-List   │ Chat-View                │
   │ Strip│ (DMs/Groups/ │ (kommt in nächster       │
   │ 64px │  Voice)      │  Sub-Phase)              │
   │      │ 300px        │ flex                     │
   └──────┴──────────────┴─────────────────────────┘
-->
<script>
  import { userStore } from './stores/user.svelte.js';
  import { i18nStore } from './stores/i18n.svelte.js';
  import { sessionStore } from './stores/session.svelte.js';
  import { inboxStore } from './stores/inbox.svelte.js';
  import { chatStore } from './stores/chat.svelte.js';
  import { voiceStore } from './stores/voice.svelte.js';
  import { ws } from './lib/ws.js';
  import { heartbeat } from './lib/multidevice.js';
  import { getRecoveryStatus } from './lib/recovery.js';
  import { uploadInboxKeyIfNeeded } from './lib/e2eKeys.js';
  import { redistributeCMKToPeer, redistributeCMKsForSelfDeviceAdded } from './lib/chatPipeline.js';
  import { bootstrapBundleRestore } from './lib/cmkBundleSync.js';
  import { clearCachedMasterKey } from './lib/masterKey.js';
  import { getCMKIfExists } from './lib/cmk.js';
  import LoginModal from './components/LoginModal.svelte';
  import IconStrip from './components/IconStrip.svelte';
  import InboxList from './components/InboxList.svelte';
  import ChatView from './components/ChatView.svelte';
  import VoiceCallOverlay from './components/VoiceCallOverlay.svelte';
  import RecoveryOnboardingModal from './components/RecoveryOnboardingModal.svelte';
  import RecoveryVerifyModal from './components/RecoveryVerifyModal.svelte';
  import RecoveryLoginModal from './components/RecoveryLoginModal.svelte';

  let sessionState = $derived(sessionStore.state);
  let myUser = $derived(userStore.myUser);

  // Show/hide logic
  let showApp     = $derived(!!myUser && (sessionState === 'authed' || sessionState === 'guest' || sessionState === 'checking' || sessionState === 'idle'));
  let showLogin   = $derived(!myUser && (sessionState === 'anonymous' || sessionState === 'idle' || sessionState === 'checking'));

  // ── Recovery-State (Spec: docs/RECOVERY.md §5, §6) ──
  let recoveryNeedsOnboarding = $state(false);
  let recoveryNeedsVerify = $state(false);
  // Recovery-Login wird hier gehalten (nicht in LoginModal), damit das Modal
  // nach erfolgreicher Passkey-Auth NICHT unmountet wird (LoginModal verschwindet
  // sobald myUser gesetzt → sonst würde Step 2 (Phrase) nie sichtbar).
  let recoveryLoginOpen = $state(false);

  // ── WebSocket + Initial Data Loads (when authenticated) ──
  let _bootstrapped = $state(false);
  // Sammelt unsubscribe-Funktionen aller WS-Listener — wird bei _teardownApp
  // sauber abgemeldet, damit nach Logout+Login keine Listener akkumulieren.
  let _wsUnsubs = [];

  $effect(() => {
    if (myUser && !_bootstrapped) {
      _bootstrapped = true;
      _bootstrapApp();
    } else if (!myUser && _bootstrapped) {
      _bootstrapped = false;
      _teardownApp();
    }
  });

  async function _bootstrapApp() {
    // Initial Data parallel laden (Errors silent — App-Boot darf nicht blockieren)
    Promise.allSettled([
      inboxStore.loadContacts(),
      inboxStore.loadGroups(),
      inboxStore.loadUnread(),
      voiceStore.loadHistory(),
    ]);

    // WebSocket starten
    ws.start();

    // WS-Listener registrieren UND unsub-Fns sammeln, damit _teardownApp
    // sauber abmelden kann (vermeidet Listener-Akkumulation bei Re-Login).
    _wsUnsubs.push(
      ws.on("message", (msg) => {
        // cmk_req = Peer hat keine CMK lokal, fragt uns aktiv → re-distribuieren
        if (msg.type === "cmk_req") {
          const me = userStore.myUser;
          if (me && msg.from && msg.from !== me) {
            console.log(`📨 cmk_req von ${msg.from} empfangen → versuche redistribute`);
            void redistributeCMKToPeer(me, msg.from).then(r => {
              if (r && r.ok && r.distributed > 0) {
                console.log(`✅ CMK an ${msg.from} (${r.distributed} Devices) verteilt`);
              } else if (r && r.reason === 'no_local_cmk') {
                console.warn(`⚠️ cmk_req von ${msg.from}: eigene CMK fehlt, cmk_unavailable gesendet`);
              }
            });
          }
          return;
        }
        // cmk_unavailable = Peer hat auch keine CMK → wir hören mit Retries auf.
        // ABER: ignorieren wenn wir die CMK bereits lokal haben (z.B. via Bundle-Restore).
        // Verzögerte/race-bedingte cmk_unavailable-Messages können sonst eine fertig
        // recoverte Session fälschlicherweise auf "unrecoverable" setzen.
        if (msg.type === "cmk_unavailable") {
          const me = userStore.myUser;
          if (me && msg.from && msg.from !== me) {
            void getCMKIfExists(msg.from).then(localCmk => {
              if (localCmk) {
                console.log(`📨 cmk_unavailable von ${msg.from} ignoriert — CMK ist bereits lokal`);
                return;
              }
              console.error(`❌ ${msg.from} hat keine CMK — Konversation unwiederherstellbar (beide Devices haben Storage verloren).`);
              chatStore.markCmkUnavailable(msg.from);
            });
          }
          return;
        }
        if (!msg.type || msg.type === "message") {
          chatStore.receiveMessage(msg);
        }
      })
    );

    _wsUnsubs.push(
      ws.on("device_added", (msg) => {
        console.log("📱 device_added", msg);
        const me = userStore.myUser;
        if (!me) return;

        // Push enthält jetzt deviceId+jwk vom neuen Device — wird für KV-Eventual-
        // Consistency-Schutz an redistribute übergeben (retry bis Device in fetch-list).
        const newDeviceInfo = msg.deviceId && msg.jwk
          ? { fromHandle: msg.from, deviceId: msg.deviceId, jwk: msg.jwk }
          : null;

        if (msg.from === me) {
          const contacts = (inboxStore.contacts || []).map(c => c.handle).filter(Boolean);
          if (contacts.length > 0) {
            void redistributeCMKsForSelfDeviceAdded(me, contacts, newDeviceInfo);
          }
        } else if (msg.from) {
          void redistributeCMKToPeer(me, msg.from, newDeviceInfo);
        }
      })
    );

    _wsUnsubs.push(
      ws.on("device_removed", (msg) => {
        console.log("🗑️ device_removed", msg);
        // Bei Self-Revoke des aktuellen Devices: Logout
        if (msg.deviceId === userStore.deviceId && msg.reason !== 'self') {
          sessionStore.logout();
        }
      })
    );

    // Contact-Live-Updates: Backend pusht bei /contacts/* — Liste neu laden.
    // Tatsächliche Backend-Events: contact_request, contact_accepted, contact_update.
    // contact_update ist generisch für cancel/reject/remove (siehe contactRoutes.js).
    const contactEvents = [
      "contact_request",
      "contact_accepted",
      "contact_update",
    ];
    for (const evt of contactEvents) {
      _wsUnsubs.push(
        ws.on(evt, (msg) => {
          console.log("👥", evt, msg);
          inboxStore.loadContacts().catch(() => {});
        })
      );
    }

    // E2E Inbox-Key Upload + Heartbeat — sequenziell aber non-blocking
    // (Phase 1A.6 Migration aus renex-legacy/js/e2e.js).
    // Upload ist idempotent — Backend macht UPSERT in D1 + KV.
    // Heartbeat erst NACH erfolgreichem Upload, damit das Device im Backend
    // existiert (sonst returnt /heartbeat 404 für unbekannte deviceIds).
    void (async () => {
      const uploaded = await uploadInboxKeyIfNeeded();
      if (uploaded) _runHeartbeat();
    })();
    document.addEventListener('visibilitychange', _onVisibilityChange);

    // Recovery-Status check (Spec: RECOVERY.md §5, §6)
    // - hasSalt=false → Onboarding-Modal (Initial-Setup oder Migration für Existing-User)
    // - hasSalt=true && verified=false → Verify-Modal (2. Login)
    // - sonst: kein Modal, App lädt normal
    void _checkRecovery();

    // Bundle-Restore (Spec: RECOVERY.md §13)
    // - Wenn cached masterKey existiert + Bundle in R2 vorhanden:
    //   alle CMKs aus Bundle in IDB importieren (no-op wenn bereits da).
    // - Schützt gegen den Fall: Tab/Browser-State teilweise verloren,
    //   aber masterKey-Cache überlebte → CMKs auto-restoren statt cmk_req-Loop.
    void bootstrapBundleRestore();
  }

  async function _checkRecovery() {
    const status = await getRecoveryStatus();
    if (!status) return;  // Network-Fehler — silent skip, beim nächsten Login retry
    if (!status.hasSalt) {
      recoveryNeedsOnboarding = true;
    } else if (!status.verified) {
      recoveryNeedsVerify = true;
    }
  }

  function _onVisibilityChange() {
    if (document.visibilityState === 'visible') {
      _runHeartbeat();
    }
  }

  function _runHeartbeat() {
    // userStore.deviceId ist per-User-skoped (siehe Bug 13 Fix)
    const id = userStore.deviceId;
    if (!id) return;
    heartbeat(id);  // silent-fail, fire-and-forget
  }

  function _teardownApp() {
    // Alle WS-Listener abmelden (sonst akkumulieren sie bei Re-Login).
    for (const unsub of _wsUnsubs) {
      try { unsub(); } catch {}
    }
    _wsUnsubs = [];
    ws.stop();
    chatStore.clear();
    document.removeEventListener('visibilitychange', _onVisibilityChange);
  }
</script>

{#if showLogin}
  <LoginModal onRecoveryClick={() => recoveryLoginOpen = true} />
{:else if showApp}
  <div class="app" class:chat-open={!!chatStore.selectedChat}>
    <IconStrip />
    <InboxList />
    <ChatView />
  </div>
{/if}

<!-- Voice-Call-Overlay (global, über allem) -->
<VoiceCallOverlay />

<!-- Recovery-Modale (blocken App-Entry bis erledigt) -->
<RecoveryOnboardingModal bind:isOpen={recoveryNeedsOnboarding} />
<RecoveryVerifyModal bind:isOpen={recoveryNeedsVerify} />
<!-- RecoveryLogin auf App-Level: überlebt LoginModal-Unmount nach Passkey-Auth.
     User durchläuft Step 1 (auth) → 2 (phrase) → 3 (success) ohne Unterbrechung. -->
<RecoveryLoginModal bind:isOpen={recoveryLoginOpen} />

<style>
  .app {
    flex: 1;
    display: flex;
    height: 100vh;
    height: 100dvh;
    overflow: hidden;
  }

  /* Mobile: Chat-View overlay-style wenn offen */
  @media (max-width: 768px) {
    .app.chat-open :global(.panel-list),
    .app.chat-open :global(.icon-strip) {
      display: none;
    }
    .app:not(.chat-open) :global(.chat-view) {
      display: none;
    }
  }
</style>
