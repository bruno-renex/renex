import { json, readJson, param, convoId } from '../utils.js';
import { requireSession, rateLimit, pushToUserDO } from '../auth.js';
import { handleChatSend } from '../helpers/chatSend.js';

// ======================================================
// CHAT ROUTES: /chat/send, /chat/list, /chat/unread,
//              /chat/delivered, /chat/message/delete
// ======================================================
export async function handleChatRoutes(request, env, path, params) {
  switch (path) {

    // =========================
    // CHAT / SEND
    // =========================
    case "/chat/send": {
      if (request.method === "POST") {
        return handleChatSend(request, env);
      }
      break;
    }

    // =========================
    // CHAT / LIST
    // =========================
    case "/chat/list": {
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

        // D1 SELECT — cursor pagination (newest first, then reversed)
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
          if (r.sig)       m.sig      = r.sig;
          if (r.device_id) m.deviceId = r.device_id;
          return m;
        });

        let nextCursor = null;
        if (sliced.length > 0) {
          nextCursor = sliced[0].ts;
        }

        // ======================================================
        // UNREAD COUNTER RESET
        // ======================================================
        await env.RENEX_KV.delete(`unread:${me}:${other}`);

        // UNREAD INDEX FIX
        const unreadIndexKey = `unread_index:${me}`;

        const rawUnreadIndex = await env.RENEX_KV.get(unreadIndexKey);

        if (rawUnreadIndex) {
          try {
            const unreadIndex = JSON.parse(rawUnreadIndex);
            if (unreadIndex && unreadIndex[other]) {
              delete unreadIndex[other];
              await env.RENEX_KV.put(unreadIndexKey, JSON.stringify(unreadIndex));
            }
          } catch {}
        }

        console.log("📦 CHAT LIST RETURN:", { me, other, count: sliced.length });

        return json(request, {
          with: other,
          messages: sliced,
          nextCursor
        });
      }
      break;
    }

    // ======================================================
    // CHAT / UNREAD (FAST INDEX)
    // ======================================================
    case "/chat/unread": {
      if (request.method === "GET") {
        const session = await requireSession(request, env);
        if (!session) {
          return json(request, { error: "Not authenticated" }, 401);
        }

        const me = String(session.handle || "").toLowerCase();

        const raw = await env.RENEX_KV.get(`unread_index:${me}`);

        let map = {};
        if (raw) {
          try { map = JSON.parse(raw); } catch {}
        }

        return json(request, { unread: map });
      }
      break;
    }

    // =========================
    // CHAT / DELIVERED
    // =========================
    case "/chat/delivered": {
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

        // D1 UPDATE — mark incoming messages as delivered
        const result = await env.RENEX_DB.prepare(
          `UPDATE messages
           SET status = 'delivered'
           WHERE convo_id = ? AND to_user = ? AND from_user = ? AND type IS NULL AND status != 'delivered'`
        ).bind(cid, me, other).run();

        const updated = result.meta?.changes ?? 0;

        // ======================================================
        // LIVE DELIVERY CONTROL EVENT
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

          // Live Push via DO
          await pushToUserDO(env, other, deliveryEvent);
        }

        return json(request, { ok: true, updated });
      }
      break;
    }

    // =========================
    // CHAT / DELETE MESSAGE
    // =========================
    case "/chat/message/delete": {
      if (request.method === "DELETE" || request.method === "POST") {
        const session = await requireSession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);

        const me = String(session.handle || "").toLowerCase();

        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);

        const msgId = String(body.id || "").trim();
        if (!msgId) return json(request, { error: "Missing id" }, 400);

        // Nachricht laden — prüfen ob Sender korrekt
        const row = await env.RENEX_DB.prepare(
          "SELECT id, from_user, to_user, convo_id FROM messages WHERE id = ?"
        ).bind(msgId).first();

        if (!row) return json(request, { error: "Message not found" }, 404);
        if (row.from_user !== me) return json(request, { error: "Forbidden" }, 403);

        // Aus D1 löschen
        await env.RENEX_DB.prepare("DELETE FROM messages WHERE id = ?").bind(msgId).run();

        // Peer via DO benachrichtigen
        const peer = row.to_user === me ? row.from_user : row.to_user;
        await pushToUserDO(env, peer, {
          id: crypto.randomUUID(),
          type: "message_deleted",
          messageId: msgId,
          from: me,
          to: peer,
          ts: Date.now()
        });

        return json(request, { ok: true });
      }
      break;
    }

    default:
      break;
  }

  return json(request, { error: "Not found" }, 404);
}
