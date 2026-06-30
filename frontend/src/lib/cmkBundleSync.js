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
    // GSKs sammeln — eigene Sender-Group-Keys. Ohne diesen Pfad würden alle
    // eigenen Group-Sends nach Phrase-Recovery in der eigenen History
    // unleserlich (kein Sender-Key zum Re-Decrypt der eigenen Messages).
    const { collectMyGSKs } = await import('./groupCrypto.js');
    const gsks = await collectMyGSKs();
    const bundle = {
      ts: Date.now(),
      cmks,
      rotationMaps,  // Pre-Rotation-CMKs für Decrypt von alten Messages nach Recovery
      gsks,          // Eigene Sender-GSKs für Group-History nach Recovery
    };

    const masterKey = await masterKeyBytesToCryptoKey(masterKeyBytes);
    // L2: handle als AAD-Binding — auto-sync upgraded Legacy v=1 → v=2 mit AAD
    const handle = getMyHandle();
    const blob = await encryptBundle(bundle, masterKey, handle);
    const r = await putBundle(blob);
    if (r.ok) {
      const count = Object.keys(cmks).length;
      const rotCount = Object.keys(rotationMaps).length;
      const gskCount = Object.keys(gsks).length;
      const rotSuffix = rotCount > 0 ? `, ${rotCount} rotation-map${rotCount === 1 ? '' : 's'}` : '';
      const gskSuffix = gskCount > 0 ? `, ${gskCount} GSK${gskCount === 1 ? '' : 's'}` : '';
      console.log(`☁️ Bundle synced (${count} CMK${count === 1 ? '' : 's'}${rotSuffix}${gskSuffix})`);
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
  // FORWARD-TOLERANT: decryptBundle hat die Authentizität bereits via AES-GCM+AAD
  // geprüft (GCM-Tag). KEIN Versions-Whitelist mehr — der frühere `v!==1 && v!==2`-
  // Check verwarf jede künftige Version STILL und hat 2026 bereits einmal live alle
  // CMKs beim Recovery vernichtet (Vorher: nur v=1 → v=2-Bundles ignoriert). Wir
  // importieren die Felder, die wir verstehen (cmks/rotationMaps/gsks), und ignorieren
  // unbekannte höhere Versionen. Forward-Compat-Vertrag: siehe recovery.js.
  if (!bundle || typeof bundle !== 'object' || !bundle.cmks) {
    return { imported: 0, skipped: 0 };
  }
  let imported = 0;
  let skipped = 0;
  // Per-Reason-Counter für Diagnose von Multi-Device-Bundle-Restore-Differenzen
  // (siehe Vorfall 2026-05-15: iPhone bekam 1/6 Maps, Mac 6/6 — Grund ohne
  // diese Diagnose unklar).
  const cmkSkipReasons = { already_in_idb: 0, wrong_length: 0, exception: 0 };

  // getCMKIfExists dynamisch laden — verhindert circular import beim Modul-Eval
  const { getCMKIfExists } = await import('./cmk.js');

  for (const [peer, cmkB64] of Object.entries(bundle.cmks)) {
    try {
      const existing = await getCMKIfExists(peer);
      if (existing) { skipped++; cmkSkipReasons.already_in_idb++; continue; }
      const cmkBytes = b64ToBytes(cmkB64);
      if (cmkBytes.length !== 32) { skipped++; cmkSkipReasons.wrong_length++; continue; }
      await importAndStoreCMKFromPeer(peer, cmkBytes);
      imported++;
    } catch (e) {
      skipped++;
      cmkSkipReasons.exception++;
      captureException(e, { context: 'restoreCmksFromBundle', peer });
    }
  }

  // Rotation-Maps zurückschreiben — ohne sie wären Pre-Rotation-Messages nach
  // komplettem Storage-Verlust nicht mehr decryptbar (current CMK ist neu, alte
  // CMKs sind nur in der Map archiviert).
  // Bestehende Maps werden ÜBERSCHRIEBEN — der Bundle ist die Source-of-Truth
  // bei Recovery; lokale Maps wären nach komplettem IDB-Reset eh leer.
  let rotImported = 0;
  let rotSkipped = 0;
  const rotSkipReasons = {
    not_array_or_empty: 0,
    all_entries_invalid: 0,
    exception: 0,
  };
  const rotEntrySkips = { invalid_fields: 0, wrong_length: 0 };
  const bundleRotCount = bundle.rotationMaps && typeof bundle.rotationMaps === 'object'
    ? Object.keys(bundle.rotationMaps).length
    : 0;
  if (bundleRotCount > 0) {
    for (const [sid, entries] of Object.entries(bundle.rotationMaps)) {
      try {
        if (!Array.isArray(entries) || entries.length === 0) {
          rotSkipped++;
          rotSkipReasons.not_array_or_empty++;
          const what = Array.isArray(entries) ? 'empty-array' : `not-array(${typeof entries})`;
          console.warn(`📥 Bundle-Restore SKIP rotation-map sid=${sid}: not_array_or_empty (${what})`);
          continue;
        }
        const decoded = [];
        let entryInvalidFields = 0;
        let entryWrongLength = 0;
        for (const e of entries) {
          if (!e || typeof e.fromIndex !== 'number' || typeof e.cmk !== 'string') {
            entryInvalidFields++;
            continue;
          }
          const cmkBytes = b64ToBytes(e.cmk);
          if (cmkBytes.length !== 32) {
            entryWrongLength++;
            continue;
          }
          // appendToRotationMap-Format: cmkBytes als plain Array (JSON-friendly)
          decoded.push({ fromIndex: e.fromIndex, cmkBytes: Array.from(cmkBytes) });
        }
        rotEntrySkips.invalid_fields += entryInvalidFields;
        rotEntrySkips.wrong_length += entryWrongLength;
        if (decoded.length === 0) {
          rotSkipped++;
          rotSkipReasons.all_entries_invalid++;
          console.warn(`📥 Bundle-Restore SKIP rotation-map sid=${sid}: all_entries_invalid (in=${entries.length}, invalid_fields=${entryInvalidFields}, wrong_length=${entryWrongLength})`);
          continue;
        }
        await idbSet(`${ROTATION_MAP_PREFIX}${sid}`, decoded);
        rotImported++;
        if (entryInvalidFields > 0 || entryWrongLength > 0) {
          console.warn(`📥 Bundle-Restore PARTIAL rotation-map sid=${sid}: kept=${decoded.length}/${entries.length} (invalid_fields=${entryInvalidFields}, wrong_length=${entryWrongLength})`);
        }
      } catch (e) {
        rotSkipped++;
        rotSkipReasons.exception++;
        console.warn(`📥 Bundle-Restore SKIP rotation-map sid=${sid}: exception (${e?.name || e?.message || 'unknown'})`);
        captureException(e, { context: 'restoreRotationMaps', sid });
      }
    }
  }

  // GSKs zurückschreiben — eigene Sender-Group-Keys für die Decrypt-Pipeline
  // der eigenen Group-History nach Phrase-Recovery. Existierende werden NICHT
  // überschrieben (würde Divergenzen mit aktiven Group-Sessions erzeugen).
  let gskImported = 0;
  let gskSkipped = 0;
  if (bundle.gsks && typeof bundle.gsks === 'object') {
    try {
      const { restoreMyGSKsFromBundle } = await import('./groupCrypto.js');
      const r = await restoreMyGSKsFromBundle(bundle.gsks);
      gskImported = r.imported;
      gskSkipped = r.skipped;
    } catch (e) {
      captureException(e, { context: 'restoreMyGSKs' });
    }
  }

  const rotSuffix = rotImported > 0 ? `, ${rotImported} rotation-map${rotImported === 1 ? '' : 's'} restored` : '';
  const gskSuffix = gskImported > 0 ? `, ${gskImported} GSK${gskImported === 1 ? '' : 's'} restored` : '';
  console.log(`📥 Bundle-Restore: ${imported} CMKs importiert, ${skipped} übersprungen${rotSuffix}${gskSuffix}`);

  // Diagnostic-Breakdown — nur loggen wenn was Schiefging, sonst Noise.
  if (skipped > 0) {
    const cmkBreakdown = Object.entries(cmkSkipReasons)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`).join(', ');
    if (cmkBreakdown) console.log(`📥 Bundle-Restore CMK-Skips: ${cmkBreakdown}`);
  }
  // Rotation-Map-Diagnose: zeige Total-im-Bundle vs restored, plus Skip-Gründe
  // und Per-Entry-Verluste (wichtig für Multi-Device-Vergleich zwischen Geräten,
  // die dasselbe Bundle laden).
  if (bundleRotCount > 0 && (rotSkipped > 0 || rotEntrySkips.invalid_fields > 0 || rotEntrySkips.wrong_length > 0)) {
    const mapBreakdown = Object.entries(rotSkipReasons)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`).join(', ');
    const entryDetail = (rotEntrySkips.invalid_fields + rotEntrySkips.wrong_length) > 0
      ? `; entries-dropped: invalid_fields=${rotEntrySkips.invalid_fields}, wrong_length=${rotEntrySkips.wrong_length}`
      : '';
    console.log(`📥 Bundle-Restore RotationMap-Skips: ${rotImported}/${bundleRotCount} restored${mapBreakdown ? `, maps: ${mapBreakdown}` : ''}${entryDetail}`);
  }

  return {
    imported,
    skipped,
    cmkSkipReasons,
    rotationMapsImported: rotImported,
    rotationMapsSkipped: rotSkipped,
    rotationMapsInBundle: bundleRotCount,
    rotationMapSkipReasons: rotSkipReasons,
    rotationMapEntrySkips: rotEntrySkips,
    gsksImported: gskImported,
    gsksSkipped: gskSkipped,
  };
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
