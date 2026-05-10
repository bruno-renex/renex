<!--
  MemberActionsModal — Action-Sheet für Group-Member-Klick.

  Auto-detected den Beziehungs-Status zwischen mir und dem Target und zeigt
  statusabhängig die richtigen Aktionen:

    bereits Kontakt (status='accepted')   → 💬 Direkt-Nachricht öffnen
    Pending eingehend                      → ✓ Annehmen / × Ablehnen
    Pending ausgehend                      → ⏳ Hinweis + ↩ Zurückziehen
    Kein Kontakt                           → ➕ Als Kontakt anfragen
    Eigener User                           → Modal sollte gar nicht aufgehen

  State kommt aus inboxStore. Modal mounted global in App.svelte, Trigger
  via memberActionsStore.open(handle).
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { inboxStore } from '../stores/inbox.svelte.js';
  import { userStore } from '../stores/user.svelte.js';
  import { profileCache } from '../stores/profileCache.svelte.js';
  import { memberActionsStore } from '../stores/memberActions.svelte.js';
  import { chatStore } from '../stores/chat.svelte.js';
  import { toastStore } from '../stores/toast.svelte.js';
  import { apiFetch } from '../lib/api.js';
  import { captureException } from '../lib/sentry.js';
  import { isGuestHandle, guestDisplayName } from '../lib/guestNames.js';

  let lang = $derived(i18nStore.lang);
  let me   = $derived(userStore.myUser);
  let isOpen = $derived(memberActionsStore.isOpen);
  let handle = $derived(memberActionsStore.handle);

  let busy = $state(false);
  let errorMsg = $state('');

  // Reset Error-State beim Öffnen.
  $effect(() => {
    if (isOpen) {
      errorMsg = '';
      busy = false;
      // Display-Name nachladen falls Cache leer
      if (handle && !isGuestHandle(handle) && !profileCache.get(handle)) {
        profileCache.prefetch([handle]);
      }
    }
  });

  // Beziehungs-Status zwischen mir und target. Reaktiv aus inboxStore.
  // 'self' | 'accepted' | 'pending_in' | 'pending_out' | 'none' | 'guest'
  let relation = $derived.by(() => {
    if (!handle) return 'none';
    if (isGuestHandle(handle)) return 'guest';
    if (me && handle === me) return 'self';
    if (inboxStore.contacts.some(c => c.handle === handle)) return 'accepted';
    if (inboxStore.pendingIn.some(c => c.handle === handle)) return 'pending_in';
    if (inboxStore.pendingOut.some(c => c.handle === handle)) return 'pending_out';
    return 'none';
  });

  let displayName = $derived.by(() => {
    if (!handle) return '';
    if (isGuestHandle(handle)) return guestDisplayName(handle);
    return profileCache.get(handle) || null;
  });

  let initials = $derived.by(() => {
    const src = (displayName || handle || '').replace(/^Guest /, '');
    if (!src) return '?';
    return src.split(/[\s._-]+/).map(p => p[0]).join('').slice(0, 2).toUpperCase();
  });

  // ── Actions ────────────────────────────────────────

  function openDm() {
    if (!handle) return;
    // Bestehenden Display-Name in den Chat-Header passenden Namen rendern.
    const dn = profileCache.get(handle);
    chatStore.selectChat({
      type: 'dm',
      key:  handle,
      peer: handle,
      name: dn ? `${dn} · @${handle}` : `@${handle}`,
    });
    memberActionsStore.close();
  }

  async function sendRequest() {
    if (!handle || busy) return;
    busy = true;
    errorMsg = '';
    try {
      const r = await apiFetch('/contacts/request', {
        method: 'POST',
        body: { contact: handle },
      });
      if (r.ok) {
        const s = r.data?.status;
        let msg;
        if (s === 'accepted')             msg = lang.maContactAccepted  || 'Kontakt akzeptiert';
        else if (s === 'already_exists')  msg = lang.maAlreadyContact   || 'Bereits in Kontaktliste';
        else if (s === 'already_pending') msg = lang.maAlreadyPending   || 'Anfrage bereits offen';
        else                              msg = lang.maRequestSent      || 'Anfrage gesendet ✓';
        toastStore.push(msg, { kind: 'success' });
        await inboxStore.loadContacts().catch(() => {});
        memberActionsStore.close();
      } else if (r.status === 404) {
        errorMsg = lang.maUserNotFound || 'User nicht gefunden';
      } else if (r.status === 410) {
        errorMsg = lang.maAccountDeleted || 'Account gelöscht';
      } else {
        errorMsg = r.error || (lang.maRequestFailed || 'Anfrage fehlgeschlagen');
      }
    } catch (e) {
      captureException(e, { context: 'MemberActionsModal.sendRequest' });
      errorMsg = lang.requestFailed || 'Anfrage fehlgeschlagen';
    } finally {
      busy = false;
    }
  }

  async function acceptRequest() {
    if (!handle || busy) return;
    busy = true;
    const ok = await inboxStore.acceptRequest(handle);
    busy = false;
    if (ok) {
      toastStore.push(lang.maContactAccepted || 'Kontakt akzeptiert', { kind: 'success' });
      memberActionsStore.close();
    } else {
      errorMsg = lang.maRequestFailed || 'Annahme fehlgeschlagen';
    }
  }

  async function rejectRequest() {
    if (!handle || busy) return;
    if (!confirm(lang.maRejectConfirm || 'Diese Anfrage ablehnen?')) return;
    busy = true;
    const ok = await inboxStore.rejectRequest(handle);
    busy = false;
    if (ok) {
      toastStore.push(lang.maRequestRejected || 'Anfrage abgelehnt', { kind: 'info' });
      memberActionsStore.close();
    } else {
      errorMsg = lang.maRequestFailed || 'Ablehnung fehlgeschlagen';
    }
  }

  async function cancelRequest() {
    if (!handle || busy) return;
    if (!confirm(lang.maCancelConfirm || 'Anfrage zurückziehen?')) return;
    busy = true;
    const ok = await inboxStore.cancelRequest(handle);
    busy = false;
    if (ok) {
      toastStore.push(lang.maRequestCancelled || 'Anfrage zurückgezogen', { kind: 'info' });
      memberActionsStore.close();
    } else {
      errorMsg = lang.maRequestFailed || 'Zurückziehen fehlgeschlagen';
    }
  }

  // ── Modal-Steuerung ────────────────────────────────

  function close() {
    if (busy) return;
    memberActionsStore.close();
  }

  function onBackdropClick(e) {
    if (e.target.classList.contains('ma-overlay')) close();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if isOpen && handle && relation !== 'self'}
  <div class="ma-overlay" role="presentation" onclick={onBackdropClick}>
    <div class="ma-dialog" role="dialog" aria-labelledby="ma-title" aria-modal="true">
      <div class="ma-header">
        <div class="ma-avatar" class:is-guest={isGuestHandle(handle)}>{initials}</div>
        <div class="ma-name-wrap">
          <div id="ma-title" class="ma-name">
            {displayName || (isGuestHandle(handle) ? guestDisplayName(handle) : `@${handle}`)}
          </div>
          {#if !isGuestHandle(handle) && displayName}
            <div class="ma-handle">@{handle}</div>
          {/if}
        </div>
        <button class="close-btn" onclick={close} disabled={busy} aria-label="Close">×</button>
      </div>

      {#if errorMsg}
        <div class="ma-error">{errorMsg}</div>
      {/if}

      <div class="ma-body">
        {#if relation === 'guest'}
          <p class="ma-hint">
            {lang.guestNoActions || 'Gäste können nicht als Kontakt hinzugefügt werden.'}
          </p>

        {:else if relation === 'accepted'}
          <button class="ma-action ma-primary" onclick={openDm} disabled={busy}>
            <span class="ma-action-icon">💬</span>
            <span class="ma-action-label">{lang.openDm || 'Direkt-Nachricht'}</span>
          </button>

        {:else if relation === 'pending_in'}
          <p class="ma-hint">{lang.hasPendingRequestIn || 'möchte dich als Kontakt hinzufügen.'}</p>
          <div class="ma-action-row">
            <button class="ma-action ma-primary" onclick={acceptRequest} disabled={busy}>
              <span class="ma-action-icon">✓</span>
              <span class="ma-action-label">{lang.acceptBtn || 'Annehmen'}</span>
            </button>
            <button class="ma-action ma-secondary" onclick={rejectRequest} disabled={busy}>
              <span class="ma-action-icon">×</span>
              <span class="ma-action-label">{lang.rejectBtn || 'Ablehnen'}</span>
            </button>
          </div>

        {:else if relation === 'pending_out'}
          <p class="ma-hint">{lang.requestPendingHint || '⏳ Anfrage gesendet — wartet auf Bestätigung.'}</p>
          <button class="ma-action ma-secondary" onclick={cancelRequest} disabled={busy}>
            <span class="ma-action-icon">↩</span>
            <span class="ma-action-label">{lang.cancelRequestBtn || 'Anfrage zurückziehen'}</span>
          </button>

        {:else}
          <p class="ma-hint">{lang.notInContactsYet || 'Noch nicht in deinen Kontakten.'}</p>
          <button class="ma-action ma-primary" onclick={sendRequest} disabled={busy}>
            <span class="ma-action-icon">➕</span>
            <span class="ma-action-label">{lang.requestContactBtn || 'Als Kontakt anfragen'}</span>
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .ma-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    z-index: 1100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    animation: fadeIn 0.15s ease-out;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .ma-dialog {
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 14px;
    padding: 22px;
    width: 100%;
    max-width: 380px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .ma-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .ma-avatar {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    color: var(--text-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 16px;
    flex-shrink: 0;
  }
  .ma-avatar.is-guest {
    color: var(--text-muted);
    font-style: italic;
  }

  .ma-name-wrap { flex: 1; min-width: 0; }
  .ma-name {
    font-size: 15px;
    font-weight: 700;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ma-handle {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 2px;
  }

  .close-btn {
    background: none;
    border: none;
    font-size: 22px;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
    line-height: 1;
    flex-shrink: 0;
  }
  .close-btn:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-panel-alt); }

  .ma-error {
    padding: 8px 10px;
    background: color-mix(in srgb, var(--status-error, #ef4444) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--status-error, #ef4444) 50%, transparent);
    color: var(--status-error, #ef4444);
    border-radius: 8px;
    font-size: 12px;
  }

  .ma-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .ma-hint {
    font-size: 13px;
    color: var(--text-secondary);
    margin: 0;
  }

  .ma-action-row {
    display: flex;
    gap: 8px;
  }
  .ma-action-row .ma-action { flex: 1; }

  .ma-action {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 12px 14px;
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    background: var(--bg-panel-alt);
    color: var(--text-primary);
    cursor: pointer;
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    text-align: left;
    transition: all 0.12s;
  }
  .ma-action:disabled { opacity: 0.5; cursor: not-allowed; }
  .ma-action:hover:not(:disabled) {
    background: var(--bg-panel);
    border-color: var(--accent-voice);
  }
  .ma-action.ma-primary {
    background: var(--accent-voice);
    color: #07070a;
    border-color: var(--accent-voice);
  }
  .ma-action.ma-primary:hover:not(:disabled) { background: #0ea5e9; }

  .ma-action-icon {
    font-size: 18px;
    line-height: 1;
    flex-shrink: 0;
  }
  .ma-action-label { flex: 1; }
</style>
