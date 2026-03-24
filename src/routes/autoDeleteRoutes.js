import { json, readJson } from '../utils.js';
import { requireSession, pushToUserDO } from '../auth.js';

// ======================================================
// AUTO-DELETE ROUTES: /chat/auto-delete
// ======================================================
export async function handleAutoDeleteRoutes(request, env, path, params) {
  switch (path) {

    // =========================
    // AUTO-DELETE PRO CONVERSATION
    // =========================
    case "/chat/auto-delete": {
      const session = await requireSession(request, env);
      if (!session) return json(request, { error: "Not authenticated" }, 401);
      const me = session.handle;

      // GET: aktuelles Setting für Conversation laden
      if (request.method === "GET") {
        const url = new URL(request.url);
        const peer = url.searchParams.get("peer");
        if (!peer) return json(request, { error: "peer required" }, 400);
        const convoId = [me, peer].sort().join(":");
        const row = await env.RENEX_DB.prepare(
          "SELECT * FROM auto_delete_settings WHERE convo_id = ?"
        ).bind(convoId).first();
        return json(request, row ?? { convo_id: convoId, status: "off" });
      }

      if (request.method === "POST") {
        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);
        const { peer, action, days } = body;
        if (!peer || !action) return json(request, { error: "peer + action required" }, 400);

        // Contact-Check: nur akzeptierte Kontakte
        const contact = await env.RENEX_DB.prepare(
          "SELECT status FROM contacts WHERE user_handle = ? AND contact_handle = ?"
        ).bind(me, peer).first();
        if (contact?.status !== "accepted") return json(request, { error: "Not a contact" }, 403);

        const ALLOWED_DAYS = new Set([1, 7, 28, 90]);
        const convoId = [me, peer].sort().join(":");
        const now = Date.now();

        if (action === "propose") {
          if (!ALLOWED_DAYS.has(Number(days))) return json(request, { error: "Invalid days" }, 400);
          await env.RENEX_DB.prepare(
            `INSERT INTO auto_delete_settings (convo_id, days, proposed_by, status, updated_at)
             VALUES (?, ?, ?, 'pending', ?)
             ON CONFLICT(convo_id) DO UPDATE SET days = excluded.days, proposed_by = excluded.proposed_by, status = 'pending', updated_at = excluded.updated_at`
          ).bind(convoId, Number(days), me, now).run();

          // Control-Message an Peer
          const ctrl = { id: crypto.randomUUID(), from: me, to: peer, type: "auto_delete_set", action: "propose", days: Number(days), ts: now };
          await pushToUserDO(env, peer, ctrl);
          return json(request, { ok: true, status: "pending", days: Number(days) });
        }

        if (action === "accept") {
          const row = await env.RENEX_DB.prepare(
            "SELECT * FROM auto_delete_settings WHERE convo_id = ?"
          ).bind(convoId).first();
          if (!row || row.status !== "pending") return json(request, { error: "No pending proposal" }, 400);
          if (row.proposed_by === me) return json(request, { error: "Cannot accept own proposal" }, 400);

          await env.RENEX_DB.prepare(
            "UPDATE auto_delete_settings SET status = 'active', updated_at = ? WHERE convo_id = ?"
          ).bind(now, convoId).run();

          // Control-Message an Peer
          const ctrl = { id: crypto.randomUUID(), from: me, to: peer, type: "auto_delete_set", action: "accept", days: row.days, ts: now };
          await pushToUserDO(env, peer, ctrl);
          return json(request, { ok: true, status: "active", days: row.days });
        }

        if (action === "decline" || action === "cancel") {
          await env.RENEX_DB.prepare(
            "DELETE FROM auto_delete_settings WHERE convo_id = ?"
          ).bind(convoId).run();

          // Control-Message an Peer
          const ctrl = { id: crypto.randomUUID(), from: me, to: peer, type: "auto_delete_set", action, ts: now };
          await pushToUserDO(env, peer, ctrl);
          return json(request, { ok: true, status: "off" });
        }

        return json(request, { error: "Invalid action" }, 400);
      }
      break;
    }

    default:
      break;
  }

  return json(request, { error: "Not found" }, 404);
}
