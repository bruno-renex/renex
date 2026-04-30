// ======================================================
// Multi-Device Lib — Frontend-API für Phase 1B
// ======================================================
// Wraps:
//   POST /e2e/inbox/heartbeat        → heartbeat()
//   GET  /e2e/devices/list           → listDevices()
//   POST /e2e/inbox/remove           → revokeDevice()
//
// Spec: docs/MULTI_DEVICE.md §10, §12
// ======================================================

import { apiFetch } from './api.js';
import { captureException } from './sentry.js';

/**
 * Heartbeat: meldet eigenes Device als "lebendig" an Backend.
 * Backend debounced 1×/Stunde — daher kann Frontend öfter rufen.
 * Idempotent. Silent-Fail (returnt false bei Fehler).
 */
export async function heartbeat(deviceId) {
  if (!deviceId) return false;
  try {
    const r = await apiFetch('/e2e/inbox/heartbeat', {
      method: 'POST',
      body: { deviceId },
    });
    return r.ok;
  } catch (e) {
    // Silent — Heartbeat-Fehler sind nicht kritisch
    return false;
  }
}

/**
 * Liste aller eigenen aktiven Devices (für Settings-UI).
 * @param {string} currentDeviceId - Local deviceId, wird im Response zurückgegeben für UI-Marker
 * @returns {Promise<{devices, currentDeviceId, maxDevices, tier} | null>}
 */
export async function listDevices(currentDeviceId) {
  try {
    const q = currentDeviceId
      ? `?current=${encodeURIComponent(currentDeviceId)}`
      : '';
    const r = await apiFetch(`/e2e/devices/list${q}`);
    if (!r.ok) return null;
    return r.data;
  } catch (e) {
    captureException(e, { context: 'listDevices' });
    return null;
  }
}

/**
 * Entfernt ein Device.
 * @param {string} deviceId
 * @param {'user'|'self'} reason
 *   - 'user': Sicherheits-Aktion (gestohlen) → CMK-Rotation auf Backend
 *   - 'self': Logout-Cleanup → keine Rotation
 * @returns {Promise<{ok: boolean, error?: string, remaining?: number}>}
 */
export async function revokeDevice(deviceId, reason = 'user') {
  if (!deviceId) return { ok: false, error: 'deviceId required' };
  if (reason !== 'user' && reason !== 'self') reason = 'user';
  try {
    const r = await apiFetch('/e2e/inbox/remove', {
      method: 'POST',
      body: { deviceId, reason },
    });
    if (r.ok) {
      return { ok: true, remaining: r.data?.remaining ?? 0 };
    }
    return { ok: false, error: r.error || 'unknown' };
  } catch (e) {
    captureException(e, { context: 'revokeDevice' });
    return { ok: false, error: e.message || 'unknown' };
  }
}

/**
 * Relatives Zeitformat: "jetzt", "vor 5min", "vor 3h", "gestern", "5. Apr".
 * Spec: docs/MULTI_DEVICE.md §12.2
 */
export function formatRelativeTime(ts, locale = 'de-DE') {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000) return locale.startsWith('de') ? 'jetzt' : 'now';
  if (diff < 3600_000) {
    const min = Math.floor(diff / 60_000);
    return locale.startsWith('de') ? `vor ${min}min` : `${min}min ago`;
  }
  if (diff < 86400_000) {
    const h = Math.floor(diff / 3600_000);
    return locale.startsWith('de') ? `vor ${h}h` : `${h}h ago`;
  }
  if (diff < 7 * 86400_000) {
    const d = Math.floor(diff / 86400_000);
    return locale.startsWith('de') ? `vor ${d}d` : `${d}d ago`;
  }
  return new Date(ts).toLocaleDateString(locale, {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

/**
 * Erkennt einen freundlichen Device-Namen aus dem User-Agent.
 * z.B. "Mac (Safari)", "iPhone (Safari)", "Windows (Chrome)".
 * Wird beim Add-Device an POST /e2e/inbox/upload mitgesendet.
 */
export function detectDeviceName() {
  const ua = navigator.userAgent || '';
  let device = 'Unknown';
  let browser = 'Browser';

  // Device
  if (/iPhone/.test(ua)) device = 'iPhone';
  else if (/iPad/.test(ua)) device = 'iPad';
  else if (/Android/.test(ua)) device = 'Android';
  else if (/Macintosh|Mac OS X/.test(ua)) device = 'Mac';
  else if (/Windows/.test(ua)) device = 'Windows';
  else if (/Linux/.test(ua)) device = 'Linux';

  // Browser
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';

  return `${device} (${browser})`;
}

/**
 * Icon für ein Device basierend auf Name oder User-Agent.
 */
export function deviceIcon(nameOrUa) {
  const s = (nameOrUa || '').toLowerCase();
  if (s.includes('iphone') || s.includes('ipad') || s.includes('android')) return '📱';
  if (s.includes('mac') || s.includes('macbook')) return '💻';
  if (s.includes('windows')) return '🖥️';
  if (s.includes('linux')) return '🐧';
  return '🔐';
}

// ======================================================
// Pure Helpers — testbar ohne Browser-Context
// Spec: docs/MULTI_DEVICE.md §8.1
// ======================================================

/**
 * 7-Tage-Cutoff-Filter beim Add-Device-Flow.
 * Nimmt eine Liste von Convos und gibt nur die zurück, die innerhalb der
 * Cutoff-Periode Aktivität hatten. Wird beim CMK-Re-Wrap für ein neues Device
 * verwendet (siehe MULTI_DEVICE.md §4.4.3).
 *
 * @param {Array<{convoId: string, lastMessageTs: number}>} convos
 * @param {number} now - Unix-ms (für Tests injectable)
 * @param {number} cutoffDays - Default 7 (siehe Spec §6 + Decision Log)
 * @returns {Array} Convos mit lastMessageTs > (now - cutoff)
 */
export function recoveryCutoffFilter(convos, now = Date.now(), cutoffDays = 7) {
  if (!Array.isArray(convos)) return [];
  const cutoffTs = now - cutoffDays * 86400_000;
  return convos.filter(c => c && typeof c.lastMessageTs === 'number' && c.lastMessageTs > cutoffTs);
}

/**
 * Device-State-Machine: erlaubte Transitions.
 * Spec: docs/MULTI_DEVICE.md §3 State-Machine.
 *
 * Mapping reflektiert die State-Machine 1:1:
 *   new      → syncing | revoked
 *   syncing  → active | revoked
 *   active   → active (Heartbeat) | revoked
 *   revoked  → (terminal, keine Transition)
 */
const VALID_TRANSITIONS = {
  new:     ['syncing', 'revoked'],
  syncing: ['active', 'revoked'],
  active:  ['active', 'revoked'],
  revoked: [],
};

export function isValidStateTransition(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

export const DEVICE_STATES = Object.freeze(['new', 'syncing', 'active', 'revoked']);
