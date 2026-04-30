// ======================================================
// Chat-Pipeline — E2E Send/Receive über deployed Crypto-Libs
// ======================================================
// Glue zwischen Svelte chat-store und den Crypto-Layern:
//   bytes / chatCrypto / cmk / session / messageSig / e2eKeys
//
// Spec: docs/MULTI_DEVICE.md §4.2 (Send), §4.4 (CMK-Distribution)
// ======================================================

import { apiFetch } from './api.js';
import { captureException } from './sentry.js';
import { getDeviceId } from './e2eKeys.js';
import {
  isPendingCmkReq, markPendingCmkReq, clearPendingCmkReq,
  isCmkUnavailable,
} from './cmkRequestState.js';
import {
  getOrCreateCMK, getCMKIfExists, importAndStoreCMKFromPeer,
  storePeerDevices, findSenderDeviceJwk, getSigPubForDevice,
  wrapCMKForInboxDevices, unwrapCMKFromPeer,
  createAndStoreCMK,
} from './cmk.js';
import {
  EPOCH_MS, dmSessionId,
  deriveSessionKeyBytes, deriveSessionKeyBytesForRotation,
  deriveMessageKey,
  getRotationMap, findCmkForRotationIndex,
} from './session.js';
import { e2eEncrypt, e2eDecrypt } from './chatCrypto.js';
import { signMessage, verifyMessageSig } from './messageSig.js';

// LRU für SK-Bytes pro (sid, rotationIndex) — vermeidet Re-Derivation pro Message
const _skCache = new Map();
const SK_CACHE_MAX = 50;
function _skCacheKey(sid, rotation) { return `${sid}:${rotation || 0}`; }
function _skCacheGet(sid, rotation) {
  const key = _skCacheKey(sid, rotation);
  if (!_skCache.has(key)) return null;
  const sk = _skCache.get(key);
  // Move to end (LRU)
  _skCache.delete(key);
  _skCache.set(key, sk);
  return sk;
}
function _skCacheSet(sid, rotation, sk) {
  const key = _skCacheKey(sid, rotation);
  if (_skCache.has(key)) _skCache.delete(key);
  _skCache.set(key, sk);
  if (_skCache.size > SK_CACHE_MAX) {
    _skCache.delete(_skCache.keys().next().value);
  }
}

// LRU für decrypted Messages — vermeidet Re-Decrypt beim Re-Render.
// Speichert {text, verified} damit verified-State nicht verloren geht wenn ein
// device_added eine zweite _decryptAllE2E-Runde triggert und die Cache-Hits
// die UI mit verified=null überschreiben würden.
const _decryptCache = new Map();
const DECRYPT_CACHE_MAX = 200;
function _decryptCacheGet(msgId) { return _decryptCache.get(msgId) || null; }
function _decryptCacheSet(msgId, text, verified) {
  if (_decryptCache.has(msgId)) _decryptCache.delete(msgId);
  _decryptCache.set(msgId, { text, verified });
  if (_decryptCache.size > DECRYPT_CACHE_MAX) {
    _decryptCache.delete(_decryptCache.keys().next().value);
  }
}

// ======================================================
// Peer-Inbox-Devices fetchen + cachen
// ======================================================

// Single-Flight: gleichzeitige Fetches für denselben Handle dedupen → 1 Netz-Call.
// Verhindert 429-Bursts wenn _decryptAllE2E 18 Messages parallel decryptet.
// Kein TTL nötig — der Eintrag wird gelöscht sobald die Promise resolved.
const _inFlightPeerDevices = new Map();
const _inFlightCmkFetch = new Map();

/**
 * Lädt + cached die Inbox-Devices eines Peers.
 * @returns {Promise<Array<{deviceId, jwk, sigPub?}>>}
 */
