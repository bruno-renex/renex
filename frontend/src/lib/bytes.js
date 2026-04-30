// ======================================================
// Bytes-Helpers — DRY zwischen recovery, multidevice, cmk, session
// ======================================================
// Standard-Base64 (NICHT URL-safe). Identisch zu legacy chatCrypto.js.
// ======================================================

/**
 * Uint8Array → Standard-Base64 (chunked für große Buffer).
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
 * Standard-Base64 → Uint8Array.
 */
export function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * ArrayBuffer → Standard-Base64.
 */
export function abToB64(ab) {
  return bytesToB64(new Uint8Array(ab));
}

/**
 * Standard-Base64 → ArrayBuffer.
 */
export function b64ToAb(b64) {
  return b64ToBytes(b64).buffer;
}
