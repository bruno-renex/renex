import { json, param, isUUID } from '../utils.js';
import { requireSession, requireAnySession, rateLimit } from '../auth.js';

// ======================================================
// UPLOAD ROUTES: /upload/file, /upload/download
// Upload läuft direkt durch den Worker (kein Pre-signed URL)
// ======================================================

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const ALLOWED_MIME_PHOTO = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"
]);

const ALLOWED_MIME_FILE = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
  "text/calendar",
  "image/gif",
  "text/plain",
]);

const BLOCKED_EXTENSIONS = new Set([
  ".exe", ".dmg", ".sh", ".bat", ".apk", ".msi", ".cmd", ".ps1",
  ".vbs", ".jar", ".com", ".scr", ".pif", ".reg", ".dll"
]);

function isBlockedExtension(fileName) {
  const lower = String(fileName || "").toLowerCase();
  for (const ext of BLOCKED_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

export async function handleUploadRoutes(request, env, path, params) {

  // =========================
  // POST /upload/file
  // Client sendet encrypted Bytes direkt — Worker speichert in R2
  // Header: X-Mime-Type, X-File-Name, X-File-Size, X-Attachment-Type, X-Convo-Id
  // =========================
  if (path === "/upload/file" && request.method === "POST") {
    // eGov 1.2: Gäste dürfen hochladen (Bürger reicht Dokument/Foto ein) —
    // aber nur in ihre zugewiesene Konversation (Gate unten, nach convoId-Parse)
    // und mit zusätzlicher Tages-Quota gegen R2-Storage-Abuse.
    const session = await requireAnySession(request, env);
    if (!session) return json(request, { error: "Not authenticated" }, 401);
    const me = session.handle;
    const isGuest = session.isGuest === true;

    // Rate limit: 20 Uploads pro Minute
    const ok = await rateLimit(env, `upload_file:${me}`, 60_000, 20);
    if (!ok) return json(request, { error: "Upload rate limit exceeded", retryAfterMs: 60000 }, 429);
    if (isGuest) {
      const okDay = await rateLimit(env, `upload_guest_day:${me}`, 86_400_000, 100);
      if (!okDay) return json(request, { error: "Daily upload limit reached" }, 429);
    }

    // Metadaten aus Headers lesen
    const mimeType      = request.headers.get("X-Mime-Type")      || "application/octet-stream";
    const fileName      = request.headers.get("X-File-Name")      || "file";
    const fileSize      = Number(request.headers.get("X-File-Size") || "0");
    const attachmentType = request.headers.get("X-Attachment-Type") || "";
    const convoId       = request.headers.get("X-Convo-Id")       || "";

    // Validierungen
    if (!fileSize || fileSize > MAX_FILE_SIZE) {
      return json(request, { error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024} MB)` }, 400);
    }
    if (!["photo", "file"].includes(attachmentType)) {
      return json(request, { error: "Invalid attachmentType" }, 400);
    }
    if (isBlockedExtension(fileName)) {
      return json(request, { error: "File type not allowed" }, 400);
    }
    const mimeOk = attachmentType === "photo"
      ? ALLOWED_MIME_PHOTO.has(mimeType)
      : ALLOWED_MIME_FILE.has(mimeType);
    if (!mimeOk) {
      return json(request, { error: "MIME type not allowed" }, 400);
    }
    if (!convoId || convoId.length > 128) {
      return json(request, { error: "convoId required" }, 400);
    }
    // SECURITY: convoId muss entweder UUID (Gruppe) oder handle:handle (DM) sein
    // Verhindert Path-Traversal im R2-Key und stellt sicher, dass der Uploader Mitglied ist
    const isGroupConvo = isUUID(convoId);
    const isDmConvo    = /^[a-z0-9_]{1,30}:[a-z0-9_]{1,30}$/.test(convoId);
    if (!isGroupConvo && !isDmConvo) {
      return json(request, { error: "Invalid convoId format" }, 400);
    }
    // Gäste: ausschließlich die eigene zugewiesene Konversation (wie beim
    // Download, uploadRoutes GET; deckt DM UND Gruppen-Gäste ab).
    if (isGuest && convoId !== session.convoId) {
      return json(request, { error: "Not authorized for this conversation" }, 403);
    }
    if (isDmConvo) {
      // DM: Uploader muss einer der beiden Handles sein
      const handles = convoId.split(":");
      if (!handles.includes(me)) {
        return json(request, { error: "Not a member of this conversation" }, 403);
      }
    }
    if (isGroupConvo) {
      // Gruppe: Mitgliedschaft in DB prüfen
      const memberCheck = await env.RENEX_DB.prepare(
        "SELECT 1 FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
      ).bind(convoId, me).first();
      if (!memberCheck) {
        return json(request, { error: "Not a member of this group" }, 403);
      }
    }

    if (!env.RENEX_FILES) {
      return json(request, { error: "R2 not configured" }, 503);
    }

    // Body lesen (encrypted Bytes)
    const body = await request.arrayBuffer();
    if (!body || body.byteLength === 0) {
      return json(request, { error: "Empty body" }, 400);
    }
    if (body.byteLength > MAX_FILE_SIZE + 256) { // etwas Overhead für AES-GCM Tag
      return json(request, { error: "File too large" }, 400);
    }

    // R2 Key: files/{convoId}/{uuid}
    const r2Key = `files/${convoId}/${crypto.randomUUID()}`;

    // In R2 speichern
    await env.RENEX_FILES.put(r2Key, body, {
      httpMetadata: { contentType: "application/octet-stream" }
    });

    return json(request, { r2Key });
  }

  // =========================
  // GET /upload/download?key=...
  // Worker fetcht von R2 und streamt zum Client (nach Membership-Check)
  // =========================
  if (path === "/upload/download" && request.method === "GET") {
    // Gäste dürfen Dateien aus ihrer zugewiesenen Konversation herunterladen
    const session = await requireAnySession(request, env);
    if (!session) return json(request, { error: "Not authenticated" }, 401);
    const me      = session.handle;
    const isGuest = session.isGuest === true;

    const r2Key = param(params, "key");
    if (!r2Key || !r2Key.startsWith("files/")) {
      return json(request, { error: "Invalid key" }, 400);
    }
    // SECURITY: Path-Traversal verhindern — kein ".." und keine "//" erlaubt
    if (r2Key.includes("..") || r2Key.includes("//")) {
      return json(request, { error: "Invalid key" }, 400);
    }

    // convoId aus Key: files/{convoId}/{uuid} — exakt 3 Segmente erwartet
    const parts = r2Key.split("/");
    if (parts.length !== 3) return json(request, { error: "Invalid key format" }, 400);
    const convoId = parts[1];
    // convoId muss UUID (Gruppe) oder handle:handle (DM) sein
    const isGroupKey = isUUID(convoId);
    const isDmKey    = /^[a-z0-9_]{1,30}:[a-z0-9_]{1,30}$/.test(convoId);
    if (!isGroupKey && !isDmKey) {
      return json(request, { error: "Invalid key format" }, 400);
    }

    // Gäste: nur ihre zugewiesene Konversation
    if (isGuest && convoId !== session.convoId) {
      return json(request, { error: "Not authorized for this conversation" }, 403);
    }

    // Membership-Check
    if (isGroupKey) {
      const member = await env.RENEX_DB.prepare(
        "SELECT 1 FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
      ).bind(convoId, me).first();
      if (!member) return json(request, { error: "Not a member" }, 403);
    } else {
      // isDmKey: handle muss im convoId enthalten sein
      const handles = convoId.split(":");
      if (!handles.includes(me)) return json(request, { error: "Not a member" }, 403);
    }

    if (!env.RENEX_FILES) {
      return json(request, { error: "R2 not configured" }, 503);
    }

    // R2 Object laden
    const obj = await env.RENEX_FILES.get(r2Key);
    if (!obj) return json(request, { error: "File not found" }, 404);

    // Als Binary Response zurückgeben
    const { corsHeaders } = await import('../utils.js');
    return new Response(obj.body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "private, no-store",
        ...corsHeaders(request),
      }
    });
  }

  return json(request, { error: "Not found" }, 404);
}
