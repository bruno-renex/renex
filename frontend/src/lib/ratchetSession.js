// ======================================================
// ratchetSession.js — REALE Double-Ratchet-Session (P3.1)
// ======================================================
// Der ECHTE Ver-/Entschlüsselungspfad (im Gegensatz zum Shadow, der nur
// Fingerprints vergleicht). Wendet die aus ratchet.js abgeleiteten
// Message-Keys via AES-GCM auf den Klartext an — AAD = header_b64 (bindet den
// Ratchet-Header kryptografisch) — und signiert den Header (signMessageV4).
//
// Wire (v4-DM, koexistiert mit Legacy v2 — Routing via header_b64-Präsenz):
//   { v:4, header_b64:{v:4,dh,pn,n,kemEpoch}, ivB64, ctB64, sig, init? }
//   init = PQXDH-InitHdr, nur bis der Peer geantwortet hat (PreKeyMessage).
//   KEIN sid/epoch/rotationIndex.
//
// State device-scoped in IDB `ratchet:<peer>:<dev>` (§4.0 D1), versiegelt.
// GETRENNT vom Shadow (ratchetshadow:) — eigener Handshake/RK0 → saubere
// Entkopplung (Shadow = Telemetrie, Session = echt), Preis = 1 OPK/Paar.
//
// Härtung wie Shadow: per-(peer,dev)-Mutex (kein Lost-Update), KEIN Netzwerk
// am Send-Pfad (primeRatchetSession im Hintergrund → 1. Send fällt auf Legacy
// zurück, bis die Session steht). Skipped-Store: Cap (MAX_SKIP in ratchet.js) +
// harte Gesamtgrenze hier. Wirft NIE unkontrolliert; null = „nicht möglich,
// nutze Legacy".
// ======================================================
import { idbGet, idbSet, idbListKeys } from './idb.js';
import { deriveStorageKey, sealJson, openJson } from './deviceStore.js';
import { b64ToBytes, bytesToB64 } from './bytes.js';
import { x25519PublicKey } from './pqCrypto.js';
import {
  initInitiator, initResponder, nextSendKey, deriveReceiveKey,
  encodeRatchetHeader, decodeRatchetHeader,
  serializeRatchetState, deserializeRatchetState,
} from './ratchet.js';
import {
  initPqState, pqRekeyDue, pqAnnounce, pqSendFields, pqMarkCtSent,
  pqNoteSend, pqNoteRecv, pqReceivePrep,
} from './pqRatchet.js';
import { e2eEncrypt, e2eDecrypt } from './chatCrypto.js';
import { signMessageV4, verifyMessageSigV4 } from './messageSig.js';
import { ensureHybridSession, acceptHybridSession } from './hybridSession.js';
import { getRecipientDevices } from './sesame.js';
import { getKemEkForDevice } from './cmk.js';
import { getOrCreateKemIdentity } from './kemIdentity.js';

const STORE_INFO = 'renex:ratchetsession:store:v1';
const IDB_PREFIX = 'ratchet:';
const V4MSG_PREFIX = 'v4msg:';           // persistenter Klartext-Store (siehe unten)
const SKIPPED_CAP = 512;                 // harte Gesamtgrenze des Skipped-Stores (über MAX_SKIP hinaus)
const MAX_INIT_SENDS = 32;               // InitHdr höchstens so oft mitschicken (danach liegt es in der History)
const _key = () => deriveStorageKey(STORE_INFO);
const _idbKey = (peer, dev) => `${IDB_PREFIX}${peer}:${dev}`;

