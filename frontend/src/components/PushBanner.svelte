<!--
  PushBanner — Notification-Aktivierung-Banner
  Migration von /renex/index.html #push-banner.

  iOS-Spezifikum: requestPermission() MUSS synchron nach User-Click
  aufgerufen werden, vor anderen awaits. Daher die Reihenfolge:
   1) requestPermission()  ← synchron im click-handler
   2) initServiceWorker()
   3) subscribeToPush()
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { getPushStatus, requestPermissionAndSubscribe, initServiceWorker, subscribeToPush } from '../lib/push.js';

  let lang = $derived(i18nStore.lang);

  // States
  let isVisible = $state(false);
  let isBusy = $state(false);
  let title = $state("");
  let subtitle = $state("");

  // Bei Mount: Status prüfen
  $effect(() => {
    initStatus();
  });

  async function initStatus() {
    const s = await getPushStatus();
    if (!s.supported) return;

    // Permission granted → Subscription syncen + ausblenden
    if (s.permission === "granted") {
      await initServiceWorker();
      subscribeToPush().catch(() => {});
      isVisible = false;
      return;
    }

    // Permission default oder denied → Banner zeigen
    title = lang.pushBannerTitle || "Enable notifications";
    subtitle = lang.pushBannerSubtitle || "Don't miss any messages";
    isVisible = true;
  }

  async function onActivate() {
    if (isBusy) return;
    isBusy = true;
    title = lang.pushBannerActivating || "Activating…";
    try {
      const r = await requestPermissionAndSubscribe();
      if (r.granted) {
        isVisible = false;
      } else {
        title = lang.pushBannerBlocked || "Notifications blocked";
        setTimeout(() => { isVisible = false; }, 2000);
      }
    } catch {
      isVisible = false;
    } finally {
      isBusy = false;
    }
  }

  function onKeydown(e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate();
    }
  }
</script>

{#if isVisible}
  <div
    class="push-banner"
    role="button"
    tabindex="0"
    aria-label="Enable notifications"
    onclick={onActivate}
    onkeydown={onKeydown}
  >
    <div class="icon">🔔</div>
    <div class="text">
      <div class="title">{title}</div>
      <div class="subtitle">{subtitle}</div>
    </div>
    <div class="arrow">→</div>
  </div>
{/if}

<style>
  .push-banner {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 10px 10px 6px;
    padding: 12px 14px;
    background: linear-gradient(135deg, rgba(56, 189, 248, 0.18), rgba(56, 189, 248, 0.05));
    border: 1px solid var(--accent-voice);
    border-radius: 12px;
    cursor: pointer;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
    transition: background 0.2s ease, transform 0.1s ease;
    flex-shrink: 0;
  }

  .push-banner:hover,
  .push-banner:focus-visible {
    background: linear-gradient(135deg, rgba(56, 189, 248, 0.28), rgba(56, 189, 248, 0.08));
    outline: none;
  }

  .push-banner:active {
    transform: scale(0.98);
  }

  .icon {
    font-size: 22px;
    line-height: 1;
    flex-shrink: 0;
  }

  .text {
    flex: 1;
    min-width: 0;
  }

  .title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    line-height: 1.3;
  }

  .subtitle {
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1.3;
    margin-top: 2px;
  }

  .arrow {
    font-size: 18px;
    color: var(--accent-voice);
    flex-shrink: 0;
    font-weight: 600;
  }
</style>
