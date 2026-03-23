// =========================
// CORS
// =========================
function corsHeaders(request) {
  const origin = request.headers.get("Origin");

  const allowedOrigins = [
    "https://app.renex.id",
    "https://renex-static.pages.dev",
  ];

  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  };

  if (origin && allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  } else {
    // 🔥 WICHTIG: Development fallback
    headers["Access-Control-Allow-Origin"] = allowedOrigins[0];
  }

  return headers;
}

// =========================
// SAFE JSON HELPER
// =========================
async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request),
    },
  });
}

// =========================
// TURNSTILE VERIFY
// =========================
async function verifyTurnstile(token, ip, env) {
  try {
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET);
    form.append("response", token);
    if (ip) form.append("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

// =========================
// SESSION + CHAT HELPERS
// =========================
function getToken(request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;

  const token = auth.slice(7).trim();

  // 1) Hard length limit (KV + Abuse Schutz)
  if (token.length < 10 || token.length > 64) return null;

  // 2) Only allow exactly your token format: sess_ + UUID
  // UUID: 8-4-4-4-12 hex
  const ok = /^sess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
  if (!ok) return null;

  return token;
}


async function requireSession(request, env) {
  const token = getToken(request);
  if (!token) return null;

  // ✅ Minimaler Token-Guard (gegen Müll/Abuse)
  if (typeof token !== "string" || token.length < 20 || token.length > 200) {
    return null;
  }

  const raw = await env.RENEX_KV.get(`session:${token}`);
  if (!raw) return null;

  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    return null;
  }

  // ✅ Expiry check (zusätzlich zur KV-TTL)
  if (session?.exp && Date.now() > Number(session.exp)) {
    // optional: sofort entfernen
    await env.RENEX_KV.delete(`session:${token}`);
    return null;
  }
  
// ✅ User-Agent Bindung (SOFT, Worker-sicher)
const ua = request.headers.get("User-Agent") || "";

let uaHashB64 = null;

try {
  if (crypto?.subtle?.digest) {
    const uaHash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(ua)
    );
    uaHashB64 = base64url(new Uint8Array(uaHash));
  }
} catch (e) {
  console.warn("UA hash skipped (runtime)", e);
}

// 🔐 Nur prüfen, wenn BEIDE Seiten vorhanden sind
if (session?.ua && uaHashB64 && session.ua !== uaHashB64) {
  await env.RENEX_KV.delete(`session:${token}`);
  return null;
}

  // ✅ Handle-Guard
  if (!session?.handle || !/^[a-z0-9_]+$/.test(String(session.handle))) {
    return null;
  }

  return session; // { handle, created_at, exp }
}

async function rateLimit(env, key, windowMs, limit, { failOpen = false } = {}) {
  try {
    const now = Date.now();
    const bucket = Math.floor(now / windowMs);
    const kvKey = `rl:${key}:${bucket}`;

    const raw = await env.RENEX_KV.get(kvKey);
    const count = raw ? Number(raw) : 0;

    if (count >= limit) return false;

    // KV braucht TTL >= 60
    await env.RENEX_KV.put(kvKey, String(count + 1), {
      expirationTtl: 60
    });

    return true;

  } catch (err) {
    // 🔒 Fail-Closed für sicherheitskritische Endpoints (Login, Register)
    // Fail-Open nur wenn explizit erlaubt (z.B. Chat-Send für UX)
    console.error("⚠️ rateLimit KV error:", key, err.message);
    return failOpen ? true : false;
  }
}

