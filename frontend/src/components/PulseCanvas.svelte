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

  // Atmender-Schwarm-State: globale Atem-Phase + Frame-Timing
  let breathPhase = 0, lastNow = 0;

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
      vx: 0, vy: 0,                          // akkumulierte Geschwindigkeit (Steering)
      ang: Math.random() * Math.PI * 2,      // Wander-Heading (Eigenleben)
      baseR: 1.3 + Math.random() * 1.6,
      tp: Math.random() * Math.PI * 2,       // Twinkle-Phase
      ts: 0.6 + Math.random() * 1.3,         // Twinkle-Speed
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

  // Generischer N-Punkt-Stern (rotierbar). points=6 → klassischer Stern,
  // deutlich andere Silhouette als die 4-Punkt-✦ des Felds.
  function drawStar(ctx, x, y, points, rOuter, rInner, rot, color, alpha) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.globalAlpha = Math.min(1, Math.max(0, alpha));
    ctx.fillStyle = color;
    ctx.beginPath();
    const n = points * 2;
    for (let i = 0; i < n; i++) {
      const ang = (Math.PI / points) * i - Math.PI / 2;
      const rad = i % 2 === 0 ? rOuter : rInner;
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
    const { energy, mode, active, sync, syncT, nod, nodT } = pulseStore.tickPeer(now);

    ctx.clearRect(0, 0, dim.w * dim.dpr, dim.h * dim.dpr);

    // Nachglüh-Trigger: Sync endet → warmer Reststern entsteht (ephemer)
    if (prevSync && !sync) { agStart = now; agUntil = now + AFTERGLOW_MS; }
    prevSync = sync;

    const afterglow = now < agUntil;
    // Silent wenn Peer nicht teilt UND kein Nachglühen/Nicken läuft (§9.6)
    if (!active && energy < 0.01 && !afterglow && !nod) { particles = []; return; }

    const env = sync ? Math.sin(Math.PI * Math.min(1, Math.max(0, syncT))) : 0;
    const hb = sync ? heartbeat(syncT) * env : 0;          // gemeinsamer Herzschlag
    const eEff = Math.min(1, energy + env * 0.4 + hb * 0.25);
    const foam = mode === MODES.FOAM;
    const sprite = foam ? goldSprite : cyanSprite;
    const lineHue = foam ? 40 : 190;
    const coreColor = foam ? '#ffd36b' : '#bdf0ff';
    const nowSec = now / 1000;

    // Atem-Phase fortschreiben — Rate energie-gekoppelt (calm ~5s, erregt ~2.3s)
    const dt = lastNow ? Math.min(64, now - lastNow) : 16;
    lastNow = now;
    breathPhase += dt * (0.0013 + eEff * 0.0017);

    ctx.save();
    ctx.scale(dim.dpr, dim.dpr);

    const target = Math.round(lerp(P_MIN, P_MAX, eEff));
    adjustCount(target);

    // ── Atmender Schwarm: Wander (Eigenleben) + energie-gekoppelte Kohäsion zur
    //    Mitte. Im Sync rückt der Schwarm stark zusammen ("Verschmelzen" → Reststern). ──
    const ax = dim.w / 2, ay = dim.h / 2;
    const wander = 0.014 + eEff * 0.05;
    const coh = lerp(0.0007, 0.004, eEff) + env * 0.02;
    const nLean = nod ? Math.sin(Math.PI * Math.min(1, Math.max(0, nodT))) : 0; // Nicken: Lehnen
    const nodX = dim.w / 2, nodY = Math.min(46, dim.h * 0.12);
    for (const p of particles) {
      p.ang += (Math.random() - 0.5) * 0.6;            // Wander: Richtung dreht sanft
      p.vx += Math.cos(p.ang) * wander;
      p.vy += Math.sin(p.ang) * wander;
      p.vx += (ax - p.x) * coh;                         // Kohäsion zur Mitte
      p.vy += (ay - p.y) * coh;
      if (nLean > 0) {                                   // obere Motes lehnen zum Peer
        p.vx += (nodX - p.x) * 0.003 * nLean;
        p.vy += (nodY - p.y) * 0.006 * nLean;
      }
      p.vx *= 0.90; p.vy *= 0.90;                        // Dämpfung → weiche Bahnen
      p.x += p.vx; p.y += p.vy;
    }

    // Atem: das ganze Feld dehnt/zieht sich sanft um die Mitte (Render-Skala)
    const bScale = 1 + lerp(0.04, 0.09, eEff) * Math.sin(breathPhase);
    for (const p of particles) {
      p._dx = ax + (p.x - ax) * bScale;
      p._dy = ay + (p.y - ay) * bScale;
    }

    // ── Konstellations-Linien (unter den Sternen). Herzschlag hellt sie auf. ──
    const lineBase = (0.025 + eEff * 0.11) * (1 + hb * 3);
    if (lineBase > 0.004) {
      ctx.lineWidth = 1;
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i];
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j];
          const dx = a._dx - b._dx, dy = a._dy - b._dy;
          const d = Math.hypot(dx, dy);
          if (d < LINK_DIST) {
            const alpha = (1 - d / LINK_DIST) * lineBase;
            ctx.strokeStyle = `hsla(${lineHue}, 90%, 70%, ${alpha})`;
            ctx.beginPath();
            ctx.moveTo(a._dx, a._dy);
            ctx.lineTo(b._dx, b._dy);
            ctx.stroke();
          }
        }
      }
    }

    // ── Sterne (additives Glow + ✦-Funken, Per-Partikel-Twinkle) ──
    ctx.globalCompositeOperation = 'lighter';
    for (const p of particles) {
      const tw = 0.7 + 0.3 * Math.sin(nowSec * p.ts + p.tp);
      const size = p.baseR * (0.9 + eEff * 0.9) * tw * (p.sparkle ? 1.5 : 1) * (foam && p.sparkle ? 1.5 : 1);
      const alpha = (0.10 + eEff * 0.42) * MAX_OPACITY * tw * (1 + hb * 0.8);

      ctx.globalAlpha = Math.min(1, alpha);
      const glowD = size * (p.sparkle ? 7 : 5);
      ctx.drawImage(sprite, p._dx - glowD / 2, p._dy - glowD / 2, glowD, glowD);

      if (p.sparkle) {
        drawSparkle(ctx, p._dx, p._dy, size * 1.3, coreColor, alpha * 2.4);
      }
    }

    // ── Nachglühen: warmer 6-Punkt-Stern, weiß-heißer Kern. Sternschnuppen-
    //    Eintritt, Schimmer + atmender Halo, langsame Drehung, ~25s Verglimmen.
    //    Bewusst WARM (nicht cyan) → hebt sich vom kalten Sternenfeld ab. ──
    if (afterglow) {
      const elapsed = now - agStart;
      const ENTRANCE_MS = 650;
      const ent = Math.min(1, elapsed / ENTRANCE_MS);     // Eintritts-Fortschritt
      const agT = Math.min(1, elapsed / AFTERGLOW_MS);    // Gesamt-Leben
      const cx = dim.w / 2, cy = dim.h / 2;
      const life = Math.pow(1 - agT, 1.4);                // Gesamt-Fade
      const shimmer = 0.82 + 0.18 * Math.sin(nowSec * 4.5);
      const breath = 0.5 + 0.5 * Math.sin(nowSec * 1.05); // 0..1 langsames Atmen
      const rot = elapsed * 0.00018;                      // langsame Drehung
      const eo = 1 - Math.pow(1 - ent, 3);                // easeOutCubic

      // Sternschnuppen-Eintritt: Head fliegt von oben-rechts ins Zentrum
      const sx = cx + 70, sy = cy - 150;
      const hx = sx + (cx - sx) * eo;
      const hy = sy + (cy - sy) * eo;
      if (ent < 1) {
        const tail = 0.35 * (1 - eo) + 0.12;
        const tx = hx - (cx - sx) * tail;
        const ty = hy - (cy - sy) * tail;
        const grad = ctx.createLinearGradient(hx, hy, tx, ty);
        grad.addColorStop(0, `rgba(255,245,220,${0.9 * (1 - ent * 0.3)})`);
        grad.addColorStop(1, 'rgba(255,220,150,0)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(tx, ty); ctx.stroke();
      }

      const px = ent < 1 ? hx : cx;
      const py = ent < 1 ? hy : cy;
      const flash = (ent > 0.6 ? 1 : 0) * Math.max(0, 1 - Math.abs(ent - 1) * 8); // Lande-Blitz

      // Warmer, atmender Halo
      const haloSize = (26 + 10 * breath) * (0.7 + 0.3 * eo);
      ctx.globalAlpha = Math.min(1, (0.42 + 0.22 * breath) * life);
      ctx.drawImage(warmSprite, px - haloSize * 2, py - haloSize * 2, haloSize * 4, haloSize * 4);

      // 6-Punkt-Stern: warm-gold Schicht + weiß-heißer Kern (schimmernd, rotierend)
      const starR = (9 + 3 * shimmer + flash * 9) * (0.5 + 0.5 * eo);
      drawStar(ctx, px, py, 6, starR, starR * 0.40, rot, '#ffcf7a', (0.7 * life + flash) * shimmer);
      drawStar(ctx, px, py, 6, starR * 0.62, starR * 0.26, rot, '#fffbe9', (0.85 * life + flash) * shimmer);
    }

    // ── „Nicken" (digitaler Blickkontakt): kurzes warmes Aufblühen oben-mittig ──
    //    Einseitig + kurz (~1.2s) → klar vom Handshake (beidseitig, 25s) unterscheidbar.
    if (nod) {
      const ne = Math.sin(Math.PI * Math.min(1, Math.max(0, nodT))); // 0→1→0
      const nx = dim.w / 2, ny = Math.min(46, dim.h * 0.12);
      const nsh = 0.85 + 0.15 * Math.sin(nowSec * 8);
      const nsize = 12 + 6 * ne;
      ctx.globalAlpha = Math.min(1, 0.7 * ne);
      ctx.drawImage(warmSprite, nx - nsize * 2.2, ny - nsize * 2.2, nsize * 4.4, nsize * 4.4);
      drawStar(ctx, nx, ny, 6, nsize * (0.9 + 0.2 * ne), nsize * 0.4, nowSec * 0.5, '#ffcf7a', 0.7 * ne * nsh);
      drawStar(ctx, nx, ny, 6, nsize * 0.6, nsize * 0.26, nowSec * 0.5, '#fffbe9', 0.9 * ne * nsh);
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
