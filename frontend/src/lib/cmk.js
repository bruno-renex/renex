// ======================================================
// CMK — Conversation Master Key Storage + Distribution
// ======================================================
// Port aus renex-legacy/js/e2e.js (Lines 80-360).
//
// Verantwortlichkeiten:
//   - Device-Storage-Key: HKDF aus device_secret + userHandle
//     → AES-GCM-Key zum lokalen CMK-Verschlüsseln in IndexedDB
//   - CMK-Persistenz: getOrCreateCMK, getCMKIfExists, importAndStoreCMKFromPeer
//   - Peer-Device-Cache: storePeerDevices, loadPeerDevicesIdb
//   - CMK-Wrap-for-Inbox: ECDH(myPriv × peerPub) → AES-GCM → encrypt CMK
//
// Spec: docs/MULTI_DEVICE.md §4.4 (CMK-Distribution)
// ======================================================

import { idbGet, idbSet, idbDelete } from './idb.js';
import { bytesToB64, b64ToBytes } from './bytes.js';
import { loadPrivateKey, getDeviceId } from './e2eKeys.js';
import { CURRENT_WRAP_ALGO } from './wrapVersion.js';

// Lazy-Import um Circular zu vermeiden: cmkBundleSync importiert importAndStore-CMK.
async function _scheduleBundleSync() {
  try {
    const mod = await import('./cmkBundleSync.js');
    mod.scheduleBundleSync();
  } catch {}
}

const IDB_DEVICE_SECRET = 'device_secret';

// ======================================================
// Device-Storage-Key: HKDF(device_secret + userHandle + peerHandle) → AES-GCM-Key
// Lokaler Wrap-Key zum Schutz von CMK-IDB-Einträgen.
//
// IV-Lifetime / Birthday-Bound (L3, 2026-05-02):
// AES-GCM verwendet 96-bit IVs (random). Birthday-Kollisions-Risiko bei ~2^48
// Encryptions mit demselben Key. Pro CMK + DeviceStorageKey:
//   - CMK selbst: 1× encrypt pro create + 1× pro Migration ≈ konstant
//   - Bei aggressiver Rotation alle 5 Min für 100 Jahre: ~10^7 Encryptions
//   → praktisch unerreichbar bei realen Volumes.
// Falls in Phase 1C ein Auto-Rotate-Mechanismus eingeführt wird, sollte er
// nach 2^32 Encryptions pro Key prophylaktisch rotieren.
// ======================================================

async function getDeviceSecretB64() {
  // 1. Aus IDB laden
  let s = await idbGet(IDB_DEVICE_SECRET);
  if (s) return s;

  // 2. Migration: localStorage (Legacy)
  const legacy = typeof localStorage !== 'undefined'
    ? localStorage.getItem('device_secret')
    : null;
  if (legacy) {
    await idbSet(IDB_DEVICE_SECRET, legacy);
    return legacy;
  }

  // 3. Neu erzeugen (32 Bytes random → base64)
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  s = bytesToB64(bytes);
  await idbSet(IDB_DEVICE_SECRET, s);
  return s;
}

/**
 * Leitet einen Storage-Key aus device_secret ab.
 *
 * Scoping (L1, 2026-05-02): wenn peerHandle gegeben, ist der Key zusätzlich
 * an das User-Paar gebunden — jede CMK hat damit einen EIGENEN Storage-Key.
 * Vorteil: ein potentieller Key-Compromise eines Pairs leakt nicht alle anderen.
 *
 * Modi:
 *   - getDeviceStorageKey(me, peer)  → per-peer Key (current standard)
 *   - getDeviceStorageKey(me, null)  → per-user Key (legacy migration-only)
 *   - getDeviceStorageKey(null)      → globaler Key (älteste Legacy)
 *
 * @param {string|null} userHandle
 * @param {string|null} [peerHandle]
 */
