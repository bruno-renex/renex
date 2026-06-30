// ======================================================
// Recovery Lib — BIP39 + PBKDF2 + AES-GCM für Account-Recovery
// ======================================================
// Spec: docs/RECOVERY.md §4 (Krypto-Setup)
//
// Public API:
//   Phrase:       generatePhrase, validatePhrase
//   Crypto:       deriveMasterKey, encryptBundle, decryptBundle
//   Helpers:      randomSalt, bytesToB64, b64ToBytes
//   API-Calls:    getRecoveryStatus, initRecovery, getBundle, putBundle, markVerified
//
// Bundle-Format (Plaintext):
//   { v:1, ts: number, cmks: { [convoId]: base64-key }, gsks: { [groupId]: base64-key } }
//
// Bundle-Format (Encrypted):
//   [12 Bytes IV] [AES-GCM-Ciphertext]
// ======================================================

import { generateMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { apiFetch } from './api.js';
import { captureException } from './sentry.js';

// ── BIP39-Konstanten ──────────────────────────────────────
const BIP39_STRENGTH_BITS = 128;  // → 12 Wörter
const BIP39_WORD_COUNT    = 12;

// ── PBKDF2-Konstanten (Spec §4.2, §4.5) ───────────────────
// SECURITY: Änderung dieser Konstanten verändert die Brute-Force-Resistenz.
// Test tests/recoveryConstants.test.js lockt sie — Update der Tests + Spec
// und Security-Review Pflicht bei jeder Änderung.
export const PBKDF2_ITERATIONS = 600_000;
export const PBKDF2_HASH       = 'SHA-256';
export const MASTER_KEY_BITS   = 256;

// ── AES-GCM-Konstanten ────────────────────────────────────
export const AES_IV_SIZE       = 12;   // 96 bits — Standard für AES-GCM
export const SALT_SIZE         = 16;   // 128 bits

// ======================================================
// Phrase: Generierung + Validierung
// ======================================================

/**
 * Generiert eine zufällige 12-Wort-Phrase via BIP39 (englisches Wordlist).
 * Verwendet crypto.getRandomValues unter der Haube.
 * @returns {string} z.B. "abandon ability able about above absent absorb abstract absurd abuse access accident"
 */
export function generatePhrase() {
  return generateMnemonic(englishWordlist, BIP39_STRENGTH_BITS);
}

/**
 * Prüft ob eine Phrase BIP39-valide ist (Wordlist + Checksum).
 * @param {string} phrase - User-Input, wird normalisiert (lowercase, trim, whitespace-collapse)
 * @returns {boolean}
 */
export function validatePhrase(phrase) {
  if (typeof phrase !== 'string') return false;
  const normalized = normalizePhrase(phrase);
  if (!normalized) return false;
  if (normalized.split(' ').length !== BIP39_WORD_COUNT) return false;
  try {
    return validateMnemonic(normalized, englishWordlist);
  } catch {
    return false;
  }
}

/**
 * Normalisiert User-Input: lowercase, trim, multiple-spaces → single-space.
 * @param {string} phrase
 * @returns {string}
 */
export function normalizePhrase(phrase) {
  return String(phrase || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Splittet eine Phrase in ihre Wörter.
 * @param {string} phrase
 * @returns {string[]} 12 Wörter (oder weniger bei invalidem Input)
 */
export function phraseToWords(phrase) {
  const norm = normalizePhrase(phrase);
  return norm ? norm.split(' ') : [];
}

// ======================================================
// Master-Key-Derivation
// ======================================================

/**
 * Leitet den Master-Key aus Phrase + Salt ab via PBKDF2.
 * Achtung: braucht ~500ms auf moderner Hardware → Loading-Indikator zeigen.
 *
 * @param {string} phrase - 12-Wort-Phrase (wird intern NFKD-normalisiert)
 * @param {Uint8Array} salt - 16 Bytes
 * @returns {Promise<CryptoKey>} AES-GCM-Key (extractable=false)
 */
export async function deriveMasterKey(phrase, salt) {
  if (!validatePhrase(phrase)) {
    throw new Error('invalid_phrase');
  }
  if (!(salt instanceof Uint8Array) || salt.length !== SALT_SIZE) {
    throw new Error('invalid_salt');
  }

  // NFKD-Normalisierung (BIP39-konform: identische Bytes auf allen Plattformen)
  const normalized = normalizePhrase(phrase).normalize('NFKD');
  const passwordBytes = new TextEncoder().encode(normalized);

  // PBKDF2-Key-Material importieren
  const baseKey = await crypto.subtle.importKey(
    'raw',
    passwordBytes,
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  // PBKDF2 → AES-GCM-Key ableiten
  return await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    baseKey,
    { name: 'AES-GCM', length: MASTER_KEY_BITS },
    false,        // extractable=false (Key bleibt im Browser, nicht exportierbar)
    ['encrypt', 'decrypt']
  );
}

/**
 * Wie deriveMasterKey, aber liefert die Raw-Bytes (32) statt CryptoKey.
 * Wird gebraucht für masterKey.js Cache (Bytes können wir mit dem
 * Device-Storage-Key wrappen und in IDB legen — CryptoKeys mit extractable=false
 * können nicht exportiert werden).
 *
 * Die Bytes selbst sind genauso sensibel wie der CryptoKey. Sie werden NUR in
 * IDB persistiert (verschlüsselt mit Device-Storage-Key), nie ins Netz geschickt.
 *
 * @param {string} phrase
 * @param {Uint8Array} salt - 16 Bytes
 * @returns {Promise<Uint8Array>} 32 Bytes
 */
export async function deriveMasterKeyRaw(phrase, salt) {
  if (!validatePhrase(phrase)) throw new Error('invalid_phrase');
  if (!(salt instanceof Uint8Array) || salt.length !== SALT_SIZE) {
    throw new Error('invalid_salt');
  }
  const normalized = normalizePhrase(phrase).normalize('NFKD');
  const passwordBytes = new TextEncoder().encode(normalized);

  const baseKey = await crypto.subtle.importKey(
    'raw', passwordBytes, { name: 'PBKDF2' },
    false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    baseKey,
    MASTER_KEY_BITS
  );
  return new Uint8Array(bits);
}

// ======================================================
// Bundle: Encrypt / Decrypt
// ======================================================

/**
 * Bundle-AAD-String: bindet Bundle-Ciphertext kryptografisch an einen
 * bestimmten Handle. Verhindert dass ein Bundle z.B. mit dem masterKey
 * eines anderen Users decryptet werden könnte (auch wenn der RNG-Salt
 * mal kollidieren sollte). L2 Hardening (2026-05-02).
 */
function _bundleAad(handle) {
  if (!handle) return null;
  return new TextEncoder().encode(`renex:bundle:${String(handle).toLowerCase()}`);
}

/**
 * Verschlüsselt ein Bundle-Objekt mit AES-GCM.
 *
 * @param {object} bundle - z.B. { v, ts, cmks, gsks }
 * @param {CryptoKey} masterKey
 * @param {string} [handle] - Wenn gegeben → AAD = "renex:bundle:<handle>".
 *   Bundle wird als v=2 markiert. Ohne handle: v=1 Legacy-Format ohne AAD.
 * @returns {Promise<Uint8Array>} [IV (12B)] [Ciphertext]
 */
export async function encryptBundle(bundle, masterKey, handle) {
  const aad = _bundleAad(handle);
  // Markiere Version: v=2 wenn AAD gebunden, v=1 sonst (rückwärts-kompatibel)
  const versioned = { ...bundle, v: aad ? 2 : 1 };

  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_SIZE));
  const plaintext = new TextEncoder().encode(JSON.stringify(versioned));
  const params = aad
    ? { name: 'AES-GCM', iv, additionalData: aad }
    : { name: 'AES-GCM', iv };
  const ciphertext = await crypto.subtle.encrypt(params, masterKey, plaintext);

  // [IV][Ciphertext] concatenieren
  const out = new Uint8Array(iv.length + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), iv.length);
  return out;
}

