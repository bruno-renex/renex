<!--
  InviteLinkModal — Generiert + zeigt Einladungslink an
  Backend: POST /invite/create (mit oder ohne convoId)
   - Ohne convoId: 1:1-Einladung (Gast wird in einer neuen DM mit Einlader geguestet)
   - Mit convoId (group): Group-Einladung (Gast joint die Gruppe)

  Features:
   - Copy-to-Clipboard mit visueller Bestätigung
   - Ablauf-Datum + Message-Limit anzeigen
   - Web-Share-API auf Mobile (falls verfügbar)
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { toastStore } from '../stores/toast.svelte.js';
  import { apiFetch } from '../lib/api.js';
  import { captureException } from '../lib/sentry.js';

  /** @type {{ isOpen: boolean, convoId?: string|null, groupName?: string|null }} */
  let { isOpen = $bindable(false), convoId = null, groupName = null } = $props();

  let lang = $derived(i18nStore.lang);

  let isLoading = $state(false);
  let inviteUrl = $state(null);
  let inviteToken = $state(null);  // wird für /invite/revoke benötigt
  let expiresAt = $state(null);
  let msgLimit  = $state(null);
  let errorMsg = $state(null);
  let copied = $state(false);
  let revoking = $state(false);

  $effect(() => {
    if (isOpen) {
      // Reset
      inviteUrl = null;
      inviteToken = null;
      expiresAt = null;
      msgLimit  = null;
      errorMsg = null;
      copied = false;
      revoking = false;
      void create();
    }
  });

  async function create() {
    isLoading = true;
    errorMsg = null;
    try {
      const body = convoId ? { convoId } : {};
      const r = await apiFetch('/invite/create', { method: 'POST', body });
      if (r.ok && r.data?.inviteUrl) {
        inviteUrl = r.data.inviteUrl;
        inviteToken = r.data.token || null;
        expiresAt = r.data.expiresAt || null;
        msgLimit  = r.data.msgLimit || null;
      } else if (r.status === 429) {
        errorMsg = lang.inviteRateLimit || 'Zu viele Einladungen — bitte später erneut versuchen.';
      } else {
        errorMsg = r.data?.error || lang.inviteCreateFailed || 'Einladungslink konnte nicht erstellt werden';
      }
    } catch (e) {
      captureException(e, { context: 'invite.create' });
      errorMsg = lang.inviteCreateFailed || 'Einladungslink konnte nicht erstellt werden';
    } finally {
      isLoading = false;
    }
  }

  async function copyLink() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      copied = true;
      setTimeout(() => { copied = false; }, 2000);
    } catch (e) {
      // Fallback: select+execCommand wäre Legacy — bei Clipboard-API-Fail einfach Fehler zeigen
      errorMsg = lang.copyFailed || 'Kopieren nicht möglich — Link manuell auswählen';
    }
  }

  async function revoke() {
    if (!inviteToken || revoking) return;
    const msg = lang.inviteRevokeConfirm || 'Diesen Einladungslink widerrufen? Er wird sofort ungültig.';
    if (!confirm(msg)) return;
    revoking = true;
    try {
      const r = await apiFetch('/invite/revoke', {
        method: 'POST',
        body: { token: inviteToken },
      });
      if (r.ok) {
        toastStore.push(lang.inviteRevokeSuccess || 'Einladungslink widerrufen', { kind: 'success' });
        close();
      } else {
        toastStore.push(lang.inviteRevokeFailed || 'Widerruf fehlgeschlagen', { kind: 'error' });
      }
    } catch (e) {
      captureException(e, { context: 'invite.revoke' });
      toastStore.push(lang.inviteRevokeFailed || 'Widerruf fehlgeschlagen', { kind: 'error' });
    } finally {
      revoking = false;
    }
  }

  async function shareLink() {
    if (!inviteUrl) return;
    if (!navigator.share) return;
    try {
      await navigator.share({
        title: 'RENEX',
        text: lang.inviteShareText || 'Hi! Schreib mir auf RENEX — ohne Account.',
        url: inviteUrl,
      });
    } catch {
      // User-Cancel ist kein Fehler
    }
  }

  function close() {
    isOpen = false;
  }

  function onBackdrop(e) {
    if (e.target.classList.contains('inv-overlay')) close();
  }

  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }

  // Format expiresAt
  let expiresDisplay = $derived.by(() => {
    if (!expiresAt) return null;
    const d = new Date(expiresAt);
    return d.toLocaleString(lang.locale || 'de-DE', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  });

  // Title je nach Kontext
  let titleText = $derived(
    convoId
      ? (lang.inviteToGroupTitle || 'In Gruppe einladen').replace('{name}', groupName || '')
      : (lang.invite1to1Title || 'Person einladen (1:1)')
  );

  let canShare = $derived(
    inviteUrl && typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  );
</script>

{#if isOpen}
  <div class="inv-overlay" role="presentation" onclick={onBackdrop}>
    <div
      class="inv-dialog"
      role="dialog"
      aria-labelledby="inv-title"
      aria-modal="true"
      tabindex="-1"
      onkeydown={onKeydown}
    >
      <div class="inv-header">
        <h3 id="inv-title">{titleText}</h3>
        <button class="close-btn" onclick={close} aria-label="Close">×</button>
      </div>

      {#if isLoading}
        <div class="inv-loading">
          <span class="spinner"></span>
          {lang.creatingInvite || 'Einladungslink wird erstellt…'}
        </div>
      {:else if errorMsg}
        <div class="inv-error">{errorMsg}</div>
      {:else if inviteUrl}
        <p class="inv-hint">
          {convoId
            ? (lang.inviteGroupHint || 'Sende diesen Link an Personen die deiner Gruppe beitreten sollen — sie chatten als Gast (kein Account nötig).')
            : (lang.invite1to1Hint || 'Sende diesen Link an die Person mit der du chatten willst — sie chattet als Gast (kein Account nötig).')}
        </p>

        <div class="link-row">
          <input
            type="text"
            class="link-input"
            value={inviteUrl}
            readonly
            onclick={(e) => e.target.select()}
          />
          <button
            class="copy-btn"
            class:copied
            onclick={copyLink}
            aria-label="Copy link"
          >
            {#if copied}
              ✓ {lang.copied || 'Kopiert'}
            {:else}
              📋 {lang.copy || 'Kopieren'}
            {/if}
          </button>
        </div>

        {#if canShare}
          <button class="share-btn" onclick={shareLink}>
            ↗ {lang.shareBtn || 'Teilen'}
          </button>
        {/if}

        <div class="meta-grid">
          {#if expiresDisplay}
            <div class="meta">
              <div class="meta-label">{lang.expiresAt || 'Gültig bis'}</div>
              <div class="meta-value">{expiresDisplay}</div>
            </div>
          {/if}
          {#if msgLimit}
            <div class="meta">
              <div class="meta-label">{lang.guestMsgLimit || 'Gast-Nachrichten'}</div>
              <div class="meta-value">{msgLimit}</div>
            </div>
          {/if}
        </div>

        {#if inviteToken}
          <button
            class="revoke-btn"
            onclick={revoke}
            disabled={revoking}
            type="button"
          >
            {revoking ? '…' : '🗑️'} {lang.inviteRevokeBtn || 'Widerrufen'}
          </button>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .inv-overlay {
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

  .inv-dialog {
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 14px;
    padding: 22px;
    width: 100%;
    max-width: 440px;
    max-height: calc(100vh - 32px);
    max-height: calc(100dvh - 32px);
    overflow-y: auto;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
  }

  .inv-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 14px;
  }
  .inv-header h3 { margin: 0; font-size: 16px; color: var(--text-primary); }

  .close-btn {
    background: none;
    border: none;
    font-size: 22px;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
    line-height: 1;
  }
  .close-btn:hover { color: var(--text-primary); background: var(--bg-panel-alt); }

  .inv-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 28px;
    color: var(--text-muted);
    font-size: 13px;
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--border-subtle);
    border-top-color: var(--accent-voice);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .inv-error {
    padding: 10px 12px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid var(--status-error);
    border-radius: 8px;
    color: var(--status-error);
    font-size: 12px;
  }

  .inv-hint {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0 0 14px 0;
  }

  .link-row {
    display: flex;
    gap: 6px;
    margin-bottom: 10px;
  }

  .link-input {
    flex: 1;
    padding: 10px 12px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    color: var(--text-primary);
    font-size: 12px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    min-width: 0;
  }
  .link-input:focus { border-color: var(--accent-voice); outline: none; }

  .copy-btn {
    padding: 8px 14px;
    background: var(--accent-voice);
    color: #07070a;
    border: none;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .copy-btn:hover { background: #0ea5e9; }
  .copy-btn.copied { background: var(--status-success); }

  .share-btn {
    width: 100%;
    padding: 10px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    color: var(--text-primary);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    margin-bottom: 14px;
  }
  .share-btn:hover {
    background: var(--accent-voice-dim);
    border-color: var(--accent-voice);
    color: var(--accent-voice);
  }

  .meta-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border-subtle);
  }

  .meta { font-size: 11px; }
  .meta-label {
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 700;
    margin-bottom: 4px;
  }
  .meta-value {
    color: var(--text-primary);
    font-size: 13px;
    font-weight: 600;
  }

  .revoke-btn {
    display: block;
    width: 100%;
    margin-top: 14px;
    padding: 8px;
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .revoke-btn:hover:not(:disabled) {
    color: var(--status-error);
    border-color: var(--status-error);
    background: rgba(239, 68, 68, 0.06);
  }
  .revoke-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
