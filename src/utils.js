// =========================
// CORS / Origin-Allowlist
// =========================
// Single Source of Truth für Allowed-Origins.
// - renex.id              → Brand-Apex (Phase 6, deckt auch Login/App via RP-ID renex.id)
// - app.renex.id          → Production App-Host
// - renex-static.pages.dev → Production Pages-Project (Svelte-Build, Deploy-Ziel)
// - <hash>.renex-static.pages.dev → per-Deploy Preview-URLs (Cloudflare Pages)
// - localhost:*           → lokale Entwicklung
const PAGES_DEPLOY_RE = /^https:\/\/[a-z0-9-]+\.renex-static\.pages\.dev$/;

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (origin === "https://renex.id") return true;
  if (origin === "https://app.renex.id") return true;
  if (origin === "https://renex-static.pages.dev") return true;
  if (origin.startsWith("http://localhost:")) return true;
  if (PAGES_DEPLOY_RE.test(origin)) return true;
  return false;
}

export function corsHeaders(request) {
  const origin = request.headers.get("Origin");

  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Mime-Type, X-File-Name, X-File-Size, X-Attachment-Type, X-Convo-Id, X-Guest-Token",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "3600", // 1h Preflight-Cache → halbiert Request-Volumen (vorher 0 = jeder Request triggerte OPTIONS)
    "Vary": "Origin",
  };

  // Nur explizit erlaubte Origins → kein Fallback auf fixen Wert
  if (isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  // Kein ACAO-Header für unbekannte Origins → Browser blockt, Server verrät nichts

  return headers;
}

// =========================
// CSRF ORIGIN CHECK
// =========================
// Prüft Origin-Header auf State-mutierenden Requests (POST/DELETE).
// Gibt null zurück wenn OK, sonst einen 403 Response.
export function checkCsrf(request) {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "OPTIONS" || method === "HEAD") return null;

  const origin = request.headers.get("Origin");
  if (!isAllowedOrigin(origin)) {
    return new Response(JSON.stringify({ error: "CSRF check failed" }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    });
  }
  return null; // OK
}

// =========================
// SAFE JSON HELPER
// =========================
export async function readJson(request) {
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return null;
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request),
    },
  });
}

// =========================
// SAFE PARAM HELPER
// =========================
export function param(params, name) {
  const v = params.get(name);
  if (!v) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

// =========================
// BASE64URL
// =========================
export function base64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64urlToString(b64url) {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);
  return atob(b64);
}

export function base64urlToArrayBuffer(base64url) {
  const base64 = base64url
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(base64url.length + (4 - base64url.length % 4) % 4, "=");

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

// =========================
// CBOR DECODER (minimal, WebAuthn subset)
// =========================
export function decodeCBOR(data) {
  let pos = 0;

  function readUint(additionalInfo) {
    if (additionalInfo < 24) return additionalInfo;
    if (additionalInfo === 24) return data[pos++];
    if (additionalInfo === 25) { const v = (data[pos] << 8) | data[pos + 1]; pos += 2; return v; }
    if (additionalInfo === 26) { const v = ((data[pos] << 24) | (data[pos+1] << 16) | (data[pos+2] << 8) | data[pos+3]) >>> 0; pos += 4; return v; }
    throw new Error("Unsupported CBOR length: " + additionalInfo);
  }

  function decodeItem() {
    const byte = data[pos++];
    const majorType = (byte >> 5) & 0x07;
    const additionalInfo = byte & 0x1f;
    const value = readUint(additionalInfo);
    switch (majorType) {
      case 0: return value;
      case 1: return -(value + 1);
      case 2: { const b = data.slice(pos, pos + value); pos += value; return b; }
      case 3: { const b = data.slice(pos, pos + value); pos += value; return new TextDecoder().decode(b); }
      case 4: { const arr = []; for (let i = 0; i < value; i++) arr.push(decodeItem()); return arr; }
      case 5: { const map = {}; for (let i = 0; i < value; i++) { const k = decodeItem(); map[k] = decodeItem(); } return map; }
      default: throw new Error("Unsupported CBOR major type: " + majorType);
    }
  }

  return decodeItem();
}

// DER-kodierte ECDSA-Signatur → raw 64-Byte r||s (für Web Crypto)
export function derToRawECDSA(derSig) {
  if (derSig[0] !== 0x30) throw new Error("Not a DER SEQUENCE");
  let offset = derSig[1] === 0x81 ? 3 : 2;

  if (derSig[offset] !== 0x02) throw new Error("Expected INTEGER for r");
  const rLen = derSig[offset + 1];
  let r = derSig.slice(offset + 2, offset + 2 + rLen);
  offset += 2 + rLen;

  if (derSig[offset] !== 0x02) throw new Error("Expected INTEGER for s");
  const sLen = derSig[offset + 1];
  let s = derSig.slice(offset + 2, offset + 2 + sLen);

  while (r.length > 32 && r[0] === 0) r = r.slice(1);
  while (s.length > 32 && s[0] === 0) s = s.slice(1);

  const raw = new Uint8Array(64);
  raw.set(r, 32 - r.length);
  raw.set(s, 64 - s.length);
  return raw;
}

// ======================================================
// dmConvoId — deterministisches Konversations-ID für 1:1 DMs
// Format: "alice:bob" (alphabetisch sortiert, lowercase)
// Für Gruppen wird stattdessen eine UUID verwendet (GroupChatDO).
// ======================================================
export function dmConvoId(a, b) {
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  const [p, q] = x < y ? [x, y] : [y, x];
  return `${p}:${q}`;
}

// Backward-Kompatibilität: bestehende Importe müssen nicht sofort angepasst werden
export const convoId = dmConvoId;

// ======================================================
// UUID / Group-ID Validation
// ======================================================
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUUID(value) {
  return UUID_RE.test(String(value));
}

export const isValidGroupId = isUUID;

export function validateConvoId(convoId) {
  if (!convoId || typeof convoId !== "string") return null;
  if (UUID_RE.test(convoId)) return "group";
  if (/^[a-z0-9_]{1,30}:[a-z0-9_]{1,30}$/.test(convoId)) return "dm";
  return null;
}

// ======================================================
// System Message Helper (D1)
// ======================================================
export function insertSystemMessage(db, { convoId, fromUser, message }) {
  const id = crypto.randomUUID();
  const ts = Date.now();
  return db.prepare(
    `INSERT INTO messages (id, convo_id, from_user, to_user, ts, type, message, e2e)
     VALUES (?, ?, ?, NULL, ?, 'system', ?, 0)`
  ).bind(id, convoId, fromUser, ts, message);
}

// ======================================================
// Guest Token / Handle Generation
// ======================================================
export function generateGuestToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return "guest_" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function generateGuestHandle() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return "guest_" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ======================================================
// Contact Version Bump (KV)
// ======================================================
export async function bumpContactsVersion(env, ...handles) {
  const ts = String(Date.now());
  await Promise.all(handles.map(h =>
    env.RENEX_KV.put(`contacts_v:${h}`, ts, { expirationTtl: 86400 })
  ));
}
