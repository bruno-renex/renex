<!--
  PulseLandingCanvas — interaktive Pulse-Visualisierung im Landing-Hero.

  Demonstriert RENEX's Signature-Feature "Pulse" (siehe docs/PULSE.md) bereits
  VOR dem Login: die eigene Maus-/Touch-Bewegung des Besuchers treibt die
  Partikel-Energie. "Beweg dich — das ist dein Puls. Bots haben keinen."

  Dies ist eine LOKALE, eigenständige Demo (nur eigener Input, kein Cross-User,
  kein WS, kein E2E) — eine ehrliche Kostprobe des echten In-App-Features.
  Der Renderer ist bewusst eng an die Pulse-Spec angelehnt und kann später nach
  frontend/src/lib/pulse/particles.js extrahiert werden (Phase 6.5 Bootstrap).

  Pulse-Spec-Konformität:
   - Cyan-Anchored: hsl(190, 80%, L%), L energy-moduliert (§9.4)
   - Foam-Spike: kurzer Hue-Shift zu warm-gold hsl(38, 95%, 65%) bei schnellem Move
   - Modi calm/active/excited/foam über Energy-Level (§4.3)
   - prefers-reduced-motion → statisches Calm-Frame, keine Animation (§9.4)
   - Pausiert bei document.hidden (Battery, §8.4)
   - Mobile: weniger Partikel (GPU-Last)
