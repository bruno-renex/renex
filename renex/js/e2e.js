// e2e.js
// ======================================================
// IndexedDB (Keys)
// ======================================================
let dbPromise = null;

function openKeyDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open("renex-keys", 1);

    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("keys")) {
        req.result.createObjectStore("keys");
      }
    };

    req.onerror = () => {
      dbPromise = null; // Cache zurücksetzen → nächster Aufruf versucht erneut
      reject(req.error);
    };

    req.onsuccess = () => {
      const db = req.result;
      // IDB-Verbindung kann vom Browser geschlossen werden (z.B. bei DB-Version-Upgrade)
      // → Promise-Cache zurücksetzen damit der nächste idbGet/idbSet neu öffnet
      db.onclose = () => { dbPromise = null; };
      db.onerror = () => { dbPromise = null; };
      resolve(db);
    };
  });

  return dbPromise;
}

export async function idbSet(key, value) {
  const db = await openKeyDB();
  const tx = db.transaction("keys", "readwrite");
  tx.objectStore("keys").put(value, key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbGet(key) {
  const db = await openKeyDB();
  const tx = db.transaction("keys", "readonly");
  return new Promise(resolve => {
    const req = tx.objectStore("keys").get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}

// ======================================================
// SENDER DEVICE JWK (aus IDB — für CMK-Decryption)
// ======================================================
export async function findSenderDeviceJwk(from, fromDeviceId) {
  const devices = (await idbGet(`peer-devices:${from}`)) || [];
  const d = devices.find(x => x.deviceId === fromDeviceId);
  return d?.jwk || null;
}

// ======================================================
// DEVICE ID (stabil pro Gerät)
// ======================================================
export function getDeviceId() {
  let id = localStorage.getItem("device_id");
  if (!id) {
    id = "dev_" + crypto.randomUUID();
    localStorage.setItem("device_id", id);
    console.log("🆕 deviceId erzeugt:", id);
  }
  return id;
}

// ======================================================
// PHASE 2.1 — DEVICE STORAGE KEY (AES-GCM) für CMK-Speicher
// ======================================================
async function getDeviceSecretB64() {

  // 1️⃣ Zuerst aus IndexedDB laden
  let s = await idbGet("device_secret");

  if (s) {
    return s;
  }

  // 2️⃣ Fallback: localStorage (Migration)
  const legacy = localStorage.getItem("device_secret");

  if (legacy) {
    console.log("🔄 Migriere device_secret nach IndexedDB");
    await idbSet("device_secret", legacy);
    return legacy;
  }

  // 3️⃣ Neu erzeugen
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  s = btoa(bin);

  await idbSet("device_secret", s);

  console.log("🆕 device_secret neu erzeugt");
  return s;
}

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

async function getDeviceStorageKey() {
  // Key aus device_secret ableiten (stabil pro Gerät)
const secretB64 = await getDeviceSecretB64();
const secretBytes = b64ToBytes(secretB64);

  return crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

// ======================================================
// PHASE 2.1 — CMK (Conversation Master Key) persistieren
// ======================================================
function cmkIdbKey(peerHandle) {
  const me = (localStorage.getItem("my_user") || "").toLowerCase();
  const peer = String(peerHandle || "").toLowerCase();

  if (!me || !peer) {
    throw new Error("❌ CMK: user oder peer fehlt");
  }

  return `cmk:${me}:${peer}`;
}

async function encryptForStorage(storageKey, plaintextBytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    storageKey,
    plaintextBytes
  );

  return {
    ivB64: bytesToB64(iv),
    ctB64: bytesToB64(new Uint8Array(ct))
  };
}

async function decryptFromStorage(storageKey, ivB64, ctB64) {
  const iv = b64ToBytes(ivB64);
  const ctBytes = b64ToBytes(ctB64);

  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    storageKey,
    ctBytes.buffer
  );

  return new Uint8Array(pt);
}

// ✅ Export: CMK holen oder erstellen (32 bytes)
export async function getOrCreateCMK(peerHandle) {
  const key = cmkIdbKey(peerHandle);
  const storageKey = await getDeviceStorageKey();

  // 1) laden (wenn vorhanden)
  const saved = await idbGet(key);
  if (saved && saved.ivB64 && saved.ctB64) {
    try {
      const cmkBytes = await decryptFromStorage(storageKey, saved.ivB64, saved.ctB64);

      if (!(cmkBytes instanceof Uint8Array) || cmkBytes.length !== 32) {
        throw new Error("CMK hat ungültige Länge");
      }

      console.log("🔐 CMK geladen:", peerHandle);
      return cmkBytes;

    } catch (e) {
      // ❗WICHTIG: NICHT neu erzeugen -> sonst sind alte Chats tot
      console.error("❌ CMK konnte nicht entschlüsselt werden – möglicher device_secret Verlust", e);
      throw new Error("CMK_DECRYPT_FAILED");
    }
  }

  // 2) nur wenn wirklich keine existiert -> neu erstellen
  const cmk = crypto.getRandomValues(new Uint8Array(32));
  const enc = await encryptForStorage(storageKey, cmk);
  await idbSet(key, enc);

  console.log("✅ CMK erstellt & gespeichert:", peerHandle);
  return cmk;
}

export async function getCMKIfExists(peerHandle) {
  const newKey = cmkIdbKey(peerHandle);
  const oldKey = `cmk:${String(peerHandle).toLowerCase()}`;
  const storageKey = await getDeviceStorageKey();

  // 1️⃣ Versuche neuen Key
  let saved = await idbGet(newKey);

  // 2️⃣ Falls nicht vorhanden → MIGRATION prüfen
  if (!saved) {
    const legacy = await idbGet(oldKey);

    if (legacy && legacy.ivB64 && legacy.ctB64) {
      console.log("🔄 Migriere alten CMK → neues Namespace-Format");

      // alten unter neuem speichern
      await idbSet(newKey, legacy);

// alten löschen (transaktions-sicher)
const db = await openKeyDB();
const tx = db.transaction("keys", "readwrite");
tx.objectStore("keys").delete(oldKey);

await new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
});

saved = legacy;
    }
  }

  if (!saved || !saved.ivB64 || !saved.ctB64) return null;

  try {
    const cmkBytes = await decryptFromStorage(
      storageKey,
      saved.ivB64,
      saved.ctB64
    );

    if (!(cmkBytes instanceof Uint8Array) || cmkBytes.length !== 32)
      return null;

    return cmkBytes;

  } catch {
    return null;
  }
}

export async function importAndStoreCMKFromPeer(peerHandle, cmkBytes) {
  if (!(cmkBytes instanceof Uint8Array) || cmkBytes.length !== 32) {
    throw new Error("❌ CMK ungültig (muss 32 bytes sein)");
  }

  const key = cmkIdbKey(peerHandle);
  const storageKey = await getDeviceStorageKey();
  const enc = await encryptForStorage(storageKey, cmkBytes);
  await idbSet(key, enc);

  console.log("✅ CMK von Peer importiert & gespeichert:", peerHandle);
}

export async function storePeerDevices(peerHandle, devices) {
  await idbSet(`peer-devices:${peerHandle}`, devices);
}

export async function loadPeerDevicesIdb(peerHandle) {
  return await idbGet(`peer-devices:${peerHandle}`) || [];
}

// Optional: CMK löschen (für Reset/Debug)
export async function deleteCMK(peerHandle) {
  const db = await openKeyDB();
  const tx = db.transaction("keys", "readwrite");
  tx.objectStore("keys").delete(cmkIdbKey(peerHandle));

  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  console.log("🗑️ CMK vollständig gelöscht:", peerHandle);
}

// ======================================================
// 🔐 CMK für Inbox-Devices verschlüsseln (Bootstrap)
// ======================================================
export async function wrapCMKForInboxDevices(devices, cmkBytes) {
  const myPriv = await loadPrivateKey();
  if (!myPriv) throw new Error("No private key");

  const payloads = [];

  for (const d of devices) {
    const peerPub = await crypto.subtle.importKey(
      "jwk",
      d.jwk,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      []
    );

    const aesKey = await crypto.subtle.deriveKey(
      { name: "ECDH", public: peerPub },
      myPriv,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"]
    );

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      aesKey,
      cmkBytes
    );

    payloads.push({
      deviceId: d.deviceId,
      fromDeviceId: getDeviceId(),
      ivB64: bytesToB64(iv),
      ctB64: bytesToB64(new Uint8Array(ct))
    });
  }

  return payloads;
}

