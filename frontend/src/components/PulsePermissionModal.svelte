<!--
  PulsePermissionModal — iOS-First-Time-Erklärung vor dem DeviceMotion-Prompt
  (PULSE.md §9.2). "Erlauben" triggert die iOS-Permission AUS DEM Klick-Handler
  (Pflicht für iOS). Bei Ablehnung läuft Pulse mit Touch/Typing-Fallback weiter
  (kein Nag). "Abbrechen" aktiviert Pulse nicht.
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { pulseStore } from '../stores/pulseStore.svelte.js';
  import { requestMotion } from '../lib/pulse/permission.js';

  let { isOpen = $bindable(false), peer = null } = $props();
  let lang = $derived(i18nStore.lang);
  let busy = $state(false);

  async function allow() {
    if (busy) return;
    busy = true;
    try {
      const res = await requestMotion();       // muss aus User-Geste kommen
      pulseStore.setMotionGranted(res === 'granted');
    } catch {
      pulseStore.setMotionGranted(false);
    } finally {
      busy = false;
    }
    // Pulse für diesen Chat aktivieren (Motion optional, Fallback Touch/Typing)
    if (peer) pulseStore.setEnabledFor(peer, true);
    isOpen = false;
  }

  function cancel() {
    isOpen = false; // nicht aktivieren
  }
</script>

{#if isOpen}
  <div class="pulse-perm-backdrop" role="dialog" aria-modal="true" aria-labelledby="pulse-perm-title">
    <div class="pulse-perm-card">
      <div class="pulse-perm-icon">✨</div>
      <h2 id="pulse-perm-title">{lang.pulsePermTitle || 'Pulse aktivieren'}</h2>
      <p class="pulse-perm-body">
        {lang.pulsePermBody || 'RENEX nutzt subtile Bewegung deines Geräts, um deine Anwesenheit sichtbar zu machen.'}
      </p>
      <ul class="pulse-perm-points">
        <li>✓ {lang.pulsePermPoint1 || 'Vollständig auf deinem Gerät'}</li>
        <li>✓ {lang.pulsePermPoint2 || 'Nichts wird gespeichert'}</li>
        <li>✓ {lang.pulsePermPoint3 || 'Nur dein Gegenüber sieht es'}</li>
      </ul>
      <p class="pulse-perm-hint">
        {lang.pulsePermHint || 'iOS fragt im nächsten Schritt nach der Bewegungs-Berechtigung.'}
      </p>
      <div class="pulse-perm-actions">
        <button class="btn-secondary" onclick={cancel} disabled={busy}>
          {lang.cancel || 'Abbrechen'}
        </button>
        <button class="btn-primary" onclick={allow} disabled={busy}>
          {lang.pulsePermAllow || 'Erlauben →'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .pulse-perm-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
    padding: 20px;
  }
  .pulse-perm-card {
    width: 100%;
    max-width: 360px;
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 16px;
    padding: 28px 24px;
    text-align: center;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  }
  .pulse-perm-icon { font-size: 34px; }
  .pulse-perm-card h2 {
    font-size: 18px;
    font-weight: 800;
    color: var(--text-primary);
    margin: 8px 0 12px;
  }
  .pulse-perm-body {
    font-size: 14px;
    color: var(--text-secondary);
    line-height: 1.6;
    margin: 0 0 16px;
  }
  .pulse-perm-points {
    list-style: none;
    padding: 0;
    margin: 0 0 16px;
    text-align: left;
    display: inline-block;
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.9;
  }
  .pulse-perm-hint {
    font-size: 12px;
    color: var(--text-muted);
    margin: 0 0 20px;
  }
  .pulse-perm-actions {
    display: flex;
    gap: 10px;
    justify-content: center;
  }
  .btn-secondary, .btn-primary {
    padding: 11px 20px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    border: none;
    transition: background 0.15s, opacity 0.15s;
  }
  .btn-secondary {
    background: var(--bg-panel-alt);
    color: var(--text-secondary);
    border: 1px solid var(--border-subtle);
  }
  .btn-primary {
    background: var(--accent-voice);
    color: #07070a;
  }
  .btn-primary:hover:not(:disabled) { background: #0ea5e9; }
  .btn-secondary:disabled, .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
