// ======================================================
// Group-E2E — Sender-Keys / GSK (Phase 1C)
// ======================================================
// Sender-Keys-Pattern: jeder User hat pro Gruppe einen eigenen GSK
// (32-Byte AES-GCM-Key). Sends werden mit dem eigenen GSK encrypted; Recipients
// dechiffrieren mit dem GSK des Senders, den sie via `gsk` Control-Message
// (oder `/e2e/group-gsk/fetch` für eigene andere Devices) erhalten.
//
// Storage-Layout (IDB, identische Härtung wie CMK §4.4):
//   gsk:my:<me>:<groupId>          → encrypted-by-storageKey eigener GSK (32 B)
//   gsk:peer:<me>:<groupId>:<peer> → encrypted-by-storageKey Peer-GSK
//
// Distribution:
//   - Eigene andere Devices  : `/e2e/group-gsk/store` (KV, my-handle keyspace)
//   - Andere Members         : `chatSend({type:"gsk", convoId, payloads})`
//                              gewrappt per ECDH(myPriv × deviceJwk)
//
// Rotation-Trigger: device_added (self), member_joined, member_left,
// member_removed.
//
// Spec: docs/MULTI_DEVICE.md §1 (GSK-Definition), §13 (Phase 1C)
// ======================================================

import { idbGet, idbSet, idbDelete, idbListKeys } from './idb.js';
import { bytesToB64, b64ToBytes } from './bytes.js';
import { apiFetch } from './api.js';
import { captureException } from './sentry.js';
import { loadPrivateKey, getDeviceId, loadSigningPrivKey } from './e2eKeys.js';
import {
  storePeerDevices, loadPeerDevicesIdb, findSenderDeviceJwk,
  getSigPubForDevice,
} from './cmk.js';

// ======================================================
// Storage-Key-Härtung — analog cmk.js (per-Group-Scoping)
// device_secret + me + groupId → AES-GCM-Wrap-Key.
// Ein Compromise eines Groups leakt nicht alle anderen.
// ======================================================

const IDB_DEVICE_SECRET = 'device_secret';

async function _getDeviceSecretBytes() {
  const s = await idbGet(IDB_DEVICE_SECRET);
  if (!s) {
    // groupCrypto wird erst NACH e2eKeys-Init gerufen — Secret muss existieren.
    // Aber falls jemand lädt vor dem Init: random fallback (nur für diese Session).
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    await idbSet(IDB_DEVICE_SECRET, bytesToB64(bytes));
    return bytes;
  }
  return b64ToBytes(s);
}

async function _getGroupStorageKey(myHandle, groupId, scope) {
  const secret = await _getDeviceSecretBytes();
  const baseKey = await crypto.subtle.importKey(
    'raw', secret, { name: 'HKDF' }, false, ['deriveKey']
  );
  const info = new TextEncoder().encode(
    `renex:gsk-storage:${scope}:${String(myHandle).toLowerCase()}:${String(groupId).toLowerCase()}`
  );
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function _encryptForStorage(storageKey, plaintextBytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, storageKey, plaintextBytes
  );
  return { ivB64: bytesToB64(iv), ctB64: bytesToB64(new Uint8Array(ct)) };
}

async function _decryptFromStorage(storageKey, ivB64, ctB64) {
  const iv = b64ToBytes(ivB64);
  const ct = b64ToBytes(ctB64);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv }, storageKey, ct.buffer
  );
  return new Uint8Array(pt);
}

/**
 * Re-encryptet ein gespeichertes GSK-Blob für eine neue Self-Identität.
 *
 * Background: Storage-Key ist HKDF-derived aus
 *   `renex:gsk-storage:<scope>:<me>:<groupId>`
 * — bindet `me` und `groupId`, NICHT den Peer. Beim Guest-Convert wechselt
 * `me` auf der Self-Seite, der Storage-Key ändert sich also.
 *
 * @param {{ivB64: string, ctB64: string}} blob
 * @param {'my'|'peer'} scope
 * @param {string} oldMe
 * @param {string} newMe
 * @param {string} groupId
 * @returns {Promise<{ivB64: string, ctB64: string}|null>}
 */
export async function reEncryptGskBlobForRename(blob, scope, oldMe, newMe, groupId) {
  if (!blob || !blob.ivB64 || !blob.ctB64) return null;
  const oldKey = await _getGroupStorageKey(oldMe, groupId, scope);
  const newKey = await _getGroupStorageKey(newMe, groupId, scope);
  try {
    const gskBytes = await _decryptFromStorage(oldKey, blob.ivB64, blob.ctB64);
    if (gskBytes instanceof Uint8Array && gskBytes.length === 32) {
      return await _encryptForStorage(newKey, gskBytes);
    }
  } catch {}
  return null;
}

// ======================================================
// IDB-Keys
// ======================================================

function _getMyHandle() {
  if (typeof localStorage === 'undefined') return '';
  return (localStorage.getItem('my_user') || '').toLowerCase();
}

function _myGskKey(me, groupId) {
  return `gsk:my:${me.toLowerCase()}:${String(groupId).toLowerCase()}`;
}
function _peerGskKey(me, groupId, peer) {
  return `gsk:peer:${me.toLowerCase()}:${String(groupId).toLowerCase()}:${String(peer).toLowerCase()}`;
}

// ======================================================
// AES-GCM Key import for Plain-Bytes
// ======================================================

