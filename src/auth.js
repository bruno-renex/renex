import { base64url } from './utils.js';

// =========================
// SESSION TOKEN REGEX
// =========================
const SESSION_TOKEN_RE = /^sess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateTokenFormat(token) {
  if (!token || token.length < 10 || token.length > 64) return null;
  return SESSION_TOKEN_RE.test(token) ? token : null;
}

export function getToken(request) {
  // 1) Cookie (bevorzugt — nicht in Logs sichtbar)
  const cookie = request.headers.get("Cookie") || "";
  const cookieMatch = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  if (cookieMatch) {
    const t = validateTokenFormat(decodeURIComponent(cookieMatch[1].trim()));
    if (t) return t;
  }

  // 2) Authorization-Header (Fallback für ältere Clients)
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) {
    return validateTokenFormat(auth.slice(7).trim());
  }

  return null;
}

export async function requireSession(request, env) {
  const token = getToken(request);
  if (!token) return null;

  // Minimaler Token-Guard (gegen Müll/Abuse)
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

  // Expiry check (zusätzlich zur KV-TTL)
  if (session?.exp && Date.now() > Number(session.exp)) {
    // optional: sofort entfernen
    await env.RENEX_KV.delete(`session:${token}`);
    return null;
  }

  // User-Agent Bindung (SOFT, Worker-sicher)
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

  // Nur prüfen, wenn BEIDE Seiten vorhanden sind
  if (session?.ua && uaHashB64 && session.ua !== uaHashB64) {
    await env.RENEX_KV.delete(`session:${token}`);
    return null;
  }

  // Handle-Guard
  if (!session?.handle || !/^[a-z0-9_]+$/.test(String(session.handle))) {
    return null;
  }

  return session; // { handle, created_at, exp }
}

export async function rateLimit(env, key, windowMs, limit, { failOpen = false } = {}) {
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
    // Fail-Closed für sicherheitskritische Endpoints (Login, Register)
    // Fail-Open nur wenn explizit erlaubt (z.B. Chat-Send für UX)
    console.error("⚠️ rateLimit KV error:", key, err.message);
    return failOpen ? true : false;
  }
}

// =========================
// CONTACT NORMALIZER
// =========================
export async function isAcceptedContact(env, me, other) {
  other = String(other || "").toLowerCase();
  const row = await env.RENEX_DB.prepare(
    "SELECT status FROM contacts WHERE user_handle = ? AND contact_handle = ? LIMIT 1"
  ).bind(me, other).first();
  return row?.status === "accepted";
}

// =========================
// TURNSTILE VERIFY
// =========================
export async function verifyTurnstile(token, ip, env) {
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

// ── Session-Index: Token registrieren ─────────────────
export async function registerSessionToken(env, handle, token) {
  const key = `sessions:index:${handle}`;
  let tokens = [];
  try {
    const raw = await env.RENEX_KV.get(key);
    if (raw) tokens = JSON.parse(raw);
  } catch {}
  tokens.push(token);
  // Max 20 aktive Sessions pro User speichern
  if (tokens.length > 20) tokens = tokens.slice(-20);
  await env.RENEX_KV.put(key, JSON.stringify(tokens), { expirationTtl: 90000 }); // 25h
}

// ── Session-Index: Token entfernen ────────────────────
export async function unregisterSessionToken(env, handle, token) {
  const key = `sessions:index:${handle}`;
  try {
    const raw = await env.RENEX_KV.get(key);
    if (!raw) return;
    const tokens = JSON.parse(raw).filter(t => t !== token);
    await env.RENEX_KV.put(key, JSON.stringify(tokens), { expirationTtl: 90000 });
  } catch {}
}

// ── Alle Sessions eines Users widerrufen ─────────────
export async function revokeAllSessions(env, handle) {
  const key = `sessions:index:${handle}`;
  try {
    const raw = await env.RENEX_KV.get(key);
    if (!raw) return;
    const tokens = JSON.parse(raw);
    await Promise.all(tokens.map(t => env.RENEX_KV.delete(`session:${t}`)));
    await env.RENEX_KV.delete(key);
    console.log(`🔐 ${tokens.length} Session(s) widerrufen für: ${handle}`);
  } catch (e) {
    console.warn("revokeAllSessions fehlgeschlagen:", e);
  }
}

// ── Event via DO an einzelnen User pushen ────────────
// Fail-silent: User offline → kein Problem, KV hat's gespeichert
export async function pushToUserDO(env, handle, event) {
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

// ── Event an alle Gruppen-Mitglieder pushen ───────────
// Liest Mitglieder aus conversation_members, pusht an jeden (ausser Sender).
// Parallel via Promise.allSettled — ein offline User blockiert keine anderen.
export async function pushToGroupMembers(env, db, groupId, senderHandle, event) {
  let members;
  try {
    const rows = await db.prepare(
      "SELECT member_handle FROM conversation_members WHERE convo_id = ?"
    ).bind(groupId).all();
    members = (rows.results || []).map(r => r.member_handle);
  } catch (e) {
    console.warn("pushToGroupMembers: D1 lookup failed", groupId, e);
    return;
  }

  // Sender bekommt kein Echo (er hat die Nachricht selbst gesendet)
  // senderHandle = null → alle Members benachrichtigen (z.B. Join/Leave-Events)
  const recipients = senderHandle
    ? members.filter(h => h !== senderHandle)
    : members;

  await Promise.allSettled(
    recipients.map(handle => pushToUserDO(env, handle, event))
  );

  console.log(`📡 Group push: ${groupId} → ${recipients.length} members`);
}

// ======================================================
// DURABLE OBJECT: UserSessionDO
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
