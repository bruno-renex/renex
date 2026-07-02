// ======================================================
// ratchetShadow.js — P3.0 decrypt-only Dark-Launch (RATCHET_SEND=0)
// ======================================================
// Führt den Double-Ratchet (ratchet.js) als SCHATTEN parallel zum Legacy-
// CMK-Pfad: pro echter DM wird ein Shadow-MK abgeleitet und nur dessen
// 8-Byte-Fingerprint verglichen + gezählt. KEINE echte Krypto-Nutzung —
// die Nachricht selbst bleibt Legacy-verschlüsselt. Ziel (§4.4): ≥1000
// Live-Nachrichten mit 100% Match → Freigabe P3.1.
//
// Session-Identität = per-peer-device (§4.0 D1): Initiator wählt EIN
// pq-fähiges Ziel-Device (sesame); nur DAS Device kann folgen (InitHdr
// referenziert seine OPK) — andere Peer-Devices skippen still via `tgt`.
// Shadow-Wire (top-level, additiv, ~120B; +InitHdr ~2.2KB bis zur ersten
// Antwort): { v:4, tgt, header, fp, init? }.
//
// Ausschlüsse: Control-/Pulse-Typen (Rekey-Storm-Guard §4.4), History-
// Re-Reads (Server persistiert das Shadow-Feld bewusst NICHT → nur fresh
// WS-Receives tragen es). Kill-Switch: localStorage renex_ratchet_shadow='0'.
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
const _key = () => deriveStorageKey(STORE_INFO);
const _idbKey = (peer, dev) => `${IDB_PREFIX}${peer}:${dev}`;

export function shadowEnabled() {
  try { return localStorage.getItem('renex_ratchet_shadow') !== '0'; } catch { return true; }
}

// ── Stats (localStorage, fürs ≥1000-Gate ablesbar) ─────
export function shadowStats() {
  try { return JSON.parse(localStorage.getItem(STATS_KEY)) || { match: 0, mismatch: 0, skip: 0, err: 0 }; }
  catch { return { match: 0, mismatch: 0, skip: 0, err: 0 }; }
}
function _bump(field) {
  try {
    const s = shadowStats();
    s[field] = (s[field] || 0) + 1;
    localStorage.setItem(STATS_KEY, JSON.stringify(s));
    if (field === 'match' && s.match % 50 === 0) {
      console.log(`🧬 ratchet_shadow: ${s.match} matches (mismatch=${s.mismatch}, skip=${s.skip}, err=${s.err})`);
    }
    return s;
  } catch { return null; }
}

// ── State-Persistenz (versiegelt, device-scoped) ───────
async function _load(peer, dev) {
  const sealed = await idbGet(_idbKey(peer, dev));
  if (!sealed) return null;
  const o = await openJson(await _key(), sealed);
  return o ? { ...o, state: deserializeRatchetState(o.state) } : null;
}
async function _save(peer, dev, rec) {
  await idbSet(_idbKey(peer, dev), await sealJson(await _key(), { ...rec, state: serializeRatchetState(rec.state) }));
}
// Existierende Shadow-Session (irgendein Device) des Peers finden.
async function _findExisting(peer) {
  const keys = await idbListKeys(`${IDB_PREFIX}${peer}:`);
  if (!keys?.length) return null;
  const dev = keys[0].slice(`${IDB_PREFIX}${peer}:`.length);
  const rec = await _load(peer, dev);
  return rec ? { dev, rec } : null;
}

// ======================================================
// SENDEN: Shadow-Feld für eine echte DM erzeugen (oder null)
// ======================================================
/**
 * @param {string} peerHandle
 * @param {{type?:string|null}} [opts] type≠null/'message' (Pulse/Control) → null
 * @returns {Promise<object|null>} Shadow-Wire-Feld oder null (skip)
 */