/**
 * Forward-tolerante Bundle-Akzeptanz: Ein erfolgreich per AES-GCM (mit handle-AAD
 * bzw. legacy ohne) entschlüsseltes + geparstes Bundle ist bereits KRYPTOGRAFISCH
 * AUTHENTIFIZIERT (GCM-Tag + AAD). Der frühere `v===1||v===2`-Whitelist-Check trug
 * NICHTS zur Sicherheit bei, verwarf aber jede künftige Version → genau dieser
 * Mechanismus hat 2026 schon einmal live alle CMKs beim Recovery vernichtet (siehe
 * cmkBundleSync.js). Daher: jede plausible (Objekt mit numerischer `v`)
 * AUTHENTIFIZIERTE Version akzeptieren; unbekannte höhere Versionen liest der
 * tolerante Leser (restoreCmksFromBundle) feldweise, statt sie zu verwerfen.
 *
 * FORWARD-COMPAT-VERTRAG (für künftige Bundle-Versionen, z.B. PQ-v3, VERBINDLICH):
 * Verschlüsselung bleibt AES-GCM mit AAD = `renex:bundle:<handle>` (versions-
 * UNABHÄNGIG); die cmks/gsks/rotationMaps-Maps bleiben erhalten; neue Versionen
 * fügen NUR Felder HINZU. Leser dürfen NIE wegen einer höheren `v` ablehnen/löschen.
 */
function _isAuthenticBundle(b) {
  return !!b && typeof b === 'object' && !Array.isArray(b) && typeof b.v === 'number';
}

