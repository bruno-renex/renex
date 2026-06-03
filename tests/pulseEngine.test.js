// ======================================================
// Unit-Tests für die Pulse-Engine (frontend/src/lib/pulse/engine.js)
// ======================================================
// Spec: docs/PULSE.md §5.3 (Normalization), §6 (Mode-FSM mit Hysterese)
//
// Garantien:
//   - EMA-Smoothing: Energie folgt Input geglättet, bleibt in [0,1]
//   - Auto-Decay: ohne Input fällt Energie mit ~0.05/s
//   - Mode-FSM: Transitions feuern erst nach Mindest-Haltedauer (Hysterese)
//   - Foam ist kurzlebig (Cooldown 800ms → excited)
//   - modeFromEnergy: reine Bereichs-Zuordnung für den Empfänger
// ======================================================

import { describe, it, expect } from 'vitest';
import {
  MODES,
  DECAY_PER_SEC,
  FOAM_COOLDOWN_MS,
  createPulseState,
  pushInput,
  tick,
  modeFromEnergy,
} from '../frontend/src/lib/pulse/engine.js';

// Hilfsfunktion: hält die Energie hoch indem wiederholt input gepusht wird,
// während die Zeit voranschreitet.
function drive(state, raw, fromTs, toTs, stepMs = 20) {
  for (let t = fromTs; t <= toTs; t += stepMs) {
    pushInput(state, raw, t);
  }
}

describe('Pulse-Engine — Init & Bereiche', () => {
  it('startet calm mit Lebenszeichen-Energie (0.05, nicht 0)', () => {
    const s = createPulseState(0);
    expect(s.mode).toBe(MODES.CALM);
    expect(s.energy).toBeCloseTo(0.05, 5);
  });

  it('modeFromEnergy ordnet Bereiche korrekt zu', () => {
    expect(modeFromEnergy(0.0)).toBe(MODES.CALM);
    expect(modeFromEnergy(0.24)).toBe(MODES.CALM);
    expect(modeFromEnergy(0.25)).toBe(MODES.ACTIVE);
    expect(modeFromEnergy(0.59)).toBe(MODES.ACTIVE);
    expect(modeFromEnergy(0.60)).toBe(MODES.EXCITED);
    expect(modeFromEnergy(0.84)).toBe(MODES.EXCITED);
    expect(modeFromEnergy(0.85)).toBe(MODES.FOAM);
    expect(modeFromEnergy(1.0)).toBe(MODES.FOAM);
    // Saturation
    expect(modeFromEnergy(5)).toBe(MODES.FOAM);
    expect(modeFromEnergy(-1)).toBe(MODES.CALM);
  });
});

describe('Pulse-Engine — EMA & Saturation', () => {
  it('hält Energie immer in [0,1]', () => {
    const s = createPulseState(0);
    for (let t = 0; t < 2000; t += 20) pushInput(s, 5, t); // raw > 1
    expect(s.energy).toBeLessThanOrEqual(1);
    expect(s.energy).toBeGreaterThanOrEqual(0);
  });

  it('folgt einem hohen Input nach oben (geglättet, nicht sofort)', () => {
    const s = createPulseState(0);
    const e1 = pushInput(s, 1, 20);
    expect(e1).toBeGreaterThan(0.05);
    expect(e1).toBeLessThan(1); // ein einzelner Schritt erreicht noch nicht 1
  });
});

describe('Pulse-Engine — Auto-Decay', () => {
  it('fällt ohne Input mit ~0.05/s', () => {
    const s = createPulseState(0);
    drive(s, 1, 0, 1000);          // Energie hochtreiben
    const before = s.energy;
    const { energy: after } = tick(s, s.lastTick + 1000); // 1s ohne Input
    expect(after).toBeCloseTo(Math.max(0, before - DECAY_PER_SEC), 2);
  });

  it('fällt nie unter 0', () => {
    const s = createPulseState(0);
    s.energy = 0.02;
    const { energy } = tick(s, s.lastTick + 5000);
    expect(energy).toBe(0);
  });
});

describe('Pulse-Engine — Mode-FSM Hysterese', () => {
  it('calm→active erst nach ≥200ms über 0.30', () => {
    const s = createPulseState(0);
    // Energie über 0.30 bringen
    drive(s, 0.6, 0, 100);
    expect(s.energy).toBeGreaterThan(0.30);
    // Noch nicht 200ms gehalten → bleibt calm (oder gerade erst)
    // Klar < 200ms:
    const s2 = createPulseState(0);
    pushInput(s2, 0.6, 10);
    expect(s2.mode).toBe(MODES.CALM); // 1 Schritt, Timer läuft noch
    // ≥200ms halten → active
    drive(s2, 0.6, 10, 400);
    expect(s2.mode).toBe(MODES.ACTIVE);
  });

  it('active→excited nach ≥150ms über 0.65', () => {
    const s = createPulseState(0);
    drive(s, 0.9, 0, 400);   // calm→active passiert unterwegs
    expect([MODES.ACTIVE, MODES.EXCITED, MODES.FOAM]).toContain(s.mode);
    drive(s, 0.8, 400, 800); // klar über 0.65, lange genug
    expect([MODES.EXCITED, MODES.FOAM]).toContain(s.mode);
  });

  it('excited→foam bei Spike >0.90, dann Cooldown→excited', () => {
    const s = createPulseState(0);
    // erst in excited bringen
    drive(s, 0.8, 0, 800);
    expect([MODES.EXCITED, MODES.FOAM]).toContain(s.mode);
    // Spike
    pushInput(s, 1, 820);
    drive(s, 1, 820, 1000);
    expect(s.mode).toBe(MODES.FOAM);
    // foamUntil wird beim Foam-EINTRITT gesetzt (nicht bei lastTick)
    const foamUntil = s.foamUntil;
    expect(foamUntil).toBeGreaterThan(0);
    // vor Cooldown-Ende noch foam
    tick(s, foamUntil - 50);
    expect(s.mode).toBe(MODES.FOAM);
    // nach Cooldown → excited
    tick(s, foamUntil + 10);
    expect(s.mode).toBe(MODES.EXCITED);
  });

  it('active→calm erst nach ≥1000ms unter 0.20', () => {
    const s = createPulseState(0);
    drive(s, 0.6, 0, 400);
    expect(s.mode).toBe(MODES.ACTIVE);
    // schnell auf <0.20 bringen
    s.energy = 0.1;
    const t = s.lastTick;
    tick(s, t + 100);     // a2c-Timer startet hier (~t+100)
    expect(s.mode).toBe(MODES.ACTIVE);
    tick(s, t + 500);     // ~400ms unter Schwelle gehalten → noch active
    expect(s.mode).toBe(MODES.ACTIVE);
    tick(s, t + 1200);    // ~1100ms gehalten → calm
    expect(s.mode).toBe(MODES.CALM);
  });

  it('flackert nicht: kurzer Spike unter Haltedauer wechselt Mode nicht', () => {
    const s = createPulseState(0);
    pushInput(s, 1, 10);   // ein einzelner hoher Input
    tick(s, 60);           // 50ms später
    expect(s.mode).toBe(MODES.CALM); // < 200ms → noch calm
  });
});
