// ======================================================
// Handle-Migration nach Guest-Convert
// ======================================================
// Beim Guest-Convert (Gast → echter User-Account) muss IDB-Storage
// umgeschrieben werden, weil viele Schlüssel den Handle enthalten.
//
// Inviter-Seite (Anna, hat den Gast eingeladen):
//   migratePeerHandle(oldGuestHandle, newRealHandle)
//   → Schlüssel mit `peer = oldGuestHandle` umbenennen
//
// Self-Seite (Panther, ehem. Gast, hat sich konvertiert):
//   migrateMyHandle(oldGuestHandle, newRealHandle)
//   → Schlüssel mit `me = oldGuestHandle` umbenennen
//
// Betroffene Schlüssel-Schemata:
//   cmk:${me}:${peer}                    (cmk.js)
//   peer-devices:${peer}                 (cmk.js)
//   rotation:${sid}                      (session.js)
//   lastRotation:${sid}                  (session.js)
//   cmk:rotation-map:${sid}              (session.js)
//   gsk:my:${me}:${groupId}              (groupCrypto.js)
//   gsk:peer:${me}:${groupId}:${peer}    (groupCrypto.js)
//
// Alle Operationen sind idempotent — nochmaliger Aufruf ist no-op.
// ======================================================

import { idbGet, idbSet, idbDelete, idbListKeys } from './idb.js';
import { dmSessionId } from './session.js';
import { reEncryptCmkBlobForRename } from './cmk.js';
import { reEncryptGskBlobForRename } from './groupCrypto.js';

function _myHandle() {
  if (typeof localStorage === 'undefined') return '';
  return (localStorage.getItem('my_user') || '').toLowerCase();
}

/**
 * Verschiebt den IDB-Eintrag von `oldKey` nach `newKey`.
 * Returnt true wenn ein Rename passiert ist.
 *
 * Defensiv: existiert newKey schon, wird oldKey nur gelöscht (nicht überschrieben),
 * damit eine teil-gelaufene Migration keine neuen Daten zerschießt.
 */
async function _renameKey(oldKey, newKey) {
  if (oldKey === newKey) return false;
  // idbGet returnt `null` (nicht undefined) wenn der Key fehlt — mit `== null`
  // catchen wir beide Fälle.
  const oldValue = await idbGet(oldKey);
  if (oldValue == null) return false;
  const newValue = await idbGet(newKey);
  if (newValue != null) {
    await idbDelete(oldKey);
    return false;
  }
  await idbSet(newKey, oldValue);
  await idbDelete(oldKey);
  return true;
}

/**
 * CMK braucht Re-Encryption (Storage-Key bindet me+peer via HKDF).
 * Ein simpler IDB-Rename hinterlässt den Inhalt mit dem alten Storage-Key
 * verschlüsselt → CMK_DECRYPT_FAILED beim nächsten Lookup.
 */
async function _migrateCmkEntry(oldKey, newKey, oldMe, oldPeer, newMe, newPeer) {
  if (oldKey === newKey) return false;
  const blob = await idbGet(oldKey);
  if (blob == null) return false;
  const existingNew = await idbGet(newKey);
  if (existingNew != null) {
    await idbDelete(oldKey);
    return false;
  }
  const reEncrypted = await reEncryptCmkBlobForRename(blob, oldMe, oldPeer, newMe, newPeer);
  if (!reEncrypted) {
    // Decrypt schlug fehl — alten Eintrag liegen lassen, damit ein erneuter Versuch
    // möglich bleibt. Caller ignoriert den Rückgabewert false.
    return false;
  }
  await idbSet(newKey, reEncrypted);
  await idbDelete(oldKey);
  return true;
}

/**
 * GSK (my/peer) braucht Re-Encryption wenn `me` wechselt — Storage-Key bindet
 * scope+me+groupId via HKDF (peer ist NICHT im Storage-Key).
 */
async function _migrateGskEntry(oldKey, newKey, scope, oldMe, newMe, groupId) {
  if (oldKey === newKey) return false;
  const blob = await idbGet(oldKey);
  if (blob == null) return false;
  const existingNew = await idbGet(newKey);
  if (existingNew != null) {
    await idbDelete(oldKey);
    return false;
  }
  const reEncrypted = await reEncryptGskBlobForRename(blob, scope, oldMe, newMe, groupId);
  if (!reEncrypted) return false;
  await idbSet(newKey, reEncrypted);
  await idbDelete(oldKey);
  return true;
}

/**
 * Inviter-Seite: ein Peer wurde umbenannt.
 *
 * @param {string} oldPeer - alter Handle (z.B. "guest_2d7bd3a1")
 * @param {string} newPeer - neuer Handle (z.B. "panther16")
 * @returns {Promise<{renamed: number}>}
 */
