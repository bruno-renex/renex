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
  storePeerDevices, findSenderDeviceJwk, getSigPubForDevice, getSigPubHistoryForDevice,
  wrapCMKForInboxDevices, unwrapCMKFromPeer,
  createAndStoreCMK,
  incrementCmkEncryptCounter, rotateCMKForPeer,
} from './cmk.js';
import {
  EPOCH_MS, dmSessionId,
  deriveSessionKeyBytes, deriveSessionKeyBytesForRotation,
  deriveMessageKey,
  getRotationMap, findCmkForRotationIndex, appendToRotationMap,
} from './session.js';
import { e2eEncrypt, e2eDecrypt } from './chatCrypto.js';
import { wrapAttachmentPlaintext } from './attachmentCrypto.js';
import { signMessage, verifyMessageSig } from './messageSig.js';
import { sendChatWithPow } from './pow.js';
import { logWrapVerify } from './wrapSig.js';
import {
  ensureMyGSK, getMyGSK, getOrRequestPeerGSK, importGskAesKey,
  findMyGSKAtTs, findPeerGSKAtTs,
  nextGroupChainIndex, deriveGroupMessageKey,
  rotateMyGSK, ENCRYPT_ROTATE_THRESHOLD,
} from './groupCrypto.js';

// LRU für SK-Bytes pro (sid, rotationIndex) — vermeidet Re-Derivation pro Message
// Bei vielen Rotation-Indices (Multi-Device + älteren Konversationen) wäre 50 zu klein.
// 200 deckt komfortabel ~10 unique Rotation-Indices × 20 sid (Pro-Tier) ab.
const _skCache = new Map();
const SK_CACHE_MAX = 200;
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
// 1000 Einträge × ~150 B/Entry ≈ 150 KB Memory — bei 1000-Message-Chats deckt
// es einen vollständigen Re-Render ohne Cache-Miss ab (vorher: 800 Misses bei
// 1000 Messages → ~10s Re-Decrypt-Zeit).
const _decryptCache = new Map();
const DECRYPT_CACHE_MAX = 1000;
function _decryptCacheGet(msgId) { return _decryptCache.get(msgId) || null; }
/**
 * Decrypt-Cache für eine einzelne Message invalidieren — z.B. nach einem
 * Edit-Event, damit ein anschließender Chat-Reload die EDITIERTE Version
 * decryptet, nicht die gecachte alte.
 */
