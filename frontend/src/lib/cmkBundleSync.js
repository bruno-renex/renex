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

import { idbGet, idbSet, idbListKeys } from './idb.js';
import { bytesToB64, b64ToBytes } from './bytes.js';
import {
  loadCachedMasterKey, masterKeyBytesToCryptoKey,
} from './masterKey.js';
import { encryptBundle, decryptBundle, putBundle, getBundle } from './recovery.js';
import { importAndStoreCMKFromPeer, getCMKIfExists } from './cmk.js';
import { captureException } from './sentry.js';

const ROTATION_MAP_PREFIX = 'cmk:rotation-map:';

const SYNC_DEBOUNCE_MS = 5000;

let _debounceTimer = null;
let _syncInFlight = null;

function getMyHandle() {
  if (typeof localStorage === 'undefined') return '';
  return (localStorage.getItem('my_user') || '').toLowerCase();
}

/**
 * Liest alle CMKs für den aktuellen User aus IDB.
 * Returnt Map<peerHandle, base64-CMK-Bytes>.
 *
 * Delegiert das Decrypten an `getCMKIfExists` aus cmk.js — der kennt alle drei
 * Storage-Key-Layer (per-peer L1 / per-user / global) inkl. Auto-Migration.
 * Vorher hatte cmkBundleSync eine eigene per-user-only Implementation, die
 * NACH der L1-Härtung am 2026-05-02 alle CMKs als „nicht decryptbar" sah und
 * 0-Einträge-Bundles nach R2 schrieb (Daten-Verlust-Risiko bei Recovery).
 */
async function collectLocalCmks() {
  const me = getMyHandle();
  if (!me) return {};
  const prefix = `cmk:${me}:`;
  const keys = await idbListKeys(prefix);
  if (keys.length === 0) return {};

  const out = {};
  for (const k of keys) {
    const peer = k.slice(prefix.length);
    if (!peer) continue;
    // `cmk:rotation-map:*` matcht auch das `cmk:`-Prefix wenn me-Handle mit
    // 'rotation-map' kollidieren würde — defensiv ausschließen via direkter
    // Inklusion von ':' (rotation-map-keys haben ein zweites ':' nach 'map').
    // Bei normalen CMK-Keys ist `peer` ein nackter Handle ohne ':'.
    if (peer.includes(':')) continue;
    try {
      const cmkBytes = await getCMKIfExists(peer);
      if (cmkBytes instanceof Uint8Array && cmkBytes.length === 32) {
        out[peer] = bytesToB64(cmkBytes);
      }
    } catch {}
  }
  return out;
}

/**
 * Sammelt alle lokalen Rotation-Maps (`cmk:rotation-map:<sessionId>`) und
 * encoded sie für den Bundle-Sync. Format pro Session:
 *   sessionId → [{ fromIndex: number, cmk: base64 }, ...]
 *
 * Nötig für Recovery nach komplettem Storage-Verlust: ohne archivierte
 * historische CMKs könnten Pre-Rotation-Messages nicht mehr decryptet werden.
 */
