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
import { loadPrivateKey, getDeviceId } from './e2eKeys.js';
import {
  storePeerDevices, loadPeerDevicesIdb, findSenderDeviceJwk,
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
}

/**
 * Erstellt eine NEUE eigene GSK (32 Bytes random) und persistiert sie.
 */
export async function createMyGSK(groupId) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  await setMyGSK(groupId, bytes);
  return bytes;
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
export async function sendMyGSKToMember(groupId, gskBytes, peerHandle) {
  try {
    const devices = await _fetchUserDevices(peerHandle);
    if (devices.length === 0) return { ok: false, reason: 'no_devices' };

    // KV-Limit chatSend: max 10 payloads/message. Bei grossen Multi-Device-
    // Konstellationen (theoretisch >10 Devices pro User) splitten.
    const CHUNK = 10;
    let totalDelivered = 0;
    for (let i = 0; i < devices.length; i += CHUNK) {
      const slice = devices.slice(i, i + CHUNK);
      const payloads = await _wrapGskForDevices(slice, gskBytes);
      if (payloads.length === 0) continue;

      const r = await apiFetch('/chat/send', {
        method: 'POST',
        body: {
          to: peerHandle,
          convoId: groupId,
          type: 'gsk',
          v: 1,
          e2e: false,
          payloads,
          deviceId: getDeviceId(),
          message: '__gsk__',
        },
      });
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

// ======================================================
// Distribution: GSK an eigene andere Devices (KV)
// ======================================================

export async function storeMyGSKForOwnDevices(groupId, gskBytes) {
  try {
    const me = _getMyHandle();
    if (!me) return { ok: false, reason: 'no_me' };

    const devices = await _fetchUserDevices(me);
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
