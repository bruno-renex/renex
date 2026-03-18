// /js/sessionManager.js
import {
  getOrCreateCMK,
  getCMKIfExists,
  importAndStoreCMKFromPeer,
  wrapCMKForInboxDevices,
  deriveSessionKeyBytes,
  dmSessionId,
  loadPrivateKey,
  getDeviceId,
  findSenderDeviceJwk
} from "./e2e.js";

const sessionCache = new Map(); // sid -> { cmkBytes, skBytes, ready }

export function isAuthority(me, peer) {
  const a = String(me || "").toLowerCase();
  const b = String(peer || "").toLowerCase();
  return a < b;
}

export async function getSession(me, peer) {
  const sid = dmSessionId(me, peer);

  // 0) RAM Cache zuerst
  if (sessionCache.has(sid)) {
    return { sid, ...sessionCache.get(sid) };
  }

  // 1) CMK laden (wenn vorhanden)
  const cmk = await getCMKIfExists(peer);

  if (!cmk) {
    const entry = { ready: false, cmkBytes: null, skBytes: null };
    sessionCache.set(sid, entry);
    return { sid, ...entry };
  }

  // 2) SessionKey ableiten
  const skBytes = await deriveSessionKeyBytes(cmk, sid);

  const entry = { ready: true, cmkBytes: cmk, skBytes };
  sessionCache.set(sid, entry);

  return { sid, ...entry };
}

/**
 * Leader: erstellt/holt CMK und bootstrappt an peer inbox devices
 */
export async function ensureBootstrapped(me, peer, fetchInboxKeysFn, apiFetchFn) {
  const sid = dmSessionId(me, peer);

  // Guard: nur 1x pro Session
  const onceKey = `bootstrapped:${sid}`;
  if (sessionStorage.getItem(onceKey)) return;
  sessionStorage.setItem(onceKey, "1");

  // 🔑 Zuerst: Hat Non-Authority bereits ein CMK in KV hinterlegt?
  try {
    const myDeviceId = getDeviceId();
    const res = await apiFetchFn(`/e2e/cmk/fetch?from=${peer}&deviceId=${myDeviceId}`);
    if (res?.payload) {
      const { fromDeviceId, ivB64, ctB64 } = res.payload;
      const ok = await receiveCMK({
        from: peer,
        myDeviceId,
        payloads: [{ deviceId: myDeviceId, fromDeviceId, ivB64, ctB64 }],
        findSenderDeviceJwk
      });
      if (ok) {
        console.log("✅ Authority: CMK aus KV importiert (Non-Auth hatte Fallback-Bootstrap gemacht)");
        const existingCmk = await getCMKIfExists(peer);
        if (existingCmk) {
          const skBytes = await deriveSessionKeyBytes(existingCmk, sid);
          sessionCache.set(sid, { ready: true, cmkBytes: existingCmk, skBytes });
          return; // fertig — kein neuer CMK nötig
        }
      }
    }
  } catch (e) {
    console.warn("⚠️ Authority KV-Check fehlgeschlagen (non-fatal)", e);
  }

  const cmk = await getOrCreateCMK(peer); // Leader erzeugt falls nicht existiert

  const inboxDevices = await fetchInboxKeysFn(peer);
  if (!Array.isArray(inboxDevices) || inboxDevices.length === 0) return;

// 🔐 Maximal 10 Geräte (neueste zuerst) — Backend-Limit beachten
const MAX_DEVICES = 10;
const limitedDevices = inboxDevices.slice(-MAX_DEVICES);

// 🔐 CMK für alle Geräte gleichzeitig verpacken
const payloads = await wrapCMKForInboxDevices(limitedDevices, cmk);

console.log("📦 CMK payloads prepared for devices:", limitedDevices.map(d => d.deviceId), `(${inboxDevices.length} total, capped at ${MAX_DEVICES})`);

// 📤 einmalige CMK Message senden (live via WebSocket)
await apiFetchFn("/chat/send", {
  method: "POST",
  body: JSON.stringify({
    to: peer,
    e2e: true,
    v: 2,
    type: "cmk",
    sid,
    message: "__cmk__",
    payloads
  })
});

// 💾 CMK persistent in KV speichern (Option C: Offline Recovery)
try {
  await apiFetchFn("/e2e/cmk/store", {
    method: "POST",
    body: JSON.stringify({ to: peer, payloads })
  });
  console.log("💾 CMK in KV gespeichert für", peer);
} catch (e) {
  console.warn("⚠️ CMK KV-Store fehlgeschlagen (non-fatal)", e);
}

  // Cache aktualisieren
  const skBytes = await deriveSessionKeyBytes(cmk, sid);
  sessionCache.set(sid, { ready: true, cmkBytes: cmk, skBytes });
}

