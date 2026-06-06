<!--
  PulseToggle — Ein/Aus-Schalter für Pulse im Chat-Header (1:1 only, default OFF).
  Spec: PULSE.md §9.1 (Per-Chat-Opt-in). Beim Einschalten auf iOS zuerst der
  Erklär-Dialog (PulsePermissionModal), sonst direkt aktivieren.
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { pulseStore } from '../stores/pulseStore.svelte.js';
  import { motionNeedsPermission } from '../lib/pulse/permission.js';
  import PulsePermissionModal from './PulsePermissionModal.svelte';

  let { peer } = $props();
  let lang = $derived(i18nStore.lang);
  let showPermModal = $state(false);

  // Aktiv-Zustand reaktiv aus dem Store (activate(peer) wird in ChatView gesetzt)
  let active = $derived(pulseStore.enabled && pulseStore.activePeer === String(peer || '').toLowerCase());

  // Mini-Self-Indicator (§9.5): der Punkt pulsiert mit der eigenen Energie —
  // sofortiges Feedback ("mein Pulse geht raus"), auch wenn der Peer (noch) nicht teilt.
  let selfE = $derived(active ? pulseStore.selfEnergy : 0);

  function toggle() {
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

<button
  class="pulse-toggle action-btn"
  class:active
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
</button>

<PulsePermissionModal bind:isOpen={showPermModal} {peer} />

<style>
  .pulse-toggle {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    line-height: 1;
    transition: all 0.15s;
  }
  .pulse-toggle:hover {
    background: var(--accent-voice-dim);
  }
  .pulse-toggle.active {
    background: var(--accent-voice-dim);
    color: var(--accent-voice);
    box-shadow: 0 0 0 1px var(--accent-voice) inset;
  }
  /* Glühender Punkt (Leuchtkäfer/Pulse-Mark) statt ✨ — wir haben keine Sterne mehr */
  .pulse-dot {
    display: inline-block;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: currentColor;
    transition: transform 0.08s linear, opacity 0.08s linear, box-shadow 0.15s;
    will-change: transform;
  }
  .pulse-toggle.active .pulse-dot {
    box-shadow: 0 0 8px var(--accent-voice), 0 0 3px var(--accent-voice);
  }
</style>