async function _importGskAesKey(gskBytes) {
  return crypto.subtle.importKey(
    'raw', gskBytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ======================================================
// Eigene GSK
// ======================================================

/**
 * Holt die eigene GSK für eine Gruppe (lokal in IDB).
 * Returns null wenn noch nie generiert.
 */
export async function getMyGSK(groupId) {
  const me = _getMyHandle();
  if (!me) return null;
  const saved = await idbGet(_myGskKey(me, groupId));
  if (!saved?.ivB64 || !saved?.ctB64) return null;
  try {
    const sk = await _getGroupStorageKey(me, groupId, 'my');
    const bytes = await _decryptFromStorage(sk, saved.ivB64, saved.ctB64);
    return (bytes instanceof Uint8Array && bytes.length === 32) ? bytes : null;
  } catch {
    return null;
  }
}

// ======================================================
// GSK-Rotation-Archive (in-memory, 16min TTL)
// ------------------------------------------------------
// Edits laufen in einem 15min-Window nach Original-Send. Wenn die GSK in
// dieser Zeit rotiert (z.B. nach group_member_left), würde der Edit-Decrypt
// bei Empfängern fehlschlagen — die alte GSK wäre überschrieben.
//
// Lösung: jeden setMyGSK/setPeerGSK behält den vorherigen Wert kurz im
// Speicher. editEncryptedGroup / decryptEditedGroupMessage können dann die
// historische GSK über `originalMsg.ts` finden.
//
// Bewusst in-memory only:
//  - 15min-Edit-Window ist kurz, IDB-Write pro Rotation wäre Overkill
//  - Bei Tab-Reload geht's verloren — das ist OK, dann gilt eben "kein Edit"
//  - Kein Storage-Wrap → kein zusätzlicher Crypto-Roundtrip
// ======================================================
const ARCHIVE_TTL_MS = 16 * 60 * 1000;
// _gskArchive: Map<archiveKey, Array<{gsk: Uint8Array, replacedAt: number}>>
//   archiveKey = `my:${groupId}` oder `peer:${groupId}:${peerHandle}`
const _gskArchive = new Map();

function _archiveKey(kind, groupId, peerHandle = null) {
  const gid = String(groupId).toLowerCase();
  return kind === 'my'
    ? `my:${gid}`
    : `peer:${gid}:${String(peerHandle || '').toLowerCase()}`;
}

function _pruneArchive(key) {
  const list = _gskArchive.get(key);
  if (!list) return;
  const cutoff = Date.now() - ARCHIVE_TTL_MS;
  const fresh = list.filter(e => e.replacedAt >= cutoff);
  if (fresh.length === 0) _gskArchive.delete(key);
  else if (fresh.length !== list.length) _gskArchive.set(key, fresh);
}

function _archivePush(key, gskBytes) {
  if (!(gskBytes instanceof Uint8Array) || gskBytes.length !== 32) return;
  const list = _gskArchive.get(key) || [];
  list.push({ gsk: new Uint8Array(gskBytes), replacedAt: Date.now() });
  _gskArchive.set(key, list);
  _pruneArchive(key);
}

/**
 * Findet die GSK, die zum Zeitpunkt `ts` aktiv war.
 * Eintrag passt wenn `replacedAt > ts` (also danach abgelöst).
 * @returns {Uint8Array|null}
 */
function _archiveFindAtTs(key, ts) {
  _pruneArchive(key);
  const list = _gskArchive.get(key);
  if (!list || list.length === 0 || typeof ts !== 'number') return null;
  // älteste passende Version (kleinster replacedAt > ts) — sonst bekommt man
  // bei mehreren Rotationen die jüngste statt die zur Zeit ts korrekte.
  let best = null;
  for (const e of list) {
    if (e.replacedAt > ts) {
      if (!best || e.replacedAt < best.replacedAt) best = e;
    }
  }
  return best ? best.gsk : null;
}

/** Findet die historische eigene GSK zum gegebenen Zeitpunkt. */
export function findMyGSKAtTs(groupId, ts) {
  return _archiveFindAtTs(_archiveKey('my', groupId), ts);
}

/** Findet die historische Peer-GSK zum gegebenen Zeitpunkt. */
export function findPeerGSKAtTs(groupId, peerHandle, ts) {
  return _archiveFindAtTs(_archiveKey('peer', groupId, peerHandle), ts);
}

/** Wird von group-leave / Logout aufgerufen — archiv für die Gruppe leeren. */
export function clearGSKArchiveForGroup(groupId) {
  const gid = String(groupId).toLowerCase();
  for (const k of _gskArchive.keys()) {
    if (k === `my:${gid}` || k.startsWith(`peer:${gid}:`)) {
      _gskArchive.delete(k);
    }
  }
}

/**
 * Schreibt eine eigene GSK in IDB (Wrap-for-Storage).
 * Bevor der neue Wert geschrieben wird, der vorherige (falls vorhanden) ins
 * In-Memory-Archive für 16min — damit Edits älterer Messages noch decryptbar
 * sind (siehe Archive-Doku oben).
 */
export async function setMyGSK(groupId, gskBytes) {
  if (!(gskBytes instanceof Uint8Array) || gskBytes.length !== 32) {
    throw new Error('GSK must be 32 bytes');
  }
  const me = _getMyHandle();
  if (!me) throw new Error('not logged in');
  // Vor dem Überschreiben: alten Wert ins Archive
  try {
    const prev = await getMyGSK(groupId);
    if (prev) _archivePush(_archiveKey('my', groupId), prev);
  } catch {}
  const sk = await _getGroupStorageKey(me, groupId, 'my');
  const enc = await _encryptForStorage(sk, gskBytes);
  await idbSet(_myGskKey(me, groupId), enc);

  // ChainIndex zurücksetzen — neue GSK = neue Sender-Key-Identität, also
  // beginnt der Counter wieder bei 0. Ohne Reset würde der Empfänger nach
  // einer Rotation falsche per-Message-MKs ableiten (chainIndex-Mismatch
  // zwischen Sender (counter weiterläuft) und ableitbarem Counter aus
  // GSK-Generation-Time).
  try { await idbSet(_chainKey(me, groupId), 0); } catch {}

  // Bundle-Sync triggern — neue/rotierte GSK ins R2-Bundle pushen damit
  // Phrase-Recovery sie wiederherstellen kann. Debounced via scheduleBundleSync.
  // Dynamic-Import vermeidet circular import (cmkBundleSync importiert
  // collectMyGSKs aus diesem Modul).
  try {
    const mod = await import('./cmkBundleSync.js');
    mod.scheduleBundleSync();
  } catch {}
}

/**
 * Erstellt eine NEUE eigene GSK (32 Bytes random) und persistiert sie.
 */
export async function createMyGSK(groupId) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  await setMyGSK(groupId, bytes);
  return bytes;
}

// ======================================================
// GSK Sender-Signature (Defense-in-Depth gegen from-Spoofing)
// ------------------------------------------------------
// Zusätzlich zur ECDH-Symmetrie (Sender-Pubkey aus Inbox-Cache) wird
// die GSK-Distribution mit der ECDSA-Sig des Senders authentifiziert.
// Schützt gegen ein hypothetisches Backend-Manipulation des `from`-Felds.
//
// Signed-String-Format:  `renex-gsk-v1|<groupId>|<ts>|<sha256(gsk)-hex>`
// → bindet GSK-Hash an (groupId, timestamp). Wenn Backend GSK ersetzt,
//   ändert sich der Hash → verify fail. Wenn Backend `from` ersetzt,
//   ist die Sig nicht mit dem (anderen) sigPub verifizierbar → fail.
// ======================================================

async function _sha256Hex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < arr.length; i++) {
    out += arr[i].toString(16).padStart(2, '0');
  }
  return out;
}

