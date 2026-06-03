<!--
  AddDeviceModal — Onboarding-Hilfe für Cross-Device-Passkey-Add-Flow
  Spec: docs/MULTI_DEVICE.md §12.1 / §12.2 ("+ Neues Gerät hinzufügen")

  Was zeigt der QR?
   - URL https://renex.id (Onboarding-Helper, NICHT der WebAuthn-Hybrid-QR).
   - Der WebAuthn-Hybrid-QR wird vom OS auf dem NEUEN Gerät erzeugt, sobald
     der User dort "Mit Passkey anmelden" → "anderes Gerät" wählt.
   - Wir liefern nur den schnellen Sprung "Wo geh ich auf dem neuen Gerät hin?".

  Sicherheit:
   - Der Modal löst KEINE Backend-Calls aus. Die eigentliche Geräte-Registrierung
     passiert auf dem neuen Gerät via WebAuthn → POST /e2e/inbox/upload.
   - Bestätigung des Adds geschieht implizit durch den Cross-Device-Passkey
     (siehe MULTI_DEVICE.md Decision Log 2026-04-28).
-->
<script>
  import { onMount } from 'svelte';
  import QRCode from 'qrcode';
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { captureException } from '../lib/sentry.js';

  let { isOpen = $bindable(false) } = $props();

  let lang = $derived(i18nStore.lang);

  // Fix-URL — Brand-Apex. Bewusst hartkodiert: der QR ändert sich nie und
  // muss in BEIDEN Worlds (Production via renex.id und Local-Dev via
  // localhost:5173) stabil das Production-Ziel zeigen, damit der gescannte
  // QR aus einem Local-Dev-Tab den User trotzdem zur richtigen App führt.
  const APP_URL = 'https://renex.id';

  let qrSvg = $state('');
  let qrError = $state(false);

  async function generateQr() {
    try {
      qrError = false;
      qrSvg = await QRCode.toString(APP_URL, {
        type: 'svg',
        width: 220,
        margin: 1,
        errorCorrectionLevel: 'M',
        color: {
          // Cyan-on-Dark passt zum App-Theme (var(--accent-voice) = #38bdf8).
          // Hartkodiert da SVG-Inline keine CSS-Variablen unterstützt.
          dark: '#38bdf8',
          light: '#0f0f12',
        },
      });
    } catch (e) {
      captureException(e, { context: 'AddDeviceModal.generateQr', extra: { url: APP_URL } });
      qrError = true;
    }
  }

  // QR nur generieren wenn Modal sichtbar — spart Initialisierung beim Mount.
  $effect(() => {
    if (isOpen && !qrSvg && !qrError) {
      void generateQr();
    }
  });

  function close() { isOpen = false; }

  function onBackdropClick(e) {
    if (e.target.classList.contains('add-overlay')) close();
  }

  function onKey(e) {
    if (e.key === 'Escape' && isOpen) close();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if isOpen}
  <div class="add-overlay" role="presentation" onclick={onBackdropClick}>
    <div class="add-dialog" role="dialog" aria-labelledby="add-title" aria-modal="true">
      <div class="add-header">
        <h3 id="add-title">{lang.addDeviceTitle || 'Neues Gerät hinzufügen'}</h3>
        <button class="close-btn" onclick={close} aria-label="Close">×</button>
      </div>

      <p class="add-intro">
        {lang.addDeviceIntro || 'Folge diesen Schritten — dein Passkey bleibt sicher auf diesem Gerät.'}
      </p>

      <ol class="add-steps">
        <li>{lang.addDeviceStep1 || 'Auf dem neuen Gerät renex.id öffnen.'}</li>
        <li>{lang.addDeviceStep2 || 'Deinen Handle eingeben und einloggen — der Browser zeigt dort einen QR-Code.'}</li>
        <li>{lang.addDeviceStep3 || 'Diesen QR-Code mit der Kamera-App dieses Geräts scannen.'}</li>
        <li>{lang.addDeviceStep4 || 'Mit Touch-ID / Face-ID bestätigen — fertig.'}</li>
      </ol>

      <div class="convenience-section">
        <p class="convenience-tip">
          {lang.addDeviceConvenienceTip || '💡 Tipp: Scanne diesen QR mit der Kamera deines neuen Geräts, um renex.id direkt zu öffnen (spart das URL-Eintippen).'}
        </p>
        <div class="qr-wrap qr-wrap-small">
          {#if qrError}
            <div class="qr-fallback">
              <p>{lang.addDeviceQrError || 'QR-Code konnte nicht erzeugt werden.'}</p>
              <p class="qr-url">{APP_URL}</p>
            </div>
          {:else if qrSvg}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            <div class="qr-svg">{@html qrSvg}</div>
          {:else}
            <div class="qr-loading">
              <span class="spinner"></span>
            </div>
          {/if}
        </div>
      </div>

      <p class="add-hint">
        {lang.addDeviceHint || '🔒 Dein Passkey bleibt auf diesem Gerät — er wird nie übertragen. Das neue Gerät erstellt einen eigenen Passkey, den dein bestehender per QR-Scan bestätigt.'}
      </p>

      <p class="add-notice">
        {lang.addDeviceAppleNotice || '✨ Auf Apple-Geräten mit gemeinsamer iCloud-ID erscheint stattdessen automatisch eine Bestätigungs-Benachrichtigung — dann kannst du Schritt 3 überspringen.'}
      </p>

      <div class="add-actions">
        <button class="btn-primary" onclick={close}>
          {lang.addDeviceCloseBtn || 'Verstanden'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .add-overlay {
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

  .add-dialog {
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 14px;
    padding: 22px;
    width: 100%;
    max-width: 420px;
    max-height: calc(100vh - 40px);
    max-height: calc(100dvh - 40px);
    overflow-y: auto;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
  }

  .add-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
  }

  .add-header h3 {
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

  .add-intro {
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-secondary);
    margin: 0 0 16px 0;
  }

  .add-steps {
    margin: 0 0 16px 0;
    padding-left: 22px;
    color: var(--text-primary);
    font-size: 13px;
    line-height: 1.6;
  }
  .add-steps li {
    margin-bottom: 6px;
  }

  .convenience-section {
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    padding: 12px;
    margin-bottom: 14px;
    display: flex;
    gap: 12px;
    align-items: center;
  }
  .convenience-tip {
    flex: 1;
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-secondary);
  }

  .qr-wrap {
    display: flex;
    justify-content: center;
    align-items: center;
    background: #0f0f12;
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
  }
  .qr-wrap-small {
    flex-shrink: 0;
    width: 130px;
    height: 130px;
    padding: 8px;
  }

  .qr-svg {
    line-height: 0;
  }

  .qr-wrap-small .qr-svg :global(svg) {
    display: block;
    width: 114px;
    height: 114px;
  }

  .qr-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 114px;
    height: 114px;
  }

  .qr-fallback {
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }

  .qr-fallback p {
    margin: 4px 0;
  }

  .qr-url {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    color: var(--accent-voice);
    word-break: break-all;
    font-size: 12px;
  }

  .add-hint {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0 0 8px 0;
    padding: 10px 12px;
    background: var(--bg-panel-alt);
    border-radius: 8px;
  }

  .add-notice {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0 0 16px 0;
    padding: 10px 12px;
    background: transparent;
    border: 1px dashed var(--border-subtle);
    border-radius: 8px;
    font-style: italic;
  }

  .add-actions {
    display: flex;
    justify-content: flex-end;
  }

  .btn-primary {
    background: var(--accent-voice);
    color: #07070a;
    border: none;
    padding: 9px 18px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    transition: opacity 0.12s;
  }
  .btn-primary:hover { opacity: 0.9; }

  .spinner {
    display: inline-block;
    width: 22px;
    height: 22px;
    border: 2px solid var(--border-subtle);
    border-top-color: var(--accent-voice);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
</style>
