import { json, readJson } from '../utils.js';
import { requireSession } from '../auth.js';

// ======================================================
// NOTIFICATION ROUTES
// GET  /notifications/muted  — Liste aller stummgeschalteten Convos
// POST /notifications/mute   — Stummschalten togglen { convoId, mute: bool }
// ======================================================

export async function handleNotificationRoutes(request, env, path) {

  const session = await requireSession(request, env);
  if (!session) return json(request, { error: "Not authenticated" }, 401);
  const me = String(session.handle || "").toLowerCase();

  switch (path) {

    // GET /notifications/muted
    case "/notifications/muted": {
      if (request.method !== "GET") break;
      const rows = await env.RENEX_DB.prepare(
        "SELECT convo_id FROM notification_mutes WHERE user_handle = ?"
      ).bind(me).all();
      const muted = (rows.results || []).map(r => r.convo_id);
      return json(request, { muted });
    }

    // POST /notifications/mute
    // Body: { convoId: string, mute: boolean }
    case "/notifications/mute": {
      if (request.method !== "POST") break;
      const body = await readJson(request);
      if (!body) return json(request, { error: "Invalid JSON" }, 400);

      const { convoId, mute } = body;
      if (!convoId || typeof mute !== "boolean") {
        return json(request, { error: "convoId + mute (bool) required" }, 400);
      }

      // Sicherstellen dass User Mitglied der Konversation ist
      // DM convoId = "alice:bob" (sorted handles), Gruppe = UUID
      const isDm = /^[a-z0-9_]{1,64}:[a-z0-9_]{1,64}$/i.test(convoId);
      if (isDm) {
        // DM: User muss einer der beiden Handles sein
        const parts = convoId.split(':');
        if (!parts.includes(me)) return json(request, { error: "Not a member" }, 403);
      } else {
        // Gruppe: conversation_members prüfen
        const isMember = await env.RENEX_DB.prepare(
          "SELECT 1 FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
        ).bind(convoId, me).first();
        if (!isMember) return json(request, { error: "Not a member" }, 403);
      }

      if (mute) {
        await env.RENEX_DB.prepare(
          `INSERT INTO notification_mutes (user_handle, convo_id, muted_at)
           VALUES (?, ?, ?)
           ON CONFLICT(user_handle, convo_id) DO NOTHING`
        ).bind(me, convoId, Date.now()).run();
      } else {
        await env.RENEX_DB.prepare(
          "DELETE FROM notification_mutes WHERE user_handle = ? AND convo_id = ?"
        ).bind(me, convoId).run();
      }

      return json(request, { ok: true, convoId, muted: mute });
    }

    default:
      break;
  }

  return json(request, { error: "Not found" }, 404);
}
