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
 *
 * Phase 5.4: Race-Guard — wenn der incoming GSK identisch zum gespeicherten ist
 * (z.B. doppelt empfangen via WebSocket + KV oder durch Re-Distribution), als
 * no-op behandeln. Verhindert Cache-Thrashing + bewahrt Chain-State.
 */
export async function storeReceivedGroupSK(groupId, senderHandle, keyBytes) {
  const existing = await idbGet(gskKey(groupId, senderHandle));
  if (existing instanceof Uint8Array && existing.length === keyBytes.length) {
    let identical = true;
    for (let i = 0; i < keyBytes.length; i++) {
      if (existing[i] !== keyBytes[i]) { identical = false; break; }
    }
    if (identical) {
      console.log("⏭️ storeReceivedGroupSK: identisch zum gespeicherten — no-op", { groupId, senderHandle });
      return;
    }
  }
  await idbSet(gskKey(groupId, senderHandle), keyBytes);
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
// Aktueller Salt (v1) — domain-spezifisch statt 32 zero bytes
const HKDF_SALT_V1 = new TextEncoder().encode("renex:gmk:v1");
// Legacy Salt (v0) — für Rückwärtskompatibilität mit alten Nachrichten
const HKDF_SALT_V0 = new Uint8Array(32);

export async function deriveGroupMK(skBytes, groupId, senderHandle, chainIndex, salt = HKDF_SALT_V1) {
  const info = new TextEncoder().encode(
    `renex-group:${groupId}:${senderHandle}:${chainIndex}`
  );

  const baseKey = await crypto.subtle.importKey(
    "raw", skBytes, "HKDF", false, ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info },
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
    const iv = b64ToBytes(ivB64);
    const ct = b64ToBytes(ctB64);
    // Erst neuen Salt (v1) versuchen, dann Legacy-Salt (v0) für ältere Nachrichten
    for (const salt of [HKDF_SALT_V1, HKDF_SALT_V0]) {
      try {
        const mk = await deriveGroupMK(skBytes, groupId, senderHandle, chainIndex, salt);
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, mk, ct.buffer);
        return new TextDecoder().decode(plain);
      } catch { /* nächsten Salt versuchen */ }
    }
    console.warn("❌ Group MK decrypt failed (alle Salts):", { groupId, senderHandle, chainIndex });
    return "__decrypt_failed__";
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
    // Phase 5.4: Local-Only-Modus — kein Empfänger-Device verfügbar (alle Members
    // offline / haben keine Inbox-Keys). Eigener GSK existiert lokal, Nachrichten
    // können verschlüsselt + auf Server gespeichert werden. Members holen GSK via
    // request_gsk wenn sie wieder online sind. Caller behandelt den false-Return
    // typischerweise mit UX-Hint (siehe ensureGroupChatReady).
    console.warn("⚠️ distributeGroupSK (Local-Only): keine Empfänger-Devices — eigener GSK lokal verfügbar, Members holen ihn später");
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
export async function receiveGroupSK({ from, groupId, myDeviceId, payloads, findSenderDeviceJwkFn }) {
  const p = payloads?.find(x => x.deviceId === myDeviceId);
  if (!p) {
      return false;
  }

  const myPriv = await loadPrivateKey();
  if (!myPriv) return false;

  // Sender-JWK holen — optionaler Callback (mit Inbox-Fallback) hat Vorrang vor IDB-only
  const lookupFn = findSenderDeviceJwkFn || findSenderDeviceJwk;
  const senderJwk = await lookupFn(from, p.fromDeviceId);
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
    console.warn("❌ GSK decrypt failed (Key-Mismatch?):", { from, error: String(e) });
    // Key-Mismatch: Sender hat GSK mit altem Public Key gewrapped.
    // Alten GSK-Cache löschen damit ein frischer Request mit neuen Keys möglich wird.
    try { await idbSet(gskKey(groupId, from), null); } catch {}
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

  return true;
}

// ======================================================
// Phase 5.3: MULTI-DEVICE GSK-SYNC via KV
// ======================================================
// Eigener GSK wird für andere eigene Geräte (Mac+iPad+Phone) in KV abgelegt,
// damit ein neu hinzugefügtes Gerät den GSK fetchen kann ohne dass das alte
// Gerät online sein muss.
// Throttle: 5 Min pro Gruppe (verhindert Spam bei häufigem Chat-Wechsel).
// ======================================================
const SELF_GSK_SYNC_TTL_MS = 5 * 60_000;

export async function syncGroupSKToOwnDevices(groupId, myHandle, fetchInboxKeysFn, apiFetchFn) {
  const throttleKey = `group_gsk_sync:${groupId}`;
  const syncedDevicesKey = `group_gsk_synced_devs:${groupId}`;

  const skBytes = await getGroupSK(groupId, myHandle);
  if (!skBytes) return;

  let myInboxDevices;
  try {
    myInboxDevices = await fetchInboxKeysFn(myHandle, { forceFresh: true });
  } catch { return; }
  if (!Array.isArray(myInboxDevices) || myInboxDevices.length <= 1) return;

  const myDeviceId = getDeviceId();
  const otherDevices = myInboxDevices.filter(d => d?.deviceId && d.deviceId !== myDeviceId);
  if (otherDevices.length === 0) return;

  const otherDeviceIds = otherDevices.map(d => d.deviceId).sort();
  const otherDevicesKey = otherDeviceIds.join(",");

  // Throttle UMGEHEN, wenn ein neues Device aufgetaucht ist (gegenüber letztem Sync).
  // Sonst klassischer 5-Min-Throttle gegen Spam.
  let lastSyncedKey = "";
  try { lastSyncedKey = sessionStorage.getItem(syncedDevicesKey) || ""; } catch {}
  const hasNewDevice = lastSyncedKey !== otherDevicesKey;

  if (!hasNewDevice) {
    try {
      const last = Number(sessionStorage.getItem(throttleKey) || "0");
      if (Date.now() - last < SELF_GSK_SYNC_TTL_MS) return;
    } catch {}
  } else {
    console.log("🆕 Neues eigenes Device erkannt — Sync-Throttle übergehen");
  }

  try {
    const payloads = await wrapCMKForInboxDevices(otherDevices.slice(-9), skBytes);
    if (!payloads || payloads.length === 0) return;
    await apiFetchFn("/e2e/group-gsk/store", {
      method: "POST",
      body: JSON.stringify({ groupId, payloads })
    });
    try { sessionStorage.setItem(throttleKey, String(Date.now())); } catch {}
    try { sessionStorage.setItem(syncedDevicesKey, otherDevicesKey); } catch {}
    console.log(`🔁 Self-Sync (Group): GSK für ${payloads.length} eigene Devices in KV abgelegt`);
  } catch (e) {
    console.warn("⚠️ syncGroupSKToOwnDevices fehlgeschlagen", e);
  }
}

// Phase 5.3: Beim Chat-Open auf neuem Device — eigenen GSK aus KV holen.
// Wird aufgerufen WENN local kein GSK vorhanden (frisches Gerät) ODER manuell
// nach device_added-Event. Versucht mehrfach (extended polling) damit bestehendes
// Device Zeit hat, syncGroupSKToOwnDevices auszuführen.
export async function fetchOwnGroupSKFromKV(groupId, apiFetchFn, findSenderDeviceJwkFn) {
  const myDeviceId = getDeviceId();
  const myHandle = (localStorage.getItem("my_user") || "").toLowerCase();
  if (!myHandle || !myDeviceId) return false;

  // Falls schon vorhanden, nicht erneut holen
  const existing = await getGroupSK(groupId, myHandle);
  if (existing instanceof Uint8Array && existing.length === 32) return true;

  const POLL_DELAYS = [0, 2000, 4000, 8000, 16000]; // 30s gesamt
  for (let i = 0; i < POLL_DELAYS.length; i++) {
    if (POLL_DELAYS[i] > 0) {
      console.log(`⏳ Multi-Device GSK-Polling Versuch ${i}/${POLL_DELAYS.length - 1}...`);
      await new Promise(r => setTimeout(r, POLL_DELAYS[i]));
    }
    try {
      const res = await apiFetchFn(`/e2e/group-gsk/fetch?groupId=${encodeURIComponent(groupId)}&deviceId=${encodeURIComponent(myDeviceId)}`);
      if (!res?.payload) continue;

      const { fromDeviceId, ivB64, ctB64 } = res.payload;
      const ok = await receiveGroupSK({
        from: myHandle,
        groupId,
        myDeviceId,
        payloads: [{ deviceId: myDeviceId, fromDeviceId, ivB64, ctB64 }],
        findSenderDeviceJwkFn
      });
      if (ok) {
        console.log("✅ Eigener GSK aus KV importiert (Multi-Device)");
        return true;
      }
    } catch (e) {
      console.warn(`⚠️ fetchOwnGroupSKFromKV Versuch ${i} fehlgeschlagen`, e);
    }
  }
  console.log("⏸️ Multi-Device GSK-Polling erschöpft — neuer GSK wird beim ersten Send erzeugt");
  return false;
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
