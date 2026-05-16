<!--
  SettingsDevicesPanel — Multi-Device Management
  Spec: docs/MULTI_DEVICE.md §12

  Features:
   - Liste eigener aktiver Devices (GET /e2e/devices/list)
   - "AKTUELL"-Badge auf currentDeviceId
   - Revoke-Button (anderer Text + reason für current vs other)
   - Live-Update bei device_added/device_removed WS-Events
   - Limit-Indicator (3 / 5)
   - Auto-Revoke-Hinweis (30d)
-->
<script>
  import { onMount, onDestroy } from 'svelte';
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { userStore } from '../stores/user.svelte.js';
  import { sessionStore } from '../stores/session.svelte.js';
  import { ws } from '../lib/ws.js';
  import { listDevices, revokeDevice, formatRelativeTime, deviceIcon } from '../lib/multidevice.js';
  import { captureException } from '../lib/sentry.js';
  import AddDeviceModal from './AddDeviceModal.svelte';

  let { isOpen = $bindable(false) } = $props();

  // Add-Device-Modal: getrennt vom devices-Panel-State, da das Add-Modal
  // über dem Panel liegt und beide gleichzeitig sichtbar sein können.
  let addDeviceOpen = $state(false);

  let lang = $derived(i18nStore.lang);
  let currentDeviceId = $derived(userStore.deviceId);

  let devices = $state([]);
  let maxDevices = $state(5);
  let tier = $state('free');
  let isLoading = $state(false);
  let busyDeviceId = $state(null);
  let errorMsg = $state('');

  // ── WS-Listener für Live-Updates ──────────────────
  let _unsubAdded = null;
  let _unsubRemoved = null;

  $effect(() => {
    if (isOpen) {
      load();
      _unsubAdded = ws.on('device_added', () => load());
      _unsubRemoved = ws.on('device_removed', () => load());
      return () => {
        if (_unsubAdded) { _unsubAdded(); _unsubAdded = null; }
        if (_unsubRemoved) { _unsubRemoved(); _unsubRemoved = null; }
      };
    }
  });

  async function load() {
    isLoading = true;
    errorMsg = '';
    try {
      const data = await listDevices(currentDeviceId);
      if (data) {
        devices = data.devices || [];
        maxDevices = data.maxDevices ?? 5;
        tier = data.tier || 'free';
      } else {
        errorMsg = lang.devicesLoadFailed || 'Geräte konnten nicht geladen werden';
      }
    } catch (e) {
      captureException(e, { context: 'loadDevices' });
      errorMsg = lang.devicesLoadFailed || 'Geräte konnten nicht geladen werden';
    } finally {
      isLoading = false;
    }
  }

  async function onRevoke(device) {
    if (busyDeviceId) return;

    const isCurrent = device.deviceId === currentDeviceId;
    const reason = isCurrent ? 'self' : 'user';

    const confirmText = isCurrent
      ? (lang.deviceLogoutConfirm || 'Diese Sitzung wirklich beenden?')
      : (lang.deviceRevokeConfirm || 'Gerät entfernen? Diese Aktion ist endgültig. Alle Konversationen werden mit neuen Schlüsseln re-verschlüsselt.');

    if (!confirm(confirmText)) return;

    busyDeviceId = device.deviceId;
    errorMsg = '';

    try {
      const r = await revokeDevice(device.deviceId, reason);
      if (!r.ok) {
        errorMsg = (lang.deviceRevokeFailed || 'Entfernen fehlgeschlagen') + ': ' + (r.error || '');
        return;
      }

      if (isCurrent) {
        // Self-Revoke = Logout
        await sessionStore.logout();
        return;
      }

      // Live-Update via WS-Event käme normalerweise — aber zur Sicherheit lokal entfernen
      devices = devices.filter(d => d.deviceId !== device.deviceId);
    } finally {
      busyDeviceId = null;
    }
  }

  function close() {
    isOpen = false;
  }

  function onBackdropClick(e) {
    if (e.target.classList.contains('dev-overlay')) close();
  }

  function locale() {
    return lang.locale || 'de-DE';
  }

  let activeCount = $derived(devices.length);
  let limitReached = $derived(activeCount >= maxDevices);
</script>