export async function shadowOnSend(peerHandle, { type = null } = {}) {
  try {
    if (!shadowEnabled()) return null;
    if (type && type !== 'message') return null;   // Pulse/Control NIE (Rekey-Storm-Guard)
    const peer = String(peerHandle || '').toLowerCase();
    if (!peer) return null;

    // 1) Bestehende Session (egal welche Rolle) wiederverwenden.
    let dev, rec;
    const existing = await _findExisting(peer);
    if (existing) {
      ({ dev, rec } = existing);
    } else {
      // 2) Neuer Initiator-Handshake gegen EIN pq-fähiges Ziel-Device.
      const devices = await getRecipientDevices(peer).catch(() => []);
      const target = (devices || []).find(d => d.hasKem && d.caps?.hybrid);
      if (!target) { _bump('skip'); return null; }   // Peer (noch) nicht pq-fähig
      dev = target.deviceId;
      const hs = await ensureHybridSession(peer, dev);
      if (!hs?.peerSpkPub) { _bump('skip'); return null; }   // Alt-Record ohne Ratchet-Anker
      rec = {
        role: 'initiator', peerSeen: false, initHdr: hs.initHdr,
        state: initInitiator(hs.rootKey, b64ToBytes(hs.peerSpkPub)),
      };
    }

    if (!rec.state.cks) { _bump('skip'); return null; }   // Responder vor erstem Empfang: noch nicht sendefähig

    const { mk, header } = nextSendKey(rec.state);
    await _save(peer, dev, rec);
    return {
      v: 4,
      tgt: dev,                                    // nur DIESES Peer-Device kann folgen
      header: encodeRatchetHeader(header),
      fp: bytesToB64(fingerprintMk(mk)),
      // InitHdr mitsenden, bis der Peer geantwortet hat (Standard-Signal-Verhalten).
      ...(rec.role === 'initiator' && !rec.peerSeen && rec.initHdr ? { init: rec.initHdr } : {}),
    };
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
 * @returns {Promise<'match'|'mismatch'|'skip'|'err'>}
 */
export async function shadowOnReceive(fromHandle, senderDeviceId, shadow, myDeviceId) {
  try {
    if (!shadowEnabled() || !shadow || typeof shadow !== 'object') return 'skip';
    if (shadow.v !== 4 || !shadow.header || !shadow.fp) return 'skip';
    if (shadow.tgt && myDeviceId && shadow.tgt !== myDeviceId) return 'skip';   // nicht für dieses Gerät (still)
    const peer = String(fromHandle || '').toLowerCase();
    const dev = String(senderDeviceId || '');
    if (!peer || !dev) { _bump('skip'); return 'skip'; }

    // Session laden / via InitHdr aufbauen (accept NUR wenn kein State —
    // sonst würde die one-time-OPK erneut konsumiert).
    let rec = await _load(peer, dev);
    if (!rec) {
      if (!shadow.init) { _bump('skip'); return 'skip'; }   // Init verpasst (z.B. offline) → erst nächster Handshake
      const hs = await acceptHybridSession(peer, dev, shadow.init);   // verify+log intern (Dark-Launch)
      const spkPriv = b64ToBytes(hs.ownSpkPriv);
      rec = {
        role: 'responder', peerSeen: true, initHdr: null,
        state: initResponder(hs.rootKey, { priv: spkPriv, pub: x25519PublicKey(spkPriv) }),
      };
    }

    const mk = deriveReceiveKey(rec.state, decodeRatchetHeader(shadow.header));
    const match = bytesToB64(fingerprintMk(mk)) === shadow.fp;
    if (rec.role === 'initiator') rec.peerSeen = true;      // Antwort gesehen → init nicht mehr mitsenden
    await _save(peer, dev, rec);

    if (match) { _bump('match'); return 'match'; }
    // Divergenz = das eigentliche Dark-Launch-Signal → warn + Sentry (Muster logWrapVerify 'invalid').
    console.warn(`🧬 ratchet_shadow MISMATCH ${peer}:${dev}`);
    try { captureException(new Error('ratchet_shadow_mismatch'), { context: 'ratchetShadow', where: `${peer}:${dev}` }); } catch {}
    _bump('mismatch');
    return 'mismatch';
  } catch (e) {
    // skip_limit/Header-Fehler etc.: console-only (Rollout-Rauschen, Muster logWrapVerify)
    console.warn('🧬 ratchet_shadow recv err (non-fatal):', e?.message);
    _bump('err');
    return 'err';
  }
}