export async function migratePeerHandle(oldPeer, newPeer) {
  const me = _myHandle();
  const o = String(oldPeer || '').toLowerCase();
  const n = String(newPeer || '').toLowerCase();
  if (!me || !o || !n || o === n) return { renamed: 0 };

  let renamed = 0;

  // 1. CMK — Re-Encryption nötig (Storage-Key bindet me+peer)
  if (await _migrateCmkEntry(`cmk:${me}:${o}`, `cmk:${me}:${n}`, me, o, me, n)) renamed++;

  // 2. Peer-Devices — Plain-JSON, simpler Rename reicht
  if (await _renameKey(`peer-devices:${o}`, `peer-devices:${n}`)) renamed++;

  // 3. Session-bound Keys (rotation, lastRotation, rotation-map) — Plain-Werte, simpler Rename
  const oldSid = dmSessionId(me, o);
  const newSid = dmSessionId(me, n);
  if (oldSid !== newSid) {
    if (await _renameKey(`rotation:${oldSid}`, `rotation:${newSid}`)) renamed++;
    if (await _renameKey(`lastRotation:${oldSid}`, `lastRotation:${newSid}`)) renamed++;
    if (await _renameKey(`cmk:rotation-map:${oldSid}`, `cmk:rotation-map:${newSid}`)) renamed++;
  }

  // 4. GSK-peer Keys — Storage-Key hängt nur an me+groupId, peer betrifft nur den IDB-Key.
  // Daher: simpler Rename reicht (kein Re-Encrypt).
  const gskPeerKeys = await idbListKeys(`gsk:peer:${me}:`);
  for (const k of gskPeerKeys) {
    if (k.endsWith(`:${o}`)) {
      const newK = k.slice(0, -o.length) + n;
      if (await _renameKey(k, newK)) renamed++;
    }
  }

  return { renamed };
}

/**
 * Self-Seite (ehem. Gast): der eigene Handle wurde umbenannt.
 *
 * Aufruf NACH userStore.setUser(realHandle) und NACH dem Convert-API-Call,
 * solange localStorage.my_user den neuen Wert hält. Die DM-Session-IDs werden
 * aus oldMe/newMe selbst neu berechnet — `me`-aus-localStorage wird hier nicht gelesen.
 *
 * @param {string} oldMe - alter Handle (z.B. "guest_2d7bd3a1")
 * @param {string} newMe - neuer Handle (z.B. "panther16")
 * @returns {Promise<{renamed: number, migratedDmPeers: string[]}>}
 *   migratedDmPeers — Liste der Peers für die ein CMK-Storage-Rename passiert
 *   ist. Caller muss für jeden `republishCMKForPeer(newMe, peer)` triggern, damit
 *   der KV-Wrap unter dem neuen `cid = [newMe,peer].sort()` liegt. Sonst kann
 *   der Empfänger den Wrap nach Convert nicht fetchen.
 */
export async function migrateMyHandle(oldMe, newMe) {
  const o = String(oldMe || '').toLowerCase();
  const n = String(newMe || '').toLowerCase();
  if (!o || !n || o === n) return { renamed: 0, migratedDmPeers: [] };

  let renamed = 0;
  const migratedDmPeers = [];

  // 1. CMK-Keys: cmk:${oldMe}:${peer} → cmk:${newMe}:${peer} (mit Re-Encryption!)
  // Defensiv: rotation-map-Keys (`cmk:rotation-map:*`) nicht matchen.
  const cmkKeys = await idbListKeys(`cmk:${o}:`);
  const peers = [];
  for (const k of cmkKeys) {
    const peer = k.slice(`cmk:${o}:`.length);
    if (!peer || peer.includes(':')) continue;
    peers.push(peer);
    if (await _migrateCmkEntry(k, `cmk:${n}:${peer}`, o, peer, n, peer)) {
      renamed++;
      migratedDmPeers.push(peer);
    }
  }

  // 2. Session-bound Keys: für jeden Peer wechselt sid = dmSessionId(me, peer). Plain-Werte.
  for (const peer of peers) {
    const oldSid = dmSessionId(o, peer);
    const newSid = dmSessionId(n, peer);
    if (oldSid === newSid) continue;
    if (await _renameKey(`rotation:${oldSid}`, `rotation:${newSid}`)) renamed++;
    if (await _renameKey(`lastRotation:${oldSid}`, `lastRotation:${newSid}`)) renamed++;
    if (await _renameKey(`cmk:rotation-map:${oldSid}`, `cmk:rotation-map:${newSid}`)) renamed++;
  }

  // 3. GSK-my Keys: Re-Encryption nötig (Storage-Key bindet me+groupId)
  const gskMyKeys = await idbListKeys(`gsk:my:${o}:`);
  for (const k of gskMyKeys) {
    const groupId = k.slice(`gsk:my:${o}:`.length);
    if (!groupId) continue;
    if (await _migrateGskEntry(k, `gsk:my:${n}:${groupId}`, 'my', o, n, groupId)) renamed++;
  }

  // 4. GSK-peer Keys: Re-Encryption nötig (Storage-Key bindet me+groupId, peer ist nur im IDB-Key)
  const gskPeerKeys = await idbListKeys(`gsk:peer:${o}:`);
  for (const k of gskPeerKeys) {
    const rest = k.slice(`gsk:peer:${o}:`.length);
    if (!rest) continue;
    // rest = "${groupId}:${peer}" — wir brauchen groupId für den Storage-Key.
    const colonIdx = rest.indexOf(':');
    if (colonIdx <= 0) continue;
    const groupId = rest.slice(0, colonIdx);
    if (await _migrateGskEntry(k, `gsk:peer:${n}:${rest}`, 'peer', o, n, groupId)) renamed++;
  }

  return { renamed, migratedDmPeers };
}
