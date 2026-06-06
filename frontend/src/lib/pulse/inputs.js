/**
 * Pulse-Inputs — Erfassung & Normalisierung der Bewegungs-Inputs (PULSE.md §5).
 *
 * Sammelt passive Events (Maus, Wheel, Touch, DeviceMotion, Tippen) und treibt
 * damit eine lokale Pulse-Engine. Jeden Frame (rAF-gedrosselt) wird die
 * geglättete Energie + der Mode via onUpdate(energy, mode) emittiert.
 *
 *  Desktop: mousemove (Geschwindigkeit), wheel, keydown (Tipprate + Backspace).
 *  Mobile:  touchmove (Geschwindigkeit), devicemotion (Beschleunigung).
 *
 * Roh-Inputs werden gerätagnostisch auf 0..1 normalisiert; die Engine glättet
 * (EMA) + decayed. NICHTS verlässt dieses Modul außer dem Skalar {energy, mode}.
 */

import { createPulseState, pushInput, tick } from './engine.js';

// Normalisierungs-Konstanten (gerätspezifisch kalibriert)
const MOUSE_SPEED_MAX = 2.2;   // px/ms → energy 1
const TOUCH_SPEED_MAX = 0.9;   // px/ms (Touch langsamer als Maus-Flicks)
const WHEEL_MAX = 200;         // |deltaY| → energy 1
const MOTION_MAX = 1.5;        // m/s² (Foam-Schwelle, §5.4) → energy 1
const MOTION_DROP_CLAMP = 6;   // m/s² Phone-Drop-Filter — darüber ignorieren (§5.4)
const THINK_FLOOR = 0.30;      // Thinking Pulse: Energie-Boden während des Komponierens
const TYPE_WINDOW = 500;       // ms Sliding-Window für Tipprate

function now() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();
}

/**
 * @param {object} opts
 * @param {(energy:number, mode:string)=>void} opts.onUpdate  pro Frame aufgerufen
 * @returns {{start:Function, stop:Function, enableMotion:Function, disableMotion:Function, isMotionEnabled:Function}}
 */
export function createPulseInputs({ onUpdate, getComposing } = {}) {
  const state = createPulseState(now());
  let raf = null;
  let running = false;
  let motionEnabled = false;

  let instMax = 0;          // max. normalisierter Input dieses Frames
  let lastMx = 0, lastMy = 0, lastMt = 0;   // Maus
  let lastTx = 0, lastTy = 0, lastTt = 0;   // Touch
  let typeTimes = [];       // keydown-Timestamps (Sliding-Window)
  let backspaceBoost = 0;   // Backspace als emotional-marker (§5.1)
  let typeKick = 0;         // kleiner Blip pro Tastendruck (etwas mehr Aktivität beim Tippen)

  function bump(v) {
    if (v > instMax) instMax = v;  // Engine clampt selbst auf [0,1]
  }

  // ── Desktop ──
  function onMouseMove(e) {
    const t = now();
    if (lastMt) {
      const dt = t - lastMt;
      if (dt > 0) {
        const dist = Math.hypot(e.clientX - lastMx, e.clientY - lastMy);
        bump((dist / dt) / MOUSE_SPEED_MAX);
      }
    }
    lastMx = e.clientX; lastMy = e.clientY; lastMt = t;
  }
  function onWheel(e) {
    bump(Math.abs(e.deltaY) / WHEEL_MAX);
  }
  function onKeyDown(e) {
    const t = now();
    typeTimes.push(t);
    const cutoff = t - TYPE_WINDOW;
    while (typeTimes.length && typeTimes[0] < cutoff) typeTimes.shift();
    typeKick = Math.min(1, typeKick + 0.12);   // jeder Tastendruck = kleiner Aktivitäts-Blip
    if (e.key === 'Backspace') backspaceBoost = Math.min(1, backspaceBoost + 0.18);
  }

  // ── Touch ──
  function onTouchMove(e) {
    const tch = e.touches && e.touches[0];
    if (!tch) return;
    const t = now();
    if (lastTt) {
      const dt = t - lastTt;
      if (dt > 0) {
        const dist = Math.hypot(tch.clientX - lastTx, tch.clientY - lastTy);
        bump((dist / dt) / TOUCH_SPEED_MAX);
      }
    }
    lastTx = tch.clientX; lastTy = tch.clientY; lastTt = t;
  }

  // ── Motion (nur wenn Permission erteilt) ──
  function onMotion(e) {
    if (!motionEnabled) return;
    const a = e.acceleration || e.accelerationIncludingGravity;
    if (!a) return;
    const mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
    if (mag > MOTION_DROP_CLAMP) return; // Drop-Filter
    bump(mag / MOTION_MAX);
  }

  function frame() {
    if (!running) return;
    const t = now();

    // Tipprate-Beitrag (chars/sec / 10, §5.1): typeTimes über 500ms → /5
    const cutoff = t - TYPE_WINDOW;
    while (typeTimes.length && typeTimes[0] < cutoff) typeTimes.shift();
    if (typeTimes.length) bump(typeTimes.length / 5);

    if (typeKick > 0) {
      bump(typeKick);
      typeKick *= 0.82;
      if (typeKick < 0.02) typeKick = 0;
    }

    if (backspaceBoost > 0) {
      bump(backspaceBoost);
      backspaceBoost *= 0.85;
      if (backspaceBoost < 0.02) backspaceBoost = 0;
    }

    // Thinking Pulse: solange im Composer formuliert wird, steter Grundpegel →
    // Puls bleibt „active" auch in Denkpausen (EMA rampt sanft rein/raus).
    if (getComposing && getComposing()) bump(THINK_FLOOR);

    if (instMax > 0) pushInput(state, instMax, t);
    const { energy, mode } = tick(state, t);
    instMax = 0;

    if (onUpdate) onUpdate(energy, mode);
    raf = requestAnimationFrame(frame);
  }

  return {
    start() {
      if (running) return;
      running = true;
      lastMt = lastTt = 0;
      typeTimes = [];
      backspaceBoost = 0;
      typeKick = 0;
      window.addEventListener('mousemove', onMouseMove, { passive: true });
      window.addEventListener('wheel', onWheel, { passive: true });
      window.addEventListener('touchmove', onTouchMove, { passive: true });
      window.addEventListener('devicemotion', onMotion, { passive: true });
      document.addEventListener('keydown', onKeyDown, { passive: true });
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('devicemotion', onMotion);
      document.removeEventListener('keydown', onKeyDown);
    },
    enableMotion() { motionEnabled = true; },
    disableMotion() { motionEnabled = false; },
    isMotionEnabled() { return motionEnabled; },
  };
}