// ======================================================
// Exported key loaders
// ======================================================
export async function loadPrivateKey() {
  return await idbGet("e2e-private-key");
}

export async function loadPublicKey() {
  return await idbGet("e2e-public-key");
}

async function storePrivateKey(privateKey) {
  await idbSet("e2e-private-key", privateKey);
}
// ======================================================
// CMK v2 – Session Helpers (NEU)
// ======================================================

// 🔑 Deterministische DM-Session-ID
export function dmSessionId(me, peer) {
  const a = String(me).toLowerCase();
  const b = String(peer).toLowerCase();
  return a < b ? `dm:${a}:${b}` : `dm:${b}:${a}`;
}

// 🔐 HKDF: Session Key → Message Key (epoch-basiert)
export async function deriveMessageKey(skBytes, sessionId, epoch) {
  const sk = await crypto.subtle.importKey(
    "raw",
    skBytes,
    "HKDF",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(sessionId),
      info: new TextEncoder().encode(`renex/v2/mk/epoch:${epoch}`)
    },
    sk,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// ======================================================
// CMK v2 – Session Key (SK) als BYTES
// ======================================================
export async function deriveSessionKeyBytes(cmkBytes, sessionId) {
  if (!(cmkBytes instanceof Uint8Array) || cmkBytes.length !== 32) {
    throw new Error("CMK ungültig");
  }

  const cmkKey = await crypto.subtle.importKey(
    "raw",
    cmkBytes,
    "HKDF",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("renex/cmk-v2"),
      info: new TextEncoder().encode(`session:${sessionId}`)
    },
    cmkKey,
    256
  );

  return new Uint8Array(bits); // 👈 SK BYTES
}