// =========================
// SAFE PARAM HELPER
// =========================
function param(params, name) {
  const v = params.get(name);
  if (!v) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

// =========================
// BASE64URL
// =========================
function base64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function base64urlToString(b64url) {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);
  return atob(b64);
}
function base64urlToArrayBuffer(base64url) {
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
function decodeCBOR(data) {
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
function derToRawECDSA(derSig) {
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

// =========================
// CONTACT NORMALIZER
// =========================

async function isAcceptedContact(env, me, other) {
  other = String(other || "").toLowerCase();
  const row = await env.RENEX_DB.prepare(
    "SELECT status FROM contacts WHERE user_handle = ? AND contact_handle = ? LIMIT 1"
  ).bind(me, other).first();
  return row?.status === "accepted";
}

// ======================================================
// 💾 convoId helper (same sorting logic as old chatKey)
// ======================================================

function convoId(a, b) {
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  const [p, q] = x < y ? [x, y] : [y, x];
  return `${p}:${q}`;
}

// ======================================================
// 🔌 DURABLE OBJECT: UserSessionDO
// Hält eine persistente WebSocket-Verbindung pro User.
// Der Worker pusht Events direkt rein → kein Polling mehr.
// ======================================================
export class UserSessionDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // ── WebSocket Upgrade (vom Browser) ──────────────────
    if (request.headers.get("Upgrade") === "websocket") {
      const { 0: client, 1: server } = new WebSocketPair();
      // Hibernatable WebSocket: DO schläft wenn idle → kosteneffizient
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // ── Interner Push (vom Worker bei neuen Events) ───────
    if (request.method === "POST" && url.pathname === "/push") {
      const event = await request.json();
      const sockets = this.state.getWebSockets();
      for (const ws of sockets) {
        try { ws.send(JSON.stringify(event)); } catch {}
      }
      return new Response(JSON.stringify({ delivered: sockets.length }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("Not found", { status: 404 });
  }

  // Hibernatable WebSocket Handlers (Pflicht bei acceptWebSocket)
  webSocketMessage(ws, message) {}
  webSocketClose(ws, code, reason) {}
  webSocketError(ws, error) {}
}

// ======================================================
// 🔌 HELPER: Event via DO an User pushen
// Fail-silent: User offline → kein Problem, KV hat's gespeichert
// ======================================================
async function pushToUserDO(env, handle, event) {
  try {
    const id = env.USER_SESSION_DO.idFromName(String(handle).toLowerCase());
    const stub = env.USER_SESSION_DO.get(id);
    await stub.fetch("https://do-internal/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
  } catch (e) {
    // User offline oder DO nicht erreichbar → kein Fehler
    console.log("📴 pushToUserDO skipped (user offline):", handle);
  }
}

// =========================
// WORKER
// =========================
export default {
  async fetch(request, env) {

    // ✅ PRE-FLIGHT
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }
    
    try {
const url = new URL(request.url);
const path = url.pathname;
const params = url.searchParams;

switch (path.toLowerCase()) {
// =========================
// CHAT / TEST
// =========================
case "/chat/test":

if (request.method === "GET") {

const session = await requireSession(request, env);
  if (!session) {
    return json(request, { error: "Not authenticated" }, 401);
  }
  
  return json(request, {
    ok: true,
    me: session.handle
  });
}

break;

// ======================================================
// 🔌 CHAT / WS — WebSocket Upgrade (ersetzt /chat/control)
// Token kommt als Query-Param weil Browser keine
// Authorization-Header bei WebSocket senden können.
// ======================================================
case "/chat/ws":

if (request.headers.get("Upgrade") === "websocket") {

  // Token aus Query-Param (nicht aus Header — WS limitation)
  const wsToken = param(params, "token");
  if (!wsToken) {
    return new Response("Missing token", { status: 401 });
  }

  // Session validieren (gleiche Logik wie requireSession)
  const tokenOk = /^sess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wsToken);
  if (!tokenOk) {
    return new Response("Invalid token", { status: 401 });
  }

  const rawSess = await env.RENEX_KV.get(`session:${wsToken}`);
  if (!rawSess) return new Response("Unauthorized", { status: 401 });

  let wsSess;
  try { wsSess = JSON.parse(rawSess); } catch { return new Response("Unauthorized", { status: 401 }); }

  if (!wsSess?.handle || (wsSess?.exp && Date.now() > Number(wsSess.exp))) {
    return new Response("Session expired", { status: 401 });
  }

  const wsHandle = String(wsSess.handle).toLowerCase();

  // An UserSessionDO weiterleiten
  const doId = env.USER_SESSION_DO.idFromName(wsHandle);
  const stub = env.USER_SESSION_DO.get(doId);
  return stub.fetch(request);
}

break;

// /chat/control war der alte Long-Polling Fallback (entfernt — WebSocket via /chat/ws)
case "/chat/control":
  return json(request, { error: "Use WebSocket /chat/ws instead" }, 410);


// ======================================================
// 🔐 CHAT KEYS: UPLOAD PUBLIC KEY
// ======================================================
case "/chat/keys/upload":

if (request.method === "POST") {

  const session = await requireSession(request, env);
  if (!session) {
    return json(request, { error: "Not authenticated" }, 401);
  }
  
  const handle = session.handle;
  
  // 📦 Body
const body = await readJson(request);
if (!body) return json(request, { error: "Invalid JSON" }, 400);

  const { jwk, deviceId } = body;

  if (!deviceId || typeof deviceId !== "string" || deviceId.length > 64) {
    return json(request, { error: "Missing/invalid deviceId" }, 400);
  }

  // 💾 Store device public key
  await env.RENEX_KV.put(
    `chat:pubkey:${handle}:${deviceId}`,
    JSON.stringify(jwk)
  );

  // 🗂️ optional: Index-Liste der Devices pflegen
  const idxKey = `chat:pubkeys:${handle}`;
  let idx = [];
  const rawIdx = await env.RENEX_KV.get(idxKey);
  if (rawIdx) {
    try { idx = JSON.parse(rawIdx) } catch {}
  }
  if (!idx.includes(deviceId)) idx.push(deviceId);

  await env.RENEX_KV.put(idxKey, JSON.stringify(idx));

  return json(request, { ok: true });
}

break;

// ======================================================
// 🔐 CHAT KEYS: GET PUBLIC KEY (privacy-safe)
// ======================================================
case "/chat/keys/get":

if (request.method === "GET") {

  const session = await requireSession(request, env);
  if (!session) return json(request, { error: "Not authenticated" }, 401);
  
  const { handle: me } = session;  

const user = (param(params, "user") || "").toLowerCase();

  if (!user || user === me) {
    return json(request, { jwk: null });
  }

  const contactRow = await env.RENEX_DB.prepare(
    "SELECT status FROM contacts WHERE user_handle = ? AND contact_handle = ? LIMIT 1"
  ).bind(me, user).first();

  if (!contactRow || contactRow.status !== "accepted") {
    return json(request, { jwk: null });
  }

  // ✅ NEW: multi-device keys
  const idxKey = `chat:pubkeys:${user}`;
  const rawIdx = await env.RENEX_KV.get(idxKey);

  let deviceIds = [];
  if (rawIdx) {
    try { deviceIds = JSON.parse(rawIdx) } catch {}
  }

  const keys = [];
  for (const deviceId of deviceIds) {
    const raw = await env.RENEX_KV.get(`chat:pubkey:${user}:${deviceId}`);
    if (!raw) continue;
    try {
      keys.push({ deviceId, jwk: JSON.parse(raw) });
    } catch {}
  }

  // 🔁 BACKWARD-COMPAT: falls noch alte Single-Key Speicherung existiert
  if (keys.length === 0) {
    const legacyRaw = await env.RENEX_KV.get(`chat:pubkey:${user}`);
    if (!legacyRaw) return json(request, { keys: [] });

    try {
      keys.push({ deviceId: "legacy", jwk: JSON.parse(legacyRaw) });
    } catch {}
  }

  return json(request, {
    devices: keys
  });
}

break;

// ======================================================
// 🔐 INBOX KEY: UPLOAD (GLOBAL, 1 PRO USER / DEVICE)
// ======================================================
case "/e2e/inbox/upload":

if (request.method === "POST") {

const session = await requireSession(request, env);
  if (!session) {
    return json(request, { error: "Not authenticated" }, 401);
  }

  const handle = session.handle;

const body = await readJson(request);
if (!body) return json(request, { error: "Invalid JSON" }, 400);

  const { jwk, deviceId } = body;

  if (!jwk || typeof jwk !== "object") {
    return json(request, { error: "Missing jwk" }, 400);
  }

  if (
    typeof deviceId !== "string" ||
    deviceId.length < 8 ||
    deviceId.length > 64
  ) {
  return json(request, { error: "Missing deviceId" }, 400);
  }

  // 🔐 GLOBAL Inbox-Key
  await env.RENEX_KV.put(
    `e2e:inbox:${handle}:${deviceId}`,
    JSON.stringify(jwk)
  );

  // optional Index
  const idxKey = `e2e:inbox:index:${handle}`;
  let idx = [];
  const raw = await env.RENEX_KV.get(idxKey);
  if (raw) {
    try { idx = JSON.parse(raw) } catch {}
  }
  if (!idx.includes(deviceId)) idx.push(deviceId);

  // 🧹 Max. 10 Geräte behalten — älteste entfernen
  const MAX_INBOX_DEVICES = 10;
  if (idx.length > MAX_INBOX_DEVICES) {
    const removed = idx.splice(0, idx.length - MAX_INBOX_DEVICES);
    for (const oldDeviceId of removed) {
      await env.RENEX_KV.delete(`e2e:inbox:${handle}:${oldDeviceId}`);
    }
  }

  await env.RENEX_KV.put(idxKey, JSON.stringify(idx));

  // 🔑 device_added → Authority-Kontakte benachrichtigen (CMK Rotation triggern)
  // Authority = alphabetisch kleinster Handle. Wir suchen Kontakte wo contact_handle < handle.
  try {
    const authContacts = await env.RENEX_DB.prepare(
      "SELECT contact_handle FROM contacts WHERE user_handle = ? AND status = 'accepted' AND contact_handle < ?"
    ).bind(handle, handle).all();

    for (const row of (authContacts.results || [])) {
      await pushToUserDO(env, row.contact_handle, {
        id: crypto.randomUUID(),
        type: "device_added",
        from: handle,
        to: row.contact_handle,
        ts: Date.now()
      });
    }
  } catch (e) {
    // non-fatal
    console.warn("device_added push fehlgeschlagen (non-fatal):", e.message);
  }

  // 🔑 device_added → eigene Devices benachrichtigen
  // Damit das bestehende Device den CMK für das neue Device in KV ablegt
  try {
    await pushToUserDO(env, handle, {
      id: crypto.randomUUID(),
      type: "device_added",
      from: handle,
      to: handle,
      ts: Date.now()
    });
  } catch (e) {
    console.warn("device_added self-push fehlgeschlagen (non-fatal):", e.message);
  }

  return json(request, { ok: true });
}

break;

// ======================================================
// 🔐 INBOX KEY: GET (PUBLIC, NO CONTACT REQUIRED)
// ======================================================
case "/e2e/inbox/get":

if (request.method === "GET") {

const session = await requireSession(request, env);
  if (!session) {
    return json(request, { error: "Not authenticated" }, 401);
  }

const user = (param(params, "user") || "").toLowerCase();

  if (!user || !/^[a-z0-9_]+$/.test(user)) {
    return json(request, { devices: [] });
  }

  const idxKey = `e2e:inbox:index:${user}`;
  const rawIdx = await env.RENEX_KV.get(idxKey);

  let deviceIds = [];
  if (rawIdx) {
    try { deviceIds = JSON.parse(rawIdx); } catch {}
  }

  const devices = [];
  for (const deviceId of deviceIds) {
    const raw = await env.RENEX_KV.get(`e2e:inbox:${user}:${deviceId}`);
    if (!raw) continue;

    try {
      devices.push({
        deviceId,
        jwk: JSON.parse(raw)
      });
    } catch {}
  }

  return json(request, { devices });
}

break;

// ======================================================
// 🔐 INBOX DEVICE REMOVE: Entfernt ein eigenes Device aus dem Inbox-Index
// Triggert device_removed bei Authority-Kontakten → CMK Rotation (Forward Secrecy)
// ======================================================
case "/e2e/inbox/remove":

if (request.method === "POST") {
  const session = await requireSession(request, env);
  if (!session) return json(request, { error: "Not authenticated" }, 401);

  const handle = String(session.handle || "").toLowerCase();
  const body = await request.json().catch(() => ({}));
  const deviceId = String(body.deviceId || "").trim();

  if (!deviceId) return json(request, { error: "deviceId required" }, 400);

  // Device aus Inbox-Index entfernen
  const idxKey = `e2e:inbox:index:${handle}`;
  const rawIdx = await env.RENEX_KV.get(idxKey);
  let idx = [];
  if (rawIdx) { try { idx = JSON.parse(rawIdx); } catch {} }

  if (!idx.includes(deviceId)) {
    return json(request, { ok: true, removed: false, message: "Device not found" });
  }

  idx = idx.filter(id => id !== deviceId);
  await env.RENEX_KV.put(idxKey, JSON.stringify(idx));
  await env.RENEX_KV.delete(`e2e:inbox:${handle}:${deviceId}`);

  // 🔑 device_removed → Authority-Kontakte benachrichtigen (CMK Rotation triggern)
  try {
    const authContacts = await env.RENEX_DB.prepare(
      "SELECT contact_handle FROM contacts WHERE user_handle = ? AND status = 'accepted' AND contact_handle < ?"
    ).bind(handle, handle).all();

    for (const row of (authContacts.results || [])) {
      await pushToUserDO(env, row.contact_handle, {
        id: crypto.randomUUID(),
        type: "device_removed",
        from: handle,
        to: row.contact_handle,
        ts: Date.now()
      });
    }
  } catch (e) {
    console.warn("device_removed push fehlgeschlagen (non-fatal):", e.message);
  }

  console.log(`🗑️ Device entfernt aus Inbox: ${handle} / ${deviceId} — ${idx.length} verbleiben`);
  return json(request, { ok: true, removed: true, remaining: idx.length });
}

break;

// ======================================================
// 🔐 CMK STORE: Authority speichert gewrappte CMK-Payloads in KV
// ======================================================
case "/e2e/cmk/store":

if (request.method === "POST") {

  const session = await requireSession(request, env);
  if (!session) return json(request, { error: "Not authenticated" }, 401);

  const me = String(session.handle || "").toLowerCase();

  const body = await readJson(request);
  if (!body) return json(request, { error: "Invalid JSON" }, 400);

  const { to, payloads } = body;

  if (!to || typeof to !== "string" || !/^[a-z0-9_]+$/.test(to)) {
    return json(request, { error: "Invalid to" }, 400);
  }
  if (!Array.isArray(payloads) || payloads.length === 0 || payloads.length > 20) {
    return json(request, { error: "Invalid payloads" }, 400);
  }

  const peer = to.toLowerCase();
  const convoId = [me, peer].sort().join(":");

  // Jedes Payload pro Device speichern
  const storedDeviceIds = [];
  for (const p of payloads) {
    if (
      typeof p.deviceId !== "string" || p.deviceId.length < 8 || p.deviceId.length > 64 ||
      typeof p.fromDeviceId !== "string" ||
      typeof p.ivB64 !== "string" ||
      typeof p.ctB64 !== "string"
    ) continue;

    await env.RENEX_KV.put(
      `e2e:cmk:${convoId}:${p.deviceId}`,
      JSON.stringify({ fromDeviceId: p.fromDeviceId, ivB64: p.ivB64, ctB64: p.ctB64 })
    );
    storedDeviceIds.push(p.deviceId);
  }

  // Index für convoId
  const convoIdxKey = `e2e:cmk:index:${convoId}`;
  let convoIdx = [];
  const rawConvoIdx = await env.RENEX_KV.get(convoIdxKey);
  if (rawConvoIdx) { try { convoIdx = JSON.parse(rawConvoIdx); } catch {} }
  for (const did of storedDeviceIds) {
    if (!convoIdx.includes(did)) convoIdx.push(did);
  }
  await env.RENEX_KV.put(convoIdxKey, JSON.stringify(convoIdx));

  // User-Index für account-delete cleanup
  for (const u of [me, peer]) {
    const userIdxKey = `e2e:cmk:user-idx:${u}`;
    let userIdx = [];
    const rawUserIdx = await env.RENEX_KV.get(userIdxKey);
    if (rawUserIdx) { try { userIdx = JSON.parse(rawUserIdx); } catch {} }
    if (!userIdx.includes(convoId)) userIdx.push(convoId);
    await env.RENEX_KV.put(userIdxKey, JSON.stringify(userIdx));
  }

  return json(request, { ok: true });
}

break;

// ======================================================
// 🔐 CMK FETCH: Non-Authority holt gespeicherte CMK aus KV
// ======================================================
case "/e2e/cmk/fetch":

if (request.method === "GET") {

  const session = await requireSession(request, env);
  if (!session) return json(request, { error: "Not authenticated" }, 401);

  const me = String(session.handle || "").toLowerCase();
  const from = (param(params, "from") || "").toLowerCase();

  if (!from || !/^[a-z0-9_]+$/.test(from) || from === me) {
    return json(request, { payload: null });
  }

  const myDeviceId = (param(params, "deviceId") || "").trim();
  if (!myDeviceId || myDeviceId.length < 8 || myDeviceId.length > 64) {
    return json(request, { payload: null });
  }

  const convoId = [me, from].sort().join(":");
  const raw = await env.RENEX_KV.get(`e2e:cmk:${convoId}:${myDeviceId}`);
  if (!raw) return json(request, { payload: null });

  let payload = null;
  try { payload = JSON.parse(raw); } catch {}

  return json(request, { payload });
}

break;

// =========================
// CHAT / SEND (A1.4)
// =========================
case "/chat/send":

if (request.method === "POST") {

  const session = await requireSession(request, env);
  if (!session) {
    return json(request, { error: "Not authenticated" }, 401);
  }
  
const me = String(session.handle || "").toLowerCase();

    // 📦 Body (SAFE)
const body = await readJson(request);
if (!body) return json(request, { error: "Invalid JSON body" }, 400);

const {
  to,
  message,
  e2e,
  payloads,
  ivB64,
  ctB64,
  v,
  type,
  sid,
  epoch
} = body;

// 🔒 Recipient Validation (early guard)
const other = String(to || "").toLowerCase();

if (!/^[a-z0-9_]+$/.test(other)) {
  return json(request, { error: "Invalid recipient" }, 400);
}

// 📏 Payload size limits (D1 storage protection)
const MAX_IV_B64   = 24;    // AES-GCM 12-byte IV → 16 chars base64; 24 = safe headroom
const MAX_CT_B64   = 6000;  // ≤1000 UTF-8 chars × 4 bytes × base64 overhead + AES-GCM tag
const MAX_MSG_LEN  = 1000;  // plaintext fallback
const MAX_SID_LEN  = 128;   // session ID
const MAX_TYPE_LEN = 32;    // control message type

if (typeof ivB64 === "string" && ivB64.length > MAX_IV_B64) {
  return json(request, { error: "ivB64 too large" }, 400);
}
if (typeof ctB64 === "string" && ctB64.length > MAX_CT_B64) {
  return json(request, { error: "ctB64 too large" }, 400);
}
if (typeof message === "string" && message.length > MAX_MSG_LEN) {
  return json(request, { error: "message too large" }, 400);
}
if (typeof sid === "string" && sid.length > MAX_SID_LEN) {
  return json(request, { error: "sid too large" }, 400);
}
if (typeof type === "string" && type.length > MAX_TYPE_LEN) {
  return json(request, { error: "type too large" }, 400);
}

console.log("📨 SEND BODY TYPE:", type);

// Rotation-Index aus Body
const rotationIndex = (typeof body.rotationIndex === "number" && Number.isInteger(body.rotationIndex) && body.rotationIndex >= 0)
  ? body.rotationIndex
  : 0;

// 🛑 HARD SEND RATE LIMIT (global pro User)
// ❗ GILT NICHT für Control-Messages
if (type !== "cmk_req" && type !== "cmk" && type !== "epoch_rotate" && type !== "cmk_rotate") {
  const ok = await rateLimit(
    env,
    `chat_send:${me}`,
    2000,
    1,
    { failOpen: true } // UX: lieber senden als blockieren bei KV-Fehler
  );

  if (!ok) {
    return json(request, {
      error: "Send cooldown",
      retryAfterMs: 2000
    }, 429);
  }
}

// 🛑 CONTROL MESSAGE RATE LIMIT (cmk / cmk_req / epoch_rotate)
// Max. 10 Key-Exchange-Messages pro Minute pro User
if (type === "cmk_req" || type === "cmk" || type === "epoch_rotate" || type === "cmk_rotate") {
  const ok = await rateLimit(
    env,
    `control_send:${me}`,
    60_000,
    10
  );

  if (!ok) {
    return json(request, {
      error: "Control message rate limit exceeded",
      retryAfterMs: 60000
    }, 429);
  }
}

// 🔐 E2E Versions-Guard
// ❗ gilt NUR für echte E2E-Nachrichten
if (type !== "cmk_req" && type !== "cmk" && type !== "epoch_rotate" && type !== "cmk_rotate") {
  if (v !== undefined && v !== 2) {
    return json(request, { error: "Unsupported E2E version" }, 400);
  }
}
// 🔐 v2 Pflichtfelder – NUR für echte verschlüsselte Nachrichten
if (v === 2 && e2e === true && type !== "cmk") {
  if (typeof sid !== "string" || sid.length < 5) {
    return json(request, { error: "Missing or invalid sid" }, 400);
  }

  if (typeof epoch !== "number" || !Number.isInteger(epoch) || epoch < 0) {
    return json(request, { error: "Missing or invalid epoch" }, 400);
  }
}

// 🔒 Darf nur an ACCEPTED Kontakte senden — gilt für ALLE Message-Typen inkl. Control-Messages
// (verhindert CMK-Flooding / E2E-Manipulation gegen Nicht-Kontakte)
const isAllowed = await isAcceptedContact(env, me, to);
if (!isAllowed) {
  return json(request, {
    error: "Recipient not accepted"
  }, 403);
}

if (!other) {
  return json(request, { error: "Missing 'to'" }, 400);
}

const hasLegacyE2E = (e2e && typeof ivB64 === "string" && typeof ctB64 === "string");
const hasMultiE2E =
  (e2e === true &&
   Array.isArray(payloads) &&
   payloads.length > 0);

// 🔐 v2 VALIDATION — NUR für echte verschlüsselte Chat-Messages
if (
  v === 2 &&
  e2e === true &&
  type !== "cmk" &&
  type !== "cmk_req"
) {
  if (
    typeof ivB64 !== "string" ||
    typeof ctB64 !== "string"
  ) {
    return json(
      request,
      { error: "v2 message requires ivB64/ctB64" },
      400
    );
  }
}
   
// ✅ Nur echte Chat-Messages brauchen Payload
if (!type || (type !== "cmk_req" && type !== "cmk" && type !== "epoch_rotate" && type !== "cmk_rotate")) {
  if (!message && !(hasLegacyE2E || hasMultiE2E)) {
    return json(request, { error: "Missing message payload" }, 400);
  }
}

// 🔑 Conversation ID
const cid = convoId(me, other);

const msg = {
  id: crypto.randomUUID(),
  from: me,
  to: other,
  ts: Date.now(),
  status: "sent"
};

if (type === "cmk" || type === "cmk_req" || type === "epoch_rotate" || type === "cmk_rotate") {
  msg.message = undefined;
}

if (type === "cmk" || type === "cmk_req" || type === "epoch_rotate" || type === "cmk_rotate") {
  delete msg.status;
}

// 🔄 Rotation-Index für epoch_rotate
if (type === "epoch_rotate") {
  msg.rotationIndex = rotationIndex;
}

if (typeof sid === "string") {
  msg.sid = sid;
}

if (typeof epoch === "number") {
  msg.epoch = epoch;
}

  // ✅ CMK / Control Message Typ speichern
if (typeof type === "string") {
  msg.type = type;
}

// 🔐 CMK ist Control + E2E-Hülle, aber KEINE Chat-v2-Message
if (type === "cmk") {
  msg.v = 2;        // ok
  msg.e2e = true;   // ok
}
if (type === "cmk_req") {
  msg.v = 1;
  msg.e2e = false;
}

// 🔐 E2E Version nur übernehmen, wenn KEIN Control-Message
if (typeof v === "number" && type !== "cmk_req" && type !== "cmk") {
  msg.v = v;
}
  
  if (e2e) {
    msg.e2e = true; 
  
    // ✅ NEW: multi-device payloads
    if (hasMultiE2E) {
      // minimal validation
      const cleaned = [];
      for (const p of payloads) {
        if (!p) continue;
        const { deviceId, ivB64, ctB64, fromDeviceId } = p;
        if (
          typeof deviceId !== "string" ||
          deviceId.length < 4 ||
          deviceId.length > 64 ||
          typeof ivB64 !== "string" ||
          ivB64.length < 16 ||
          ivB64.length > MAX_IV_B64 ||
          typeof ctB64 !== "string" ||
          ctB64.length < 16 ||
          ctB64.length > MAX_CT_B64
        ) continue;
           
        cleaned.push({ deviceId, ivB64, ctB64, fromDeviceId });
      }
  
      if (cleaned.length > 10) {
        return json(request, { error: "Too many device payloads" }, 400);
      }
        
      msg.payloads = cleaned;
    } else {
      // single payload (AES-GCM)
      msg.ivB64 = ivB64;
      msg.ctB64 = ctB64;
    
      // ⚠️ v NUR setzen, wenn Client es nicht explizit gesetzt hat
      if (msg.v === undefined) {
        msg.v = 2;
      }
    }
      
  } else {
    msg.message = message;
  }
  
// 💾 D1 INSERT — only real chat messages (not control)
if (msg.type !== "cmk" && msg.type !== "cmk_req" && msg.type !== "epoch_rotate" && msg.type !== "cmk_rotate") {
  await env.RENEX_DB.prepare(
    `INSERT OR IGNORE INTO messages
       (id, convo_id, from_user, to_user, ts, status, type, v, e2e, sid, epoch, message, iv_b64, ct_b64, payloads, rotation_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    msg.id,
    cid,
    msg.from,
    msg.to,
    msg.ts,
    msg.status ?? "sent",
    msg.type ?? null,
    msg.v ?? null,
    msg.e2e ? 1 : 0,
    msg.sid ?? null,
    msg.epoch ?? null,
    msg.message ?? null,
    msg.ivB64 ?? null,
    msg.ctB64 ?? null,
    msg.payloads ? JSON.stringify(msg.payloads) : null,
    rotationIndex
  ).run();
}


// ======================================================
// 🌍 CONTROL INDEX (für /chat/control)
// ======================================================
if (msg.type === "cmk" || msg.type === "cmk_req" || msg.type === "epoch_rotate" || msg.type === "cmk_rotate" || msg.type === undefined) {

if (!to || typeof to !== "string") {
    console.error("❌ CONTROL: invalid 'to'", to);
    return json(request, { error: "Invalid control target" }, 400);
  }

  // 🔌 Live Push via DO
  await pushToUserDO(env, String(to).toLowerCase(), msg);
}

// ======================================================
// 🔔 UNREAD COUNTER
// ======================================================
if (msg.type !== "cmk" && msg.type !== "cmk_req" && msg.type !== "epoch_rotate" && msg.type !== "cmk_rotate") {

const unreadKey = `unread:${other}:${me}`;

let count = 0;

const rawUnread = await env.RENEX_KV.get(unreadKey);

if (rawUnread) {
  try {
    count = Number(rawUnread) || 0;
  } catch {}
}

count++;

await env.RENEX_KV.put(unreadKey, String(count));


// 🔥 NEW: UNREAD INDEX UPDATE
const unreadIndexKey = `unread_index:${other}`;

let unreadIndex = {};

const rawIndex = await env.RENEX_KV.get(unreadIndexKey);

if (rawIndex) {
  try { unreadIndex = JSON.parse(rawIndex); } catch {}
}

unreadIndex[me] = count;

await env.RENEX_KV.put(
  unreadIndexKey,
  JSON.stringify(unreadIndex)
);
}

// ✅ Antwort an Client
return json(request, {
  ok: true,
  message: msg
});
}

break;

// =========================
// CHAT / LIST
// =========================
case "/chat/list":

if (request.method === "GET") {

const session = await requireSession(request, env);
  if (!session) {
    return json(request, { error: "Not authenticated" }, 401);
  }

  const me = String(session.handle || "").toLowerCase();

  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";

  const ok = await rateLimit(
    env,
    `chat_list:${me}:${ip}`,
    30_000,
    15,
    { failOpen: true } // UX: Chat-List nicht blockieren bei KV-Fehler
  );

  if (!ok) {
    return json(request, { error: "Too many requests" }, 429);
  }

const otherRaw = param(params, "with");

const limit = Math.min(
  Number(param(params, "limit")) || 30,
  100
);

const cursorRaw = param(params, "cursor");
const cursor = cursorRaw ? Number(cursorRaw) : null;

if (!otherRaw) {
  return json(request, { error: "Missing 'with' parameter" }, 400);
}

const other = String(otherRaw).toLowerCase();
const cid = convoId(me, other);

let sliced = [];
let nextCursor = null;

// 💾 D1 SELECT — cursor pagination (newest first, then reversed)
const rows = cursor !== null
  ? await env.RENEX_DB.prepare(
      `SELECT * FROM messages WHERE convo_id = ? AND ts < ? ORDER BY ts DESC LIMIT ?`
    ).bind(cid, cursor, limit).all()
  : await env.RENEX_DB.prepare(
      `SELECT * FROM messages WHERE convo_id = ? ORDER BY ts DESC LIMIT ?`
    ).bind(cid, limit).all();

sliced = (rows.results || []).reverse().map(r => {
  const m = {
    id: r.id,
    from: r.from_user,
    to: r.to_user,
    ts: r.ts,
    status: r.status,
  };
  if (r.type)    m.type    = r.type;
  if (r.v)       m.v       = r.v;
  if (r.e2e)     m.e2e     = true;
  if (r.sid)     m.sid     = r.sid;
  if (r.epoch != null) m.epoch = r.epoch;
  if (r.message) m.message = r.message;
  if (r.iv_b64)  m.ivB64   = r.iv_b64;
  if (r.ct_b64)  m.ctB64   = r.ct_b64;
  if (r.payloads) {
    try { m.payloads = JSON.parse(r.payloads); } catch {}
  }
  if (r.rotation_index) m.rotationIndex = r.rotation_index;
  return m;
});

if (sliced.length > 0) {
  nextCursor = sliced[0].ts;
}
// ======================================================
// 🔕 UNREAD COUNTER RESET
// ======================================================
await env.RENEX_KV.delete(`unread:${me}:${other}`);

// 🔥 UNREAD INDEX FIX
const unreadIndexKey = `unread_index:${me}`;

const rawUnreadIndex = await env.RENEX_KV.get(unreadIndexKey);

if (rawUnreadIndex) {
  try {
    const unreadIndex = JSON.parse(rawUnreadIndex);

    if (unreadIndex && unreadIndex[other]) {
      delete unreadIndex[other];

      await env.RENEX_KV.put(
        unreadIndexKey,
        JSON.stringify(unreadIndex)
      );
    }
  } catch {}
}

console.log("📦 CHAT LIST RETURN:", {
  me,
  other,
  count: sliced.length
});

return json(request, {
  with: other,
  messages: sliced,
  nextCursor
});
}

break;

// ======================================================
// CHAT / UNREAD (FAST INDEX)
// ======================================================
case "/chat/unread":

if (request.method === "GET") {

  const session = await requireSession(request, env);
  if (!session) {
    return json(request, { error: "Not authenticated" }, 401);
  }

  const me = String(session.handle || "").toLowerCase();

  const raw = await env.RENEX_KV.get(`unread_index:${me}`);

  let map = {};
 
  if (raw) {
    try {
      map = JSON.parse(raw);
    } catch {}
  }

  return json(request, {
    unread: map
  });
}

break;

// =========================
// CHAT / DELIVERED
// =========================
case "/chat/delivered":

if (request.method === "POST") {

const session = await requireSession(request, env);
  if (!session) {
    return json(request, { error: "Not authenticated" }, 401);
  }

  const me = String(session.handle || "").toLowerCase();

const body = await readJson(request);
if (!body) return json(request, { error: "Invalid JSON" }, 400);

  const other = String(body.with || "").toLowerCase();
  if (!other) {
    return json(request, { error: "Missing with" }, 400);
  }

  const cid = convoId(me, other);

  // 💾 D1 UPDATE — mark incoming messages as delivered
  const result = await env.RENEX_DB.prepare(
    `UPDATE messages
     SET status = 'delivered'
     WHERE convo_id = ? AND to_user = ? AND from_user = ? AND type IS NULL AND status != 'delivered'`
  ).bind(cid, me, other).run();

  const updated = result.meta?.changes ?? 0;
// ======================================================
// 🔔 LIVE DELIVERY CONTROL EVENT
// ======================================================

if (updated > 0) {

  const deliveryEvent = {
    id: crypto.randomUUID(),
    type: "delivered",
    from: me,
    to: other,
    ts: Date.now(),
    sid: `dm:${[me, other].sort().join(":")}`
  };

  // 🔌 Live Push via DO
  await pushToUserDO(env, other, deliveryEvent);
}

  return json(request, { ok: true, updated });
}

break;

// =========================
// AUTH / REGISTER / START
// =========================
case "/auth/register/start":

if (request.method === "POST") {

const body = await readJson(request);
if (!body) return json(request, { error: "Invalid JSON" }, 400);

const { handle } = body;

  const h = (handle || "").toLowerCase();

  if (!/^[a-z0-9_]+$/.test(h) || h.length < 3 || h.length > 32) {
    return json(request, { error: "Invalid handle" }, 400);
  }

  // 🛑 Rate Limit: max. 5 Registrierungsversuche pro IP pro Minute (fail-closed)
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const rlOk = await rateLimit(env, `register_start:${ip}`, 60_000, 5);
  if (!rlOk) return json(request, { error: "Too many requests" }, 429);

  // 🤖 Turnstile Bot-Schutz — muss vor jeder weiteren Verarbeitung geprüft werden
  const turnstileOk = await verifyTurnstile(body.turnstile_token, ip, env);
  if (!turnstileOk) {
    return json(request, { error: "Bot check failed. Please try again." }, 403);
  }

  // 🚫 Handle-Sperre prüfen (gelöschte Accounts)
  const deletedFlag = await env.RENEX_KV.get(`deleted:${h}`);
  if (deletedFlag) {
    return json(request, { error: "Handle not available" }, 409);
  }

  // 🔐 Challenge erzeugen
  const challengeB64 = base64url(
    crypto.getRandomValues(new Uint8Array(32))
  );

  // 💾 Challenge speichern (5 Minuten)
  await env.RENEX_KV.put(
    `challenge:register:${h}`,
    JSON.stringify({
      challenge: challengeB64,
      ts: Date.now()
    }),
    { expirationTtl: 300 }
  );

  return json(request, {
    publicKey: {
      challenge: challengeB64,

      rp: {
        name: "RENEX",
        id: "app.renex.id"
      },

      user: {
        id: base64url(new TextEncoder().encode(h)),
        name: h,
        displayName: h
      },

      pubKeyCredParams: [
        { type: "public-key", alg: -7 },    // ES256
        { type: "public-key", alg: -257 }   // RS256 fallback
      ],

      authenticatorSelection: {
        userVerification: "required",
        residentKey: "preferred",
        requireResidentKey: false
      },

      timeout: 60000,
      attestation: "none"
    }
  });
}

break;

// =========================
// AUTH / REGISTER / FINISH
// =========================
case "/auth/register/finish":

if (request.method === "POST") {

const body = await readJson(request);
if (!body) return json(request, { error: "Invalid JSON" }, 400);

  const handle = (body.handle || "").toLowerCase();

  if (!handle || !body.response?.clientDataJSON) {
    return json(request, { error: "Invalid register payload" }, 400);
  }

  // 🔁 Challenge aus KV laden
  const chRaw = await env.RENEX_KV.get(`challenge:register:${handle}`);
  if (!chRaw) {
    return json(request, { error: "Register challenge expired" }, 400);
  }

  const { challenge } = JSON.parse(chRaw);

  // 🔍 clientDataJSON prüfen
  let clientData;
  try {
    clientData = JSON.parse(
      base64urlToString(body.response.clientDataJSON)
    );
  } catch {
    return json(request, { error: "Invalid clientDataJSON" }, 400);
  }

  if (clientData.type !== "webauthn.create") {
    return json(request, { error: "Invalid WebAuthn type" }, 400);
  }

  if (clientData.origin !== "https://app.renex.id") {
    await env.RENEX_KV.delete(`challenge:register:${handle}`);
    return json(request, { error: "Invalid origin" }, 400);
  }

  if (clientData.challenge !== challenge) {
    return json(request, { error: "Challenge mismatch" }, 400);
  }

  // 🧹 Challenge löschen
  await env.RENEX_KV.delete(`challenge:register:${handle}`);

  // 🔑 Public Key aus attestationObject extrahieren
  if (!body.response?.attestationObject) {
    return json(request, { error: "Missing attestationObject" }, 400);
  }

  let authDataReg;
  try {
    const attObjBytes = new Uint8Array(base64urlToArrayBuffer(body.response.attestationObject));
    const attObj = decodeCBOR(attObjBytes);
    authDataReg = attObj["authData"];
  } catch {
    return json(request, { error: "Invalid attestationObject" }, 400);
  }

  if (!authDataReg || authDataReg.length < 55) {
    return json(request, { error: "Invalid authData in attestationObject" }, 400);
  }

  const regCredIdLen = (authDataReg[53] << 8) | authDataReg[54];
  const coseKeyOffset = 55 + regCredIdLen;

  if (authDataReg.length <= coseKeyOffset) {
    return json(request, { error: "Missing COSE key in authData" }, 400);
  }

  let publicKeyJwk;
  try {
    const coseKey = decodeCBOR(authDataReg.slice(coseKeyOffset));
    const kty = coseKey[1];
    const alg = coseKey[3];
    if (kty === 2 && alg === -7) {
      // ES256 / P-256
      publicKeyJwk = { kty: "EC", crv: "P-256", x: base64url(coseKey[-2]), y: base64url(coseKey[-3]) };
    } else if (kty === 3 && alg === -257) {
      // RS256 / RSA
      publicKeyJwk = { kty: "RSA", alg: "RS256", n: base64url(coseKey[-1]), e: base64url(coseKey[-2]) };
    } else {
      return json(request, { error: "Unsupported key type" }, 400);
    }
  } catch {
    return json(request, { error: "Invalid COSE key" }, 400);
  }

  // 💾 Credential + Public Key speichern
  await env.RENEX_KV.put(
    `webauthn:${handle}`,
    JSON.stringify({
      credential_id: body.id,
      publicKeyJwk,
      created_at: Date.now()
    })
  );

  return json(request, { status: "ok" });

}

break;

// =========================
// AUTH / LOGIN / START
// =========================
case "/auth/login/start":

if (request.method === "POST") {

const body = await readJson(request);
if (!body) return json(request, { error: "Invalid JSON" }, 400);

  const handle = (body.handle || "").toLowerCase();
      
  if (!/^[a-z0-9_]+$/.test(handle)) {
    return json(request, { error: "Invalid handle" }, 400);
  }
      
  // 🛑 Rate limit: login/start pro IP
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const ok = await rateLimit(
  env,
  `login_start:${ip}:${handle}`,
  60_000,
  10
  );        
  if (!ok) return json(request, { error: "Too many requests" }, 429);
      
  const stored = await env.RENEX_KV.get(`webauthn:${handle}`);
  if (!stored) {
    return json(request, { error: "No passkey registered" }, 404);
  }
      
  let parsed;
  try {
  parsed = JSON.parse(stored);
  } catch {
    return json(request, { error: "Corrupted passkey data" }, 500);
  }
  const credential_id = parsed.credential_id;
  if (!credential_id || typeof credential_id !== "string") {
    return json(request, { error: "Invalid credential" }, 500);
  }

  // 🔐 Login-Challenge erzeugen
  const challengeB64 = base64url(
    crypto.getRandomValues(new Uint8Array(32))
  );

  // 💾 Login-Challenge speichern (5 Minuten)
  await env.RENEX_KV.put(
    `challenge:login:${handle}`,
      JSON.stringify({
      challenge: challengeB64,
      credential_id,
      ts: Date.now()
      }),
      { expirationTtl: 300 }
    );

    return json(request, {
      publicKey: {
        challenge: challengeB64,
        rpId: "app.renex.id",
    
        allowCredentials: [{
          type: "public-key",
          id: credential_id,   // ✅ STRING!
          transports: ["internal"]
        }],
    
        userVerification: "required",
        timeout: 60000,
      },
    });
  }

  break;

// =========================
// AUTH / LOGIN / FINISH
// =========================
case "/auth/login/finish":

if (request.method === "POST") {

  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const ok = await rateLimit(env, `login_finish:${ip}`, 60_000, 20);
  if (!ok) return json(request, { error: "Too many requests" }, 429);

const body = await readJson(request);
if (!body) return json(request, { error: "Invalid JSON" }, 400);

  const handle = (body.handle || "").toLowerCase();

  if (!/^[a-z0-9_]+$/.test(handle)) {
    return json(request, { error: "Invalid handle" }, 400);
  }

  // 🔁 Challenge laden
  const chRaw = await env.RENEX_KV.get(`challenge:login:${handle}`);
  if (!chRaw) {
    return json(request, { error: "Login challenge expired" }, 400);
  }

  let challengeObj;
  try {
    challengeObj = JSON.parse(chRaw);
  } catch {
    return json(request, { error: "Invalid login challenge" }, 400);
  }

  // ⏱ Age-Check
  if (!challengeObj.ts || Date.now() - challengeObj.ts > 5 * 60 * 1000) {
    await env.RENEX_KV.delete(`challenge:login:${handle}`);
    return json(request, { error: "Login challenge expired" }, 400);
  }

  // 📦 clientDataJSON
  if (!body.response?.clientDataJSON) {
    return json(request, { error: "Missing clientDataJSON" }, 400);
  }

  let clientData;
  try {
    clientData = JSON.parse(base64urlToString(body.response.clientDataJSON));
  } catch {
    return json(request, { error: "Invalid clientDataJSON" }, 400);
  }

  if (clientData.type !== "webauthn.get") {
    return json(request, { error: "Invalid WebAuthn type" }, 400);
  }

  if (clientData.origin !== "https://app.renex.id") {
    await env.RENEX_KV.delete(`challenge:login:${handle}`);
    return json(request, { error: "Invalid origin" }, 400);
  }

  if (clientData.challenge !== challengeObj.challenge) {
    return json(request, { error: "Challenge mismatch" }, 400);
  }

  // 🔐 Credential-ID MUSS passen
  if (body.id !== challengeObj.credential_id) {
    await env.RENEX_KV.delete(`challenge:login:${handle}`);
    return json(request, { error: "Credential mismatch" }, 400);
  }

  // 🔐 authenticatorData
  if (!body.response?.authenticatorData) {
    return json(request, { error: "Missing authenticatorData" }, 400);
  }

  let authData;
  try {
    const bin = base64urlToString(body.response.authenticatorData);
    authData = Uint8Array.from(bin, c => c.charCodeAt(0));
  } catch {
    return json(request, { error: "Invalid authenticatorData" }, 400);
  }

  if (authData.length < 37) {
    return json(request, { error: "Invalid authenticatorData length" }, 400);
  }

  // 🔒 RP ID Hash
  const rpIdHash = authData.slice(0, 32);
  const expectedHash = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("app.renex.id")
    )
  );

  for (let i = 0; i < 32; i++) {
    if (rpIdHash[i] !== expectedHash[i]) {
      return json(request, { error: "Invalid rpIdHash" }, 400);
    }
  }

  // 🚩 FLAGS
  const flags = authData[32];
  if (!(flags & 0x01)) return json(request, { error: "User presence required" }, 400);
  if (!(flags & 0x04)) return json(request, { error: "User verification required" }, 400);

  // 🔢 signCount (BIG FIX)
  const newSignCount =
    (authData[33] << 24) |
    (authData[34] << 16) |
    (authData[35] << 8)  |
    authData[36];

  // 🔁 Stored Credential
  const storedRaw = await env.RENEX_KV.get(`webauthn:${handle}`);
  if (!storedRaw) return json(request, { error: "No passkey registered" }, 403);

  const storedObj = JSON.parse(storedRaw);
  const storedSignCount = Number(storedObj.signCount || 0);

  if (storedSignCount > 0 && newSignCount <= storedSignCount) {
    return json(request, { error: "Replay detected" }, 403);
  }

  // 🔐 Kryptographische Signatur prüfen
  const storedPublicKeyJwk = storedObj.publicKeyJwk;
  if (!storedPublicKeyJwk) {
    return json(request, { error: "Passkey re-registration required" }, 403);
  }

  if (!body.response?.signature) {
    return json(request, { error: "Missing signature" }, 400);
  }

  let publicKey;
  try {
    if (storedPublicKeyJwk.kty === "EC") {
      publicKey = await crypto.subtle.importKey(
        "jwk",
        { ...storedPublicKeyJwk, key_ops: ["verify"] },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"]
      );
    } else if (storedPublicKeyJwk.kty === "RSA") {
      publicKey = await crypto.subtle.importKey(
        "jwk",
        { ...storedPublicKeyJwk, key_ops: ["verify"] },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]
      );
    } else {
      return json(request, { error: "Unsupported key type" }, 403);
    }
  } catch {
    return json(request, { error: "Public key import failed" }, 500);
  }

  // verifyData = authData || SHA-256(clientDataJSON)
  const clientDataJSONBytes = new Uint8Array(base64urlToArrayBuffer(body.response.clientDataJSON));
  const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSONBytes));
  const verifyData = new Uint8Array(authData.length + clientDataHash.length);
  verifyData.set(authData, 0);
  verifyData.set(clientDataHash, authData.length);

  const sigBytes = new Uint8Array(base64urlToArrayBuffer(body.response.signature));

  let signatureValid = false;
  try {
    if (storedPublicKeyJwk.kty === "EC") {
      const rawSig = derToRawECDSA(sigBytes);
      signatureValid = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey, rawSig, verifyData
      );
    } else {
      signatureValid = await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        publicKey, sigBytes, verifyData
      );
    }
  } catch {
    signatureValid = false;
  }

  if (!signatureValid) {
    return json(request, { error: "Signature verification failed" }, 403);
  }

  // 🧹 Challenge löschen (JETZT!)
  await env.RENEX_KV.delete(`challenge:login:${handle}`);

  // 💾 signCount persistieren
  await env.RENEX_KV.put(
    `webauthn:${handle}`,
    JSON.stringify({
      ...storedObj,
      signCount: newSignCount,
      updated_at: Date.now()
    })
  );

  // 🎫 Session
  const sessionToken = "sess_" + crypto.randomUUID();
  const uaHash = base64url(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(request.headers.get("User-Agent") || "")
    )
  );

  await env.RENEX_KV.put(
    `session:${sessionToken}`,
    JSON.stringify({
      handle,
      created_at: Date.now(),
      exp: Date.now() + 86400000,
      ua: uaHash || null
    }),
    { expirationTtl: 86400 }
  );

  return json(request, {
    authenticated: true,
    session_token: sessionToken
  });
}

break;

// =========================
// AUTH / LOGOUT
// =========================
case "/auth/logout":

if (request.method === "POST") {

const token = getToken(request);

  if (token) {
  await env.RENEX_KV.delete(`session:${token}`);
  }

  return json(request, { status: "logged_out" });
}

break;

// =========================
// ACCOUNT / DELETE
// =========================
case "/account":

if (request.method === "DELETE") {

const session = await requireSession(request, env);
if (!session) return json(request, { error: "Not authenticated" }, 401);

const handle = session.handle;
const token = getToken(request);

// 1. Alle Sessions des Users löschen (nur aktuelle ist bekannt → aktuelle löschen)
if (token) {
  await env.RENEX_KV.delete(`session:${token}`);
}

// 2. WebAuthn-Passkey löschen
await env.RENEX_KV.delete(`webauthn:${handle}`);

// 3. Chat-Pubkeys löschen (alle Devices via Index)
const chatIdxRaw = await env.RENEX_KV.get(`chat:pubkeys:${handle}`);
if (chatIdxRaw) {
  try {
    const deviceIds = JSON.parse(chatIdxRaw);
    for (const did of deviceIds) {
      await env.RENEX_KV.delete(`chat:pubkey:${handle}:${did}`);
    }
  } catch {}
  await env.RENEX_KV.delete(`chat:pubkeys:${handle}`);
}
// Legacy single-key
await env.RENEX_KV.delete(`chat:pubkey:${handle}`);

// 4. E2E Inbox-Keys löschen (alle Devices via Index)
const inboxIdxRaw = await env.RENEX_KV.get(`e2e:inbox:index:${handle}`);
if (inboxIdxRaw) {
  try {
    const deviceIds = JSON.parse(inboxIdxRaw);
    for (const did of deviceIds) {
      await env.RENEX_KV.delete(`e2e:inbox:${handle}:${did}`);
    }
  } catch {}
  await env.RENEX_KV.delete(`e2e:inbox:index:${handle}`);
}

// 5. Unread-Counter und Index löschen
const unreadIndex = await env.RENEX_KV.get(`unread_index:${handle}`);
if (unreadIndex) {
  try {
    const map = JSON.parse(unreadIndex);
    for (const peer of Object.keys(map)) {
      await env.RENEX_KV.delete(`unread:${handle}:${peer}`);
    }
  } catch {}
  await env.RENEX_KV.delete(`unread_index:${handle}`);
}

// 6. CMK KV-Einträge löschen
const cmkUserIdxRaw = await env.RENEX_KV.get(`e2e:cmk:user-idx:${handle}`);
if (cmkUserIdxRaw) {
  try {
    const convoIds = JSON.parse(cmkUserIdxRaw);
    for (const convoId of convoIds) {
      const convoIdxRaw = await env.RENEX_KV.get(`e2e:cmk:index:${convoId}`);
      if (convoIdxRaw) {
        try {
          const deviceIds = JSON.parse(convoIdxRaw);
          for (const did of deviceIds) {
            await env.RENEX_KV.delete(`e2e:cmk:${convoId}:${did}`);
          }
        } catch {}
        await env.RENEX_KV.delete(`e2e:cmk:index:${convoId}`);
      }
    }
  } catch {}
  await env.RENEX_KV.delete(`e2e:cmk:user-idx:${handle}`);
}

// 7. Handle für 300 Tage sperren
await env.RENEX_KV.put(
  `deleted:${handle}`,
  "1",
  { expirationTtl: 300 * 24 * 60 * 60 }
);

// 7. Nachrichten in D1 löschen
await env.RENEX_DB.prepare(
  "DELETE FROM messages WHERE from_user = ? OR to_user = ?"
).bind(handle, handle).run();

// 8. Eigene Kontaktzeilen löschen, Gegenseite auf account_deleted setzen
await env.RENEX_DB.prepare(
  "DELETE FROM contacts WHERE user_handle = ?"
).bind(handle).run();

await env.RENEX_DB.prepare(
  "UPDATE contacts SET status = 'account_deleted', updated_at = ? WHERE contact_handle = ?"
).bind(Date.now(), handle).run();

return json(request, { status: "deleted" });
}

break;

// =========================
// CONTACTS / LIST  (Alias)
// =========================
case "/contacts":
case "/contacts/list":

if (request.method === "GET") {

const session = await requireSession(request, env);
if (!session) return json(request, { error: "Not authenticated" }, 401);

const handle = session.handle;

  const { results } = await env.RENEX_DB.prepare(
    "SELECT contact_handle, display_handle, status, direction FROM contacts WHERE user_handle = ? AND status != 'removed'"
  ).bind(handle).all();

  return json(request, {
    contacts: results.map(r => ({
      handle: r.contact_handle,
      display_handle: r.display_handle || r.contact_handle,
      status: r.status,
      direction: r.direction ?? undefined,
    }))
  });
}

break;

      // =========================
      // CONTACTS / REQUEST
      // =========================
case "/contacts/request":

if (request.method === "POST") {

const session = await requireSession(request, env);
if (!session) {
  return json(request, { error: "Not authenticated" }, 401);
}

const me = String(session.handle || "").toLowerCase();

// 🛑 Kontaktanfrage Rate Limit
const ok = await rateLimit(
  env,
  `contact_request:${me}`,
  5000,
  1
);

if (!ok) {
  return json(request, { error: "Too many contact requests" }, 429);
}        

const body = await readJson(request);
if (!body) return json(request, { error: "Invalid JSON" }, 400);

const contact = body.contact;

const targetHandle = String(contact || "")
  .trim()
  .toLowerCase();

if (targetHandle === me) {
  return json(request, { error: "Cannot add yourself" }, 400);
}

const target = await env.RENEX_KV.get(`webauthn:${targetHandle}`);
if (!target) return json(request, { error: "Contact not found" }, 404);

const now = Date.now();

// 🔒 Cross-request Guard: hat targetHandle schon einen pending-Request an mich?
const reverse = await env.RENEX_DB.prepare(
  "SELECT status FROM contacts WHERE user_handle = ? AND contact_handle = ? LIMIT 1"
).bind(targetHandle, me).first();

if (reverse?.status === "pending") {
  // Beide haben gleichzeitig Request geschickt → direkt akzeptieren
  await env.RENEX_DB.prepare(
    "UPDATE contacts SET status = 'accepted', direction = NULL, updated_at = ? WHERE user_handle = ? AND contact_handle = ?"
  ).bind(now, targetHandle, me).run();
  await env.RENEX_DB.prepare(
    "INSERT INTO contacts (user_handle, contact_handle, status, direction, display_handle, created_at, updated_at) VALUES (?, ?, 'accepted', NULL, ?, ?, ?) ON CONFLICT(user_handle, contact_handle) DO UPDATE SET status = 'accepted', direction = NULL, updated_at = excluded.updated_at"
  ).bind(me, targetHandle, targetHandle, now, now).run();
  return json(request, { status: "accepted" });
}

// Gibt es bereits einen Eintrag bei targetHandle für mich?
const existing = await env.RENEX_DB.prepare(
  "SELECT status FROM contacts WHERE user_handle = ? AND contact_handle = ? LIMIT 1"
).bind(targetHandle, me).first();

if (existing) {
  if (existing.status === "pending")  return json(request, { status: "already_pending" });
  if (existing.status === "accepted") return json(request, { status: "already_exists" });
  if (existing.status === "removed") {
    // Wieder aktivieren
    await env.RENEX_DB.prepare(
      "UPDATE contacts SET status = 'pending', direction = 'in', updated_at = ? WHERE user_handle = ? AND contact_handle = ?"
    ).bind(now, targetHandle, me).run();
    return json(request, { status: "requested", contact });
  }
}

// Neue Anfrage: beim Empfänger als "in", beim Sender als "out"
await env.RENEX_DB.prepare(
  "INSERT INTO contacts (user_handle, contact_handle, status, direction, display_handle, created_at, updated_at) VALUES (?, ?, 'pending', 'in', ?, ?, ?) ON CONFLICT(user_handle, contact_handle) DO UPDATE SET status = 'pending', direction = 'in', updated_at = excluded.updated_at"
).bind(targetHandle, me, me, now, now).run();

const mySide = await env.RENEX_DB.prepare(
  "SELECT 1 FROM contacts WHERE user_handle = ? AND contact_handle = ? LIMIT 1"
).bind(me, targetHandle).first();

if (!mySide) {
  await env.RENEX_DB.prepare(
    "INSERT INTO contacts (user_handle, contact_handle, status, direction, display_handle, created_at, updated_at) VALUES (?, ?, 'pending', 'out', ?, ?, ?)"
  ).bind(me, targetHandle, targetHandle, now, now).run();
}

return json(request, { status: "requested", contact });
}

break;

      // =========================
      // CONTACTS / ACCEPT
      // =========================
case "/contacts/accept":

if (request.method === "POST") {

const session = await requireSession(request, env);
if (!session) {
  return json(request, { error: "Not authenticated" }, 401);
}

const me = String(session.handle || "").toLowerCase();

  const body = await readJson(request);
if (!body) return json(request, { error: "Invalid JSON" }, 400);

const { contact } = body;

  const myEntry = await env.RENEX_DB.prepare(
    "SELECT status FROM contacts WHERE user_handle = ? AND contact_handle = ? LIMIT 1"
  ).bind(me, contact).first();

  if (!myEntry) return json(request, { error: "Contact not found" }, 404);
  if (myEntry.status === "accepted") return json(request, { status: "already_accepted" });
  if (myEntry.status !== "pending") return json(request, { error: "Invalid contact state" }, 400);

  const now = Date.now();

  await env.RENEX_DB.prepare(
    "UPDATE contacts SET status = 'accepted', direction = NULL, updated_at = ? WHERE user_handle = ? AND contact_handle = ?"
  ).bind(now, me, contact).run();

  await env.RENEX_DB.prepare(
    "INSERT INTO contacts (user_handle, contact_handle, status, direction, display_handle, created_at, updated_at) VALUES (?, ?, 'accepted', NULL, ?, ?, ?) ON CONFLICT(user_handle, contact_handle) DO UPDATE SET status = 'accepted', direction = NULL, updated_at = excluded.updated_at"
  ).bind(contact, me, me, now, now).run();

  return json(request, { status: "accepted", contact });
      }

      break;

      // =========================
      // CONTACTS / REJECT
      // =========================
case "/contacts/reject":

if (request.method === "POST") {

const session = await requireSession(request, env);
if (!session) {
  return json(request, { error: "Not authenticated" }, 401);
}

const me = String(session.handle || "").toLowerCase();

  const body = await readJson(request);
if (!body) return json(request, { error: "Invalid JSON" }, 400);

const { contact } = body;

  const deleted = await env.RENEX_DB.prepare(
    "DELETE FROM contacts WHERE user_handle = ? AND contact_handle = ?"
  ).bind(me, contact).run();

  if (!deleted.meta?.changes) return json(request, { error: "No contacts" }, 404);

  return json(request, { status: "rejected", contact });
      }

      break;

// =========================
// CONTACTS / REMOVE
// =========================
case "/contacts/remove": 

if (request.method === "POST") {

const session = await requireSession(request, env);
if (!session) {
  return json(request, { error: "Not authenticated" }, 401);
}

const me = String(session.handle || "").toLowerCase();

  const body = await readJson(request);
if (!body) return json(request, { error: "Invalid JSON" }, 400);

const { contact } = body;

  if (!contact || contact === me) {
    return json(request, { error: "Invalid contact" }, 400);
  }

  const now = Date.now();

  await env.RENEX_DB.prepare(
    "UPDATE contacts SET status = 'removed', updated_at = ? WHERE user_handle = ? AND contact_handle = ?"
  ).bind(now, me, contact).run();

  await env.RENEX_DB.prepare(
    "UPDATE contacts SET status = 'removed', updated_at = ? WHERE user_handle = ? AND contact_handle = ?"
  ).bind(now, contact, me).run();

  return json(request, { status: "removed", contact });
}

break;

      // =========================
      // FALLBACK
      // =========================
default:
  return json(request, { error: "Not found" }, 404);

} // ← schließt switch(path)

} catch (e) {
  console.error("WORKER CRASH", e);

  return json(request, {
    error: "Internal server error"
  }, 500);
}

},
};
