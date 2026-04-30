// ======================================================
// Session-Keys + Message-Keys + Rotation
// ======================================================
// Port aus renex-legacy/js/e2e.js (Lines 380-660).
//
// Zwei-Stufen-HKDF-Hierarchie pro DM:
//   CMK (32B random)
//     → SessionKey: HKDF(CMK, salt='renex/cmk-v2', info=`session:<sid>:rotation:<i>`)
//       → MessageKey: HKDF(SK, salt=sid, info=`renex/v2/mk/epoch:<epoch>`)
//
// Rotation-Index wechselt SK ohne CMK-Wechsel (z.B. nach N Messages).
// CMK-Wechsel erzeugt einen neuen Eintrag in der Rotation-Map.
//
// Spec: docs/MULTI_DEVICE.md §4.2 (Send-Flow)
// ======================================================

import { idbGet, idbSet } from './idb.js';

// ======================================================
// Konstanten
// ======================================================

/**
 * Epoch-Granularität für Message-Keys: 1 Stunde.
 * Sender + Receiver berechnen den gleichen epoch aus message.ts wenn
 * `epoch` nicht explizit im Message-Body steht.
 * Receiver versuchen ±1 epoch für Clock-Skew-Toleranz.
 */
export const EPOCH_MS = 3_600_000;

// ======================================================
// Session-ID
// ======================================================

/**
 * Deterministische DM-Session-ID, alphabetisch sortiert.
 * @param {string} me
 * @param {string} peer
 * @returns {string} z.B. "dm:alice:bob"
 */
export function dmSessionId(me, peer) {
  const a = String(me).toLowerCase();
  const b = String(peer).toLowerCase();
  return a < b ? `dm:${a}:${b}` : `dm:${b}:${a}`;
}

/**
 * Extrahiert den Peer-Handle aus einer DM-SID.
 * "dm:alice:bob" + me="alice" → "bob"
 * Wird für SID-basierten Fallback bei Guest-Conversion benötigt.
 */
export function peerFromDmSid(sid, me) {
  if (typeof sid !== 'string' || !sid.startsWith('dm:')) return null;
  const parts = sid.slice(3).split(':');
  if (parts.length !== 2) return null;
  const meL = String(me || '').toLowerCase();
  const [a, b] = parts;
  if (a === meL) return b;
  if (b === meL) return a;
  return null;
}

// ======================================================
// Session-Key-Derivation (Stufe 1: CMK → SK)
// ======================================================

/**
 * Leitet Session-Key-Bytes aus einem CMK ab (Rotation-Index 0 / Default).
 * @param {Uint8Array} cmkBytes - 32 Bytes
 * @param {string} sessionId
 * @returns {Promise<Uint8Array>} 32 Bytes
 */
export async function deriveSessionKeyBytes(cmkBytes, sessionId) {
  if (!(cmkBytes instanceof Uint8Array) || cmkBytes.length !== 32) {
    throw new Error('CMK ungültig');
  }

  const cmkKey = await crypto.subtle.importKey(
    'raw', cmkBytes,
    'HKDF',
    false, ['deriveBits']
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('renex/cmk-v2'),
      info: new TextEncoder().encode(`session:${sessionId}`),
    },
    cmkKey,
    256
  );

  return new Uint8Array(bits);
}

/**
 * Variante mit explizitem Rotation-Index.
 * Index 0 nutzt die alte Formel (backward-compat zu deriveSessionKeyBytes).
 */
export async function deriveSessionKeyBytesForRotation(cmkBytes, sessionId, rotationIndex) {
  if (rotationIndex === 0 || rotationIndex == null) {
    return deriveSessionKeyBytes(cmkBytes, sessionId);
  }

  const cmkKey = await crypto.subtle.importKey(
    'raw', cmkBytes,
    'HKDF',
    false, ['deriveBits']
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('renex/cmk-v2'),
      info: new TextEncoder().encode(`session:${sessionId}:rotation:${rotationIndex}`),
    },
    cmkKey,
    256
  );

  return new Uint8Array(bits);
}