function _gskSigInput(groupId, gskHashHex, ts) {
  return new TextEncoder().encode(`renex-gsk-v1|${groupId}|${ts}|${gskHashHex}`);
}

/**
 * Signiert eine GSK-Distribution mit dem eigenen ECDSA-Sig-Privkey.
 * @param {string} groupId
 * @param {Uint8Array} gskBytes - 32-Byte Sender-GSK
 * @param {number} ts - epoch ms
 * @returns {Promise<string>} sigB64
 */
export async function signGskPayload(groupId, gskBytes, ts) {
  if (!(gskBytes instanceof Uint8Array) || gskBytes.length !== 32) {
    throw new Error('gskBytes must be 32 bytes');
  }
  const privKey = await loadSigningPrivKey();
  if (!privKey) throw new Error('No signing key — initE2EKeys + uploadInboxKeyIfNeeded first');
  const gskHash = await _sha256Hex(gskBytes);
  const data = _gskSigInput(String(groupId), gskHash, Number(ts));
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privKey,
    data
  );
  return bytesToB64(new Uint8Array(sig));
}

/**
 * Verifiziert die GSK-Sig gegen den Sender-Sig-Pubkey aus dem Peer-Cache.
 * Returns false bei jedem Fehler — Caller (handleIncomingGSKMessage) muss
 * dann entscheiden ob die GSK trotzdem akzeptiert wird (z.B. wenn sig
 * fehlt = älterer Sender ohne Sig-Support, ECDH-Symmetrie schützt schon).
 *
 * @param {string} sigB64
 * @param {object} sigPubJwk - aus getSigPubForDevice
 * @param {string} groupId
 * @param {Uint8Array} gskBytes - die UNWRAPPTE GSK (nach ECDH-Decrypt)
 * @param {number} ts
 * @returns {Promise<boolean>}
 */
export async function verifyGskPayload(sigB64, sigPubJwk, groupId, gskBytes, ts) {
  try {
    if (typeof sigB64 !== 'string' || !sigPubJwk) return false;
    if (sigPubJwk.kty !== 'EC' || sigPubJwk.crv !== 'P-256') return false;
    if (typeof sigPubJwk.x !== 'string' || typeof sigPubJwk.y !== 'string') return false;
    if (sigPubJwk.d !== undefined) return false;
    if (!(gskBytes instanceof Uint8Array) || gskBytes.length !== 32) return false;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return false;

    const pubKey = await crypto.subtle.importKey(
      'jwk', sigPubJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, ['verify']
    );
    const gskHash = await _sha256Hex(gskBytes);
    const data = _gskSigInput(String(groupId), gskHash, ts);
    const sigBytes = b64ToBytes(sigB64);
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pubKey,
      sigBytes,
      data
    );
  } catch {
    return false;
  }
}

// ======================================================
// Auto-Rotate Threshold (NIST SP 800-38D)
// ------------------------------------------------------
// AES-GCM-Birthday-Bound: 2^48 IV-Collision-Wahrscheinlichkeit pro Key.
// NIST empfiehlt prophylaktische Rotation VOR 2^32 Encryptions, damit die
// Collision-Wahrscheinlichkeit unter ~2^-65 bleibt — astronomisch sicher.
// Bei realistischen Volumes (selbst extreme Power-User: ~10^7 sends/Jahr)
// wird der Threshold nie erreicht, aber der Mechanismus ist da als
// Defense-in-Depth gegen langfristige Key-Reuse.
// ======================================================
export const ENCRYPT_ROTATE_THRESHOLD = 2 ** 32;

// ======================================================
// GSK Chain-Index (Forward-Secrecy)
// ------------------------------------------------------
// Pro (groupId, myHandle) zählt ein monoton-wachsender Counter, der bei
// jedem Send inkrementiert wird. Die Group-MK pro Message ist dann
// HKDF(GSK, info=`renex-group:<groupId>:<sender>:<chainIndex>`).
//
// Damit hat jede Message einen eigenen MK — das gleiche Forward-Secrecy-
// Pattern wie Vanilla (groupSessionManager.js encryptGroupMessage) und
// symmetrisch zu DM (deriveMessageKey aus session.js).
//
// Reset auf 0 bei jeder neuen GSK (siehe setMyGSK), damit ein Empfänger
// nach Rotation wieder bei 0 anfängt — wichtig für IV-Uniqueness-Garantie
// (12-Byte IV pro Message zufällig, aber chainIndex bindet auch).
// ======================================================
function _chainKey(me, groupId) {
  return `gsk-chain:${String(me).toLowerCase()}:${String(groupId).toLowerCase()}`;
}

/**
 * Holt den nächsten chainIndex (current value) und persistiert
 * `current + 1` für den Folge-Aufruf. Der returnte Wert wird in der
 * aktuellen Message als rotationIndex mitgeschickt.
 */
