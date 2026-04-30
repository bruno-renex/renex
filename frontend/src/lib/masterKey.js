// ======================================================
// MasterKey-Cache — Recovery-MasterKey persistiert in IDB
// ======================================================
// Spec: docs/RECOVERY.md (Bundle-Auto-Sync)
//
// Der MasterKey wird aus der BIP39-Phrase abgeleitet (PBKDF2, ~500ms).
// Damit Auto-Bundle-Sync auf CMK-Änderung NICHT bei jeder Aktion neu
// die Phrase abfragt, persistieren wir den abgeleiteten Schlüssel:
//
//   wrap(masterKey, deviceStorageKey) → IDB
//
// `deviceStorageKey` ist HKDF(device_secret + userHandle), siehe cmk.js.
// Verlust-Modell:
//   - Normaler Reload: ✅ Cache überlebt → Auto-Sync funktioniert
//   - Inkognito-Tab-Close / IDB-Wipe: ❌ Cache weg → User muss Phrase
//     neu eingeben (RecoveryLoginModal); danach wird Cache wieder gefüllt
//   - Phrasenverlust: ❌ Daten unwiederherstellbar (gewollt)
// ======================================================

import { idbGet, idbSet, idbDelete } from './idb.js';
import { bytesToB64, b64ToBytes } from './bytes.js';

// Legacy-Key (vor Multi-User-Fix): nicht per-user-skoped → wurde überschrieben
// wenn mehrere User denselben Browser benutzten. Wir migrieren beim ersten Zugriff.
const IDB_KEY_MK_LEGACY = 'recovery_master_key';
// Neuer per-User Key: recovery_master_key:<handle>
function mkIdbKey(handle) {
  const h = String(handle || '').toLowerCase();
  if (!h) throw new Error('masterKey: handle required');
  return `recovery_master_key:${h}`;
}

const IDB_KEY_DS = 'device_secret';

// Memory-Cache pro Handle. Vermeidet, dass User-A's MasterKey nach User-B-Login
// noch im Modul-State herumgeistert.
const _inMemoryMasterKey = new Map();  // handle → Uint8Array

function getMyHandle() {
  if (typeof localStorage === 'undefined') return '';
  return (localStorage.getItem('my_user') || '').toLowerCase();
}

/**
 * Liefert (oder erzeugt) das per-Device random 32-Byte secret in IDB.
 * Spiegelt cmk.js getDeviceSecretB64 — eigene Kopie hier um Circular-Import
 * zu vermeiden (cmk.js → cmkBundleSync.js → masterKey.js).
 *
 * Brand-neue User haben das Secret noch nicht (e2eKeys.js generiert es lazy
 * beim ersten CMK-Bedarf). Bei Recovery-Onboarding wird cacheMasterKey
 * VOR jedem CMK aufgerufen → wir müssen hier selbst initialisieren können.
 */
async function getOrInitDeviceSecret() {
  let s = await idbGet(IDB_KEY_DS);
  if (s) return s;
  // Migration: localStorage (Legacy)
  const legacy = typeof localStorage !== 'undefined'
    ? localStorage.getItem('device_secret')
    : null;
  if (legacy) {
    await idbSet(IDB_KEY_DS, legacy);
    return legacy;
  }
  // Neu erzeugen
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  s = bytesToB64(bytes);
  await idbSet(IDB_KEY_DS, s);
  return s;
}

async function deviceStorageKey() {
  const secretB64 = await getOrInitDeviceSecret();
  const secretBytes = b64ToBytes(secretB64);
  const baseKey = await crypto.subtle.importKey(
    'raw', secretBytes, { name: 'HKDF' }, false, ['deriveKey']
  );
  const handle = getMyHandle();
  const info = new TextEncoder().encode(`renex:masterkey:${handle}`);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Speichert den MasterKey verschlüsselt in IDB unter `recovery_master_key:<handle>`.
 *
 * masterKey ist ein non-extractable AES-GCM-CryptoKey aus deriveMasterKey().
 * Wir können ihn NICHT direkt exportieren. Stattdessen exportieren wir die
 * Raw-Bytes via separater Derivation: caller muss `deriveMasterKeyRaw()` benutzen.
 *
 * @param {Uint8Array} masterKeyBytes 32 Bytes raw key material
 */
export async function cacheMasterKey(masterKeyBytes) {
  if (!(masterKeyBytes instanceof Uint8Array) || masterKeyBytes.length !== 32) {
    throw new Error('masterKey must be 32 raw bytes');
  }
  const handle = getMyHandle();
  if (!handle) throw new Error('masterKey: my_user not set');

  _inMemoryMasterKey.set(handle, masterKeyBytes);

  const dsKey = await deviceStorageKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    dsKey,
    masterKeyBytes
  );
  await idbSet(mkIdbKey(handle), {
    ivB64: bytesToB64(iv),
    ctB64: bytesToB64(new Uint8Array(ct)),
  });

  // Legacy-Key aufräumen (Migration vom unprefixed Key auf per-user)
  // Nur wenn Legacy mit *unserem* dsKey decryptbar war — sonst gehört er
  // einem anderen User und wir lassen ihn liegen (der andere User soll ihn
  // selbst migrieren wenn er sich einloggt).
  void _maybeCleanupLegacyKey(dsKey);
}

