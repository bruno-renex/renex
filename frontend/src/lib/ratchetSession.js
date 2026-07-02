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
import { e2eEncrypt, e2eDecrypt } from './chatCrypto.js';
import { signMessageV4, verifyMessageSigV4 } from './messageSig.js';
import { ensureHybridSession, acceptHybridSession } from './hybridSession.js';
import { getRecipientDevices } from './sesame.js';

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
// EMPFANGEN (v4). null → Aufrufer behandelt als „noch nicht entschlüsselbar".
// ======================================================
/**
 * @param {string} fromHandle
 * @param {string} senderDeviceId
 * @param {{header_b64:string, ivB64:string, ctB64:string, sig?:string, init?:object}} msg
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

      const mk = deriveReceiveKey(rec.state, header);
      const aesKey = await _aesKey(mk);
      // Entschlüsseln (AES-GCM-Tag beweist Integrität inkl. header via AAD).
      const text = await e2eDecrypt(aesKey, msg.ivB64, msg.ctB64, msg.header_b64);

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