async function fetchPeerDevices(handle) {
  const k = String(handle || '').toLowerCase();
  const inFlight = _inFlightPeerDevices.get(k);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const r = await apiFetch(`/e2e/inbox/get?user=${encodeURIComponent(handle)}`);
    if (!r.ok || !Array.isArray(r.data?.devices)) return [];
    await storePeerDevices(handle, r.data.devices);
    return r.data.devices;
  })().finally(() => { _inFlightPeerDevices.delete(k); });

  _inFlightPeerDevices.set(k, promise);
  return promise;
}

// ======================================================
// CMK-Fetch + Unwrap (wenn CMK fehlt → vom Backend holen)
// ======================================================

/**
 * Holt + entwrappt eine CMK aus KV.
 *
 * @param {string} fromHandle
 * @param {{storeIfFresh?: boolean}} opts
 *   - storeIfFresh (default true): Wenn lokal noch KEIN CMK existiert, fetched
 *     CMK persistieren. WICHTIG: Bestehende lokale CMKs werden NIE überschrieben
 *     — das würde Divergenzen verschärfen (Mac hatte CMK_M, iPhone created CMK_iPhone,
 *     fetch overwrote CMK_M → Mac kann test9's Messages mit CMK_T9 nicht mehr lesen).
 */
async function tryFetchAndUnwrapCMK(fromHandle, opts = {}) {
  const { storeIfFresh = true } = opts;
  // Single-Flight pro (handle, storeIfFresh): 18 parallele decryptIncomingMessage
  // sollen NICHT 18× /e2e/cmk/fetch hämmern → sonst Cloudflare 429.
  // Verschiedene storeIfFresh-Werte separat keyen, weil das Verhalten differs.
  const cacheKey = `${String(fromHandle || '').toLowerCase()}|${storeIfFresh ? 1 : 0}`;
  const inFlight = _inFlightCmkFetch.get(cacheKey);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      const myDeviceId = getDeviceId();
      const r = await apiFetch(
        `/e2e/cmk/fetch?from=${encodeURIComponent(fromHandle)}&deviceId=${encodeURIComponent(myDeviceId)}`
      );
      if (!r.ok || !r.data?.payload) return null;

      const { fromDeviceId, ivB64, ctB64 } = r.data.payload;
      if (!fromDeviceId || !ivB64 || !ctB64) return null;

      let senderJwk = await findSenderDeviceJwk(fromHandle, fromDeviceId);
      if (!senderJwk) {
        const devs = await fetchPeerDevices(fromHandle);
        senderJwk = devs.find(d => d.deviceId === fromDeviceId)?.jwk || null;
      }
      if (!senderJwk) return null;

      const cmk = await unwrapCMKFromPeer(ivB64, ctB64, senderJwk);

      // Nur persistieren wenn lokal NOCH KEIN CMK existiert. Niemals überschreiben.
      if (storeIfFresh) {
        const existing = await getCMKIfExists(fromHandle);
        if (!existing) {
          await importAndStoreCMKFromPeer(fromHandle, cmk);
        }
      }
      return cmk;
    } catch (e) {
      captureException(e, { context: 'tryFetchAndUnwrapCMK', fromHandle });
      return null;
    }
  })().finally(() => { _inFlightCmkFetch.delete(cacheKey); });

  _inFlightCmkFetch.set(cacheKey, promise);
  return promise;
}

// ======================================================
// CMK-Distribution: bei NEUER CMK wrappen + an alle Devices schicken
// ======================================================

/**
 * Prüft ob es schon Chat-Historie zwischen me + peer gibt.
 * Wenn ja → CMK existiert irgendwo (auf älterem Device oder propagiert grad in KV).
 * Verhindert dann das Erstellen einer NEUEN CMK (würde divergente Sessions schaffen).
 */
async function hasChatHistory(peerHandle) {
  try {
    const r = await apiFetch(`/chat/list?with=${encodeURIComponent(peerHandle)}&limit=1`);
    return r.ok && Array.isArray(r.data?.messages) && r.data.messages.length > 0;
  } catch {
    return false;
  }
}

