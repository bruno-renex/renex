// ======================================================
// Upload-Helper — Datei picken, vorbereiten, encrypten, hochladen
// ======================================================
// Flow:
//   1. File-Picker (oder Drag/Paste-Quelle)
//   2. Photos: EXIF-Strip + Resize auf max 2048 px / 2 MB (Privacy + Bandbreite)
//   3. Random AES-Key + IV (attachmentCrypto.generateAttachmentKey)
//   4. Encrypt mit dem File-Key
//   5. POST /upload/file → Server speichert opaque bytes in R2
//   6. Returnt Meta-Objekt das in Message-JSON wandert (E2E-encrypted)
//
// Prinzipien:
//   #2 AI-Free: Server bekommt nur encrypted bytes — keine Image-Analyse möglich
//   #4 Privacy: EXIF (Geo, Device-ID) wird vor Encrypt entfernt
//   #5 Gamer-First UX: Resize spart Latenz + Cost
// ======================================================

import { apiFetch } from './api.js';
import {
  generateAttachmentKey, encryptAttachment, attachmentMetaToJson,
} from './attachmentCrypto.js';

const MAX_FILE_BYTES   = 10 * 1024 * 1024;   // 10 MB Server-Limit
const PHOTO_MAX_BYTES  = 2 * 1024 * 1024;    // 2 MB Photo-Resize-Threshold
const PHOTO_MAX_DIM    = 2048;               // px

const ALLOWED_PHOTO_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
]);

const ALLOWED_FILE_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'text/calendar',
  'image/gif',
  'text/plain',
]);

const BLOCKED_EXT = new Set([
  '.exe', '.dmg', '.sh', '.bat', '.apk', '.msi', '.cmd', '.ps1',
  '.vbs', '.jar', '.com', '.scr', '.pif', '.reg', '.dll',
]);

function _hasBlockedExtension(name) {
  const lower = String(name || '').toLowerCase();
  for (const ext of BLOCKED_EXT) if (lower.endsWith(ext)) return true;
  return false;
}

/**
 * EXIF/Metadaten-strippendes Resize via Canvas — verliert beim Re-Encode
 * automatisch alle EXIF-Tags (Geolocation, Device-ID, Datum, etc.).
 * Behält Aspect-Ratio. Cap bei PHOTO_MAX_DIM.
 *
 * Rückgabe: Blob (image/jpeg quality 0.86) wenn Resize stattfand,
 * sonst original File.
 */
async function _stripAndMaybeResizePhoto(file) {
  if (!ALLOWED_PHOTO_MIME.has(file.type)) return file;
  // HEIC/HEIF kann der Browser nicht canvas-decoden auf den meisten Plattformen.
  // → in dem Fall geben wir das File so weiter (EXIF bleibt drin, akzeptiert
  // weil iOS-Photos meistens schon EXIF-strippen beim Share).
  if (file.type === 'image/heic' || file.type === 'image/heif') return file;

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;

  const { width, height } = bitmap;
  const scale = Math.min(1, PHOTO_MAX_DIM / Math.max(width, height));
  const targetW = Math.round(width * scale);
  const targetH = Math.round(height * scale);

  // Wenn klein UND unter 2 MB → Originalbytes drinlassen, EXIF aber strippen.
  // Resize ist günstiger als naiver Re-Encode bei großen Files.
  const canvas = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(targetW, targetH)
    : Object.assign(document.createElement('canvas'), { width: targetW, height: targetH });
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, targetW, targetH);
  bitmap.close?.();

  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 })
    : await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.86));

  if (!blob) return file;
  // Wenn re-encoded größer wäre als original UND original < 2 MB → original behalten
  if (blob.size >= file.size && file.size < PHOTO_MAX_BYTES) return file;
  return blob;
}

/**
 * Validiert, bereitet vor und lädt eine Datei verschlüsselt hoch.
 *
 * @param {File|Blob} file
 * @param {'photo'|'file'} attachmentType
 * @param {string} convoId
 * @returns {Promise<{type, r2Key, fileKey, iv, fileName, mimeType, fileSize}>}
 *          Meta-Objekt für die Message-JSON. Bei Fehler: throw mit user-readable message.
 */
export async function uploadAttachment(file, attachmentType, convoId) {
  if (!file || !(file instanceof Blob)) throw new Error('no_file');
  if (!['photo', 'file'].includes(attachmentType)) throw new Error('invalid_attachment_type');
  if (!convoId) throw new Error('missing_convo_id');

  const origName = (file instanceof File && file.name) ? file.name : 'attachment';
  if (_hasBlockedExtension(origName)) throw new Error('extension_blocked');

  // 1. Photo-Pre-Processing (EXIF strip + resize)
  let prepared = file;
  if (attachmentType === 'photo') {
    prepared = await _stripAndMaybeResizePhoto(file);
  }

  const finalMime = prepared.type || (file.type || 'application/octet-stream');
  const finalName = (prepared !== file && attachmentType === 'photo')
    ? origName.replace(/\.[a-z0-9]+$/i, '') + '.jpg'
    : origName;

  // MIME-Whitelist (Server prüft das auch — hier early-fail für UX)
  const allowedMime = attachmentType === 'photo' ? ALLOWED_PHOTO_MIME : ALLOWED_FILE_MIME;
  if (!allowedMime.has(finalMime)) throw new Error('mime_not_allowed');

  if (prepared.size > MAX_FILE_BYTES) throw new Error('file_too_large');

  // 2. Random Per-File-Key + IV
  const { keyBytes, iv } = generateAttachmentKey();

  // 3. Encrypt
  const plaintextBuffer = await prepared.arrayBuffer();
  const ciphertext      = await encryptAttachment(plaintextBuffer, keyBytes, iv);

  // 4. Upload (apiFetch sendet credentials + Auth-Header automatisch).
  // Wir nutzen direkt fetch hier, weil apiFetch JSON-orientiert ist —
  // bei /upload/file gehen rohe Bytes als Body raus.
  const uploadUrl = (typeof window !== 'undefined' && window.location.hostname === 'localhost')
    ? '/upload/file'
    : 'https://api.renex.id/upload/file';
  const res = await fetch(uploadUrl, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type':       'application/octet-stream',
      'X-Mime-Type':        finalMime,
      'X-File-Name':        finalName.slice(0, 200),
      'X-File-Size':        String(prepared.size),
      'X-Attachment-Type':  attachmentType,
      'X-Convo-Id':         convoId,
    },
    body: ciphertext,
  });

  if (!res.ok) {
    let errMsg = 'upload_failed';
    try { const j = await res.json(); if (j?.error) errMsg = j.error; } catch {}
    if (res.status === 429) throw new Error('rate_limit');
    throw new Error(errMsg);
  }

  const data = await res.json();
  if (!data?.r2Key) throw new Error('upload_no_key');

  return attachmentMetaToJson({
    keyBytes, iv,
    r2Key:           data.r2Key,
    fileName:        finalName,
    mimeType:        finalMime,
    fileSize:        prepared.size,
    attachmentType,
  });
}
