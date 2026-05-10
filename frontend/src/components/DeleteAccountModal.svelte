<!--
  DeleteAccountModal — Account-Löschung mit Username-Bestätigung.

  Flow:
    1. User klickt im ProfileDropdown auf "Account löschen"
    2. Modal öffnet mit Warnungs-Hinweis
    3. User tippt seinen eigenen Username (Match-Check verhindert Versehen)
    4. Submit → DELETE /account → Backend löscht ALLES:
       - Sessions (alle Geräte sofort ausgeloggt)
       - WebAuthn-Passkeys
       - Chat-Pubkeys / E2E-Inbox-Keys / CMK
       - Messages (gesendet + empfangen)
       - R2-Attachments (Photos, Files)
       - Recovery-Bundle in R2
       - Devices, Push-Subscriptions, Notification-Mutes
       - Call-Log, Auto-Delete-Settings
       - Group-Memberships (mit Admin-Nachfolge)
       - Eigene Kontaktzeilen, Gegenseite → status='account_deleted'
       - Handle 300 Tage gesperrt
    5. Bei Erfolg: lokale Stores wipen + Reload (UI auf Logout)
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { userStore } from '../stores/user.svelte.js';
  import { apiFetch } from '../lib/api.js';
  import { captureException } from '../lib/sentry.js';

  let { isOpen = $bindable(false) } = $props();

  let lang = $derived(i18nStore.lang);
  let me   = $derived(userStore.myUser);

  let confirmInput = $state('');
  let isSubmitting = $state(false);
  let errorMsg = $state('');

  // Reset bei Open
  $effect(() => {
    if (isOpen) {
      confirmInput = '';
      errorMsg = '';
      isSubmitting = false;
      setTimeout(() => {
        document.getElementById('da-confirm-input')?.focus();
      }, 60);
    }
  });

  // Match-Check: case-insensitive trim
  let matchesUsername = $derived(
    me && confirmInput.trim().toLowerCase() === String(me).toLowerCase()
  );
  let canSubmit = $derived(matchesUsername && !isSubmitting);

  async function submit() {
    if (!canSubmit) return;
    isSubmitting = true;
    errorMsg = '';

    try {
      const r = await apiFetch('/account', { method: 'DELETE' });
      if (r.ok) {
        // Lokale Daten wipen — Server hat bereits alle Sessions revoked.
        // Kein sessionStore.logout(), weil der zusätzlich an den Server geht;
        // wir wollen einen sauberen Hard-Reset clientseitig und reloaden direkt.
        try { localStorage.clear(); } catch {}
        try { sessionStorage.clear(); } catch {}
        try {
          if (typeof indexedDB !== 'undefined' && indexedDB.databases) {
            const dbs = await indexedDB.databases();
            await Promise.allSettled((dbs || []).map(db => {
              return new Promise(res => {
                if (!db?.name) return res();
                const req = indexedDB.deleteDatabase(db.name);
                req.onsuccess = req.onerror = req.onblocked = () => res();
              });
            }));
          }
        } catch {}
        // Hard-Reload zur Landing — kein Optimismus, sondern komplett frischer State
        location.replace('/');
        return;
      }
      // Fehler-Cases
      if (r.status === 401) {
        errorMsg = lang.notAuthenticated || 'Nicht angemeldet';
      } else {
        errorMsg = r.error || (lang.deleteAccountFailed || 'Löschung fehlgeschlagen');
      }
    } catch (e) {
      captureException(e, { context: 'DeleteAccountModal.submit' });
      errorMsg = lang.deleteAccountFailed || 'Löschung fehlgeschlagen';
    } finally {
      isSubmitting = false;
    }
  }

  function close() {
    if (isSubmitting) return;
    isOpen = false;
  }
  function onBackdropClick(e) {
    if (e.target.classList.contains('da-overlay')) close();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && canSubmit) {
      e.preventDefault();
      submit();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if isOpen}
  <div class="da-overlay" role="presentation" onclick={onBackdropClick}>
    <div class="da-dialog" role="dialog" aria-labelledby="da-title" aria-modal="true">
      <div class="da-header">
        <h3 id="da-title">⚠️ {lang.deleteAccountDialogTitle || 'Account löschen'}</h3>
        <button class="close-btn" onclick={close} disabled={isSubmitting} aria-label="Close">×</button>
      </div>

      <div class="da-body">
        <p class="da-warning">
          {@html lang.deleteAccountDialogBody
            || 'Diese Aktion ist <strong>unwiderruflich</strong>. Alle Nachrichten, Anhänge und Kontakte werden gelöscht.<br><br>Gib deinen Username zur Bestätigung ein:'}
        </p>

        <ul class="da-checklist">
          <li>{lang.daWipeMessages    || 'Alle Nachrichten + Anhänge'}</li>
          <li>{lang.daWipeContacts    || 'Alle Kontakte (Gegenseite sieht „Account gelöscht")'}</li>
          <li>{lang.daWipeGroups      || 'Du wirst aus allen Gruppen entfernt'}</li>
          <li>{lang.daWipeDevices     || 'Alle Geräte sofort ausgeloggt'}</li>
          <li>{lang.daWipePasskeys    || 'Alle Passkeys'}</li>
          <li>{lang.daWipeBackup      || 'Recovery-Backup auf dem Server'}</li>
          <li>{lang.daHandleLocked    || 'Username wird 300 Tage gesperrt'}</li>
        </ul>

        <input
          id="da-confirm-input"
          type="text"
          class="da-input"
          placeholder={me || (lang.deleteAccountPlaceholder || 'Dein Username')}
          bind:value={confirmInput}
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          disabled={isSubmitting}
        />

        {#if errorMsg}
          <div class="da-error">{errorMsg}</div>
        {/if}
      </div>

      <div class="da-buttons">
        <button class="btn btn-secondary" onclick={close} disabled={isSubmitting}>
          {lang.cancel || 'Abbrechen'}
        </button>
        <button class="btn btn-danger" onclick={submit} disabled={!canSubmit}>
          {#if isSubmitting}
            <span class="spinner"></span>
          {/if}
          {lang.deleteAccountConfirmBtn || 'Account löschen'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .da-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    z-index: 1100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    animation: fadeIn 0.15s ease-out;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .da-dialog {
    background: var(--bg-panel);
    border: 1px solid var(--status-error, #ef4444);
    border-radius: 14px;
    padding: 22px;
    width: 100%;
    max-width: 460px;
    max-height: calc(100vh - 32px);
    max-height: calc(100dvh - 32px);
    overflow-y: auto;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.7);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .da-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .da-header h3 {
    margin: 0;
    font-size: 16px;
    color: var(--status-error, #ef4444);
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
  }
  .close-btn:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-panel-alt); }

  .da-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .da-warning {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-primary);
  }
  .da-warning :global(strong) {
    color: var(--status-error, #ef4444);
  }

  .da-checklist {
    margin: 0;
    padding: 12px 14px 12px 28px;
    background: color-mix(in srgb, var(--status-error, #ef4444) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--status-error, #ef4444) 30%, transparent);
    border-radius: 8px;
    font-size: 12px;
    color: var(--text-secondary);
    line-height: 1.5;
  }
  .da-checklist li { margin-bottom: 2px; }
  .da-checklist li:last-child { margin-bottom: 0; }

  .da-input {
    width: 100%;
    padding: 10px 12px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    color: var(--text-primary);
    font-size: 14px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    box-sizing: border-box;
  }
  .da-input:focus {
    outline: none;
    border-color: var(--status-error, #ef4444);
  }

  .da-error {
    padding: 8px 10px;
    background: color-mix(in srgb, var(--status-error, #ef4444) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--status-error, #ef4444) 50%, transparent);
    color: var(--status-error, #ef4444);
    border-radius: 8px;
    font-size: 12px;
  }

  .da-buttons {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    padding-top: 8px;
    border-top: 1px solid var(--border-subtle);
  }
  .btn {
    padding: 9px 16px;
    border-radius: 8px;
    border: 1px solid transparent;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: all 0.15s;
  }
  .btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn-secondary {
    background: transparent;
    border-color: var(--border-subtle);
    color: var(--text-primary);
  }
  .btn-secondary:hover:not(:disabled) { background: var(--bg-panel-alt); }
  .btn-danger {
    background: var(--status-error, #ef4444);
    color: #fff;
    border-color: var(--status-error, #ef4444);
  }
  .btn-danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--status-error, #ef4444) 85%, #000);
  }

  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
