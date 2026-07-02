// ======================================================
// ratchetShadow.js — P3.0 decrypt-only Dark-Launch (RATCHET_SEND=0)
// ======================================================
// Führt den Double-Ratchet (ratchet.js) als SCHATTEN parallel zum Legacy-
// CMK-Pfad: pro echter DM wird ein Shadow-MK abgeleitet und nur dessen
// 8-Byte-Fingerprint verglichen + gezählt. KEINE echte Krypto-Nutzung —
// die Nachricht selbst bleibt Legacy-verschlüsselt. Ziel (§4.4): ≥1000
// Live-Nachrichten mit 100% Match → Freigabe P3.1.
//
// Korrektheits-Härtung (adversariale Review P3.0):
//  - Per-(peer,dev)-Mutex (_withLock) um JEDE State-Mutation → kein Race bei
//    schnellen Sends (verlorene ns) / gleichzeitigen Receives (doppelter
//    OPK-Consume via acceptHybridSession, State-Clobber).
//  - KEIN Netzwerk auf dem Send-Pfad: die Session (Bundle-Fetch + OPK-Consume)
//    wird im HINTERGRUND pre-established (primeShadowSession); shadowOnSend
//    macht nur noch lokale CPU/IDB-Arbeit oder skippt sofort. Die allererste
//    Nachricht an einen neuen Peer trägt daher noch keinen Shadow (akzeptiert).
//  - Device-Reuse nur wenn das Device NOCH pq-aktiv ist (sesame) — sonst frische
//    Session fürs aktuelle Ziel; deterministische Device-Wahl (sortiert).
//  - Receive-Idempotenz per msgId (gegen WS-Redelivery → sonst nr-Doppel-
//    Advance = Desync).
//
// Ausschlüsse: Control-/Pulse-Typen (Rekey-Storm-Guard §4.4), History-Re-Reads
// (Server persistiert das Shadow-Feld bewusst NICHT → nur fresh WS-Receives
// tragen es). Kill-Switch: localStorage renex_ratchet_shadow='0'.
// Wirft NIE (Login-/Chat-Flow-Schutz); Telemetrie im logWrapVerify-Stil.
// ======================================================
import { idbGet, idbSet, idbListKeys } from './idb.js';
import { deriveStorageKey, sealJson, openJson } from './deviceStore.js';
import { b64ToBytes, bytesToB64 } from './bytes.js';
import { x25519PublicKey } from './pqCrypto.js';
import {
  initInitiator, initResponder, nextSendKey, deriveReceiveKey,
  encodeRatchetHeader, decodeRatchetHeader, fingerprintMk,
  serializeRatchetState, deserializeRatchetState,
} from './ratchet.js';
import { ensureHybridSession, acceptHybridSession } from './hybridSession.js';
import { getRecipientDevices } from './sesame.js';
import { captureException } from './sentry.js';

const STORE_INFO = 'renex:ratchetshadow:store:v1';
const IDB_PREFIX = 'ratchetshadow:';
const STATS_KEY = 'renex_ratchet_shadow_stats';
const SEEN_CAP = 256;                          // Receive-Dedup-Ringpuffer pro Session
const _key = () => deriveStorageKey(STORE_INFO);
const _idbKey = (peer, dev) => `${IDB_PREFIX}${peer}:${dev}`;

export function shadowEnabled() {
  try { return localStorage.getItem('renex_ratchet_shadow') !== '0'; } catch { return true; }
}

// ── Per-Key-Mutex (race-frei via Promise-Verkettung) ───
const _tail = new Map();
function _withLock(key, fn) {
  const run = (_tail.get(key) || Promise.resolve()).then(fn, fn);   // fn läuft egal wie der Vorgänger endete
  _tail.set(key, run.then(() => {}, () => {}));                     // Tail fehlerfrei halten
  return run;
}