/**
 * Sicherer Session-Setup für DM mit Peer:
 * 1. Peer-Devices fetchen + cachen
 * 2. CMK aus IDB holen (oder neu erstellen)
 * 3. Falls neu erstellt: für alle Peer-Devices + eigene Devices wrappen,
 *    via /e2e/cmk/store ablegen
 *
 * Race-Schutz: bei existierender Chat-Historie wird KV mehrfach mit Backoff
 * gefetcht bevor eine neue CMK erstellt würde (würde sonst die existierende
 * gemeinsame CMK ersetzen → Divergenz).
 *
 * @returns {Promise<Uint8Array|null>} CMK, oder null bei Fehler
 */
export async function ensureSecureDmSession(myHandle, peerHandle) {
  try {
    // Hard-Stop: Peer hat cmk_unavailable signalisiert → nicht mehr versuchen.
    if (isCmkUnavailable(peerHandle)) {
      console.error(`❌ CMK für ${peerHandle} unrecoverable (cmk_unavailable empfangen).`);
      return null;
    }

    const peerDevices = await fetchPeerDevices(peerHandle);

    let cmk = await getCMKIfExists(peerHandle);
    if (cmk) return cmk;

    cmk = await tryFetchAndUnwrapCMK(peerHandle);
    if (cmk) return cmk;

    // Vor dem Erstellen einer NEUEN CMK: prüfen ob schon Historie existiert.
    // Wenn ja → CMK gibt's woanders, wir warten auf KV-Propagation ODER fragen aktiv.
    const hasHistory = await hasChatHistory(peerHandle);
    if (hasHistory) {
      console.warn(`⚠️ Chat-Historie mit ${peerHandle} existiert, aber CMK fehlt lokal+KV. Sende cmk_req…`);
      // Erstes Retry-Cycle: KV könnte gerade propagieren (z.B. Peer hat eben redistributed)
      for (const delay of [1500, 3000]) {
        await new Promise(r => setTimeout(r, delay));
        cmk = await tryFetchAndUnwrapCMK(peerHandle);
        if (cmk) {
          console.log(`✅ CMK nach ${delay}ms aus KV propagiert`);
          return cmk;
        }
      }
      // Aktive Anfrage: Peer soll seine CMK redistribuieren.
      // Dedup: wenn bereits ein cmk_req pending ist (z.B. von Decrypt-Pfad), nicht erneut senden.
      if (!isPendingCmkReq(peerHandle)) {
        console.warn(`📨 cmk_req → ${peerHandle}`);
        markPendingCmkReq(peerHandle);
        await sendCmkRequest(peerHandle);
      } else {
        console.log(`⏳ cmk_req für ${peerHandle} schon pending — warte`);
      }
      // 2. Retry-Cycle nach cmk_req — Peer braucht Zeit zum Antworten.
      // Falls cmk_unavailable inzwischen empfangen wurde → sofort abbrechen.
      for (const delay of [2000, 5000, 10000]) {
        await new Promise(r => setTimeout(r, delay));
        if (isCmkUnavailable(peerHandle)) {
          console.error(`❌ ${peerHandle} sendete cmk_unavailable während Wartezeit → abbrechen.`);
          return null;
        }
        cmk = await tryFetchAndUnwrapCMK(peerHandle);
        if (cmk) {
          console.log(`✅ CMK nach cmk_req + ${delay}ms erhalten`);
          clearPendingCmkReq(peerHandle);
          return cmk;
        }
      }
      // Aufgeben — Peer ist offline oder cmk_req nicht zugestellt.
      // KEINE neue CMK erstellen → würde Divergenz schaffen.
      console.error(`❌ CMK für ${peerHandle} nicht erreichbar (Peer evtl. offline). Send abgebrochen.`);
      return null;
    }

    // Wirklich frische Konversation → OK eine neue CMK zu erstellen
    cmk = await createAndStoreCMK(peerHandle);

    if (peerDevices.length === 0) {
      return cmk;
    }

    // Eigene Devices fetchen (für eigene Multi-Device-Verteilung)
    let myDevices = [];
    try {
      const me = await fetchPeerDevices(myHandle);
      myDevices = me;
    } catch {}

    // Empfänger = alle Peer-Devices + eigene Devices, MINUS dieses aktuelle Device
    const myDeviceId = getDeviceId();
    const recipients = [...peerDevices, ...myDevices].filter(d => d.deviceId !== myDeviceId);

    if (recipients.length > 0) {
      const payloads = await wrapCMKForInboxDevices(recipients, cmk);
      if (payloads.length > 0) {
        await apiFetch('/e2e/cmk/store', {
          method: 'POST',
          body: { to: peerHandle, payloads },
        });
      }
    }

    return cmk;
  } catch (e) {
    captureException(e, { context: 'ensureSecureDmSession', peerHandle });
    return null;
  }
}

