<!--
  PulseLandingCanvas — interaktive Pulse-Visualisierung im Landing-Hero.

  Demonstriert RENEX's Signature-Feature "Pulse" bereits VOR dem Login: die
  Maus-/Touch-Bewegung des Besuchers treibt die Energie. "Beweg dich — das ist
  dein Puls. Bots haben keinen." Lokale Demo (kein WS/E2E).

  Look = identisch zum In-App-Pulse: „Leuchtkäfer" (weiche runde Glühpunkte +
  heller Kern, eigenständiges Blinken, freies Wandern, gleichmäßig verteilt).
  KEINE ✦-Zacken, KEINE Konstellations-Linien. Cyan; Foam → warm-gold.
  Cursor/Touch = Energie + Bursts (die „aktive" Energie), Heartbeat auf Touch.
  prefers-reduced-motion → statisches Frame; pausiert bei document.hidden.
-->
<script>
  import { onMount } from 'svelte';

  let canvasEl = $state(null);

  const isMobile = typeof window !== 'undefined'
    && window.matchMedia('(max-width: 480px)').matches;

  const AMB_MIN   = isMobile ? 10 : 16;
  const AMB_MAX   = isMobile ? 30 : 54;
  const MAX_TOTAL = isMobile ? 70 : 140;
  const SPEED_MAX = 2.2;
  const ENERGY_DECAY = 0.955;
  const ENERGY_FLOOR = 0.04;
  const FOAM_MS = 420;
  const EDGE_M = 38;                         // Rand-Margin (sanfte Abstoßung)

  const isCoarse = typeof window !== 'undefined'
    && window.matchMedia('(hover: none), (pointer: coarse)').matches;
  const SPEED_MAX_TOUCH = 0.9;

  let energy = ENERGY_FLOOR;
  let particles = [];
  let foamUntil = 0;
  let running = false;
  let raf = null;
  let reducedMotion = false;
  let cyanSprite = null, goldSprite = null;

  let lastX = 0, lastY = 0, lastT = 0;
  let lastTX = 0, lastTY = 0, lastTT = 0;
  let nextBeat = 0;

  let dim = { dpr: 1, w: 0, h: 0 };

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  function makeGlow(rgb) {
    const s = document.createElement('canvas');
    const size = 64; s.width = s.height = size;
    const g = s.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0,   `rgba(${rgb},0.95)`);
    grad.addColorStop(0.3, `rgba(${rgb},0.42)`);
    grad.addColorStop(1,   `rgba(${rgb},0)`);
    g.fillStyle = grad; g.fillRect(0, 0, size, size);
    return s;
  }

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
      vx: 0, vy: 0,
      ang: Math.random() * Math.PI * 2,    // Wander-Heading
      r: 1.6 + Math.random() * 1.8,
      ambient: true,
      life: Infinity,
      tp: Math.random() * Math.PI * 2,     // Blink-Phase
      ts: 0.5 + Math.random() * 1.1,       // Blink-Speed
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
        r: 1.8 + Math.random() * 2.4,
        ambient: false,
        life: 1,
        maxLife: 520 + Math.random() * 520,
        born: performance.now(),
      });
    }
  }

  function adjustAmbient() {
    const target = Math.round(lerp(AMB_MIN, AMB_MAX, energy));
    let ambientCount = 0;
    for (const p of particles) if (p.ambient) ambientCount++;
    if (ambientCount < target) {
      const add = Math.min(target - ambientCount, MAX_TOTAL - particles.length, 3);
      for (let i = 0; i < add; i++) particles.push(makeAmbient());
    } else if (ambientCount > target) {
      let toRemove = Math.min(ambientCount - target, 2);
      for (let i = particles.length - 1; i >= 0 && toRemove > 0; i--) {
        if (particles[i].ambient) { particles.splice(i, 1); toRemove--; }
      }
    }
  }

  function step(ctx, now) {
    energy = Math.max(ENERGY_FLOOR, energy * ENERGY_DECAY);

    // Autonomer "Heartbeat" auf Touch-Geräten (ohne Hover sonst fast statisch)
    if (isCoarse && !reducedMotion) {
      if (nextBeat === 0) nextBeat = now + 1200;
      if (now >= nextBeat) {
        energy = Math.max(energy, 0.30 + Math.random() * 0.12);
        const bx = dim.w * (0.28 + Math.random() * 0.44);
        const by = dim.h * (0.30 + Math.random() * 0.40);
        spawnBurst(bx, by, isMobile ? 3 : 4);
        nextBeat = now + 3000 + Math.random() * 1800;
      }
    }

    adjustAmbient();

    ctx.clearRect(0, 0, dim.w * dim.dpr, dim.h * dim.dpr);
    ctx.save();
    ctx.scale(dim.dpr, dim.dpr);

    const foamFactor = foamUntil > now ? clamp01((foamUntil - now) / FOAM_MS) : 0;
    const foam = foamFactor > 0.22;
    const sprite = foam ? goldSprite : cyanSprite;
    const coreColor = foam ? '#ffe6b0' : '#dffaff';
    const nowSec = now / 1000;
    const wander = 0.014 + energy * 0.06;

    // ── Leuchtkäfer (Glow-Halo + heller Kern) ──
    ctx.globalCompositeOperation = 'lighter';
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];

      if (p.ambient) {
        // Freies Wandern + sanfte Rand-Abstoßung → gleichmäßig verteilt
        p.ang += (Math.random() - 0.5) * 0.6;
        p.vx += Math.cos(p.ang) * wander;
        p.vy += Math.sin(p.ang) * wander;
        if (p.x < EDGE_M) p.vx += (EDGE_M - p.x) * 0.004;
        else if (p.x > dim.w - EDGE_M) p.vx -= (p.x - (dim.w - EDGE_M)) * 0.004;
        if (p.y < EDGE_M) p.vy += (EDGE_M - p.y) * 0.004;
        else if (p.y > dim.h - EDGE_M) p.vy -= (p.y - (dim.h - EDGE_M)) * 0.004;
        p.vx *= 0.90; p.vy *= 0.90;
        p.x += p.vx; p.y += p.vy;
      } else {
        // Burst (Cursor-Funke): Reibung + Lebensdauer
        p.vx *= 0.96; p.vy *= 0.96;
        p.x += p.vx; p.y += p.vy;
        p.life = clamp01(1 - (now - p.born) / p.maxLife);
        if (p.life <= 0) { particles.splice(i, 1); continue; }
      }

      let alpha, size;
      if (p.ambient) {
        const blink = 0.45 + 0.55 * Math.pow(0.5 + 0.5 * Math.sin(nowSec * p.ts + p.tp), 2);
        alpha = (0.14 + energy * 0.5) * blink;
        size = p.r * (0.85 + energy * 0.8) * (0.7 + 0.6 * blink);
      } else {
        alpha = p.life * 0.95;
        size = p.r * (0.6 + p.life * 1.0);
      }

      const glowD = size * 5;
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.drawImage(sprite, p.x - glowD / 2, p.y - glowD / 2, glowD, glowD);
      // heller runder Kern (der „Käfer")
      ctx.globalAlpha = Math.min(1, alpha * 1.6);
      ctx.fillStyle = coreColor;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
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

    cyanSprite = makeGlow('150,225,255');
    goldSprite = makeGlow('255,205,110');

    resize(canvas);

    const mqReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = mqReduced.matches;

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
      if (e.pointerType === 'touch') return;   // Touch via onTouch*
      const now = performance.now();
      const x = e.clientX, y = e.clientY;
      if (lastT) {
        const dt = now - lastT;
        if (dt > 0) {
          const dist = Math.hypot(x - lastX, y - lastY);
          const inst = clamp01((dist / dt) / SPEED_MAX);
          if (inst > energy) energy = energy + (inst - energy) * 0.5;
          if (inst > 0.85) foamUntil = now + FOAM_MS;
          const cx = x - dim.left, cy = y - dim.top;
          if (cy >= 0 && cy <= dim.h && cx >= 0 && cx <= dim.w && inst > 0.12) {
            spawnBurst(cx, cy, Math.min(3, 1 + Math.floor(inst * 3)));
          }
        }
      }
      lastX = x; lastY = y; lastT = now;
    }

    function touchPoint(e) {
      const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
      return t ? { x: t.clientX, y: t.clientY } : null;
    }
    function onTouchStart(e) {
      const p = touchPoint(e);
      if (!p) return;
      const now = performance.now();
      lastTX = p.x; lastTY = p.y; lastTT = now;
      const cx = p.x - dim.left, cy = p.y - dim.top;
      if (cy >= 0 && cy <= dim.h && cx >= 0 && cx <= dim.w) {
        energy = Math.max(energy, 0.72);
        foamUntil = now + FOAM_MS;
        spawnBurst(cx, cy, isMobile ? 6 : 9);
      }
    }
    function onTouchMove(e) {
      const p = touchPoint(e);
      if (!p) return;
      const now = performance.now();
      if (lastTT) {
        const dt = now - lastTT;
        if (dt > 0) {
          const dist = Math.hypot(p.x - lastTX, p.y - lastTY);
          const inst = clamp01((dist / dt) / SPEED_MAX_TOUCH);
          energy = Math.max(energy, 0.4 + inst * 0.6);
          if (inst > 0.6) foamUntil = now + FOAM_MS;
          const cx = p.x - dim.left, cy = p.y - dim.top;
          if (cy >= 0 && cy <= dim.h && cx >= 0 && cx <= dim.w) {
            spawnBurst(cx, cy, 2 + Math.floor(inst * 3));
          }
        }
      }
      lastTX = p.x; lastTY = p.y; lastTT = now;
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
      window.addEventListener('touchstart', onTouchStart, { passive: true });
      window.addEventListener('touchmove', onTouchMove, { passive: true });
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', onResize);
    mqReduced.addEventListener?.('change', onReducedChange);

    return () => {
      stop();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
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