/**
 * Importiert CMK aus einer CMK-Control-Message (global)
 */
export async function receiveCMK({
  from,
  myDeviceId,
  payloads,
  findSenderDeviceJwk
}) {
const p = payloads?.find(x => x.deviceId === myDeviceId);
if (!p) {
  console.log("ℹ️ CMK payload not for this device → ignore", {
    myDeviceId,
    payloadDeviceIds: (payloads || []).map(x => x.deviceId)
  });
  return false;
}
console.log("📦 receiveCMK payload picked", p);

  const myPriv = await loadPrivateKey();
  if (!myPriv) return false;

  const senderJwk = await findSenderDeviceJwk(from, p.fromDeviceId);
  if (!senderJwk) return false;

  // ECDH derive AES decrypt key
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

function b64ToU8(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const iv = b64ToU8(p.ivB64);
const ct = b64ToU8(p.ctB64);

let cmkBuf;

try {
  cmkBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    aesKey,
    ct.buffer
  );
} catch (e) {
  console.warn("❌ CMK decrypt failed", {
    from,
    myDeviceId,
    fromDeviceId: p.fromDeviceId,
    error: String(e)
  });
  return false;
}

const cmkBytes = new Uint8Array(cmkBuf);

  await importAndStoreCMKFromPeer(from, cmkBytes);

  // Cache aktualisieren
const me = localStorage.getItem("my_user");
const sid = dmSessionId(me, from);
  const skBytes = await deriveSessionKeyBytes(cmkBytes, sid);
  sessionCache.set(sid, { ready: true, cmkBytes, skBytes });

  return true;
}
export async function ensureConversationReady(me, peer, fetchInboxKeysFn, apiFetchFn) {
  console.log("🧠 ensureConversationReady CALLED", { me, peer });

  const { sid, ready } = await getSession(me, peer);

  console.log("⚖ Authority check:", {
  me,
  peer,
  isAuthority: isAuthority(me, peer)
});

  if (ready) return true;

  // Authority?
  if (isAuthority(me, peer)) {

    // Leader erzeugt + bootstrappt
    await ensureBootstrapped(me, peer, fetchInboxKeysFn, apiFetchFn);
    return true;
  }

  // Nicht Authority → CMK anfordern (max. 1x alle 30s, bis CMK ankommt)
  const onceKey = `cmk_req_sent:${sid}`;
  const lastSent = Number(sessionStorage.getItem(onceKey) || "0");
  const CMK_REQ_COOLDOWN = 30_000; // 30 Sekunden

  if (lastSent > 0 && Date.now() - lastSent < CMK_REQ_COOLDOWN) return false;
  sessionStorage.setItem(onceKey, String(Date.now()));

  try {
    await apiFetchFn("/chat/send", {
      method: "POST",
      body: JSON.stringify({
        to: peer,
        e2e: false,
        v: 1,
        type: "cmk_req",
        message: "__cmk_req__",
        sid
      })
    });
    console.log("📤 CMK_REQ gesendet", { peer, sid });
  } catch (e) {
    // Guard zurücksetzen, damit beim nächsten Versuch retry passiert
    sessionStorage.removeItem(onceKey);
    console.warn("⚠️ CMK_REQ send failed", e);
  }

  return false;
}
// ======================================================
// 🔐 BOOT CONVERSATION (lokales Aktivieren)
// ======================================================
export async function bootConversation(me, peer) {

  const sid = dmSessionId(me, peer);

  // Schon im Cache?
  if (sessionCache.has(sid)) {
    const entry = sessionCache.get(sid);
    if (entry?.ready && entry?.skBytes) {
      return entry;
    }
  }

  // CMK aus Storage laden
  const cmkBytes = await getCMKIfExists(peer);
  if (!cmkBytes) {
    return null;
  }

  // SessionKey ableiten
  const skBytes = await deriveSessionKeyBytes(cmkBytes, sid);

  const entry = {
    ready: true,
    cmkBytes,
    skBytes
  };

  sessionCache.set(sid, entry);

  return entry;
}

