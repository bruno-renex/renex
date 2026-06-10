import { base64url } from './utils.js';
import { getChannelViewerHandles } from './lib/channelAccess.js';

// =========================
// SESSION TOKEN REGEX
// =========================
const SESSION_TOKEN_RE   = /^sess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Guest-Token-Format: "guest_" + 32 hex chars (16 zufällige Bytes)
export const GUEST_TOKEN_RE  = /^guest_[a-z0-9]{32}$/;
// Guest-Handle-Format: "guest_" + 8 hex chars (4 zufällige Bytes)
export const GUEST_HANDLE_RE = /^guest_[a-z0-9]{8}$/;

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

  // Token-Format: "sess_" + UUID = exakt 41 Zeichen
  if (typeof token !== "string" || token.length !== 41 || !token.startsWith("sess_")) {
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

  // Sliding-TTL-Refresh (M4, 2026-05-02; TTL 24h→30d 2026-06-03): wenn letzte
  // Refresh-Zeit > 6h alt ist, verlängert sich KV-TTL auf weitere 30d. Aktive
  // User bleiben praktisch unbegrenzt eingeloggt; idle 30d → KV expired →
  // forced logout. KV-TTL = Cookie-Max-Age (konsistent), KV ist Source-of-Truth.
  const SESSION_REFRESH_THRESHOLD_MS = 6 * 60 * 60 * 1000;
  const SESSION_TTL_SEC = 2_592_000;
  const lastRef = Number(session.lastRefreshed || session.createdAt || session.created_at || 0);
  if (lastRef > 0 && Date.now() - lastRef > SESSION_REFRESH_THRESHOLD_MS) {
    session.lastRefreshed = Date.now();
    // Non-fatal: bei KV-Fehler bleibt Session weiter gültig (alte TTL läuft normal aus)
    try {
      await env.RENEX_KV.put(`session:${token}`, JSON.stringify(session), { expirationTtl: SESSION_TTL_SEC });
    } catch {}
  }

  return session; // { handle, createdAt|created_at, exp?, ua, lastRefreshed? }
}

// =========================
// GUEST SESSION AUTH
// =========================

// Liest das guest_session-Cookie ODER den X-Guest-Token Header aus dem Request
// X-Guest-Token wird von apiFetch gesetzt wenn Safari/ITP den Cookie blockiert
export function getGuestToken(request) {
  // 1) X-Guest-Token Header (Safari ITP Fallback)
  const headerToken = request.headers.get("X-Guest-Token");
  if (headerToken) {
    const t = String(headerToken).trim();
    if (GUEST_TOKEN_RE.test(t)) return t;
  }
  // 2) Cookie (Standard)
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)guest_session=([^;]+)/);
  if (!m) return null;
  const t = decodeURIComponent(m[1].trim());
  return GUEST_TOKEN_RE.test(t) ? t : null;
}

// Validiert einen Guest-Token → gibt Guest-Session-Objekt zurück oder null
// Rückgabe: { handle, isGuest: true, token, convoId, expiresAt, msgLimit, msgCount }
export async function requireGuestSession(request, env) {
  const token = getGuestToken(request);
  if (!token) return null;

  // Erst KV (schnell), dann D1 als Fallback
  const raw = await env.RENEX_KV.get(`guest_session:${token}`);
  if (raw) {
    try {
      const s = JSON.parse(raw);
      if (!s?.handle || !GUEST_HANDLE_RE.test(s.handle)) return null;
      if (s.expiresAt && Date.now() > s.expiresAt) return null;
      return { ...s, isGuest: true };
    } catch {
      return null;
    }
  }

  // KV abgelaufen → D1 prüfen (z.B. nach Worker-Neustart)
  const row = await env.RENEX_DB.prepare(
    "SELECT * FROM guest_sessions WHERE token = ?"
  ).bind(token).first();
  if (!row) return null;
  if (Date.now() > row.expires_at) return null;
  if (!row.guest_handle || !GUEST_HANDLE_RE.test(row.guest_handle)) return null;
  if (row.converted_to) return null; // Bereits konvertiert

  // KV-Cache wiederherstellen
  const ttlSec = Math.max(60, Math.floor((row.expires_at - Date.now()) / 1000));
  const session = {
    handle:    row.guest_handle,
    isGuest:   true,
    token,
    convoId:   row.convo_id,
    expiresAt: row.expires_at,
    msgLimit:  row.msg_limit,
    msgCount:  row.msg_count,
  };
  await env.RENEX_KV.put(`guest_session:${token}`, JSON.stringify(session), {
    expirationTtl: ttlSec,
  });
  return session;
}

