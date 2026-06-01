<!--
  CreateServerModal — Server-Erstellung (Phase 3A)
  Spec: docs/SERVERS.md §3.2

  Felder:
    - Name (Pflicht, 1-80)
    - Description (optional, max 500)

  Nach Erfolg:
    - serverStore.loadServers() + selectServer(newId)
    - Modal schliesst, Toast „Server erstellt"
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { serverStore } from '../stores/serverStore.svelte.js';
  import { toastStore } from '../stores/toast.svelte.js';
  import { renderTurnstile, preloadTurnstileScript } from '../lib/turnstile.js';
  import { captureException } from '../lib/sentry.js';
  import { onMount } from 'svelte';

  let { isOpen = $bindable(false) } = $props();

  let lang = $derived(i18nStore.lang);

  let name = $state('');
  let description = $state('');
  let busy = $state(false);
  let errorMsg = $state('');

  // Phase 5-Light: Turnstile-Captcha
  let turnstileEl = $state(null);
  let cfTurnstileToken = $state(null);
  let _turnstileHandle = null;

  onMount(() => {
    void preloadTurnstileScript().catch((e) => {
      captureException(e, { context: 'turnstile.preload.createServer' });
    });
  });

  // Reset bei Open
  $effect(() => {
    if (isOpen) {
      name = '';
      description = '';
      busy = false;
      errorMsg = '';
      cfTurnstileToken = null;
    }
  });

  // Turnstile rendern wenn Modal offen — Pattern aus LoginModal übernommen.
  $effect(() => {
    if (!turnstileEl || !isOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const h = await renderTurnstile(turnstileEl, {
          onToken: (t) => { if (!cancelled) cfTurnstileToken = t; },
          onExpired: () => { if (!cancelled) cfTurnstileToken = null; },
          onError: () => { if (!cancelled) cfTurnstileToken = null; },
          theme: 'dark',
        });
        if (cancelled) { h.dispose(); return; }
        _turnstileHandle = h;
      } catch (e) {
        captureException(e, { context: 'turnstile.load.createServer' });
      }
    })();
    return () => {
      cancelled = true;
      cfTurnstileToken = null;
      if (_turnstileHandle) { _turnstileHandle.dispose(); _turnstileHandle = null; }
    };
  });

  async function onSubmit(e) {
    e?.preventDefault?.();
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      errorMsg = lang.createServerNameRequired || 'Name ist erforderlich';
      return;
    }
    if (trimmed.length > 80) {
      errorMsg = lang.createServerNameTooLong || 'Name zu lang (max 80 Zeichen)';
      return;
    }
    busy = true;
    errorMsg = '';
    const r = await serverStore.createServer({ name: trimmed, description, cfTurnstileToken });
    busy = false;
    if (r.ok) {
      toastStore.push(lang.createServerSuccess || '✅ Server erstellt', { kind: 'success' });
      close();
    } else {
      // Backend-Fehler übersetzen
      if (r.error === 'server_limit_reached') {
        // Tier-aware Message (Phase 3A.5): Backend liefert {limit, tier, upgradeAvailable}
        const tier = r.tier || 'free';
        const limit = r.limit ?? 3;
        if (tier === 'pro') {
          errorMsg = (lang.createServerLimitReachedPro || 'Server-Limit erreicht (max {limit} als Pro-Owner).')
            .replace('{limit}', String(limit));
        } else if (r.upgradeAvailable) {
          errorMsg = (lang.createServerLimitReachedFree || 'Server-Limit erreicht (max {limit} als Owner im Free-Tier). Upgrade auf Pro für {proLimit}.')
            .replace('{limit}', String(limit))
            .replace('{proLimit}', String(r.upgradeAvailable.proLimit));
        } else {
          errorMsg = lang.createServerLimitReached || 'Server-Limit erreicht.';
        }
      } else if (r.error === 'Too many requests') {
        errorMsg = lang.tooManyRequests || 'Zu viele Anfragen — bitte kurz warten.';
      } else if (r.error === 'Captcha required' || r.error === 'Captcha verification failed') {
        errorMsg = lang.captchaFailed || 'Captcha-Verifikation fehlgeschlagen. Bitte Widget erneut bestätigen.';
        cfTurnstileToken = null;
      } else {
        errorMsg = (lang.createServerFailed || 'Erstellen fehlgeschlagen') + ': ' + r.error;
      }
    }
  }

  function close() {
    isOpen = false;
  }

  function onBackdropClick(e) {
    if (e.target.classList.contains('cs-overlay')) close();
  }

  function onKey(e) {
    if (e.key === 'Escape' && isOpen) close();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if isOpen}
  <div class="cs-overlay" role="presentation" onclick={onBackdropClick}>
    <form class="cs-dialog" role="dialog" aria-labelledby="cs-title" aria-modal="true" onsubmit={onSubmit}>
      <div class="cs-header">
        <h3 id="cs-title">{lang.createServerTitle || 'Server erstellen'}</h3>
        <button type="button" class="close-btn" onclick={close} aria-label="Close">×</button>
      </div>

      <p class="cs-intro">
        {lang.createServerIntro || 'Erstelle einen Hub mit eigenen Channels für deine Community.'}
      </p>

      <label class="cs-field">
        <span class="cs-label">{lang.createServerNameLabel || 'Name'}</span>
        <input
          type="text"
          bind:value={name}
          placeholder={lang.createServerNamePlaceholder || 'z.B. Mein Clan'}
          maxlength="80"
          required
          disabled={busy}
          autofocus
        />
      </label>

      <label class="cs-field">
        <span class="cs-label">{lang.createServerDescLabel || 'Beschreibung (optional)'}</span>
        <textarea
          bind:value={description}
          placeholder={lang.createServerDescPlaceholder || 'Worum geht es?'}
          maxlength="500"
          rows="3"
          disabled={busy}
        ></textarea>
      </label>

      <!-- Phase 5-Light: Turnstile-Widget -->
      <div bind:this={turnstileEl} class="cs-turnstile"></div>

      {#if errorMsg}
        <div class="cs-error">{errorMsg}</div>
      {/if}

      <div class="cs-actions">
        <button type="button" class="btn-secondary" onclick={close} disabled={busy}>
          {lang.cancel || 'Abbrechen'}
        </button>
        <button type="submit" class="btn-primary" disabled={busy || !name.trim()}>
          {#if busy}
            <span class="spinner-sm"></span>
            {lang.creating || 'Erstelle…'}
          {:else}
            {lang.createServerSubmitBtn || 'Server erstellen'}
          {/if}
        </button>
      </div>
    </form>
  </div>
{/if}

<style>
  .cs-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    z-index: 1100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    animation: fadeIn 0.15s ease-out;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .cs-dialog {
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 14px;
    padding: 22px;
    width: 100%;
    max-width: 440px;
    max-height: calc(100vh - 40px);
    max-height: calc(100dvh - 40px);
    overflow-y: auto;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .cs-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .cs-header h3 {
    margin: 0;
    font-size: 17px;
    color: var(--text-primary);
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
  .close-btn:hover {
    color: var(--text-primary);
    background: var(--bg-panel-alt);
  }

  .cs-intro {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.5;
    margin: 0;
  }

  .cs-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .cs-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }

  .cs-field input,
  .cs-field textarea {
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 9px 11px;
    color: var(--text-primary);
    font-size: 13px;
    font-family: inherit;
    resize: vertical;
  }

  .cs-field input:focus,
  .cs-field textarea:focus {
    outline: none;
    border-color: var(--accent-voice);
  }

  .cs-error {
    padding: 10px 12px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid var(--status-error);
    border-radius: 8px;
    color: var(--status-error);
    font-size: 12px;
  }

  .cs-turnstile {
    display: flex;
    justify-content: center;
    min-height: 65px;
  }

  .cs-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }

  .btn-primary,
  .btn-secondary {
    padding: 9px 16px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    transition: opacity 0.12s;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .btn-primary {
    background: var(--accent-voice);
    color: #07070a;
    border: none;
  }
  .btn-primary:hover:not(:disabled) { opacity: 0.9; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-secondary {
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border-subtle);
  }
  .btn-secondary:hover:not(:disabled) {
    color: var(--text-primary);
    background: var(--bg-panel-alt);
  }

  .spinner-sm {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
</style>
