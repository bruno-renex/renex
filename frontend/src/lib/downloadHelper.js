// ======================================================
// Download-Helper — verschlüsselte Datei abholen, decrypten, Blob-URL cachen
// ======================================================
// Flow:
//   1. Empfänger entschlüsselt Message → bekommt { r2Key, fileKey, iv, mimeType }
//   2. GET /upload/download?key=<r2Key> → encrypted bytes
//   3. decryptAttachment(bytes, fileKey, iv) → plaintext
//   4. Blob mit originalem MIME → blob:URL → cached pro r2Key
//
// Cache-Strategie:
//   - In-Memory-Map: r2Key → { url, blob, refCount }
//   - URL.revokeObjectURL beim Modul-Unload (z.B. Page-Close) ist OK,
//     Browser räumt eh auf bei Tab-Close.
//   - Re-Use beim Re-Render derselben Message — kein Doppel-Decrypt.
// ======================================================

import { decryptAttachment } from './attachmentCrypto.js';

const _cache = new Map();   // r2Key → { url, blob, mimeType }
const _inflight = new Map(); // r2Key → Promise<url>

const DOWNLOAD_BASE = (typeof window !== 'undefined' && window.location.hostname === 'localhost')
  ? '/upload/download'
  : 'https://api.renex.id/upload/download';

/**
 * Holt + entschlüsselt eine Datei und returnt eine Blob-URL.
 * Cached über die Session — gleicher r2Key liefert die gleiche URL.
 *
 * @param {{r2Key: string, fileKey: string, iv: string, mimeType?: string}} meta
 * @returns {Promise<{url: string, blob: Blob}>}
 */
export async function getAttachmentBlobUrl(meta) {
  if (!meta?.r2Key || !meta?.fileKey || !meta?.iv) {
    throw new Error('attachment_meta_invalid');
  }
  const cached = _cache.get(meta.r2Key);
  if (cached) return { url: cached.url, blob: cached.blob };

  // Single-flight: parallele Aufrufe für gleichen r2Key teilen Promise.
  // Inflight-Cleanup via try/finally INSIDE der async-IIFE — sonst würde
  // promise.finally(...) eine separate ungecatchte Promise erzeugen und
  // bei 404 (attachment_gone) eine UnhandledPromiseRejection auslösen.
  let promise = _inflight.get(meta.r2Key);
  if (!promise) {
    promise = (async () => {
      try {
        const url = `${DOWNLOAD_BASE}?key=${encodeURIComponent(meta.r2Key)}`;
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) {
          if (res.status === 404) throw new Error('attachment_gone');
          if (res.status === 403) throw new Error('attachment_forbidden');
          throw new Error('attachment_download_failed');
        }
        const ciphertext = await res.arrayBuffer();
        const plaintext  = await decryptAttachment(ciphertext, meta.fileKey, meta.iv);
        const mime = meta.mimeType || 'application/octet-stream';
        const blob = new Blob([plaintext], { type: mime });
        const objUrl = URL.createObjectURL(blob);
        _cache.set(meta.r2Key, { url: objUrl, blob, mimeType: mime });
        return { url: objUrl, blob };
      } finally {
        _inflight.delete(meta.r2Key);
      }
    })();
    // No-Op-Observer: markiert die in _inflight gespeicherte Promise als
    // "handled" für Sentry's unhandledrejection-Handler. Der eigentliche
    // Caller-await erhält die Rejection weiterhin — `.catch()` returnt
    // eine neue Promise, die original-promise behält ihren Reject-Status.
    // Ohne dieses Observer triggert ein Microtask-Race zwischen
    // _inflight.set() und dem Caller-await einen falschen Sentry-Event
    // (z.B. attachment_gone bei gelöschten Files).
    promise.catch(() => {});
    _inflight.set(meta.r2Key, promise);
  }
  return promise;
}

/**
 * Triggert einen Browser-Download (für File-Cards mit "Download"-Button).
 * Lädt + entschlüsselt falls noch nicht im Cache.
 */
export async function downloadAttachment(meta, fileName) {
  const { blob } = await getAttachmentBlobUrl(meta);
  const tmpUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href     = tmpUrl;
  a.download = fileName || 'download';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Kleine Verzögerung damit der Browser den Download startet, bevor URL revoked wird.
  setTimeout(() => URL.revokeObjectURL(tmpUrl), 1000);
}

/**
 * Cache leeren — z.B. bei Logout. Revokt alle Blob-URLs.
 */
export function clearAttachmentCache() {
  for (const { url } of _cache.values()) {
    try { URL.revokeObjectURL(url); } catch {}
  }
  _cache.clear();
}