async function _maybeCleanupLegacyKey(dsKey) {
  try {
    const saved = await idbGet(IDB_KEY_MK_LEGACY);
    if (!saved || !saved.ivB64 || !saved.ctB64) return;
    // Test-Decrypt: wenn klappt, war's unsere → wegräumen
    const iv = b64ToBytes(saved.ivB64);
    const ct = b64ToBytes(saved.ctB64);
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, dsKey, ct.buffer);
    await idbDelete(IDB_KEY_MK_LEGACY);
  } catch {}
}

/**
 * Lädt den MasterKey aus IDB für den aktuellen User. Returnt null wenn nicht gecached.
 * Migriert Legacy-Eintrag (`recovery_master_key` ohne Handle-Suffix) bei erstem Zugriff,
 * falls er mit dem aktuellen User-Storage-Key decryptbar ist.
 *
 * @returns {Promise<Uint8Array|null>} 32 Bytes raw key material
 */
export async function loadCachedMasterKey() {
  const handle = getMyHandle();
  if (!handle) return null;

  const inMemory = _inMemoryMasterKey.get(handle);
  if (inMemory) return inMemory;

  try {
    const dsKey = await deviceStorageKey();

    // 1. Per-User-Key (current standard)
    const saved = await idbGet(mkIdbKey(handle));
    if (saved && saved.ivB64 && saved.ctB64) {
      try {
        const bytes = await _decryptMK(saved, dsKey);
        if (bytes) {
          _inMemoryMasterKey.set(handle, bytes);
          return bytes;
        }
      } catch {}
    }

    // 2. Legacy-Migration: alter unprefixed Key, falls noch da
    const legacy = await idbGet(IDB_KEY_MK_LEGACY);
    if (legacy && legacy.ivB64 && legacy.ctB64) {
      try {
        const bytes = await _decryptMK(legacy, dsKey);
        if (bytes) {
          // Migrate: in per-user Key umziehen, Legacy weglöschen
          await idbSet(mkIdbKey(handle), legacy);
          await idbDelete(IDB_KEY_MK_LEGACY);
          _inMemoryMasterKey.set(handle, bytes);
          return bytes;
        }
      } catch {}
    }

    return null;
  } catch {
    return null;
  }
}

async function _decryptMK(saved, dsKey) {
  const iv = b64ToBytes(saved.ivB64);
  const ct = b64ToBytes(saved.ctB64);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, dsKey, ct.buffer);
  const bytes = new Uint8Array(pt);
  if (bytes.length !== 32) return null;
  return bytes;
}

/**
 * Importiert raw masterKey-Bytes als CryptoKey (für encrypt/decrypt von Bundles).
 */
export async function masterKeyBytesToCryptoKey(bytes) {
  return crypto.subtle.importKey(
    'raw', bytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Löscht den gecacheten MasterKey für den aktuellen User (z.B. nach Logout
 * + bewusstem "Vergiss meine Phrase" — nicht beim normalen Logout, sonst
 * müsste User die Phrase bei jedem Login neu eingeben).
 */
export async function clearCachedMasterKey() {
  const handle = getMyHandle();
  if (!handle) return;
  _inMemoryMasterKey.delete(handle);
  await idbDelete(mkIdbKey(handle));
}

export function isMasterKeyCached() {
  const handle = getMyHandle();
  if (!handle) return false;
  return _inMemoryMasterKey.has(handle);
}