// ======================================================
// 1) INIT KEYPAIR (global / long-term)
// ======================================================
export async function initE2EKeys() {
  const existingPrivateKey = await loadPrivateKey();
  const existingPublicKey  = await loadPublicKey();

  if (existingPrivateKey && existingPublicKey) {
    console.log("🔐 E2E: Keypair bereits vorhanden");
    return true;
  }

  console.log("🔐 E2E: Erzeuge neues Keypair");

  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey"]
  );

  await storePrivateKey(keyPair.privateKey);
  await idbSet("e2e-public-key", keyPair.publicKey);

  console.log("✅ E2E Keypair erzeugt & gespeichert");
  return true;
}

// ======================================================
// 2) Upload Public Key (idempotent)
// ======================================================
async function pubkeyUploadedFlag(deviceId) {
  const pub = await loadPublicKey();
  if (!pub) return null;

  const jwk = await crypto.subtle.exportKey("jwk", pub);
  const fingerprint = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(jwk))
  );

  const hash = btoa(
    String.fromCharCode(...new Uint8Array(fingerprint))
  ).slice(0, 16); // kurz & stabil

  return `e2e_pubkey_uploaded:${deviceId}:${hash}`;
}

export async function debugPrintMyPublicKey() {
  const pub = await loadPublicKey();
  if (!pub) return console.warn("🔑 Noch kein Public Key gespeichert");
  const jwk = await crypto.subtle.exportKey("jwk", pub);
  console.log("📌 MEIN PUBLIC KEY JWK:", jwk);
}

// ======================================================
// 📮 INBOX KEY – GLOBAL & IDEMPOTENT
// ======================================================
export async function uploadInboxKeyIfNeeded() {
  const deviceId = getDeviceId();
  if (!deviceId) {
    console.warn("📮 Inbox-Key: kein deviceId");
    return;
  }

  const pubKey = await loadPublicKey();
  if (!pubKey) {
    console.warn("📮 Inbox-Key: kein PublicKey");
    return;
  }

  const jwk    = await crypto.subtle.exportKey("jwk", pubKey);
  const sigPub = await getSigningPublicKeyJwk();

  await fetch("https://api.renex.id/e2e/inbox/upload", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jwk, deviceId, sigPub })
  });

  console.log("📮 Inbox-Key + SigPub hochgeladen:", deviceId);
}

// ======================================================
// EPOCH ROTATION — SK pro Rotation-Index
// ======================================================

// SK ableiten mit Rotation-Index (index=0 → alte Formel, backward-compat)
export async function deriveSessionKeyBytesForRotation(cmkBytes, sessionId, rotationIndex) {
  if (rotationIndex === 0) return deriveSessionKeyBytes(cmkBytes, sessionId);

  const cmkKey = await crypto.subtle.importKey(
    "raw", cmkBytes, "HKDF", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: new TextEncoder().encode("renex/cmk-v2"),
    info: new TextEncoder().encode(`session:${sessionId}:rotation:${rotationIndex}`)
  }, cmkKey, 256);
  return new Uint8Array(bits);
}

// Rotation-Index aus IDB laden (default: 0)
export async function getRotationIndex(sessionId) {
  return (await idbGet(`rotation:${sessionId}`)) ?? 0;
}

// Rotation-Index in IDB speichern
export async function setRotationIndex(sessionId, index) {
  await idbSet(`rotation:${sessionId}`, index);
}