export async function nextGroupChainIndex(groupId) {
  const me = _getMyHandle();
  if (!me) throw new Error('not logged in');
  const k = _chainKey(me, groupId);
  const current = (await idbGet(k)) ?? 0;
  const next = (typeof current === 'number' && current >= 0) ? current : 0;
  await idbSet(k, next + 1);
  return next;
}

/** Liest den nächsten chainIndex ohne ihn zu inkrementieren (für Tests/Debug). */
export async function peekGroupChainIndex(groupId) {
  const me = _getMyHandle();
  if (!me) return 0;
  return (await idbGet(_chainKey(me, groupId))) ?? 0;
}

/** Setzt den chainIndex zurück auf 0 (bei neuer/rotierter GSK). */
export async function resetGroupChainIndex(groupId) {
  const me = _getMyHandle();
  if (!me) return;
  await idbSet(_chainKey(me, groupId), 0);
}

/**
 * HKDF-derived per-Message-Key für Group-Sends (Forward-Secrecy).
 * Cross-Frontend-kompatibel mit Vanilla — selber Salt, selbes info-Format.
 *
 * @param {Uint8Array} gskBytes - 32-Byte Sender-GSK
 * @param {string} groupId
 * @param {string} senderHandle
 * @param {number} chainIndex
 * @returns {Promise<CryptoKey>}
 */
export async function deriveGroupMessageKey(gskBytes, groupId, senderHandle, chainIndex) {
  const salt = new TextEncoder().encode('renex:gmk:v1');
  const info = new TextEncoder().encode(
    `renex-group:${groupId}:${senderHandle}:${chainIndex}`
  );
  const baseKey = await crypto.subtle.importKey(
    'raw', gskBytes, 'HKDF', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Sammelt alle lokalen eigenen GSKs als Map<groupId, base64-bytes>.
 * Genutzt vom Bundle-Sync (cmkBundleSync.js) damit GSKs bei
 * Phrase-Recovery nicht verloren gehen — sonst wären alle eigenen
 * Group-Sends nach Recovery in der eigenen History unleserlich.
 *
 * @returns {Promise<Object<string, string>>} { groupId: cmkB64 }
 */
export async function collectMyGSKs() {
  const me = _getMyHandle();
  if (!me) return {};
  const lc = me.toLowerCase();
  const prefix = `gsk:my:${lc}:`;
  const keys = await idbListKeys(prefix);
  if (keys.length === 0) return {};

  const out = {};
  for (const k of keys) {
    const groupId = k.slice(prefix.length);
    if (!groupId) continue;
    try {
      const bytes = await getMyGSK(groupId);
      if (bytes instanceof Uint8Array && bytes.length === 32) {
        // base64 — gleicher Encoding-Stil wie Bundle-CMKs.
        let s = '';
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        out[groupId] = btoa(s);
      }
    } catch {}
  }
  return out;
}

/**
 * Restored eigene GSKs aus einem Recovery-Bundle.
 * Bestehende GSKs werden NICHT überschrieben (würden Divergenzen erzeugen
 * mit dem aktiven Sender-Key-State der Group).
 *
 * @param {Object<string, string>} gsks - { groupId: base64-bytes } aus Bundle
 * @returns {Promise<{imported: number, skipped: number}>}
 */
export async function restoreMyGSKsFromBundle(gsks) {
  if (!gsks || typeof gsks !== 'object') return { imported: 0, skipped: 0 };
  let imported = 0;
  let skipped = 0;
  for (const [groupId, b64] of Object.entries(gsks)) {
    try {
      if (typeof b64 !== 'string' || !groupId) { skipped++; continue; }
      const existing = await getMyGSK(groupId);
      if (existing) { skipped++; continue; }
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      if (bytes.length !== 32) { skipped++; continue; }
      await setMyGSK(groupId, bytes);
      imported++;
    } catch {
      skipped++;
    }
  }
  return { imported, skipped };
}

/**
 * Löscht die eigene GSK (z.B. bei group-leave).
 */
export async function deleteMyGSK(groupId) {
  const me = _getMyHandle();
  if (!me) return;
  await idbDelete(_myGskKey(me, groupId));
}

// ======================================================
// Peer-GSKs
// ======================================================

export async function getPeerGSK(groupId, peerHandle) {
  const me = _getMyHandle();
  if (!me) return null;
  const saved = await idbGet(_peerGskKey(me, groupId, peerHandle));
  if (!saved?.ivB64 || !saved?.ctB64) return null;
  try {
    const sk = await _getGroupStorageKey(me, groupId, 'peer');
    const bytes = await _decryptFromStorage(sk, saved.ivB64, saved.ctB64);
    return (bytes instanceof Uint8Array && bytes.length === 32) ? bytes : null;
  } catch {
    return null;
  }
}

export async function setPeerGSK(groupId, peerHandle, gskBytes) {
  if (!(gskBytes instanceof Uint8Array) || gskBytes.length !== 32) {
    throw new Error('GSK must be 32 bytes');
  }
  const me = _getMyHandle();
  if (!me) throw new Error('not logged in');
  // Vorherige Peer-GSK ins Archive (für Edit-Decrypt im 15min-Window).
  try {
    const prev = await getPeerGSK(groupId, peerHandle);
    if (prev) _archivePush(_archiveKey('peer', groupId, peerHandle), prev);
  } catch {}
  const sk = await _getGroupStorageKey(me, groupId, 'peer');
  const enc = await _encryptForStorage(sk, gskBytes);
  await idbSet(_peerGskKey(me, groupId, peerHandle), enc);
}

export async function deletePeerGSK(groupId, peerHandle) {
  const me = _getMyHandle();
  if (!me) return;
  await idbDelete(_peerGskKey(me, groupId, peerHandle));
}

/**
 * Listet alle gespeicherten Peer-GSK-Keys für eine Gruppe.
 * Genutzt z.B. bei group-leave, um alle Peer-GSKs der Gruppe zu droppen.
 */
async function _listAllGroupKeys(groupId) {
  const me = _getMyHandle();
  if (!me) return [];
  const prefix = `gsk:peer:${me.toLowerCase()}:${String(groupId).toLowerCase()}:`;
  return await idbListKeys(prefix);
}

/**
 * Vollständiger Cleanup beim Verlassen einer Gruppe.
 */
export async function deleteAllGSKsForGroup(groupId) {
  clearGSKArchiveForGroup(groupId);
  await deleteMyGSK(groupId);
  const peerKeys = await _listAllGroupKeys(groupId);
  for (const k of peerKeys) {
    try { await idbDelete(k); } catch {}
  }
}

// ======================================================
// ECDH-Wrap der GSK pro Recipient-Device
// (Identisch zu wrapCMKForInboxDevices, anderer Use-Case)
// ======================================================

async function _wrapGskForDevices(devices, gskBytes) {
  const myPriv = await loadPrivateKey();
  if (!myPriv) throw new Error('No private key — initE2EKeys first');
  const fromDeviceId = getDeviceId();
  if (!fromDeviceId) throw new Error('No device_id');

  const payloads = [];
  for (const d of devices) {
    if (!d || !d.jwk || !d.deviceId) continue;
    try {
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
        { name: 'AES-GCM', iv }, aesKey, gskBytes
      );
      payloads.push({
        deviceId: d.deviceId,
        fromDeviceId,
        ivB64: bytesToB64(iv),
        ctB64: bytesToB64(new Uint8Array(ct)),
      });
    } catch (e) {
      // Einzelne Devices mit korrupten Keys überspringen, statt alle zu kippen.
      captureException(e, { context: 'wrapGskForDevices', deviceId: d.deviceId });
    }
  }
  return payloads;
}

/**
 * Inverse: aus einem für mein Device gewrappten Payload die GSK extrahieren.
 */
async function _unwrapGskFromPayload(payload, senderJwk) {
  const myPriv = await loadPrivateKey();
  if (!myPriv) throw new Error('No private key — initE2EKeys first');
  const senderPub = await crypto.subtle.importKey(
    'jwk', senderJwk,
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
  const iv = b64ToBytes(payload.ivB64);
  const ct = b64ToBytes(payload.ctB64);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv }, aesKey, ct.buffer
  );
  const bytes = new Uint8Array(pt);
  if (bytes.length !== 32) throw new Error('GSK invalid length');
  return bytes;
}

