// ======================================================
// PQXDH — hybrider Handshake-Root (X3DH-DHs + ML-KEM-768) — Migration M2
// ======================================================
// Der kryptografische Kern des Handshakes: Initiator (Alice) und Responder (Bob)
// leiten aus mehreren X25519-DHs + einer ML-KEM-Encapsulation denselben 32-Byte
// Root-Key RK0 ab, der (via ensureHybridSession, P2/P3) den Double-Ratchet
// initialisiert. Ehrlicher Claim: hybrid PQ-Vertraulichkeit; Identitäts-Auth
// bleibt klassisch (Ed25519-Prekey-Signaturen).
//
// Pure Funktionen → Node-Round-Trip-Test. Kein Infra/Live-Impact.
// ======================================================
import {
  x25519Shared, x25519PublicKey,
  mlKemEncapsulate, mlKemDecapsulate,
  edSign, edVerify,
  lenPrefix, concatBytes,
} from './pqCrypto.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

const ROOT_DOMAIN = 'renex:pqxdh:root:v3';
const F32 = new Uint8Array(32).fill(0xff);   // X3DH-Kurven-Domain-Separator

// RK0 = HKDF(ikm = F ‖ DH1 ‖ DH2 ‖ DH3 ‖ [DH4] ‖ ss_pq,
//            info = domain ‖ kemCt ‖ ikAX ‖ ikBX)
// DH-Reihenfolge fix; DH4 (OPK) MUSS auf beiden Seiten identisch present/absent
// sein (via usedOpk). Bindet kemCt + BEIDE Identitäts-X25519-Pubs → gegen
// Unknown-Key-Share + CT-Substitution.
function _root(dhs, ssPq, kemCt, ikAX, ikBX) {
  const ikm = concatBytes([F32, ...dhs, ssPq]);
  const info = concatBytes([lenPrefix(ROOT_DOMAIN), lenPrefix(kemCt), lenPrefix(ikAX), lenPrefix(ikBX)]);
  return hkdf(sha256, ikm, new Uint8Array(0), info, 32);
}

// ── Prekey-Signaturen (SPK / PQSPK signiert vom IK-Ed25519) ──
function _prekeyMsg(label, pubBytes) {
  return concatBytes([lenPrefix(`renex:pqxdh:prekey:${label}`), lenPrefix(pubBytes)]);
}
export function signPrekey(label, pubBytes, ikEdPriv) {
  return edSign(_prekeyMsg(label, pubBytes), ikEdPriv);
}
export function verifyPrekey(label, pubBytes, sig, ikEdPub) {
  return edVerify(sig, _prekeyMsg(label, pubBytes), ikEdPub);
}

/**
 * Initiator (Alice): verifiziert Bobs Prekey-Signaturen, rechnet DHs + KEM → RK0.
 * @param {{ ikAPriv, ekAPriv, bundle:{ ikEdPub, ikX, spkX, spkSig, opkX?, pqspkEk, pqspkSig } }} p
 * @returns {{ rk0: Uint8Array, kemCt: Uint8Array, usedOpk: boolean }}
 * @throws bei ungültiger SPK/PQSPK-Signatur
 */
export function initiatorRoot({ ikAPriv, ekAPriv, bundle }) {
  const { ikEdPub, ikX, spkX, spkSig, opkX = null, pqspkEk, pqspkSig } = bundle;
  if (!verifyPrekey('spk', spkX, spkSig, ikEdPub)) throw new Error('spk_sig_invalid');
  if (!verifyPrekey('pqspk', pqspkEk, pqspkSig, ikEdPub)) throw new Error('pqspk_sig_invalid');

  const ikAX = x25519PublicKey(ikAPriv);
  const dhs = [
    x25519Shared(ikAPriv, spkX),   // DH1: IK_A · SPK_B
    x25519Shared(ekAPriv, ikX),    // DH2: EK_A · IK_B
    x25519Shared(ekAPriv, spkX),   // DH3: EK_A · SPK_B
  ];
  if (opkX) dhs.push(x25519Shared(ekAPriv, opkX));   // DH4: EK_A · OPK_B (optional)

  const { ct, ss } = mlKemEncapsulate(pqspkEk);
  return { rk0: _root(dhs, ss, ct, ikAX, ikX), kemCt: ct, usedOpk: !!opkX };
}

/**
 * Responder (Bob): rechnet dieselben DHs + KEM-Decapsulation → dasselbe RK0.
 * @returns {Uint8Array} rk0
 */
export function responderRoot({ ikBPriv, spkBPriv, opkBPriv = null, pqspkDk, ikAX, ekAX, kemCt, usedOpk }) {
  const ikBX = x25519PublicKey(ikBPriv);
  const dhs = [
    x25519Shared(spkBPriv, ikAX),  // DH1: SPK_B · IK_A
    x25519Shared(ikBPriv, ekAX),   // DH2: IK_B · EK_A
    x25519Shared(spkBPriv, ekAX),  // DH3: SPK_B · EK_A
  ];
  if (usedOpk) {
    if (!opkBPriv) throw new Error('opk_priv_missing');
    dhs.push(x25519Shared(opkBPriv, ekAX));  // DH4: OPK_B · EK_A
  }
  const ss = mlKemDecapsulate(kemCt, pqspkDk);
  return _root(dhs, ss, kemCt, ikAX, ikBX);
}