/**
 * Fallback Bootstrap: Non-Authority erstellt CMK wenn Authority offline ist.
 * CMK wird in KV gespeichert damit Authority ihn beim nächsten Login findet.
 * Gibt true zurück wenn erfolgreich.
 */
export async function fallbackBootstrap(me, peer, fetchInboxKeysFn, apiFetchFn) {
  // Nur Non-Authority als Fallback
  if (isAuthority(me, peer)) return false;

  const sid = dmSessionId(me, peer);
  const onceKey = `fallback_bootstrapped:${sid}`;
  if (sessionStorage.getItem(onceKey)) return false;
  sessionStorage.setItem(onceKey, "1");

  try {
    // Inbox-Keys der Authority holen
    const inboxDevices = await fetchInboxKeysFn(peer);
    if (!Array.isArray(inboxDevices) || inboxDevices.length === 0) {
      console.warn("⚠️ Fallback Bootstrap: keine Inbox-Keys für", peer);
      sessionStorage.removeItem(onceKey);
      return false;
    }

    // CMK erstellen (oder vorhandenen nutzen)
    const cmk = await getOrCreateCMK(peer);
    const MAX_DEVICES = 10;
    const limitedDevices = inboxDevices.slice(-MAX_DEVICES);
    const payloads = await wrapCMKForInboxDevices(limitedDevices, cmk);

    // CMK persistent in KV für Authority speichern
    await apiFetchFn("/e2e/cmk/store", {
      method: "POST",
      body: JSON.stringify({ to: peer, payloads })
    });
    console.log("💾 Fallback CMK in KV gespeichert für Authority:", peer);

    // Cache aktualisieren
    const skBytes = await deriveSessionKeyBytes(cmk, sid);
    sessionCache.set(sid, { ready: true, cmkBytes: cmk, skBytes });

    console.log("✅ Fallback Bootstrap abgeschlossen:", peer);
    return true;
  } catch (e) {
    console.warn("⚠️ Fallback Bootstrap fehlgeschlagen", e);
    sessionStorage.removeItem(onceKey);
    return false;
  }
}

/**
 * Option C: Non-Authority holt gespeicherte CMK aus KV (ohne Live-Handshake).
 * Wird beim Startup aufgerufen bevor CMK_REQ gesendet wird.
 * Gibt true zurück wenn CMK erfolgreich geladen und gespeichert wurde.
 */
export async function fetchAndStoreCMK(me, peer, apiFetchFn) {
  // Nur Non-Authority fetcht (Authority hat CMK bereits lokal)
  if (isAuthority(me, peer)) return false;

  try {
    const myDeviceId = getDeviceId();
    // Authority = alphabetisch kleinster Handle
    const authority = [me, peer].sort()[0];
    const res = await apiFetchFn(`/e2e/cmk/fetch?from=${authority}&deviceId=${myDeviceId}`);
    if (!res?.payload) {
      console.log("ℹ️ Kein CMK in KV für", { me, peer });
      return false;
    }

    const { fromDeviceId, ivB64, ctB64 } = res.payload;
    const ok = await receiveCMK({
      from: authority,
      myDeviceId,
      payloads: [{ deviceId: myDeviceId, fromDeviceId, ivB64, ctB64 }],
      findSenderDeviceJwk
    });

    if (ok) {
      console.log("✅ CMK aus KV geladen für", peer);
    }
    return ok;
  } catch (e) {
    console.warn("⚠️ fetchAndStoreCMK fehlgeschlagen (non-fatal)", e);
    return false;
  }
}