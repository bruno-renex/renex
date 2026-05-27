<!--
  ServerInviteModal — zeigt einen bereits erstellten Server-Invite-Link an.

  Wird von ServersView geöffnet, NACHDEM der Invite via serverStore.createInvite
  erstellt wurde (URL kommt als Prop rein). Eigene Komponente, weil das
  bestehende InviteLinkModal fest am Gruppen-/Gast-Flow (/invite/create) hängt.

  Wichtig (Safari/iOS): Clipboard.writeText muss DIREKT auf einen Tap reagieren.
  Deshalb passiert das Kopieren hier im Copy-Button-Klick (frische User-Geste),
  nicht automatisch nach dem Netzwerk-Call.
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';

  let { isOpen = $bindable(false), url = null } = $props();

  let lang = $derived(i18nStore.lang);
  let copied = $state(false);
  let errorMsg = $state(null);

  let canShare = $derived(
    !!url && typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  );

  async function copyLink() {
    if (!url) return;
    errorMsg = null;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
      setTimeout(() => { copied = false; }, 2000);
    } catch {
      errorMsg = lang.copyFailed || 'Kopieren nicht möglich — Link oben antippen und manuell kopieren.';
    }
  }

  async function shareLink() {
    if (!url || !navigator.share) return;
    try {
      await navigator.share({ title: 'RENEX', url });
    } catch {
      // User-Cancel ist kein Fehler
    }
  }

  function close() { isOpen = false; }
  function onBackdrop(e) {
    if (e.target.classList.contains('si-overlay')) close();
  }
  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }
</script>

{#if isOpen && url}
  <div class="si-overlay" role="presentation" onclick={onBackdrop}>
    <div class="si-dialog" role="dialog" aria-labelledby="si-title" aria-modal="true" tabindex="-1" onkeydown={onKeydown}>
      <div class="si-header">
        <h3 id="si-title">🔗 {lang.serverInviteTitle || 'Server-Invite-Link'}</h3>
        <button class="close-btn" onclick={close} aria-label="Close">×</button>
      </div>

      <p class="si-hint">
        {lang.serverInviteHint || 'Sende diesen Link an Personen mit RENEX-Account — sie treten damit dem Server bei. 7 Tage gültig.'}
      </p>

      <div class="si-link-row">
        <input
          type="text"
          class="si-link-input"
          value={url}
          readonly
          onclick={(e) => e.currentTarget.select()}
        />
        <button class="si-copy-btn" class:copied onclick={copyLink} aria-label="Copy link">
          {#if copied}✓ {lang.copied || 'Kopiert'}{:else}📋 {lang.copy || 'Kopieren'}{/if}
        </button>
      </div>

      {#if canShare}
        <button class="si-share-btn" onclick={shareLink}>
          ↗ {lang.shareBtn || 'Teilen'}
        </button>
      {/if}

      {#if errorMsg}
        <div class="si-error">{errorMsg}</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .si-overlay {
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

  .si-dialog {
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 14px;
    padding: 22px;
    width: 100%;
    max-width: 440px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
  }

  .si-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 14px;
  }
  .si-header h3 { margin: 0; font-size: 16px; color: var(--text-primary); }

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

  .si-hint {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0 0 14px 0;
  }

  .si-link-row {
    display: flex;
    gap: 6px;
    margin-bottom: 10px;
  }
  .si-link-input {
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
  .si-link-input:focus { border-color: var(--accent-voice); outline: none; }

  .si-copy-btn {
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
  .si-copy-btn:hover { background: #0ea5e9; }
  .si-copy-btn.copied { background: var(--status-success); }

  .si-share-btn {
    width: 100%;
    padding: 10px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    color: var(--text-primary);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .si-share-btn:hover {
    border-color: var(--accent-voice);
    color: var(--accent-voice);
  }

  .si-error {
    margin-top: 12px;
    padding: 10px 12px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid var(--status-error);
    border-radius: 8px;
    color: var(--status-error);
    font-size: 12px;
  }
</style>