// ======================================================
// Message-Key-Derivation (Stufe 2: SK → MK pro Epoch)
// ======================================================

/**
 * HKDF von Session-Key zum Message-Key (epoch-basiert).
 * Liefert direkt einen AES-GCM-CryptoKey.
 *
 * @param {Uint8Array} skBytes - 32 Bytes (von deriveSessionKeyBytes)
 * @param {string} sessionId
 * @param {number} epoch
 * @returns {Promise<CryptoKey>} AES-GCM
 */
export async function deriveMessageKey(skBytes, sessionId, epoch) {
  const sk = await crypto.subtle.importKey(
    'raw', skBytes,
    'HKDF',
    false, ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(sessionId),
      info: new TextEncoder().encode(`renex/v2/mk/epoch:${epoch}`),
    },
    sk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ======================================================
// Rotation-State pro Session in IDB
// ======================================================

/**
 * Aktueller Rotation-Index für eine Session.
 */
export async function getRotationIndex(sessionId) {
  return (await idbGet(`rotation:${sessionId}`)) ?? 0;
}

export async function setRotationIndex(sessionId, index) {
  await idbSet(`rotation:${sessionId}`, index);
}

/**
 * Zeitstempel der letzten Rotation (für zeit-basierte Rotation).
 */
export async function getLastRotationTime(sessionId) {
  return (await idbGet(`lastRotation:${sessionId}`)) ?? 0;
}

export async function setLastRotationTime(sessionId, ts) {
  await idbSet(`lastRotation:${sessionId}`, ts);
}

// ======================================================
// CMK-Rotation-Map: welcher CMK gilt ab welchem Rotation-Index
// ======================================================

const MAX_ROTATION_MAP_ENTRIES = 50;

/**
 * Format: [{ fromIndex: 0, cmkBytes: [...] }, { fromIndex: 50, cmkBytes: [...] }, ...]
 * rotationIndex wird NIE zurückgesetzt — CMK-Wechsel = neuer Eintrag.
 */
export async function getRotationMap(sessionId) {
  return (await idbGet(`cmk:rotation-map:${sessionId}`)) || [];
}

/**
 * Hängt einen neuen CMK-Wechsel-Eintrag an. Map wird auf MAX-Einträge gekürzt.
 */
export async function appendToRotationMap(sessionId, fromIndex, cmkBytes) {
  const map = await getRotationMap(sessionId);
  // Filter alte Einträge mit gleichem oder höherem Index (Collision-Schutz)
  const filtered = map.filter(e => e.fromIndex < fromIndex);
  filtered.push({ fromIndex, cmkBytes: Array.from(cmkBytes) });
  const trimmed = filtered.length > MAX_ROTATION_MAP_ENTRIES
    ? filtered.slice(-MAX_ROTATION_MAP_ENTRIES)
    : filtered;
  await idbSet(`cmk:rotation-map:${sessionId}`, trimmed);
}

/**
 * Sucht den richtigen CMK für einen gegebenen Rotation-Index in der Map.
 * @param {Array} rotationMap
 * @param {number} rotationIndex
 * @returns {Uint8Array|null}
 */
export function findCmkForRotationIndex(rotationMap, rotationIndex) {
  if (!rotationMap || rotationMap.length === 0) return null;
  // Alle Einträge mit fromIndex <= rotationIndex sind anwendbar
  const applicable = rotationMap.filter(e => e.fromIndex <= rotationIndex);
  if (applicable.length === 0) {
    // Älterer Index als der erste Eintrag → ersten nehmen
    const first = rotationMap[0];
    return first?.cmkBytes ? new Uint8Array(first.cmkBytes) : null;
  }
  // Letzten anwendbaren Eintrag nehmen (höchster fromIndex der noch <= rotationIndex)
  const entry = applicable[applicable.length - 1];
  return entry?.cmkBytes ? new Uint8Array(entry.cmkBytes) : null;
}
