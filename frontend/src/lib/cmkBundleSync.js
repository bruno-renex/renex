// ======================================================
// CMK Bundle Sync — Auto-Backup aller CMKs nach R2 (RECOVERY.md §13)
// ======================================================
// Wird gerufen wenn eine CMK angelegt oder importiert wurde.
// Sammelt alle lokalen CMKs aus IDB, packt sie ins Bundle-Format,
// verschlüsselt mit cached masterKey, schreibt nach R2.
//
// Pre-Condition:
//   - masterKey muss gecached sein (loadCachedMasterKey() != null)
//   - Sonst silent skip — User muss erst Recovery-Onboarding/Verify durchlaufen.
//
// Race-Schutz:
//   - Debounce 5s (mehrere CMK-Imports im Burst → 1 Push)
//   - Single-flight: parallel-Aufrufe warten auf laufenden Sync
// ======================================================

import { idbGet, idbListKeys } from './idb.js';
import { bytesToB64, b64ToBytes } from './bytes.js';
import {
  loadCachedMasterKey, masterKeyBytesToCryptoKey,
} from './masterKey.js';
import { encryptBundle, decryptBundle, putBundle, getBundle } from './recovery.js';
import { importAndStoreCMKFromPeer } from './cmk.js';
import { captureException } from './sentry.js';

const SYNC_DEBOUNCE_MS = 5000;

let _debounceTimer = null;
let _syncInFlight = null;

function getMyHandle() {
  if (typeof localStorage === 'undefined') return '';
  return (localStorage.getItem('my_user') || '').toLowerCase();
}

/**
 * Liest device_secret + entwickelt den Storage-Key, mit dem CMKs in IDB
 * verschlüsselt gespeichert sind. (Spiegelt cmk.js getDeviceStorageKey.)
 */
async function deviceStorageKey() {
  const secretB64 = await idbGet('device_secret');
  if (!secretB64) return null;
  const baseKey = await crypto.subtle.importKey(
    'raw', b64ToBytes(secretB64), { name: 'HKDF' }, false, ['deriveKey']
  );
  const handle = getMyHandle();
  const info = handle
    ? new TextEncoder().encode(`renex:storage:${handle}`)
    : new TextEncoder().encode('renex:storage:global');
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Liest alle CMKs für den aktuellen User aus IDB.
 * Returnt Map<peerHandle, base64-CMK-Bytes>.
 */
async function collectLocalCmks() {
  const me = getMyHandle();
  if (!me) return {};
  const prefix = `cmk:${me}:`;
  const keys = await idbListKeys(prefix);
  if (keys.length === 0) return {};

  const dsKey = await deviceStorageKey();
  if (!dsKey) return {};

  const out = {};
  for (const k of keys) {
    const peer = k.slice(prefix.length);
    if (!peer) continue;
    const wrapped = await idbGet(k);
    if (!wrapped || !wrapped.ivB64 || !wrapped.ctB64) continue;
    try {
      const iv = b64ToBytes(wrapped.ivB64);
      const ct = b64ToBytes(wrapped.ctB64);
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv }, dsKey, ct.buffer
      );
      const cmkBytes = new Uint8Array(pt);
      if (cmkBytes.length !== 32) continue;
      out[peer] = bytesToB64(cmkBytes);
    } catch {}
  }
  return out;
}

/**
 * Schreibt das aktuelle Bundle (alle lokalen CMKs) nach R2.
 * No-op wenn masterKey nicht gecached.
 */
