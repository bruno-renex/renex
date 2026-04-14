import { json, readJson } from '../utils.js';
import { requireSession, requireAnySession } from '../auth.js';

// ======================================================
// NOTIFICATION ROUTES
// GET  /notifications/muted  — Liste aller stummgeschalteten Convos
// POST /notifications/mute   — Stummschalten togglen { convoId, mute: bool }
// ======================================================

export async function handleNotificationRoutes(request, env, path) {

  const session = await requireAnySession(request, env);
  if (!session) return json(request, { error: "Not authenticated" }, 401);
  const me = String(session.handle || "").toLowerCase();
  const isGuest = session.isGuest === true;

  switch (path) {

    // GET /notifications/muted
    case "/notifications/muted": {
      if (request.method !== "GET") break;
      // Gäste haben keine Mute-Einstellungen → leere Liste
      if (isGuest) return json(request, { muted: [] });
      const rows = await env.RENEX_DB.prepare(
        "SELECT convo_id, level, expires_at FROM notification_mutes WHERE user_handle = ?"
      ).bind(me).all();
      // Abgelaufene Mutes bereinigen + aktive zurückgeben
      const now = Date.now();
      const active = [];
      const expired = [];
      for (const r of (rows.results || [])) {
        if (r.expires_at && now > r.expires_at) {
          expired.push(r.convo_id);
        } else {
          active.push({ convoId: r.convo_id, level: r.level || "all", expiresAt: r.expires_at });
        }
      }
      // Cleanup expired (fire-and-forget)
      if (expired.length > 0) {
        Promise.allSettled(expired.map(cid =>
          env.RENEX_DB.prepare("DELETE FROM notification_mutes WHERE user_handle = ? AND convo_id = ?").bind(me, cid).run()
        )).catch(() => {});
      }
      return json(request, { muted: active });
    }

    // POST /notifications/mute
    // Body: { convoId, mute: bool } (legacy) ODER
    // Body: { convoId, level: 'all'|'mentions_only'|'nothing', duration?: minutes }
    case "/notifications/mute": {
      if (request.method !== "POST") break;
      if (isGuest) return json(request, { error: "Not authorized" }, 403);
      const body = await readJson(request);
      if (!body) return json(request, { error: "Invalid JSON" }, 400);

      const { convoId, mute, level, duration } = body;
      if (!convoId) {
        return json(request, { error: "convoId required" }, 400);
      }

      // Sicherstellen dass User Mitglied der Konversation ist
      const isDm = /^[a-z0-9_]{1,64}:[a-z0-9_]{1,64}$/i.test(convoId);
      if (isDm) {
        const parts = convoId.split(':');
        if (!parts.includes(me)) return json(request, { error: "Not a member" }, 403);
      } else {
        const isMember = await env.RENEX_DB.prepare(
          "SELECT 1 FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
        ).bind(convoId, me).first();
        if (!isMember) return json(request, { error: "Not a member" }, 403);
      }

      // Granulares Level (neu) oder Legacy bool
      // Discord-Style Levels:
      //   all              = komplett stumm (keine Notifications)
      //   mentions_only    = nur @handle (NICHT @everyone)
      //   mentions_and_everyone = @handle + @everyone
      //   nothing          = alles an (Eintrag löschen)
      const resolvedLevel = level || (mute === true ? "all" : null);
      const validLevels = ["all", "mentions_only", "mentions_and_everyone", "nothing"];

      if (resolvedLevel && !validLevels.includes(resolvedLevel)) {
        return json(request, { error: "Invalid level. Use: all, mentions_only, mentions_and_everyone, nothing" }, 400);
      }

      // Unmute: level=nothing ODER mute=false → Eintrag löschen
      if (resolvedLevel === "nothing" || mute === false) {
        await env.RENEX_DB.prepare(
          "DELETE FROM notification_mutes WHERE user_handle = ? AND convo_id = ?"
        ).bind(me, convoId).run();
        return json(request, { ok: true, convoId, muted: false, level: "nothing" });
      }

      // Mute mit Level + optionaler Duration
      const expiresAt = (typeof duration === "number" && duration > 0)
        ? Date.now() + duration * 60 * 1000
        : null;

      await env.RENEX_DB.prepare(
        `INSERT INTO notification_mutes (user_handle, convo_id, muted_at, level, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_handle, convo_id) DO UPDATE SET
           level = excluded.level,
           expires_at = excluded.expires_at,
           muted_at = excluded.muted_at`
      ).bind(me, convoId, Date.now(), resolvedLevel || "all", expiresAt).run();

      return json(request, { ok: true, convoId, muted: true, level: resolvedLevel || "all", expiresAt });
    }

    default:
      break;
  }

  return json(request, { error: "Not found" }, 404);
}
