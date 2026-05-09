<!--
  DeviceLimitModal — zeigt sich wenn /e2e/inbox/upload mit 409 device_limit_reached
  antwortet (User hat 5 Devices erreicht).

  Erklärt dem User dass er ein altes Device entfernen muss bevor das aktuelle
  registriert werden kann. Verweist auf Profil → Geräte für die Verwaltung.
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';

  /** @type {{ info: { currentDevices: number, maxDevices: number } | null }} */
  let { info = $bindable(null) } = $props();

  let lang = $derived(i18nStore.lang);
  let isOpen = $derived(!!info);

  function close() {
    info = null;
  }

  function onKeydown(e) {
    if (e.key === "Escape") close();
  }

  function onBackdrop(e) {
    if (e.target.classList.contains("dl-overlay")) close();
  }
</script>

{#if isOpen}
  <div class="dl-overlay" role="presentation" onclick={onBackdrop}>
    <div
      class="dl-dialog"
      role="alertdialog"
      aria-labelledby="dl-title"
      aria-modal="true"
      tabindex="-1"
      onkeydown={onKeydown}
    >
      <div class="dl-icon">📱</div>

      <h3 id="dl-title">
        {lang.deviceLimitTitle || "Geräte-Limit erreicht"}
      </h3>

      <p class="dl-msg">
        {(lang.deviceLimitMessage || "Du verwendest aktuell {current}/{max} Geräte. Um dieses Gerät hinzuzufügen, entferne zuerst ein altes Gerät unter Profil → Geräte.")
          .replace("{current}", info.currentDevices)
          .replace("{max}", info.maxDevices)}
      </p>

      <div class="dl-buttons">
        <button class="btn btn-primary" onclick={close}>
          {lang.deviceLimitOkBtn || lang.understandBtn || "Verstanden"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .dl-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    z-index: 1200;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    animation: fadeIn 0.15s ease-out;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .dl-dialog {
    background: var(--bg-panel);
    border: 1px solid var(--status-error, #ef4444);
    border-radius: 14px;
    padding: 24px;
    width: 100%;
    max-width: 380px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
    text-align: center;
  }

  .dl-icon {
    font-size: 40px;
    margin-bottom: 8px;
  }

  .dl-dialog h3 {
    margin: 0 0 12px;
    font-size: 17px;
    color: var(--text-primary);
  }

  .dl-msg {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.55;
    margin: 0 0 12px;
  }

  .dl-buttons {
    display: flex;
    justify-content: center;
    gap: 8px;
    margin-top: 16px;
  }

  .btn {
    padding: 10px 20px;
    border-radius: 8px;
    border: 1px solid transparent;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .btn-primary {
    background: var(--accent-voice);
    color: #07070a;
  }
  .btn-primary:hover { background: #0ea5e9; }
</style>
