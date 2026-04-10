// ======================================================
// CHAT CRYPTO — Pure E2E helper functions (no state deps)
// ======================================================

// Base64 ↔ ArrayBuffer
export function abToB64(ab) {
  const bytes = new Uint8Array(ab);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function b64ToAb(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// AES-GCM Encrypt / Decrypt
export async function e2eEncrypt(aesKey, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, data);
  return { ivB64: abToB64(iv.buffer), ctB64: abToB64(ciphertext) };
}

export async function e2eDecrypt(aesKey, ivB64, ctB64) {
  const iv = new Uint8Array(b64ToAb(ivB64));
  const ciphertext = b64ToAb(ctB64);
  const plaintextBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ciphertext);
  return new TextDecoder().decode(plaintextBuf);
}

// Binary encrypt
export async function e2eEncryptBytes(aesKey, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, bytes);
  return { ivB64: abToB64(iv.buffer), ctBytes: new Uint8Array(ct) };
}

// File key management
export async function generateFileKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function exportKeyB64(aesKey) {
  const raw = await crypto.subtle.exportKey("raw", aesKey);
  return abToB64(raw);
}

export async function importKeyB64(b64) {
  const raw = b64ToAb(b64);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
}

// Image compression
export async function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objUrl);
      const MAX_PX = 1200;
      const scale = Math.min(1, MAX_PX / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => {
        if (!blob) { reject(new Error("Compression failed")); return; }
        blob.arrayBuffer().then(resolve).catch(reject);
      }, "image/jpeg", 0.80);
    };
    img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error("Image load failed")); };
    img.src = objUrl;
  });
}

// Download and decrypt file from R2
export async function downloadAndDecryptFile(r2Key, fileKeyB64, fileIvB64) {
  const res = await fetch(`https://api.renex.id/upload/download?key=${encodeURIComponent(r2Key)}`, {
    credentials: "include"
  });
  if (!res.ok) throw new Error("Download failed");
  const ctBytes = await res.arrayBuffer();
  const fileKey = await importKeyB64(fileKeyB64);
  const iv = new Uint8Array(b64ToAb(fileIvB64));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, fileKey, ctBytes);
  return plain;
}

// Upload file: compress → encrypt → upload to R2
export async function uploadFile(file, attachmentType, { isGroupConversation, withUser, getMyUser, showSystemToast }) {
  const MAX_SIZE = 10 * 1024 * 1024;
  if (file.size > MAX_SIZE) {
    showSystemToast("⚠️ Datei zu gross (max. 10 MB)");
    return null;
  }

  let fileBytes;
  if (attachmentType === "photo") {
    try { fileBytes = await compressImage(file); }
    catch { fileBytes = await file.arrayBuffer(); }
  } else {
    fileBytes = await file.arrayBuffer();
  }

  const fileKey = await generateFileKey();
  const { ivB64: fileIvB64, ctBytes } = await e2eEncryptBytes(fileKey, fileBytes);
  const fileKeyB64 = await exportKeyB64(fileKey);

  const isGroup = isGroupConversation(withUser);
  const myConvoId = isGroup ? withUser : [getMyUser(), withUser].sort().join(":");

  let r2Key;
  try {
    const uploadRes = await fetch("https://api.renex.id/upload/file", {
      method: "POST",
      credentials: "include",
      headers: {
        "X-Mime-Type": file.type || "application/octet-stream",
        "X-File-Name": file.name,
        "X-File-Size": String(ctBytes.byteLength),
        "X-Attachment-Type": attachmentType,
        "X-Convo-Id": myConvoId,
      },
      body: ctBytes,
    });
    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${uploadRes.status}`);
    }
    const data = await uploadRes.json();
    r2Key = data.r2Key;
  } catch (e) {
    console.error("[upload] Fehler:", e);
    showSystemToast(`⚠️ Upload fehlgeschlagen: ${e.message}`);
    return null;
  }

  const attachmentPayloadJson = JSON.stringify({
    r2Key,
    fileKeyB64,
    fileIvB64,
    mimeType: file.type || "application/octet-stream",
    fileName: file.name,
    fileSize: fileBytes.byteLength,
  });

  return { attachmentPayloadJson, r2Key, attachmentType };
}

// Upload public key to server
export async function uploadMyPublicKeyIfNeeded(getDeviceId, loadPublicKey, apiFetch) {
  const deviceId = getDeviceId();
  const pub = await loadPublicKey();
  if (!pub) {
    console.warn("❌ Kein Public Key vorhanden");
    return false;
  }
  const jwk = await crypto.subtle.exportKey("jwk", pub);
  await apiFetch("/chat/keys/upload", {
    method: "POST",
    body: JSON.stringify({ jwk, deviceId })
  });
  console.log("✅ Public Key hochgeladen:", deviceId);
  return true;
}

// Text helpers
export function escapeHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

export function linkify(text) {
  if (!text) return "";
  const urlRe = /https:\/\/[^\s<>"']+/g;
  let result = "";
  let last = 0;
  let match;
  while ((match = urlRe.exec(text)) !== null) {
    result += escapeHtml(text.slice(last, match.index));
    const url = match[0];
    const display = url.length > 50 ? url.slice(0, 47) + "…" : url;
    result += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent-voice,#38BDF8);text-decoration:underline;text-underline-offset:2px;word-break:break-all;">${escapeHtml(display)}</a>`;
    last = match.index + url.length;
  }
  result += escapeHtml(text.slice(last));
  return result;
}

// LRU cache helper
export function lruCacheSet(cache, maxSize, key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > maxSize) {
    cache.delete(cache.keys().next().value);
  }
}
