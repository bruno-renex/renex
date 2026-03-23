// /js/sessionManager.js
import {
  getOrCreateCMK,
  getCMKIfExists,
  importAndStoreCMKFromPeer,
  wrapCMKForInboxDevices,
  deriveSessionKeyBytes,
  deriveSessionKeyBytesForRotation,
  getRotationIndex,
  setRotationIndex,
  setLastRotationTime,
  dmSessionId,
  loadPrivateKey,
  getDeviceId,
  findSenderDeviceJwk,
  getRotationMap,
  appendToRotationMap,
  createAndStoreCMK
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
    const entry = { ready: false, cmkBytes: null, skBytes: null, rotationIndex: 0 };
    sessionCache.set(sid, entry);
    return { sid, ...entry };
  }

  // 2) SessionKey ableiten (rotation-aware)
  const rotationIndex = await getRotationIndex(sid);
  const skBytes = await deriveSessionKeyBytesForRotation(cmk, sid, rotationIndex);

  // 3) Rotation-Map initialisieren falls noch leer (backward-compat für bestehende Sessions)
  const existingMap = await getRotationMap(sid);
  if (existingMap.length === 0) {
    await appendToRotationMap(sid, 0, cmk);
  }

  const entry = { ready: true, cmkBytes: cmk, skBytes, rotationIndex };
  sessionCache.set(sid, entry);

  return { sid, ...entry };
}

/**
 * Leader: erstellt/holt CMK und bootstrappt an peer inbox devices
 */
