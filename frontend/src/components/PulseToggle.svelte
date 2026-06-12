<!--
  PulseToggle — Ein/Aus-Schalter für Pulse im Chat-Header (1:1 only, default OFF).
  Spec: PULSE.md §9.1 (Per-Chat-Opt-in). Beim Einschalten auf iOS zuerst der
  Erklär-Dialog (PulsePermissionModal), sonst direkt aktivieren.

  Discovery (Vorstufe zu §9.5):
   - inaktiv = Pill mit „Pulse"-Label (selbst-erklärend); aktiv = nur Glüh-Punkt.
   - Einmaliger, wegklickbarer Coachmark beim ersten geöffneten DM
     (global `renex_pulse_hint_seen`). Aktiviert NICHTS automatisch (Opt-in bleibt).
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { pulseStore } from '../stores/pulseStore.svelte.js';
  import { motionNeedsPermission } from '../lib/pulse/permission.js';
  import { get, set } from '../lib/storage.js';
  import PulsePermissionModal from './PulsePermissionModal.svelte';

  let { peer } = $props();
  let lang = $derived(i18nStore.lang);
  let showPermModal = $state(false);
  let showHint = $state(false);

  const HINT_SEEN = 'pulse_hint_seen';

  // Aktiv-Zustand reaktiv aus dem Store (activate(peer) wird in ChatView gesetzt)
  let active = $derived(pulseStore.enabled && pulseStore.activePeer === String(peer || '').toLowerCase());

  // Mini-Self-Indicator (§9.5): der Punkt pulsiert mit der eigenen Energie.
  let selfE = $derived(active ? pulseStore.selfEnergy : 0);

  // Einmaliger Coachmark beim ersten geöffneten DM (global, nie wieder). Zeigt nur
  // WO + WAS — aktiviert NICHTS (Opt-in-Hardrule). Trägt nicht in andere Chats über.
  $effect(() => {
    if (peer && !active && !get(HINT_SEEN)) {
      set(HINT_SEEN, 'true');
      showHint = true;
    } else {
      showHint = false;
    }
  });

  function dismissHint() {
    showHint = false;
  }

  function toggle() {
    dismissHint();
    if (!peer) return;
    if (active) {
      pulseStore.setEnabledFor(peer, false);
      return;
    }
    // Einschalten
    if (motionNeedsPermission() && !pulseStore.motionGranted) {
      showPermModal = true;   // iOS: erst erklären, dann Permission im Modal
      return;
    }
    // Desktop/Android: Motion (falls vorhanden) braucht keinen Prompt
    pulseStore.setMotionGranted(true);
    pulseStore.setEnabledFor(peer, true);
  }
</script>

<div class="pulse-wrap">
  <button
    class="pulse-toggle action-btn"
    class:active
    class:has-label={!active}
    onclick={toggle}
    title={active ? (lang.pulseOff || 'Pulse aus') : (lang.pulseOn || 'Pulse an')}
    aria-label={active ? (lang.pulseOff || 'Pulse off') : (lang.pulseOn || 'Pulse on')}
    aria-pressed={active}
  >
    <span
      class="pulse-dot"
      style:transform={`scale(${1 + selfE * 0.6})`}
      style:opacity={active ? 0.5 + selfE * 0.5 : 1}
    ></span>
    {#if !active}<span class="pulse-label">Pulse</span>{/if}
  </button>

  {#if showHint}
    <div class="pulse-coach" role="status">
      <span class="pulse-coach-arrow" aria-hidden="true"></span>
      <span class="pulse-coach-text">{lang.pulseHintText || 'Pulse — sieh, wann jemand wirklich da ist. Tippen zum Aktivieren.'}</span>
      <button class="pulse-coach-x" onclick={dismissHint} aria-label={lang.dismiss || 'Schließen'} type="button">×</button>
    </div>
  {/if}
</div>

<PulsePermissionModal bind:isOpen={showPermModal} {peer} />

<style>
  .pulse-wrap { position: relative; display: inline-flex; }

  .pulse-toggle {
    height: 36px;
    min-width: 36px;
    width: auto;
    border-radius: 50%;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0;
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
    transition: background 0.15s, color 0.15s;
  }
  /* Inaktiv + Label = Pill (selbst-erklärend). Aktiv = runder Icon-Button. */
  .pulse-toggle.has-label {
    border-radius: 999px;
    padding: 0 12px 0 10px;
  }
  .pulse-toggle:hover { background: var(--accent-voice-dim); }
  .pulse-toggle.active {
    background: var(--accent-voice-dim);
    color: var(--accent-voice);
    box-shadow: 0 0 0 1px var(--accent-voice) inset;
  }

  .pulse-label { white-space: nowrap; letter-spacing: 0.01em; }

  /* Glühender Punkt (Leuchtkäfer/Pulse-Mark) */
  .pulse-dot {
    display: inline-block;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: currentColor;
    flex-shrink: 0;
    transition: transform 0.08s linear, opacity 0.08s linear, box-shadow 0.15s;
    will-change: transform;
  }
  .pulse-toggle.active .pulse-dot {
    background: radial-gradient(circle, #ffe1a8 0%, #ffcf7a 36%, var(--accent-voice) 100%);
    box-shadow: 0 0 8px var(--accent-voice), 0 0 3px var(--accent-voice);
  }

  /* ── Einmaliger Coachmark (öffnet nach unten-rechts, innerhalb der chat-view) ── */
  .pulse-coach {
    position: absolute;
    top: calc(100% + 10px);
    right: 0;
    z-index: 60;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: max-content;
    max-width: min(260px, 72vw);
    padding: 10px 8px 10px 12px;
    background: var(--bg-panel);
    border: 1px solid var(--accent-voice);
    border-radius: 12px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
    animation: coach-in 0.22s ease-out;
  }
  @media (prefers-reduced-motion: reduce) { .pulse-coach { animation: none; } }
  @keyframes coach-in {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .pulse-coach-arrow {
    position: absolute;
    top: -6px;
    right: 13px;
    width: 11px;
    height: 11px;
    background: var(--bg-panel);
    border-left: 1px solid var(--accent-voice);
    border-top: 1px solid var(--accent-voice);
    transform: rotate(45deg);
  }
  .pulse-coach-text {
    font-size: 12.5px;
    line-height: 1.4;
    color: var(--text-primary);
  }
  .pulse-coach-x {
    flex-shrink: 0;
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    padding: 0 2px;
    margin-top: -1px;
  }
  .pulse-coach-x:hover { color: var(--text-primary); }
</style>