{#if isOpen}
  <div class="dev-overlay" role="presentation" onclick={onBackdropClick}>
    <div class="dev-dialog" role="dialog" aria-labelledby="dev-title" aria-modal="true">
      <div class="dev-header">
        <h3 id="dev-title">{lang.devicesTitle || 'Geräte verwalten'}</h3>
        <button class="close-btn" onclick={close} aria-label="Close">×</button>
      </div>

      <p class="dev-hint">
        {activeCount} / {maxDevices} {lang.devicesActive || 'Geräte aktiv'}
        {#if tier === 'free' && limitReached}
          · <span class="upgrade">{lang.devicesUpgradeHint || 'Upgrade auf Pro für 10 Geräte'}</span>
        {/if}
      </p>

      {#if errorMsg}
        <div class="dev-error">{errorMsg}</div>
      {/if}

      <div class="dev-list">
        {#if isLoading && devices.length === 0}
          <div class="dev-loading">
            <span class="spinner"></span>
            {lang.loading || 'Lade…'}
          </div>
        {:else if devices.length === 0}
          <div class="dev-empty">
            {lang.devicesEmpty || 'Keine aktiven Geräte.'}
          </div>
        {:else}
          {#each devices as d (d.deviceId)}
            {@const isCurrent = d.deviceId === currentDeviceId}
            {@const isSyncing = d.state === 'syncing'}
            <div class="dev-item" class:current={isCurrent}>
              <div class="dev-icon">{deviceIcon(d.name || d.userAgent)}</div>
              <div class="dev-info">
                <div class="dev-name">
                  {d.name || (lang.deviceUnnamed || 'Unbenanntes Gerät')}
                  {#if isCurrent}
                    <span class="dev-badge">{lang.deviceCurrent || 'AKTUELL'}</span>
                  {/if}
                </div>
                <div class="dev-meta">
                  {#if isSyncing}
                    <span class="syncing">
                      <span class="spinner-sm"></span>
                      {lang.deviceSyncing || 'syncing…'}
                    </span>
                  {:else}
                    <span>{lang.deviceLastSeen || 'zuletzt'}: {formatRelativeTime(d.lastSeenAt, locale())}</span>
                  {/if}
                </div>
              </div>
              <button
                class="dev-revoke"
                class:logout-style={isCurrent}
                disabled={busyDeviceId === d.deviceId}
                onclick={() => onRevoke(d)}
                aria-label={isCurrent ? (lang.deviceLogoutBtn || 'Sign out') : (lang.deviceRevokeBtn || 'Remove')}
              >
                {#if busyDeviceId === d.deviceId}
                  <span class="spinner-sm"></span>
                {:else if isCurrent}
                  {lang.deviceLogoutBtn || 'Sitzung beenden'}
                {:else}
                  {lang.deviceRevokeBtn || 'Entfernen'}
                {/if}
              </button>
            </div>
          {/each}
        {/if}
      </div>

      <button
        class="dev-add-btn"
        disabled={limitReached}
        onclick={() => { if (!limitReached) addDeviceOpen = true; }}
        title={limitReached ? (lang.addDeviceLimitTooltip || 'Limit erreicht. Entferne ein Gerät oder upgrade auf Pro.') : ''}
      >
        {lang.addDeviceBtn || '+ Neues Gerät hinzufügen'}
      </button>

      <p class="dev-footer-hint">
        {lang.deviceAutoRevokeHint || 'Geräte werden nach 30 Tagen Inaktivität automatisch entfernt.'}
      </p>
    </div>
  </div>

  <AddDeviceModal bind:isOpen={addDeviceOpen} />
{/if}

<style>
  .dev-overlay {
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

  .dev-dialog {
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 14px;
    padding: 22px;
    width: 100%;
    max-width: 460px;
    max-height: calc(100vh - 40px);
    max-height: calc(100dvh - 40px);
    overflow-y: auto;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
  }

  .dev-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .dev-header h3 {
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

  .dev-hint {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0 0 14px 0;
  }

  .upgrade {
    color: var(--accent-voice);
  }

  .dev-error {
    padding: 10px 12px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid var(--status-error);
    border-radius: 8px;
    color: var(--status-error);
    font-size: 12px;
    margin-bottom: 12px;
  }

  .dev-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 14px;
    min-height: 60px;
  }

  .dev-loading,
  .dev-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px;
    color: var(--text-muted);
    font-size: 13px;
  }

  .dev-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
  }

  .dev-item.current {
    border-color: var(--accent-voice);
    background: var(--accent-voice-dim);
  }

  .dev-icon {
    font-size: 22px;
    line-height: 1;
    flex-shrink: 0;
  }

  .dev-info {
    flex: 1;
    min-width: 0;
  }

  .dev-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 2px;
  }

  .dev-badge {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.5px;
    color: var(--accent-voice);
    background: var(--bg-panel);
    padding: 2px 6px;
    border-radius: 4px;
    border: 1px solid var(--accent-voice);
  }

  .dev-meta {
    font-size: 11px;
    color: var(--text-muted);
  }

  .syncing {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--accent-voice);
  }

  .dev-revoke {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    font-size: 11px;
    padding: 6px 10px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.1s;
    min-width: 80px;
  }

  .dev-revoke:hover:not(:disabled) {
    border-color: var(--status-error);
    color: var(--status-error);
    background: rgba(239, 68, 68, 0.06);
  }

  .dev-revoke.logout-style:hover:not(:disabled) {
    border-color: var(--accent-voice);
    color: var(--accent-voice);
    background: var(--accent-voice-dim);
  }

  .dev-revoke:disabled {
    opacity: 0.5;
    cursor: wait;
  }

  .dev-add-btn {
    display: block;
    width: 100%;
    padding: 11px 14px;
    margin-bottom: 14px;
    background: transparent;
    border: 1px dashed var(--accent-voice);
    border-radius: 10px;
    color: var(--accent-voice);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.12s;
  }
  .dev-add-btn:hover:not(:disabled) {
    background: var(--accent-voice-dim);
  }
  .dev-add-btn:disabled {
    border-color: var(--border-subtle);
    color: var(--text-muted);
    cursor: not-allowed;
    opacity: 0.6;
  }

  .dev-footer-hint {
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1.4;
    margin: 0;
    padding-top: 8px;
    border-top: 1px solid var(--border-subtle);
  }

  .spinner,
  .spinner-sm {
    display: inline-block;
    border: 2px solid var(--border-subtle);
    border-top-color: var(--accent-voice);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  .spinner {
    width: 16px;
    height: 16px;
  }

  .spinner-sm {
    width: 10px;
    height: 10px;
    border-width: 1.5px;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
</style>