// ======================================================
// Decrypt eingehender E2E-Message
// ======================================================

/**
 * Versucht eine E2E-Message zu decrypten + ihre Signatur zu prüfen.
 *
 * @param {object} msg - normalized message mit ivB64/ctB64 (oder iv_b64/ct_b64), sid, epoch, sig, deviceId, from, ts, rotationIndex
 * @param {string} myHandle
 * @param {string} peerHandle
 * @returns {Promise<{text: string|null, verified: boolean|null}>}
 *   text=null → konnte nicht decryptet werden
 *   verified=true → Sig korrekt, =false → Sig falsch (Tampering!), =null → Sig nicht prüfbar (kein sigPub)
 */
export async function decryptIncomingMessage(msg, myHandle, peerHandle) {
  // Cache-Hit — text + verified werden zusammen gespeichert damit ein 2.
  // _decryptAllE2E-Lauf (z.B. nach device_added) den verified-State nicht löscht.
  if (msg.id) {
    const cached = _decryptCacheGet(msg.id);
    if (cached) return { text: cached.text, verified: cached.verified };
  }

  // Hard-Stop: Peer hat cmk_unavailable gesendet → KV-Fetch sparen.
  if (isCmkUnavailable(peerHandle)) {
    return { text: null, verified: null };
  }

  const ivB64 = msg.ivB64 || msg.iv_b64;
  const ctB64 = msg.ctB64 || msg.ct_b64;
  if (typeof ivB64 !== 'string' || typeof ctB64 !== 'string') {
    return { text: null, verified: null };
  }

  const sid = msg.sid || dmSessionId(myHandle, peerHandle);
  const rotationIndex = typeof msg.rotation_index === 'number'
    ? msg.rotation_index
    : (typeof msg.rotationIndex === 'number' ? msg.rotationIndex : 0);

  const baseEpoch = typeof msg.epoch === 'number'
    ? msg.epoch
    : Math.floor((msg.ts || Date.now()) / EPOCH_MS);

  // Helper: gegebenes CMK durchprobieren über alle Epoch-Toleranzen
  async function tryDecryptWithCMK(cmkBytes) {
    let cmkForDerive = cmkBytes;
    if (rotationIndex > 0) {
      const map = await getRotationMap(sid);
      const historicCmk = findCmkForRotationIndex(map, rotationIndex);
      if (historicCmk) cmkForDerive = historicCmk;
    }
    const skBytes = await deriveSessionKeyBytesForRotation(cmkForDerive, sid, rotationIndex);

    for (const ep of [baseEpoch, baseEpoch - 1, baseEpoch + 1]) {
      try {
        const mk = await deriveMessageKey(skBytes, sid, ep);
        const decrypted = await e2eDecrypt(mk, ivB64, ctB64);
        if (typeof decrypted === 'string') return { decrypted, ep, skBytes };
      } catch {}
    }
    return null;
  }

  // 1. Versuche zuerst die Local-CMK (häufigster Pfad — eigene Messages, normale Konversation).
  let attempt = null;
  let cmk = await getCMKIfExists(peerHandle);
  if (cmk) {
    attempt = await tryDecryptWithCMK(cmk);
  }

  // 2. Fallback: bei Fehler ODER kein lokales CMK → KV-Fetch.
  // WICHTIG: storeIfFresh=false — niemals lokale CMK überschreiben mit der
  // KV-Variante. Sonst entstehen Divergenzen (siehe Bug-History).
  if (!attempt) {
    const fetchedCmk = await tryFetchAndUnwrapCMK(peerHandle, { storeIfFresh: !cmk });
    if (fetchedCmk) {
      const sameBytes = cmk && fetchedCmk.length === cmk.length &&
        fetchedCmk.every((b, i) => b === cmk[i]);
      if (!sameBytes) {
        attempt = await tryDecryptWithCMK(fetchedCmk);
      }
    }
  }

  if (!attempt) return { text: null, verified: null };

  const { decrypted, ep, skBytes } = attempt;
  _skCacheSet(sid, rotationIndex, skBytes);

  // Sig-Verify — Tampering-Schutz für ALLE Messages außer von DIESEM Device.
  // Eigene Messages von ANDEREN eigenen Devices werden ebenfalls verifiziert
  // (Multi-Device-Selbstkonsistenz: ein kompromittiertes eigenes Device könnte
  // sonst gefälschte Self-Echo schicken).
  let verified = null;
  const senderDeviceId = msg.deviceId || msg.device_id;
  const myDeviceId = getDeviceId();
  const isFromMyCurrentDevice = msg.from === myHandle && senderDeviceId === myDeviceId;

  if (!isFromMyCurrentDevice && senderDeviceId && msg.sig) {
    // sigPub aus cache; falls fehlt: peer-devices nachladen + retry.
    let sigPub = await getSigPubForDevice(msg.from, senderDeviceId);
    if (!sigPub) {
      // Cache-Miss: Devices vom Backend holen (Single-Flight in fetchPeerDevices)
      try {
        const devs = await fetchPeerDevices(msg.from);
        sigPub = devs.find(d => d.deviceId === senderDeviceId)?.sigPub || null;
      } catch {}
    }
    if (sigPub) {
      try {
        verified = await verifyMessageSig(ivB64, ctB64, sid, ep, msg.sig, sigPub);
        if (verified === false) {
          // Tampering! Loud-Log damit's im Sentry / Devtools sichtbar wird.
          console.error(
            `🚨 Sig-Verify FAILED — Message id=${String(msg.id).slice(0, 8)} ` +
            `from=${msg.from} deviceId=${senderDeviceId.slice(0, 8)} ` +
            `(Tampering oder Schlüssel-Mismatch)`
          );
        }
      } catch (e) {
        // Verify-Exception (z.B. Crypto-Fehler) → behandeln wie verified=null
        captureException(e, { context: 'verifyMessageSig', from: msg.from });
      }
    }
  }

  if (msg.id) _decryptCacheSet(msg.id, decrypted, verified);
  return { text: decrypted, verified };
}