// ======================================================
// Devices fetch (single-flight; wiederverwendet Peer-Cache aus cmk.js)
// ======================================================

const _inFlightDevices = new Map();

async function _fetchUserDevices(handle) {
  const k = String(handle || '').toLowerCase();
  if (!k) return [];
  const inFlight = _inFlightDevices.get(k);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      const r = await apiFetch(`/e2e/inbox/get?user=${encodeURIComponent(handle)}`);
      if (!r.ok || !Array.isArray(r.data?.devices)) return [];
      await storePeerDevices(handle, r.data.devices);
      return r.data.devices;
    } catch {
      return await loadPeerDevicesIdb(handle);
    }
  })().finally(() => { _inFlightDevices.delete(k); });

  _inFlightDevices.set(k, promise);
  return promise;
}

// Backoff-Retry-Variante. Schützt gegen KV-Eventual-Consistency direkt nach
// `device_added`: der KV-Index am Empfänger-Edge propagiert verzögert, daher
// fehlt das gerade hinzugekommene Device im ersten Fetch. Identisches Pattern
// wie `fetchPeerDevicesEnsuring` in chatPipeline.js für DMs.
async function _fetchUserDevicesEnsuring(handle, expectedDeviceId, expectedJwk) {
  let devs = await _fetchUserDevices(handle);
  if (!expectedDeviceId) return devs;
  if (devs.some(d => d.deviceId === expectedDeviceId)) return devs;

  for (const delay of [400, 800, 1500, 3000]) {
    await new Promise(r => setTimeout(r, delay));
    // Single-Flight-Cache umgehen: nach Delay frisch fetchen
    _inFlightDevices.delete(String(handle || '').toLowerCase());
    devs = await _fetchUserDevices(handle);
    if (devs.some(d => d.deviceId === expectedDeviceId)) return devs;
  }

  // KV propagiert nicht — Push-Info als Fallback in Cache mergen.
  if (expectedJwk) {
    const merged = [...devs.filter(d => d.deviceId !== expectedDeviceId), {
      deviceId: expectedDeviceId,
      jwk: expectedJwk,
    }];
    await storePeerDevices(handle, merged);
    return merged;
  }
  return devs;
}

// ======================================================
// Distribution: GSK an Other Members senden (chatSend control)
// ======================================================

/**
 * Sendet die eigene GSK an einen Member: für jedes seiner Devices wrappen,
 * `type:"gsk"`-Control-Message via /chat/send. Backend pusht via
 * pushToGroupMembers an alle Members ausser uns; Empfänger filtern via
 * `to`-Feld + payload.deviceId-Match.
 *
 * Ein gsk-Send pro Recipient-User (nicht pro Device) — payloads-Limit
 * (10 pro Message) reicht damit auch bei viel Multi-Device pro Member aus.
 */
