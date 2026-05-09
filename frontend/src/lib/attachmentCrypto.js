// ======================================================
// Attachment-Crypto — AES-GCM mit per-file Random-Key
// ======================================================
// Strategie (siehe docs/ATTACHMENTS.md):
//   1. Beim Send: Random 32-byte AES-GCM-Key + Random 12-byte IV pro Datei.
//   2. Datei wird damit verschlüsselt und nach R2 hochgeladen (opaque bytes).
//   3. Der File-Key + IV + originaler Filename + originale MIME wandern als
//      Plaintext-Metadaten in die Message — die wiederum E2E-verschlüsselt
//      über die normale Message-Pipeline rausgeht.
//   4. Empfänger entschlüsselt Message → bekommt Key+IV → lädt+entschlüsselt File.
//
// Privacy: Server speichert NUR encrypted bytes + r2Key + attachment_type.
// Filename, MIME, fileKey kennt nur der Empfänger via E2E-Message.
//
// Prinzip 2 (AI-Free): Server kann den Inhalt nicht analysieren — keine OCR,
// kein Auto-Tag, keine Image-Recognition möglich.
// Prinzip 4 (Privacy): per-file Key bedeutet, dass ein potentielles Leak
// einer Datei nicht andere Dateien des gleichen Users offenlegt.
// ======================================================

import { bytesToB64, b64ToBytes } from './bytes.js';

/**
 * Generiert einen frischen 32-Byte AES-GCM-Key + 12-Byte IV.
 * Pro Datei einmalig — keine Wiederverwendung über Files hinweg.
 */
export function generateAttachmentKey() {
  return {
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    iv:       crypto.getRandomValues(new Uint8Array(12)),
  };
}

/**
 * Verschlüsselt einen Datei-Inhalt (ArrayBuffer) mit AES-GCM-256.
 * @param {ArrayBuffer} plaintextBuffer
 * @param {Uint8Array} keyBytes - 32 Bytes
 * @param {Uint8Array} iv       - 12 Bytes
 * @returns {Promise<ArrayBuffer>} encrypted bytes (ciphertext + 16-byte GCM tag)
 */
export async function encryptAttachment(plaintextBuffer, keyBytes, iv) {
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 32) {
    throw new Error('attachment-encrypt: invalid key length');
  }
  if (!(iv instanceof Uint8Array) || iv.length !== 12) {
    throw new Error('attachment-encrypt: invalid IV length');
  }
  const key = await crypto.subtle.importKey(
    'raw', keyBytes,
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt']
  );
  return crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintextBuffer);
}

/**
 * Entschlüsselt heruntergeladene Datei-Bytes.
 * @param {ArrayBuffer} encryptedBuffer
 * @param {Uint8Array|string} keyBytesOrB64
 * @param {Uint8Array|string} ivOrB64
 * @returns {Promise<ArrayBuffer>} plaintext bytes
 */
export async function decryptAttachment(encryptedBuffer, keyBytesOrB64, ivOrB64) {
  const keyBytes = typeof keyBytesOrB64 === 'string' ? b64ToBytes(keyBytesOrB64) : keyBytesOrB64;
  const iv       = typeof ivOrB64 === 'string'       ? b64ToBytes(ivOrB64)       : ivOrB64;
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 32) {
    throw new Error('attachment-decrypt: invalid key length');
  }
  if (!(iv instanceof Uint8Array) || iv.length !== 12) {
    throw new Error('attachment-decrypt: invalid IV length');
  }
  const key = await crypto.subtle.importKey(
    'raw', keyBytes,
    { name: 'AES-GCM', length: 256 },
    false, ['decrypt']
  );
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encryptedBuffer);
}

/**
 * Helper: Key+IV als kompaktes Plaintext-Objekt für die Message-JSON.
 * Wird in den encrypted Body der Message gepackt — Server sieht's nie.
 */
export function attachmentMetaToJson({ keyBytes, iv, r2Key, fileName, mimeType, fileSize, attachmentType }) {
  return {
    type:     attachmentType,        // 'photo' | 'file'
    r2Key,                            // Server-Pfad — nur zum Wieder-Abholen
    fileKey:  bytesToB64(keyBytes),  // 32-byte AES-Key
    iv:       bytesToB64(iv),         // 12-byte IV
    fileName,                          // original (nicht beim Server)
    mimeType,                          // original (nicht beim Server)
    fileSize,
  };
}

// ======================================================
// Plaintext-Envelope: Caption + Attachment-Meta in einen String packen
// ======================================================
// Format: `__rx_a1__\n` + JSON({ t: <caption>, a: <meta> })
//
// Backwards-compat: bare strings ohne Prefix bleiben als Text-Messages erkannt
// (alle existierenden Messages). Magic-Prefix ist nicht naturally tippbar
// (Underscore-Pattern), Konflikt mit User-Text praktisch null.
// ======================================================

const PLAINTEXT_ATTACHMENT_PREFIX = '__rx_a1__\n';

/**
 * Packt Caption + Attachment-Meta in einen einzigen Plaintext-String,
 * der dann durch die normale E2E-Pipeline läuft.
 */
export function wrapAttachmentPlaintext(caption, attachmentMeta) {
  const payload = {
    t: caption || '',
    a: attachmentMeta,
  };
  return PLAINTEXT_ATTACHMENT_PREFIX + JSON.stringify(payload);
}

/**
 * Unpackt einen entschlüsselten Plaintext.
 * Rückgabe:
 *   { caption, attachmentMeta }  wenn Prefix erkannt
 *   { caption: <bare string>, attachmentMeta: null }  sonst
 */
export function unwrapAttachmentPlaintext(decryptedText) {
  if (typeof decryptedText !== 'string') return { caption: '', attachmentMeta: null };
  if (!decryptedText.startsWith(PLAINTEXT_ATTACHMENT_PREFIX)) {
    return { caption: decryptedText, attachmentMeta: null };
  }
  try {
    const json = JSON.parse(decryptedText.slice(PLAINTEXT_ATTACHMENT_PREFIX.length));
    const meta = json?.a;
    if (meta && typeof meta === 'object') {
      // Photo/File: in R2 verschlüsselt → braucht fileKey + iv + r2Key
      const isPhotoOrFile = !!(meta.fileKey && meta.iv && meta.r2Key);
      // GIF: GIPHY-URL direkt, kein R2 → braucht type='gif' + gifUrl
      const isGif = meta.type === 'gif' && typeof meta.gifUrl === 'string';
      if (isPhotoOrFile || isGif) {
        return { caption: typeof json.t === 'string' ? json.t : '', attachmentMeta: meta };
      }
    }
  } catch {}
  // Fallback: kaputter Envelope → als bare Text behandeln (Sicht ist „garbled" ist
  // immer noch besser als Crash).
  return { caption: decryptedText, attachmentMeta: null };
}
