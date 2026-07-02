// ======================================================
// ratchet.js — Double-Ratchet-Kern (pure) — Migration P3.0
// ======================================================
// Signal-Double-Ratchet über dem PQXDH-RK0 (hybridSession, §4.0/§4.4).
// NUR die Schlüssel-Maschine: KDF-Kette, DH-Ratchet-Steps, Header-Codec,
// Skipped-Key-Ableitung. KEIN encrypt/decrypt (P3.1), KEIN IDB (ratchetSession,
// P3.1), KEIN PQ-Epoch-Rekey (pqRatchet, P3.2 — Header trägt kemEpoch=0 als
// Forward-Compat-Feld).
//
// Bauplan-fixierte KDFs (§4.4):
//   kdfRootKey(RK, dhOut) → (RK', CK)   HKDF-SHA256(ikm=dhOut, salt=RK, info=DOMAIN, 64)
//   kdfChainKey(CK)       → (CK', MK)   MK = HMAC(CK, 0x01), CK' = HMAC(CK, 0x02)
// Initial-Konvention (Signal): Bobs SPK ist der erste Ratchet-DHr des
// Initiators; Bob startet mit dem SPK-Paar als DHs und ratcht beim ersten
// empfangenen Header. RK0 kommt opak aus ensureHybridSession/acceptHybridSession.
//
// State = serialisierbares plain object (Uint8Arrays) — pure Funktionen
// mutieren ihn kontrolliert; Node-testbar (Stil rateLimiterDO.js/pqxdh.js).
// ======================================================
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { x25519Keygen, x25519Shared } from './pqCrypto.js';
import { bytesToB64, b64ToBytes } from './bytes.js';

const ROOT_DOMAIN = new TextEncoder().encode('renex:ratchet:root:v4');
const FP_DOMAIN = new TextEncoder().encode('renex:ratchet:fp:v1');
const MK_BYTE = new Uint8Array([0x01]);
const CK_BYTE = new Uint8Array([0x02]);

// DoS-Schutz: maximal so viele Message-Keys pro Kette „überspringen".
export const MAX_SKIP = 256;

// ── KDFs (fixiert, §4.4) ───────────────────────────────
/** HKDF-Root-Step: (RK, dhOut) → { rk, ck } (je 32B). */
export function kdfRootKey(rk, dhOut) {
  const out = hkdf(sha256, dhOut, rk, ROOT_DOMAIN, 64);
  return { rk: out.slice(0, 32), ck: out.slice(32, 64) };
}
/** Symmetric-Step: CK → { ck, mk } mit MK=HMAC(CK,0x01), CK'=HMAC(CK,0x02). */
export function kdfChainKey(ck) {
  return { mk: hmac(sha256, ck, MK_BYTE), ck: hmac(sha256, ck, CK_BYTE) };
}
/** 8-Byte-MK-Fingerprint (one-way, domain-separiert) — für den Shadow-Vergleich. */
export function fingerprintMk(mk) {
  return hmac(sha256, mk, FP_DOMAIN).slice(0, 8);
}

// ── Init (D3-Rollen, RK0 aus PQXDH) ────────────────────
/**
 * Initiator (Alice): frisches Ratchet-Paar, sofortiger Root-Step gegen Bobs SPK.
 * @param {Uint8Array} rk0     32B Root aus ensureHybridSession
 * @param {Uint8Array} spkBPub Bobs Signed-Prekey-Pub (initialer DHr, Signal-Konvention)
 */
export function initInitiator(rk0, spkBPub) {
  const dhs = x25519Keygen();
  const { rk, ck } = kdfRootKey(rk0, x25519Shared(dhs.priv, spkBPub));
  return {
    role: 'initiator',
    rk, dhsPriv: dhs.priv, dhsPub: dhs.pub, dhr: spkBPub,
    cks: ck, ckr: null,
    ns: 0, nr: 0, pn: 0,
    skipped: {},               // "dhPubB64:n" → mkB64 (Cap MAX_SKIP via Ableitung)
  };
}
/**
 * Responder (Bob): startet mit dem SPK-Paar als DHs; erster Header triggert
 * den DH-Step (dann existiert CKr/CKs).
 * @param {Uint8Array} rk0      32B Root aus acceptHybridSession
 * @param {{priv:Uint8Array,pub:Uint8Array}} spkPair eigenes SPK-Paar (aus pqxdhKeys)
 */
export function initResponder(rk0, spkPair) {
  return {
    role: 'responder',
    rk: rk0, dhsPriv: spkPair.priv, dhsPub: spkPair.pub, dhr: null,
    cks: null, ckr: null,
    ns: 0, nr: 0, pn: 0,
    skipped: {},
  };
}

