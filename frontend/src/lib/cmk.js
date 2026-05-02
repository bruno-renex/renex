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