export async function sendMyGSKToMember(groupId, gskBytes, peerHandle, newDeviceInfo = null) {
  try {
    // Bei device_added(peer): retry bis das neue Peer-Device im KV-Index ist,
    // sonst fehlt der Wrap für genau dieses neue Device.
    const expectedPeerDeviceId = (newDeviceInfo && newDeviceInfo.fromHandle?.toLowerCase() === peerHandle.toLowerCase())
      ? newDeviceInfo.deviceId : null;
    const devices = expectedPeerDeviceId
      ? await _fetchUserDevicesEnsuring(peerHandle, expectedPeerDeviceId, newDeviceInfo?.jwk)
      : await _fetchUserDevices(peerHandle);
    if (devices.length === 0) return { ok: false, reason: 'no_devices' };

    // GSK-Sig signed über (groupId, ts, sha256(gskBytes)) — Auth-Layer
    // zusätzlich zur ECDH-Symmetrie. Empfänger verifiziert mit Sender-
    // SigPub aus Peer-Cache. Defense-in-depth gegen from-Spoofing.
    // Wenn Sig-Privkey fehlt (Edge-Case bei nicht-initialisiertem Device),
    // weiter ohne Sig — Empfänger logged Warn und akzeptiert (ECDH-Schutz
    // bleibt). Sig-Generation darf den GSK-Send NICHT blocken.
    const gskSigTs = Date.now();
    let gskSig = null;
    try {
      gskSig = await signGskPayload(groupId, gskBytes, gskSigTs);
    } catch (e) {
      console.warn('🔑 sendMyGSKToMember: signGskPayload failed (non-fatal):', e?.message);
    }

    // KV-Limit chatSend: max 10 payloads/message. Bei grossen Multi-Device-
    // Konstellationen (theoretisch >10 Devices pro User) splitten.
    const CHUNK = 10;
    let totalDelivered = 0;
    for (let i = 0; i < devices.length; i += CHUNK) {
      const slice = devices.slice(i, i + CHUNK);
      const payloads = await _wrapGskForDevices(slice, gskBytes);
      if (payloads.length === 0) continue;

      const body = {
        to: peerHandle,
        convoId: groupId,
        type: 'gsk',
        v: 1,
        e2e: false,
        payloads,
        deviceId: getDeviceId(),
        message: '__gsk__',
      };
      // Optional sig fields — Empfänger toleriert deren Fehlen für
      // Backwards-Compat (alte Versionen ohne Sig-Support).
      if (gskSig) {
        body.gskSig = gskSig;
        body.gskSigTs = gskSigTs;
      }

      const r = await apiFetch('/chat/send', { method: 'POST', body });
      if (r.ok) totalDelivered += payloads.length;
    }
    return { ok: totalDelivered > 0, distributed: totalDelivered };
  } catch (e) {
    captureException(e, { context: 'sendMyGSKToMember', groupId, peerHandle });
    return { ok: false, reason: 'exception' };
  }
}

/**
 * Distribuiert die eigene GSK an mehrere Members parallel.
 */
export async function distributeMyGSKToMembers(groupId, gskBytes, memberHandles) {
  const me = _getMyHandle();
  const others = memberHandles.filter(h => h && h.toLowerCase() !== me);
  const results = await Promise.allSettled(
    others.map(h => sendMyGSKToMember(groupId, gskBytes, h))
  );
  const ok = results.filter(r => r.status === 'fulfilled' && r.value?.ok).length;
  return { ok: ok > 0, recipients: others.length, delivered: ok };
}

/**
 * Re-wrapped die eigenen GSKs an einen Peer, der gerade ein neues Device
 * hinzugefügt hat. Iteriert über alle Gruppen, in denen me UND peer Member
 * sind (Quelle: groupList aus Inbox + /groups/members?groupId=).
 *
 * Spec: docs/GROUPS_MULTIDEVICE.md §4.2 (Peer-Device-Add Sequence-Diagram).
 *
 * @param {string} myHandle
 * @param {string} peerHandle
 * @param {{fromHandle: string, deviceId: string, jwk: object}} newDeviceInfo - aus device_added Push
 * @param {Array<{id: string}>} myGroups - Liste meiner Gruppen (aus inboxStore.groups)
 */
export async function redistributeGSKsForPeerDeviceAdded(myHandle, peerHandle, newDeviceInfo, myGroups) {
  if (!Array.isArray(myGroups) || myGroups.length === 0) return { ok: true, distributed: 0 };
  const me = String(myHandle || '').toLowerCase();
  const peer = String(peerHandle || '').toLowerCase();
  if (!me || !peer || me === peer) return { ok: false, reason: 'invalid_handles' };

  let distributed = 0;
  let skipped = 0;
  for (const g of myGroups) {
    const groupId = g?.id;
    if (!groupId) continue;
    try {
      // Skip Gruppen, in denen ich keine eigene GSK habe — nichts zu re-wrappen.
      const gsk = await getMyGSK(groupId);
      if (!gsk) { skipped++; continue; }

      // Membership-Check: ist Peer in dieser Gruppe?
      let members = [];
      try {
        const r = await apiFetch(`/groups/members?groupId=${encodeURIComponent(groupId)}`);
        if (r.ok && Array.isArray(r.data?.members)) {
          members = r.data.members
            .map(m => String(m.member_handle || '').toLowerCase())
            .filter(Boolean);
        }
      } catch {}
      if (!members.includes(peer)) { skipped++; continue; }

      const r = await sendMyGSKToMember(groupId, gsk, peer, newDeviceInfo);
      if (r.ok) distributed++;
      else skipped++;
    } catch (e) {
      captureException(e, { context: 'redistributeGSKsForPeerDeviceAdded', groupId, peerHandle });
      skipped++;
    }
  }
  console.log(`📤 Peer-device-added: GSK-Redistribution für ${peerHandle} → ${distributed} Gruppen verteilt, ${skipped} skipped`);
  return { ok: distributed > 0 || skipped === myGroups.length, distributed, skipped };
}

// ======================================================
// Distribution: GSK an eigene andere Devices (KV)
// ======================================================

