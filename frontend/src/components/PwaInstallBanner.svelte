<!--
  PwaInstallBanner — Smart Banner + iOS/Safari-Anleitung

  Zeigt sich wenn shouldShowBanner() true ist. Klick "Installieren":
   - native (Chrome/Edge/Brave): nativer beforeinstallprompt-Dialog
   - iOS Safari: zeigt Anleitung als Modal
   - macOS Safari: zeigt Anleitung als Modal
   - sonst: hidden (z.B. Firefox)

  Banner kann auch aus dem ProfileDropdown via prop `forceOpen` getriggert werden,
  um auch Power-User die "Nicht jetzt" geklickt haben zugänglich zu machen.
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import {
    shouldShowBanner, dismissBanner, promptInstallNative, getInstallStrategy,
    onInstallStateChange, onInstallRequested,
  } from '../lib/pwaInstall.js';

  /** @type {{ forceOpen?: boolean, onClose?: () => void }} */
  let { forceOpen = $bindable(false), onClose = () => {} } = $props();

  let lang = $derived(i18nStore.lang);

  let visible = $state(false);
  let showInstructions = $state(false);   // iOS/Safari Modal-State
  let strategy = $state(getInstallStrategy());

  // Re-evaluate wenn beforeinstallprompt feuert oder appinstalled
  $effect(() => {
    const unsub = onInstallStateChange(() => {
      strategy = getInstallStrategy();
      visible = forceOpen || shouldShowBanner();
    });
    return unsub;
  });

  // Initial: zeigen wenn Conditions erfüllt
  $effect(() => {
    visible = forceOpen || shouldShowBanner();
  });

  // Manual-Trigger via requestInstallPrompt() (z.B. ProfileDropdown-Menüitem)
  $effect(() => {
    return onInstallRequested(() => {
      strategy = getInstallStrategy();
      visible = true;
      forceOpen = true;
      // Auf iOS/Safari direkt ins Anleitungs-Modal — sonst Banner reicht für Native-Click
      if (strategy === 'ios-safari' || strategy === 'macos-safari' || strategy === 'firefox' || strategy === 'unsupported') {
        showInstructions = true;
      }
    });
  });

  async function onInstallClick() {
    if (strategy === 'native') {
      const outcome = await promptInstallNative();
      if (outcome === 'accepted') {
        // appinstalled-Event räumt auf — Banner verschwindet automatisch
        return;
      }
      // User hat Native-Prompt abgelehnt → Banner dismissen (cooldown)
      _close();
      return;
    }
    // iOS / macOS Safari: Anleitung zeigen
    showInstructions = true;
  }

  function onDismissClick() {
    _close();
  }

  function _close() {
    if (!forceOpen) dismissBanner();
    visible = false;
    forceOpen = false;
    onClose();
  }

  function closeInstructions() {
    showInstructions = false;
    if (!forceOpen) dismissBanner();
    visible = false;
    forceOpen = false;
    onClose();
  }

  function onInstructionsKey(e) {
    if (e.key === 'Escape') closeInstructions();
  }
</script>