async function getDeviceStorageKey(userHandle, peerHandle) {
  const secretB64 = await getDeviceSecretB64();
  const secretBytes = b64ToBytes(secretB64);

  const baseKey = await crypto.subtle.importKey(
    'raw', secretBytes,
    { name: 'HKDF' },
    false, ['deriveKey']
  );

  let infoStr;
  if (userHandle && peerHandle) {
    infoStr = `renex:storage:${userHandle.toLowerCase()}:${peerHandle.toLowerCase()}`;
  } else if (userHandle) {
    infoStr = `renex:storage:${userHandle.toLowerCase()}`;
  } else {
    infoStr = 'renex:storage:global';
  }
  const info = new TextEncoder().encode(infoStr);

  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ======================================================
// CMK Encrypt/Decrypt für IDB-Storage
// ======================================================

async function encryptForStorage(storageKey, plaintextBytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    storageKey,
    plaintextBytes
  );
  return {
    ivB64: bytesToB64(iv),
    ctB64: bytesToB64(new Uint8Array(ct)),
  };
}

async function decryptFromStorage(storageKey, ivB64, ctB64) {
  const iv = b64ToBytes(ivB64);
  const ctBytes = b64ToBytes(ctB64);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    storageKey,
    ctBytes.buffer
  );
  return new Uint8Array(pt);
}

// ======================================================
// CMK-IDB-Keys: scoped pro User-Pair
// ======================================================

function getMyHandle() {
  if (typeof localStorage === 'undefined') return '';
  return (localStorage.getItem('my_user') || '').toLowerCase();
}

/**
 * Re-encryptet ein gespeichertes CMK-Blob für eine neue Identität.
 *
 * Background: Der Storage-Key ist HKDF-derived aus `renex:storage:<me>:<peer>`.
 * Beim Guest-Convert wechselt `me` (Self-Seite) bzw. `peer` (Inviter-Seite),
 * also auch der Storage-Key. Ein reines Umbenennen des IDB-Keys ohne
 * Re-Encryption führt zu CMK_DECRYPT_FAILED.
 *
 * Probiert mehrere alte Storage-Keys (per-pair, per-user, global) — defensiv
 * gegen Legacy-Storage-Layer. Returnt `null` wenn keiner passt.
 *
 * @param {{ivB64: string, ctB64: string}} blob
 * @param {string} oldMe
 * @param {string} oldPeer
 * @param {string} newMe
 * @param {string} newPeer
 * @returns {Promise<{ivB64: string, ctB64: string}|null>}
 */
export async function reEncryptCmkBlobForRename(blob, oldMe, oldPeer, newMe, newPeer) {
  if (!blob || !blob.ivB64 || !blob.ctB64) return null;

  const oldPerPair = await getDeviceStorageKey(oldMe, oldPeer);
  const oldPerUser = await getDeviceStorageKey(oldMe);
  const oldGlobal  = await getDeviceStorageKey(null);
  const newPerPair = await getDeviceStorageKey(newMe, newPeer);

  for (const sk of [oldPerPair, oldPerUser, oldGlobal]) {
    try {
      const cmkBytes = await decryptFromStorage(sk, blob.ivB64, blob.ctB64);
      if (cmkBytes instanceof Uint8Array && cmkBytes.length === 32) {
        return await encryptForStorage(newPerPair, cmkBytes);
      }
    } catch {}
  }
  return null;
}

function cmkIdbKey(peerHandle) {
  const me = getMyHandle();
  const peer = String(peerHandle || '').toLowerCase();
  if (!me || !peer) {
    throw new Error('CMK: user oder peer fehlt');
  }
  return `cmk:${me}:${peer}`;
}

// ======================================================
// Public: CMK-Operationen
// ======================================================

/**
 * Holt einen existierenden CMK oder erzeugt einen neuen (32 Bytes random).
 * Migration-Pfad für alten globalen Storage-Key bleibt erhalten.
 *
 * @param {string} peerHandle
 * @returns {Promise<Uint8Array>} 32 Bytes
 */