export async function storeMyGSKForOwnDevices(groupId, gskBytes, newDeviceInfo = null) {
  try {
    const me = _getMyHandle();
    if (!me) return { ok: false, reason: 'no_me' };

    // Bei device_added(self): retry bis das gerade hinzugefügte Device im
    // KV-Index sichtbar ist. Sonst landet die GSK-Wrap nicht im KV → neues
    // Device kann beim Boot keine GSK aus KV restoren.
    const expectedSelfDeviceId = (newDeviceInfo && newDeviceInfo.fromHandle?.toLowerCase() === me)
      ? newDeviceInfo.deviceId : null;
    const devices = expectedSelfDeviceId
      ? await _fetchUserDevicesEnsuring(me, expectedSelfDeviceId, newDeviceInfo?.jwk)
      : await _fetchUserDevices(me);

    const myDeviceId = getDeviceId();
    const others = devices.filter(d => d.deviceId !== myDeviceId);
    if (others.length === 0) return { ok: true, distributed: 0 };

    // KV-Endpoint store erlaubt max 20 payloads pro Call — bei mehr eigenen
    // Devices splitten.
    const CHUNK = 20;
    let total = 0;
    for (let i = 0; i < others.length; i += CHUNK) {
      const slice = others.slice(i, i + CHUNK);
      const payloads = await _wrapGskForDevices(slice, gskBytes);
      if (payloads.length === 0) continue;
      const r = await apiFetch('/e2e/group-gsk/store', {
        method: 'POST',
        body: { groupId, payloads },
      });
      if (r.ok) total += payloads.length;
    }
    return { ok: total > 0, distributed: total };
  } catch (e) {
    captureException(e, { context: 'storeMyGSKForOwnDevices', groupId });
    return { ok: false, reason: 'exception' };
  }
}

/**
 * Holt die eigene GSK aus KV (gestored von einem anderen eigenen Device beim
 * Add-Device). Wird beim Bootstrap eines neuen Devices gerufen.
 */
export async function fetchMyGSKFromKV(groupId) {
  try {
    const myDeviceId = getDeviceId();
    if (!myDeviceId) return null;
    const r = await apiFetch(
      `/e2e/group-gsk/fetch?groupId=${encodeURIComponent(groupId)}` +
      `&deviceId=${encodeURIComponent(myDeviceId)}`
    );
    if (!r.ok || !r.data?.payload) return null;
    const { fromDeviceId, ivB64, ctB64 } = r.data.payload;
    if (!fromDeviceId || !ivB64 || !ctB64) return null;

    const me = _getMyHandle();
    let senderJwk = await findSenderDeviceJwk(me, fromDeviceId);
    if (!senderJwk) {
      const devs = await _fetchUserDevices(me);
      senderJwk = devs.find(d => d.deviceId === fromDeviceId)?.jwk || null;
    }
    if (!senderJwk) return null;

    const gsk = await _unwrapGskFromPayload({ ivB64, ctB64 }, senderJwk);
    return gsk;
  } catch (e) {
    captureException(e, { context: 'fetchMyGSKFromKV', groupId });
    return null;
  }
}

// ======================================================
// Receive: gsk Control-Message verarbeiten
// ======================================================

/**
 * Wird vom WS-Handler bei eingehendem `type:"gsk"` gerufen.
 * - msg.from == me  → eigene andere Device-Distribution → ignore (KV-Pfad zuständig)
 * - msg.to   == me  → wrap für mich, decrypt, als Peer-GSK von msg.from speichern
 * - msg.to   != me  → Broadcast-Echo, ignore
 *
 * Gibt true zurück wenn eine GSK persistiert wurde (für Logging).
 */
export async function handleIncomingGSKMessage(msg) {
  try {
    const me = _getMyHandle();
    const groupId = msg.groupId || msg.convoId;
    const from = String(msg.from || '').toLowerCase();
    const to = String(msg.to || '').toLowerCase();
    const payloads = Array.isArray(msg.payloads) ? msg.payloads : [];

    if (!me || !groupId || !from || payloads.length === 0) {
      console.warn(`🔑✗ gsk skip(precond): me=${!!me} groupId=${!!groupId} from=${from} payloads=${payloads.length}`);
      return false;
    }
    // Eigene gsk an OWN-Devices laufen über KV — nicht über chatSend-Broadcast.
    if (from === me) {
      // Nicht loggen — eigenes Echo, by design
      return false;
    }
    // Nur an mich adressierte gsks akzeptieren (Broadcast-Echo verwirft den Rest).
    if (to && to !== me) {
      // Nicht loggen — Broadcast-Echo, by design (passiert für jeden anderen Member-Empfänger)
      return false;
    }

    // Mein device-payload herausfischen
    const myDeviceId = getDeviceId();
    const payload = payloads.find(p => p?.deviceId === myDeviceId);
    if (!payload) {
      const seen = payloads.map(p => p?.deviceId).filter(Boolean);
      console.warn(`🔑✗ gsk skip(no_payload_for_device): me=${me} myDeviceId=${myDeviceId} payloads_for=[${seen.join(',')}] from=${from} group=${String(groupId).slice(0,8)}`);
      return false;
    }

    // Sender-JWK auflösen (für ECDH)
    const senderDeviceId = payload.fromDeviceId || msg.deviceId;
    if (!senderDeviceId) {
      console.warn(`🔑✗ gsk skip(no_senderDeviceId): from=${from}`);
      return false;
    }
    let senderJwk = await findSenderDeviceJwk(from, senderDeviceId);
    if (!senderJwk) {
      const devs = await _fetchUserDevices(from);
      senderJwk = devs.find(d => d.deviceId === senderDeviceId)?.jwk || null;
    }
    if (!senderJwk) {
      console.warn(`🔑✗ gsk skip(no_senderJwk): from=${from} senderDeviceId=${senderDeviceId}`);
      return false;
    }

    let gsk;
    try {
      gsk = await _unwrapGskFromPayload(payload, senderJwk);
    } catch (e) {
      console.warn(`🔑✗ gsk unwrap fail: from=${from} senderDeviceId=${senderDeviceId} err=${e?.message}`);
      throw e;
    }

    // GSK-Sender-Sig verifizieren (Defense-in-Depth gegen from-Spoofing).
    // Falls msg.gskSig fehlt: backwards-compat (alte Sender ohne Sig-Support),
    // akzeptieren mit Warning. ECDH-Symmetrie schützt schon — verkehrter
    // Sender-Pubkey hätte den unwrap nicht durchgelassen.
    // Falls msg.gskSig vorhanden ABER fail: GSK droppen (Sig-Spoof-Versuch).
    if (typeof msg.gskSig === 'string' && msg.gskSig.length > 0) {
      const sigTs = typeof msg.gskSigTs === 'number' ? msg.gskSigTs : null;
      if (sigTs === null) {
        console.warn(`🔑✗ gsk sig verify skipped: gskSig vorhanden aber gskSigTs fehlt (from=${from})`);
      } else {
        let sigPub = await getSigPubForDevice(from, senderDeviceId);
        if (!sigPub) {
          // Cache-Miss → re-fetch peer-devices und nochmal probieren
          try {
            const devs = await _fetchUserDevices(from);
            sigPub = devs.find(d => d.deviceId === senderDeviceId)?.sigPub || null;
          } catch {}
        }
        if (sigPub) {
          const ok = await verifyGskPayload(msg.gskSig, sigPub, groupId, gsk, sigTs);
          if (!ok) {
            console.error(
              `🚨 GSK-Sig-Verify FAILED — from=${from} senderDeviceId=${senderDeviceId} ` +
              `group=${String(groupId).slice(0, 8)} — GSK gedroppt (möglicher Spoof)`
            );
            return false;
          }
        } else {
          // sigPub nicht im Cache UND nicht aus Inbox — toleriert (alte Sender,
          // ECDH-Schutz greift). Im Production-Logging als Hinweis.
          console.warn(`🔑 gsk sig present but sigPub unknown for from=${from}/${senderDeviceId} — accepting via ECDH-only`);
        }
      }
    }

    await setPeerGSK(groupId, from, gsk);
    return true;
  } catch (e) {
    captureException(e, { context: 'handleIncomingGSKMessage' });
    return false;
  }
}