// ── Persistenter v4-Klartext-Store (versiegelt) ────────
// Ratchet-Message-Keys sind EINMALIG (forward-secret) → eine bereits
// entschlüsselte v4-Nachricht kann NICHT re-derivt werden. Ohne lokalen
// Klartext-Cache wären nach Reload alle v4-History-Nachrichten (empfangene UND
// eigene gesendete) unlesbar. Daher: Klartext je msgId lokal versiegelt ablegen.
// Löst zugleich Redelivery-Dedup (Store-Hit → kein zweiter Ratchet-Advance).
export async function storeV4Plaintext(msgId, text, verified = null) {
  if (!msgId || typeof text !== 'string') return;
  try { await idbSet(V4MSG_PREFIX + msgId, await sealJson(await _key(), { text, verified })); } catch {}
}
export async function loadV4Plaintext(msgId) {
  if (!msgId) return null;
  try { const s = await idbGet(V4MSG_PREFIX + msgId); return s ? await openJson(await _key(), s) : null; }
  catch { return null; }
}

// Sender-Flag (P3.1). DEFAULT AUS (opt-in) — im Gegensatz zum Shadow, der
// standardmäßig läuft. Empfangen von v4 ist IMMER an (deployed capability);
// dieses Flag steuert nur, ob ICH v4 SENDE.
export function ratchetSendEnabled() {
  try { return localStorage.getItem('renex_ratchet_send') === '1'; } catch { return false; }
}

// PQ-Triple-Rekey-Flag (P3.2-B). DEFAULT AUS (opt-in, ZUSÄTZLICH zu
// renex_ratchet_send — Rekey setzt v4-Senden voraus). Steuert nur das ANNOUNCE
// (Senden von pq_kem_ct); die Empfangs-/Aktivierungs-Seite läuft IMMER, sobald
// deployed (capability, via caps.pqrekey advertised). Kill-Switch: entfernen/0.
export function pqRekeyEnabled() {
  try { return localStorage.getItem('renex_pq_rekey') === '1' && ratchetSendEnabled(); }
  catch { return false; }
}

// ── Rekey-Telemetrie (localStorage, Muster P3.0-Shadow-Stats) ──────────────
// Dark-Launch-Gate: announce/activate_send/activate_recv/confirm hochzählen,
// locked-Gründe + Anomalien (ct_stripped/fp_mismatch/mix_mismatch) beobachten.
// mix_mismatch≈0 ist das GO-Kriterium. Wirft nie.
function pqStat(key, n = 1) {
  try {
    const s = JSON.parse(localStorage.getItem('renex_pqrk_stats') || '{}');
    s[key] = (s[key] || 0) + n;
    localStorage.setItem('renex_pqrk_stats', JSON.stringify(s));
  } catch {}
}
function pqStatAnomalies(list) {
  for (const a of (list || [])) pqStat(`anomaly_${a}`);
}

// ── Per-Key-Mutex (race-frei via Promise-Kette) ────────
const _tail = new Map();
function _withLock(key, fn) {
  const run = (_tail.get(key) || Promise.resolve()).then(fn, fn);
  _tail.set(key, run.then(() => {}, () => {}));
  return run;
}

