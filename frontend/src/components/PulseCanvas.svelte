<!--
  PulseCanvas — PEER-Puls als ambient „Leuchtkäfer"-Feld im 1:1-Chat.
  Spec: docs/PULSE.md §4.3, §9.4, §9.6, §8.4 + §20 (vNext).

  Look (Living Motes / Leuchtkäfer — Licht-Geist-Ästhetik à la Journey/Sky/Ori):
   - weiche runde Glühpunkte (Glow-Bokeh via Sprite + heller runder Kern), KEINE
     ✦-Zacken, KEINE Ambient-Konstellations-Linien.
   - jeder Käfer „blinkt" eigenständig (Per-Partikel-Phase) + atmender Schwarm
     (Wander + energie-gekoppelte Kohäsion zur Mitte + globales Atem-Skalieren).
   - prefers-reduced-motion: statisches Calm-Frame; pausiert bei document.hidden.

  Farb-System (nur Cyan ist ambient; Farben sind seltene Event-Flushes):
   - Cyan   = Präsenz/lebendig (99%)
   - Gold   = Energie-Spike (Foam)
   - Rosa   = Verbindung (Handshake: Cyan→Rosa-Verschmelzen, Knoten + Herzschlag,
              danach sanftes rosa Nachglühen — ephemer, nichts gespeichert)
   - Mint   = Bestätigung „gesehen" (Nicken: kurzer grüner Bloom oben)