export function invalidateDecryptCacheFor(msgId) {
  if (msgId) _decryptCache.delete(msgId);
}
function _decryptCacheSet(msgId, text, verified, replyText = null) {
  if (_decryptCache.has(msgId)) _decryptCache.delete(msgId);
  _decryptCache.set(msgId, { text, verified, replyText });
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
export async function tryFetchAndUnwrapCMK(fromHandle, opts = {}) {
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

      // Phase 0.3 Dark-Launch: Wrap-Sig verifizieren + loggen (KEIN Reject).
      try { await logWrapVerify(r.data.payload, await getSigPubForDevice(fromHandle, fromDeviceId), `cmk ${fromHandle}/${fromDeviceId}`); } catch {}

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
 *
 * WICHTIG: System-Messages (type='system', z.B. "👤 guest_xxx joined the chat"
 * vom /invite/join-Handler) zählen NICHT als echte Chat-Historie — sie sind
 * Backend-generierte Marker, kein Hinweis auf eine existierende CMK. Wenn wir
 * sie als Historie zählen würden, blockiert das die Initial-CMK-Erstellung
 * beim ersten Send eines Gasts (Konversation wird permanent kaputt).
 * Limit auf 5 erhöht damit die ersten paar System-Messages ggfs. übersprungen
 * werden können bevor wir auf "keine echte Historie" entscheiden.
 */
async function hasChatHistory(peerHandle) {
  try {
    const r = await apiFetch(`/chat/list?with=${encodeURIComponent(peerHandle)}&limit=5`);
    if (!r.ok || !Array.isArray(r.data?.messages)) return false;
    const realMessages = r.data.messages.filter(m => m && m.type !== 'system');
    return realMessages.length > 0;
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
      // Guest-Peer-Spezial: Gäste können in „Local-Only-Fallback" landen.
      // Legacy /chat hat ein 3s/8s/20s/60s Background-Retry das die CMK in KV
      // hochlädt sobald unsere Inbox-Keys verfügbar sind. Wir warten geduldig
      // statt Authority-Override (der zerstört die Chance auf Recovery, weil
      // er KV mit unserer CMK überschreibt — Gast hat dann nirgendwo passenden
      // Schlüssel mehr für seine alten Messages).
      if (peerHandle.startsWith('guest_')) {
        console.warn(`⏳ Guest-Peer ${peerHandle}: warte auf Local-Only-CMK-Upload (Background-Retry)`);
        for (const delay of [3000, 5000, 10000, 15000]) {
          await new Promise(r => setTimeout(r, delay));
          if (isCmkUnavailable(peerHandle)) break;
          cmk = await tryFetchAndUnwrapCMK(peerHandle);
          if (cmk) {
            console.log(`✅ Gast-CMK aus KV nach ${delay}ms erhalten`);
            clearPendingCmkReq(peerHandle);
            return cmk;
          }
        }
        // Aufgeben — Gast hat nach insgesamt ~33s nicht uploaded.
        // KEIN Authority-Override (würde existing-encrypted-Messages permanent
        // unrecoverable machen). User sieht 🔓✗-Marker, aber neue Messages
        // werden funktionieren sobald Gast endlich in KV uploaded.
        console.warn(`⌛ Gast ${peerHandle} hat CMK noch nicht in KV — Messages bleiben 🔐 bis Gast uploaded`);
        clearPendingCmkReq(peerHandle);
        return null;
      }
      // Aufgeben — Peer ist offline oder cmk_req nicht zugestellt.
      // KEINE neue CMK erstellen → würde Divergenz schaffen.
      console.error(`❌ CMK für ${peerHandle} nicht erreichbar (Peer evtl. offline). Send abgebrochen.`);
      return null;
    }

    // Wirklich frische Konversation → OK eine neue CMK zu erstellen
    cmk = await createAndStoreCMK(peerHandle);

    // Peer-Devices wenn nötig retry-fetchen: bei frisch installiertem Peer-Device
    // ist `uploadInboxKeyIfNeeded` evtl. noch nicht durch, Backend sieht das Device
    // noch nicht im Index. Ohne Retry würden wir die CMK NUR lokal erstellen und
    // peer könnte sie nie aus KV holen → bleibt 🔐.
    let effectivePeerDevices = peerDevices;
    if (effectivePeerDevices.length === 0) {
      console.log(`⏳ ${peerHandle} hat noch keine Devices im Index — retry-fetch mit Backoff…`);
      for (const delay of [1000, 3000, 5000]) {
        await new Promise(r => setTimeout(r, delay));
        try {
          effectivePeerDevices = await fetchPeerDevices(peerHandle);
        } catch {}
        if (effectivePeerDevices.length > 0) {
          console.log(`✅ ${peerHandle} hat jetzt ${effectivePeerDevices.length} Device(s) nach ${delay}ms`);
          break;
        }
      }
      if (effectivePeerDevices.length === 0) {
        console.warn(`⚠️ ${peerHandle} hat nach ~9s immer noch keine Devices — CMK bleibt nur lokal, peer wird via cmk_req nachfragen müssen`);
        return cmk;
      }
    }

    // Eigene Devices fetchen (für eigene Multi-Device-Verteilung)
    let myDevices = [];
    try {
      const me = await fetchPeerDevices(myHandle);
      myDevices = me;
    } catch {}

    // Empfänger = alle Peer-Devices + eigene Devices, MINUS dieses aktuelle Device
    const myDeviceId = getDeviceId();
    const recipients = [...effectivePeerDevices, ...myDevices].filter(d => d.deviceId !== myDeviceId);

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

/**
 * Re-publish den lokalen CMK an alle Peer- und Eigen-Devices unter dem AKTUELLEN
 * `myHandle`. Notwendig nach Guest-Convert: `migrateMyHandle` re-encryptet das
 * lokale CMK auf den neuen Storage-Key, aber der KV-Wrap (`e2e:cmk:${cid}:*`)
 * liegt weiterhin unter dem alten `cid = [guest_xxx, peer].sort()`. Wenn der
 * Empfänger den Convert verpasst hat, sucht er unter `[realHandle, peer].sort()`
 * und findet nichts → `cmk_req` → Sender offline → unrecoverable.
 *
 * Idempotent — `/e2e/cmk/store` überschreibt einen existing KV-Eintrag mit
 * identischem Wrap als no-op aus Sicht des Empfängers.
 *
 * @returns {Promise<{ok: boolean, wrapped?: number, reason?: string}>}
 */
export async function republishCMKForPeer(myHandle, peerHandle) {
  try {
    const cmk = await getCMKIfExists(peerHandle);
    if (!cmk) return { ok: false, reason: 'no_local_cmk' };

    const peerDevices = await fetchPeerDevices(peerHandle);
    let myDevices = [];
    try {
      myDevices = await fetchPeerDevices(myHandle);
    } catch {}

    const myDeviceId = getDeviceId();
    const recipients = [...peerDevices, ...myDevices].filter(d => d.deviceId !== myDeviceId);
    if (recipients.length === 0) {
      return { ok: false, reason: 'no_recipients' };
    }

    const payloads = await wrapCMKForInboxDevices(recipients, cmk);
    if (payloads.length === 0) {
      return { ok: false, reason: 'no_wraps' };
    }

    const r = await apiFetch('/e2e/cmk/store', {
      method: 'POST',
      body: { to: peerHandle, payloads },
    });
    return { ok: r.ok === true, wrapped: payloads.length };
  } catch (e) {
    captureException(e, { context: 'republishCMKForPeer', peerHandle });
    return { ok: false, reason: 'exception' };
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
 * @returns {Promise<{text: string|null, verified: boolean|null, replyText?: string|null}>}
 *   text=null → konnte nicht decryptet werden
 *   verified=true → Sig korrekt, =false → Sig falsch (Tampering!), =null → Sig nicht prüfbar (kein sigPub)
 *   replyText → Decryptete Reply-Preview, null wenn keine vorhanden / decrypt failed
 */
export async function decryptIncomingMessage(msg, myHandle, peerHandle) {
  // Cache-Hit — text + verified werden zusammen gespeichert damit ein 2.
  // _decryptAllE2E-Lauf (z.B. nach device_added) den verified-State nicht löscht.
  if (msg.id) {
    const cached = _decryptCacheGet(msg.id);
    if (cached) return { text: cached.text, verified: cached.verified, replyText: cached.replyText, _cached: true };
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

  // Helper: gegebenes CMK durchprobieren über alle Epoch-Toleranzen.
  // Strategie: Mehrere Kandidaten-CMKs sequenziell probieren — Rotation-Map-Eintrag
  // (falls für rotation_index vorhanden) ZUERST, dann den passed-in CMK als Fallback.
  // Begründung für Fallback: Bundle-Restore kann eine stale Rotation-Map zurückbringen
  // (alter CMK bei index=0 obwohl peer seit Restore neuen CMK verwendet). Ohne Fallback
  // würden NEW Messages mit rotation_index=0 IMMER mit dem stale CMK probiert und failen.
  async function tryDecryptWithCMK(cmkBytes) {
    const candidates = [];
    const _eq = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);

    // 1. Rotation-Map-Eintrag bevorzugt (historische Messages aus Vor-Rotation-Zeit)
    const map = await getRotationMap(sid);
    if (map.length > 0) {
      const historicCmk = findCmkForRotationIndex(map, rotationIndex);
      if (historicCmk) candidates.push(historicCmk);
    }
    // 2. Passed-in CMK als Fallback — schützt gegen stale Rotation-Map
    if (cmkBytes && !candidates.some(c => _eq(c, cmkBytes))) {
      candidates.push(cmkBytes);
    }

    for (const cand of candidates) {
      const skBytes = await deriveSessionKeyBytesForRotation(cand, sid, rotationIndex);
      for (const ep of [baseEpoch, baseEpoch - 1, baseEpoch + 1]) {
        try {
          const mk = await deriveMessageKey(skBytes, sid, ep);
          const decrypted = await e2eDecrypt(mk, ivB64, ctB64);
          if (typeof decrypted === 'string') return { decrypted, ep, skBytes };
        } catch {}
      }
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

  // 3. Letzter Fallback: Decrypt persistent gescheitert → cmk_req.
  // Use-Cases:
  //   a) Fresh-Install (kein local CMK): peer hat noch nicht redistributed
  //   b) CMK-Divergenz: lokales CMK ist da, aber peer hat rotiert und der neue
  //      CMK ist weder lokal noch in KV-wrap-für-uns. Peer muss zur Antwort
  //      auf cmk_req aktiv den aktuellen CMK redistributen.
  //
  // Dedup via isPendingCmkReq: bei _decryptAllE2E-Sweep (30 Messages parallel)
  // wird cmk_req nur 1× gesendet (30s pending-Window), alle Calls warten auf
  // gleiches KV-Resultat. Bei sequentiellen Fails greift dieselbe 30s-Sperre →
  // kein Spam.
  if (!attempt && !isCmkUnavailable(peerHandle)) {
    const alreadyPending = isPendingCmkReq(peerHandle);
    if (!alreadyPending) {
      markPendingCmkReq(peerHandle);
      console.warn(`📨 decryptIncomingMessage: cmk_req → ${peerHandle} (decrypt-fail, hadLocal=${!!cmk})`);
      try { await sendCmkRequest(peerHandle); } catch {}
    }
    // Retry-Loop: warte auf KV-Propagation nach cmk_req. Kurze Delays —
    // bei _decryptAllE2E-Parallelität warten alle Calls auf dieselbe KV-Hydration.
    for (const delay of [1500, 3000, 5000]) {
      await new Promise(r => setTimeout(r, delay));
      if (isCmkUnavailable(peerHandle)) break;  // Peer hat „nein" gesagt
      // storeIfFresh nur wenn wir KEIN lokales CMK hatten — sonst lassen wir das
      // aktive lokale CMK intakt (Divergenz-Schutz). Decrypt-Versuch mit dem
      // gefetchten Wert findet trotzdem statt.
      const freshCmk = await tryFetchAndUnwrapCMK(peerHandle, { storeIfFresh: !cmk });
      if (freshCmk instanceof Uint8Array && freshCmk.length === 32) {
        // Skip wenn fetched == bereits-probiertes lokales — sonst Endlosschleife
        const sameAsLocal = cmk && freshCmk.length === cmk.length &&
          freshCmk.every((b, i) => b === cmk[i]);
        if (!sameAsLocal) {
          attempt = await tryDecryptWithCMK(freshCmk);
          if (attempt) {
            console.log(`✅ decryptIncomingMessage: CMK nach cmk_req + ${delay}ms erhalten`);
            clearPendingCmkReq(peerHandle);  // Erfolg → flag freigeben
            break;
          }
        }
      }
    }
    // ACHTUNG: Bei Fail KEIN clearPendingCmkReq — das 30s-Timeout aus
    // markPendingCmkReq sorgt für automatische Freigabe. Vorzeitig zu clearen
    // würde sofortigen Re-Spam aus parallelen Decrypt-Calls erlauben (cmk_req-
    // Storm zwischen beiden Seiten wenn Messages permanent unrecoverable sind).
  }

  if (!attempt) return { text: null, verified: null };

  const { decrypted, ep, skBytes } = attempt;
  _skCacheSet(sid, rotationIndex, skBytes);

  // Reply-Preview entschlüsseln, wenn vorhanden — selbe mk wie Hauptbody.
  // Fehler hier sind nicht-fatal: Hauptmessage bleibt sichtbar, Preview einfach leer.
  let replyText = null;
  const replyIv = msg.replyIv || msg.reply_iv;
  const replyCt = msg.replyCt || msg.reply_ct;
  if (typeof replyIv === 'string' && typeof replyCt === 'string') {
    try {
      const mkReply = await deriveMessageKey(skBytes, sid, ep);
      replyText = await e2eDecrypt(mkReply, replyIv, replyCt);
    } catch {
      replyText = null;
    }
  }

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
          // Verify gegen aktuelles sigPub fehlgeschlagen — meistens Device-Key-Rotation
          // (Recovery, Re-Registration). Historische Pubkeys durchprobieren.
          const history = await getSigPubHistoryForDevice(msg.from, senderDeviceId);
          let historicMatch = false;
          for (const entry of history) {
            if (!entry?.jwk) continue;
            try {
              const ok = await verifyMessageSig(ivB64, ctB64, sid, ep, msg.sig, entry.jwk);
              if (ok === true) {
                historicMatch = true;
                verified = true;
                console.log(
                  `🔐 Sig-Verify via historic pubkey OK — id=${String(msg.id).slice(0, 8)} ` +
                  `from=${msg.from} deviceId=${senderDeviceId.slice(0, 8)} ` +
                  `(retired ${new Date(entry.retiredAt || 0).toISOString().slice(0, 10)})`
                );
                break;
              }
            } catch {}
          }
          if (!historicMatch) {
            // Auch History matcht nicht → echtes Tampering oder verlorene Historie.
            // Loud-Log damit's im Sentry / Devtools sichtbar wird.
            console.error(
              `🚨 Sig-Verify FAILED — Message id=${String(msg.id).slice(0, 8)} ` +
              `from=${msg.from} deviceId=${senderDeviceId.slice(0, 8)} ` +
              `(weder aktueller noch historischer Pubkey passt — möglicherweise Tampering)`
            );
          }
        }
      } catch (e) {
        // Verify-Exception (z.B. Crypto-Fehler) → behandeln wie verified=null
        captureException(e, { context: 'verifyMessageSig', from: msg.from });
      }
    }
  }

  if (msg.id) _decryptCacheSet(msg.id, decrypted, verified, replyText);
  return { text: decrypted, verified, replyText };
}

// ======================================================
// Encrypt + Send für DM-Message
// ======================================================

/**
 * E2E-encryptet + signiert + sendet eine DM-Message via /chat/send.
 *
 * @param {string} myHandle
 * @param {string} peerHandle
 * @param {string} plaintext
 * @param {{id: string, from: string, text: string}} [replyTo] - Quote-Reply auf eine andere Message.
 *   `text` wird mit derselben mk wie der Hauptbody verschlüsselt → Preview ist E2E-geschützt.
 * @returns {Promise<{ok: boolean, message?: object, error?: string}>}
 */
export async function sendEncryptedDm(myHandle, peerHandle, plaintext, replyTo = null, attachment = null) {
  try {
    const cmk = await ensureSecureDmSession(myHandle, peerHandle);
    if (!cmk) {
      return { ok: false, error: 'no_cmk' };
    }

    const sid = dmSessionId(myHandle, peerHandle);

    // Aktueller rotation_index aus der Map (falls Rotation passiert ist).
    // Map-Last-Eintrag enthält den höchsten fromIndex = derjenige für den
    // neue Sends. Bei Initial-Setup ohne Rotation: Map leer → rotIdx=0.
    const map = await getRotationMap(sid);
    const rotationIndex = map.length > 0
      ? map[map.length - 1].fromIndex
      : 0;

    let skBytes = _skCacheGet(sid, rotationIndex);
    if (!skBytes) {
      skBytes = rotationIndex > 0
        ? await deriveSessionKeyBytesForRotation(cmk, sid, rotationIndex)
        : await deriveSessionKeyBytes(cmk, sid);
      _skCacheSet(sid, rotationIndex, skBytes);
    }

    const epoch = Math.floor(Date.now() / EPOCH_MS);
    const mk = await deriveMessageKey(skBytes, sid, epoch);

    // Wenn ein Attachment dabei ist: Plaintext zu strukturiertem Envelope wrappen.
    // Server sieht NUR den encrypted body — Filename/MIME/fileKey bleiben privat.
    const wrappedPlaintext = attachment
      ? wrapAttachmentPlaintext(plaintext, attachment)
      : plaintext;

    const { ivB64, ctB64 } = await e2eEncrypt(mk, wrappedPlaintext);
    const sig = await signMessage(ivB64, ctB64, sid, epoch);
    const deviceId = getDeviceId();

    const body = {
      to: peerHandle,
      e2e: true,
      v: 2,
      sid,
      epoch,
      ivB64,
      ctB64,
      sig,
      deviceId,
    };

    // Attachment-Plaintext-Felder für DB (Cleanup-Cron + nicht-encrypted Listing).
    // attachmentKey = R2-Pfad. fileKey/iv/name/mime/size bleiben im encrypted Body.
    if (attachment?.r2Key) {
      body.attachmentKey  = attachment.r2Key;
      body.attachmentType = attachment.type;
    }

    // rotation_index nur mitschicken wenn > 0 (Default 0 schadet nicht, aber
    // unnötiges Body-Field für die Mehrheit der Sends).
    if (rotationIndex > 0) {
      body.rotationIndex = rotationIndex;
    }

    if (replyTo && replyTo.id && typeof replyTo.text === 'string') {
      // Preview auf max 200 Zeichen kappen — verhindert riesige reply_ct in DB
      const previewText = replyTo.text.length > 200
        ? replyTo.text.slice(0, 200) + '…'
        : replyTo.text;
      const enc = await e2eEncrypt(mk, previewText);
      body.replyToId = replyTo.id;
      body.replyFrom = replyTo.from;
      body.replyIv = enc.ivB64;
      body.replyCt = enc.ctB64;
    }

    // L1 Proof-of-Work: Nonce über (sid|epoch|sig) anhängen, Reject-Retry bei pow_weak.
    const r = await sendChatWithPow(body, { sid, epoch, sig, ctB64 });

    if (!r.ok) return { ok: false, error: r.error || 'send_failed' };

    // Auto-Rotate-Threshold (NIST SP 800-38D §8.3): per-CMK Encrypt-Counter
    // tracken. Bei Reach prophylaktisch CMK rotieren — fire-and-forget,
    // blockt den Send nicht. Counter wird in rotateCMKForPeer reset auf 0.
    void incrementCmkEncryptCounter(peerHandle).then(count => {
      if (count >= ENCRYPT_ROTATE_THRESHOLD) {
        console.warn(`⚠️ CMK auto-rotate: threshold ${ENCRYPT_ROTATE_THRESHOLD} reached for peer ${peerHandle}`);
        return rotateCMKForPeer(myHandle, peerHandle).catch(e =>
          captureException(e, { context: 'auto-rotate-cmk', peerHandle })
        );
      }
    }).catch(() => {});

    return { ok: true, message: r.data?.message };
  } catch (e) {
    captureException(e, { context: 'sendEncryptedDm', peerHandle });
    return { ok: false, error: e.message || 'unknown' };
  }
}

// ── PULSE (Phase 6.5) — E2E-verschlüsselter Presence-Skalar ──────────────
// Sendet/empfängt {energy, mode} über die GLEICHE Session-CMK-Pipeline wie DMs,
// aber als type:"pulse": kein D1-Write (Backend-Short-Circuit), KEINE Signatur
// (Pulse hat keine Authority — Belief-Layer, PULSE.md §8.2). Der Message-Key
// wird pro (sid, epoch, rotationIndex) gecacht, weil Frames mit bis zu 10 Hz
// kommen — sonst würde jede Frame HKDF + ggf. ensureSecureDmSession triggern.

let _pulseSendMk = null, _pulseSendKey = '';
let _pulseDecMk = null,  _pulseDecKey = '';

async function _pulseMk(myHandle, peerHandle, sid, epoch, rotationIndex, which) {
  const cacheKey = `${sid}|${epoch}|${rotationIndex}`;
  if (which === 'send' && _pulseSendKey === cacheKey && _pulseSendMk) return _pulseSendMk;
  if (which === 'dec'  && _pulseDecKey  === cacheKey && _pulseDecMk)  return _pulseDecMk;
  // WICHTIG: Pulse darf KEINE CMK-Etablierung ANSTOSSEN. ensureSecureDmSession
  // geht bei fehlendem lokalem CMK in lange Retry-/Key-Exchange-Schleifen (17s+);
  // der Controller würde das alle ~1.2s anhämmern → blockiert sich selbst nach
  // Reload (CMK noch nicht warm), heilt nicht von allein (Bug: erst Toggle-Off/On
  // hilft). Stattdessen nur einen BESTEHENDEN CMK lesen (lokal, kein Netz). Fehlt
  // er, wird der Frame still übersprungen — sobald der CMK da ist (Bundle-Restore
  // oder normaler Chat-Verlauf), sendet/empfängt Pulse von selbst wieder.
  const cmk = await getCMKIfExists(peerHandle);
  if (!cmk) return null;
  let skBytes = _skCacheGet(sid, rotationIndex);
  if (!skBytes) {
    skBytes = rotationIndex > 0
      ? await deriveSessionKeyBytesForRotation(cmk, sid, rotationIndex)
      : await deriveSessionKeyBytes(cmk, sid);
    _skCacheSet(sid, rotationIndex, skBytes);
  }
  const mk = await deriveMessageKey(skBytes, sid, epoch);
  if (which === 'send') { _pulseSendMk = mk; _pulseSendKey = cacheKey; }
  else { _pulseDecMk = mk; _pulseDecKey = cacheKey; }
  return mk;
}

/**
 * Sendet einen Pulse-Frame {energy, mode} an einen Peer. Throttling (≤10Hz)
 * macht der Aufrufer. Keine Signatur, kein D1. Fehler werden geschluckt —
 * Pulse-Drop ist akzeptabel, niemals den Chat stören.
 */
export async function sendPulse(myHandle, peerHandle, energy, mode) {
  try {
    const sid = dmSessionId(myHandle, peerHandle);
    const map = await getRotationMap(sid);
    const rotationIndex = map.length > 0 ? map[map.length - 1].fromIndex : 0;
    const epoch = Math.floor(Date.now() / EPOCH_MS);
    const mk = await _pulseMk(myHandle, peerHandle, sid, epoch, rotationIndex, 'send');
    if (!mk) return { ok: false, error: 'no_cmk' };
    const payload = JSON.stringify({ energy: Math.round(energy * 100) / 100, mode });
    const { ivB64, ctB64 } = await e2eEncrypt(mk, payload);
    const body = { to: peerHandle, e2e: true, v: 2, type: 'pulse', sid, epoch, ivB64, ctB64, deviceId: getDeviceId() };
    if (rotationIndex > 0) body.rotationIndex = rotationIndex;
    const r = await apiFetch('/chat/send', { method: 'POST', body });
    return r.ok ? { ok: true } : { ok: false, error: r.error || 'send_failed' };
  } catch (e) {
    return { ok: false, error: e.message || 'unknown' };
  }
}

/**
 * Sendet ein „Nicken" (digitaler Blickkontakt) an den Peer — ein einmaliges
 * Event über denselben E2E-Pulse-Kanal (Payload `{ nod: true }`). Kein D1, keine
 * Signatur. Aufrufer drosselt (Cooldown). Fehler werden geschluckt.
 */
export async function sendNod(myHandle, peerHandle) {
  try {
    const sid = dmSessionId(myHandle, peerHandle);
    const map = await getRotationMap(sid);
    const rotationIndex = map.length > 0 ? map[map.length - 1].fromIndex : 0;
    const epoch = Math.floor(Date.now() / EPOCH_MS);
    const mk = await _pulseMk(myHandle, peerHandle, sid, epoch, rotationIndex, 'send');
    if (!mk) return { ok: false, error: 'no_cmk' };
    const { ivB64, ctB64 } = await e2eEncrypt(mk, JSON.stringify({ nod: true }));
    const body = { to: peerHandle, e2e: true, v: 2, type: 'pulse', sid, epoch, ivB64, ctB64, deviceId: getDeviceId() };
    if (rotationIndex > 0) body.rotationIndex = rotationIndex;
    const r = await apiFetch('/chat/send', { method: 'POST', body });
    return r.ok ? { ok: true } : { ok: false, error: r.error || 'send_failed' };
  } catch (e) {
    return { ok: false, error: e.message || 'unknown' };
  }
}

/**
 * Entschlüsselt einen eingehenden Pulse-Frame. `msg` = WS-Event
 * {from, sid, epoch, rotationIndex, ivB64, ctB64}. Gibt {energy, mode}, {nod:true}
 * oder null.
 */
export async function decryptPulse(msg, myHandle) {
  try {
    const peer = String(msg.from || '').toLowerCase();
    if (!peer || !msg.ivB64 || !msg.ctB64) return null;
    const sid = msg.sid || dmSessionId(myHandle, peer);
    const rotationIndex = (typeof msg.rotationIndex === 'number' && msg.rotationIndex > 0) ? msg.rotationIndex : 0;
    const epoch = (typeof msg.epoch === 'number') ? msg.epoch : Math.floor((msg.ts || Date.now()) / EPOCH_MS);
    const mk = await _pulseMk(myHandle, peer, sid, epoch, rotationIndex, 'dec');
    if (!mk) return null;
    const plain = await e2eDecrypt(mk, msg.ivB64, msg.ctB64);
    const parsed = JSON.parse(plain);
    if (parsed.nod === true) return { nod: true };
    if (typeof parsed.energy !== 'number') return null;
    return { energy: parsed.energy, mode: parsed.mode };
  } catch {
    return null;
  }
}

/**
 * Editiert eine eigene E2E-DM-Message: encrypted neuen Plaintext mit der mk
 * der Original-Message (gleiche sid + epoch + rotationIndex) und schickt
 * `{iv, ct}` als JSON-String an `/chat/message/edit`. Das Backend setzt
 * `edited_message` + `edited_at` und broadcastet `message_edited` an Peer/Group.
 *
 * @param {string} myHandle
 * @param {string} peerHandle
 * @param {object} originalMsg - Raw-Backend-Message mit sid, epoch, rotation_index
 * @param {string} msgId
 * @param {string} newPlaintext
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function editEncryptedDm(myHandle, peerHandle, originalMsg, msgId, newPlaintext) {
  try {
    const cmk = await ensureSecureDmSession(myHandle, peerHandle);
    if (!cmk) return { ok: false, error: 'no_cmk' };

    const sid = originalMsg.sid || dmSessionId(myHandle, peerHandle);
    const rotationIndex = typeof originalMsg.rotation_index === 'number'
      ? originalMsg.rotation_index
      : (typeof originalMsg.rotationIndex === 'number' ? originalMsg.rotationIndex : 0);
    const epoch = typeof originalMsg.epoch === 'number'
      ? originalMsg.epoch
      : Math.floor((originalMsg.ts || Date.now()) / EPOCH_MS);

    let cmkForDerive = cmk;
    // Map IMMER konsultieren (nicht nur rotation_index>0) — die Original-Message
    // wurde mit dem CMK encrypted, das damals active war. Nach einer Rotation
    // ist das in der Map archiviert mit fromIndex=0. Edit muss mit demselben
    // CMK arbeiten, sonst kann der Empfänger es nicht decrypten.
    {
      const map = await getRotationMap(sid);
      if (map.length > 0) {
        const historicCmk = findCmkForRotationIndex(map, rotationIndex);
        if (historicCmk) cmkForDerive = historicCmk;
      }
    }
    let skBytes = _skCacheGet(sid, rotationIndex);
    if (!skBytes) {
      skBytes = await deriveSessionKeyBytesForRotation(cmkForDerive, sid, rotationIndex);
      _skCacheSet(sid, rotationIndex, skBytes);
    }

    const mk = await deriveMessageKey(skBytes, sid, epoch);
    const { ivB64, ctB64 } = await e2eEncrypt(mk, newPlaintext);
    // Neue Sig über (neue iv, neue ct, sid, epoch). Ohne diese würde sig-verify
    // beim Empfänger fehlschlagen (Sig in DB-Row gehört zur ORIGINAL-iv/ct, nicht
    // zur editierten) → falsche "Manipulation möglich"-Warnung.
    const sig = await signMessage(ivB64, ctB64, sid, epoch);

    // Backend erwartet `ciphertext` als JSON-String mit {iv, ct, sig}.
    // rotationIndex wird optional separat als Body-Field mitgegeben.
    const ciphertext = JSON.stringify({ iv: ivB64, ct: ctB64, sig });
    const r = await apiFetch('/chat/message/edit', {
      method: 'POST',
      body: { id: msgId, ciphertext, rotationIndex },
    });

    if (!r.ok) return { ok: false, error: r.error || 'edit_failed' };
    // Decrypt-Cache invalidieren, damit nachfolgende _decryptOne-Calls nicht den alten Text liefern
    _decryptCache.delete(msgId);
    return { ok: true };
  } catch (e) {
    captureException(e, { context: 'editEncryptedDm', peerHandle });
    return { ok: false, error: e.message || 'unknown' };
  }
}

/**
 * Decrypted das ciphertext-Feld eines `message_edited`-Events.
 * Format: `ciphertext` ist JSON-String `{iv, ct, rotationIndex?}`.
 *
 * @returns {Promise<string|null>} Plaintext oder null bei Decrypt-Fehler
 */
export async function decryptEditedMessage(event, originalMsg, myHandle, peerHandle) {
  try {
    let parsed;
    try { parsed = JSON.parse(event.ciphertext || ''); } catch { return null; }
    const ivB64 = parsed.iv;
    const ctB64 = parsed.ct;
    if (typeof ivB64 !== 'string' || typeof ctB64 !== 'string') return null;

    const sid = originalMsg.sid || dmSessionId(myHandle, peerHandle);
    const rotationIndex = typeof event.rotationIndex === 'number'
      ? event.rotationIndex
      : (typeof parsed.rotationIndex === 'number' ? parsed.rotationIndex : 0);
    const epoch = typeof originalMsg.epoch === 'number'
      ? originalMsg.epoch
      : Math.floor((originalMsg.ts || Date.now()) / EPOCH_MS);

    let cmk = await getCMKIfExists(peerHandle);
    if (!cmk) {
      cmk = await tryFetchAndUnwrapCMK(peerHandle, { storeIfFresh: true });
      if (!cmk) return null;
    }
    let cmkForDerive = cmk;
    // Map IMMER konsultieren (nicht nur rotation_index>0) — siehe oben in
    // editEncryptedDm/decryptIncomingMessage.
    {
      const map = await getRotationMap(sid);
      if (map.length > 0) {
        const historicCmk = findCmkForRotationIndex(map, rotationIndex);
        if (historicCmk) cmkForDerive = historicCmk;
      }
    }
    const skBytes = await deriveSessionKeyBytesForRotation(cmkForDerive, sid, rotationIndex);

    for (const ep of [epoch, epoch - 1, epoch + 1]) {
      try {
        const mk = await deriveMessageKey(skBytes, sid, ep);
        const text = await e2eDecrypt(mk, ivB64, ctB64);
        if (typeof text === 'string') return text;
      } catch {}
    }
    return null;
  } catch (e) {
    captureException(e, { context: 'decryptEditedMessage', peerHandle });
    return null;
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

// ── Mirror-Rotate Idempotenz-Layer ─────────────────────
// Schützt gegen:
//   1. Doppelte WS-Events (Reconnect-Replay) → 2× mirrorRotate für gleichen peer
//   2. Parallele self-revoke + peer-revoke Triggers
//   3. Sequenzielle Re-Triggers innerhalb der KV-Propagations-Fensters
// Ohne diesen Layer: ~32s erfolgloser Retry-Loop pro Duplikat (KV-Race-Backoff).
const _mirrorRotateInFlight = new Map();   // peerHandle → Promise<result>
const _mirrorRotateCooldown = new Map();   // peerHandle → ts
const MIRROR_ROTATE_COOLDOWN_MS = 30_000;  // 30s nach success keine Re-Tries

/**
 * Mirror-Rotation auf der Empfänger-Seite: wird gerufen wenn ein Peer ein eigenes
 * Device als kompromittiert markiert hat (`device_removed` mit `reason='user'`).
 * Wir spiegeln dann auf unserer Seite die Rotation, die der Peer eben gemacht hat:
 *
 *   1. Old local CMK in unsere Rotation-Map archivieren (Pre-Rotation-Messages
 *      bleiben decryptbar via fromIndex=0)
 *   2. Neuen CMK aus KV holen — Peer hat ihn dort frisch hochgeladen für unser
 *      Device. Mit Retry-Backoff gegen KV-Eventual-Consistency (~bis ~60s).
 *      Bug-13-Schutz wird hier BEWUSST überschrieben: nach einem device_removed
 *      mit reason='user' WISSEN wir, dass das KV-CMK das neue ist und das lokale
 *      veraltet ist. Force-Overwrite ist hier korrekt.
 *   3. Active CMK ersetzen, neuen Eintrag in der Map mit fromIndex = serverMax+1
 *
 * Race-Hinweis: Peer's `redistributeCMKToPeer` und unser KV-Read laufen unabhängig.
 * Cloudflare KV propagiert eventually consistent. Daher Retry mit zunehmenden
 * Delays.
 *
 * @returns {Promise<{ok: boolean, newFromIndex?: number, reason?: string}>}
 */
export async function mirrorRotateCMKForPeer(myHandle, peerHandle) {
  // ── Idempotenz-Guards ──────────────────────────────
  // Cooldown: jüngst-erfolgreiche Rotation → schneller Skip statt 32s Retry-Loop
  const lastSuccess = _mirrorRotateCooldown.get(peerHandle);
  if (lastSuccess && (Date.now() - lastSuccess) < MIRROR_ROTATE_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown_active' };
  }
  // In-flight: parallele Trigger teilen sich denselben Promise
  const existing = _mirrorRotateInFlight.get(peerHandle);
  if (existing) {
    console.log(`🔁 mirrorRotateCMKForPeer(${peerHandle}): in-flight, await existing`);
    return existing;
  }

  const work = (async () => _doMirrorRotate(myHandle, peerHandle))();
  _mirrorRotateInFlight.set(peerHandle, work);
  try {
    const result = await work;
    if (result?.ok) {
      _mirrorRotateCooldown.set(peerHandle, Date.now());
    }
    return result;
  } finally {
    _mirrorRotateInFlight.delete(peerHandle);
  }
}

async function _doMirrorRotate(myHandle, peerHandle) {
  try {
    const oldCmk = await getCMKIfExists(peerHandle);
    if (!oldCmk) {
      // Wir hatten ohnehin keinen lokalen CMK — beim nächsten Decrypt holt
      // tryFetchAndUnwrapCMK den neuen mit storeIfFresh=true. Nichts zu tun.
      return { ok: false, reason: 'no_local_cmk' };
    }

    const sid = dmSessionId(myHandle, peerHandle);

    // 1. Old CMK archivieren (idempotent — appendToRotationMap filtert
    // gleichen fromIndex). Wenn map leer: fromIndex=0 ist der initiale Slot.
    const mapBefore = await getRotationMap(sid);
    if (mapBefore.length === 0) {
      await appendToRotationMap(sid, 0, oldCmk);
    }

    // 2. KV-Fetch mit Retry-Backoff. Wir lesen DIREKT die wrapped Payload statt
    // tryFetchAndUnwrapCMK weil wir explizit überschreiben wollen + wissen wann
    // wir aufgeben sollen.
    let newCmk = null;
    const delays = [0, 1000, 3000, 8000, 20000];  // 0s, 1s, 3s, 8s, 20s = ~32s
    const cmkEquals = (a, b) =>
      a && b && a.length === b.length && a.every((v, i) => v === b[i]);
    // Vorsicht-Check: KV könnte einen STALE wrap halten (z.B. Initial-CMK von
    // Peer hochgeladen vor irgendwelchen Rotations). Dieser CMK ist evtl. schon
    // in unserer Map archiviert. Wir akzeptieren NUR CMKs die UNBEKANNT sind —
    // weder aktiv noch in der Map.
    const isHistorical = (bytes) =>
      mapBefore.some(e => {
        const eb = e?.cmkBytes;
        if (!Array.isArray(eb) || eb.length !== bytes.length) return false;
        return bytes.every((b, i) => b === eb[i]);
      });

    for (const delay of delays) {
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      try {
        const myDeviceId = getDeviceId();
        const r = await apiFetch(
          `/e2e/cmk/fetch?from=${encodeURIComponent(peerHandle)}&deviceId=${encodeURIComponent(myDeviceId)}`
        );
        if (!r.ok || !r.data?.payload) continue;

        const { fromDeviceId, ivB64, ctB64 } = r.data.payload;
        if (!fromDeviceId || !ivB64 || !ctB64) continue;

        let senderJwk = await findSenderDeviceJwk(peerHandle, fromDeviceId);
        if (!senderJwk) {
          const devs = await fetchPeerDevices(peerHandle);
          senderJwk = devs.find(d => d.deviceId === fromDeviceId)?.jwk || null;
        }
        if (!senderJwk) continue;

        // Phase 0.3 Dark-Launch: Wrap-Sig verifizieren + loggen (KEIN Reject).
        try { await logWrapVerify(r.data.payload, await getSigPubForDevice(peerHandle, fromDeviceId), `cmk ${peerHandle}/${fromDeviceId}`); } catch {}

        const fetched = await unwrapCMKFromPeer(ivB64, ctB64, senderJwk);
        if (!(fetched instanceof Uint8Array) || fetched.length !== 32) continue;

        // Skip wenn fetched == lokal-active → KV hat noch nicht propagiert, retry
        if (cmkEquals(fetched, oldCmk)) continue;

        // Skip wenn fetched bereits in der Map ist → das ist ein historischer
        // CMK (z.B. Initial-CMK den Peer mal uploaded hat), KEIN neuer post-
        // Rotation-CMK. Sonst würde mirror-rotate fälschlich auf das alte CMK
        // zurückspringen.
        if (isHistorical(fetched)) continue;

        // Wirklich neu: nicht active, nicht in Map.
        newCmk = fetched;
        break;
      } catch (e) {
        // Network-Glitch o.ä. — retry-fähig
      }
    }

    if (!newCmk) {
      // Geben auf: Peer hat (noch) keinen neuen CMK hochgeladen, oder KV ist
      // langsam. Lokale Map hat oldCmk@0 — Decrypt von alten Messages bleibt OK.
      // Beim nächsten Send des Peers + Decrypt-Fail-Fallback wird KV nochmal
      // gefragt — siehe decryptIncomingMessage Step 2.
      return { ok: false, reason: 'kv_no_new_cmk' };
    }

    // 3. Server-known max rotation_index (für korrekten newFromIndex)
    let serverMaxIdx = 0;
    try {
      const rr = await apiFetch(`/chat/rotation-index?peer=${encodeURIComponent(peerHandle)}`);
      if (rr.ok && typeof rr.data?.rotationIndex === 'number') {
        serverMaxIdx = rr.data.rotationIndex;
      }
    } catch {}

    const mapAfter = await getRotationMap(sid);
    const localMaxIdx = mapAfter.reduce((m, e) => Math.max(m, e.fromIndex), 0);
    const newFromIndex = Math.max(serverMaxIdx, localMaxIdx) + 1;

    // 4. Map updaten + active CMK ersetzen
    await appendToRotationMap(sid, newFromIndex, newCmk);
    await importAndStoreCMKFromPeer(peerHandle, newCmk);

    console.log(`🔁 Mirror-Rotation für ${peerHandle}: fromIndex=${newFromIndex}`);
    return { ok: true, newFromIndex };
  } catch (e) {
    captureException(e, { context: 'mirrorRotateCMKForPeer', peerHandle });
    return { ok: false, reason: 'exception' };
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

// ======================================================
// Group-E2E (Phase 1C) — Sender-Keys-Pattern
// ======================================================

/**
 * E2E-encryptet + sendet eine Gruppen-Nachricht via /chat/send.
 * - GSK pro Sender (lokal). Encrypt: AES-GCM(GSK, plaintext).
 * - sid = groupId (UUID), epoch = current time-bucket — analog DM-Sig-Format.
 *
 * @param {string} myHandle
 * @param {string} groupId
 * @param {string[]} memberHandles - alle aktiven Members (für Distribution beim Erst-Send)
 * @param {string} plaintext
 * @param {{id: string, from: string, text: string}} [replyTo]
 */
// @-Mention-Extraction für Push-Notifications (E2E-safe: läuft auf Plaintext
// im Client, Server sieht nur die abgeleiteten Felder mentions[] + mentionsEveryone).
// Sprach-aware: @everyone (EN) | @alle (DE) | @todos (ES) lösen "@all" aus.
const _ALL_MENTION_TOKENS = new Set(['everyone', 'alle', 'todos']);
function _extractMentions(plaintext, memberHandles) {
  if (!plaintext || typeof plaintext !== 'string') {
    return { mentions: [], mentionsEveryone: false };
  }
  const memberSet = new Set((memberHandles || []).map(h => String(h).toLowerCase()));
  const mentionsEveryone = /@(everyone|alle|todos)\b/i.test(plaintext);
  const mentions = [];
  const re = /@([a-z0-9_]+)/gi;
  let m;
  while ((m = re.exec(plaintext)) !== null) {
    const h = m[1].toLowerCase();
    if (_ALL_MENTION_TOKENS.has(h)) continue;
    if (memberSet.has(h) && !mentions.includes(h)) mentions.push(h);
  }
  return { mentions, mentionsEveryone };
}

export async function sendEncryptedGroup(myHandle, groupId, memberHandles, plaintext, replyTo = null, attachment = null) {
  try {
    const gskBytes = await ensureMyGSK(groupId, memberHandles);
    if (!gskBytes) return { ok: false, error: 'no_gsk' };

    // Forward-Secrecy: per-Message-MK via HKDF(GSK, info=`...:chainIndex`).
    // Symmetrisch zu DM (deriveMessageKey aus session.js) und cross-frontend-
    // kompatibel mit Vanilla. Der Decrypt-Pfad in decryptIncomingGroupMessage
    // probiert HKDF zuerst (chainIndex-Pfad), fallback Direct-GSK.
    const chainIndex = await nextGroupChainIndex(groupId);
    const mk = await deriveGroupMessageKey(gskBytes, groupId, myHandle, chainIndex);

    // Auto-Rotate-Threshold (NIST SP 800-38D §8.3): wenn die GSK >=
    // ENCRYPT_ROTATE_THRESHOLD mal verwendet wurde, prophylaktisch eine
    // neue GSK generieren + an alle Members verteilen. Fire-and-forget,
    // blockt den aktuellen Send nicht — der nächste Send nutzt dann die
    // neue GSK (chainIndex resettet auf 0 via setMyGSK).
    if (chainIndex >= ENCRYPT_ROTATE_THRESHOLD) {
      console.warn(`⚠️ GSK auto-rotate: threshold ${ENCRYPT_ROTATE_THRESHOLD} reached for group ${groupId}`);
      void rotateMyGSK(groupId, memberHandles).catch(e =>
        captureException(e, { context: 'auto-rotate-gsk', groupId })
      );
    }

    const epoch = Math.floor(Date.now() / EPOCH_MS);
    const sid = String(groupId);

    // Wenn ein Attachment dabei ist: Plaintext zu strukturiertem Envelope wrappen.
    const wrappedPlaintext = attachment
      ? wrapAttachmentPlaintext(plaintext, attachment)
      : plaintext;

    const { ivB64, ctB64 } = await e2eEncrypt(mk, wrappedPlaintext);
    const sig = await signMessage(ivB64, ctB64, sid, epoch);
    const deviceId = getDeviceId();

    // @-Mentions aus dem Plaintext extrahieren (E2E-safe: Backend sieht ct,
    // nicht den Plaintext; Push-Filter braucht aber zu wissen ob @-mentions
    // drin sind → hier am Client vorbereiten, Server liest die abgeleiteten Felder).
    const { mentions, mentionsEveryone } = _extractMentions(plaintext, memberHandles);

    const body = {
      to: myHandle,             // Backend braucht gültigen Member; Self-Push wird via pushToGroupMembers excluded.
      convoId: groupId,
      e2e: true,
      v: 2,
      sid,
      epoch,
      ivB64,
      ctB64,
      sig,
      deviceId,
      // chainIndex landet im backend als rotation_index; decryptIncomingGroupMessage
      // liest msg.rotationIndex / rotation_index für die HKDF-Ableitung.
      rotationIndex: chainIndex,
      // Mention-Metadata für Push-Filter (mentions_only / mentions_and_everyone).
      // Backend liest sie in chatSend.js und reicht sie an pushToUser durch.
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(mentionsEveryone ? { mentionsEveryone: true } : {}),
    };

    // Attachment-Plaintext-Felder für DB
    if (attachment?.r2Key) {
      body.attachmentKey  = attachment.r2Key;
      body.attachmentType = attachment.type;
    }

    if (replyTo && replyTo.id && typeof replyTo.text === 'string') {
      const previewText = replyTo.text.length > 200
        ? replyTo.text.slice(0, 200) + '…'
        : replyTo.text;
      // Reply-Preview mit demselben per-Message-MK encrypten — der Empfänger
      // hat den selben chainIndex und kann sowohl Body als auch Reply ableiten.
      const enc = await e2eEncrypt(mk, previewText);
      body.replyToId = replyTo.id;
      body.replyFrom = replyTo.from;
      body.replyIv = enc.ivB64;
      body.replyCt = enc.ctB64;
    }

    // L1 Proof-of-Work: Nonce über (sid|epoch|sig) anhängen, Reject-Retry bei pow_weak.
    const r = await sendChatWithPow(body, { sid, epoch, sig, ctB64 });
    if (!r.ok) return { ok: false, error: r.error || 'send_failed' };
    return { ok: true, message: r.data?.message };
  } catch (e) {
    captureException(e, { context: 'sendEncryptedGroup', groupId });
    return { ok: false, error: e.message || 'unknown' };
  }
}

/**
 * Decrypted eine eingehende Group-E2E-Message.
 * Sender-Keys: lookup GSK des `msg.from`. Wenn fehlt → triggert request_gsk +
 * gibt {text:null} zurück (Caller retryt mit Backoff).
 *
 * @returns {Promise<{text: string|null, verified: boolean|null, replyText?: string|null}>}
 */
export async function decryptIncomingGroupMessage(msg, myHandle, groupId) {
  try {
    if (msg.id) {
      const cached = _decryptCacheGet(msg.id);
      if (cached) return { text: cached.text, verified: cached.verified, replyText: cached.replyText, _cached: true };
    }

    const ivB64 = msg.ivB64 || msg.iv_b64;
    const ctB64 = msg.ctB64 || msg.ct_b64;
    if (typeof ivB64 !== 'string' || typeof ctB64 !== 'string') {
      return { text: null, verified: null };
    }

    const senderHandle = String(msg.from || '').toLowerCase();
    if (!senderHandle) return { text: null, verified: null };

    // Sender-GSK auflösen — eigene Sends mit lokal-cached MyGSK; Peer-Sends mit cached PeerGSK.
    let gskBytes = null;
    if (senderHandle === String(myHandle).toLowerCase()) {
      const { getMyGSK } = await import('./groupCrypto.js');
      gskBytes = await getMyGSK(groupId);
    } else {
      gskBytes = await getOrRequestPeerGSK(groupId, senderHandle);
    }
    if (!gskBytes) return { text: null, verified: null };

    const gskKey = await importGskAesKey(gskBytes);
    const sid = msg.sid || String(groupId);
    const baseEpoch = typeof msg.epoch === 'number'
      ? msg.epoch
      : Math.floor((msg.ts || Date.now()) / EPOCH_MS);

    // Decrypt-Strategien:
    //  1. Vanilla-HKDF-Pattern: deriveGroupMK(GSK, groupId, sender, chainIndex)
    //     mit Salt "renex:gmk:v1" — falls chainIndex (rotationIndex) gegeben.
    //     Vanilla-Sender (groupSessionManager.js encryptGroupMessage) verwendet
    //     einen per-Message HKDF-derived MK. Ohne diesen Pfad schlägt der
    //     Decrypt für Vanilla→Svelte-Group-Messages fehl.
    //  2. Vanilla-HKDF v0-Salt (Legacy 32 zero bytes) — alte Vanilla-Messages.
    //  3. Direct-GSK — Svelte→Svelte-Send-Pfad (sendEncryptedGroup).
    const chainIndex = typeof msg.rotationIndex === 'number'
      ? msg.rotationIndex
      : (typeof msg.rotation_index === 'number'
          ? msg.rotation_index
          : (typeof msg.chainIndex === 'number' ? msg.chainIndex : null));

    let decrypted = null;
    let workingKey = gskKey;
    let usedEpoch = baseEpoch;

    // Strategy 1+2: Vanilla HKDF-derived MK
    if (chainIndex !== null) {
      const HKDF_SALT_V1 = new TextEncoder().encode('renex:gmk:v1');
      const HKDF_SALT_V0 = new Uint8Array(32);
      const info = new TextEncoder().encode(
        `renex-group:${groupId}:${senderHandle}:${chainIndex}`
      );
      const baseKey = await crypto.subtle.importKey(
        'raw', gskBytes, 'HKDF', false, ['deriveKey']
      );
      for (const salt of [HKDF_SALT_V1, HKDF_SALT_V0]) {
        try {
          const mk = await crypto.subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt, info },
            baseKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
          );
          const pt = await e2eDecrypt(mk, ivB64, ctB64);
          if (typeof pt === 'string') {
            decrypted = pt;
            workingKey = mk;
            break;
          }
        } catch {}
      }
    }

    // Strategy 3: Direct-GSK fallback (Svelte-Sender)
    if (typeof decrypted !== 'string') {
      for (const ep of [baseEpoch, baseEpoch - 1, baseEpoch + 1]) {
        try {
          const pt = await e2eDecrypt(gskKey, ivB64, ctB64);
          if (typeof pt === 'string') {
            decrypted = pt;
            workingKey = gskKey;
            usedEpoch = ep;
            break;
          }
        } catch {}
      }
    }

    if (typeof decrypted !== 'string') {
      return { text: null, verified: null };
    }

    let replyText = null;
    const replyIv = msg.replyIv || msg.reply_iv;
    const replyCt = msg.replyCt || msg.reply_ct;
    if (typeof replyIv === 'string' && typeof replyCt === 'string') {
      try {
        // Reply mit derselben Key-Variante decrypten die für die Haupt-Bubble
        // funktioniert hat (workingKey = HKDF-derived MK ODER direct-GSK).
        replyText = await e2eDecrypt(workingKey, replyIv, replyCt);
      } catch { replyText = null; }
    }

    // Sig-Verify (Tampering-Schutz). Skip für Self-Sends von DIESEM Device.
    let verified = null;
    const senderDeviceId = msg.deviceId || msg.device_id;
    const myDeviceId = getDeviceId();
    const isFromMyCurrentDevice = senderHandle === String(myHandle).toLowerCase() && senderDeviceId === myDeviceId;
    if (!isFromMyCurrentDevice && senderDeviceId && msg.sig) {
      let sigPub = await getSigPubForDevice(senderHandle, senderDeviceId);
      if (!sigPub) {
        try {
          const r = await apiFetch(`/e2e/inbox/get?user=${encodeURIComponent(senderHandle)}`);
          if (r.ok && Array.isArray(r.data?.devices)) {
            await storePeerDevices(senderHandle, r.data.devices);
            sigPub = r.data.devices.find(d => d.deviceId === senderDeviceId)?.sigPub || null;
          }
        } catch {}
      }
      if (sigPub) {
        try {
          verified = await verifyMessageSig(ivB64, ctB64, sid, usedEpoch, msg.sig, sigPub);
          if (verified === false) {
            // Fallback: historische Sig-Pubkeys nach Device-Key-Rotation probieren.
            const history = await getSigPubHistoryForDevice(senderHandle, senderDeviceId);
            let historicMatch = false;
            for (const entry of history) {
              if (!entry?.jwk) continue;
              try {
                const ok = await verifyMessageSig(ivB64, ctB64, sid, usedEpoch, msg.sig, entry.jwk);
                if (ok === true) {
                  historicMatch = true;
                  verified = true;
                  console.log(
                    `🔐 Group-Sig-Verify via historic pubkey OK — id=${String(msg.id).slice(0, 8)} ` +
                    `from=${senderHandle} (retired ${new Date(entry.retiredAt || 0).toISOString().slice(0, 10)})`
                  );
                  break;
                }
              } catch {}
            }
            if (!historicMatch) {
              console.error(
                `🚨 Group-Sig-Verify FAILED — id=${String(msg.id).slice(0, 8)} ` +
                `from=${senderHandle} group=${String(groupId).slice(0, 8)} ` +
                `(weder aktueller noch historischer Pubkey passt)`
              );
            }
          }
        } catch (e) {
          captureException(e, { context: 'verifyGroupMessageSig', from: senderHandle });
        }
      }
    }

    if (msg.id) _decryptCacheSet(msg.id, decrypted, verified, replyText);
    return { text: decrypted, verified, replyText };
  } catch (e) {
    captureException(e, { context: 'decryptIncomingGroupMessage', groupId });
    return { text: null, verified: null };
  }
}

/**
 * Editiert eine eigene E2E-Group-Message.
 *
 * Wenn die GSK zwischen Original-Send und Edit-Zeit rotiert wurde (z.B. nach
 * group_member_left), encryptet diese Funktion die Edit-Cipher mit der
 * **Original-GSK** aus dem In-Memory-Archive (siehe groupCrypto.js). Damit
 * können Empfänger, die ebenfalls noch die alte GSK im Archive haben, den
 * Edit decrypten. Fallback wenn kein Archive-Eintrag mehr da ist: aktuelle GSK.
 *
 * @param {string} myHandle
 * @param {string} groupId
 * @param {string} msgId
 * @param {string} newPlaintext
 * @param {object} [originalMsg] - optional: enthält `ts` für Archive-Lookup
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function editEncryptedGroup(myHandle, groupId, msgId, newPlaintext, originalMsg = null) {
  try {
    // Archive-Lookup zuerst: wenn die Original-GSK noch im Archive ist
    // (Rotation seit Original-Send), nimm die — sonst current.
    const originalTs = typeof originalMsg?.ts === 'number' ? originalMsg.ts : null;
    let gskBytes = null;
    if (originalTs !== null) {
      gskBytes = findMyGSKAtTs(groupId, originalTs);
    }
    if (!gskBytes) gskBytes = await getMyGSK(groupId);
    if (!gskBytes) return { ok: false, error: 'no_gsk' };

    const sid = String(groupId);
    const epoch = Math.floor(Date.now() / EPOCH_MS);

    // Forward-Secrecy: frischer chainIndex für die Edit-Cipher. Backend
    // speichert den ciphertext-JSON inkl. rotationIndex (siehe rotIdx-
    // Embedding in chatRoutes.js:374). Empfänger leitet gleichen MK ab.
    const chainIndex = await nextGroupChainIndex(groupId);
    const mk = await deriveGroupMessageKey(gskBytes, groupId, myHandle, chainIndex);

    const { ivB64, ctB64 } = await e2eEncrypt(mk, newPlaintext);
    const sig = await signMessage(ivB64, ctB64, sid, epoch);

    const ciphertext = JSON.stringify({ iv: ivB64, ct: ctB64, sig, epoch });
    const r = await apiFetch('/chat/message/edit', {
      method: 'POST',
      body: { id: msgId, ciphertext, rotationIndex: chainIndex },
    });
    if (!r.ok) return { ok: false, error: r.error || 'edit_failed' };
    _decryptCache.delete(msgId);
    return { ok: true };
  } catch (e) {
    captureException(e, { context: 'editEncryptedGroup', groupId });
    return { ok: false, error: e.message || 'unknown' };
  }
}

/**
 * Decrypted das ciphertext-Feld eines `message_edited`-Events einer Group-Message.
 * Holt die GSK des Senders (eigene oder peer) und verifiziert die Sig.
 *
 * @param {object} event - WS-Event mit `ciphertext` (JSON-String)
 * @param {object} originalMsg - Original-Message-Row (für sender, deviceId)
 * @param {string} myHandle
 * @param {string} groupId
 * @returns {Promise<string|null>}
 */
export async function decryptEditedGroupMessage(event, originalMsg, myHandle, groupId) {
  try {
    let parsed;
    try { parsed = JSON.parse(event.ciphertext || ''); } catch { return null; }
    const ivB64 = parsed.iv;
    const ctB64 = parsed.ct;
    if (typeof ivB64 !== 'string' || typeof ctB64 !== 'string') return null;

    const senderHandle = String(originalMsg.from || event.from || '').toLowerCase();
    if (!senderHandle) return null;

    // chainIndex: aus event (Top-Level) oder ciphertext-embedded.
    // editEncryptedGroup sendet ihn als body.rotationIndex; Backend embedded
    // ihn zusätzlich ins ciphertext-JSON (chatRoutes.js:381). Beide Quellen
    // konsultieren — falls eine fehlt, fällt's auf die andere zurück.
    let chainIndex = null;
    if (typeof event.rotationIndex === 'number') chainIndex = event.rotationIndex;
    else if (typeof parsed.rotationIndex === 'number') chainIndex = parsed.rotationIndex;

    const isOwn = senderHandle === String(myHandle).toLowerCase();
    const originalTs = typeof originalMsg?.ts === 'number' ? originalMsg.ts : null;

    // Try-Order:
    //  1. aktuelle GSK des Senders (häufigster Fall)
    //  2. archivierte GSK zum Original-Send-Zeitpunkt (wenn 1. fehlschlägt
    //     UND wir wissen wann die Original-Message gesendet wurde — typisch
    //     bei GSK-Rotation innerhalb des 15min-Edit-Windows).
    const candidates = [];
    if (isOwn) {
      const cur = await getMyGSK(groupId);
      if (cur) candidates.push(cur);
      if (originalTs !== null) {
        const archived = findMyGSKAtTs(groupId, originalTs);
        if (archived) candidates.push(archived);
      }
    } else {
      const cur = await getOrRequestPeerGSK(groupId, senderHandle);
      if (cur) candidates.push(cur);
      if (originalTs !== null) {
        const archived = findPeerGSKAtTs(groupId, senderHandle, originalTs);
        if (archived) candidates.push(archived);
      }
    }
    if (candidates.length === 0) return null;

    // Pro GSK-Kandidat: probiere zuerst HKDF-Pfad (Forward-Secrecy, matched
    // editEncryptedGroup), fallback direkter GSK-Key (für Legacy-Edits ohne
    // chainIndex — z.B. Edits VOR Phase-1D-Rollout).
    for (const gskBytes of candidates) {
      // 1. HKDF-Chain (current encrypt path)
      if (chainIndex !== null) {
        try {
          const mk = await deriveGroupMessageKey(gskBytes, groupId, senderHandle, chainIndex);
          const plaintext = await e2eDecrypt(mk, ivB64, ctB64);
          if (typeof plaintext === 'string') return plaintext;
        } catch {
          // Falsche GSK oder chainIndex → fallback Direct-GSK
        }
      }
      // 2. Direct-GSK (legacy fallback)
      try {
        const gskKey = await importGskAesKey(gskBytes);
        const plaintext = await e2eDecrypt(gskKey, ivB64, ctB64);
        if (typeof plaintext === 'string') return plaintext;
      } catch {
        // Falsche GSK → nächste Kandidatin
      }
    }
    return null;
  } catch (e) {
    captureException(e, { context: 'decryptEditedGroupMessage', groupId });
    return null;
  }
}