// AES-GCM-Key aus rohem 32B-MK.
function _aesKey(mk) {
  return crypto.subtle.importKey('raw', mk, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// ── Persistenz (versiegelt, device-scoped) ─────────────
async function _load(peer, dev) {
  const sealed = await idbGet(_idbKey(peer, dev));
  if (!sealed) return null;
  const o = await openJson(await _key(), sealed);
  return o ? { ...o, state: deserializeRatchetState(o.state) } : null;
}
async function _save(peer, dev, rec) {
  // Skipped-Store hart begrenzen (DoS-/Wachstums-Schutz jenseits MAX_SKIP).
  const sk = rec.state.skipped || {};
  const keys = Object.keys(sk);
  if (keys.length > SKIPPED_CAP) {
    for (const k of keys.slice(0, keys.length - SKIPPED_CAP)) delete sk[k];   // älteste raus (Insertion-Order)
  }
  await idbSet(_idbKey(peer, dev), await sealJson(await _key(), { ...rec, state: serializeRatchetState(rec.state) }));
}
async function _findExisting(peer) {
  const pfx = `${IDB_PREFIX}${peer}:`;
  const keys = (await idbListKeys(pfx)) || [];
  if (!keys.length) return null;
  const dev = keys.map(k => k.slice(pfx.length)).sort()[0];
  const rec = await _load(peer, dev);
  return rec ? { dev, rec } : null;
}

// ── Session-Priming (Netzwerk — NUR im Hintergrund) ────
/**
 * Stellt (falls nötig) eine reale Initiator-Session gegen EIN aktives pq-Device
 * her — NUR wenn single-device qualifiziert (§4.4 P3.1): Peer hat GENAU 1 Gerät
 * (pq-fähig) UND ich habe genau 1 Gerät. Multi-Device = P3.2 (Fan-out).
 * @param {string} peerHandle
 * @param {{myHandle?:string}} [opts]
 */
export function primeRatchetSession(peerHandle, { myHandle = '' } = {}) {
  const peer = String(peerHandle || '').toLowerCase();
  if (!peer || !ratchetSendEnabled()) return Promise.resolve(null);
  return _withLock(`prime:${peer}`, async () => {
    try {
      const devices = await getRecipientDevices(peer).catch(() => []);
      const active = new Set((devices || []).filter(d => d.hasKem && d.caps?.hybrid).map(d => d.deviceId));
      const existing = await _findExisting(peer);
      if (existing && active.has(existing.dev)) return { dev: existing.dev };

      // single-device-Gate: Peer genau 1 Gerät + pq-fähig.
      if ((devices || []).length !== 1 || active.size !== 1) return null;
      // … und ICH genau 1 Gerät (sonst bricht v4 meinen Multi-Device-Self-Sync).
      if (myHandle) {
        const mine = await getRecipientDevices(String(myHandle).toLowerCase()).catch(() => []);
        if ((mine || []).length > 1) return null;
      }

      const target = [...active].sort()[0];
      if (!target) return null;
      if (await _load(peer, target)) return { dev: target };
      const hs = await ensureHybridSession(peer, target);
      if (!hs?.peerSpkPub) return null;
      await _save(peer, target, {
        role: 'initiator', peerSeen: false, initHdr: hs.initHdr,
        state: initInitiator(hs.rootKey, b64ToBytes(hs.peerSpkPub)),
      });
      return { dev: target };
    } catch (e) {
      console.warn('🔗 ratchet_session prime skip (non-fatal):', e?.message);
      return null;
    }
  });
}

/**
 * Anzahl aktuell pq-fähiger Peer-Devices (fürs single-device-Gate in P3.1).
 * @returns {Promise<number>}
 */
export async function pqDeviceCount(peerHandle) {
  try {
    const devices = await getRecipientDevices(String(peerHandle || '').toLowerCase()).catch(() => []);
    return (devices || []).filter(d => d.hasKem && d.caps?.hybrid).length;
  } catch { return 0; }
}

// ======================================================
// SENDEN (v4). null → Aufrufer sendet Legacy v2.
// ======================================================
/**
 * @param {string} peerHandle
 * @param {string} plaintext
 * @returns {Promise<{v:4, header_b64:string, ivB64:string, ctB64:string, sig:string, init?:object}|null>}
 */
export async function ratchetEncrypt(peerHandle, plaintext, { myHandle = '' } = {}) {
  try {
    if (!ratchetSendEnabled()) return null;                          // Flag AUS → immer Legacy
    const peer = String(peerHandle || '').toLowerCase();
    if (!peer || typeof plaintext !== 'string') return null;

    const existing = await _findExisting(peer);
    if (!existing) { void primeRatchetSession(peer, { myHandle }); return null; }   // Session baut sich auf → dieser Send bleibt Legacy
    const { dev } = existing;

    // Send-Zeit-Recheck (cached): Peer inzwischen multi-device geworden? → Legacy
    // (v4 für Multi-Device = P3.2). Verhindert, dass ein zweites Peer-Gerät die
    // v4-Nachricht nie lesen kann.
    if ((await pqDeviceCount(peer)) !== 1) return null;

    return await _withLock(`sess:${peer}:${dev}`, async () => {
      const rec = await _load(peer, dev);
      if (!rec || !rec.state.cks) return null;                        // Responder vor erstem Empfang: noch nicht sendefähig
      const { mk, header } = nextSendKey(rec.state);
      const headerB64 = encodeRatchetHeader(header);
      const aesKey = await _aesKey(mk);
      const { ivB64, ctB64 } = await e2eEncrypt(aesKey, plaintext, headerB64);   // AAD = header_b64
      const sig = await signMessageV4(headerB64, ivB64, ctB64);
      // init-Cap: InitHdr höchstens MAX_INIT_SENDS-mal mitschicken. Es liegt in
      // der History (init_hdr-Spalte) → ein offline gewesener Peer baut die
      // Session daraus auf; unbegrenztes Resenden wäre reine Bandbreite.
      const carryInit = rec.role === 'initiator' && !rec.peerSeen && rec.initHdr && (rec.initSends || 0) < MAX_INIT_SENDS;
      if (carryInit) rec.initSends = (rec.initSends || 0) + 1;
      await _save(peer, dev, rec);
      return { v: 4, header_b64: headerB64, ivB64, ctB64, sig, ...(carryInit ? { init: rec.initHdr } : {}) };
    });
  } catch (e) {
    console.warn('🔗 ratchet_session encrypt fail → Legacy (non-fatal):', e?.message);
    return null;
  }
}

// ======================================================
// MULTI-DEVICE-FAN-OUT (P3.2-A). Ein v4-Ciphertext pro Ziel-Device via eigener
// (handle,deviceId)-Ratchet-Session. Jede Session ist ISOLIERT → ein aus-
// gelassenes/out-of-order-Device erzeugt nur eine lokal-gesperrte Nachricht,
// NIE einen Fleet-State-Clobber (die Lehre aus 2026-05-15; Ratchet-Desync heilt
// nicht durch Re-Fetch, deshalb Isolation statt geteiltem Zustand).
// ======================================================
const FANOUT_MAX = 9;   // Server-Cap ist 10; ein Slot Reserve

/**
 * Ziel-Devices: pq-fähige Peer-Devices + EIGENE andere pq-Devices (Self-Sync),
 * ohne mein aktuelles. `pqCapable` = das Device advertist caps.pqrekey → nur an
 * die announcen wir eine Rekey-Epoche (alte v4-Empfänger ignorieren kemEpoch
 * still → würden nach der Aktivierung locken). `kemEkB64` = Encaps-Ziel aus dem
 * lokalen Cache (KEIN Netz; Miss → null → kein Rekey für dieses Device).
 */
async function _fanoutTargets(peer, myHandle, myDeviceId) {
  const pq = (list) => (list || []).filter(d => d.hasKem && d.caps?.hybrid);
  const enrich = async (handle, d) => ({
    handle, deviceId: d.deviceId,
    pqCapable: !!d.caps?.pqrekey,
    kemEkB64: await getKemEkForDevice(handle, d.deviceId).catch(() => null),
  });
  const peerDevs = await Promise.all(pq(await getRecipientDevices(peer).catch(() => [])).map(d => enrich(peer, d)));
  let mine = [];
  if (myHandle) {
    mine = await Promise.all(pq(await getRecipientDevices(myHandle).catch(() => []))
      .filter(d => d.deviceId !== myDeviceId)
      .map(d => enrich(myHandle, d)));
  }
  return [...peerDevs, ...mine];   // NICHT truncaten — Overflow behandelt der Aufrufer (Legacy)
}

/** Stellt (falls nötig) eine Initiator-Session gegen EIN exaktes (handle,dev)-Ziel her. Single-flight. */
export function primePair(handle, dev) {
  const h = String(handle || '').toLowerCase(), d = String(dev || '');
  if (!h || !d || !ratchetSendEnabled()) return Promise.resolve(false);
  return _withLock(`prime:${h}:${d}`, async () => {
    try {
      if (await _load(h, d)) return true;                       // schon da
      const hs = await ensureHybridSession(h, d);
      if (!hs?.peerSpkPub) return false;
      await _save(h, d, {
        role: 'initiator', peerSeen: false, initHdr: hs.initHdr,
        state: initInitiator(hs.rootKey, b64ToBytes(hs.peerSpkPub)),
      });
      return true;
    } catch (e) { console.warn('🔗 primePair skip:', e?.message); return false; }
  });
}

/**
 * Per-(handle,dev)-Encrypt unter Lock. null = Session nicht sendebereit.
 * @param {{pqCapable?:boolean, kemEkB64?:string|null}} [tgt] Rekey-Kontext (P3.2-B)
 */
async function _encryptForDevice(handle, dev, plaintext, tgt = {}) {
  return _withLock(`sess:${handle}:${dev}`, async () => {
    const rec = await _load(handle, dev);
    if (!rec || !rec.state.cks) return null;
    rec.pq = rec.pq || initPqState(Date.now());          // Alt-Records (P3.1/P3.2-A) migrieren

    // P3.2-B: Rekey-Announce (nur Initiator-Rolle, nur pq-fähiges Ziel mit
    // bekanntem kemEk, nur wenn fällig, nur EINE offene Epoche). KEIN Netz —
    // kemEk kommt aus dem Cache (tgt.kemEkB64). pqAnnounce prüft Rolle intern.
    if (pqRekeyEnabled() && tgt.pqCapable && tgt.kemEkB64 && pqRekeyDue(rec.pq, Date.now())) {
      try {
        if (pqAnnounce(rec.pq, rec.state, b64ToBytes(tgt.kemEkB64))) pqStat('announce');
      } catch (e) { console.warn('🔗 pqAnnounce skip:', e?.message); }
    }
    const pqf = pqSendFields(rec.pq);                     // {pqTgt,pqFp,pqCtB64,pqConf?} oder null

    const { mk, header } = nextSendKey(rec.state);        // header.kemEpoch = aktivierte Epoche
    const headerB64 = encodeRatchetHeader(
      pqf ? { ...header, pqTgt: pqf.pqTgt, pqFp: pqf.pqFp, pqConf: pqf.pqConf || null } : header
    );
    const aesKey = await _aesKey(mk);
    const { ivB64, ctB64 } = await e2eEncrypt(aesKey, plaintext, headerB64);
    const sig = await signMessageV4(headerB64, ivB64, ctB64);
    const carryInit = rec.role === 'initiator' && !rec.peerSeen && rec.initHdr && (rec.initSends || 0) < MAX_INIT_SENDS;
    if (carryInit) rec.initSends = (rec.initSends || 0) + 1;
    if (pqf) pqMarkCtSent(rec.pq);                        // optimistisch: Budget 32 tolerant ggü. Send-Fails
    pqNoteSend(rec.pq);
    await _save(handle, dev, rec);
    return {
      header_b64: headerB64, ivB64, ctB64, sig,
      ...(carryInit ? { init: rec.initHdr } : {}),
      ...(pqf ? { pq_kem_ct: pqf.pqCtB64 } : {}),
    };
  });
}

/**
 * Multi-Device-Fan-out (P3.2-A). ALL-OR-NOTHING: v4 nur, wenn JEDES Ziel-Device
 * eine bereite Session hat — sonst null (Aufrufer sendet Legacy an alle; kein
 * Device bleibt ohne lesbare Kopie) und die fehlenden Sessions primen im BG.
 * @returns {Promise<{mode:'single', tgt, header_b64, ivB64, ctB64, sig, init?}
 *                  | {mode:'multi', payloads:[{deviceId, header_b64, ivB64, ctB64, sig, init?}]}
 *                  | null>}
 */
export async function ratchetEncryptMulti(peerHandle, plaintext, { myHandle = '', myDeviceId = '' } = {}) {
  try {
    if (!ratchetSendEnabled()) return null;
    const peer = String(peerHandle || '').toLowerCase();
    if (!peer || typeof plaintext !== 'string') return null;
    const myH = String(myHandle || '').toLowerCase();

    const targets = await _fanoutTargets(peer, myH, myDeviceId);
    if (targets.length === 0) return null;                      // kein pq-Ziel → Legacy
    // Overflow NIE truncaten (sonst bekämen weggelassene Devices keine lesbare
    // Kopie = stiller Verlust) → lieber Legacy für alle.
    if (targets.length > FANOUT_MAX) return null;

    // All-or-nothing-Bereitschaft: fehlt EINEM Ziel die Session → Legacy diese
    // Runde, fehlende im Hintergrund primen.
    let allReady = true;
    for (const t of targets) {
      const rec = await _load(t.handle, t.deviceId);
      if (!rec || !rec.state.cks) { allReady = false; void primePair(t.handle, t.deviceId); }
    }
    if (!allReady) return null;

    const payloads = [];
    for (const t of targets) {
      const enc = await _encryptForDevice(t.handle, t.deviceId, plaintext, { pqCapable: t.pqCapable, kemEkB64: t.kemEkB64 });
      if (!enc) return null;                                    // Race: unbereit geworden → sicher auf Legacy
      payloads.push({ deviceId: t.deviceId, ...enc });
    }
    // 1 Ziel → single-Wire (P3.1, live-validiert, unverändert) — AUSSER ein
    // Rekey-CT reitet mit: der geht nur übers payloads[]-Format (Server-Cap
    // header_b64=512, single-Wire hat kein pq_kem_ct-Feld) → dann multi mit 1
    // Payload (Server akzeptiert das).
    if (payloads.length === 1 && !payloads[0].pq_kem_ct) {
      const { deviceId, ...single } = payloads[0];
      return { mode: 'single', tgt: deviceId, ...single };
    }
    return { mode: 'multi', payloads };
  } catch (e) {
    console.warn('🔗 ratchetEncryptMulti fail → Legacy (non-fatal):', e?.message);
    return null;
  }
}

// ======================================================
// EMPFANGEN (v4). null → Aufrufer behandelt als „noch nicht entschlüsselbar".
// ======================================================
/**
 * @param {string} fromHandle
 * @param {string} senderDeviceId
 * @param {{header_b64:string, ivB64:string, ctB64:string, sig?:string, init?:object, pq_kem_ct?:string}} msg
 * @param {object|null} [sigPubJwk] Sender-Sig-Pubkey (verify+log; null → skip verify)
 * @returns {Promise<{text:string, verified:boolean|null}|null>}
 */
export async function ratchetDecrypt(fromHandle, senderDeviceId, msg, sigPubJwk = null) {
  const peer = String(fromHandle || '').toLowerCase();
  const dev = String(senderDeviceId || '');
  if (!peer || !dev || !msg || !msg.header_b64 || !msg.ivB64 || !msg.ctB64) return null;

  // Header ZUERST validieren (pure Leseoperation, KEINE Mutation) → ein kaputter
  // Header verbrennt keine OPK (acceptHybridSession läuft erst danach).
  let header;
  try { header = decodeRatchetHeader(msg.header_b64); } catch { return null; }

  return await _withLock(`sess:${peer}:${dev}`, async () => {
    try {
      let rec = await _load(peer, dev);
      if (!rec) {
        if (!msg.init) return null;                                   // Init verpasst → (Aufrufer: retry/locked)
        const hs = await acceptHybridSession(peer, dev, msg.init);    // KONSUMIERT die one-time-OPK
        const spkPriv = b64ToBytes(hs.ownSpkPriv);
        rec = {
          role: 'responder', peerSeen: true, initHdr: null,
          state: initResponder(hs.rootKey, { priv: spkPriv, pub: x25519PublicKey(spkPriv) }),
        };
        // OPK-Verbrauch SOFORT mit persistierter Session paaren: ein späterer
        // Decrypt-Fehler kann die Session nicht mehr verwaisen lassen (sonst
        // würde der Retry acceptHybridSession erneut aufrufen → opk_consumed →
        // permanenter Lockout). Kritischer Datenverlust-Fix.
        await _save(peer, dev, rec);
      }
      rec.pq = rec.pq || initPqState(Date.now());                    // Alt-Records migrieren

      // P3.2-B: Rekey-Vorbereitung (CT-Harvest, Aktivierungs-Hooks, Confirm).
      // Reine In-Memory-Mutation VOR dem AEAD-Erfolg → bei Decrypt-Fehler wird
      // rec verworfen (kein _save) → Replay/Retry mischt den Root NIE doppelt.
      // Eigene KEM-Identität (kein Netz) NUR laden, wenn der Header eine HÖHERE
      // Epoche signalisiert als meine aktuelle — nur DANN decapsuliert die
      // Empfänger-Aktivierung (preR1) mit dem dk. Harvest/Confirm/Announcer-
      // preR2 brauchen es nicht → kein per-Nachricht-dk-Entsiegeln im ein-
      // geschwungenen Zustand (Header trägt dann kemEpoch===meine).
      const kemAdvance = (header.kemEpoch || 0) > (rec.state.kemEpoch || 0);
      let kemId = null;
      if (kemAdvance) { try { kemId = await getOrCreateKemIdentity(); } catch {} }
      const prep = pqReceivePrep(rec.pq, rec.state, header, {
        pqCtB64: msg.pq_kem_ct || null,
        kemDk: kemId?.dk || null, ownKemEk: kemId?.ek || null,
        now: Date.now(),
      });
      pqStatAnomalies(prep.anomalies);
      if (prep.locked) {
        pqStat(`locked_${prep.reason}`);
        console.warn(`🔗 pq rekey locked (${prep.reason}) ${peer}:${dev}`);
        return null;                                                 // nie steppen → Retry/History
      }

      const mk = deriveReceiveKey(rec.state, header, prep.hooks);    // Hooks mischen ss_pq nur im DH-Step
      const aesKey = await _aesKey(mk);
      // Entschlüsseln (AES-GCM-Tag beweist Integrität inkl. header via AAD).
      const text = await e2eDecrypt(aesKey, msg.ivB64, msg.ctB64, msg.header_b64);
      // Erst NACH bewiesener Integrität: Empfangs-Zähler + Rekey-Telemetrie.
      pqNoteRecv(rec.pq);
      if (prep.hooks?.preR1) pqStat('activate_recv');
      if (prep.hooks?.preR2) pqStat('activate_send');

      // Identitäts-Signatur über den Header (verify+log; Auth-Tag ist der harte
      // Schutz). verified=null wenn kein Pubkey vorhanden → NICHT als Fehler.
      let verified = null;
      if (msg.sig && sigPubJwk) {
        verified = await verifyMessageSigV4(msg.header_b64, msg.ivB64, msg.ctB64, msg.sig, sigPubJwk);
        if (!verified) console.warn(`🔗 ratchet_session v4 sig ungültig ${peer}:${dev}`);
      }

      if (rec.role === 'initiator') rec.peerSeen = true;
      await _save(peer, dev, rec);
      return { text, verified };
    } catch (e) {
      // Decrypt-Fehler (Tag-Mismatch / Replay / skip_limit) → null: Aufrufer
      // retryt/zeigt locked, wirft NICHT. Kein Sentry (Replays sind normal;
      // echte Probleme zeigen sich als dauerhaft-locked = beobachtbar).
      console.warn('🔗 ratchet_session decrypt fail (non-fatal):', e?.message);
      return null;
    }
  });
}