export async function getOrCreateCMK(peerHandle) {
  const me = getMyHandle();
  const key = cmkIdbKey(peerHandle);

  // L1 (2026-05-02): per-peer Storage-Key. Vorherige Versionen nutzten
  // per-user (alle Peers gleicher Key) bzw. global. Migration: alle drei
  // Schichten durchprobieren, bei Erfolg auf neuen Key re-encrypten.
  const newKey  = await getDeviceStorageKey(me, peerHandle);  // per-peer
  const userKey = await getDeviceStorageKey(me);              // legacy per-user
  const globalKey = await getDeviceStorageKey(null);          // legacy global

  const saved = await idbGet(key);
  if (saved && saved.ivB64 && saved.ctB64) {
    // 1. Per-peer Key (current)
    try {
      const cmkBytes = await decryptFromStorage(newKey, saved.ivB64, saved.ctB64);
      if (cmkBytes instanceof Uint8Array && cmkBytes.length === 32) return cmkBytes;
    } catch {}

    // 2. Legacy per-user Key → migrate zu per-peer
    try {
      const cmkBytes = await decryptFromStorage(userKey, saved.ivB64, saved.ctB64);
      if (cmkBytes instanceof Uint8Array && cmkBytes.length === 32) {
        const enc = await encryptForStorage(newKey, cmkBytes);
        await idbSet(key, enc);
        return cmkBytes;
      }
    } catch {}

    // 3. Legacy global Key → migrate zu per-peer
    try {
      const cmkBytes = await decryptFromStorage(globalKey, saved.ivB64, saved.ctB64);
      if (cmkBytes instanceof Uint8Array && cmkBytes.length === 32) {
        const enc = await encryptForStorage(newKey, cmkBytes);
        await idbSet(key, enc);
        return cmkBytes;
      }
    } catch {}

    // KEINE Neuerzeugung — sonst wären alle alten Chats tot
    throw new Error('CMK_DECRYPT_FAILED');
  }

  // Wirklich keiner vorhanden → neu erzeugen mit per-peer Key
  const cmk = crypto.getRandomValues(new Uint8Array(32));
  const enc = await encryptForStorage(newKey, cmk);
  await idbSet(key, enc);
  return cmk;
}

/**
 * Holt einen CMK falls vorhanden, sonst null.
 * Migration-Pfad: alte CMK-Keys ohne `me`-Prefix werden umgezogen.
 */
export async function getCMKIfExists(peerHandle) {
  const me = getMyHandle();
  const idbKey = cmkIdbKey(peerHandle);
  const oldIdbKey = `cmk:${String(peerHandle).toLowerCase()}`;

  // L1 (2026-05-02): per-peer Storage-Key. Mehrere Migrations-Layer:
  const newSk    = await getDeviceStorageKey(me, peerHandle);  // per-peer (current)
  const userSk   = await getDeviceStorageKey(me);              // legacy per-user
  const globalSk = await getDeviceStorageKey(null);            // legacy global

  let saved = await idbGet(idbKey);

  // IDB-Key-Migration vom alten "cmk:<peer>"-Key (ohne me-prefix)
  if (!saved) {
    const legacy = await idbGet(oldIdbKey);
    if (legacy && legacy.ivB64 && legacy.ctB64) {
      await idbSet(idbKey, legacy);
      await idbDelete(oldIdbKey);
      saved = legacy;
    }
  }

  if (!saved || !saved.ivB64 || !saved.ctB64) return null;

  // 1. Per-peer Key (current)
  try {
    const cmkBytes = await decryptFromStorage(newSk, saved.ivB64, saved.ctB64);
    if (cmkBytes instanceof Uint8Array && cmkBytes.length === 32) return cmkBytes;
  } catch {}

  // 2. Legacy per-user Key → migrate zu per-peer
  try {
    const cmkBytes = await decryptFromStorage(userSk, saved.ivB64, saved.ctB64);
    if (cmkBytes instanceof Uint8Array && cmkBytes.length === 32) {
      const enc = await encryptForStorage(newSk, cmkBytes);
      await idbSet(idbKey, enc);
      return cmkBytes;
    }
  } catch {}

  // 3. Legacy global Key → migrate zu per-peer
  try {
    const cmkBytes = await decryptFromStorage(globalSk, saved.ivB64, saved.ctB64);
    if (cmkBytes instanceof Uint8Array && cmkBytes.length === 32) {
      const enc = await encryptForStorage(newSk, cmkBytes);
      await idbSet(idbKey, enc);
      return cmkBytes;
    }
  } catch {}

  return null;
}

