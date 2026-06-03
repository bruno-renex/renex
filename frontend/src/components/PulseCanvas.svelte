<!--
  PulseCanvas — rendert den PEER-Puls als ambient Sternenfeld im 1:1-Chat.
  Spec: docs/PULSE.md §4.3, §9.4, §9.6, §8.4 + §20 (vNext: Sterne + Nachglüh-Handshake).

  Look:
   - Glow-Bokeh-Sterne (vorgerenderte Sprites, additives 'lighter'-Compositing)
   - vereinzelt ✦-Funkeln, alle mit Per-Partikel-Twinkle (Helligkeit/Größe)
   - feine Konstellations-Linien zwischen nahen Sternen
   - calm/active/excited → Cyan; foam → Funken größer + warm-gold
   - prefers-reduced-motion: statisches Calm-Frame; pausiert bei document.hidden

  Handshake (Nachglühen): wenn beide Pulse syncen (pulseStore.sync), leuchtet die
  Konstellation in einem gemeinsamen Herzschlag auf → kollabiert in EINEN warmen
  Reststern in der Mitte, der über ~25s verglimmt. Rein ephemer/lokal — NICHTS
  gespeichert, kein Zähler, kein Server, kein Streak (PULSE.md §20.3).
-->
<script>
  import { onMount } from 'svelte';
  import { pulseStore } from '../stores/pulseStore.svelte.js';
  import { MODES } from '../lib/pulse/engine.js';

  let canvasEl = $state(null);

  const isMobile = typeof window !== 'undefined'
    && window.matchMedia('(max-width: 480px)').matches;
  const P_MIN = isMobile ? 7 : 12;
  const P_MAX = isMobile ? 26 : 46;
  const MAX_OPACITY = 0.5;
  const SPARKLE_RATIO = 0.22;            // Anteil ✦-Funken
  const LINK_DIST = isMobile ? 92 : 122; // Konstellations-Reichweite
  const AFTERGLOW_MS = 25000;            // Nachglüh-Dauer

  let particles = [];
  let running = false;
  let raf = null;
  let reducedMotion = false;
  let dim = { dpr: 1, w: 0, h: 0 };

  // Nachglüh-State (rein lokal, nie gespeichert)
  let prevSync = false;
  let agStart = 0, agUntil = 0;

  // Vorgerenderte Glow-Sprites (Perf: drawImage statt shadowBlur pro Frame)
  let cyanSprite = null, goldSprite = null, warmSprite = null;

  function lerp(a, b, t) { return a + (b - a) * t; }

  function makeGlow(rgb) {
    const s = document.createElement('canvas');
    const size = 64; s.width = s.height = size;
    const g = s.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0,   `rgba(${rgb},0.95)`);
    grad.addColorStop(0.3, `rgba(${rgb},0.45)`);
    grad.addColorStop(1,   `rgba(${rgb},0)`);
    g.fillStyle = grad; g.fillRect(0, 0, size, size);
    return s;
  }

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
      baseR: 1.3 + Math.random() * 1.6,
      tp: Math.random() * Math.PI * 2,     // Twinkle-Phase
      ts: 0.6 + Math.random() * 1.3,       // Twinkle-Speed
      sparkle: Math.random() < SPARKLE_RATIO,
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

  // 4-Punkt-✦ (8 Vertices, scharfer Innenradius → Funke statt Blob)
  function drawSparkle(ctx, x, y, r, color, alpha) {
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.fillStyle = color;
    ctx.beginPath();
    const inner = r * 0.34;
    for (let i = 0; i < 8; i++) {
      const ang = (Math.PI / 4) * i - Math.PI / 2;
      const rad = i % 2 === 0 ? r : inner;
      const px = Math.cos(ang) * rad, py = Math.sin(ang) * rad;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Herzschlag-Hüllkurve (2 „lub-dub" über die Sync-Dauer, t in 0..1)
  function heartbeat(t) {
    const p = (t * 2) % 1;
    const lub = Math.exp(-Math.pow((p - 0.05) / 0.06, 2));
    const dub = 0.55 * Math.exp(-Math.pow((p - 0.22) / 0.06, 2));
    return Math.min(1, lub + dub);
  }

  function step(ctx, now) {
    const { energy, mode, active, sync, syncT } = pulseStore.tickPeer(now);

    ctx.clearRect(0, 0, dim.w * dim.dpr, dim.h * dim.dpr);

    // Nachglüh-Trigger: Sync endet → warmer Reststern entsteht (ephemer)
    if (prevSync && !sync) { agStart = now; agUntil = now + AFTERGLOW_MS; }
    prevSync = sync;

    const afterglow = now < agUntil;
    // Silent wenn Peer nicht teilt UND kein Nachglühen läuft (§9.6)
    if (!active && energy < 0.01 && !afterglow) { particles = []; return; }

    const env = sync ? Math.sin(Math.PI * Math.min(1, Math.max(0, syncT))) : 0;
    const hb = sync ? heartbeat(syncT) * env : 0;          // gemeinsamer Herzschlag
    const eEff = Math.min(1, energy + env * 0.4 + hb * 0.25);
    const foam = mode === MODES.FOAM;
    const sprite = foam ? goldSprite : cyanSprite;
    const lineHue = foam ? 40 : 190;
    const coreColor = foam ? '#ffd36b' : '#bdf0ff';
    const nowSec = now / 1000;

    ctx.save();
    ctx.scale(dim.dpr, dim.dpr);

    const target = Math.round(lerp(P_MIN, P_MAX, eEff));
    adjustCount(target);

    // ── Konstellations-Linien (unter den Sternen). Herzschlag hellt sie auf. ──
    const lineBase = (0.025 + eEff * 0.11) * (1 + hb * 3);
    if (lineBase > 0.004) {
      ctx.lineWidth = 1;
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i];
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d = Math.hypot(dx, dy);
          if (d < LINK_DIST) {
            const alpha = (1 - d / LINK_DIST) * lineBase;
            ctx.strokeStyle = `hsla(${lineHue}, 90%, 70%, ${alpha})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
    }

    // ── Sterne (additives Glow + ✦-Funken, Per-Partikel-Twinkle) ──
    ctx.globalCompositeOperation = 'lighter';
    for (const p of particles) {
      p.x += p.vx * (0.4 + eEff * 2.0);
      p.y += p.vy * (0.4 + eEff * 2.0);
      if (p.x < 0 || p.x > dim.w) p.vx = -p.vx;
      if (p.y < 0 || p.y > dim.h) p.vy = -p.vy;

      const tw = 0.7 + 0.3 * Math.sin(nowSec * p.ts + p.tp);
      const size = p.baseR * (0.9 + eEff * 0.9) * tw * (p.sparkle ? 1.5 : 1) * (foam && p.sparkle ? 1.5 : 1);
      const alpha = (0.10 + eEff * 0.42) * MAX_OPACITY * tw * (1 + hb * 0.8);

      ctx.globalAlpha = Math.min(1, alpha);
      const glowD = size * (p.sparkle ? 7 : 5);
      ctx.drawImage(sprite, p.x - glowD / 2, p.y - glowD / 2, glowD, glowD);

      if (p.sparkle) {
        drawSparkle(ctx, p.x, p.y, size * 1.3, coreColor, alpha * 2.4);
      }
    }

    // ── Nachglühen: ein warmer Reststern in der Mitte, verglimmt über ~25s ──
    if (afterglow) {
      const agT = (now - agStart) / AFTERGLOW_MS;          // 0..1
      const cx = dim.w / 2, cy = dim.h / 2;
      const breath = 0.85 + 0.15 * Math.sin(nowSec * 1.6); // sanftes Atmen
      const agAlpha = Math.pow(1 - agT, 1.5) * 0.6 * breath;
      const agSize = (14 + 8 * (1 - agT)) * breath;
      ctx.globalAlpha = Math.min(1, agAlpha);
      ctx.drawImage(warmSprite, cx - agSize * 2, cy - agSize * 2, agSize * 4, agSize * 4);
      drawSparkle(ctx, cx, cy, agSize * 0.7, '#ffe1b0', agAlpha * 1.3);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  function drawStaticMood(ctx) {
    // reduced-motion: ein ruhiger Stern oben-mittig, Opacity ~ Peer-Energie
    const { energy, active } = pulseStore.tickPeer(
      (typeof performance !== 'undefined' ? performance.now() : Date.now())
    );
    ctx.clearRect(0, 0, dim.w * dim.dpr, dim.h * dim.dpr);
    if (!active && energy < 0.01) return;
    ctx.save();
    ctx.scale(dim.dpr, dim.dpr);
    ctx.globalCompositeOperation = 'lighter';
    const size = 10 + energy * 8;
    ctx.globalAlpha = 0.3 + energy * 0.4;
    ctx.drawImage(cyanSprite, dim.w / 2 - size * 2, 24 - size * 2, size * 4, size * 4);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  onMount(() => {
    const canvas = canvasEl;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    cyanSprite = makeGlow('150,225,255');
    goldSprite = makeGlow('255,205,110');
    warmSprite = makeGlow('255,220,150');

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
    function start() { if (running || reducedMotion) return; running = true; loop(); }
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

    if (reducedMotion) drawStaticMood(ctx); else start();
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