// ======================================================
// request_gsk: aktiv eine fehlende Peer-GSK anfragen
// ======================================================

export async function sendRequestGSK(groupId, requestedFrom) {
  try {
    const r = await apiFetch('/chat/send', {
      method: 'POST',
      body: {
        to: requestedFrom,
        convoId: groupId,
        type: 'request_gsk',
        v: 1,
        e2e: false,
        requestedFrom,
        deviceId: getDeviceId(),
        message: '__request_gsk__',
      },
    });
    return { ok: !!r.ok };
  } catch (e) {
    captureException(e, { context: 'sendRequestGSK', groupId, requestedFrom });
    return { ok: false };
  }
}

/**
 * Reaktion auf eingehendes `request_gsk`: wenn requestedFrom === me, eigene
 * GSK an den Anfrager senden (für seine Devices wrappen).
 */
export async function handleIncomingRequestGSK(msg) {
  try {
    const me = _getMyHandle();
    const requestedFrom = String(msg.requestedFrom || '').toLowerCase();
    const requester = String(msg.from || '').toLowerCase();
    const groupId = msg.groupId || msg.convoId;
    if (!me || !requestedFrom || !requester || !groupId) return false;
    if (requestedFrom !== me) return false;
    if (requester === me) return false;

    let gsk = await getMyGSK(groupId);
    if (!gsk) gsk = await createMyGSK(groupId);

    const r = await sendMyGSKToMember(groupId, gsk, requester);
    return r.ok;
  } catch (e) {
    captureException(e, { context: 'handleIncomingRequestGSK' });
    return false;
  }
}

// ======================================================
// Rotation
// ======================================================

/**
 * Generiert einen FRISCHEN GSK + verteilt ihn an alle aktiven Members + eigene
 * andere Devices. Wird bei member_left/member_removed gerufen, damit Ex-Member
 * zukünftige Messages nicht mehr lesen können (ihr lokal-cached GSK ist stale).
 */
export async function rotateMyGSK(groupId, memberHandles) {
  try {
    const newGsk = await createMyGSK(groupId);
    const distrib = await distributeMyGSKToMembers(groupId, newGsk, memberHandles);
    const own = await storeMyGSKForOwnDevices(groupId, newGsk);
    return { ok: true, newGsk, distrib, own };
  } catch (e) {
    captureException(e, { context: 'rotateMyGSK', groupId });
    return { ok: false };
  }
}

// ======================================================
// Send-Pipeline für Group-Messages
// ======================================================

/**
 * Stellt sicher, dass eine eigene GSK existiert (lokal, KV-Restore, oder neu).
 * Gibt die GSK-Bytes zurück. Wenn neu erstellt: distribuiert sofort an alle
 * Member-Devices + eigene Devices.
 */
export async function ensureMyGSK(groupId, memberHandles) {
  let gsk = await getMyGSK(groupId);
  if (gsk) return gsk;

  // Vor Neugenerierung: KV-Restore versuchen (eigenes anderes Device hat
  // evtl. GSK schon hochgeladen).
  gsk = await fetchMyGSKFromKV(groupId);
  if (gsk) {
    await setMyGSK(groupId, gsk);
    return gsk;
  }

  // Wirklich frisch — erst jetzt neu generieren.
  gsk = await createMyGSK(groupId);
  // Distribute fire-and-forget (Send blockiert nicht auf KV-Round-Trip)
  void distributeMyGSKToMembers(groupId, gsk, memberHandles);
  void storeMyGSKForOwnDevices(groupId, gsk);
  return gsk;
}

// ======================================================
// Decrypt-Helpers — werden vom chat-store benutzt
// ======================================================

/**
 * Liefert die GSK eines bestimmten Senders (lokal). Wenn nicht vorhanden:
 * triggert request_gsk fire-and-forget und gibt null zurück. Der Caller
 * sollte einen Decrypt-Retry mit Backoff fahren.
 */
export async function getOrRequestPeerGSK(groupId, peerHandle) {
  const gsk = await getPeerGSK(groupId, peerHandle);
  if (gsk) return gsk;
  // Fire-and-forget — Antwort kommt via WS gsk-Control-Message.
  void sendRequestGSK(groupId, peerHandle);
  return null;
}

/**
 * Importiert die GSK als AES-Key (für Caller die nur den Key wollen ohne raw).
 */
export async function importGskAesKey(gskBytes) {
  return _importGskAesKey(gskBytes);
}
