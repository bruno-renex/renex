<!--
  PulseCanvas — rendert den PEER-Puls als ambient Hintergrund einer 1:1-Konversation.
  Spec: docs/PULSE.md §4.3 (Visualisierung), §9.4 (Theming + reduced-motion),
        §9.6 (Cold-Start: silent wenn Peer nicht teilt), §8.4 (Battery).

  Liest den geglätteten Peer-Pulse aus pulseStore (tickPeer pro Frame). Das ist
  bewusst dezent (niedrige Opacity, hinter den Nachrichten) — soll die Präsenz
  spürbar machen, nicht die Lesbarkeit stören. Eigener Pulse läuft separat als
  Mini-Indicator im Header (§9.5), NICHT hier.

  - calm/active/excited: Cyan hsl(190,80%,L), L energy-moduliert
  - foam: kurzer Hue-Shift zu warm-gold hsl(38,95%,65%)
  - prefers-reduced-motion: statischer Mood-Dot (pulsiert langsam), keine Partikel
  - Peer teilt nicht / offline: nichts rendern (silent)
-->
<script>
  import { onMount } from 'svelte';
  import { pulseStore } from '../stores/pulseStore.svelte.js';
  import { MODES } from '../lib/pulse/engine.js';

  let canvasEl = $state(null);

  const isMobile = typeof window !== 'undefined'
    && window.matchMedia('(max-width: 480px)').matches;
  const P_MIN = isMobile ? 6 : 10;
  const P_MAX = isMobile ? 26 : 44;
  const MAX_OPACITY = 0.42;        // dezent — hinter dem Text

  let particles = [];
  let running = false;
  let raf = null;
  let reducedMotion = false;
  let dim = { dpr: 1, w: 0, h: 0 };

  function lerp(a, b, t) { return a + (b - a) * t; }

  function resize(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    dim = { dpr, w: rect.width, h: rect.height };
  }

  function makeParticle() {
    return {
      x: Math.random() * dim.w,
      y: Math.random() * dim.h,
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.5) * 0.4,
      r: 1.1 + Math.random() * 1.3,
    };
  }

  function adjustCount(target) {
    if (particles.length < target) {
      const add = Math.min(target - particles.length, 2);
      for (let i = 0; i < add; i++) particles.push(makeParticle());
    } else if (particles.length > target) {
      particles.splice(target, particles.length - target);
    }
  }

  function colorFor(mode, energy) {
    const foam = mode === MODES.FOAM;
    const hue = foam ? 38 : 190;
    const sat = foam ? 95 : 82;
    const light = foam ? 64 : (46 + energy * 26);
    return { hue, sat, light };
  }

  function step(ctx, now) {
    const { energy, mode, active } = pulseStore.tickPeer(now);

    ctx.clearRect(0, 0, dim.w * dim.dpr, dim.h * dim.dpr);

    // Silent wenn Peer nicht teilt / offline (§9.6)
    if (!active && energy < 0.01) { particles = []; return; }

    ctx.save();
    ctx.scale(dim.dpr, dim.dpr);

    const c = colorFor(mode, energy);
    const speedMul = 0.4 + energy * 2.2;
    const target = Math.round(lerp(P_MIN, P_MAX, energy));
    adjustCount(target);

    for (const p of particles) {
      p.x += p.vx * speedMul;
      p.y += p.vy * speedMul;
      if (p.x < 0 || p.x > dim.w) p.vx = -p.vx;
      if (p.y < 0 || p.y > dim.h) p.vy = -p.vy;

      const alpha = (0.12 + energy * 0.4) * MAX_OPACITY;
      ctx.fillStyle = `hsla(${c.hue}, ${c.sat}%, ${c.light}%, ${alpha})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (0.85 + energy * 0.7), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  function drawStaticMood(ctx) {
    // reduced-motion: ein kleiner Mood-Dot oben-mittig, Opacity ~ Energie
    const { energy, mode, active } = pulseStore.tickPeer(
      (typeof performance !== 'undefined' ? performance.now() : Date.now())
    );
    ctx.clearRect(0, 0, dim.w * dim.dpr, dim.h * dim.dpr);
    if (!active && energy < 0.01) return;
    ctx.save();
    ctx.scale(dim.dpr, dim.dpr);
    const c = colorFor(mode, energy);
    ctx.fillStyle = `hsla(${c.hue}, ${c.sat}%, ${c.light}%, ${0.25 + energy * 0.4})`;
    ctx.beginPath();
    ctx.arc(dim.w / 2, 24, 5 + energy * 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  onMount(() => {
    const canvas = canvasEl;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    resize(canvas);

    const mqReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = mqReduced.matches;

    function loop() {
      if (!running) return;
      const t = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (reducedMotion) drawStaticMood(ctx);
      else step(ctx, t);
      raf = requestAnimationFrame(loop);
    }
    function start() { if (running) return; running = true; loop(); }
    function stop() { running = false; if (raf) { cancelAnimationFrame(raf); raf = null; } }

    function onVisibility() { if (document.hidden) stop(); else start(); }
    function onResize() {
      resize(canvas);
      for (const p of particles) {
        if (p.x > dim.w) p.x = dim.w;
        if (p.y > dim.h) p.y = dim.h;
      }
    }
    const onReducedChange = () => { reducedMotion = mqReduced.matches; };

    start();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', onResize);
    mqReduced.addEventListener?.('change', onReducedChange);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      mqReduced.removeEventListener?.('change', onReducedChange);
    };
  });
</script>

<canvas bind:this={canvasEl} class="pulse-canvas" aria-hidden="true"></canvas>

<style>
  .pulse-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 0;
  }
</style>