// ======================================================
// Encrypt + Send für DM-Message
// ======================================================

/**
 * E2E-encryptet + signiert + sendet eine DM-Message via /chat/send.
 *
 * @returns {Promise<{ok: boolean, message?: object, error?: string}>}
 */
export async function sendEncryptedDm(myHandle, peerHandle, plaintext) {
  try {
    const cmk = await ensureSecureDmSession(myHandle, peerHandle);
    if (!cmk) {
      return { ok: false, error: 'no_cmk' };
    }

    const sid = dmSessionId(myHandle, peerHandle);
    let skBytes = _skCacheGet(sid, 0);
    if (!skBytes) {
      skBytes = await deriveSessionKeyBytes(cmk, sid);
      _skCacheSet(sid, 0, skBytes);
    }

    const epoch = Math.floor(Date.now() / EPOCH_MS);
    const mk = await deriveMessageKey(skBytes, sid, epoch);

    const { ivB64, ctB64 } = await e2eEncrypt(mk, plaintext);
    const sig = await signMessage(ivB64, ctB64, sid, epoch);
    const deviceId = getDeviceId();

    const r = await apiFetch('/chat/send', {
      method: 'POST',
      body: {
        to: peerHandle,
        e2e: true,
        v: 2,
        sid,
        epoch,
        ivB64,
        ctB64,
        sig,
        deviceId,
      },
    });

    if (!r.ok) return { ok: false, error: r.error || 'send_failed' };
    return { ok: true, message: r.data?.message };
  } catch (e) {
    captureException(e, { context: 'sendEncryptedDm', peerHandle });
    return { ok: false, error: e.message || 'unknown' };
  }
}