// ── Header-Codec (Wire §4.4: header_b64) ───────────────
/** {v:4, dh, pn, n, kemEpoch} → b64(JSON). pqCt folgt P3.2 (additiv). */
export function encodeRatchetHeader({ dh, pn, n, kemEpoch = 0 }) {
  const json = JSON.stringify({ v: 4, dh: bytesToB64(dh), pn, n, kemEpoch });
  return bytesToB64(new TextEncoder().encode(json));
}
export function decodeRatchetHeader(headerB64) {
  const h = JSON.parse(new TextDecoder().decode(b64ToBytes(headerB64)));
  if (h?.v !== 4 || typeof h.dh !== 'string' || !Number.isInteger(h.pn) || !Number.isInteger(h.n)) {
    throw new Error('ratchet_header_invalid');
  }
  return { v: 4, dh: b64ToBytes(h.dh), pn: h.pn, n: h.n, kemEpoch: h.kemEpoch || 0 };
}

// ── Senden: nächster MK + Header ───────────────────────
/** Rückt die Sende-Kette vor. @returns {{mk, header:{dh,pn,n,kemEpoch}}} */
export function nextSendKey(state) {
  if (!state.cks) throw new Error('ratchet_no_send_chain');   // Responder vor erstem Empfang
  const { ck, mk } = kdfChainKey(state.cks);
  const header = { dh: state.dhsPub, pn: state.pn, n: state.ns, kemEpoch: 0 };
  state.cks = ck;
  state.ns += 1;
  return { mk, header };
}

// ── Empfangen: MK zum Header ableiten ──────────────────
const _skKey = (dhPub, n) => `${bytesToB64(dhPub)}:${n}`;

// Restliche Keys der AKTUELLEN Empfangs-Kette bis `until` überspringen+cachen.
function _skipTo(state, until) {
  if (!state.ckr) return;
  if (until - state.nr > MAX_SKIP) throw new Error('ratchet_skip_limit');
  while (state.nr < until) {
    const { ck, mk } = kdfChainKey(state.ckr);
    state.skipped[_skKey(state.dhr, state.nr)] = bytesToB64(mk);
    state.ckr = ck;
    state.nr += 1;
  }
}

// DH-Ratchet-Step bei neuem Remote-Pub (§4.4 dhRatchetStep).
function _dhStep(state, dhrNew) {
  state.pn = state.ns;
  state.ns = 0;
  state.nr = 0;
  state.dhr = dhrNew;
  const r1 = kdfRootKey(state.rk, x25519Shared(state.dhsPriv, state.dhr));
  state.rk = r1.rk; state.ckr = r1.ck;
  const dhs = x25519Keygen();
  state.dhsPriv = dhs.priv; state.dhsPub = dhs.pub;
  const r2 = kdfRootKey(state.rk, x25519Shared(state.dhsPriv, state.dhr));
  state.rk = r2.rk; state.cks = r2.ck;
}

/**
 * Leitet den MK für einen empfangenen Header ab (inkl. Skipped-Keys +
 * DH-Steps). Konsumiert Skipped-Einträge (one-time).
 * @param {object} state  mutiert
 * @param {{dh:Uint8Array, pn:number, n:number}} header
 * @returns {Uint8Array} mk
 */
export function deriveReceiveKey(state, header) {
  // 1) Bereits übersprungener Key?
  const cached = state.skipped[_skKey(header.dh, header.n)];
  if (cached) {
    delete state.skipped[_skKey(header.dh, header.n)];
    return b64ToBytes(cached);
  }
  // 2) Neuer Remote-Ratchet-Pub → alte Kette bis pn zu Ende skippen, dann Step.
  const isNewDh = !state.dhr || bytesToB64(header.dh) !== bytesToB64(state.dhr);
  if (isNewDh) {
    _skipTo(state, header.pn);
    _dhStep(state, header.dh);
  }
  // 3) Innerhalb der (jetzt) aktuellen Kette bis n skippen, dann ableiten.
  _skipTo(state, header.n);
  const { ck, mk } = kdfChainKey(state.ckr);
  state.ckr = ck;
  state.nr += 1;
  return mk;
}

// ── Serialisierung (für IDB via ratchetSession/Shadow) ─
const _b = (v) => (v ? bytesToB64(v) : null);
const _u = (v) => (v ? b64ToBytes(v) : null);
export function serializeRatchetState(s) {
  return {
    role: s.role, rk: _b(s.rk), dhsPriv: _b(s.dhsPriv), dhsPub: _b(s.dhsPub),
    dhr: _b(s.dhr), cks: _b(s.cks), ckr: _b(s.ckr),
    ns: s.ns, nr: s.nr, pn: s.pn, skipped: { ...s.skipped },
  };
}
export function deserializeRatchetState(o) {
  return {
    role: o.role, rk: _u(o.rk), dhsPriv: _u(o.dhsPriv), dhsPub: _u(o.dhsPub),
    dhr: _u(o.dhr), cks: _u(o.cks), ckr: _u(o.ckr),
    ns: o.ns, nr: o.nr, pn: o.pn, skipped: { ...(o.skipped || {}) },
  };
}