{#if visible}
  <div class="pwa-banner" role="region" aria-label={lang.pwaInstallTitle || 'App installieren'}>
    <div class="pwa-banner-icon">📲</div>
    <div class="pwa-banner-text">
      <div class="pwa-banner-title">{lang.pwaInstallTitle || 'Als App installieren'}</div>
      <div class="pwa-banner-sub">{lang.pwaInstallSub || 'Schneller, eigenes Fenster, Always-on.'}</div>
    </div>
    <button class="pwa-banner-cta" onclick={onInstallClick} type="button">
      {lang.pwaInstallBtn || 'Installieren'}
    </button>
    <button class="pwa-banner-dismiss" onclick={onDismissClick} aria-label={lang.dismiss || 'Schließen'} type="button">×</button>
  </div>
{/if}

{#if showInstructions}
  <div class="pwa-modal-overlay" role="presentation" onclick={closeInstructions}>
    <div
      class="pwa-modal"
      role="dialog"
      aria-labelledby="pwa-modal-title"
      aria-modal="true"
      tabindex="-1"
      onkeydown={onInstructionsKey}
      onclick={(e) => e.stopPropagation()}
    >
      <div class="pwa-modal-header">
        <h3 id="pwa-modal-title">{lang.pwaInstallTitle || 'App installieren'}</h3>
        <button class="pwa-modal-close" onclick={closeInstructions} aria-label="Close" type="button">×</button>
      </div>

      {#if strategy === 'ios-safari'}
        <ol class="pwa-steps">
          <li>{lang.pwaIosStep1 || 'Tippe auf das Teilen-Symbol unten in Safari'} <span class="pwa-icon">⎙</span></li>
          <li>{lang.pwaIosStep2 || 'Wähle „Zum Home-Bildschirm" aus dem Menü.'}</li>
          <li>{lang.pwaIosStep3 || 'Bestätige mit „Hinzufügen" oben rechts.'}</li>
        </ol>
      {:else if strategy === 'macos-safari'}
        <ol class="pwa-steps">
          <li>{lang.pwaMacStep1 || 'Öffne in Safari das Menü „Datei".'}</li>
          <li>{lang.pwaMacStep2 || 'Wähle „Zum Dock hinzufügen…"'}</li>
          <li>{lang.pwaMacStep3 || 'Bestätige im Dialog.'}</li>
        </ol>
      {:else}
        <p class="pwa-fallback">{lang.pwaUnsupportedHint || 'Dein Browser unterstützt keine direkte Installation. Versuche es in Chrome, Edge oder Safari.'}</p>
      {/if}

      <div class="pwa-modal-footer">
        <button class="pwa-modal-ok" onclick={closeInstructions} type="button">
          {lang.deviceLimitOkBtn || 'Verstanden'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .pwa-banner {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 60;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    background: var(--bg-panel);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    max-width: calc(100vw - 24px);
    width: 380px;
    animation: slideUp 0.25s ease-out;
  }
  @keyframes slideUp { from { opacity: 0; transform: translate(-50%, 12px); } to { opacity: 1; transform: translate(-50%, 0); } }
  .pwa-banner-icon { font-size: 22px; flex-shrink: 0; }
  .pwa-banner-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .pwa-banner-title { font-size: 13px; font-weight: 700; color: var(--text-primary); }
  .pwa-banner-sub   { font-size: 11px; color: var(--text-muted); line-height: 1.3; }

  .pwa-banner-cta {
    background: var(--accent-voice);
    color: #07070a;
    border: none;
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .pwa-banner-cta:hover { background: #0ea5e9; }

  .pwa-banner-dismiss {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 18px;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
    line-height: 1;
    flex-shrink: 0;
  }
  .pwa-banner-dismiss:hover { color: var(--text-primary); background: var(--bg-panel-alt); }

  .pwa-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    z-index: 1300;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    animation: fadeIn 0.15s ease-out;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .pwa-modal {
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 14px;
    padding: 22px;
    width: 100%;
    max-width: 400px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
  }
  .pwa-modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 14px;
  }
  .pwa-modal-header h3 { margin: 0; font-size: 16px; color: var(--text-primary); }
  .pwa-modal-close {
    background: none;
    border: none;
    font-size: 22px;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
    line-height: 1;
  }
  .pwa-modal-close:hover { color: var(--text-primary); background: var(--bg-panel-alt); }

  .pwa-steps {
    margin: 0;
    padding-left: 24px;
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.7;
  }
  .pwa-steps li { margin-bottom: 8px; }
  .pwa-icon {
    display: inline-block;
    margin: 0 2px;
    color: var(--accent-voice);
    font-size: 14px;
  }

  .pwa-fallback {
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.5;
    margin: 0;
  }

  .pwa-modal-footer {
    display: flex;
    justify-content: flex-end;
    margin-top: 16px;
  }
  .pwa-modal-ok {
    background: var(--accent-voice);
    color: #07070a;
    border: none;
    border-radius: 8px;
    padding: 9px 18px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
  }
  .pwa-modal-ok:hover { background: #0ea5e9; }
</style>
