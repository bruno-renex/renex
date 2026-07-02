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
  import { serverStore } from './stores/serverStore.svelte.js';
  import { voiceStore } from './stores/voice.svelte.js';
  import { notificationsStore } from './stores/notifications.svelte.js';
  import { autoDeleteStore, autoDeleteLabel } from './stores/autoDelete.svelte.js';
  import { presenceStore } from './stores/presence.svelte.js';
  import { profileCache } from './stores/profileCache.svelte.js';
  import { ws } from './lib/ws.js';
  import { heartbeat } from './lib/multidevice.js';
  import { getRecoveryStatus } from './lib/recovery.js';
  import { uploadInboxKeyIfNeeded } from './lib/e2eKeys.js';
  import { publishPqxdhBundleIfNeeded } from './lib/pqxdhPublish.js';
  import { redistributeCMKToPeer, redistributeCMKsForSelfDeviceAdded, mirrorRotateCMKForPeer, ensureSecureDmSession, republishCMKForPeer, decryptPulse } from './lib/chatPipeline.js';
  // (sendNod wird im ChatHeader genutzt, decryptPulse hier für Empfang)
  import { pulseStore } from './stores/pulseStore.svelte.js';
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
    fetchMyGSKFromKV, redistributeGSKsForPeerDeviceAdded,
    distributeMyGSKToMembers,
  } from './lib/groupCrypto.js';
  import { captureException } from './lib/sentry.js';
  import { apiFetch } from './lib/api.js';
  import LoginModal from './components/LoginModal.svelte';
  import IconStrip from './components/IconStrip.svelte';
  import InboxList from './components/InboxList.svelte';
  import ChatView from './components/ChatView.svelte';
  import GuestBanner from './components/GuestBanner.svelte';
  import VoiceCallOverlay from './components/VoiceCallOverlay.svelte';
  import VoiceLogOverlay from './components/VoiceLogOverlay.svelte';
  import RecoveryOnboardingModal from './components/RecoveryOnboardingModal.svelte';
  import RecoveryVerifyModal from './components/RecoveryVerifyModal.svelte';
  import RecoveryLoginModal from './components/RecoveryLoginModal.svelte';
  import DeviceLimitModal from './components/DeviceLimitModal.svelte';
  import MemberActionsModal from './components/MemberActionsModal.svelte';
  import LinkWarningModal from './components/LinkWarningModal.svelte';
  import ServerJoinModal from './components/ServerJoinModal.svelte';

  // Phase 5-Light: ServerJoinModal state (opens auf ?join-server=srv_inv_<hex>)
  let joinModalOpen = $state(false);
  let joinModalToken = $state(null);
  let joinModalInfo  = $state(null);
  $effect(() => {
    if (!joinModalOpen && joinModalToken) {
      joinModalToken = null;
      joinModalInfo  = null;
    }
  });
  import PwaInstallBanner from './components/PwaInstallBanner.svelte';
  import ToastContainer from './components/ToastContainer.svelte';
  import { bumpLoginCount } from './lib/pwaInstall.js';
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

  // ── Guest-Register-Flow ───────────────────────────────────
  // Gast klickt "Account erstellen" im GuestBanner → Redirect zu /?registerGuest=1.
  // Wir wollen dann das LoginModal anzeigen (für Passkey-Create), auch wenn die
  // Gast-Session noch aktiv ist. Nach erfolgreichem Register kickt der $effect
  // unten den performGuestConvert.
  let wantsRegisterAsGuest = $state(
    typeof location !== 'undefined' &&
    new URLSearchParams(location.search).get('registerGuest') === '1'
  );

  // Show/hide logic
  let showApp     = $derived(
    !!myUser &&
    (sessionState === 'authed' || sessionState === 'guest' || sessionState === 'checking' || sessionState === 'idle') &&
    !(userStore.isGuest && wantsRegisterAsGuest)  // Force-Login statt Guest-UI
  );
  let showLogin   = $derived(
    (!myUser && (sessionState === 'anonymous' || sessionState === 'idle' || sessionState === 'checking')) ||
    (userStore.isGuest && wantsRegisterAsGuest)   // Gast will Account erstellen
  );

  // ── Recovery-State (Spec: docs/RECOVERY.md §5, §6) ──
  let recoveryNeedsOnboarding = $state(false);
  let recoveryNeedsVerify = $state(false);

  // ── Device-Limit-Modal (zeigt sich wenn /e2e/inbox/upload 409 device_limit_reached liefert)
  let deviceLimitInfo = $state(null);
  // Recovery-Login wird hier gehalten (nicht in LoginModal), damit das Modal
  // nach erfolgreicher Passkey-Auth NICHT unmountet wird (LoginModal verschwindet
  // sobald myUser gesetzt → sonst würde Step 2 (Phrase) nie sichtbar).
  let recoveryLoginOpen = $state(false);

  // ── Guest-Register Post-Login Convert ─────────────────
  // Nach erfolgreichem Passkey-Register (Gast → Echter Account) ist die
  // Session AUTHED. Jetzt erst kann /invite/convert aufgerufen werden
  // (requireSession-Endpoint), um die Migration der Group-/DM-/Contact-
  // Daten von guest_xxx → realHandle zu starten.
  // Trigger: sessionState wechselt zu 'authed' UND pendingGuestConvert
  // ist in sessionStorage (vom GuestBanner-Klick gesetzt).
  let _convertAttempted = false;
  $effect(() => {
    if (
      sessionState === 'authed' &&
      !_convertAttempted &&
      readPendingGuestConvert()
    ) {
      _convertAttempted = true;
      // Pending VOR performGuestConvert lesen — der Call clearPendingGuestConvert intern.
      const pendingPre = readPendingGuestConvert();
      void (async () => {
        try {
          console.log('🔁 Post-Register: /invite/convert wird aufgerufen');
          const conv = await performGuestConvert();
          if (conv.ok) {
            // IDB-Migration: alle CMK/GSK/rotation-map-Keys von guest_xxx → realHandle
            // umbenennen UND re-encrypten (Storage-Key ist per-pair handle-bound,
            // ohne Re-Encryption decrypted nichts mehr). Muss VOR dem Inbox-Reload
            // passieren, damit der erste Decrypt-Sweep die migrierten Keys findet.
            if (pendingPre?.oldGuestHandle && conv.realHandle) {
              try {
                const r = await migrateMyHandle(pendingPre.oldGuestHandle, conv.realHandle);
                if (r?.renamed > 0) {
                  console.log(`🔁 Self-Migration: ${r.renamed} IDB-Keys umgeschrieben (${pendingPre.oldGuestHandle} → ${conv.realHandle})`);
                }
                // CMK-Republish: KV-Wrap unter altem `cid=[guest_xxx,peer].sort()` liegt
                // weiterhin im KV. Empfänger sucht nach Convert unter `[realHandle,peer]`
                // und findet nichts → cmk_req → wir offline → unrecoverable.
                // Daher pro migrated peer einen frischen Wrap unter dem neuen cid posten.
                for (const peer of (r?.migratedDmPeers || [])) {
                  void republishCMKForPeer(conv.realHandle, peer).then(res => {
                    if (res.ok) console.log(`📤 CMK-Republish ${peer}: ${res.wrapped} device-wraps publiziert`);
                    else console.warn(`⚠️ CMK-Republish ${peer} failed: ${res.reason}`);
                  });
                }
              } catch (e) {
                captureException(e, { context: 'postRegisterConvert.migrateMyHandle' });
              }
            }
            toastStore.push(
              i18nStore.lang.convertSuccess || 'Gast-Konto übernommen ✓',
              { kind: 'success' }
            );
            wantsRegisterAsGuest = false;
            // URL aufräumen
            try {
              const url = new URL(location.href);
              url.searchParams.delete('registerGuest');
              history.replaceState({}, '', url.toString());
            } catch {}
            // WebSocket reconnecten — vorher lief er unter guest_xxx's DO,
            // jetzt brauchen wir frischen Ticket für realHandle's DO. Sonst
            // gehen Push-Events (Messages, request_gsk, etc.) an den alten DO
            // und unser Tab kriegt nichts → andere Members sehen unsere
            // Sends erst nach Reload (Bug-Report).
            try {
              await ws.reconnect();
              console.log('🔁 WS reconnected unter realHandle');
            } catch (e) {
              captureException(e, { context: 'postConvert.wsReconnect' });
            }
            // Inbox neu laden, sonst fehlt der frisch-migrierte Inviter/Group
            await Promise.allSettled([
              inboxStore.loadContacts(),
              inboxStore.loadGroups(),
            ]);
            // Group-Convert: GSK an alle Members unter dem neuen Handle redistribuieren.
            // Ohne das haben andere Members die GSK noch unter peerGSK:guest_xxx:groupId
            // gespeichert — Messages vom konvertierten User (sender=realHandle) finden
            // keinen peerGSK-Lookup und bleiben verschlüsselt.
            if (conv.convoType === 'group' && conv.convoId) {
              try {
                const myGsk = await getMyGSK(conv.convoId);
                if (myGsk) {
                  const r = await apiFetch(`/groups/members?groupId=${encodeURIComponent(conv.convoId)}`);
                  if (r.ok && Array.isArray(r.data?.members)) {
                    const memberHandles = r.data.members
                      .map(m => String(m.member_handle || '').toLowerCase())
                      .filter(Boolean);
                    const distrib = await distributeMyGSKToMembers(conv.convoId, myGsk, memberHandles);
                    console.log(`🔁 Post-Convert GSK redistribute: ${distrib.delivered}/${distrib.recipients} Members in Gruppe ${conv.convoId.slice(0,8)}`);
                  }
                }
              } catch (e) {
                captureException(e, { context: 'postRegisterConvert.gskRedistribute' });
              }
            }
            // Den frisch-migrierten Chat öffnen
            if (conv.convoType === 'group' && conv.convoId) {
              chatStore.selectChat({ type: 'group', key: conv.convoId, name: 'Group' });
            } else if (conv.inviterHandle) {
              chatStore.selectChat({
                type: 'dm',
                key: conv.inviterHandle,
                peer: conv.inviterHandle,
                name: `@${conv.inviterHandle}`,
              });
            }
          } else {
            console.warn('⚠️ Post-Register-Convert fehlgeschlagen:', conv.error);
            toastStore.push(conv.error || 'Convert fehlgeschlagen', { kind: 'error' });
          }
        } catch (e) {
          captureException(e, { context: 'postRegisterGuestConvert' });
        }
      })();
    }
  });

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
    // Engagement-Counter für PWA-Smart-Banner (rein localStorage, kein Server-Touch).
    try { bumpLoginCount(); } catch {}

    // Guest-Convert PRIO-1: muss VOR Initial-Data-Load laufen, sonst lädt
    // loadContacts() für den frisch-registrierten User eine LEERE Liste
    // (Backend hat Migration noch nicht durchgeführt). Convert-API blockiert
    // nicht — bei Fehler läuft Bootstrap wie ein normaler frischer User.
    let convertedInviter = null;
    // Skip performGuestConvert solange Session noch Gast ist — /invite/convert
    // braucht eine ECHTE Session (requireSession). Bei einem Klick auf "Account
    // erstellen" im GuestBanner landet der User mit ?registerGuest=1 hier
    // BEVOR er den Passkey-Register-Flow durchlaufen hat. Der eigentliche
    // Convert läuft dann via $effect (siehe unten) nach Session-Wechsel
    // guest → authed.
    if (isGuestConvertPending() && !userStore.isGuest) {
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
              // CMK-Republish: siehe Erklärung im post-register $effect.
              for (const peer of (r?.migratedDmPeers || [])) {
                void republishCMKForPeer(conv.realHandle, peer).then(res => {
                  if (res.ok) console.log(`📤 CMK-Republish ${peer}: ${res.wrapped} device-wraps publiziert`);
                  else console.warn(`⚠️ CMK-Republish ${peer} failed: ${res.reason}`);
                });
              }
            } catch (e) {
              captureException(e, { context: 'guestConvert.migrateMyHandle' });
            }
          }
          convertedInviter = conv.inviterHandle || null;
          // Group-Convert: GSK-Redistribution analog zum post-register Flow.
          if (conv.convoType === 'group' && conv.convoId) {
            try {
              const myGsk = await getMyGSK(conv.convoId);
              if (myGsk) {
                const r = await apiFetch(`/groups/members?groupId=${encodeURIComponent(conv.convoId)}`);
                if (r.ok && Array.isArray(r.data?.members)) {
                  const memberHandles = r.data.members
                    .map(m => String(m.member_handle || '').toLowerCase())
                    .filter(Boolean);
                  const distrib = await distributeMyGSKToMembers(conv.convoId, myGsk, memberHandles);
                  console.log(`🔁 Bootstrap-Convert GSK redistribute: ${distrib.delivered}/${distrib.recipients} Members`);
                }
              }
            } catch (e) {
              captureException(e, { context: 'bootstrapConvert.gskRedistribute' });
            }
          }
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

    // Initial Data parallel laden (Errors silent — App-Boot darf nicht blockieren).
    // Gäste: voiceStore + notificationsStore skippen (Voice-Calls + Notifications-
    // Settings sind by-design nur für echte Sessions, sonst 401-Cascade).
    const isGuestBoot = userStore.isGuest;
    await Promise.allSettled([
      inboxStore.loadContacts(),
      inboxStore.loadGroups(),
      inboxStore.loadUnread(),
      ...(isGuestBoot ? [] : [voiceStore.loadHistory(), notificationsStore.load()]),
    ]);

    // Presence-Polling starten — Backend hat KEINEN WS-Broadcast bei
    // Status-Change, daher 30s-Polling über alle aktiven Kontakte.
    // getHandles wird bei jedem Tick neu evaluiert, damit neu hinzugekommene
    // Kontakte automatisch mit-gepollt werden.
    presenceStore.startPolling(() =>
      (inboxStore.contacts || []).map(c => c.handle).filter(Boolean)
    );

    // ── Badge + Tab-Title sync ──────────────────────────────────
    // Frontend ist Source-of-Truth für unread-Counts. Reaktiver Effect
    // updated bei jeder Änderung:
    //   - document.title  ("(N) RENEX")
    //   - SW-Badge        (postMessage SET_BADGE → setAppBadge / clearAppBadge)
    //
    // Vorher: SW inkrementierte den Badge bei jedem Push (sw.js:75 count++),
    //   aber der Frontend-Read-State (markRead) wurde nie zurück-synchronisiert
    //   → Badge zählte nur hoch. Tab-Title wurde nirgends gesetzt → blieb "RENEX".
    const ORIGINAL_TITLE = document.title || 'RENEX';
    const _stopBadgeSync = $effect.root(() => {
      $effect(() => {
        const total = (inboxStore.totalUnreadDms || 0) + (inboxStore.totalUnreadGroups || 0);
        // Tab-Title: WhatsApp/Slack-Pattern "(N) AppName"
        document.title = total > 0 ? `(${total}) ${ORIGINAL_TITLE}` : ORIGINAL_TITLE;
        // SW-Badge: Frontend treibt den Counter, SW spiegelt nur. So bleibt
        // der PWA-App-Icon-Badge bei jedem markRead/Chat-Open synchron.
        if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
          try {
            navigator.serviceWorker.controller.postMessage({
              type: 'SET_BADGE',
              count: total,
            });
          } catch {}
        }
      });
    });
    _wsUnsubs.push(() => {
      try { _stopBadgeSync(); } catch {}
      // Auf Logout/Disconnect Title wieder neutralisieren + Badge clearen
      document.title = ORIGINAL_TITLE;
      if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
        try {
          navigator.serviceWorker.controller.postMessage({ type: 'SET_BADGE', count: 0 });
        } catch {}
      }
    });

    // Push-Notification-Deep-Link: SW öffnet die PWA mit /?with=<peer> (DM)
    // oder /?group=<id> (Group). Helper extrahiert Params, öffnet Chat,
    // räumt URL auf. Wird sowohl beim Bootstrap (Cold-Open via Notification)
    // als auch bei sw-postMessage 'navigate' (PWA war bereits offen) gerufen.
    const handleDeepLink = (url) => {
      try {
        const u = url ? new URL(url, location.origin) : location;
        const p = new URLSearchParams(u.search);
        const dmPeer = p.get('with');
        const groupId = p.get('group');
        const groupName = p.get('name');
        console.log(`📞 handleDeepLink: url-arg=${url || '(cold-boot)'} location.search=${location.search} with=${dmPeer} call=${p.get('call')}`);

        // Server-Invite-Link (?join-server=srv_inv_<hex>): Modal mit Turnstile (Phase 5-Light).
        const joinToken = p.get('join-server');
        if (joinToken && /^srv_inv_[a-f0-9]{32}$/.test(joinToken)) {
          // Param sofort strippen, sonst re-trigger bei jedem Reload.
          const cleaned = new URL(location.href);
          cleaned.searchParams.delete('join-server');
          history.replaceState(null, '', cleaned.toString());
          void (async () => {
            const lng = i18nStore.lang;
            const info = await serverStore.getInviteInfo(joinToken);
            if (!info.ok) {
              toastStore.push(lng.inviteInvalid || 'Invite-Link ungültig oder abgelaufen', { kind: 'error' });
              return;
            }
            if (info.info.alreadyMember) {
              await serverStore.loadServers();
              serverStore.selectServer(info.info.serverId);
              toastStore.push(lng.inviteAlreadyMember || 'Du bist bereits Mitglied dieses Servers', { kind: 'info' });
              return;
            }
            // Phase 5-Light: ServerJoinModal mit Turnstile öffnen statt native confirm()
            joinModalToken = joinToken;
            joinModalInfo  = info.info;
            joinModalOpen  = true;
          })();
          return true;
        }

        // Voice-Call von Notification-Tap (?call=1): PWA war zu, voice:ring
        // WS-Event ging verloren. Backend hat das Ring-Event in KV gespeichert
        // (voice_ring:<me>) — wir holen's via /voice/active und triggern
        // receiveCall manuell, damit der Annehmen/Ablehnen-Dialog erscheint.
        if (p.get('call') === '1') {
          console.log(`📞 deep-link call=1 detected, fetching /voice/active...`);
          apiFetch('/voice/active').then(res => {
            console.log(`📞 /voice/active response:`, { active: res?.active, hasRingEvent: !!res?.ringEvent, callId: res?.ringEvent?.callId?.slice(0,8) });
            if (res?.active && res?.ringEvent) {
              console.log(`📞 calling voiceStore.receiveCall with ringEvent`);
              void voiceStore.receiveCall(res.ringEvent);
            } else {
              console.warn(`📞 /voice/active returned no active call — banner-tap too late or voice_state expired`);
              const lng = i18nStore.lang;
              const callerName = dmPeer ? `@${dmPeer.toLowerCase()}` : (lng.someone || 'Jemand');
              toastStore.push(
                (lng.voiceCallEnded || 'Anruf von {peer} wurde bereits beendet').replace('{peer}', callerName),
                { kind: 'info', duration: 5000 }
              );
            }
          }).catch(e => {
            console.warn(`📞 /voice/active fetch failed:`, e?.message);
          });
          // call-Param aus URL strippen, sonst re-triggered bei jedem Reload
          if (!url) {
            const cleaned = new URL(location.href);
            cleaned.searchParams.delete('call');
            history.replaceState(null, '', cleaned.toString());
          }
        }
        if (dmPeer && /^[a-z0-9_]+$/i.test(dmPeer)) {
          chatStore.selectChat({
            type: 'dm',
            key: dmPeer.toLowerCase(),
            peer: dmPeer.toLowerCase(),
            name: `@${dmPeer.toLowerCase()}`,
          });
          return true;
        }
        if (groupId && /^[0-9a-f-]{36}$/i.test(groupId)) {
          chatStore.selectChat({
            type: 'group',
            key: groupId,
            name: groupName ? decodeURIComponent(groupName) : 'Group',
          });
          return true;
        }
      } catch {}
      return false;
    };

    // Cold-Boot: zuerst Push-Deep-Link prüfen, sonst Convert/Invite-Inviter.
    const handledByDeepLink = handleDeepLink();
    if (!handledByDeepLink) {
      const openInviter = convertedInviter || acceptedInviter;
      if (openInviter) {
        chatStore.selectChat({
          type: 'dm',
          key: openInviter,
          peer: openInviter,
          name: `@${openInviter}`,
        });
      } else if (userStore.isGuest && !chatStore.selectedChat) {
        // Gast-Mode: Konversation auto-öffnen. Gast hat per Definition
        // genau EINE Konversation (DM oder Group, gebunden an die Session).
        // Reduziertes UI rendert eh nur die ChatView, deshalb müssen wir
        // sicherstellen dass dort etwas drin ist.
        const groups = inboxStore.groups || [];
        const contacts = inboxStore.contacts || [];
        if (groups.length > 0) {
          chatStore.selectChat({
            type: 'group',
            key: groups[0].id,
            name: groups[0].name,
          });
        } else if (contacts.length > 0) {
          const c = contacts[0];
          chatStore.selectChat({
            type: 'dm',
            key: c.handle,
            peer: c.handle,
            name: `@${c.handle}`,
          });
        }
      }
    } else {
      // Query-Params nach Verarbeitung aus der URL entfernen (sonst öffnet
      // jeder Reload erneut den Push-Chat).
      try { history.replaceState({}, '', location.pathname); } catch {}
    }

    // Warm-Open: SW-postMessage 'navigate' bei bereits laufender PWA. SW
    // ruft das, wenn der User eine Notification anklickt während ein Tab
    // schon offen ist (focus statt openWindow).
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'navigate' && typeof e.data.url === 'string') {
          handleDeepLink(e.data.url);
        }
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
          // In-App-Toast: jemand hat auf MEINE Message reagiert.
          // Filter: nur "added" (kein Spam bei Removal), nur fremde Reaktoren
          // (kein Multi-Device-Self-Echo), nur wenn ich der Message-Autor bin,
          // und nur wenn der betreffende Chat NICHT gerade offen ist (sonst
          // sieht der User die Reaktion bereits live im ChatView).
          if (
            msg.action === "added"
            && msg.from
            && msg.from !== userStore.myUser
            && msg.msgAuthor === userStore.myUser
            && msg.emoji
          ) {
            const sel = chatStore.selectedChat;
            const isGroupReact = !!msg.groupName;
            const chatKey = isGroupReact ? msg.convoId : msg.from;
            // Channel vs. Group unterscheiden: gecachte Channel-Info liefert serverId
            // (nötig für korrekte selectChat-Navigation aus dem Toast).
            const channelInfo = isGroupReact ? serverStore.getChannelInfo(msg.convoId) : null;
            const isViewingChat = sel
              && (((sel.type === 'group' || sel.type === 'channel') && sel.key === chatKey)
                  || (sel.type === 'dm' && (sel.peer === chatKey || sel.key === chatKey)));
            if (!isViewingChat) {
              const lng = i18nStore.lang;
              const peerDn = profileCache.get(msg.from) || `@${msg.from}`;
              const tmpl = isGroupReact
                ? (lng.reactionToastGroup || '{emoji} {peer} hat in {group} reagiert')
                : (lng.reactionToastDm    || '{emoji} {peer} hat reagiert');
              // Click-Target: zum reagierten Chat öffnen + zur Message scrollen.
              // ChatView's $effect picks pendingJumpTo + messages.length auf und
              // jumpt sobald das Bubble-DOM-Element verfügbar ist.
              const chatNav = isGroupReact
                ? (channelInfo
                    ? { type: 'channel', key: msg.convoId, name: msg.groupName || 'Channel', serverId: channelInfo.serverId }
                    : { type: 'group', key: msg.convoId, name: msg.groupName || 'Group' })
                : { type: 'dm',    key: msg.from,    peer: msg.from, name: `@${msg.from}` };
              toastStore.push(
                tmpl
                  .replace('{emoji}', msg.emoji)
                  .replace('{peer}', peerDn)
                  .replace('{group}', msg.groupName || ''),
                {
                  kind: 'info',
                  ttl: 7000, // länger als default — User braucht Zeit zu antippen
                  action: msg.messageId
                    ? () => { void chatStore.selectChatAndJump(chatNav, msg.messageId); }
                    : undefined,
                }
              );
            }
          }
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
        // Pulse (Phase 6.5): ambient Presence-Frame. Nur entschlüsseln wenn Pulse
        // aktiv UND vom gerade offenen Chat — spart Decrypt-CPU bei 5-10Hz.
        if (msg.type === "pulse") {
          const me = userStore.myUser;
          const from = String(msg.from || '').toLowerCase();
          if (me && pulseStore.enabled && pulseStore.activePeer === from) {
            void decryptPulse(msg, me).then((p) => {
              if (!p) return;
              if (p.nod) pulseStore.triggerNod();                 // „Nicken" → warmes Aufblühen
              else pulseStore.onPeerFrame(from, p.energy, p.mode, performance.now());
            });
          }
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

    // Group-Rename: Inbox-Liste + aktiver ChatHeader live updaten.
    // Backend pusht an alle Members inkl. Renamender (senderHandle=null in
    // pushToGroupMembers) — daher idempotent zum optimistischen Update in
    // ChatHeaderMenu.onRename. System-Bubble nur für ANDERE Members lokal
    // einfügen (Renamender hat sie bereits durch optimistischen Pfad).
    _wsUnsubs.push(
      ws.on("group_renamed", (msg) => {
        console.log("👥 group_renamed", msg);
        if (!msg.groupId || !msg.newName) return;
        inboxStore.renameGroup(msg.groupId, msg.newName);
        chatStore.renameSelectedIfMatch(msg.groupId, msg.newName);
        const meHandle = userStore.myUser;
        if (msg.renamedBy && msg.renamedBy !== meHandle) {
          chatStore.appendLocalSystemMessage(
            msg.groupId,
            `${msg.renamedBy} hat die Gruppe in "${msg.newName}" umbenannt`,
            msg.ts
          );
        }
      })
    );

    // Auto-Delete: propose/accept/decline/cancel — Peer/Group-Mitglied hat Setting
    // geändert. Lokalen Store updaten + bei DM-Proposal Toast zeigen damit der User
    // weiß dass jetzt eine Akzeptier-Aktion im 3-Punkte-Menü ansteht.
    //
    // System-Bubbles werden lokal eingefügt für sofortiges Feedback. Backend
    // persistiert dieselbe Info in D1 — beim nächsten Reload kommt sie aus der
    // History (deutsch hardcoded, siehe groupRoutes.js / autoDeleteRoutes.js).
    // Self-Skip via msg.from !== me, da der Sender via optimistisches Update
    // im autoDeleteStore.set() bereits Feedback bekommt.
    _wsUnsubs.push(
      ws.on("auto_delete_set", (msg) => {
        autoDeleteStore.applyControl(msg);
        const lng = i18nStore.lang;
        const me = userStore.myUser;

        // DM-Konsens-Modell: Vorschlag → Empfänger bekommt Toast.
        if (msg.action === "propose" && msg.from) {
          const label = autoDeleteLabel(msg.days, lng);
          toastStore.push(
            `📨 @${msg.from} ` +
            (lng.autoDeleteProposalIncoming || 'schlägt Auto-Delete vor:') +
            ' ' + label,
            { kind: 'info' }
          );
        }

        // ── GROUP (Last-Write-Wins) ────────────────────
        // accept/cancel von einem ANDEREN Member → Toast + lokale System-Bubble.
        if (msg.groupId && msg.from && msg.from !== me) {
          if (msg.action === "accept") {
            const label = autoDeleteLabel(msg.days, lng);
            toastStore.push(
              `⏱ @${msg.from} ` +
              (lng.autoDeleteSetByPeer || 'hat Auto-Delete gesetzt:') +
              ' ' + label,
              { kind: 'info' }
            );
            chatStore.appendLocalSystemMessage(
              msg.groupId,
              `${msg.from} ` +
              (lng.autoDeleteSetByPeer || 'hat Auto-Delete gesetzt:') +
              ' ' + label,
              msg.ts
            );
          } else if (msg.action === "cancel") {
            toastStore.push(
              `⏱ @${msg.from} ` +
              (lng.autoDeleteDisabledByPeer || 'hat Auto-Delete deaktiviert.'),
              { kind: 'info' }
            );
            chatStore.appendLocalSystemMessage(
              msg.groupId,
              `${msg.from} ` +
              (lng.autoDeleteDisabledByPeer || 'hat Auto-Delete deaktiviert.'),
              msg.ts
            );
          }
        }

        // ── DM (Konsens-Modell) ───────────────────────
        // accept = wirksam geworden (vom Peer akzeptiert). cancel = wirksam
        // deaktiviert. decline = bleibt ephemer (kein wirksamer Zustandswechsel).
        // convoId = sortierte Handles "alphabet erst".
        if (!msg.groupId && msg.from && msg.from !== me) {
          const convoId = [me, msg.from].sort().join(':');
          if (msg.action === "accept") {
            // proposer = Urheber des Vorschlags. Konsistent zur persistenten
            // D1-Message in autoDeleteRoutes.js (proposer als from_user).
            // Fallback: msg.from (acceptor), falls Backend kein proposed_by liefert.
            const proposer = msg.proposed_by || msg.from;
            const label = autoDeleteLabel(msg.days, lng);
            toastStore.push(
              `⏱ @${proposer} ` +
              (lng.autoDeleteSetByPeer || 'hat Auto-Delete gesetzt:') +
              ' ' + label,
              { kind: 'info' }
            );
            chatStore.appendLocalSystemMessage(
              convoId,
              `${proposer} ` +
              (lng.autoDeleteSetByPeer || 'hat Auto-Delete gesetzt:') +
              ' ' + label,
              msg.ts
            );
          } else if (msg.action === "cancel" && !msg.original_days) {
            // Nur bei "wirksam deaktiviert" — wenn original_days gesetzt,
            // wurde nur ein Vorschlag zurückgezogen, kein wirksamer Wechsel.
            toastStore.push(
              `⏱ @${msg.from} ` +
              (lng.autoDeleteDisabledByPeer || 'hat Auto-Delete deaktiviert.'),
              { kind: 'info' }
            );
            chatStore.appendLocalSystemMessage(
              convoId,
              `${msg.from} ` +
              (lng.autoDeleteDisabledByPeer || 'hat Auto-Delete deaktiviert.'),
              msg.ts
            );
          }
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

        // Wenn ICH der Joinende bin: Inbox-Liste neuladen damit die neue Gruppe
        // in der Sidebar erscheint. Backend sendet `group_added` typischerweise
        // nur beim Group-Create (initial members), NICHT beim nachträglichen
        // Invite — daher hier explizit reloaden.
        // Eigene GSK kommt via /e2e/group-gsk/fetch beim ersten Send, oder via
        // request_gsk wenn ich Peer-GSKs zum Lesen brauche.
        if (msg.handle && msg.handle.toLowerCase() === me) {
          inboxStore.loadGroups().catch(() => {});
          return;
        }

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

      // Wenn ICH der Leaver bin (z.B. anderer Admin hat mich gekickt, oder
      // ein anderes Device hat /groups/leave gerufen): GSKs droppen + Group
      // aus der Inbox entfernen + ggf. aktuelle Chat-View deselektieren.
      if (leaver === me) {
        void deleteAllGSKsForGroup(groupId);
        inboxStore.removeGroup(groupId);
        if (chatStore.selectedChat?.type === 'group' && chatStore.selectedChat?.key === groupId) {
          chatStore.selectChat(null);
        }
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

        // VISION §6: User-sichtbarer Toast — eigenes neues Device vs Kontakt-Device.
        // Wir filtern das CURRENT-Device aus (das hat sich gerade selbst registriert
        // und braucht keine Notification). Backend liefert (noch) kein device_name,
        // wir zeigen daher die deviceId-Kürzel als Identifier.
        if (msg.deviceId && msg.deviceId !== userStore.deviceId) {
          const lng = i18nStore.lang;
          const shortId = String(msg.deviceId).slice(0, 12);
          const text = msg.from === me
            ? (lng.deviceAddedSelfToast || `📱 Neues Gerät hinzugefügt (${shortId}…). Wenn das nicht du warst — sofort entfernen unter Profil → Geräte.`)
            : (lng.deviceAddedPeerToast || `📱 @${msg.from} hat ein neues Gerät hinzugefügt (${shortId}…)`);
          toastStore.push(text, { kind: msg.from === me ? 'warn' : 'info', ttl: 7000 });
        }

        if (msg.from === me) {
          const contacts = (inboxStore.contacts || []).map(c => c.handle).filter(Boolean);
          if (contacts.length > 0) {
            void redistributeCMKsForSelfDeviceAdded(me, contacts, newDeviceInfo);
          }
          // Group-GSK: für jede Gruppe in der ich Member bin, eigene GSK
          // (falls vorhanden) für das neue eigene Device per KV ablegen.
          // newDeviceInfo durchreichen → storeMyGSKForOwnDevices retried bis
          // das neue Device im KV-Index sichtbar ist (Race-Schutz).
          // Spec: docs/GROUPS_MULTIDEVICE.md §4.1
          // Phase 4c: dasselbe für Channels (bekannte via serverStore-Cache).
          void (async () => {
            const groups = inboxStore.groups || [];
            const channels = serverStore.getKnownChannels();
            const convos = [...groups, ...channels.map(c => ({ id: c.id }))];
            for (const g of convos) {
              try {
                const gsk = await getMyGSK(g.id);
                if (gsk) await storeMyGSKForOwnDevices(g.id, gsk, newDeviceInfo);
              } catch (e) {
                captureException(e, { context: 'gsk-self-device-add', groupId: g.id });
              }
            }
          })();
        } else if (msg.from) {
          void redistributeCMKToPeer(me, msg.from, newDeviceInfo);
          // Phase 1C: GSK-Re-Wrap für alle Gruppen, in denen me + peer beide
          // Member sind. Ohne diesen Hook könnte das neue Peer-Device meine
          // zukünftigen Group-Messages nicht decrypten.
          // Spec: docs/GROUPS_MULTIDEVICE.md §4.2
          // Phase 4c: Channels mit-iteriert via serverStore-Channel-Cache.
          // Self-Healing-Fallback via `request_gsk` deckt nicht-gecachte
          // Channels automatisch beim nächsten Decrypt-Attempt ab.
          if (newDeviceInfo) {
            const channels = serverStore.getKnownChannels();
            const allConvos = [
              ...(inboxStore.groups || []),
              ...channels.map(c => ({ id: c.id })),
            ];
            void redistributeGSKsForPeerDeviceAdded(
              me, msg.from, newDeviceInfo, allConvos
            );
          }
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

        // VISION §6: Toast für entferntes Device. Reason-Differenzierung:
        //  - 'user' (Security-Aktion) — prominenter Warn-Toast inkl. Rotation-Hinweis
        //  - 'auto' (30d Inaktivität) — leiser Info-Toast
        //  - 'self' (Logout-Cleanup) — kein Toast nötig (User hat selbst ausgelöst)
        if (msg.deviceId && msg.deviceId !== userStore.deviceId && msg.reason !== 'self') {
          const me = userStore.myUser;
          const lng = i18nStore.lang;
          const shortId = String(msg.deviceId).slice(0, 12);
          let text, kind;
          if (msg.reason === 'auto') {
            text = msg.from === me
              ? (lng.deviceAutoRevokedSelfToast || `🧹 Inaktives Gerät entfernt (${shortId}…) — 30 Tage offline`)
              : (lng.deviceAutoRevokedPeerToast || `🧹 @${msg.from}'s Gerät (${shortId}…) automatisch entfernt`);
            kind = 'info';
          } else {
            text = msg.from === me
              ? (lng.deviceRevokedSelfToast || `🔒 Gerät (${shortId}…) entfernt — Schlüssel werden rotiert`)
              : (lng.deviceRevokedPeerToast || `🔒 @${msg.from} hat ein Gerät entfernt — Schlüssel rotiert`);
            kind = 'warn';
          }
          toastStore.push(text, { kind, ttl: 7000 });
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

          // In-App-Toast bei neuer Kontaktanfrage — User sieht Anfrage sofort
          // auch wenn er gerade in einem anderen Chat ist (InboxList ist auf
          // Mobile bei offenem Chat per CSS hidden).
          if (msg?.type === "contact_request" && msg?.from) {
            const lng = i18nStore.lang;
            const peer = msg.from;
            const peerDn = profileCache.get(peer) || `@${peer}`;
            toastStore.push(
              (lng.contactRequestToast || '📩 Neue Kontaktanfrage von {peer}')
                .replace('{peer}', peerDn),
              { kind: 'info' }
            );
          }

          // Special-Case: Peer hat MICH entfernt (action === "removed").
          // → Toast + ggf. offenen Chat schließen, weil Senden eh blockt (403).
          if (msg?.type === "contact_update"
              && msg?.action === "removed"
              && msg?.from) {
            const lng = i18nStore.lang;
            const peer = msg.from;
            const peerDn = profileCache.get(peer) || `@${peer}`;
            toastStore.push(
              (lng.contactRemovedByPeer || '{peer} hat dich aus den Kontakten entfernt')
                .replace('{peer}', peerDn),
              { kind: 'info' }
            );
            // Wenn dieser Chat gerade offen ist → schließen
            const sel = chatStore.selectedChat;
            if (sel?.type === 'dm' && (sel.peer === peer || sel.key === peer)) {
              chatStore.selectChat(null);
            }
          }
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

    // ── Server/Channel Live-Updates (Phase 3A + 3A.5) ───────────────────
    // Backend pusht diese Events an alle Server-Members. Wenn der betroffene
    // Server gerade geöffnet ist, Detail (Channels/Members/Roles) neu laden.
    // Sidebar-relevante Events (Member-Count, Name, Icon, Owner-Wechsel)
    // triggern zusätzlich /servers/list, auch wenn der Server nicht geöffnet ist.
    const _serverLiveEvents = [
      "server_member_joined", "server_member_left",
      "server_member_banned", "server_member_unbanned",
      "server_updated", "server_owner_changed",
      "channel_created", "channel_renamed", "channel_deleted",
      "channel_permissions_updated",
      "role_created", "role_updated", "role_deleted",
      "member_role_assigned", "member_role_revoked",
    ];
    const _sidebarRelevant = new Set([
      "server_member_joined", "server_member_left",
      "server_member_banned", "server_member_unbanned",
      "server_updated", "server_owner_changed",
    ]);
    for (const evt of _serverLiveEvents) {
      _wsUnsubs.push(ws.on(evt, (msg) => {
        if (msg?.serverId && msg.serverId === serverStore.selectedServerId) {
          void serverStore.loadServerDetail(msg.serverId);
        }
        if (_sidebarRelevant.has(evt)) {
          void serverStore.loadServers();
        }
      }));
    }

    // Phase 3A.5: Self-ban-Behandlung — wenn ich der Gebannte bin, Server-View
    // zurücksetzen + Toast. Kommt zusätzlich zum allgemeinen Handler oben.
    _wsUnsubs.push(ws.on("server_member_banned", (msg) => {
      serverStore.incrementBanEventVersion();
      if (msg?.handle && userStore.myUser && msg.handle === userStore.myUser) {
        if (msg.serverId === serverStore.selectedServerId) {
          serverStore.selectServer(null);
        }
        const reasonSuffix = msg.reason ? ` — „${msg.reason}"` : '';
        toastStore.push(`🚫 ${(i18nStore.lang.bannedFromServerToast || 'Du wurdest vom Server gebannt')}${reasonSuffix}`, { kind: 'error' });
      }
    }));
    // Phase 3A.5: Unban — refresh Banned-Liste im offenen Modal
    _wsUnsubs.push(ws.on("server_member_unbanned", () => {
      serverStore.incrementBanEventVersion();
    }));

    // ── H1: Forward-Secrecy bei Server-Kick/Ban/Leave ──────────────────────
    // Channel-GSKs wurden — anders als bei Gruppen (group_member_left/removed) —
    // bei Server-Membership-Verlust NICHT rotiert. Ohne Rotation behält der
    // Entfernte die GSK und könnte zukünftige Channel-Messages entschlüsseln,
    // sofern er Ciphertext bekommt. Hier: pro Channel des Servers die eigene GSK
    // rotieren + an die verbleibenden Member neu verteilen (= Forward Secrecy,
    // analog zum Gruppen-Pfad). Early-Out via getKnownChannels: Member, die in
    // dem Server nie gesendet haben (keine eigene GSK), machen weder Fetch noch
    // Rotation — bounded Last bei großen Servern.
    // #6: Mehrere Removals desselben Servers werden in EINEN Rotations-Pass
    // gebündelt (Coalesce), und der Fetch+Rotate wird per Jitter über die Clients
    // gestreut — sonst fetchen bei einem Kick alle N verbleibenden Member
    // gleichzeitig /servers/<id> und rotieren (Thundering-Herd / O(N^2)-GSK-Traffic
    // bei großen Servern). Die kurze Verzögerung schwächt die Forward-Secrecy nicht:
    // der Entfernte ist backend-seitig sofort aus server_members + Recipient-Filter
    // raus und bekommt in dem Fenster ohnehin keinen neuen Ciphertext.
    const _gskRotateBatches = new Map(); // serverId -> { removed:Set<handle>, timer }

    const serverMemberRemovedHandler = (msg) => {
      const removed  = String(msg?.handle || '').toLowerCase();
      const serverId = msg?.serverId;
      const me = userStore.myUser;
      if (!removed || !serverId || !me) return;

      // Ich selbst wurde entfernt → eigene + Peer-GSKs für die Channels dieses
      // Servers droppen (obsolet; dürfen lokal nicht weiterleben). Sofort, kein Defer.
      if (removed === me) {
        for (const ch of serverStore.getKnownChannels().filter(c => c.serverId === serverId)) {
          void deleteAllGSKsForGroup(ch.id);
        }
        return;
      }

      let batch = _gskRotateBatches.get(serverId);
      if (!batch) { batch = { removed: new Set(), timer: null }; _gskRotateBatches.set(serverId, batch); }
      batch.removed.add(removed);
      if (batch.timer) return; // Pass für diesen Server bereits geplant → nur sammeln
      const jitterMs = 500 + Math.floor(Math.random() * 4500); // 0.5–5s gestreut

      batch.timer = setTimeout(() => {
        _gskRotateBatches.delete(serverId);
        const removedSet = batch.removed;
        void (async () => {
          try {
            // Early-Out: nur rotieren, wenn ich in mind. einem (bekannten) Channel
            // dieses Servers eine eigene GSK habe (sonst kein Fetch/keine Rotation).
            const knownChs = serverStore.getKnownChannels().filter(c => c.serverId === serverId);
            let anyGsk = false;
            for (const ch of knownChs) { if (await getMyGSK(ch.id)) { anyGsk = true; break; } }
            if (!anyGsk) return;

            // Frische Member-/Channel-Liste (VIEW-gefiltert) für die Distribution.
            const r = await apiFetch(`/servers/${encodeURIComponent(serverId)}`);
            if (!r.ok) return;
            const members = (Array.isArray(r.data?.members) ? r.data.members : [])
              .map(m => String(m.handle || '').toLowerCase())
              .filter(h => h && h !== me && !removedSet.has(h));
            const channels = Array.isArray(r.data?.channels) ? r.data.channels : [];
            for (const ch of channels) {
              for (const rem of removedSet) await deletePeerGSK(ch.id, rem);
              const myGsk = await getMyGSK(ch.id);
              if (!myGsk) continue;            // nie in dem Channel gesendet → keine Rotation nötig
              await rotateMyGSK(ch.id, members);
            }
          } catch (e) {
            captureException(e, { context: 'rotate-on-server-member-removed', serverId });
          }
        })();
      }, jitterMs);
    };
    _wsUnsubs.push(ws.on("server_member_kicked", serverMemberRemovedHandler));
    _wsUnsubs.push(ws.on("server_member_banned", serverMemberRemovedHandler));
    _wsUnsubs.push(ws.on("server_member_left",   serverMemberRemovedHandler));

    // E2E Inbox-Key Upload + Heartbeat — sequenziell aber non-blocking
    // (Phase 1A.6 Migration aus renex-legacy/js/e2e.js).
    // Upload ist idempotent — Backend macht UPSERT in D1 + KV.
    // Heartbeat erst NACH erfolgreichem Upload, damit das Device im Backend
    // existiert (sonst returnt /heartbeat 404 für unbekannte deviceIds).
    void (async () => {
      const result = await uploadInboxKeyIfNeeded();
      if (result?.ok) {
        _runHeartbeat();
        // M2 PQXDH (Dark-Launch PUBLISH-ONLY): Prekey-Bundle publizieren +
        // OPK-Topup. Best-effort/non-blocking — wirft nie. Guests haben keine
        // Session für /e2e/pqxdh/upload (requireSession) → skippen.
        if (!userStore.isGuest) {
          void publishPqxdhBundleIfNeeded();
        }
      } else if (result?.deviceLimit) {
        deviceLimitInfo = result.deviceLimit;
      }
    })();
    document.addEventListener('visibilitychange', _onVisibilityChange);

    // Recovery-Pfade sind für Gäste irrelevant (keine Phrase, kein Bundle, keine
    // dauerhafte Identität). Sonst 401-Cascade auf /e2e/recovery/status + /bundle.
    if (!userStore.isGuest) {
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

    // Recovery-Prompt-Hint: Inkognito/neuer-Browser-Fall — Bundle existiert in R2,
    // aber masterKey nicht im Cache. User würde sonst nur 🔐-Messages sehen ohne
    // zu wissen wie er die freischalten kann. Toast zeigt klickbaren Hint.
    // Gäste: skip — sie haben keine Phrase/Bundle.
    if (!userStore.isGuest) void (async () => {
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
      // PWA-Resume nach Suspend: Push-Nachrichten sind während Background
      // angekommen, aber WS war gekappt → offenen Chat + Inbox-Daten refreshen.
      // DO buffert keine Events: ohne Refetch sieht der User neue Kontakt-
      // anfragen, Gruppen-Adds und Unread-Counts erst nach PWA-Restart.
      chatStore.refreshSelected();
      void inboxStore.loadContacts().catch(() => {});
      void inboxStore.loadGroups().catch(() => {});
      void inboxStore.loadUnread().catch(() => {});
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
    presenceStore.clear();
    profileCache.clear();
    document.removeEventListener('visibilitychange', _onVisibilityChange);
  }
</script>

{#if showLogin}
  <LoginModal onRecoveryClick={() => recoveryLoginOpen = true} />
{:else if showApp}
  {#if userStore.isGuest}
    <!-- Gast-Modus: keine Sidebar/IconStrip — Gast hat per Definition
         genau eine Konversation (Group oder DM gebunden an die Session).
         Volles App-Layout würde den Eindruck erwecken er könne Chats wechseln,
         Kontakte hinzufügen, Voice-Calls starten — alles aber ohne Daten/Rechte.
         GuestBanner oben zeigt Session-Countdown, msgs-left, Account-erstellen-CTA. -->
    <div class="app guest-mode">
      <GuestBanner />
      <ChatView />
    </div>
  {:else}
    <div class="app" class:chat-open={!!chatStore.selectedChat}>
      <IconStrip />
      <InboxList />
      <ChatView />
    </div>
  {/if}
{/if}

<!-- Voice-Call-Overlay (global, über allem) -->
<VoiceCallOverlay />

<!-- Temporäres Voice-Debug-Overlay — aktiv via ?voice-debug=1 (siehe Component) -->
<VoiceLogOverlay />

<!-- Recovery-Modale (blocken App-Entry bis erledigt) -->
<RecoveryOnboardingModal bind:isOpen={recoveryNeedsOnboarding} />
<RecoveryVerifyModal bind:isOpen={recoveryNeedsVerify} />
<!-- RecoveryLogin auf App-Level: überlebt LoginModal-Unmount nach Passkey-Auth.
     User durchläuft Step 1 (auth) → 2 (phrase) → 3 (success) ohne Unterbrechung. -->
<RecoveryLoginModal bind:isOpen={recoveryLoginOpen} />

<!-- Device-Limit-Modal: 5 Geräte erreicht -->
<DeviceLimitModal bind:info={deviceLimitInfo} />

<!-- Member-Actions-Modal: globaler Action-Sheet bei Klick auf Group-Sender / Group-Member -->
<MemberActionsModal />
<LinkWarningModal />
<ServerJoinModal bind:isOpen={joinModalOpen} token={joinModalToken} info={joinModalInfo} />

<!-- PWA-Install-Banner: Smart Banner + iOS/Safari-Anleitung. Trigger via Profile-Menü. -->
<PwaInstallBanner />

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

  /* Gast-Modus: GuestBanner oben, ChatView nimmt den Rest. Kein IconStrip,
     keine InboxList — Gast hat nur eine Konversation. */
  .app.guest-mode {
    flex-direction: column;
  }
  .app.guest-mode :global(.chat-view) {
    flex: 1;
    width: 100%;
    min-height: 0;
  }

  /* Mobile: Chat-View overlay-style wenn offen.
     Gast-Modus ausgenommen: dort gibt's nur ChatView, kein InboxList — also
     immer sichtbar (sonst würde der Gast eine leere Page sehen, ohne Input). */
  @media (max-width: 768px) {
    .app.chat-open :global(.panel-list),
    .app.chat-open :global(.icon-strip) {
      display: none;
    }
    .app:not(.chat-open):not(.guest-mode) :global(.chat-view) {
      display: none;
    }
  }
</style>