/**
 * Holt Peer-Devices, retry bis erwartete deviceId in der Liste ist.
 * Schützt gegen KV-Eventual-Consistency: nach device_added kann der KV-Index
 * auf dem Empfänger-Edge noch nicht propagiert sein.
 */
async function fetchPeerDevicesEnsuring(handle, expectedDeviceId, expectedJwk) {
  // Erstes Mal direkt fetchen
  let devs = await fetchPeerDevices(handle);
  if (!expectedDeviceId) return devs;

  // Wenn Device schon drin: fertig
  if (devs.some(d => d.deviceId === expectedDeviceId)) return devs;

  // Retry mit Backoff
  for (const delay of [400, 800, 1500, 3000]) {
    await new Promise(r => setTimeout(r, delay));
    devs = await fetchPeerDevices(handle);
    if (devs.some(d => d.deviceId === expectedDeviceId)) return devs;
  }

  // KV propagiert immer noch nicht — wir fügen das Device manuell aus dem Push hinzu.
  // Better than nothing: Peer-Cache wird mit dem Push-Info ergänzt.
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

/**
 * Re-distribuiert die lokale CMK an einen Peer und alle eigenen Devices.
 *
 * Bei device_added-Event mit deviceId+jwk im Push: redistribute mit
 * Garantie dass das neue Device in der wrap-Liste ist (KV-Eventual-
 * Consistency-Schutz).
 *
 * @param {string} myHandle
 * @param {string} peerHandle
 * @param {{deviceId?: string, jwk?: object}} [newDeviceInfo] - Info aus dem device_added Push
 * @returns {Promise<{ok: boolean, distributed: number}>}
 */
export async function redistributeCMKToPeer(myHandle, peerHandle, newDeviceInfo = null) {
  try {
    const cmk = await getCMKIfExists(peerHandle);
    if (!cmk) {
      // Wir haben selbst keine lokale CMK → Peer würde sonst endlos retryen.
      // Explizites cmk_unavailable signalisiert: bitte aufhören zu fragen.
      // Nur senden wenn der Peer-Request potenziell von einem cmk_req kam
      // (newDeviceInfo === null deutet auf cmk_req-Trigger; bei device_added wäre
      // newDeviceInfo gesetzt und der Request kommt nicht vom Peer-User).
      if (newDeviceInfo === null) {
        try { await sendCmkUnavailable(peerHandle); } catch {}
      }
      return { ok: false, distributed: 0, reason: 'no_local_cmk' };
    }

    // Peer-Devices fetchen — wenn newDeviceInfo bekannt, retry bis es drin ist
    const expectedPeerDeviceId = (newDeviceInfo && peerHandle === newDeviceInfo.fromHandle) ? newDeviceInfo.deviceId : null;
    const peerDevices = await fetchPeerDevicesEnsuring(peerHandle, expectedPeerDeviceId, newDeviceInfo?.jwk);
    if (peerDevices.length === 0) return { ok: true, distributed: 0 };

    // Eigene Devices: wenn newDeviceInfo Self-Event war, retry bis NEUES eigenes Device drin
    const expectedMyDeviceId = (newDeviceInfo && myHandle === newDeviceInfo.fromHandle) ? newDeviceInfo.deviceId : null;
    let myDevices = [];
    try {
      myDevices = await fetchPeerDevicesEnsuring(myHandle, expectedMyDeviceId, newDeviceInfo?.jwk);
    } catch {}

    const myDeviceId = getDeviceId();
    const recipients = [...peerDevices, ...myDevices].filter(d => d.deviceId !== myDeviceId);

    if (recipients.length === 0) return { ok: true, distributed: 0 };

    const payloads = await wrapCMKForInboxDevices(recipients, cmk);
    if (payloads.length === 0) return { ok: true, distributed: 0 };

    const r = await apiFetch('/e2e/cmk/store', {
      method: 'POST',
      body: { to: peerHandle, payloads },
    });

    return { ok: !!r.ok, distributed: payloads.length };
  } catch (e) {
    captureException(e, { context: 'redistributeCMKToPeer', peerHandle });
    return { ok: false, distributed: 0 };
  }
}

/**
 * Sendet eine cmk_req Control-Message an Peer.
 * Empfänger erhält via WS, ruft dann redistributeCMKToPeer für UNS auf
 * → unsere CMK landet in KV → wir können beim nächsten Fetch decrypten.
 *
 * Wird genutzt wenn ein neues Device joined, aber existing devices offline waren
 * (also keine Redistribution auf device_added stattfinden konnte).
 */
export async function sendCmkRequest(peerHandle) {
  try {
    const r = await apiFetch('/chat/send', {
      method: 'POST',
      body: {
        to: peerHandle,
        type: 'cmk_req',
        v: 1,
        e2e: false,
        message: '__cmk_req__',
      },
    });
    return { ok: !!r.ok };
  } catch (e) {
    captureException(e, { context: 'sendCmkRequest', peerHandle });
    return { ok: false };
  }
}

/**
 * Negative ACK auf einen `cmk_req`: signalisiert dem Peer, dass auch wir
 * die CMK nicht haben. Stoppt Retry-Loops und erlaubt Peer eine klare
 * Fehlermeldung anzuzeigen ("Konversation unwiederherstellbar").
 */
export async function sendCmkUnavailable(peerHandle) {
  try {
    const r = await apiFetch('/chat/send', {
      method: 'POST',
      body: {
        to: peerHandle,
        type: 'cmk_unavailable',
        v: 1,
        e2e: false,
        message: '__cmk_unavailable__',
      },
    });
    return { ok: !!r.ok };
  } catch (e) {
    captureException(e, { context: 'sendCmkUnavailable', peerHandle });
    return { ok: false };
  }
}

/**
 * Re-distribuiert CMKs für ALLE Kontakte an die aktuell registrierten
 * Devices (inkl. eigenem neuen Device).
 *
 * Wird gerufen bei `device_added`-Self-Event (msg.from === me):
 * Ein neues eigenes Device wurde registriert → existierende Devices müssen
 * ihre CMKs für jede aktive DM neu verteilen, damit das neue Device decrypten
 * kann.
 *
 * @param {string} myHandle
 * @param {string[]} peerHandles - Liste der DM-Kontakte (aus inboxStore.contacts)
 */
export async function redistributeCMKsForSelfDeviceAdded(myHandle, peerHandles, newDeviceInfo = null) {
  if (!Array.isArray(peerHandles) || peerHandles.length === 0) return;
  let success = 0;
  let skipped = 0;
  for (const peer of peerHandles) {
    try {
      const r = await redistributeCMKToPeer(myHandle, peer, newDeviceInfo);
      if (r.ok && r.distributed > 0) success++;
      else skipped++;
    } catch {
      skipped++;
    }
  }
  console.log(`📤 Self-device-added: CMK-Redistribution für ${peerHandles.length} Kontakte → ${success} verteilt, ${skipped} ohne lokale CMK`);
}

/**
 * Wird vom WS-Handler bei eingehendem `cmk_response`-Equivalent aufgerufen
 * (heute: erfolgreiches CMK-Fetch). Pending-Flag clearen, damit Decrypt-
 * Retries nicht mehr pausieren.
 */
export function notifyCmkArrived(peerHandle) {
  clearPendingCmkReq(peerHandle);
}

/**
 * Räumt SK + Decrypt-Caches beim Logout.
 */
export function clearChatPipelineCaches() {
  _skCache.clear();
  _decryptCache.clear();
}