/**
 * Importiert einen CMK von einem Peer (z.B. nach cmk_req-Flow).
 * Validiert: muss 32 Bytes sein.
 */
export async function importAndStoreCMKFromPeer(peerHandle, cmkBytes) {
  if (!(cmkBytes instanceof Uint8Array) || cmkBytes.length !== 32) {
    throw new Error('CMK ungültig (muss 32 Bytes sein)');
  }
  const me = getMyHandle();
  const key = cmkIdbKey(peerHandle);
  // L1: per-peer Storage-Key
  const storageKey = await getDeviceStorageKey(me, peerHandle);
  const enc = await encryptForStorage(storageKey, cmkBytes);
  await idbSet(key, enc);
  void _scheduleBundleSync();
}

/**
 * Erstellt einen NEUEN CMK + speichert ihn (für Rotation).
 */
export async function createAndStoreCMK(peerHandle) {
  const newCmkBytes = crypto.getRandomValues(new Uint8Array(32));
  await importAndStoreCMKFromPeer(peerHandle, newCmkBytes);
  return newCmkBytes;
}

/**
 * Löscht einen CMK (für Reset/Debug).
 */
export async function deleteCMK(peerHandle) {
  await idbDelete(cmkIdbKey(peerHandle));
}

// ======================================================
// DM Encrypt-Counter (Auto-Rotate-Threshold)
// ------------------------------------------------------
// Pro CMK ein monoton wachsender Counter, der bei jedem
// E2E-Encrypt im DM-Pfad inkrementiert wird. Wenn er den
// Threshold erreicht, soll ein Caller eine prophylaktische
// CMK-Rotation triggern.
//
// Reset auf 0 nach erfolgreicher Rotation (am Ende von
// rotateCMKForPeer) — der neue CMK beginnt frisch.
//
// IDB-Key: `cmk-counter:<peer-lowercase>`. Per-User-Skoping
// nicht nötig, weil der Browser-Tab eh per User-Login isoliert
// ist (sessionStore.check) und CMKs ebenfalls.
// ======================================================
const CMK_COUNTER_PREFIX = 'cmk-counter:';

function _cmkCounterKey(peerHandle) {
  return `${CMK_COUNTER_PREFIX}${String(peerHandle || '').toLowerCase()}`;
}

/**
 * Inkrementiert den Encrypt-Counter für die DM-CMK eines Peers
 * und gibt den neuen Wert zurück. Caller (z.B. sendEncryptedDm)
 * vergleicht mit ENCRYPT_ROTATE_THRESHOLD aus groupCrypto.js und
 * triggert ggf. rotateCMKForPeer.
 *
 * @param {string} peerHandle
 * @returns {Promise<number>} neuer Counter-Wert (>= 1)
 */
export async function incrementCmkEncryptCounter(peerHandle) {
  if (!peerHandle) return 0;
  const k = _cmkCounterKey(peerHandle);
  const current = (await idbGet(k)) ?? 0;
  const next = (typeof current === 'number' && current >= 0 ? current : 0) + 1;
  await idbSet(k, next);
  return next;
}

/** Liest den aktuellen Counter ohne Increment (Tests/Debug). */
export async function peekCmkEncryptCounter(peerHandle) {
  if (!peerHandle) return 0;
  return (await idbGet(_cmkCounterKey(peerHandle))) ?? 0;
}

/** Setzt den Counter auf 0 (nach Rotation). */
export async function resetCmkEncryptCounter(peerHandle) {
  if (!peerHandle) return;
  await idbSet(_cmkCounterKey(peerHandle), 0);
}

