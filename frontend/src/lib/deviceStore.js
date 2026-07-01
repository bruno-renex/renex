// ======================================================
// device_secret-abgeleiteter At-Rest-Storage (geteilt)
// ======================================================
// Kleiner, wiederverwendbarer Helfer: leitet aus dem geräteeigenen device_secret
// (geteilt mit cmk.js/kemIdentity.js) per HKDF+info einen AES-GCM-Storage-Key ab
// und ver-/entschlüsselt rohe Bytes für IDB. Distinkte info-Strings → isolierte
// Keys pro Subsystem (kemstore / pqxdh / …).
// ======================================================
import { idbGet, idbSet } from './idb.js';
import { bytesToB64, b64ToBytes } from './bytes.js';

const IDB_DEVICE_SECRET = 'device_secret';

/** device_secret (32 rand Bytes) lesen oder anlegen — konsistent mit cmk.js. */
export async function deviceSecretBytes() {
  let s = await idbGet(IDB_DEVICE_SECRET);
  if (!s) {
    s = bytesToB64(crypto.getRandomValues(new Uint8Array(32)));
    await idbSet(IDB_DEVICE_SECRET, s);
  }
  return b64ToBytes(s);
}

/** AES-GCM-256-Storage-Key ableiten. `info` domain-separiert je Subsystem. */
export async function deriveStorageKey(info) {
  const base = await crypto.subtle.importKey('raw', await deviceSecretBytes(), { name: 'HKDF' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(info) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

/** Beliebiges JSON-serialisierbares Objekt versiegeln → {ivB64, ctB64}. */
export async function sealJson(key, obj) {
  const pt = new TextEncoder().encode(JSON.stringify(obj));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt);
  return { ivB64: bytesToB64(iv), ctB64: bytesToB64(new Uint8Array(ct)) };
}

/** {ivB64, ctB64} entsiegeln → Objekt (oder null bei Fehler/leer). */
export async function openJson(key, sealed) {
  if (!sealed?.ivB64 || !sealed?.ctB64) return null;
  try {
    const iv = b64ToBytes(sealed.ivB64);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64ToBytes(sealed.ctB64));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch { return null; }
}