-->
<script>
  import { onMount } from 'svelte';
  import { pulseStore } from '../stores/pulseStore.svelte.js';
  import { MODES } from '../lib/pulse/engine.js';

  let canvasEl = $state(null);

  const isMobile = typeof window !== 'undefined'
    && window.matchMedia('(max-width: 480px)').matches;
  const P_MIN = isMobile ? 8 : 14;
  const P_MAX = isMobile ? 28 : 50;
  const MAX_OPACITY = 0.5;
  const LINK_DIST = isMobile ? 100 : 130;   // nur für Handshake-Verbindungslinien
  const AFTERGLOW_MS = 22000;                // rosa Nachglüh-Dauer (ephemer)

  let particles = [];
  let running = false;
  let raf = null;
  let reducedMotion = false;
  let dim = { dpr: 1, w: 0, h: 0 };

  // Nachglüh-State (rein lokal, nie gespeichert) + Atem/Frame-Timing
  let prevSync = false;
  let agStart = 0, agUntil = 0;
  let breathPhase = 0, lastNow = 0;

  // Vorgerenderte Glow-Sprites (Perf: drawImage statt shadowBlur)
  let cyanSprite = null, goldSprite = null, pinkSprite = null, greenSprite = null;

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
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    dim = { dpr, w: rect.width, h: rect.height };
  }

  function makeParticle() {
    return {
      x: Math.random() * dim.w,
      y: Math.random() * dim.h,
      vx: 0, vy: 0,
      ang: Math.random() * Math.PI * 2,    // Wander-Heading
      baseR: 1.6 + Math.random() * 1.8,
      tp: Math.random() * Math.PI * 2,     // Blink-Phase
      ts: 0.5 + Math.random() * 1.1,       // Blink-Speed
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

    // Nachglüh-Trigger: Sync endet → rosa Nachglühen entsteht (ephemer)
    if (prevSync && !sync) { agStart = now; agUntil = now + AFTERGLOW_MS; }
    prevSync = sync;

    const afterglow = now < agUntil;
    // Silent wenn Peer nicht teilt UND kein Nachglühen/Nicken läuft (§9.6)
    if (!active && energy < 0.01 && !afterglow && !nod) { particles = []; return; }

    const env = sync ? Math.sin(Math.PI * clamp01(syncT)) : 0;   // Handshake-Hüllkurve
    const hbRaw = sync ? heartbeat(syncT) : 0;                   // roher Herzschlag (0..1)
    const hb = hbRaw * env;
    const eEff = Math.min(1, energy + env * 0.4 + hb * 0.25);
    const foam = mode === MODES.FOAM;
    const baseSprite = foam ? goldSprite : cyanSprite;
    // Nachglühen jetzt VERTEILT (rosa Wash über alle Käfer) statt Mitten-Glow → auch im vollen Chat sichtbar
    const ag = afterglow ? Math.pow(1 - (now - agStart) / AFTERGLOW_MS, 1.5) : 0;
    const pinkAmt = Math.max(env, ag * 0.55);
    const nowSec = now / 1000;

    // Atem-Phase fortschreiben — Rate energie-gekoppelt (calm ~5s, erregt ~2.3s)
    const dt = lastNow ? Math.min(64, now - lastNow) : 16;
    lastNow = now;
    breathPhase += dt * (0.0013 + eEff * 0.0017);

    ctx.save();
    ctx.scale(dim.dpr, dim.dpr);

    const target = Math.round(lerp(P_MIN, P_MAX, eEff));
    adjustCount(target);

    // ── Freies Wandern, gleichmäßig verteilt. KEINE Mitten-Kohäsion (sonst
    //    verstecken sich die Käfer hinter den Nachrichten-Bubbles). Stattdessen
    //    sanfte Rand-Abstoßung. Konvergenz zur Mitte NUR beim Handshake. ──
    const wander = 0.014 + eEff * 0.05;
    const M = 38;                                           // Rand-Margin
    for (const p of particles) {
      p.ang += (Math.random() - 0.5) * 0.6;
      p.vx += Math.cos(p.ang) * wander;
      p.vy += Math.sin(p.ang) * wander;
      // sanfte Rand-Abstoßung → bleibt im Bild + gleichmäßig
      if (p.x < M) p.vx += (M - p.x) * 0.004;
      else if (p.x > dim.w - M) p.vx -= (p.x - (dim.w - M)) * 0.004;
      if (p.y < M) p.vy += (M - p.y) * 0.004;
      else if (p.y > dim.h - M) p.vy -= (p.y - (dim.h - M)) * 0.004;
      // KEIN Zusammenrücken zur Mitte — die „Verschmelzung" beim Handshake ist rein
      // rhythmisch (synchrones rosa Blinken + rosa Linien). Käfer bleiben verteilt
      // → überall sichtbar, auch im vollen Chat hinter den Bubbles.
      p.vx *= 0.90; p.vy *= 0.90;
      p.x += p.vx; p.y += p.vy;
    }

    // Kollektives Atmen als Helligkeits-Puls (keine Positions-Skala → Verteilung
    // bleibt gleichmäßig, nichts wird an den Rand/aus dem Bild gedrückt)
    const breath = 0.82 + 0.18 * Math.sin(breathPhase);

    // ── Verbindungslinien NUR beim Handshake (rosa) — „die Verbindung zeichnet sich" ──
    if (env > 0.02) {
      const la = (0.06 + hb * 0.25) * env;
      ctx.lineWidth = 1;
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i];
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < LINK_DIST) {
            ctx.strokeStyle = `hsla(322, 90%, 72%, ${(1 - d / LINK_DIST) * la})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
    }

    // ── Leuchtkäfer (Glow-Halo + heller Kern, eigenständiges Blinken) ──
    ctx.globalCompositeOperation = 'lighter';
    for (const p of particles) {
      // Blink: unabhängig → beim Handshake Einschwingen in gemeinsamen Herzschlag
      const indep = 0.45 + 0.55 * Math.pow(0.5 + 0.5 * Math.sin(nowSec * p.ts + p.tp), 2);
      const shared = 0.25 + 0.75 * hbRaw;
      const blink = lerp(indep, shared, env);
      const size = p.baseR * (0.85 + eEff * 0.8) * (0.7 + 0.6 * blink) * (foam ? 1.25 : 1);
      const aBase = (0.12 + eEff * 0.4) * MAX_OPACITY * blink * breath * (1 + hb * 0.8);
      const glowD = size * 5;

      // Cyan→Rosa-Crossfade (Handshake voll, Nachglühen sanft + verteilt)
      const cyanA = aBase * (1 - pinkAmt * 0.85);
      ctx.globalAlpha = Math.min(1, cyanA);
      ctx.drawImage(baseSprite, p.x - glowD / 2, p.y - glowD / 2, glowD, glowD);
      if (pinkAmt > 0.01) {
        ctx.globalAlpha = Math.min(1, aBase * pinkAmt);
        ctx.drawImage(pinkSprite, p.x - glowD / 2, p.y - glowD / 2, glowD, glowD);
      }
      // Heller runder Kern (der „Käfer") — Farbe folgt dem Moment
      const coreCol = pinkAmt > 0.4 ? '#ffd0ec' : (foam ? '#ffe6b0' : '#dffaff');
      ctx.globalAlpha = Math.min(1, (cyanA + aBase * pinkAmt) * 1.5);
      ctx.fillStyle = coreCol;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // (Rosa Nachglühen ist jetzt VERTEILT — als pinkAmt-Wash über alle Käfer oben,
    //  kein Mitten-Glow mehr, damit es im vollen Chat sichtbar bleibt.)

    // ── Nicken: EINE grüne Mote reist von oben (Peer) im Bogen zu dir (unten) ──
    //    „ein Blick kommt an" — einzeln + gerichtet + kurz, klar anders als der
    //    kollektive rosa Herzschlag des Handshakes.
    if (nod) {
      const t = clamp01(nodT);
      const easeAt = (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
      const sx = dim.w * 0.5, sy = dim.h * 0.10;   // Start: oben (Peer)
      const ex = dim.w * 0.5, ey = dim.h * 0.90;   // Ziel: unten (du)
      const posAt = (u) => {
        const e = easeAt(u);
        return {
          // seitliche Welle (mehrere Schwünge), Amplitude per sin(uπ) eingefasst → 0 an den Enden
          x: sx + (ex - sx) * e + Math.sin(u * Math.PI * 3) * Math.sin(u * Math.PI) * dim.w * 0.20,
          y: sy + (ey - sy) * e,
        };
      };
      const head = posAt(t);
      const tail = posAt(clamp01(t - 0.07));
      const a = Math.min(1, Math.sin(Math.PI * t) * 1.5);

      // Komet-Schweif head→tail (goldig, ausfadend)
      const grad = ctx.createLinearGradient(head.x, head.y, tail.x, tail.y);
      grad.addColorStop(0, `rgba(255,216,140,${0.7 * a})`);
      grad.addColorStop(1, 'rgba(255,205,110,0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(head.x, head.y); ctx.lineTo(tail.x, tail.y); ctx.stroke();

      // goldener Glow + heller Kern am Kopf
      const gs = 15;
      ctx.globalAlpha = Math.min(1, 0.85 * a);
      ctx.drawImage(goldSprite, head.x - gs * 2, head.y - gs * 2, gs * 4, gs * 4);
      ctx.globalAlpha = Math.min(1, a);
      ctx.fillStyle = '#fff0cf';
      ctx.beginPath(); ctx.arc(head.x, head.y, 3.2, 0, Math.PI * 2); ctx.fill();

      // sanftes Ankommen unten (kurzer Bloom am Ende)
      if (t > 0.82) {
        const land = (t - 0.82) / 0.18;
        const ls = 14 + 10 * land;
        ctx.globalAlpha = Math.min(1, 0.5 * (1 - land));
        ctx.drawImage(goldSprite, ex - ls * 2, ey - ls * 2, ls * 4, ls * 4);
      }
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  function drawStaticMood(ctx) {
    // reduced-motion: ein ruhiger Glühpunkt oben-mittig, Opacity ~ Peer-Energie
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

    cyanSprite  = makeGlow('150,225,255');
    goldSprite  = makeGlow('255,205,110');
    pinkSprite  = makeGlow('255,120,200');
    greenSprite = makeGlow('120,255,180');

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