export async function ensureBootstrapped(me, peer, fetchInboxKeysFn, apiFetchFn) {
  const sid = dmSessionId(me, peer);

  // Guard: nur 1x pro Session — wird bei Fehler zurückgesetzt
  const onceKey = `bootstrapped:${sid}`;
  if (sessionStorage.getItem(onceKey)) return;
  sessionStorage.setItem(onceKey, "1");

  try {

    // 🔑 ZUERST: IDB prüfen — Authority ist Source of Truth
    // Wenn CMK bereits in IDB → direkt senden, KV-Import überspringen
    // (verhindert dass Fallback-CMK von Non-Authority den richtigen CMK überschreibt)
    const existingLocalCmk = await getCMKIfExists(peer);
    if (existingLocalCmk) {
      const inboxDevices = await fetchInboxKeysFn(peer);
      if (Array.isArray(inboxDevices) && inboxDevices.length > 0) {
        const peerPayloads = await wrapCMKForInboxDevices(inboxDevices.slice(-10), existingLocalCmk);
        await apiFetchFn("/chat/send", {
          method: "POST",
          body: JSON.stringify({ to: peer, e2e: true, v: 2, type: "cmk", sid, message: "__cmk__", payloads: peerPayloads })
        });
        // 🔑 Auch für eigene Devices wrappen → neues Authority-Device kann CMK aus KV holen
        let kvPayloads = peerPayloads;
        try {
          const myInboxDevices = await fetchInboxKeysFn(me);
          if (Array.isArray(myInboxDevices) && myInboxDevices.length > 0) {
            const myPayloads = await wrapCMKForInboxDevices(myInboxDevices.slice(-10), existingLocalCmk);
            kvPayloads = [...peerPayloads, ...myPayloads];
            console.log("🔑 CMK auch für eigene Devices gewrappt:", myInboxDevices.length);
          }
        } catch (e) { console.warn("⚠️ CMK self-wrap fehlgeschlagen (non-fatal)", e); }
        try {
          await apiFetchFn("/e2e/cmk/store", {
            method: "POST",
            body: JSON.stringify({ to: peer, payloads: kvPayloads })
          });
        } catch {}
        const rotationIndex = await getRotationIndex(sid);
        const skBytes = await deriveSessionKeyBytesForRotation(existingLocalCmk, sid, rotationIndex);
        sessionCache.set(sid, { ready: true, cmkBytes: existingLocalCmk, skBytes, rotationIndex });
        console.log("✅ Authority: bestehender CMK aus IDB gesendet (kein KV-Import)");
      }
      return;
    }

    // 🔑 Kein CMK in IDB: Hat ein anderes Device den CMK in KV hinterlegt?
    // Retry-Loop: bestehendes Device braucht ~2s für device_added_self → re-wrap → KV
    try {
      const myDeviceId = getDeviceId();
      let res = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) {
          console.log(`⏳ Authority: Warte auf CMK in KV (Versuch ${attempt}/3)...`);
          await new Promise(r => setTimeout(r, 2000));
        }
        res = await apiFetchFn(`/e2e/cmk/fetch?from=${peer}&deviceId=${myDeviceId}`);
        if (res?.payload) break;
      }
      if (res?.payload) {
        const { fromDeviceId, ivB64, ctB64 } = res.payload;

        // Peer-Key suchen: erst IDB, dann Inbox-API als Fallback
        const findSenderJwkWithFallback = async (fromHandle, deviceId) => {
          const cached = await findSenderDeviceJwk(fromHandle, deviceId);
          if (cached) return cached;
          try {
            const inboxDevices = await fetchInboxKeysFn(fromHandle);
            const d = (inboxDevices || []).find(d => d.deviceId === deviceId);
            return d?.jwk || null;
          } catch { return null; }
        };

        const ok = await receiveCMK({
          from: peer,
          myDeviceId,
          payloads: [{ deviceId: myDeviceId, fromDeviceId, ivB64, ctB64 }],
          findSenderDeviceJwk: findSenderJwkWithFallback
        });
        if (ok) {
          console.log("✅ Authority: Fallback-CMK aus KV importiert (erster Bootstrap)");
          const importedCmk = await getCMKIfExists(peer);
          if (importedCmk) {
            const rotationIndex = await getRotationIndex(sid);
            const skBytes = await deriveSessionKeyBytesForRotation(importedCmk, sid, rotationIndex);
            sessionCache.set(sid, { ready: true, cmkBytes: importedCmk, skBytes, rotationIndex });
            return;
          }
        } else if (res?.payload) {
          console.warn("⚠️ Authority: KV-Payload gefunden aber Import fehlgeschlagen — kein neuer CMK erstellt");
          sessionStorage.removeItem(onceKey);
          return;
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

    // 🔐 CMK für alle Peer-Geräte verpacken
    const peerPayloads = await wrapCMKForInboxDevices(limitedDevices, cmk);

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
        payloads: peerPayloads
      })
    });

    // 🔑 Auch für eigene Devices wrappen → neues Authority-Device kann CMK aus KV holen
    let kvPayloads = peerPayloads;
    try {
      const myInboxDevices = await fetchInboxKeysFn(me);
      if (Array.isArray(myInboxDevices) && myInboxDevices.length > 0) {
        const myPayloads = await wrapCMKForInboxDevices(myInboxDevices.slice(-10), cmk);
        kvPayloads = [...peerPayloads, ...myPayloads];
        console.log("🔑 CMK auch für eigene Devices gewrappt:", myInboxDevices.length);
      }
    } catch (e) { console.warn("⚠️ CMK self-wrap fehlgeschlagen (non-fatal)", e); }

    // 💾 CMK persistent in KV speichern (Option C: Offline Recovery)
    try {
      await apiFetchFn("/e2e/cmk/store", {
        method: "POST",
        body: JSON.stringify({ to: peer, payloads: kvPayloads })
      });
      console.log("💾 CMK in KV gespeichert für", peer, "(peer +", kvPayloads.length - peerPayloads.length, "own devices)");
    } catch (e) {
      console.warn("⚠️ CMK KV-Store fehlgeschlagen (non-fatal)", e);
    }

    // Cache aktualisieren (rotation-aware)
    const rotationIndex = await getRotationIndex(sid);
    const skBytes = await deriveSessionKeyBytesForRotation(cmk, sid, rotationIndex);
    sessionCache.set(sid, { ready: true, cmkBytes: cmk, skBytes, rotationIndex });

  } catch (e) {
    // Guard zurücksetzen damit retry beim nächsten Aufruf möglich ist
    console.warn("⚠️ ensureBootstrapped fehlgeschlagen — Guard zurückgesetzt", e);
    sessionStorage.removeItem(onceKey);
  }
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

  // Cache aktualisieren (rotation-aware)
  const me = localStorage.getItem("my_user");
  const sid = dmSessionId(me, from);
  const rotationIndex = await getRotationIndex(sid);
  const skBytes = await deriveSessionKeyBytesForRotation(cmkBytes, sid, rotationIndex);
  sessionCache.set(sid, { ready: true, cmkBytes, skBytes, rotationIndex });

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

  // SessionKey ableiten (rotation-aware)
  const rotationIndex = await getRotationIndex(sid);
  const skBytes = await deriveSessionKeyBytesForRotation(cmkBytes, sid, rotationIndex);

  const entry = {
    ready: true,
    cmkBytes,
    skBytes,
    rotationIndex
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

    // 🔒 Race-Condition-Guard: Echter CMK könnte während des async Fallbacks
    // via receiveCMK() angekommen sein → Fallback verwerfen, echter CMK hat Vorrang.
    // onceKey bleibt gesetzt: verhindert weitere Fallback-Versuche in dieser Session.
    const existing = sessionCache.get(sid);
    if (existing?.ready) {
      console.log("⏭️ Fallback Bootstrap: echter CMK bereits im Cache — Fallback verworfen");
      return false;
    }

    // CMK persistent in KV für Authority speichern
    await apiFetchFn("/e2e/cmk/store", {
      method: "POST",
      body: JSON.stringify({ to: peer, payloads })
    });
    console.log("💾 Fallback CMK in KV gespeichert für Authority:", peer);

    // Cache aktualisieren (rotation-aware)
    const rotationIndex = await getRotationIndex(sid);
    const skBytes = await deriveSessionKeyBytesForRotation(cmk, sid, rotationIndex);

    // Letzter Check vor Cache-Schreiben (zweite async-Lücke nach KV-Store)
    if (sessionCache.get(sid)?.ready) {
      console.log("⏭️ Fallback Bootstrap: echter CMK nach KV-Store angekommen — Fallback verworfen");
      return false;
    }

    sessionCache.set(sid, { ready: true, cmkBytes: cmk, skBytes, rotationIndex });

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
export async function fetchAndStoreCMK(me, peer, apiFetchFn, fetchInboxKeysFn) {
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

    // Fallback: Sender-Key ggf. frisch aus Inbox laden (neues Authority-Device)
    const findSenderJwkWithFallback = async (fromHandle, deviceId) => {
      const cached = await findSenderDeviceJwk(fromHandle, deviceId);
      if (cached) return cached;
      if (!fetchInboxKeysFn) return null;
      try {
        const devices = await fetchInboxKeysFn(fromHandle);
        const d = (devices || []).find(d => d.deviceId === deviceId);
        return d?.jwk || null;
      } catch { return null; }
    };

    const ok = await receiveCMK({
      from: authority,
      myDeviceId,
      payloads: [{ deviceId: myDeviceId, fromDeviceId, ivB64, ctB64 }],
      findSenderDeviceJwk: findSenderJwkWithFallback
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
// ======================================================
// 🔄 EPOCH ROTATION
// ======================================================

/**
 * Empfänger: neuen Rotation-Index anwenden
 */
export async function handleEpochRotate(me, peer, newRotationIndex) {
  const sid = dmSessionId(me, peer);
  const cached = sessionCache.get(sid);

  if (!cached?.cmkBytes) {
    console.warn("⚠️ handleEpochRotate: kein CMK im Cache für", peer);
    return false;
  }

  if (newRotationIndex <= (cached.rotationIndex ?? 0)) {
    console.warn("⚠️ handleEpochRotate: alter Index ignoriert", newRotationIndex);
    return false;
  }

  const newSkBytes = await deriveSessionKeyBytesForRotation(cached.cmkBytes, sid, newRotationIndex);
  await setRotationIndex(sid, newRotationIndex);
  sessionCache.set(sid, { ...cached, skBytes: newSkBytes, rotationIndex: newRotationIndex });

  console.log("🔄 Epoch rotiert (Empfänger):", { peer, newRotationIndex });
  return true;
}

/**
 * Authority: Rotation auslösen und Peer benachrichtigen
 */
export async function rotateEpoch(me, peer, apiFetchFn) {
  if (!isAuthority(me, peer)) return false;

  const sid = dmSessionId(me, peer);
  const cached = sessionCache.get(sid);
  if (!cached?.ready || !cached?.cmkBytes) return false;

  const newRotationIndex = (cached.rotationIndex ?? 0) + 1;
  const newSkBytes = await deriveSessionKeyBytesForRotation(cached.cmkBytes, sid, newRotationIndex);

  await setRotationIndex(sid, newRotationIndex);
  sessionCache.set(sid, { ...cached, skBytes: newSkBytes, rotationIndex: newRotationIndex });

  try {
    await apiFetchFn("/chat/send", {
      method: "POST",
      body: JSON.stringify({
        to: peer,
        type: "epoch_rotate",
        sid,
        rotationIndex: newRotationIndex,
        e2e: false,
        v: 1,
        message: "__epoch_rotate__"
      })
    });
    await setLastRotationTime(sid, Date.now());
    console.log("🔄 Epoch rotation gesendet:", { peer, newRotationIndex });
    return true;
  } catch (e) {
    // Rollback
    const prevIndex = newRotationIndex - 1;
    const prevSkBytes = await deriveSessionKeyBytesForRotation(cached.cmkBytes, sid, prevIndex);
    await setRotationIndex(sid, prevIndex);
    sessionCache.set(sid, { ...cached, skBytes: prevSkBytes, rotationIndex: prevIndex });
    console.warn("⚠️ rotateEpoch fehlgeschlagen, zurückgesetzt", e);
    return false;
  }
}

// ======================================================
// 🔑 CMK ROTATION (Event-basiert: Device Add/Remove)
// ======================================================

/**
 * Authority: neuen CMK generieren, für alle Peer-Devices wrappen, senden.
 * rotationIndex wird NICHT zurückgesetzt — neuer CMK gilt ab currentIndex+1.
 */
export async function rotateCMK(me, peer, apiFetchFn, fetchInboxKeysFn) {
  if (!isAuthority(me, peer)) return false;

  const sid = dmSessionId(me, peer);
  const cached = sessionCache.get(sid);
  if (!cached?.ready) return false;

  const currentRotationIndex = cached.rotationIndex ?? 0;
  const fromRotationIndex = currentRotationIndex + 1;

  try {
    // Neuen CMK generieren und speichern
    const newCmkBytes = await createAndStoreCMK(peer);

    // Rotation-Map updaten (alter CMK 0..current, neuer CMK fromIndex+)
    await appendToRotationMap(sid, fromRotationIndex, newCmkBytes);

    // Neuen SK ableiten
    const newSkBytes = await deriveSessionKeyBytesForRotation(newCmkBytes, sid, fromRotationIndex);
    await setRotationIndex(sid, fromRotationIndex);
    sessionCache.set(sid, { ...cached, cmkBytes: newCmkBytes, skBytes: newSkBytes, rotationIndex: fromRotationIndex });

    // Peer-Devices laden und CMK wrappen
    const inboxDevices = await fetchInboxKeysFn(peer);
    if (!Array.isArray(inboxDevices) || inboxDevices.length === 0) {
      console.warn("⚠️ rotateCMK: keine Peer-Devices gefunden");
      return false;
    }
    const payloads = await wrapCMKForInboxDevices(inboxDevices.slice(-10), newCmkBytes);

    // cmk_rotate Control-Message senden
    await apiFetchFn("/chat/send", {
      method: "POST",
      body: JSON.stringify({
        to: peer,
        type: "cmk_rotate",
        sid,
        fromRotationIndex,
        payloads,
        e2e: false,
        v: 1,
        message: "__cmk_rotate__"
      })
    });

    // KV-Backup für Offline-Recovery
    try {
      await apiFetchFn("/e2e/cmk/store", {
        method: "POST",
        body: JSON.stringify({ to: peer, payloads })
      });
    } catch (e) {
      console.warn("⚠️ CMK KV-Backup fehlgeschlagen (non-fatal)", e);
    }

    console.log("🔑 CMK rotiert (Device-Event):", { peer, fromRotationIndex });
    return true;
  } catch (e) {
    console.warn("⚠️ rotateCMK fehlgeschlagen", e);
    return false;
  }
}

/**
 * Non-Authority: neuen CMK aus cmk_rotate Message empfangen und speichern.
 * @param findSenderDeviceJwkFn Optional: Fallback-Funktion für unbekannte Sender-Devices
 */
export async function receiveCMKRotation({ me, from, myDeviceId, fromRotationIndex, payloads, findSenderDeviceJwkFn }) {
  const sid = dmSessionId(me, from);

  // CMK entschlüsseln + in IDB speichern (nutzt bestehende receiveCMK-Logik)
  const ok = await receiveCMK({
    from,
    myDeviceId,
    payloads,
    findSenderDeviceJwk: findSenderDeviceJwkFn || findSenderDeviceJwk
  });
  if (!ok) return false;

  // Neu gespeicherten CMK laden
  const newCmkBytes = await getCMKIfExists(from);
  if (!newCmkBytes) return false;

  // Rotation-Map updaten
  await appendToRotationMap(sid, fromRotationIndex, newCmkBytes);

  // Neuen SK ableiten und Cache updaten
  const newSkBytes = await deriveSessionKeyBytesForRotation(newCmkBytes, sid, fromRotationIndex);
  await setRotationIndex(sid, fromRotationIndex);

  const cached = sessionCache.get(sid) || {};
  sessionCache.set(sid, {
    ...cached,
    cmkBytes: newCmkBytes,
    skBytes: newSkBytes,
    rotationIndex: fromRotationIndex,
    ready: true
  });

  console.log("🔑 CMK Rotation empfangen:", { from, fromRotationIndex });
  return true;
}
