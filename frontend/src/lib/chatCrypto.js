// ======================================================
// Chat-Crypto — Pure E2E-Encrypt/Decrypt
// ======================================================
// Port aus renex-legacy/js/chatCrypto.js (Lines 21-55).
// Pure Functions, keine State-Deps. Wird von session.js genutzt um
// Message-Keys auf Plaintext anzuwenden, und von Send/Receive-Pipeline.
//
// Tests: tests/chatCrypto.test.js (bereits vorhanden — testet legacy-Quelle,
// hier identische Implementation → Tests gelten).
// ======================================================

import { abToB64, b64ToAb } from './bytes.js';

/**
 * AES-GCM Encrypt eines Strings.
 * @param {CryptoKey} aesKey - AES-GCM 256
 * @param {string} plaintext - UTF-8
 * @returns {Promise<{ivB64: string, ctB64: string}>}
 */
export async function e2eEncrypt(aesKey, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    data
  );
  return { ivB64: abToB64(iv.buffer), ctB64: abToB64(ciphertext) };
}

/**
 * AES-GCM Decrypt zurück zu UTF-8-String.
 * @param {CryptoKey} aesKey
 * @param {string} ivB64
 * @param {string} ctB64
 * @returns {Promise<string>}
 */
export async function e2eDecrypt(aesKey, ivB64, ctB64) {
  const iv = new Uint8Array(b64ToAb(ivB64));
  const ciphertext = b64ToAb(ctB64);
  const plaintextBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    ciphertext
  );
  return new TextDecoder().decode(plaintextBuf);
}

/**
 * AES-GCM Encrypt von beliebigen Bytes (z.B. Files).
 * @param {CryptoKey} aesKey
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Promise<{ivB64: string, ctBytes: Uint8Array}>}
 */
export async function e2eEncryptBytes(aesKey, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    bytes
  );
  return { ivB64: abToB64(iv.buffer), ctBytes: new Uint8Array(ct) };
}

/**
 * AES-GCM Decrypt von beliebigen Bytes.
 * @param {CryptoKey} aesKey
 * @param {string} ivB64
 * @param {Uint8Array|ArrayBuffer} ctBytes
 * @returns {Promise<Uint8Array>}
 */
export async function e2eDecryptBytes(aesKey, ivB64, ctBytes) {
  const iv = new Uint8Array(b64ToAb(ivB64));
  const ct = ctBytes instanceof Uint8Array ? ctBytes.buffer : ctBytes;
  const plaintextBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    ct
  );
  return new Uint8Array(plaintextBuf);
}