async function collectLocalRotationMaps() {
  const keys = await idbListKeys(ROTATION_MAP_PREFIX);
  if (keys.length === 0) return {};
  const out = {};
  for (const k of keys) {
    const sid = k.slice(ROTATION_MAP_PREFIX.length);
    if (!sid) continue;
    try {
      const arr = await idbGet(k);
      if (!Array.isArray(arr) || arr.length === 0) continue;
      const encoded = [];
      for (const e of arr) {
        if (!e || typeof e.fromIndex !== 'number' || !Array.isArray(e.cmkBytes)) continue;
        if (e.cmkBytes.length !== 32) continue;
        encoded.push({
          fromIndex: e.fromIndex,
          cmk: bytesToB64(new Uint8Array(e.cmkBytes)),
        });
      }
      if (encoded.length > 0) out[sid] = encoded;
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
    const rotationMaps = await collectLocalRotationMaps();
    const bundle = {
      ts: Date.now(),
      cmks,
      rotationMaps,  // Pre-Rotation-CMKs für Decrypt von alten Messages nach Recovery
      gsks: {},      // GSKs Phase 1C
    };

    const masterKey = await masterKeyBytesToCryptoKey(masterKeyBytes);
    // L2: handle als AAD-Binding — auto-sync upgraded Legacy v=1 → v=2 mit AAD
    const handle = getMyHandle();
    const blob = await encryptBundle(bundle, masterKey, handle);
    const r = await putBundle(blob);
    if (r.ok) {
      const count = Object.keys(cmks).length;
      const rotCount = Object.keys(rotationMaps).length;
      const rotSuffix = rotCount > 0 ? `, ${rotCount} rotation-map${rotCount === 1 ? '' : 's'}` : '';
      console.log(`☁️ Bundle synced (${count} CMK${count === 1 ? '' : 's'}${rotSuffix})`);
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
  // v=1 (Legacy ohne AAD) und v=2 (current, mit handle-AAD) sind beide gültig.
  // decryptBundle hat die Authentizität bereits geprüft — Version-Check hier ist
  // nur Schema-Sanity. Vorher: nur v=1 → v=2-Bundles wurden ignoriert (alle
  // CMKs verloren beim Recovery).
  if (!bundle || (bundle.v !== 1 && bundle.v !== 2) || !bundle.cmks) {
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

  // Rotation-Maps zurückschreiben — ohne sie wären Pre-Rotation-Messages nach
  // komplettem Storage-Verlust nicht mehr decryptbar (current CMK ist neu, alte
  // CMKs sind nur in der Map archiviert).
  // Bestehende Maps werden ÜBERSCHRIEBEN — der Bundle ist die Source-of-Truth
  // bei Recovery; lokale Maps wären nach komplettem IDB-Reset eh leer.
  let rotImported = 0;
  if (bundle.rotationMaps && typeof bundle.rotationMaps === 'object') {
    for (const [sid, entries] of Object.entries(bundle.rotationMaps)) {
      try {
        if (!Array.isArray(entries) || entries.length === 0) continue;
        const decoded = [];
        for (const e of entries) {
          if (!e || typeof e.fromIndex !== 'number' || typeof e.cmk !== 'string') continue;
          const cmkBytes = b64ToBytes(e.cmk);
          if (cmkBytes.length !== 32) continue;
          // appendToRotationMap-Format: cmkBytes als plain Array (JSON-friendly)
          decoded.push({ fromIndex: e.fromIndex, cmkBytes: Array.from(cmkBytes) });
        }
        if (decoded.length > 0) {
          await idbSet(`${ROTATION_MAP_PREFIX}${sid}`, decoded);
          rotImported++;
        }
      } catch (e) {
        captureException(e, { context: 'restoreRotationMaps', sid });
      }
    }
  }

  const rotSuffix = rotImported > 0 ? `, ${rotImported} rotation-map${rotImported === 1 ? '' : 's'} restored` : '';
  console.log(`📥 Bundle-Restore: ${imported} CMKs importiert, ${skipped} übersprungen${rotSuffix}`);
  return { imported, skipped, rotationMapsImported: rotImported };
}

/**
 * Checkt ob ein Recovery-Prompt nötig ist beim Boot:
 * - User ist eingeloggt (Passkey-OK)
 * - KEIN cached masterKey (z.B. Inkognito, neuer Browser, nach Storage-Wipe)
 * - Bundle in R2 EXISTIERT (User hatte schon Chats / CMKs)
 *
 * Wenn alle drei: User hat Chat-History die ohne Phrase nicht decryptbar ist.
 * UI sollte einen non-blocking Toast/Banner zeigen mit Recovery-Trigger.
 *
 * @returns {Promise<boolean>}
 */
export async function checkRecoveryPromptNeeded() {
  try {
    const masterKeyBytes = await loadCachedMasterKey();
    if (masterKeyBytes) return false;  // Schlüssel ist da → kein Prompt nötig
    const data = await getBundle();
    return !!(data && data.blob);
  } catch {
    return false;
  }
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

    // Sync-Forcing-Hook: egal ob Bundle existiert/leer/decryptable ist —
    // wenn masterKey gecached ist, müssen wir am Ende des Boots sicherstellen,
    // dass das R2-Bundle die AKTUELLEN lokalen CMKs widerspiegelt.
    // Hintergrund: vor dem 2026-05-02 hat die Bundle-Sync-Funktion einen
    // anderen Storage-Key benutzt als cmk.js (L1-Härtungs-Bug) und schrieb
    // leere Bundles nach R2. Ohne diesen Force-Sync würden bestehende User
    // auch nach dem Fix nie ein gefülltes Bundle bekommen, weil Sync sonst
    // nur bei NEUEN CMK-Imports triggert. Schedule (debounced 5s) sammelt
    // Imports vom Bootstrap-Restore und Login-Flows in einem Push.
    const triggerSync = () => scheduleBundleSync();

    if (!data || !data.blob) {
      // Kein Bundle in R2 → trotzdem syncen damit wir eines anlegen.
      triggerSync();
      return { ok: false, reason: 'no_bundle' };
    }

    const masterKey = await masterKeyBytesToCryptoKey(masterKeyBytes);
    let bundle;
    try {
      // L2: handle als AAD — fällt automatisch auf v=1 (legacy) zurück.
      bundle = await decryptBundle(data.blob, masterKey, getMyHandle());
    } catch {
      // Cached masterKey passt nicht zum aktuellen Bundle — Salt/Phrase wechselte.
      // Cache ist tot, User muss Recovery erneut durchgehen.
      return { ok: false, reason: 'decrypt_failed' };
    }
    const result = await restoreCmksFromBundle(bundle);
    // Bundle gelesen — jetzt auch synced damit lokale CMKs (die ggf. NICHT im
    // Bundle waren, z.B. nach dem 0-CMK-Bug) hochgeladen werden.
    triggerSync();
    return result;
  } catch (e) {
    captureException(e, { context: 'bootstrapBundleRestore' });
    return { ok: false, reason: 'exception' };
  }
}