/**
 * Rotiert das CMK für eine DM (Forward Secrecy bei Device-Compromise).
 *
 * Trigger: User-Revoke eines eigenen Devices mit `reason='user'` — das geleakte
 * Device hatte das alte CMK lokal. Neue Messages müssen mit neuem CMK encrypted
 * werden, alte müssen weiterhin lesbar bleiben.
 *
 * Ablauf:
 *   1. Old CMK in rotation map archivieren (Decrypt von alten Messages)
 *   2. Neuen CMK random generieren
 *   3. Active CMK = neu (cmk:me:peer überschrieben)
 *   4. Neuen Eintrag in map mit fromIndex = max(server-known, local-max) + 1
 *
 * Bei `reason='self'`/`'auto'` NICHT rufen — Memory-Spec §4.4: Forward Secrecy
 * nur bei echtem Security-Event, sonst Cron-Storm.
 *
 * @param {string} myHandle
 * @param {string} peerHandle
 * @returns {Promise<{ok: boolean, newCmk?: Uint8Array, newFromIndex?: number, reason?: string}>}
 */
export async function rotateCMKForPeer(myHandle, peerHandle) {
  // Lazy-Imports um circular dep mit session.js zu vermeiden
  const { dmSessionId, getRotationMap, appendToRotationMap } = await import('./session.js');
  const { apiFetch } = await import('./api.js');

  // 1. Aktuellen CMK laden — muss existieren, sonst keine Rotation sinnvoll
  const oldCmk = await getCMKIfExists(peerHandle);
  if (!oldCmk) {
    return { ok: false, reason: 'no_local_cmk' };
  }

  const sid = dmSessionId(myHandle, peerHandle);

  // 2. Old CMK archivieren wenn map leer (initial archival mit fromIndex=0)
  let map = await getRotationMap(sid);
  if (map.length === 0) {
    await appendToRotationMap(sid, 0, oldCmk);
    map = await getRotationMap(sid);  // re-load to include new entry
  }

  // 3. Server-known max rotation_index — für Sync zwischen Multi-Device
  let serverMaxIdx = 0;
  try {
    const r = await apiFetch(`/chat/rotation-index?peer=${encodeURIComponent(peerHandle)}`);
    if (r.ok && typeof r.data?.rotationIndex === 'number') {
      serverMaxIdx = r.data.rotationIndex;
    }
  } catch {}

  const localMaxIdx = map.reduce((max, e) => Math.max(max, e.fromIndex), 0);
  const newFromIndex = Math.max(serverMaxIdx, localMaxIdx) + 1;

  // 4. Neuen CMK generieren (kryptographisch random)
  const newCmk = crypto.getRandomValues(new Uint8Array(32));

  // 5. Neuen Eintrag in map (für Decrypt von messages mit rotation_index >= newFromIndex)
  await appendToRotationMap(sid, newFromIndex, newCmk);

  // 6. Active CMK ersetzen (importAndStoreCMKFromPeer triggert auch bundle-sync)
  await importAndStoreCMKFromPeer(peerHandle, newCmk);

  // 7. Encrypt-Counter reset — neuer CMK beginnt frisch (Auto-Rotate-Reset)
  await resetCmkEncryptCounter(peerHandle);

  console.log(`🔁 CMK rotiert für ${peerHandle}: fromIndex=${newFromIndex}`);
  return { ok: true, newCmk, newFromIndex };
}

// ======================================================
// Peer-Device-Cache
// ======================================================

/**
 * Speichert die bekannte Device-Liste eines Peers (jwk + sigPub pro Device).
 */
export async function storePeerDevices(peerHandle, devices) {
  await idbSet(`peer-devices:${peerHandle.toLowerCase()}`, devices);
}

/**
 * Lädt die bekannte Device-Liste eines Peers.
 */
export async function loadPeerDevicesIdb(peerHandle) {
  return await idbGet(`peer-devices:${peerHandle.toLowerCase()}`) || [];
}

/**
 * Findet den JWK eines bestimmten Peer-Devices (für CMK-Decrypt).
 */