async function _doSync() {
  try {
    const masterKeyBytes = await loadCachedMasterKey();
    if (!masterKeyBytes) return { ok: false, reason: 'no_master_key' };

    const cmks = await collectLocalCmks();
    const bundle = {
      v: 1,
      ts: Date.now(),
      cmks,
      gsks: {},  // GSKs Phase 1C
    };

    const masterKey = await masterKeyBytesToCryptoKey(masterKeyBytes);
    const blob = await encryptBundle(bundle, masterKey);
    const r = await putBundle(blob);
    if (r.ok) {
      const count = Object.keys(cmks).length;
      console.log(`☁️ Bundle synced (${count} CMK${count === 1 ? '' : 's'})`);
    }
    return r;
  } catch (e) {
    captureException(e, { context: 'cmkBundleSync' });
    return { ok: false, reason: 'exception' };
  }
}

/**
 * Schedule-API: debounced single-flight sync.
 * Mehrere Aufrufe innerhalb SYNC_DEBOUNCE_MS → 1 Push.
 */
export function scheduleBundleSync() {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    if (!_syncInFlight) {
      _syncInFlight = _doSync().finally(() => { _syncInFlight = null; });
    }
  }, SYNC_DEBOUNCE_MS);
}

/**
 * Sofortiger Sync (für Tests / explizite Trigger). Wartet auf laufenden Sync.
 */
export async function syncBundleNow() {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  if (_syncInFlight) return _syncInFlight;
  _syncInFlight = _doSync().finally(() => { _syncInFlight = null; });
  return _syncInFlight;
}

// ======================================================
// Bundle → IDB Restore
// ======================================================

/**
 * Importiert CMKs aus einem decrypted Bundle in den lokalen IDB-Cache.
 * Bestehende CMKs werden NICHT überschrieben (würde Divergenzen erzeugen).
 *
 * @param {object} bundle - { v, ts, cmks: {peer: cmkB64}, gsks }
 * @returns {Promise<{imported: number, skipped: number}>}
 */
export async function restoreCmksFromBundle(bundle) {
  if (!bundle || bundle.v !== 1 || !bundle.cmks) {
    return { imported: 0, skipped: 0 };
  }
  let imported = 0;
  let skipped = 0;

  // getCMKIfExists dynamisch laden — verhindert circular import beim Modul-Eval
  const { getCMKIfExists } = await import('./cmk.js');

  for (const [peer, cmkB64] of Object.entries(bundle.cmks)) {
    try {
      const existing = await getCMKIfExists(peer);
      if (existing) { skipped++; continue; }
      const cmkBytes = b64ToBytes(cmkB64);
      if (cmkBytes.length !== 32) { skipped++; continue; }
      await importAndStoreCMKFromPeer(peer, cmkBytes);
      imported++;
    } catch (e) {
      skipped++;
      captureException(e, { context: 'restoreCmksFromBundle', peer });
    }
  }
  console.log(`📥 Bundle-Restore: ${imported} CMKs importiert, ${skipped} übersprungen`);
  return { imported, skipped };
}

/**
 * Boot-Hook: wenn cached masterKey vorhanden + Bundle in R2 existiert,
 * pull Bundle, decrypt, restore lokal fehlende CMKs.
 *
 * Wird beim App-Start aufgerufen (App.svelte _bootstrapApp).
 * Silent skip wenn nichts zu tun ist (no master key cached).
 */
export async function bootstrapBundleRestore() {
  try {
    const masterKeyBytes = await loadCachedMasterKey();
    if (!masterKeyBytes) return { ok: false, reason: 'no_master_key' };

    const data = await getBundle();
    if (!data || !data.blob) return { ok: false, reason: 'no_bundle' };

    const masterKey = await masterKeyBytesToCryptoKey(masterKeyBytes);
    let bundle;
    try {
      bundle = await decryptBundle(data.blob, masterKey);
    } catch {
      // Cached masterKey passt nicht zum aktuellen Bundle — Salt/Phrase wechselte.
      // Cache ist tot, User muss Recovery erneut durchgehen.
      return { ok: false, reason: 'decrypt_failed' };
    }
    return restoreCmksFromBundle(bundle);
  } catch (e) {
    captureException(e, { context: 'bootstrapBundleRestore' });
    return { ok: false, reason: 'exception' };
  }
}
