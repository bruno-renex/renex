<!--
  ServerJoinModal — Phase 5-Light

  Ersetzt den bisherigen native `confirm()`-Dialog für Server-Invites.
  Zeigt Server-Detail (Name, Beschreibung, Mitgliederzahl, Einlader) +
  Turnstile-Widget + Beitreten/Abbrechen-Buttons.

  Opens automatisch bei `?join-server=srv_inv_<hex>` in der URL (siehe App.svelte).
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { serverStore } from '../stores/serverStore.svelte.js';
  import { toastStore } from '../stores/toast.svelte.js';
  import { renderTurnstile, preloadTurnstileScript } from '../lib/turnstile.js';
  import { captureException } from '../lib/sentry.js';
  import { onMount } from 'svelte';

  let {
    isOpen = $bindable(false),
    token = null,        // srv_inv_<32hex>
    info = null,         // { serverId, name, description, memberCount, inviterHandle, alreadyMember }
  } = $props();

  let lang = $derived(i18nStore.lang);
  let busy = $state(false);
  let errorMsg = $state('');

  // Phase 5-Light: Turnstile
  let turnstileEl = $state(null);
  let cfTurnstileToken = $state(null);
  let _turnstileHandle = null;

  onMount(() => {
    void preloadTurnstileScript().catch((e) => {
      captureException(e, { context: 'turnstile.preload.serverJoin' });
    });
  });

  // Reset bei Open
  $effect(() => {
    if (isOpen) {
      busy = false;
      errorMsg = '';
      cfTurnstileToken = null;
    }
  });

  // Turnstile rendern wenn Modal offen — Pattern aus LoginModal
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
        captureException(e, { context: 'turnstile.load.serverJoin' });
      }
    })();
    return () => {
      cancelled = true;
      cfTurnstileToken = null;
      if (_turnstileHandle) { _turnstileHandle.dispose(); _turnstileHandle = null; }
    };
  });

  async function onJoin() {
    if (busy || !token) return;
    busy = true;
    errorMsg = '';
    const r = await serverStore.joinByToken(token, cfTurnstileToken);
    busy = false;
    if (r.ok) {
      toastStore.push(lang.inviteJoinSuccess || '✅ Server beigetreten', { kind: 'success' });
      close();
    } else if (r.error === 'Captcha required' || r.error === 'Captcha verification failed') {
      errorMsg = lang.captchaFailed || 'Captcha-Verifikation fehlgeschlagen. Bitte Widget erneut bestätigen.';
      cfTurnstileToken = null;
    } else if (r.error === 'user_banned') {
      errorMsg = lang.inviteUserBanned || 'Du wurdest von diesem Server gebannt und kannst nicht beitreten.';
    } else if (r.error === 'server_full') {
      errorMsg = lang.inviteServerFull || 'Server ist voll.';
    } else if (r.error === 'invite_expired') {
      errorMsg = lang.inviteExpired || 'Invite-Link ist abgelaufen.';
    } else if (r.error === 'invite_used_up') {
      errorMsg = lang.inviteUsedUp || 'Invite-Link wurde schon aufgebraucht.';
    } else {
      errorMsg = (lang.inviteJoinFailed || 'Beitritt fehlgeschlagen') + ': ' + r.error;
    }
  }

  function close() { isOpen = false; }
  function onBackdropClick(e) { if (e.target.classList.contains('sj-overlay')) close(); }
  function onKey(e) { if (e.key === 'Escape' && isOpen) close(); }
</script>

<svelte:window onkeydown={onKey} />

{#if isOpen && info}
  <div class="sj-overlay" role="presentation" onclick={onBackdropClick}>
    <div class="sj-dialog" role="dialog" aria-labelledby="sj-title" aria-modal="true">
      <div class="sj-header">
        <h3 id="sj-title">{lang.inviteJoinTitle || 'Server-Einladung'}</h3>
        <button type="button" class="close-btn" onclick={close} aria-label="Close" disabled={busy}>×</button>
      </div>

      <div class="sj-info">
        <div class="sj-server-name">{info.name}</div>
        {#if info.description}
          <div class="sj-server-desc">{info.description}</div>
        {/if}
        <div class="sj-meta">
          {(lang.inviteMemberCount || '{count} Mitglieder').replace('{count}', String(info.memberCount || 0))}
          {#if info.inviterHandle}
            · {(lang.inviteFrom || 'von @{handle}').replace('{handle}', info.inviterHandle)}
          {/if}
        </div>
      </div>

      <!-- Turnstile -->
      <div bind:this={turnstileEl} class="sj-turnstile"></div>

      {#if errorMsg}
        <div class="sj-error">{errorMsg}</div>
      {/if}

      <div class="sj-actions">
        <button type="button" class="btn-secondary" onclick={close} disabled={busy}>
          {lang.cancel || 'Abbrechen'}
        </button>
        <button type="button" class="btn-primary" onclick={onJoin} disabled={busy}>
          {#if busy}
            <span class="spinner-sm"></span>
            {lang.joining || 'Beitrete…'}
          {:else}
            {lang.inviteJoinBtn || 'Beitreten'}
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .sj-overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.65);
    z-index: 1110;
    display: flex; align-items: center; justify-content: center;
    padding: 20px;
  }
  .sj-dialog {
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 14px;
    padding: 22px;
    width: 100%; max-width: 440px;
    max-height: calc(100vh - 40px);
    max-height: calc(100dvh - 40px);
    overflow-y: auto;
    box-shadow: 0 16px 48px rgba(0,0,0,0.6);
    display: flex; flex-direction: column; gap: 14px;
  }
  .sj-header {
    display: flex; justify-content: space-between; align-items: center;
  }
  .sj-header h3 { margin: 0; font-size: 17px; color: var(--text-primary); }
  .close-btn {
    background: none; border: none; font-size: 22px;
    color: var(--text-muted); cursor: pointer;
    padding: 4px 8px; border-radius: 6px; line-height: 1;
  }
  .close-btn:hover { color: var(--text-primary); background: var(--bg-panel-alt); }
  .close-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .sj-info {
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    padding: 14px;
    display: flex; flex-direction: column; gap: 6px;
  }
  .sj-server-name {
    font-size: 16px; font-weight: 700;
    color: var(--text-primary);
  }
  .sj-server-desc {
    font-size: 13px; color: var(--text-secondary);
    line-height: 1.4;
  }
  .sj-meta {
    font-size: 11px; color: var(--text-muted);
    margin-top: 4px;
  }

  .sj-turnstile {
    display: flex; justify-content: center;
    min-height: 65px;
  }

  .sj-error {
    padding: 10px 12px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid var(--status-error);
    border-radius: 8px;
    color: var(--status-error);
    font-size: 12px;
  }

  .sj-actions {
    display: flex; justify-content: flex-end; gap: 8px;
  }
  .btn-primary, .btn-secondary {
    padding: 9px 16px; border-radius: 8px;
    font-size: 13px; font-weight: 700;
    cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .btn-primary { background: var(--accent-voice); color: #07070a; border: none; }
  .btn-primary:hover:not(:disabled) { opacity: 0.9; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-secondary {
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border-subtle);
  }
  .btn-secondary:hover:not(:disabled) {
    color: var(--text-primary); background: var(--bg-panel-alt);
  }
  .btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }

  .spinner-sm {
    display: inline-block; width: 12px; height: 12px;
    border: 1.5px solid currentColor; border-top-color: transparent;
    border-radius: 50%; animation: spin 0.6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