// Akzeptiert echte Sessions UND Gast-Sessions
// Gibt null zurück wenn weder noch vorhanden
export async function requireAnySession(request, env) {
  const real = await requireSession(request, env);
  if (real) return real;
  return requireGuestSession(request, env);
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
  await env.RENEX_KV.put(key, JSON.stringify(tokens), { expirationTtl: 2592000 }); // 30d (matches sliding session lifetime)
}

// ── Session-Index: Token entfernen ────────────────────
export async function unregisterSessionToken(env, handle, token) {
  const key = `sessions:index:${handle}`;
  try {
    const raw = await env.RENEX_KV.get(key);
    if (!raw) return;
    const tokens = JSON.parse(raw).filter(t => t !== token);
    await env.RENEX_KV.put(key, JSON.stringify(tokens), { expirationTtl: 2592000 });
  } catch {}
}

// ── Alle Sessions eines Users widerrufen ─────────────
// options.exceptToken: dieser Token überlebt — Nutzung im device-revoke-Pfad,
// damit das initiierende Device seine laufende CMK-Rotation + Distribution
// nicht mit 401-Burst killt. Andere Sessions werden trotzdem revoked
// (Security-Garantie bleibt für die zu schützenden anderen Devices).
export async function revokeAllSessions(env, handle, options = {}) {
  const exceptToken = options.exceptToken || null;
  const key = `sessions:index:${handle}`;
  try {
    const raw = await env.RENEX_KV.get(key);
    if (!raw) return;
    const tokens = JSON.parse(raw);
    const toRevoke = exceptToken ? tokens.filter(t => t !== exceptToken) : tokens;
    await Promise.all(toRevoke.map(t => env.RENEX_KV.delete(`session:${t}`)));
    if (exceptToken && toRevoke.length !== tokens.length) {
      // Index neu schreiben mit nur dem behaltenen Token (sonst löschen wir den Index)
      await env.RENEX_KV.put(key, JSON.stringify([exceptToken]), { expirationTtl: 2592000 });
      console.log(`🔐 ${toRevoke.length}/${tokens.length} Session(s) widerrufen für: ${handle} (initiator behalten)`);
    } else {
      await env.RENEX_KV.delete(key);
      console.log(`🔐 ${toRevoke.length} Session(s) widerrufen für: ${handle}`);
    }
  } catch (e) {
    console.warn("revokeAllSessions fehlgeschlagen:", e);
  }
}

// ──────────────────────────────────────────────────────
// Phase 3A.5: User-Tier (Free / Pro)
// Storage: KV `user:tier:<handle>` = "free" | "pro" (missing ⇒ "free").
// Set via wrangler kv (oder ab Phase 6 via Founder's-Pass-Flow / Stripe-Webhook).
// ──────────────────────────────────────────────────────
const VALID_TIERS = new Set(['free', 'pro']);

export async function getUserTier(env, handle) {
  try {
    const raw = await env.RENEX_KV.get(`user:tier:${String(handle).toLowerCase()}`);
    const t = (raw || 'free').toLowerCase();
    return VALID_TIERS.has(t) ? t : 'free';
  } catch {
    return 'free';
  }
}