// ── Stats (localStorage + In-Memory-Fallback fürs ≥1000-Gate) ──
let _mem = { match: 0, mismatch: 0, skip: 0, err: 0 };
export function shadowStats() {
  try { return JSON.parse(localStorage.getItem(STATS_KEY)) || { ..._mem }; }
  catch { return { ..._mem }; }
}
function _bump(field) {
  _mem[field] = (_mem[field] || 0) + 1;                    // immer (überlebt localStorage-Ausfall)
  let s = _mem;
  try {
    s = shadowStats();
    s[field] = (s[field] || 0) + 1;
    localStorage.setItem(STATS_KEY, JSON.stringify(s));
    _mem = { ...s };
  } catch { /* private mode etc. → In-Memory zählt weiter */ }
  if (field === 'match' && s.match % 50 === 0) {
    console.log(`🧬 ratchet_shadow: ${s.match} matches (mismatch=${s.mismatch}, skip=${s.skip}, err=${s.err})`);
  }
  return s;
}

// ── State-Persistenz (versiegelt, device-scoped) ───────
async function _load(peer, dev) {
  const sealed = await idbGet(_idbKey(peer, dev));
  if (!sealed) return null;
  const o = await openJson(await _key(), sealed);
  return o ? { ...o, state: deserializeRatchetState(o.state), seen: o.seen || [] } : null;
}
async function _save(peer, dev, rec) {
  await idbSet(_idbKey(peer, dev), await sealJson(await _key(), {
    ...rec, state: serializeRatchetState(rec.state), seen: (rec.seen || []).slice(-SEEN_CAP),
  }));
}
// Existierende Shadow-Session des Peers finden — deterministisch (sortiert).
async function _findExisting(peer) {
  const pfx = `${IDB_PREFIX}${peer}:`;
  const keys = (await idbListKeys(pfx)) || [];
  if (!keys.length) return null;
  const dev = keys.map(k => k.slice(pfx.length)).sort()[0];
  const rec = await _load(peer, dev);
  return rec ? { dev, rec } : null;
}

// ======================================================
// Session-Priming (Netzwerk — NUR im Hintergrund, NIE am Send-Pfad)
// ======================================================
/**
 * Stellt (falls nötig) eine Initiator-Shadow-Session gegen EIN aktuell
 * pq-fähiges Peer-Device her. Single-flight pro Peer (via _withLock). Reuse
 * einer bestehenden Session nur, wenn ihr Device noch pq-aktiv ist.
 * @returns {Promise<{dev:string}|null>}
 */
export function primeShadowSession(peerHandle) {
  const peer = String(peerHandle || '').toLowerCase();
  if (!peer) return Promise.resolve(null);
  return _withLock(`prime:${peer}`, async () => {
    try {
      const devices = await getRecipientDevices(peer).catch(() => []);
      const active = new Set((devices || []).filter(d => d.hasKem && d.caps?.hybrid).map(d => d.deviceId));

      const existing = await _findExisting(peer);
      if (existing && active.has(existing.dev)) return { dev: existing.dev };   // noch gültig

      const target = [...active].sort()[0];
      if (!target) return null;                                                  // Peer (noch) nicht pq-fähig
      if (await _load(peer, target)) return { dev: target };                    // schon da

      const hs = await ensureHybridSession(peer, target);
      if (!hs?.peerSpkPub) return null;                                          // Alt-Record ohne Ratchet-Anker
      await _save(peer, target, {
        role: 'initiator', peerSeen: false, initHdr: hs.initHdr, seen: [],
        state: initInitiator(hs.rootKey, b64ToBytes(hs.peerSpkPub)),
      });
      return { dev: target };
    } catch (e) {
      console.warn('🧬 ratchet_shadow prime skip (non-fatal):', e?.message);
      return null;
    }
  });
}

// ======================================================
// SENDEN: Shadow-Feld für eine echte DM (lokal, kein Netzwerk)
// ======================================================
/**
 * @param {string} peerHandle
 * @param {{type?:string|null}} [opts] type≠null/'message' (Pulse/Control) → null
 * @returns {Promise<object|null>} Shadow-Wire-Feld oder null (skip)
 */
