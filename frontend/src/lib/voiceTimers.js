// ======================================================
// Voice-Timer Helper — testbare Timer-Verwaltung
// ======================================================
// Verkapselt setTimeout-basierte Timer mit Schlüssel-Lookup. Verhindert
// doppelte Timer pro Schlüssel (start cancelled vorher den alten).
// Nutzt voice.svelte.js für No-Answer-Timeout, ICE-Restart-Delay etc.
//
// Vorteile gegenüber inline `let _xTimer = null`-Pattern:
//   - In Isolation testbar (vi.useFakeTimers reicht)
//   - Kein Memory-Leak bei vergessenen Clears (Reset löscht alle)
//   - Gleiches Pattern für mehrere Timer-Use-Cases
// ======================================================

const TIMERS = new Map();  // key → timer-id

/**
 * Startet einen Timer unter `key`. Bestehender Timer mit gleichem Key
 * wird VORHER gecancelled (idempotent).
 *
 * @param {string} key - Eindeutiger Schlüssel (z.B. 'no-answer', 'restart-ice')
 * @param {number} ms - Delay in Millisekunden
 * @param {() => void} callback
 */
export function startVoiceTimer(key, ms, callback) {
  cancelVoiceTimer(key);
  const id = setTimeout(() => {
    TIMERS.delete(key);
    try { callback(); } catch (e) {
      // Timer-Callbacks sollen nie unhandled rejections produzieren
      console.warn(`voiceTimer ${key}: callback threw`, e?.message);
    }
  }, ms);
  TIMERS.set(key, id);
}

/**
 * Bricht den Timer unter `key` ab. No-op wenn nicht gesetzt.
 */
export function cancelVoiceTimer(key) {
  const id = TIMERS.get(key);
  if (id !== undefined) {
    clearTimeout(id);
    TIMERS.delete(key);
  }
}

/**
 * Prüft ob ein Timer aktuell läuft. Hauptsächlich für Tests.
 */
export function isVoiceTimerActive(key) {
  return TIMERS.has(key);
}

/**
 * Bricht ALLE laufenden Voice-Timer ab. Wird beim Call-Ende aufgerufen.
 */
export function clearAllVoiceTimers() {
  for (const id of TIMERS.values()) {
    clearTimeout(id);
  }
  TIMERS.clear();
}
