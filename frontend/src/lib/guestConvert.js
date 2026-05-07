// ======================================================
// Guest-Convert Flow — Gast → Echter User-Account
// ======================================================
// Legacy /chat-Page leitet bei "Convert to Passkey" → /?registerGuest=1 weiter,
// und legt die Gast-Token-Daten in sessionStorage als 'pendingGuestConvert'.
//
// Nach erfolgreichem Passkey-Register MUSS:
//   1. POST /invite/convert mit guestToken aufgerufen werden
//   2. Backend migriert: Messages, Conversation, Contacts (guest_xxx → realHandle)
//   3. Frontend lädt Kontakte/Gruppen neu → Inviter erscheint in Inbox
//   4. sessionStorage cleanen
//
// Backend: src/routes/inviteRoutes.js → POST /invite/convert
// ======================================================

import { apiFetch } from './api.js';
import { captureException } from './sentry.js';

const STORAGE_KEY = 'pendingGuestConvert';

/**
 * Liest pending-convert-Daten (gesetzt von Legacy /chat).
 * @returns {{ token: string, convoId: string, convoType: string, inviterHandle: string }|null}
 */
export function readPendingGuestConvert() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.token && /^guest_[0-9a-f]+$/.test(parsed.token)) {
      return parsed;
    }
  } catch {}
  return null;
}

/**
 * Löscht pending-convert-Daten (nach erfolgreichem Convert oder bei Abbruch).
 */
export function clearPendingGuestConvert() {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
}

/**
 * Prüft ob ein Convert nötig ist (URL hat ?registerGuest=1 oder pending-Daten existieren).
 */
export function isGuestConvertPending() {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  if (params?.get('registerGuest') === '1') return true;
  return !!readPendingGuestConvert();
}

/**
 * Führt den Convert-API-Call aus. Muss NACH erfolgreicher Passkey-Registrierung
 * gerufen werden — Session muss real (nicht guest) sein.
 *
 * @returns {Promise<{ok: boolean, realHandle?: string, convoId?: string, inviterHandle?: string, error?: string}>}
 */
export async function performGuestConvert() {
  const pending = readPendingGuestConvert();
  if (!pending) return { ok: false, error: 'no_pending' };

  try {
    const r = await apiFetch('/invite/convert', {
      method: 'POST',
      body: { guestToken: pending.token },
    });
    if (!r.ok) {
      return { ok: false, error: r.error || 'convert_failed' };
    }
    clearPendingGuestConvert();
    return {
      ok:            true,
      realHandle:    r.data?.realHandle,
      convoId:       r.data?.convoId,
      convoType:     r.data?.convoType,
      inviterHandle: r.data?.inviterHandle,
    };
  } catch (e) {
    captureException(e, { context: 'performGuestConvert' });
    return { ok: false, error: e.message || 'exception' };
  }
}