// ── Event via DO an einzelnen User pushen ────────────
// Gibt die Anzahl zugestellter WebSocket-Verbindungen zurück (0 = offline).
// Fail-silent: User offline → return 0.
export async function pushToUserDO(env, handle, event) {
  try {
    const id = env.USER_SESSION_DO.idFromName(String(handle).toLowerCase());
    const stub = env.USER_SESSION_DO.get(id);
    const res = await stub.fetch("https://do-internal/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    const data = await res.json().catch(() => ({}));
    return data.delivered || 0;
  } catch (e) {
    // User offline oder DO nicht erreichbar → kein Fehler
    console.log("📴 pushToUserDO skipped (user offline):", handle);
    return 0;
  }
}

// ── Event an alle Gruppen-Mitglieder pushen ───────────
// Liest Mitglieder aus KV-Cache (TTL 60s), fällt auf D1 zurück bei Cache-Miss.
// Parallel via Promise.allSettled — ein offline User blockiert keine anderen.
//
// `opts.bypassCache=true` — liest IMMER direkt aus D1 (frische Liste).
// Notwendig direkt nach `member_left`/`member_removed` (KV-delete dort ist
// fire-and-forget) und für GSK-Distribution (sicherheitskritisch: ex-member
// darf keine GSK-Events mehr empfangen).
const GROUP_MEMBERS_CACHE_TTL   = 60;  // Sekunden (klassische Groups)
const CHANNEL_MEMBERS_CACHE_TTL = 300; // Sekunden (Channels — Members ändern selten)

/**
 * Type-aware Lookup für Convo-Member-Handles.
 *
 * Quelle hängt vom `conversations.type` ab:
 *   - 'dm'      : N/A (DMs sind 1:1, brauchen keine Member-Liste)
 *   - 'group'   : conversation_members.member_handle
 *   - 'channel' : server_members.user_handle WHERE server_id = conversations.server_id
 *                 (Phase 3A: alle Server-Member sind Channel-Member.
 *                  Phase 4: VIEW_CHANNEL-Permission-Filter via channel_permission_overrides
 *                  kommt nach Roles-Editor-UI.)
 *
 * @param {D1Database} db
 * @param {string} convoId
 * @returns {Promise<string[]>} alle Handles, leer wenn convo nicht existiert
 */
/**
 * Type-aware Membership-Check.
 * Effizienter als getConvoMemberHandles().includes(handle) — exists-only Query.
 *
 * @param {D1Database} db
 * @param {string} convoId
 * @param {string} handle
 * @returns {Promise<boolean>}
 */
export async function isConvoMember(db, convoId, handle) {
  const convo = await db.prepare(
    "SELECT type, server_id FROM conversations WHERE id = ?"
  ).bind(convoId).first();
  if (!convo) return false;

  if (convo.type === 'channel' && convo.server_id) {
    const r = await db.prepare(
      "SELECT 1 FROM server_members WHERE server_id = ? AND user_handle = ?"
    ).bind(convo.server_id, handle).first();
    return !!r;
  }

  // 'group' default
  const r = await db.prepare(
    "SELECT 1 FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
  ).bind(convoId, handle).first();
  return !!r;
}

export async function getConvoMemberHandles(db, convoId) {
  const r = await getConvoMembersWithType(db, convoId);
  return r.handles;
}

/**
 * Erweiterte Variante: liefert handles + type + serverId.
 * Wird intern von pushToGroupMembers genutzt um die TTL für den
 * Recipient-Set-Cache type-aware zu setzen (Spec SERVERS.md §4.3).
 *
 * @param {D1Database} db
 * @param {string} convoId
 * @returns {Promise<{type: string|null, serverId: string|null, handles: string[]}>}
 */
export async function getConvoMembersWithType(db, convoId) {
  const convo = await db.prepare(
    "SELECT type, server_id FROM conversations WHERE id = ?"
  ).bind(convoId).first();
  if (!convo) return { type: null, serverId: null, handles: [] };

  if (convo.type === 'channel' && convo.server_id) {
    // C2: Recipient-Set auf VIEW_CHANNEL-Berechtigte beschränken (private Channels).
    // Fast-Path in getChannelViewerHandles → kein Overhead für offene Channels
    // (ohne Overrides = alle Member). Gilt für WS-Broadcast UND Web-Push, da beide
    // über getConvoMembersWithType/getConvoMemberHandles laufen.
    const handles = await getChannelViewerHandles(db, convo.server_id, convoId);
    return {
      type:     'channel',
      serverId: convo.server_id,
      handles,
    };
  }

  // 'group' (default) — auch fallback wenn type unspecified
  const rows = await db.prepare(
    "SELECT member_handle FROM conversation_members WHERE convo_id = ?"
  ).bind(convoId).all();
  return {
    type:     convo.type || 'group',
    serverId: null,
    handles:  (rows.results || []).map(r => r.member_handle),
  };
}

export async function pushToGroupMembers(env, db, groupId, senderHandle, event, opts = {}) {
  const bypassCache = opts.bypassCache === true;
  let members;
  const cacheKey = `grp_members:${groupId}`;
  try {
    const cached = bypassCache ? null : await env.RENEX_KV.get(cacheKey);
    if (cached) {
      members = JSON.parse(cached);
    } else {
      // Type-aware: groups → conversation_members, channels → server_members.
      // TTL ebenfalls type-aware: Channels haben stabile Member-Listen (nur
      // bei kick/ban/leave/join/role-changes invalidiert), daher 5min Cache;
      // Groups historically 60s.
      const r = await getConvoMembersWithType(db, groupId);
      members = r.handles;
      if (!bypassCache) {
        const ttl = r.type === 'channel' ? CHANNEL_MEMBERS_CACHE_TTL : GROUP_MEMBERS_CACHE_TTL;
        env.RENEX_KV.put(cacheKey, JSON.stringify(members), { expirationTtl: ttl }).catch(() => {});
      }
    }
  } catch (e) {
    console.warn("pushToGroupMembers: lookup failed", groupId, e);
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

  // Handle aus DO-Name ableiten (gesetzt via idFromName(wsHandle))
  get _handle() {
    try { return this.state.id.name || null; } catch { return null; }
  }

  async fetch(request) {
    const url = new URL(request.url);

    // ── WebSocket Upgrade (vom Browser) ──────────────────
    if (request.headers.get("Upgrade") === "websocket") {
      const { 0: client, 1: server } = new WebSocketPair();
      // Hibernatable WebSocket: DO schläft wenn idle → kosteneffizient
      this.state.acceptWebSocket(server);
      // Presence: sofort online setzen (TTL übernimmt Ablauf, kein Alarm nötig)
      await this._setOnline();
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

  // Hibernatable WebSocket Handlers
  webSocketMessage(ws, message) {
    // Heartbeat — Client sendet { type: "ping", ts }, Server antwortet mit
    // { type: "pong", ts }. Verhindert NAT-Timeout + DO-Hibernation.
    try {
      const m = typeof message === "string" ? JSON.parse(message) : null;
      if (m?.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", ts: m.ts || Date.now() }));
        // KV-Presence refreshen — sonst läuft TTL (5min) ab und der User
        // erscheint fälschlich als offline obwohl WS aktiv ist. Frontend
        // pingt alle 25s → bleibt komfortabel innerhalb der TTL.
        // Fire-and-forget: pong nicht durch KV-Latenz blockieren.
        void this._setOnline().catch(() => {});
      }
    } catch {}
  }

  async webSocketClose(ws, code, reason) {
    // Letzter Socket geschlossen → offline
    if (this.state.getWebSockets().length === 0) {
      await this._setOffline();
    }
  }

  async webSocketError(ws, error) {
    if (this.state.getWebSockets().length === 0) {
      await this._setOffline();
    }
  }

  // ── KV-Helpers ────────────────────────────────────────
  async _setOnline() {
    const handle = this._handle;
    if (!handle || !this.env?.RENEX_KV) return;
    await this.env.RENEX_KV.put(
      `presence:${handle}`,
      JSON.stringify({ online: true, ts: Date.now() }),
      { expirationTtl: 300 }   // 5 Min TTL — kein Alarm, TTL übernimmt Ablauf
    );
  }

  async _setOffline() {
    const handle = this._handle;
    if (!handle || !this.env?.RENEX_KV) return;
    await this.env.RENEX_KV.put(
      `presence:${handle}`,
      JSON.stringify({ online: false, lastSeen: Date.now() }),
      { expirationTtl: 7 * 24 * 3600 }  // 7 Tage — für "zuletzt gesehen"
    );
  }
}
