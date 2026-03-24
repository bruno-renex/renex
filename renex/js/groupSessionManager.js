// groupSessionManager.js
// Sender Keys Protokoll für RENEX Gruppen-Chat
// Basiert auf Signal's Sender Keys Design (vereinfacht)
//
// ┌─────────────────────────────────────────────────────────────────┐
// │  Warum Sender Keys statt CMK für Gruppen?                       │
// │                                                                 │
// │  CMK (DM):     Authority wraps CMK für ALLE Empfänger-Devices   │
// │                O(members × devices) Wrap-Ops pro Nachricht      │
// │                                                                 │
// │  Sender Keys:  Jedes Mitglied hat eigenen Group Sender Key      │
// │                Einmalig distribuiert → O(1) pro Nachricht       │
// │                Kein Authority-Konzept → skaliert auf N Personen │
// └─────────────────────────────────────────────────────────────────┘
//
// Flow:
//   1. Gruppe erstellen → jedes Mitglied generiert eigenen GSK
//   2. GSK wird einmalig an alle Mitglieder-Devices gesendet (typ: "gsk")
//   3. Nachricht senden: encrypt(GSK_sender, chainIndex, plaintext) → O(1)
//   4. Nachricht empfangen: decrypt(GSK_sender, chainIndex, ciphertext)
//   5. Neues Device: empfängt GSK von Gruppe (Mitglied wraps für neues Device)

import {
  idbGet,
  idbSet,
  loadPrivateKey,
  wrapCMKForInboxDevices,
  getDeviceId,
  findSenderDeviceJwk
} from "./e2e.js";

// ======================================================
// IDB KEY NAMES
// ======================================================
// gsk:{groupId}:{memberHandle}    → Uint8Array(32)  — Group Sender Key
// gsk-chain:{groupId}:{handle}    → Number          — Chain Index (eigener)

const gskKey      = (gId, handle) => `gsk:${gId}:${handle}`;
const gskChainKey = (gId, handle) => `gsk-chain:${gId}:${handle}`;

// ======================================================
// HELPERS
// ======================================================
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// ======================================================
// GSK GENERIEREN & SPEICHERN
// ======================================================

/**
 * Generiert einen neuen Group Sender Key für ein Mitglied.
 * Wird aufgerufen wenn:
 *  - eine Gruppe erstellt wird
 *  - ein Mitglied eine Gruppe betritt (eigener GSK)
 *  - CMK-Rotation für Gruppen (nach Member-Kick)
 */
export async function generateGroupSK(groupId, myHandle) {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  await idbSet(gskKey(groupId, myHandle), keyBytes);
  await idbSet(gskChainKey(groupId, myHandle), 0);
  console.log("🔑 Group Sender Key generiert:", { groupId, myHandle });
  return keyBytes;
}

/**
 * Eigenen GSK holen (zum Senden).
 * Generiert einen neuen wenn noch keiner existiert.
 */
export async function getOrCreateGroupSK(groupId, myHandle) {
  let keyBytes = await idbGet(gskKey(groupId, myHandle));
  if (!(keyBytes instanceof Uint8Array)) {
    keyBytes = await generateGroupSK(groupId, myHandle);
  }
  return keyBytes;
}

/**
 * Empfangenen GSK eines anderen Mitglieds speichern.
 * Wird aufgerufen nach erfolgreichem "gsk" Control-Message.
 */
export async function storeReceivedGroupSK(groupId, senderHandle, keyBytes) {
  await idbSet(gskKey(groupId, senderHandle), keyBytes);
  console.log("📥 Group Sender Key empfangen:", { groupId, senderHandle });
}

/**
 * GSK eines Mitglieds holen (zum Entschlüsseln).
 * Gibt null zurück wenn noch nicht empfangen.
 */
export async function getGroupSK(groupId, senderHandle) {
  const bytes = await idbGet(gskKey(groupId, senderHandle));
  return bytes instanceof Uint8Array ? bytes : null;
}

// ======================================================
// CHAIN INDEX (Forward Secrecy innerhalb einer Epoch)
// ======================================================

/**
 * Chain Index inkrementieren und zurückgeben.
 * Jede gesendete Nachricht bekommt einen eindeutigen Index.
 */