/**
 * Entschlüsselt einen Bundle-Blob. Versucht mit AAD (v>=2) zuerst, fällt auf
 * legacy ohne AAD (v=1) zurück. Akzeptiert JEDE authentifizierte Version
 * (forward-tolerant — siehe _isAuthenticBundle). Wirft nur bei falschem Key /
 * korrupten Daten (beide Decrypt-Versuche scheitern am GCM-Tag).
 *
 * @param {Uint8Array} blob - [IV (12B)] [Ciphertext]
 * @param {CryptoKey} masterKey
 * @param {string} [handle] - Wenn gegeben → AAD-Versuch zuerst
 * @returns {Promise<object>} bundle-Objekt
 * @throws bei falschem Key oder korrupten Daten
 */
export async function decryptBundle(blob, masterKey, handle) {
  if (!(blob instanceof Uint8Array) || blob.length < AES_IV_SIZE + 16) {
    throw new Error('invalid_blob');
  }
  const iv = blob.slice(0, AES_IV_SIZE);
  const ciphertext = blob.slice(AES_IV_SIZE);
  const aad = _bundleAad(handle);

  // 1. Mit AAD (v>=2 — current + künftig). GCM-Tag authentifiziert das Bundle
  //    versions-unabhängig; jede authentische Version akzeptieren.
  if (aad) {
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: aad },
        masterKey, ciphertext
      );
      const bundle = JSON.parse(new TextDecoder().decode(pt));
      if (_isAuthenticBundle(bundle)) return bundle;
    } catch {}
  }

  // 2. Fallback ohne AAD (v=1 legacy) — auch ohne handle versucht.
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, masterKey, ciphertext
    );
    const bundle = JSON.parse(new TextDecoder().decode(pt));
    if (_isAuthenticBundle(bundle)) return bundle;
    throw new Error('unsupported_bundle_version');
  } catch (e) {
    throw new Error(e?.message || 'decrypt_failed');
  }
}

// ======================================================
// Helpers: Random + Base64
// ======================================================

/**
 * Generiert 16 zufällige Bytes für PBKDF2-Salt.
 * @returns {Uint8Array}
 */
export function randomSalt() {
  return crypto.getRandomValues(new Uint8Array(SALT_SIZE));
}

/**
 * Konvertiert Uint8Array → Standard-Base64.
 */
export function bytesToB64(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/**
 * Konvertiert Standard-Base64 → Uint8Array.
 */
export function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ======================================================
// API-Helpers
// ======================================================

/**
 * GET /e2e/recovery/status
 * @returns {Promise<{hasBundle, hasSalt, verified, shownAt} | null>}
 */
export async function getRecoveryStatus() {
  try {
    const r = await apiFetch('/e2e/recovery/status');
    if (!r.ok) return null;
    return r.data;
  } catch (e) {
    captureException(e, { context: 'getRecoveryStatus' });
    return null;
  }
}

/**
 * POST /e2e/recovery/init { salt: <base64> }
 * @param {Uint8Array} saltBytes - 16 Bytes
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function initRecovery(saltBytes) {
  try {
    const r = await apiFetch('/e2e/recovery/init', {
      method: 'POST',
      body: { salt: bytesToB64(saltBytes) },
    });
    // status + code durchreichen, damit OnboardingModal salt_exists korrekt erkennt
    return { ok: r.ok, status: r.status, error: r.error, code: r.data?.code };
  } catch (e) {
    captureException(e, { context: 'initRecovery' });
    return { ok: false, error: e.message };
  }
}

/**
 * GET /e2e/recovery/bundle
 * @returns {Promise<{salt: Uint8Array, blob: Uint8Array|null, ts: number|null} | null>}
 */
export async function getBundle() {
  try {
    const r = await apiFetch('/e2e/recovery/bundle');
    if (!r.ok || !r.data?.salt) return null;
    return {
      salt: b64ToBytes(r.data.salt),
      blob: r.data.blob ? b64ToBytes(r.data.blob) : null,
      ts: r.data.ts,
    };
  } catch (e) {
    captureException(e, { context: 'getBundle' });
    return null;
  }
}

/**
 * POST /e2e/recovery/bundle (binary body)
 * @param {Uint8Array} blob
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function putBundle(blob) {
  try {
    const r = await apiFetch('/e2e/recovery/bundle', {
      method: 'POST',
      body: blob,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    return { ok: r.ok, error: r.error };
  } catch (e) {
    captureException(e, { context: 'putBundle' });
    return { ok: false, error: e.message };
  }
}

/**
 * POST /e2e/recovery/verify
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function markVerified() {
  try {
    const r = await apiFetch('/e2e/recovery/verify', {
      method: 'POST',
      body: { verified: true },
    });
    return { ok: r.ok, error: r.error };
  } catch (e) {
    captureException(e, { context: 'markVerified' });
    return { ok: false, error: e.message };
  }
}
