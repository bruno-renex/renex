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
  import { notificationsStore } from './stores/notifications.svelte.js';
  import { autoDeleteStore, autoDeleteLabel } from './stores/autoDelete.svelte.js';
  import { profileCache } from './stores/profileCache.svelte.js';
  import { ws } from './lib/ws.js';
  import { heartbeat } from './lib/multidevice.js';
  import { getRecoveryStatus } from './lib/recovery.js';
  import { uploadInboxKeyIfNeeded } from './lib/e2eKeys.js';
  import { redistributeCMKToPeer, redistributeCMKsForSelfDeviceAdded, mirrorRotateCMKForPeer, ensureSecureDmSession } from './lib/chatPipeline.js';
  import { isGuestHandle } from './lib/guestNames.js';
  import { isGuestConvertPending, performGuestConvert, readPendingGuestConvert } from './lib/guestConvert.js';
  import { migratePeerHandle, migrateMyHandle } from './lib/handleMigration.js';
  import { bootstrapBundleRestore, checkRecoveryPromptNeeded } from './lib/cmkBundleSync.js';
  import { clearCachedMasterKey } from './lib/masterKey.js';
  import { getCMKIfExists, rotateCMKForPeer } from './lib/cmk.js';
  import {
    handleIncomingGSKMessage, handleIncomingRequestGSK,
    getMyGSK, getPeerGSK, storeMyGSKForOwnDevices, sendMyGSKToMember,
    rotateMyGSK, deleteAllGSKsForGroup, deletePeerGSK,
    fetchMyGSKFromKV,
  } from './lib/groupCrypto.js';
  import { captureException } from './lib/sentry.js';
  import { apiFetch } from './lib/api.js';
  import LoginModal from './components/LoginModal.svelte';
  import IconStrip from './components/IconStrip.svelte';
  import InboxList from './components/InboxList.svelte';
  import ChatView from './components/ChatView.svelte';
  import VoiceCallOverlay from './components/VoiceCallOverlay.svelte';
  import RecoveryOnboardingModal from './components/RecoveryOnboardingModal.svelte';
  import RecoveryVerifyModal from './components/RecoveryVerifyModal.svelte';
  import RecoveryLoginModal from './components/RecoveryLoginModal.svelte';
  import DeviceLimitModal from './components/DeviceLimitModal.svelte';
  import ToastContainer from './components/ToastContainer.svelte';
  import { toastStore } from './stores/toast.svelte.js';
  import { startVersionPolling } from './lib/versionCheck.js';

  let sessionState = $derived(sessionStore.state);
  let myUser = $derived(userStore.myUser);

  // Debug-Hook: macht die wichtigsten Stores + Crypto-Funktionen für die Browser-
  // Console verfügbar. Nur für manuelle Tests im Dev-Mode — z.B. CMK-Rotation
  // triggern ohne echtes device_removed-Event.
  // import.meta.env.DEV ist nur in `vite serve` true; bei `vite build` (Prod)
  // wird der ganze Block dead-code-eliminiert → kein __renex auf Production.
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    window.__renex = {
      stores: { userStore, inboxStore, chatStore, voiceStore, sessionStore },
      cmk: { rotateCMKForPeer, getCMKIfExists, redistributeCMKToPeer, mirrorRotateCMKForPeer },
      gsk: { getMyGSK, getPeerGSK, rotateMyGSK, fetchMyGSKFromKV, deleteAllGSKsForGroup },
      sync: { bootstrapBundleRestore },
    };
  }

  // Show/hide logic
  let showApp     = $derived(!!myUser && (sessionState === 'authed' || sessionState === 'guest' || sessionState === 'checking' || sessionState === 'idle'));
  let showLogin   = $derived(!myUser && (sessionState === 'anonymous' || sessionState === 'idle' || sessionState === 'checking'));

  // ── Recovery-State (Spec: docs/RECOVERY.md §5, §6) ──
  let recoveryNeedsOnboarding = $state(false);
  let recoveryNeedsVerify = $state(false);

  // ── Device-Limit-Modal (zeigt sich wenn /e2e/inbox/upload 409 device_limit_reached liefert)
  let deviceLimitInfo = $state(null);
  // Recovery-Login wird hier gehalten (nicht in LoginModal), damit das Modal
  // nach erfolgreicher Passkey-Auth NICHT unmountet wird (LoginModal verschwindet
  // sobald myUser gesetzt → sonst würde Step 2 (Phrase) nie sichtbar).
  let recoveryLoginOpen = $state(false);

  // ── WebSocket + Initial Data Loads (when authenticated) ──
  let _bootstrapped = $state(false);
  // Sammelt unsubscribe-Funktionen aller WS-Listener — wird bei _teardownApp
  // sauber abgemeldet, damit nach Logout+Login keine Listener akkumulieren.
  let _wsUnsubs = [];

  // PWA-Update-Polling: läuft immer (auch im LoginModal-State), nicht nur in App.
  // Stoppt sich selbst beim Mount-Tearout via $effect-Cleanup.
  $effect(() => {
    return startVersionPolling((serverVersion) => {
      const text = i18nStore.lang.updateAvailableToast || '🔄 Neue Version verfügbar — Reload';
      toastStore.push(text, {
        kind: 'info',
        ttl: 0,                                // persistent
        action: () => { window.location.reload(); },
      });
    });
  });

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
    // Guest-Convert PRIO-1: muss VOR Initial-Data-Load laufen, sonst lädt
    // loadContacts() für den frisch-registrierten User eine LEERE Liste
    // (Backend hat Migration noch nicht durchgeführt). Convert-API blockiert
    // nicht — bei Fehler läuft Bootstrap wie ein normaler frischer User.
    let convertedInviter = null;
    if (isGuestConvertPending()) {
      console.log('🔁 Guest-Convert pending → /invite/convert wird aufgerufen');
      // Pending VOR performGuestConvert lesen — der Call clearPendingGuestConvert intern.
      const pendingPre = readPendingGuestConvert();
      try {
        const conv = await performGuestConvert();
        if (conv.ok) {
          console.log('✅ Guest-Convert erfolgreich:', conv);
          // E2E-Storage von guest_xxx auf realHandle migrieren (CMK, GSK, rotation-keys etc.)
          // — sonst bleiben CMKs unter dem alten Guest-Handle liegen und Decrypt schlägt fehl.
          if (pendingPre?.token && conv.realHandle) {
            try {
              const r = await migrateMyHandle(pendingPre.token, conv.realHandle);
              if (r.renamed > 0) console.log(`🔁 Self-Migration: ${r.renamed} IDB-Keys umgeschrieben`);
            } catch (e) {
              captureException(e, { context: 'guestConvert.migrateMyHandle' });
            }
          }
          convertedInviter = conv.inviterHandle || null;
          toastStore.push(
            i18nStore.lang.convertSuccess || 'Gast-Konto übernommen ✓',
            { kind: 'success' }
          );
          // URL-Cleanup: ?registerGuest=1 entfernen damit kein Re-Trigger
          try {
            const url = new URL(location.href);
            url.searchParams.delete('registerGuest');
            history.replaceState({}, '', url.toString());
          } catch {}
        } else {
          console.warn('⚠️ Guest-Convert fehlgeschlagen:', conv.error);
        }
      } catch (e) {
        captureException(e, { context: 'guestConvert.bootstrap' });
      }
    }

    // Invite-Accept: Real-User kam über /join?token=... und hat "Sign in & join"
    // geklickt. join/index.html legte `pendingInviteRedirect` in sessionStorage ab.
    // Wir extrahieren den Token, rufen /invite/accept und öffnen den entstehenden
    // Chat. Bei Fehler bleibt der User in der Inbox (Toast informiert).
    let acceptedInviter = null;
    try {
      const redirectUrl = sessionStorage.getItem('pendingInviteRedirect');
      if (redirectUrl) {
        sessionStorage.removeItem('pendingInviteRedirect');
        let inviteToken = null;
        try {
          inviteToken = new URL(redirectUrl).searchParams.get('token');
        } catch {}
        if (inviteToken) {
          console.log('🤝 Invite-Accept pending → /invite/accept wird aufgerufen');
          try {
            const r = await apiFetch('/invite/accept', {
              method: 'POST',
              body: { token: inviteToken },
            });
            if (r.ok && r.data?.convoId) {
              console.log('✅ Invite-Accept erfolgreich:', r.data);
              acceptedInviter = r.data.inviterHandle || null;
            } else {
              console.warn('⚠️ Invite-Accept fehlgeschlagen:', r.error || r.data?.code);
              toastStore.push(
                i18nStore.lang.inviteAcceptFailed || 'Could not accept invite',
                { kind: 'error' }
              );
            }
          } catch (e) {
            captureException(e, { context: 'inviteAccept.bootstrap' });
          }
        }
      }
    } catch {}

    // Initial Data parallel laden (Errors silent — App-Boot darf nicht blockieren)
    await Promise.allSettled([
      inboxStore.loadContacts(),
      inboxStore.loadGroups(),
      inboxStore.loadUnread(),
      voiceStore.loadHistory(),
      notificationsStore.load(),
    ]);

    // Nach erfolgreichem Convert oder Invite-Accept: direkt den Chat mit dem
    // Inviter öffnen (sonst hat der User eine leere ChatView trotz vollem Inbox).
    const openInviter = convertedInviter || acceptedInviter;
    if (openInviter) {
      chatStore.selectChat({
        type: 'dm',
        key: openInviter,
        peer: openInviter,
        name: `@${openInviter}`,
        isOnline: true,
      });
    }

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
            void (async () => {
              const r = await redistributeCMKToPeer(me, msg.from);
              if (r && r.ok && r.distributed > 0) {
                console.log(`✅ CMK an ${msg.from} (${r.distributed} Devices) verteilt`);
                return;
              }
              if (r?.reason !== 'no_local_cmk') return;

              // Fresh-Guest-Path: Gast hat per Fallback-Bootstrap eine CMK in KV
              // hochgeladen, aber wir (Inviter) haben sie nie lokal importiert.
              // ensureSecureDmSession holt sie aus KV (tryFetchAndUnwrapCMK) und
              // speichert lokal. Danach Re-Distribute, damit alle Inviter-Devices
              // synchronisiert sind.
              if (isGuestHandle(msg.from)) {
                console.log(`🔍 Guest cmk_req: versuche KV-Fetch des Gast-CMK für ${msg.from}`);
                try {
                  const cmk = await ensureSecureDmSession(me, msg.from);
                  if (cmk) {
                    console.log(`✅ Guest-CMK aus KV importiert für ${msg.from}, redistribute`);
                    await redistributeCMKToPeer(me, msg.from);
                    return;
                  }
                } catch (e) {
                  captureException(e, { context: 'cmk_req-guest-bootstrap', peer: msg.from });
                }
              }
              console.warn(`⚠️ cmk_req von ${msg.from}: eigene CMK fehlt, cmk_unavailable gesendet`);
            })();
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
        if (msg.type === "message_deleted") {
          chatStore.handleMessageDeleted(msg);
          return;
        }
        if (msg.type === "message_edited") {
          void chatStore.handleMessageEdited(msg);
          return;
        }
        if (msg.type === "reaction_updated") {
          chatStore.handleReactionUpdated(msg);
          return;
        }
        // Group-E2E (Phase 1C): GSK-Distribution + Anfrage-Pattern.
        if (msg.type === "gsk") {
          void handleIncomingGSKMessage(msg).then(stored => {
            if (stored) {
              console.log(`🔑 GSK von ${msg.from} für group=${String(msg.groupId || msg.convoId || '').slice(0,8)} gespeichert`);
              // Gerade arrivierte GSK könnte einen anstehenden Group-Decrypt entlocken.
              // Decrypt-Loop läuft per setTimeout-Backoff und greift beim nächsten Tick.
            }
          });
          return;
        }
        if (msg.type === "request_gsk") {
          void handleIncomingRequestGSK(msg).then(ok => {
            if (ok) console.log(`📨 request_gsk von ${msg.from} → eigene GSK gesendet`);
          });
          return;
        }
        if (!msg.type || msg.type === "message") {
          chatStore.receiveMessage(msg);
        }
      })
    );

    // Neue Gruppe: Empfänger lädt Group-Liste neu, damit sie in der Inbox erscheint.
    _wsUnsubs.push(
      ws.on("group_added", (msg) => {
        console.log("👥 group_added", msg);
        inboxStore.loadGroups().catch(() => {});
      })
    );

    // Auto-Delete: propose/accept/decline/cancel — Peer/Group-Mitglied hat Setting
    // geändert. Lokalen Store updaten + bei DM-Proposal Toast zeigen damit der User
    // weiß dass jetzt eine Akzeptier-Aktion im 3-Punkte-Menü ansteht.
    _wsUnsubs.push(
      ws.on("auto_delete_set", (msg) => {
        autoDeleteStore.applyControl(msg);
        if (msg.action === "propose" && msg.from) {
          const lng = i18nStore.lang;
          const label = autoDeleteLabel(msg.days, lng);
          toastStore.push(
            `📨 @${msg.from} ` +
            (lng.autoDeleteProposalIncoming || 'schlägt Auto-Delete vor:') +
            ' ' + label,
            { kind: 'info' }
          );
        }
      })
    );

    // Group-Membership-Events: Cache invalidieren + GSK-Rotation triggern.
    _wsUnsubs.push(
      ws.on("group_member_joined", (msg) => {
        console.log("👥 group_member_joined", msg);
        const me = userStore.myUser;
        const groupId = msg.groupId;
        if (!me || !groupId) return;
        chatStore.invalidateGroupMembers(groupId);
        // Wenn ICH der Joinende bin: nichts zu tun (eigene GSK kommt via /e2e/group-gsk/fetch
        // beim ersten Send, oder via request_gsk wenn ich Peer-GSKs brauche).
        if (msg.handle && msg.handle.toLowerCase() === me) return;

        // Andernfalls: ich bin schon Member → meine eigene GSK an den neuen Member
        // senden, damit er meine zukünftigen Sends (und alte mit gleichem GSK) lesen kann.
        void (async () => {
          const myGsk = await getMyGSK(groupId);
          if (!myGsk) return;  // Ich habe noch nie in der Gruppe gesendet → nichts zu verteilen.
          await sendMyGSKToMember(groupId, myGsk, msg.handle.toLowerCase());
        })();
      })
    );

    const memberLeaveHandler = (msg) => {
      console.log("👥 member-leave", msg);
      const me = userStore.myUser;
      const groupId = msg.groupId;
      const leaver = (msg.handle || '').toLowerCase();
      if (!me || !groupId || !leaver) return;
      chatStore.invalidateGroupMembers(groupId);

      // Wenn ICH der Leaver bin: alle GSKs für diese Gruppe lokal löschen.
      if (leaver === me) {
        void deleteAllGSKsForGroup(groupId);
        return;
      }

      // Sonst: Leaver-GSK lokal droppen (sein lokal-cached Wert ist obsolet) +
      // EIGENE GSK rotieren, damit der Leaver zukünftige Messages nicht mehr lesen
      // kann (er hat den alten Wert noch lokal). Verteilen an alle verbleibenden Members.
      void (async () => {
        await deletePeerGSK(groupId, leaver);
        const myGsk = await getMyGSK(groupId);
        if (!myGsk) return;  // Nie in der Gruppe gesendet → keine Rotation nötig.

        try {
          const r = await apiFetch(`/groups/members?groupId=${encodeURIComponent(groupId)}`);
          if (!r.ok || !Array.isArray(r.data?.members)) return;
          const members = r.data.members
            .map(m => String(m.member_handle || '').toLowerCase())
            .filter(h => h && h !== me);
          await rotateMyGSK(groupId, members);
        } catch (e) {
          captureException(e, { context: 'rotate-on-member-leave', groupId });
        }
      })();
    };
    _wsUnsubs.push(ws.on("group_member_left", memberLeaveHandler));
    _wsUnsubs.push(ws.on("group_member_removed", memberLeaveHandler));

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
          // Group-GSK: für jede Gruppe in der ich Member bin, eigene GSK
          // (falls vorhanden) für das neue eigene Device per KV ablegen.
          // Backend-Endpoint /e2e/group-gsk/store wrapped neu auf alle eigenen
          // Devices, inklusive des neu hinzugekommenen.
          void (async () => {
            const groups = inboxStore.groups || [];
            for (const g of groups) {
              try {
                const gsk = await getMyGSK(g.id);
                if (gsk) await storeMyGSKForOwnDevices(g.id, gsk);
              } catch (e) {
                captureException(e, { context: 'gsk-self-device-add', groupId: g.id });
              }
            }
          })();
        } else if (msg.from) {
          void redistributeCMKToPeer(me, msg.from, newDeviceInfo);
          // Frischer Peer (z.B. Gast joined gerade) → Contacts neu laden, sonst
          // erscheint die Konversation erst nach manuellem Reload in der Inbox.
          // Backend hat beim /invite/join schon contacts-Eintrag erzeugt + ETag
          // gebumped, aber Frontend-Cache muss explizit gepullt werden.
          inboxStore.loadContacts().catch(() => {});
        }
      })
    );

    _wsUnsubs.push(
      ws.on("device_removed", (msg) => {
        console.log("🗑️ device_removed", msg);
        // Bei Self-Revoke des AKTUELLEN Devices: Logout (wir sind das gerade
        // entfernte Device — nichts mehr zu rotieren, einfach raus).
        if (msg.deviceId === userStore.deviceId && msg.reason !== 'self') {
          sessionStore.logout();
          return;
        }

        // CMK-Rotation bei `reason='user'` (echtes Security-Event, Memory §4.4):
        // Das geleakte Device hatte alle CMKs lokal — ALLE zukünftigen Messages
        // müssen mit neuen CMKs encrypted werden. Alte Messages bleiben lesbar
        // weil die alten CMKs in die rotation map archiviert werden.
        // Bei `self` (Logout-Cleanup) und `auto` (30d Inaktivität): KEINE Rotation
        // — Forward-Secrecy nur bei echtem Security-Event, sonst Cron-Storm.
        if (msg.reason !== 'user') return;

        const me = userStore.myUser;
        if (!me) return;

        if (msg.from === me) {
          // ICH habe ein eigenes Device als kompromittiert markiert (von einem
          // ANDEREN meiner Devices — sonst wäre der Logout-Pfad oben aktiv
          // gewesen). Für JEDE DM einen neuen CMK generieren + redistributen.
          // Achtung: das Removed Device ist bereits aus der KV/D1 entfernt
          // (Backend-side); wrapCMKForInboxDevices nimmt nur noch aktive Devices
          // → der alte CMK ist auf dem geleakten Device tot.
          //
          // Multi-Device-Race-Fix (B11): Nur das initiierende Device rotiert.
          // `msg.initiatedBy` ist die deviceId des Devices das die Revoke-Aktion
          // ausgeführt hat. Andere Devices skippen → keine konkurrierenden CMK-
          // Generationen mit divergenten Werten in KV.
          // Backwards-Compat: wenn initiatedBy nicht gesetzt (alte Backend-Version),
          // rotiert jedes Device wie zuvor (Race möglich, aber nicht schlimmer).
          const myDeviceId = userStore.deviceId;
          const isInitiator = !msg.initiatedBy || msg.initiatedBy === myDeviceId;
          if (!isInitiator) {
            console.log(`🔁 Self-Revoke: skip Rotation — Initiator ist ${msg.initiatedBy} (ich bin ${myDeviceId})`);
            return;
          }
          void (async () => {
            const contacts = (inboxStore.contacts || []).map(c => c.handle).filter(Boolean);
            console.log(`🔁 Self-Revoke (initiator): rotiere CMK für ${contacts.length} DMs`);
            let rotatedCount = 0;
            for (const peer of contacts) {
              try {
                const r = await rotateCMKForPeer(me, peer);
                if (r?.ok) {
                  await redistributeCMKToPeer(me, peer);
                  rotatedCount++;
                }
              } catch (e) {
                captureException(e, { context: 'rotate-on-self-revoke', peer });
              }
            }
            if (rotatedCount > 0) {
              const t = i18nStore.lang.cmkSelfRotateToast || '🔁 Sicherheits-Schlüssel rotiert ({n} Chats)';
              toastStore.push(t.replace('{n}', String(rotatedCount)), { kind: 'success' });
            }
          })();
        } else if (msg.from && msg.from !== me) {
          // Peer hat ein eigenes Device als kompromittiert markiert. Wir spiegeln
          // die Rotation lokal: Old CMK in unsere Map archivieren, neuen CMK aus
          // KV holen (Peer hat ihn frisch hochgeladen für unser Device), active
          // ersetzen. Das stellt Forward-Secrecy symmetric auch auf unserer Seite
          // her — sonst würden zukünftige Sends mit dem alten CMK encrypted, das
          // das geleakte Device kannte.
          void (async () => {
            console.log(`🔁 Peer-Revoke (${msg.from}): mirror-rotation triggern`);
            try {
              const r = await mirrorRotateCMKForPeer(me, msg.from);
              if (r.ok) {
                // Re-Decrypt-Sweep: Messages die zwischen Rotate-Trigger und CMK-
                // Import als 🔐 hängengeblieben sind erneut versuchen.
                chatStore.retryDecryptForPeer(msg.from);
                const t = i18nStore.lang.cmkMirrorRotateToast || '🔁 Sicherheits-Schlüssel mit {peer} rotiert';
                toastStore.push(t.replace('{peer}', msg.from), { kind: 'success' });
              } else {
                console.warn(`Mirror-Rotation für ${msg.from} skipped: ${r.reason}`);
              }
            } catch (e) {
              captureException(e, { context: 'mirror-rotate-on-peer-revoke', peer: msg.from });
            }
          })();
        }
      })
    );

    // invite_accepted: Ein Real-User hat unseren Invite-Link akzeptiert.
    // Pendant zum guest_joined-Event, aber für eingeloggte Empfänger statt Gäste.
    _wsUnsubs.push(
      ws.on("invite_accepted", (msg) => {
        console.log("🤝 invite_accepted", msg);
        const handle = (msg?.handle || '').toLowerCase();
        if (!handle) return;
        inboxStore.loadContacts().catch(() => {});
        inboxStore.loadUnread().catch(() => {});
        const tpl = i18nStore.lang.inviteAcceptedToast || '🤝 {handle} accepted the invite';
        toastStore.push(tpl.replace('{handle}', handle), { kind: 'info' });
      })
    );

    // guest_joined: Ein Gast hat unseren Invite-Link benutzt und ist beigetreten.
    // Backend hat contacts-Eintrag bereits angelegt (siehe inviteRoutes.js); wir
    // laden die Inbox neu, damit der Gast als Kontakt + Unread-Badge erscheinen.
    _wsUnsubs.push(
      ws.on("guest_joined", (msg) => {
        console.log("👤 guest_joined", msg);
        const handle = (msg?.handle || '').toLowerCase();
        if (!handle) return;
        inboxStore.loadContacts().catch(() => {});
        inboxStore.loadUnread().catch(() => {});
        const tpl = i18nStore.lang.guestJoinedToast || '👤 {handle} joined';
        toastStore.push(tpl.replace('{handle}', handle), { kind: 'info' });
      })
    );

    // GUEST_CONVERTED: Gast hat sich registriert → wird zu echtem User mit neuem Handle.
    // Backend migriert contacts (guest_xxx → realHandle). Wir laden Kontakte neu.
    // Wenn aktueller Chat = der konvertierte Gast → Chat auf neuen Handle umschalten.
    _wsUnsubs.push(
      ws.on("GUEST_CONVERTED", async (msg) => {
        console.log("🔁 GUEST_CONVERTED", msg);
        const oldHandle = (msg.oldHandle || '').toLowerCase();
        const newHandle = (msg.newHandle || '').toLowerCase();
        if (!oldHandle || !newHandle) return;

        // ProfileCache invalidieren (alter guest_xxx-Display ist obsolet)
        profileCache.invalidate(oldHandle);
        profileCache.invalidate(newHandle);

        // E2E-Storage migrieren: Peer-Handle wechselt von guest_xxx → realHandle.
        // Sonst lägen CMK/Rotation-Maps unter dem alten Schlüssel und Decrypt
        // bzw. cmk_req-Antworten würden „unrecoverable" liefern.
        try {
          const r = await migratePeerHandle(oldHandle, newHandle);
          if (r.renamed > 0) console.log(`🔁 Peer-Migration: ${r.renamed} IDB-Keys umgeschrieben`);
        } catch (e) {
          captureException(e, { context: 'GUEST_CONVERTED.migratePeerHandle' });
        }

        // Kontakte neu laden (Backend hat user_handle in contacts-Tabelle migriert)
        inboxStore.loadContacts().catch(() => {});

        // Wenn aktuell ein Chat mit dem alten Gast offen ist → auf neuen Handle umschalten
        const sel = chatStore.selectedChat;
        if (sel?.type === 'dm' && sel.peer === oldHandle) {
          chatStore.selectChat({
            type: 'dm',
            key: newHandle,
            peer: newHandle,
            name: `@${newHandle}`,
            isOnline: true,
          });
        }

        // Toast-Hinweis
        const t = i18nStore.lang.guestConvertedToast || '👤 {old} ist jetzt {new}';
        toastStore.push(
          t.replace('{old}', oldHandle).replace('{new}', newHandle),
          { kind: 'info' }
        );
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
          // ProfileCache für betroffenen Handle invalidieren — falls DN sich
          // geändert hat, holt der nächste .get() frisch (statt 5min TTL zu warten).
          if (msg?.from && typeof msg.from === 'string') {
            profileCache.invalidate(msg.from);
          }
          inboxStore.loadContacts().catch(() => {});
        })
      );
    }

    // ── Voice/WebRTC-Signaling-Events ────────────────────
    // Backend pushed bei /voice/ring|answer|ice|hangup|decline|cancel.
    // voiceStore orchestriert RTCPeerConnection.
    _wsUnsubs.push(ws.on("voice:ring", (msg) => {
      console.log("📞 voice:ring", msg.from, msg.callId);
      void voiceStore.receiveCall(msg);
    }));
    _wsUnsubs.push(ws.on("voice:answer", (msg) => {
      console.log("📞 voice:answer", msg.callId);
      void voiceStore._handleAnswer(msg);
    }));
    _wsUnsubs.push(ws.on("voice:ice", (msg) => {
      void voiceStore._handleIce(msg);
    }));
    _wsUnsubs.push(ws.on("voice:hangup", (msg) => {
      console.log("📞 voice:hangup", msg.callId);
      void voiceStore._handlePeerEnd(msg, "hangup");
    }));
    _wsUnsubs.push(ws.on("voice:decline", (msg) => {
      console.log("📞 voice:decline", msg.callId);
      void voiceStore._handlePeerEnd(msg, "decline");
    }));
    _wsUnsubs.push(ws.on("voice:cancel", (msg) => {
      console.log("📞 voice:cancel", msg.callId);
      void voiceStore._handlePeerEnd(msg, "cancel");
    }));

    // E2E Inbox-Key Upload + Heartbeat — sequenziell aber non-blocking
    // (Phase 1A.6 Migration aus renex-legacy/js/e2e.js).
    // Upload ist idempotent — Backend macht UPSERT in D1 + KV.
    // Heartbeat erst NACH erfolgreichem Upload, damit das Device im Backend
    // existiert (sonst returnt /heartbeat 404 für unbekannte deviceIds).
    void (async () => {
      const result = await uploadInboxKeyIfNeeded();
      if (result?.ok) {
        _runHeartbeat();
      } else if (result?.deviceLimit) {
        deviceLimitInfo = result.deviceLimit;
      }
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

    // Recovery-Prompt-Hint: Inkognito/neuer-Browser-Fall — Bundle existiert in R2,
    // aber masterKey nicht im Cache. User würde sonst nur 🔐-Messages sehen ohne
    // zu wissen wie er die freischalten kann. Toast zeigt klickbaren Hint.
    void (async () => {
      const needsPrompt = await checkRecoveryPromptNeeded();
      if (needsPrompt) {
        const text = i18nStore.lang.recoveryPromptToast || '🔐 Chat-History wiederherstellen — Phrase eingeben';
        toastStore.push(text, {
          kind: 'info',
          ttl: 0,                                    // persistent — User soll's bewusst wegklicken
          action: () => { recoveryLoginOpen = true; },
        });
      }
    })();
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
    notificationsStore.clear();
    autoDeleteStore.clear();
    profileCache.clear();
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

<!-- Device-Limit-Modal: 5 (Free) bzw. 10 (Pro) Geräte erreicht -->
<DeviceLimitModal bind:info={deviceLimitInfo} />

<!-- Toast-Stack (CMK-Rotation, future Notifications) -->
<ToastContainer />

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
