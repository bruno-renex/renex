<!--
  LandingParticles — subtle Particle-Network im Hero-Hintergrund.

  Performance-aware:
   - requestAnimationFrame, kein setInterval
   - Pausiert wenn Tab nicht sichtbar (Page Visibility API)
   - Mobile: weniger Particles für niedrigere GPU-Last
   - prefers-reduced-motion: reduce → static (keine Animation)

  Visual:
   - 30 Punkte (20 auf Mobile) driften in zufällige Richtungen
   - Lines zwischen nahen Punkten (<120 px) mit Fade-out
   - Subtle: Accent-Voice Color mit niedriger Opacity
-->
<script>
  import { onMount } from 'svelte';

  let canvasEl = $state(null);
  let _raf = null;
  let _particles = [];
  let _running = false;

  // Beobachten ob User reduced-motion bevorzugt — initial + bei Wechsel
  let _reducedMotion = false;

  function _init(canvas) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    return ctx;
  }

  function _resize(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width  = Math.max(1, Math.floor(rect.width  * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    return { dpr, w: rect.width, h: rect.height };
  }

  function _seed(w, h, count) {
    const arr = [];
    for (let i = 0; i < count; i++) {
      arr.push({
        x:  Math.random() * w,
        y:  Math.random() * h,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
      });
    }
    return arr;
  }

  function _step(ctx, w, h, dpr) {
    ctx.clearRect(0, 0, w * dpr, h * dpr);
    ctx.save();
    ctx.scale(dpr, dpr);

    // Lines zwischen nahen Particles
    const MAX_DIST = 120;
    for (let i = 0; i < _particles.length; i++) {
      for (let j = i + 1; j < _particles.length; j++) {
        const a = _particles[i], b = _particles[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const dist = Math.hypot(dx, dy);
        if (dist < MAX_DIST) {
          const alpha = (1 - dist / MAX_DIST) * 0.18;
          ctx.strokeStyle = `rgba(56, 189, 248, ${alpha})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    // Particles als kleine Kreise
    ctx.fillStyle = 'rgba(56, 189, 248, 0.55)';
    for (const p of _particles) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.4, 0, Math.PI * 2);
      ctx.fill();

      if (!_reducedMotion) {
        p.x += p.vx;
        p.y += p.vy;
        // Bounce am Rand
        if (p.x < 0 || p.x > w) p.vx = -p.vx;
        if (p.y < 0 || p.y > h) p.vy = -p.vy;
      }
    }

    ctx.restore();
  }

  onMount(() => {
    const canvas = canvasEl;
    if (!canvas) return;
    const ctx = _init(canvas);
    if (!ctx) return;

    const isMobile = window.matchMedia('(max-width: 480px)').matches;
    const count = isMobile ? 20 : 30;

    let dim = _resize(canvas);
    _particles = _seed(dim.w, dim.h, count);

    // reduced-motion: einmalig zeichnen, keine Animation
    const mqReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    _reducedMotion = mqReduced.matches;
    const onReducedChange = () => { _reducedMotion = mqReduced.matches; };
    mqReduced.addEventListener?.('change', onReducedChange);

    const onVisibility = () => {
      if (document.hidden) _stop(); else _start();
    };

    const onResize = () => {
      dim = _resize(canvas);
      // Particles in neuer Bounding-Box halten
      for (const p of _particles) {
        if (p.x > dim.w) p.x = dim.w;
        if (p.y > dim.h) p.y = dim.h;
      }
    };

    function _loop() {
      if (!_running) return;
      _step(ctx, dim.w, dim.h, dim.dpr);
      _raf = requestAnimationFrame(_loop);
    }

    function _start() {
      if (_running) return;
      _running = true;
      _loop();
    }

    function _stop() {
      _running = false;
      if (_raf) { cancelAnimationFrame(_raf); _raf = null; }
    }

    _start();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', onResize);

    return () => {
      _stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      mqReduced.removeEventListener?.('change', onReducedChange);
    };
  });
</script>

<canvas bind:this={canvasEl} class="particles" aria-hidden="true"></canvas>

<style>
  .particles {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 0;
  }
</style>