// Zeitstempel der letzten Rotation (für zeitbasierte Rotation)
export async function getLastRotationTime(sessionId) {
  return (await idbGet(`lastRotation:${sessionId}`)) ?? 0;
}

export async function setLastRotationTime(sessionId, ts) {
  await idbSet(`lastRotation:${sessionId}`, ts);
}

// ======================================================
// 🔑 CMK ROTATION MAP
// Speichert welcher CMK ab welchem rotationIndex gilt.
// Format: [{ fromIndex: 0, cmkBytes: [...] }, { fromIndex: 50, cmkBytes: [...] }, ...]
// rotationIndex wird NIE zurückgesetzt — CMK-Wechsel = neuer Eintrag ab Index N
// ======================================================

export async function getRotationMap(sessionId) {
  return (await idbGet(`cmk:rotation-map:${sessionId}`)) || [];
}

export async function appendToRotationMap(sessionId, fromIndex, cmkBytes) {
  const map = await getRotationMap(sessionId);
  const filtered = map.filter(e => e.fromIndex < fromIndex);
  filtered.push({ fromIndex, cmkBytes: Array.from(cmkBytes) });
  await idbSet(`cmk:rotation-map:${sessionId}`, filtered);
}

export function findCmkForRotationIndex(rotationMap, rotationIndex) {
  if (!rotationMap || rotationMap.length === 0) return null;
  const applicable = rotationMap.filter(e => e.fromIndex <= rotationIndex);
  if (applicable.length === 0) {
    const first = rotationMap[0];
    return first?.cmkBytes ? new Uint8Array(first.cmkBytes) : null;
  }
  const entry = applicable[applicable.length - 1];
  return entry?.cmkBytes ? new Uint8Array(entry.cmkBytes) : null;
}

// Erstellt einen NEUEN CMK (zufällig), speichert ihn in IDB, gibt ihn zurück
export async function createAndStoreCMK(peerHandle) {
  const newCmkBytes = crypto.getRandomValues(new Uint8Array(32));
  await importAndStoreCMKFromPeer(peerHandle, newCmkBytes);
  return newCmkBytes;
}

// ======================================================
// 🔏 MESSAGE SIGNING — ECDSA P-256
// Schützt ctB64 vor Backend-Manipulation.
// Signing-Key: 1 pro Device, in IDB gespeichert.
// ======================================================
const SIG_KEY_IDB = "sig_keypair";

async function getOrCreateSigningKeyPair() {
  const saved = await idbGet(SIG_KEY_IDB);
  if (saved?.pub && saved?.priv) {
    try {
      const privKey = await crypto.subtle.importKey(
        "jwk", saved.priv,
        { name: "ECDSA", namedCurve: "P-256" },
        false, ["sign"]
      );
      return { privKey, pubJwk: saved.pub };
    } catch {}
  }

  // Neu generieren
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true, ["sign", "verify"]
  );
  const pubJwk  = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  await idbSet(SIG_KEY_IDB, { pub: pubJwk, priv: privJwk });
  return { privKey: pair.privateKey, pubJwk };
}

// Signing Public Key (JWK) — wird beim Inbox-Upload mitgeschickt
export async function getSigningPublicKeyJwk() {
  const { pubJwk } = await getOrCreateSigningKeyPair();
  return pubJwk;
}

// signiert: ivB64 | ctB64 | sid | epoch
export async function signMessage(ivB64, ctB64, sid, epoch) {
  const { privKey } = await getOrCreateSigningKeyPair();
  const data = new TextEncoder().encode(`${ivB64}|${ctB64}|${sid}|${epoch}`);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privKey, data
  );
  return bytesToB64(new Uint8Array(sig));
}

// Verifiziert Signatur gegen den Sender-pubJwk
export async function verifyMessageSig(ivB64, ctB64, sid, epoch, sigB64, pubJwk) {
  try {
    const pubKey = await crypto.subtle.importKey(
      "jwk", pubJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false, ["verify"]
    );
    const data = new TextEncoder().encode(`${ivB64}|${ctB64}|${sid}|${epoch}`);
    const sig  = b64ToBytes(sigB64);
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pubKey, sig, data
    );
  } catch {
    return false;
  }
}

// Liefert sigPub für ein Device aus dem lokalen Peer-Cache
export async function getSigPubForDevice(fromHandle, fromDeviceId) {
  const devices = (await idbGet(`peer-devices:${fromHandle}`)) || [];
  const d = devices.find(x => x.deviceId === fromDeviceId);
  return d?.sigPub || null;
}