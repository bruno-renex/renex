/**
 * Pulse-Permission — DeviceMotion-Berechtigung (PULSE.md §5.2, §9.2).
 *
 * iOS 13+ verlangt für `DeviceMotionEvent` einen expliziten, per User-Geste
 * ausgelösten Permission-Call. Android/Desktop brauchen keine Permission.
 *
 * WICHTIG (per-Chat-Opt-in, kein globaler App-Start-Prompt): requestMotion()
 * MUSS direkt aus einem Click-/Touch-Handler aufgerufen werden, sonst lehnt
 * iOS still ab. Bei Ablehnung fällt Pulse graceful auf Typing-Rate / Touch
 * zurück (kein Nag, Chat funktioniert normal weiter).
 */

/** Existiert die DeviceMotion-API überhaupt? */
export function motionSupported() {
  return typeof window !== 'undefined' && typeof window.DeviceMotionEvent !== 'undefined';
}

/** Verlangt diese Plattform einen expliziten Permission-Prompt? (iOS 13+) */
export function motionNeedsPermission() {
  return motionSupported()
    && typeof window.DeviceMotionEvent.requestPermission === 'function';
}

/**
 * Fordert die Motion-Permission an. NUR aus einer User-Geste aufrufen.
 * @returns {Promise<'granted'|'denied'|'unsupported'>}
 *   - 'unsupported': keine DeviceMotion-API (z.B. Desktop ohne Sensor)
 *   - 'granted':     erlaubt (oder Plattform ohne Permission-Pflicht → implizit)
 *   - 'denied':      abgelehnt oder Fehler → Fallback auf Typing/Touch
 */
export async function requestMotion() {
  if (!motionSupported()) return 'unsupported';
  if (!motionNeedsPermission()) return 'granted'; // Android/Desktop: implizit
  try {
    const res = await window.DeviceMotionEvent.requestPermission();
    return res === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}