export async function nextChainIndex(groupId, myHandle) {
  const current = (await idbGet(gskChainKey(groupId, myHandle))) ?? 0;
  const next = current + 1;
  await idbSet(gskChainKey(groupId, myHandle), next);
  return next;
}

// ======================================================
// NACHRICHTENSCHLÜSSEL ABLEITEN (HKDF)
// ======================================================

/**
 * Group Message Key: HKDF(GSK, info={groupId}:{senderHandle}:{chainIndex})
 * Jede Nachricht hat einen einzigartigen MK → AES-GCM encrypt/decrypt.
 */
export async function deriveGroupMK(skBytes, groupId, senderHandle, chainIndex) {
  const info = new TextEncoder().encode(
    `renex-group:${groupId}:${senderHandle}:${chainIndex}`
  );

  const baseKey = await crypto.subtle.importKey(
    "raw", skBytes, "HKDF", false, ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// ======================================================
// VERSCHLÜSSELN (Sender-Seite)
// ======================================================

/**
 * Gruppen-Nachricht verschlüsseln.
 * Gibt { ivB64, ctB64, chainIndex } zurück — wird in der Message mitgeschickt.
 *
 * O(1) — unabhängig von Gruppengrös­se.
 */
export async function encryptGroupMessage(groupId, myHandle, plaintext) {
  const skBytes = await getOrCreateGroupSK(groupId, myHandle);
  const chainIndex = await nextChainIndex(groupId, myHandle);
  const mk = await deriveGroupMK(skBytes, groupId, myHandle, chainIndex);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    mk,
    new TextEncoder().encode(plaintext)
  );

  return {
    ivB64: bytesToB64(iv),
    ctB64: bytesToB64(new Uint8Array(ct)),
    chainIndex
  };
}

// ======================================================
// ENTSCHLÜSSELN (Empfänger-Seite)
// ======================================================

/**
 * Gruppen-Nachricht entschlüsseln.
 * Gibt decrypted string zurück, oder null wenn GSK fehlt/Fehler.
 *
 * senderHandle + chainIndex kommen aus den Message-Metadaten.
 */
export async function decryptGroupMessage(groupId, senderHandle, ivB64, ctB64, chainIndex) {
  const skBytes = await getGroupSK(groupId, senderHandle);
  if (!skBytes) {
    console.warn("❌ Kein GSK für Sender:", { groupId, senderHandle });
    return null; // GSK noch nicht empfangen → deferred
  }

  try {
    const mk = await deriveGroupMK(skBytes, groupId, senderHandle, chainIndex);
    const iv = b64ToBytes(ivB64);
    const ct = b64ToBytes(ctB64);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, mk, ct.buffer);
    return new TextDecoder().decode(plain);
  } catch (e) {
    console.warn("❌ Group MK decrypt failed:", { groupId, senderHandle, chainIndex, error: String(e) });
    return "__decrypt_failed__";
  }
}

// ======================================================
// GSK DISTRIBUTION — einmalig bei Gruppe beitreten / erstellen
// ======================================================

/**
 * Eigenen GSK für alle Mitglieder-Devices wrappen und verteilen.
 *
 * Nutzt exakt denselben ECDH-Mechanismus wie CMK-Wrapping (wrapCMKForInboxDevices).
 * Wird gesendet als Control-Message Typ "gsk".
 *
 * @param groupId    UUID der Gruppe
 * @param myHandle   eigener Handle
 * @param allDevices Array<{deviceId, jwk}> — alle Devices ALLER Mitglieder (ausser eigene)
 * @param apiFetch   fetch-Wrapper
 */
export async function distributeGroupSK(groupId, myHandle, allDevices, apiFetch) {
  const skBytes = await getOrCreateGroupSK(groupId, myHandle);

  if (allDevices.length === 0) {
    console.warn("distributeGroupSK: keine Empfänger-Devices");
    return false;
  }

  // Selben ECDH-Wrap wie CMK verwenden (wrapCMKForInboxDevices akzeptiert beliebige keyBytes)
  const payloads = await wrapCMKForInboxDevices(allDevices, skBytes);

  await apiFetch("/chat/send", {
    method: "POST",
    body: JSON.stringify({
      to:      allDevices[0]?.memberHandle ?? "",  // Routing-Hint (DO delivery)
      convoId: groupId,
      type:    "gsk",
      gskSender: myHandle,
      payloads,
      v:    2,
      e2e:  true
    })
  });

  console.log("📤 GSK distribuiert:", { groupId, myHandle, devices: allDevices.length });
  return true;
}

