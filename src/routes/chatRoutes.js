import { json, readJson, param, dmConvoId } from '../utils.js';
import { requireSession, rateLimit, pushToUserDO, pushToGroupMembers } from '../auth.js';
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
        // Gruppe = UUID direkt verwenden; DM = sorted "alice:bob"
        const isGroupConvo = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(other);
        const cid = isGroupConvo ? other : dmConvoId(me, other);

        // Gruppen: Mitgliedschaft prüfen (verhindert Lesen fremder Gruppen)
        if (isGroupConvo) {
          const isMember = await env.RENEX_DB.prepare(
            "SELECT 1 FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
          ).bind(cid, me).first();
          if (!isMember) return json(request, { error: "Not a member of this group" }, 403);
        }

        let sliced = [];

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
          if (r.rotation_index != null) m.rotationIndex = r.rotation_index;
          if (r.sig)       m.sig      = r.sig;
          if (r.device_id) m.deviceId = r.device_id;
          // Reply-Felder (E2E-verschlüsselt — nur Ciphertext)
          if (r.reply_to_id)          m.replyToId          = r.reply_to_id;
          if (r.reply_from)           m.replyFrom          = r.reply_from;
          if (r.reply_iv)             m.replyIv            = r.reply_iv;
          if (r.reply_ct)             m.replyCt            = r.reply_ct;
          if (r.reply_rotation_index != null) m.replyRotationIndex = r.reply_rotation_index;
          // Bearbeitete Nachrichten
          if (r.edited_message)       m.edited_message     = r.edited_message;
          if (r.edited_at != null)    m.edited_at          = r.edited_at;
          // Attachment
          if (r.attachment_key)       m.attachmentKey      = r.attachment_key;
          if (r.attachment_type)      m.attachmentType     = r.attachment_type;
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

        // Reaktionen für diese Nachrichten laden
        const msgIds = sliced.map(m => m.id).filter(Boolean);
        let reactions = {};
        if (msgIds.length > 0) {
          const placeholders = msgIds.map(() => "?").join(",");
          const rxRows = await env.RENEX_DB.prepare(
            `SELECT message_id, emoji, user_handle FROM message_reactions WHERE message_id IN (${placeholders})`
          ).bind(...msgIds).all();
          for (const r of (rxRows.results || [])) {
            if (!reactions[r.message_id]) reactions[r.message_id] = {};
            if (!reactions[r.message_id][r.emoji]) reactions[r.message_id][r.emoji] = [];
            reactions[r.message_id][r.emoji].push(r.user_handle);
          }
        }

        return json(request, {
          with: other,
          messages: sliced,
          nextCursor,
          reactions
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

        // Gruppen-Konversationen: kein Delivered-Tracking (Option D)
        // Status bleibt 'sent' = Server-Bestätigung ✓
        // UUID-Format erkennt Gruppen (DMs: "alice:bob")
        const isGroup = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(other);
        if (isGroup) {
          return json(request, { ok: true, updated: 0, skipped: "group" });
        }

        const cid = dmConvoId(me, other);

        // D1 UPDATE — mark incoming DM messages as delivered
        // to_user IS NOT NULL Guard verhindert versehentliches Update von Gruppen-Messages
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
          "SELECT id, from_user, to_user, convo_id, attachment_key, attachment_type FROM messages WHERE id = ?"
        ).bind(msgId).first();

        if (!row) return json(request, { error: "Message not found" }, 404);
        if (row.from_user !== me) return json(request, { error: "Forbidden" }, 403);

        // R2-Objekt löschen (wenn vorhanden und kein GIF — GIFs haben keinen R2-Key)
        if (row.attachment_key && row.attachment_type !== "gif" && env.RENEX_FILES) {
          await env.RENEX_FILES.delete(row.attachment_key).catch(() => {});
        }

        // Aus D1 löschen
        await env.RENEX_DB.prepare("DELETE FROM messages WHERE id = ?").bind(msgId).run();

        // Peer via DO benachrichtigen
        const isGroup = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.convo_id);
        const deleteEvent = {
          id: crypto.randomUUID(),
          type: "message_deleted",
          messageId: msgId,
          from: me,
          ts: Date.now()
        };
        if (isGroup) {
          // Gruppen: alle Mitglieder benachrichtigen (exkl. Sender)
          await pushToGroupMembers(env, env.RENEX_DB, row.convo_id, me, deleteEvent);
        } else {
          // DM: nur den Peer benachrichtigen
          const peer = row.to_user === me ? row.from_user : row.to_user;
          await pushToUserDO(env, peer, { ...deleteEvent, to: peer });
        }

        return json(request, { ok: true });
      }
      break;
    }

    // ──────────────────────────────────────────────────
    // POST /chat/message/edit  { id, ciphertext }
    // Editiert eine eigene Nachricht (max. 15 Minuten nach Senden)
    // ──────────────────────────────────────────────────
    case "/chat/message/edit": {
      if (request.method !== "POST") break;
      const session = await requireSession(request, env);
      if (!session) return json(request, { error: "Not authenticated" }, 401);

      const me = String(session.handle || "").toLowerCase();
      const body = await readJson(request);
      if (!body) return json(request, { error: "Invalid JSON" }, 400);

      const msgId     = String(body.id || "").trim();
      const cipher    = String(body.ciphertext || "").trim();
      const rotIdx    = body.rotationIndex ?? null;
      if (!msgId || !cipher) return json(request, { error: "Missing id or ciphertext" }, 400);

      // Nachricht laden
      const row = await env.RENEX_DB.prepare(
        "SELECT id, from_user, to_user, convo_id, ts FROM messages WHERE id = ?"
      ).bind(msgId).first();
      if (!row) return json(request, { error: "Message not found" }, 404);
      if (row.from_user !== me) return json(request, { error: "Forbidden" }, 403);

      // Zeitlimit: max. 15 Minuten
      const EDIT_WINDOW_MS = 15 * 60 * 1000;
      if (Date.now() - Number(row.ts) > EDIT_WINDOW_MS) {
        return json(request, { error: "Edit window expired (15 min)" }, 403);
      }

      const now = Date.now();
      // rotationIndex in edited_message einbetten → korrekte Entschlüsselung beim Laden
      let editedMessageJson = cipher;
      if (rotIdx !== null) {
        try {
          const parsed = JSON.parse(cipher);
          editedMessageJson = JSON.stringify({ ...parsed, rotationIndex: rotIdx });
        } catch {}
      }
      await env.RENEX_DB.prepare(
        "UPDATE messages SET edited_message = ?, edited_at = ? WHERE id = ?"
      ).bind(editedMessageJson, now, msgId).run();

      // Peer(s) benachrichtigen
      const isGroup = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.convo_id);
      const editEvent = {
        id: crypto.randomUUID(),
        type: "message_edited",
        messageId: msgId,
        ciphertext: cipher,
        rotationIndex: rotIdx,
        from: me,
        ts: now
      };
      if (isGroup) {
        await pushToGroupMembers(env, env.RENEX_DB, row.convo_id, me, editEvent);
      } else {
        const peer = row.to_user === me ? row.from_user : row.to_user;
        await pushToUserDO(env, peer, { ...editEvent, to: peer });
      }

      return json(request, { ok: true, editedAt: now });
    }

    // ──────────────────────────────────────────────────
    // GET /chat/rotation-index?peer=X
    // Recovery nach IDB-Reset: letzten bekannten rotation_index zurückgeben
    // ──────────────────────────────────────────────────
    case "/chat/rotation-index": {
      if (request.method !== "GET") break;
      const session = await requireSession(request, env);
      if (!session) return json(request, { error: "Not authenticated" }, 401);

      const me   = String(session.handle || "").toLowerCase();
      const peer = String(url.searchParams.get("peer") || "").toLowerCase();
      if (!peer) return json(request, { error: "Missing peer" }, 400);

      // Höchsten rotation_index aus eigenen gesendeten Nachrichten an diesen Peer
      const row = await env.RENEX_DB.prepare(`
        SELECT MAX(rotation_index) as max_idx
        FROM messages
        WHERE from_user = ?
          AND (to_user = ? OR convo_id = (
            SELECT id FROM conversations
            WHERE type = 'dm'
              AND id IN (
                SELECT convo_id FROM conversation_members WHERE member_handle = ?
                INTERSECT
                SELECT convo_id FROM conversation_members WHERE member_handle = ?
              )
            LIMIT 1
          ))
      `).bind(me, peer, me, peer).first();

      return json(request, { rotationIndex: row?.max_idx ?? 0 });
    }

    // ──────────────────────────────────────────────────
    // POST /chat/react  { messageId, emoji }
    // Toggle Reaktion auf eine Nachricht (add/remove)
    // ──────────────────────────────────────────────────
    case "/chat/react": {
      if (request.method !== "POST") break;
      const session = await requireSession(request, env);
      if (!session) return json(request, { error: "Not authenticated" }, 401);

      const me   = String(session.handle || "").toLowerCase();
      const body = await readJson(request);
      if (!body) return json(request, { error: "Invalid JSON" }, 400);

      const ALLOWED_EMOJIS = ["💀","🔥","🗿","😭","🫡","💯","🤝"];
      const msgId = String(body.messageId || "").trim();
      const emoji = String(body.emoji || "").trim();
      if (!msgId) return json(request, { error: "Missing messageId" }, 400);
      if (!ALLOWED_EMOJIS.includes(emoji)) return json(request, { error: "Invalid emoji" }, 400);

      // Nachricht laden — Convo bestimmen
      const msg = await env.RENEX_DB.prepare(
        "SELECT id, from_user, to_user, convo_id FROM messages WHERE id = ?"
      ).bind(msgId).first();
      if (!msg) return json(request, { error: "Message not found" }, 404);

      // Mitgliedschaft prüfen (DM oder Gruppe)
      const isGroup = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(msg.convo_id);
      let groupName = null;
      if (isGroup) {
        const member = await env.RENEX_DB.prepare(
          "SELECT 1 FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
        ).bind(msg.convo_id, me).first();
        if (!member) return json(request, { error: "Forbidden" }, 403);
        const grp = await env.RENEX_DB.prepare(
          "SELECT name FROM conversations WHERE id = ?"
        ).bind(msg.convo_id).first();
        groupName = grp?.name || null;
      } else {
        if (msg.from_user !== me && msg.to_user !== me) return json(request, { error: "Forbidden" }, 403);
      }

      // Toggle: existiert Reaktion bereits?
      const existing = await env.RENEX_DB.prepare(
        "SELECT id FROM message_reactions WHERE message_id = ? AND user_handle = ? AND emoji = ?"
      ).bind(msgId, me, emoji).first();

      let action;
      if (existing) {
        await env.RENEX_DB.prepare(
          "DELETE FROM message_reactions WHERE message_id = ? AND user_handle = ? AND emoji = ?"
        ).bind(msgId, me, emoji).run();
        action = "removed";
      } else {
        await env.RENEX_DB.prepare(
          "INSERT INTO message_reactions (id, message_id, convo_id, user_handle, emoji, ts) VALUES (?,?,?,?,?,?)"
        ).bind(crypto.randomUUID(), msgId, msg.convo_id, me, emoji, Date.now()).run();
        action = "added";
      }

      // Alle Reaktionen für diese Nachricht zurückgeben
      const rows = await env.RENEX_DB.prepare(
        "SELECT emoji, user_handle FROM message_reactions WHERE message_id = ? ORDER BY ts ASC"
      ).bind(msgId).all();

      // Aggregieren: { emoji -> [handles] }
      const reactions = {};
      for (const r of (rows.results || [])) {
        if (!reactions[r.emoji]) reactions[r.emoji] = [];
        reactions[r.emoji].push(r.user_handle);
      }

      // WebSocket Push an alle Beteiligten
      const reactionEvent = {
        id: crypto.randomUUID(),
        type: "reaction_updated",
        messageId: msgId,
        emoji,
        action,
        from: me,
        msgAuthor: msg.from_user,
        convoId: msg.convo_id,
        groupName,
        reactions,
        ts: Date.now()
      };
      if (isGroup) {
        await pushToGroupMembers(env, env.RENEX_DB, msg.convo_id, me, reactionEvent);
      } else {
        const peer = msg.to_user === me ? msg.from_user : msg.to_user;
        await pushToUserDO(env, peer, { ...reactionEvent, to: peer });
      }
      // Sender selbst (eigener Tab) bekommt auch das Event zurück
      return json(request, { ok: true, action, reactions });
    }

    default:
      break;
  }

  return json(request, { error: "Not found" }, 404);
}