-->
<script>
  import { onMount } from 'svelte';

  let canvasEl = $state(null);

  // ── Tuning-Konstanten ──────────────────────────────
  const isMobile = typeof window !== 'undefined'
    && window.matchMedia('(max-width: 480px)').matches;

  const AMB_MIN   = isMobile ? 10 : 16;   // Ambient-Partikel bei calm
  const AMB_MAX   = isMobile ? 30 : 54;   // Ambient-Partikel bei foam
  const MAX_TOTAL = isMobile ? 70 : 140;  // Hard-Cap inkl. Burst-Partikel
  const LINK_DIST = 110;                   // px, Verbindungslinien-Reichweite
  const SPEED_MAX = 2.2;                   // px/ms ≈ sehr schnelle Bewegung → energy 1
  const ENERGY_DECAY = 0.955;              // pro Frame
  const ENERGY_FLOOR = 0.04;               // "calm hat Lebenszeichen" (PULSE.md §9.6)
  const FOAM_MS = 420;                      // Gold-Spike-Dauer

  // ── Laufzeit-State (kein $state nötig — alles in der rAF-Loop) ──
  let energy = ENERGY_FLOOR;
  let particles = [];
  let foamUntil = 0;
  let running = false;
  let raf = null;
  let reducedMotion = false;

  // Pointer-Tracking
  let lastX = 0, lastY = 0, lastT = 0;
  let pointerInside = false;
  let ptrCanvasX = 0, ptrCanvasY = 0;

  let dim = { dpr: 1, w: 0, h: 0 };

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  function resize(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width  = Math.max(1, Math.floor(rect.width  * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    dim = { dpr, w: rect.width, h: rect.height, left: rect.left, top: rect.top };
  }

  function makeAmbient() {
    return {
      x: Math.random() * dim.w,
      y: Math.random() * dim.h,
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.5) * 0.4,
      r: 1.1 + Math.random() * 1.1,
      ambient: true,
      life: Infinity,
    };
  }

  function spawnBurst(x, y, n) {
    for (let i = 0; i < n && particles.length < MAX_TOTAL; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 0.6 + Math.random() * 2.2 * energy;
      particles.push({
        x, y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        r: 1.8 + Math.random() * 2.2,
        ambient: false,
        life: 1,            // 1 → 0 über maxLife
        maxLife: 520 + Math.random() * 520, // ms
        born: performance.now(),
      });
    }
  }

  // Ambient-Partikelzahl an Energy angleichen (sanftes Wachsen/Schrumpfen)
  function adjustAmbient() {
    const target = Math.round(lerp(AMB_MIN, AMB_MAX, energy));
    let ambientCount = 0;
    for (const p of particles) if (p.ambient) ambientCount++;
    if (ambientCount < target) {
      const add = Math.min(target - ambientCount, MAX_TOTAL - particles.length, 3);
      for (let i = 0; i < add; i++) particles.push(makeAmbient());
    } else if (ambientCount > target) {
      // älteste Ambients zuerst entfernen (max 2/Frame, kein Flackern)
      let toRemove = Math.min(ambientCount - target, 2);
      for (let i = particles.length - 1; i >= 0 && toRemove > 0; i--) {
        if (particles[i].ambient) { particles.splice(i, 1); toRemove--; }
      }
    }
  }

  function currentColor(now, lightnessBoost = 0) {
    const foamFactor = foamUntil > now ? clamp01((foamUntil - now) / FOAM_MS) : 0;
    // 99% cyan, kurzer Hue-Shift zu gold (38) bei Foam
    const hue = lerp(190, 38, foamFactor);
    const sat = 82;
    const light = 46 + energy * 28 + foamFactor * 16 + lightnessBoost;
    return { hue, sat, light, foamFactor };
  }

  function step(ctx, now) {
    // Energy-Decay
    energy = Math.max(ENERGY_FLOOR, energy * ENERGY_DECAY);

    adjustAmbient();

    ctx.clearRect(0, 0, dim.w * dim.dpr, dim.h * dim.dpr);
    ctx.save();
    ctx.scale(dim.dpr, dim.dpr);

    const speedMul = 0.5 + energy * 2.4;

    // ── Verbindungslinien (Netzwerk energetisiert sich mit Bewegung) ──
    const c = currentColor(now);
    const lineBase = 0.04 + energy * 0.16;
    for (let i = 0; i < particles.length; i++) {
      const a = particles[i];
      for (let j = i + 1; j < particles.length; j++) {
        const b = particles[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d = Math.hypot(dx, dy);
        if (d < LINK_DIST) {
          const alpha = (1 - d / LINK_DIST) * lineBase;
          ctx.strokeStyle = `hsla(${c.hue}, ${c.sat}%, ${c.light}%, ${alpha})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    // ── Partikel ──
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];

      // Bewegung
      p.x += p.vx * (p.ambient ? speedMul : 1);
      p.y += p.vy * (p.ambient ? speedMul : 1);

      if (p.ambient) {
        // Wrap/Bounce am Rand
        if (p.x < 0 || p.x > dim.w) p.vx = -p.vx;
        if (p.y < 0 || p.y > dim.h) p.vy = -p.vy;
      } else {
        // Burst: Reibung + Lebensdauer
        p.vx *= 0.96; p.vy *= 0.96;
        p.life = clamp01(1 - (now - p.born) / p.maxLife);
        if (p.life <= 0) { particles.splice(i, 1); continue; }
      }

      const alpha = p.ambient ? (0.28 + energy * 0.42) : (p.life * 0.85);
      const col = currentColor(now, p.ambient ? 0 : 10);
      ctx.fillStyle = `hsla(${col.hue}, ${col.sat}%, ${col.light}%, ${alpha})`;
      ctx.beginPath();
      const rr = p.ambient ? p.r * (0.85 + energy * 0.6) : p.r * (0.5 + p.life * 0.8);
      ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  function drawStatic(ctx) {
    // reduced-motion: einmaliges ruhiges Calm-Frame, keine Animation
    energy = 0.12;
    if (particles.length === 0) {
      for (let i = 0; i < AMB_MIN; i++) particles.push(makeAmbient());
    }
    step(ctx, performance.now());
  }

  onMount(() => {
    const canvas = canvasEl;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    resize(canvas);

    const mqReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = mqReduced.matches;

    // Seed Ambient
    for (let i = 0; i < AMB_MIN; i++) particles.push(makeAmbient());

    function loop() {
      if (!running) return;
      step(ctx, performance.now());
      raf = requestAnimationFrame(loop);
    }
    function start() {
      if (running || reducedMotion) return;
      running = true;
      loop();
    }
    function stop() {
      running = false;
      if (raf) { cancelAnimationFrame(raf); raf = null; }
    }

    function onPointerMove(e) {
      const now = performance.now();
      const x = e.clientX, y = e.clientY;
      if (lastT) {
        const dt = now - lastT;
        if (dt > 0) {
          const dist = Math.hypot(x - lastX, y - lastY);
          const inst = clamp01((dist / dt) / SPEED_MAX);
          // Energy nach oben schnell folgen, Abfall via Decay
          if (inst > energy) energy = energy + (inst - energy) * 0.5;
          if (inst > 0.85) foamUntil = now + FOAM_MS;

          // Burst am Cursor (canvas-relativ), nur wenn über dem Hero
          const cx = x - dim.left, cy = y - dim.top;
          if (cy >= 0 && cy <= dim.h && cx >= 0 && cx <= dim.w && inst > 0.12) {
            ptrCanvasX = cx; ptrCanvasY = cy; pointerInside = true;
            spawnBurst(cx, cy, Math.min(3, 1 + Math.floor(inst * 3)));
          }
        }
      }
      lastX = x; lastY = y; lastT = now;
    }

    function onVisibility() {
      if (document.hidden) stop(); else start();
    }
    function onResize() {
      resize(canvas);
      for (const p of particles) {
        if (p.x > dim.w) p.x = dim.w;
        if (p.y > dim.h) p.y = dim.h;
      }
      if (reducedMotion) drawStatic(ctx);
    }
    const onReducedChange = () => {
      reducedMotion = mqReduced.matches;
      if (reducedMotion) { stop(); drawStatic(ctx); } else { start(); }
    };

    if (reducedMotion) {
      drawStatic(ctx);
    } else {
      start();
      window.addEventListener('pointermove', onPointerMove, { passive: true });
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', onResize);
    mqReduced.addEventListener?.('change', onReducedChange);

    return () => {
      stop();
      window.removeEventListener('pointermove', onPointerMove);
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