// ======================================================
// GSK EMPFANGEN (Control-Message Handler)
// ======================================================

/**
 * Eingehende "gsk" Control-Message verarbeiten.
 * Entschlüsselt den für dieses Device bestimmten GSK-Payload.
 *
 * @param from        Handle des Senders (Gruppen-Mitglied das seinen GSK schickt)
 * @param groupId     Konversations-UUID
 * @param myDeviceId  eigene Device-ID
 * @param payloads    Array<{deviceId, fromDeviceId, ivB64, ctB64}> aus der Message
 */
export async function receiveGroupSK({ from, groupId, myDeviceId, payloads }) {
  const p = payloads?.find(x => x.deviceId === myDeviceId);
  if (!p) {
    console.log("ℹ️ GSK payload nicht für dieses Device", { myDeviceId });
    return false;
  }

  const myPriv = await loadPrivateKey();
  if (!myPriv) return false;

  // Sender-JWK holen (Inbox-Key des Senders, selbe Lookup-Logik wie CMK)
  const senderJwk = await findSenderDeviceJwk(from, p.fromDeviceId);
  if (!senderJwk) {
    console.warn("❌ Sender-JWK nicht gefunden für GSK:", { from, fromDeviceId: p.fromDeviceId });
    return false;
  }

  const peerPub = await crypto.subtle.importKey(
    "jwk",
    senderJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  const aesKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: peerPub },
    myPriv,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  let skBuf;
  try {
    skBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64ToBytes(p.ivB64) },
      aesKey,
      b64ToBytes(p.ctB64).buffer
    );
  } catch (e) {
    console.warn("❌ GSK decrypt failed:", { from, error: String(e) });
    return false;
  }

  await storeReceivedGroupSK(groupId, from, new Uint8Array(skBuf));
  return true;
}

// ======================================================
// DEVICE ROTATION (neues eigenes Device)
// ======================================================

/**
 * Wenn ein neues eigenes Device hinzukommt:
 * Anderes Device sendet den eigenen GSK an das neue Device.
 * (Nur 1 Device muss wrappen, nicht alle → kein Authority-Konzept nötig)
 *
 * @param groupId      Konversations-UUID
 * @param myHandle     eigener Handle
 * @param newDevices   Array<{deviceId, jwk}> — nur das/die neuen Devices
 * @param apiFetch     fetch-Wrapper
 */
export async function rewrapGroupSKForNewDevice(groupId, myHandle, newDevices, apiFetch) {
  const skBytes = await getGroupSK(groupId, myHandle);
  if (!skBytes) {
    console.warn("rewrapGroupSKForNewDevice: kein GSK für eigenen Handle", { groupId, myHandle });
    return false;
  }

  const payloads = await wrapCMKForInboxDevices(newDevices, skBytes);

  await apiFetch("/chat/send", {
    method: "POST",
    body: JSON.stringify({
      to:        newDevices[0]?.memberHandle ?? myHandle,
      convoId:   groupId,
      type:      "gsk",
      gskSender: myHandle,
      payloads,
      v:    2,
      e2e:  true
    })
  });

  console.log("🔑 GSK für neues Device re-wrapped:", { groupId, myHandle, newDevices: newDevices.length });
  return true;
}

// ======================================================
// FORWARD SECRECY — Member Kick / Gruppe verlassen
// ======================================================

/**
 * Nach Member-Kick oder Austritt: neuen GSK generieren + distribuieren.
 * Alle verbleibenden Mitglieder tun dasselbe → Kicked-Member kann neue
 * Nachrichten nicht mehr entschlüsseln (Forward Secrecy für Gruppen).
 *
 * @param groupId       Konversations-UUID
 * @param myHandle      eigener Handle
 * @param remainingDevices  Array<{deviceId, jwk}> — alle verbleibenden Mitglieder-Devices
 * @param apiFetch      fetch-Wrapper
 */
export async function rotateGroupSK(groupId, myHandle, remainingDevices, apiFetch) {
  // Alten GSK überschreiben
  await generateGroupSK(groupId, myHandle);
  // Neuen GSK verteilen
  return distributeGroupSK(groupId, myHandle, remainingDevices, apiFetch);
}