export async function shadowOnSend(peerHandle, { type = null } = {}) {
  try {
    if (!shadowEnabled()) return null;
    if (type && type !== 'message') return null;         // Pulse/Control NIE (Rekey-Storm-Guard)
    const peer = String(peerHandle || '').toLowerCase();
    if (!peer) return null;

    const existing = await _findExisting(peer);
    if (!existing) {
      void primeShadowSession(peer);                     // Hintergrund; DIESE Nachricht skippt
      _bump('skip');
      return null;
    }
    const { dev } = existing;

    return await _withLock(`sess:${peer}:${dev}`, async () => {
      const rec = await _load(peer, dev);                // frisch unter Lock (kein Lost-Update)
      if (!rec || !rec.state.cks) { _bump('skip'); return null; }   // Responder vor erstem Empfang: nicht sendefähig
      const { mk, header } = nextSendKey(rec.state);
      await _save(peer, dev, rec);
      return {
        v: 4, tgt: dev,
        header: encodeRatchetHeader(header),
        fp: bytesToB64(fingerprintMk(mk)),
        ...(rec.role === 'initiator' && !rec.peerSeen && rec.initHdr ? { init: rec.initHdr } : {}),
      };
    });
  } catch (e) {
    console.warn('🧬 ratchet_shadow send skip (non-fatal):', e?.message);
    _bump('err');
    return null;
  }
}

// ======================================================
// EMPFANGEN: parallel-derive + Fingerprint-Vergleich (verify+log)
// ======================================================
/**
 * @param {string} fromHandle       Absender (Wire `from`)
 * @param {string} senderDeviceId   Absender-Gerät (Wire `deviceId`)
 * @param {object|null} shadow      das Shadow-Wire-Feld der Nachricht
 * @param {string} myDeviceId       eigenes Gerät (tgt-Filter)
 * @param {string} [msgId]          Nachrichten-ID (Receive-Dedup gegen Redelivery)
 * @returns {Promise<'match'|'mismatch'|'skip'|'err'>}
 */
export async function shadowOnReceive(fromHandle, senderDeviceId, shadow, myDeviceId, msgId = '') {
  try {
    if (!shadowEnabled() || !shadow || typeof shadow !== 'object') return 'skip';
    if (shadow.v !== 4 || !shadow.header || !shadow.fp) return 'skip';
    if (shadow.tgt && myDeviceId && shadow.tgt !== myDeviceId) return 'skip';   // nicht für dieses Gerät (still)
    const peer = String(fromHandle || '').toLowerCase();
    const dev = String(senderDeviceId || '');
    if (!peer || !dev) { _bump('skip'); return 'skip'; }

    // Alles unter demselben Session-Lock wie der Send → acceptHybridSession läuft
    // GENAU EINMAL (kein doppelter OPK-Consume), kein State-Clobber.
    return await _withLock(`sess:${peer}:${dev}`, async () => {
      let rec = await _load(peer, dev);
      if (!rec) {
        if (!shadow.init) { _bump('skip'); return 'skip'; }   // Init verpasst (offline) → erst nächster Handshake
        const hs = await acceptHybridSession(peer, dev, shadow.init);   // verify+log intern (Dark-Launch)
        const spkPriv = b64ToBytes(hs.ownSpkPriv);
        rec = {
          role: 'responder', peerSeen: true, initHdr: null, seen: [],
          state: initResponder(hs.rootKey, { priv: spkPriv, pub: x25519PublicKey(spkPriv) }),
        };
      }

      // Idempotenz gegen WS-Redelivery: schon verarbeitete msgId → nicht erneut advancen.
      if (msgId && rec.seen?.includes(msgId)) { _bump('skip'); return 'skip'; }

      const mk = deriveReceiveKey(rec.state, decodeRatchetHeader(shadow.header));
      const match = bytesToB64(fingerprintMk(mk)) === shadow.fp;
      if (rec.role === 'initiator') rec.peerSeen = true;    // Antwort gesehen → init nicht mehr mitsenden
      if (msgId) rec.seen = [...(rec.seen || []), msgId].slice(-SEEN_CAP);
      await _save(peer, dev, rec);

      if (match) { _bump('match'); return 'match'; }
      console.warn(`🧬 ratchet_shadow MISMATCH ${peer}:${dev}`);
      try { captureException(new Error('ratchet_shadow_mismatch'), { context: 'ratchetShadow', where: `${peer}:${dev}` }); } catch {}
      _bump('mismatch');
      return 'mismatch';
    });
  } catch (e) {
    console.warn('🧬 ratchet_shadow recv err (non-fatal):', e?.message);
    _bump('err');
    return 'err';
  }
}
