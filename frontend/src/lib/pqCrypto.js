// ======================================================
// PQ-Krypto-Fundament (Migration M0.5)
// ======================================================
// Dünne Wrapper um @noble/post-quantum (ML-KEM-768) + @noble/curves (X25519)
// und der EINE CT-bindende Hybrid-Combiner, den alle Migrations-Phasen teilen
// (PQXDH-Root P2, Ratchet-Rekey P3.2, Wrap P1, Recovery-Anker P5).
//
// Reine Bytes (Uint8Array), synchron, pure — testbar in Node (KATs). Läuft
// identisch im Browser + Cloudflare-Worker-Isolate. NICHT von Live-Code
// importiert (M0.5 = Fundament) → tree-shaking hält es aus dem App-Bundle.
//
// ⚠️ EHRLICH: @noble/post-quantum ist self-audited (unabh. Audit ~2026), KEIN
// Constant-Time-Schutz in reinem JS; ML-KEM-`dk` liegt extractable im IDB. Für
// das Remote-Bedrohungsmodell eines Async-Messengers dokumentierbar akzeptabel.
// ======================================================
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

// Feste Größen (die „KAT"-Invarianten — Byte-Längen der ML-KEM-768-Artefakte).
export const PQ = Object.freeze({
  ML_KEM_EK: 1184,   // encapsulation key (public)
  ML_KEM_DK: 2400,   // decapsulation key (secret)
  ML_KEM_CT: 1088,   // ciphertext
  SS: 32,            // shared secret (KEM + X25519)
  X25519_KEY: 32,    // X25519 pub/priv
});

// ── ML-KEM-768 ──────────────────────────────────────────
export function mlKemKeygen() {
  const { publicKey, secretKey } = ml_kem768.keygen();
  return { ek: publicKey, dk: secretKey };
}
export function mlKemEncapsulate(peerEk) {
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(peerEk);
  return { ct: cipherText, ss: sharedSecret };
}
export function mlKemDecapsulate(ct, dk) {
  return ml_kem768.decapsulate(ct, dk);
}

// ── X25519 ──────────────────────────────────────────────
export function x25519Keygen() {
  const priv = x25519.utils.randomSecretKey();
  return { priv, pub: x25519.getPublicKey(priv) };
}
export function x25519PublicKey(priv) {
  return x25519.getPublicKey(priv);
}
export function x25519Shared(myPriv, peerPub) {
  return x25519.getSharedSecret(myPriv, peerPub);
}

// ── Ed25519 (Identitäts-Signaturen für Prekeys / InitHdr) ───
export function ed25519Keygen() {
  const priv = ed25519.utils.randomSecretKey();
  return { priv, pub: ed25519.getPublicKey(priv) };
}
export function edSign(msg, priv) {
  return ed25519.sign(msg, priv);
}
export function edVerify(sig, msg, pub) {
  try { return ed25519.verify(sig, msg, pub); } catch { return false; }
}

// ── CT-bindender Hybrid-Combiner ────────────────────────
const _enc = new TextEncoder();
// 2-Byte-BE Längenpräfix ‖ Bytes — verhindert Concatenation-Ambiguity
// (variabel-lange Felder ohne Präfix wären der klassische Foot-Gun).
function _lp(x) {
  const b = x instanceof Uint8Array ? x : _enc.encode(String(x));
  const out = new Uint8Array(2 + b.length);
  out[0] = (b.length >>> 8) & 0xff;
  out[1] = b.length & 0xff;
  out.set(b, 2);
  return out;
}
function _concat(arrs) {
  let n = 0; for (const a of arrs) n += a.length;
  const out = new Uint8Array(n); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// Wiederverwendbar für andere Hybrid-KDFs (pqxdh.js Root, P3 Rekey).
export { _lp as lenPrefix, _concat as concatBytes };

/**
 * Der EINE Hybrid-Wrap-Key-Combiner (verbindlich, überall identisch).
 * wrapKey = HKDF-SHA256(ikm = ss_ecdh ‖ ss_pq,
 *                       salt,
 *                       info = domain ‖ algoVersion ‖ sid ‖ kemCT ‖ pubA ‖ pubB)
 * Alle info-Segmente 2-Byte-BE-längenpräfixiert. Bindet den ML-KEM-CT UND beide
 * Pubkeys ins info → IND-CCA-Erhalt (ein TOFU-Server kann keinen eigenen
 * KEM-Pubkey unterschieben, ohne den Wrap-Key zu ändern).
 *
 * @returns {Uint8Array} 32-Byte Wrap-Key (Default `length`)
 */
export function deriveHybridWrapKey({
  ssEcdh, ssPq, kemCt, pubA, pubB,
  algoVersion = 3, sid = '', salt = new Uint8Array(0), length = 32,
}) {
  const ikm = _concat([ssEcdh, ssPq]);
  const info = _concat([
    _lp('renex:hybridwrap:v3'),
    _lp(new Uint8Array([algoVersion & 0xff])),
    _lp(sid),
    _lp(kemCt),
    _lp(pubA),
    _lp(pubB),
  ]);
  return hkdf(sha256, ikm, salt, info, length);
}
