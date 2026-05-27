import { json, readJson, param, dmConvoId, isUUID } from '../utils.js';
import { requireSession, requireAnySession, rateLimit, pushToUserDO, pushToGroupMembers, isConvoMember } from '../auth.js';
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

        // Gäste dürfen ihre zugewiesene Konversation lesen (requireAnySession)
        const session = await requireAnySession(request, env);
        if (!session) {
          return json(request, { error: "Not authenticated" }, 401);
        }

        const me         = String(session.handle || "").toLowerCase();
        const isGuest    = session.isGuest === true;

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
        if (cursor !== null && (isNaN(cursor) || cursor < 0 || cursor > Date.now())) {
          return json(request, { error: "Invalid cursor" }, 400);
        }

        if (!otherRaw) {
          return json(request, { error: "Missing 'with' parameter" }, 400);
        }

        const other = String(otherRaw).toLowerCase();
        // Gruppe = UUID direkt verwenden; DM = sorted "alice:bob"
        const isGroupConvo = isUUID(other);
        const cid = isGroupConvo ? other : dmConvoId(me, other);

        // Gäste: dürfen NUR ihre zugewiesene Konversation lesen
        if (isGuest && !session.convoId) {
          return json(request, { error: "Not authenticated" }, 401);
        }
        if (isGuest && cid !== session.convoId) {
          return json(request, { error: "Not authorized for this conversation" }, 403);
        }

        // Gäste: Session-Ablauf sofort prüfen (verhindert unbegrenztes Mitlesen)
        if (isGuest) {
          const guestRow = await env.RENEX_DB.prepare(
            "SELECT expires_at, converted_to FROM guest_sessions WHERE token = ?"
          ).bind(session.token).first();
          if (!guestRow || guestRow.converted_to || Date.now() > guestRow.expires_at) {
            return json(request, { error: "Session expired" }, 410);
          }
        }

        // Gruppen/Channels: Mitgliedschaft prüfen (verhindert Lesen fremder Konversationen).
        // PLUS joined_at-Filter holen — neue Member (insb. Gäste via Invite-Link)
        // sollen nur Messages AB ihrem Beitritt sehen, sonst kriegen sie 🔐-Bubbles
        // für alte E2E-Messages die sie GSK-mässig nicht decrypten können.
        // Mit-Effekt: rejoiner sehen nicht ihre frühere History (Forward Secrecy).
        let joinedAt = 0;
        if (isGroupConvo) {
          // Type-aware: Channel-Members leben in server_members, klassische
          // Group-Members in conversation_members.
          const convoInfo = await env.RENEX_DB.prepare(
            "SELECT type, server_id FROM conversations WHERE id = ?"
          ).bind(cid).first();
          if (convoInfo?.type === 'channel' && convoInfo.server_id) {
            const sm = await env.RENEX_DB.prepare(
              "SELECT joined_at FROM server_members WHERE server_id = ? AND user_handle = ? LIMIT 1"
            ).bind(convoInfo.server_id, me).first();
            if (!sm) return json(request, { error: "Not a member of this server" }, 403);
            joinedAt = Number(sm.joined_at) || 0;
          } else {
            const memberRow = await env.RENEX_DB.prepare(
              "SELECT joined_at FROM conversation_members WHERE convo_id = ? AND member_handle = ? LIMIT 1"
            ).bind(cid, me).first();
            if (!memberRow) return json(request, { error: "Not a member of this group" }, 403);
            joinedAt = Number(memberRow.joined_at) || 0;
          }
        }

        let sliced = [];

        // Group: zusätzlich ts >= joinedAt filtern. DM: kein Filter (DMs haben
        // implizite Mitgliedschaft über convo_id und beide Seiten sehen alles).
        const rows = cursor !== null
          ? (isGroupConvo
              ? await env.RENEX_DB.prepare(
                  `SELECT * FROM messages WHERE convo_id = ? AND ts < ? AND ts >= ? ORDER BY ts DESC LIMIT ?`
                ).bind(cid, cursor, joinedAt, limit).all()
              : await env.RENEX_DB.prepare(
                  `SELECT * FROM messages WHERE convo_id = ? AND ts < ? ORDER BY ts DESC LIMIT ?`
                ).bind(cid, cursor, limit).all())
          : (isGroupConvo
              ? await env.RENEX_DB.prepare(
                  `SELECT * FROM messages WHERE convo_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?`
                ).bind(cid, joinedAt, limit).all()
              : await env.RENEX_DB.prepare(
                  `SELECT * FROM messages WHERE convo_id = ? ORDER BY ts DESC LIMIT ?`
                ).bind(cid, limit).all());

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
        // UNREAD COUNTER RESET (atomar via D1)
        // ======================================================
        await env.RENEX_DB.prepare(
          "DELETE FROM unread_counters WHERE owner = ? AND sender = ?"
        ).bind(me, other).run();

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
        // Gäste haben Unread-Counter pro DM (z.B. wenn Inviter offline → Guest sammelt unread)
        const session = await requireAnySession(request, env);
        if (!session) {
          return json(request, { error: "Not authenticated" }, 401);
        }

        const me = String(session.handle || "").toLowerCase();

        // Rate-Limit: 60 req/min — schützt gegen Polling-Stürme.
        // Client pollt alle 30s → 2 req/min normal. 60 erlaubt Multi-Tab + Bursts.
        const rl = await rateLimit(env, `chat_unread:${me}`, 60_000, 60);
        if (!rl) return json(request, { error: "Too many requests" }, 429);

        const rows = await env.RENEX_DB.prepare(
          "SELECT sender, count FROM unread_counters WHERE owner = ?"
        ).bind(me).all();

        const map = {};
        for (const row of (rows.results || [])) {
          map[row.sender] = row.count;
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

        const session = await requireAnySession(request, env);
        if (!session) {
          return json(request, { error: "Not authenticated" }, 401);
        }

        const me = String(session.handle || "").toLowerCase();

        // Rate-Limit: 120 req/min — Delivery-ACKs werden pro neuer Nachricht
        // gesendet, daher höher als unread.
        const rl = await rateLimit(env, `chat_delivered:${me}`, 60_000, 120);
        if (!rl) return json(request, { error: "Too many requests" }, 429);

        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);

        const other = String(body.with || "").toLowerCase();
        if (!other) {
          return json(request, { error: "Missing with" }, 400);
        }

        // Gruppen-Konversationen: kein Delivered-Tracking (Option D)
        // Status bleibt 'sent' = Server-Bestätigung ✓
        // UUID-Format erkennt Gruppen (DMs: "alice:bob")
        const isGroup = isUUID(other);
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
        // Gäste dürfen eigene Nachrichten löschen (requireAnySession statt requireSession)
        const session = await requireAnySession(request, env);
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

        // Peer(s) via DO benachrichtigen
        const isGroup = isUUID(row.convo_id);
        const deleteEvent = {
          id: crypto.randomUUID(),
          type: "message_deleted",
          messageId: msgId,
          convoId: row.convo_id,
          groupId: isGroup ? row.convo_id : null,
          from: me,
          ts: Date.now()
        };
        if (isGroup) {
          await pushToGroupMembers(env, env.RENEX_DB, row.convo_id, me, deleteEvent);
        } else {
          const peer = row.to_user === me ? row.from_user : row.to_user;
          await pushToUserDO(env, peer, { ...deleteEvent, to: peer });
        }
        // Multi-Device-Self-Sync: eigene andere Devices ebenfalls benachrichtigen
        // (DM + Group). Tab/Device, der die Aktion ausgelöst hat, filtert sich
        // im Frontend via msg.deviceId selbst raus. Fire-and-forget.
        pushToUserDO(env, me, deleteEvent).catch(() => {});

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
      // Gäste dürfen eigene Nachrichten bearbeiten (requireAnySession statt requireSession)
      const session = await requireAnySession(request, env);
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
      const isGroup = isUUID(row.convo_id);
      const editEvent = {
        id: crypto.randomUUID(),
        type: "message_edited",
        messageId: msgId,
        ciphertext: cipher,
        rotationIndex: rotIdx,
        // convoId immer mitgeben damit Empfänger sicher routen kann (DM vs Group),
        // auch wenn die _raw-Row beim Empfänger noch keine groupId hat (Reload-Pfad).
        convoId: row.convo_id,
        groupId: isGroup ? row.convo_id : null,
        from: me,
        ts: now
      };
      if (isGroup) {
        await pushToGroupMembers(env, env.RENEX_DB, row.convo_id, me, editEvent);
      } else {
        const peer = row.to_user === me ? row.from_user : row.to_user;
        await pushToUserDO(env, peer, { ...editEvent, to: peer });
      }
      // Multi-Device-Self-Sync: eigene andere Devices kriegen Edit-Event auch.
      pushToUserDO(env, me, editEvent).catch(() => {});

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

      const url  = new URL(request.url);
      const me   = String(session.handle || "").toLowerCase();

      const rl = await rateLimit(env, `rotation_idx:${me}`, 60_000, 30);
      if (!rl) return json(request, { error: "Too many requests" }, 429);

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
      // Gäste dürfen in ihrer zugewiesenen Konvo reagieren (requireAnySession statt requireSession)
      const session = await requireAnySession(request, env);
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
      const isGroup = isUUID(msg.convo_id);
      let groupName = null;
      if (isGroup) {
        // Type-aware: works for both 'group' and 'channel'
        const allowed = await isConvoMember(env.RENEX_DB, msg.convo_id, me);
        if (!allowed) return json(request, { error: "Forbidden" }, 403);
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
      // Multi-Device-Self-Sync: eigene andere Devices spiegeln die Reaktion.
      pushToUserDO(env, me, reactionEvent).catch(() => {});
      // Sender selbst (eigener Tab) bekommt auch das Event zurück
      return json(request, { ok: true, action, reactions });
    }

    default:
      break;
  }

  return json(request, { error: "Not found" }, 404);
}
