// ======================================================
// Chat-Crypto — Pure E2E-Encrypt/Decrypt
// ======================================================
// Pure Functions, keine State-Deps. Wird von session.js genutzt um
// Message-Keys auf Plaintext anzuwenden, und von Send/Receive-Pipeline.
//
// AAD (Additional Authenticated Data, AES-GCM): optionaler Parameter
// für Wire-Format-Versionierung / Domain-Binding (defense-in-depth).
// AAD wird MITAUTHENTIFIZIERT aber NICHT verschlüsselt — wenn beim
// Decrypt eine andere AAD verwendet wird als beim Encrypt, schlägt
// der Auth-Tag-Check fehl. Use-Cases:
//   - Wire-Versionierung: aad = "renex:e2e:v1"
//   - Cross-Layer-Cipher-Misuse-Schutz: aad = "renex:dm:v1" vs "renex:group:v1"
//
// Default ist `aad = null` (entspricht klassischem AES-GCM ohne AAD,
// backward-compat zu allen bestehenden Cipher-Texten).
// ======================================================

import { abToB64, b64ToAb } from './bytes.js';

/**
 * Normalisiert AAD-Eingabe zu Uint8Array oder undefined.
 * Strings werden via UTF-8 encodet.
 */
function _normalizeAad(aad) {
  if (aad == null) return undefined;
  if (typeof aad === 'string') return new TextEncoder().encode(aad);
  if (aad instanceof Uint8Array) return aad;
  if (aad instanceof ArrayBuffer) return new Uint8Array(aad);
  throw new TypeError('aad must be string, Uint8Array, ArrayBuffer, or null');
}

/**
 * AES-GCM Encrypt eines Strings.
 * @param {CryptoKey} aesKey - AES-GCM 256
 * @param {string} plaintext - UTF-8
 * @param {string|Uint8Array|ArrayBuffer|null} [aad] - optional Additional Authenticated Data
 * @returns {Promise<{ivB64: string, ctB64: string}>}
 */
export async function e2eEncrypt(aesKey, plaintext, aad = null) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const params = { name: 'AES-GCM', iv };
  const ad = _normalizeAad(aad);
  if (ad) params.additionalData = ad;
  const ciphertext = await crypto.subtle.encrypt(params, aesKey, data);
  return { ivB64: abToB64(iv.buffer), ctB64: abToB64(ciphertext) };
}

/**
 * AES-GCM Decrypt zurück zu UTF-8-String.
 * @param {CryptoKey} aesKey
 * @param {string} ivB64
 * @param {string} ctB64
 * @param {string|Uint8Array|ArrayBuffer|null} [aad] - muss zum Encrypt-AAD passen
 * @returns {Promise<string>}
 */
export async function e2eDecrypt(aesKey, ivB64, ctB64, aad = null) {
  const iv = new Uint8Array(b64ToAb(ivB64));
  const ciphertext = b64ToAb(ctB64);
  const params = { name: 'AES-GCM', iv };
  const ad = _normalizeAad(aad);
  if (ad) params.additionalData = ad;
  const plaintextBuf = await crypto.subtle.decrypt(params, aesKey, ciphertext);
  return new TextDecoder().decode(plaintextBuf);
}

/**
 * AES-GCM Encrypt von beliebigen Bytes (z.B. Files).
 * @param {CryptoKey} aesKey
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {string|Uint8Array|ArrayBuffer|null} [aad]
 * @returns {Promise<{ivB64: string, ctBytes: Uint8Array}>}
 */
export async function e2eEncryptBytes(aesKey, bytes, aad = null) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const params = { name: 'AES-GCM', iv };
  const ad = _normalizeAad(aad);
  if (ad) params.additionalData = ad;
  const ct = await crypto.subtle.encrypt(params, aesKey, bytes);
  return { ivB64: abToB64(iv.buffer), ctBytes: new Uint8Array(ct) };
}

/**
 * AES-GCM Decrypt von beliebigen Bytes.
 * @param {CryptoKey} aesKey
 * @param {string} ivB64
 * @param {Uint8Array|ArrayBuffer} ctBytes
 * @param {string|Uint8Array|ArrayBuffer|null} [aad]
 * @returns {Promise<Uint8Array>}
 */
export async function e2eDecryptBytes(aesKey, ivB64, ctBytes, aad = null) {
  const iv = new Uint8Array(b64ToAb(ivB64));
  const ct = ctBytes instanceof Uint8Array ? ctBytes.buffer : ctBytes;
  const params = { name: 'AES-GCM', iv };
  const ad = _normalizeAad(aad);
  if (ad) params.additionalData = ad;
  const plaintextBuf = await crypto.subtle.decrypt(params, aesKey, ct);
  return new Uint8Array(plaintextBuf);
}
