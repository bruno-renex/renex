/**
 * Pulse-Engine — die "pure function + lokaler State"-Schicht aus PULSE.md §4.1.
 *
 * Übersetzt rohe, bereits auf 0..1 normalisierte Bewegungs-Inputs in eine
 * geglättete "Lebensenergie" (energy) + einen diskreten Mood-Mode
 * (calm/active/excited/foam). Keine DOM-, keine Netz-, keine Crypto-Abhängigkeit
 * — damit vollständig unit-testbar.
 *
 *  Pipeline (PULSE.md §5.3):
 *    Raw-Input → EMA (α=0.15) → Saturation [0,1] → Auto-Decay (0.05/s) wenn idle
 *
 *  Mode-FSM mit Hysterese (PULSE.md §6) — kein Flackern:
 *    calm    → active   wenn energy > 0.30 für ≥ 200ms
 *    active  → excited  wenn energy > 0.65 für ≥ 150ms
 *    excited → foam     wenn energy > 0.90 (Spike)
 *    foam    → excited  nach 800ms Cooldown
 *    excited → active   wenn energy < 0.55 für ≥ 500ms
 *    active  → calm     wenn energy < 0.20 für ≥ 1000ms
 *
 * Foam ist bewusst kurzlebig (annoying-by-design vermeiden).
 */

export const MODES = Object.freeze({
  CALM: 'calm',
  ACTIVE: 'active',
  EXCITED: 'excited',
  FOAM: 'foam',
});

export const EMA_ALPHA = 0.15;       // Glättung des Input-Signals
export const DECAY_PER_SEC = 0.05;   // Energie-Abfall pro Sekunde wenn keine Inputs
export const FOAM_COOLDOWN_MS = 800; // Foam-Auto-Decay
export const FOAM_THRESHOLD = 0.90;  // Spike-Schwelle für Foam

// Hysterese-Schwellen + Haltedauern
const TH = Object.freeze({
  c2a: { cmp: (e) => e > 0.30, ms: 200 },   // calm    → active
  a2e: { cmp: (e) => e > 0.65, ms: 150 },   // active  → excited
  e2a: { cmp: (e) => e < 0.55, ms: 500 },   // excited → active
  a2c: { cmp: (e) => e < 0.20, ms: 1000 },  // active  → calm
});

/**
 * Erzeugt einen frischen Engine-State. `now` = aktueller Timestamp (ms).
 * Init-Energie 0.05 — "calm hat Lebenszeichen" (PULSE.md §9.6, kein totes 0).
 */
export function createPulseState(now = 0) {
  return {
    energy: 0.05,
    mode: MODES.CALM,
    lastTick: now,
    foamUntil: 0,
    timers: Object.create(null), // transitionName → startTs
  };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Hält die Bedingung `cond` schon mindestens `dur` ms an?
 * Verwaltet den Timer in state.timers[name]; resettet ihn sobald cond false wird.
 */
function held(state, name, cond, now, dur) {
  if (cond) {
    if (state.timers[name] == null) state.timers[name] = now;
    return now - state.timers[name] >= dur;
  }
  state.timers[name] = null;
  return false;
}

function clearTimers(state) {
  state.timers = Object.create(null);
}

/**
 * Füttert einen neuen, auf 0..1 normalisierten Roh-Input ein (z.B. Maus-/Touch-
 * Geschwindigkeit). Glättet via EMA. `raw` darf > 0.90 sein (treibt Foam).
 * Gibt die neue Energie zurück.
 */
export function pushInput(state, raw, now) {
  const r = clamp01(raw);
  // EMA: schnelles Folgen nach oben (Responsiveness), sanfteres Nachgeben.
  // Nach oben mit erhöhtem α, damit ein kräftiger Move sofort spürbar ist.
  const alpha = r > state.energy ? Math.min(1, EMA_ALPHA * 3) : EMA_ALPHA;
  state.energy = clamp01(state.energy + alpha * (r - state.energy));
  state.lastTick = now;
  updateMode(state, now);
  return state.energy;
}

/**
 * Zeitschritt ohne neuen Input: Auto-Decay + Mode-FSM. In der Render-/Sync-Loop
 * jeden Frame aufrufen. Gibt {energy, mode} zurück.
 */
export function tick(state, now) {
  const dt = Math.max(0, now - state.lastTick);
  if (dt > 0) {
    state.energy = clamp01(state.energy - DECAY_PER_SEC * (dt / 1000));
    state.lastTick = now;
  }
  updateMode(state, now);
  return { energy: state.energy, mode: state.mode };
}

function updateMode(state, now) {
  const e = state.energy;
  switch (state.mode) {
    case MODES.CALM:
      if (held(state, 'c2a', TH.c2a.cmp(e), now, TH.c2a.ms)) {
        state.mode = MODES.ACTIVE;
        clearTimers(state);
      }
      break;

    case MODES.ACTIVE:
      if (held(state, 'a2e', TH.a2e.cmp(e), now, TH.a2e.ms)) {
        state.mode = MODES.EXCITED;
        clearTimers(state);
      } else if (held(state, 'a2c', TH.a2c.cmp(e), now, TH.a2c.ms)) {
        state.mode = MODES.CALM;
        clearTimers(state);
      }
      break;

    case MODES.EXCITED:
      if (e > FOAM_THRESHOLD) {
        // Spike → Foam (kein Halte-Timer, sofort)
        state.mode = MODES.FOAM;
        state.foamUntil = now + FOAM_COOLDOWN_MS;
        clearTimers(state);
      } else if (held(state, 'e2a', TH.e2a.cmp(e), now, TH.e2a.ms)) {
        state.mode = MODES.ACTIVE;
        clearTimers(state);
      }
      break;

    case MODES.FOAM:
      if (now >= state.foamUntil) {
        state.mode = MODES.EXCITED;
        clearTimers(state);
      }
      break;

    default:
      state.mode = MODES.CALM;
  }
}

/**
 * Leitet einen Mode allein aus einem Energiewert ab (für den Empfänger, der nur
 * {energy, mode} bekommt und ohne FSM-Historie smoothen will — Fallback wenn
 * der Sender-Mode fehlt). Reine Bereichs-Zuordnung, keine Hysterese.
 */
export function modeFromEnergy(energy) {
  const e = clamp01(energy);
  if (e >= 0.85) return MODES.FOAM;
  if (e >= 0.60) return MODES.EXCITED;
  if (e >= 0.25) return MODES.ACTIVE;
  return MODES.CALM;
}
