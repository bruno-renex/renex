// ======================================================
// Message-Signaturen — ECDSA-P256
// ======================================================
// Port aus renex-legacy/js/e2e.js (Lines 660-731).
//
// Schützt ctB64 vor Backend-Manipulation:
//   sign(privKey, `${ivB64}|${ctB64}|${sid}|${epoch}`) → sigB64
//   verify(pubKey, sigB64, gleicher Input) → true/false
//
// Sender-PrivKey kommt aus e2eKeys.js (lokal in IDB).
// Empfänger-PubKey kommt aus cmk.js (Peer-Device-Cache).
//
// Spec: docs/MULTI_DEVICE.md §4.2 (Send-Flow, Schritt "Signiere")
// ======================================================

import { idbGet } from './idb.js';
import { bytesToB64, b64ToBytes } from './bytes.js';

const IDB_SIG_KEYPAIR = 'sig_keypair';

/**
 * Lädt den Signing-Private-Key aus IDB (über e2eKeys.js init persistiert).
 * Returns null wenn Keypair nicht initialisiert ist.
 */
async function loadSigningPrivKey() {
  const saved = await idbGet(IDB_SIG_KEYPAIR);
  if (!saved?.priv) return null;
  try {
    return await crypto.subtle.importKey(
      'jwk', saved.priv,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, ['sign']
    );
  } catch {
    return null;
  }
}

/**
 * Signiert eine Message mit dem Device-Private-Key.
 * Format: `${ivB64}|${ctB64}|${sid}|${epoch}` — UTF-8 → SHA-256 → ECDSA
 *
 * @returns {Promise<string>} Signature als Base64
 */
export async function signMessage(ivB64, ctB64, sid, epoch) {
  const privKey = await loadSigningPrivKey();
  if (!privKey) throw new Error('No signing key — initE2EKeys + uploadInboxKeyIfNeeded first');

  const data = new TextEncoder().encode(`${ivB64}|${ctB64}|${sid}|${epoch}`);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privKey,
    data
  );
  return bytesToB64(new Uint8Array(sig));
}

/**
 * Verifiziert eine Message-Signatur gegen den Sender-PubKey.
 * Returns false bei jedem Fehler (Verify-failed, Key-Import-failed, etc.).
 *
 * @param {string} ivB64
 * @param {string} ctB64
 * @param {string} sid
 * @param {number} epoch
 * @param {string} sigB64
 * @param {object} pubJwk - Sender-Sig-Pubkey (aus Peer-Device-Cache)
 * @returns {Promise<boolean>}
 */
export async function verifyMessageSig(ivB64, ctB64, sid, epoch, sigB64, pubJwk) {
  try {
    const pubKey = await crypto.subtle.importKey(
      'jwk', pubJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, ['verify']
    );
    const data = new TextEncoder().encode(`${ivB64}|${ctB64}|${sid}|${epoch}`);
    const sig  = b64ToBytes(sigB64);
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pubKey,
      sig,
      data
    );
  } catch {
    return false;
  }
}