export async function findSenderDeviceJwk(from, fromDeviceId) {
  const devices = await loadPeerDevicesIdb(from);
  const d = devices.find(x => x.deviceId === fromDeviceId);
  return d?.jwk || null;
}

/**
 * Findet den Sig-Pubkey eines Peer-Devices (für Sig-Verify).
 */
export async function getSigPubForDevice(fromHandle, fromDeviceId) {
  const devices = await loadPeerDevicesIdb(fromHandle);
  const d = devices.find(x => x.deviceId === fromDeviceId);
  return d?.sigPub || null;
}

/**
 * Findet die historischen Sig-Pubkeys eines Peer-Devices (nach Device-Key-Rotation).
 * Fallback für Sig-Verify alter Messages: wenn Verify mit dem aktuellen Pubkey
 * fehlschlägt, kann der Caller durch die Historie iterieren.
 *
 * @returns {Promise<Array<{jwk: object, retiredAt: number}>>}
 */
export async function getSigPubHistoryForDevice(fromHandle, fromDeviceId) {
  const devices = await loadPeerDevicesIdb(fromHandle);
  const d = devices.find(x => x.deviceId === fromDeviceId);
  const hist = d?.sigPubHistory;
  return Array.isArray(hist) ? hist : [];
}

// ======================================================
// CMK-Wrap-for-Inbox-Devices
// ECDH(myPriv × peerPub) → AES-GCM → encrypt CMK
// Spec: MULTI_DEVICE.md §4.4 (Add-Device + DM-Initialisierung)
// ======================================================

/**
 * Verschlüsselt einen CMK für jedes Device einer Device-Liste.
 * @param {Array<{deviceId: string, jwk: object}>} devices - Peer-Device-Pubkeys
 * @param {Uint8Array} cmkBytes - 32-Byte CMK
 * @returns {Promise<Array<{deviceId, fromDeviceId, ivB64, ctB64}>>}
 */
export async function wrapCMKForInboxDevices(devices, cmkBytes) {
  const myPriv = await loadPrivateKey();
  if (!myPriv) throw new Error('No private key — initE2EKeys first');

  // getDeviceId() ist jetzt per-User-skoped (Bug 13 Fix)
  const fromDeviceId = getDeviceId();
  if (!fromDeviceId) throw new Error('No device_id');

  const payloads = [];

  for (const d of devices) {
    if (!d || !d.jwk || !d.deviceId) continue;

    const peerPub = await crypto.subtle.importKey(
      'jwk', d.jwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      false, []
    );

    const aesKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: peerPub },
      myPriv,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    );

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      cmkBytes
    );

    payloads.push({
      // algoVersion (Phase 0.2): kennzeichnet das Wrap-Verfahren. Additiv —
      // Legacy-Reader ignorieren es, neue lesen tolerant (wrapAlgoOf).
      algoVersion: CURRENT_WRAP_ALGO,
      deviceId: d.deviceId,
      fromDeviceId,
      ivB64: bytesToB64(iv),
      ctB64: bytesToB64(new Uint8Array(ct)),
    });
  }

  return payloads;
}

/**
 * Inverse Operation: entschlüsselt einen für mich gewrappten CMK.
 * @param {string} ivB64
 * @param {string} ctB64
 * @param {object} senderPubJwk - der ECDH-Pubkey des Senders (aus Peer-Cache)
 * @returns {Promise<Uint8Array>} 32-Byte CMK
 */
export async function unwrapCMKFromPeer(ivB64, ctB64, senderPubJwk) {
  const myPriv = await loadPrivateKey();
  if (!myPriv) throw new Error('No private key — initE2EKeys first');

  const senderPub = await crypto.subtle.importKey(
    'jwk', senderPubJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false, []
  );

  const aesKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: senderPub },
    myPriv,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const iv = b64ToBytes(ivB64);
  const ct = b64ToBytes(ctB64);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    ct.buffer
  );

  const cmkBytes = new Uint8Array(pt);
  if (cmkBytes.length !== 32) throw new Error('CMK invalid length');
  return cmkBytes;
}
