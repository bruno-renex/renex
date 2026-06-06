<!--
  PulseController — unsichtbare Lifecycle-Komponente. Solange gemountet (Pulse
  für den offenen 1:1-Chat aktiv), erfasst sie Bewegungs-Inputs, treibt den
  eigenen Pulse (pulseStore.setSelf) und sendet ihn gedrosselt (~6Hz, adaptive)
  an den Peer. Beim Unmount/Peer-Wechsel werden Listener sauber entfernt.

  Spec: PULSE.md §5 (Inputs), §7.1 (10Hz max, adaptiv), §8.4 (Battery).
-->
<script>
  import { onDestroy } from 'svelte';
  import { pulseStore } from '../stores/pulseStore.svelte.js';
  import { userStore } from '../stores/user.svelte.js';
  import { createPulseInputs } from '../lib/pulse/inputs.js';
  import { sendPulse } from '../lib/chatPipeline.js';

  let { peer } = $props();

  const SEND_INTERVAL = 160;   // ms → ~6 Frames/s (innerhalb 10Hz-Cap)
  const KEEPALIVE_MS = 1200;   // auch bei Stillstand gelegentlich senden (Presence)
  const CHANGE_EPS = 0.03;     // nur senden wenn sich Energie spürbar ändert

  let inputs = null;
  let lastSent = 0;
  let lastSentEnergy = -1;

  function stop() {
    if (inputs) { inputs.stop(); inputs = null; }
  }

  $effect(() => {
    const me = userStore.myUser;
    const p = peer ? String(peer).toLowerCase() : null;
    const motion = pulseStore.motionGranted;

    stop();
    lastSent = 0;
    lastSentEnergy = -1;
    if (!me || !p) return;

    inputs = createPulseInputs({
      getComposing: () => pulseStore.composing,   // Thinking Pulse: Composer-Boden
      onUpdate: (energy, mode) => {
        pulseStore.setSelf(energy, mode);
        const now = performance.now();
        const changed = Math.abs(energy - lastSentEnergy) > CHANGE_EPS;
        if (now - lastSent >= SEND_INTERVAL && (changed || now - lastSent >= KEEPALIVE_MS)) {
          lastSent = now;
          lastSentEnergy = energy;
          void sendPulse(me, p, energy, mode);
        }
      },
    });
    if (motion) inputs.enableMotion();
    inputs.start();

    return stop;
  });

  onDestroy(stop);
</script>
