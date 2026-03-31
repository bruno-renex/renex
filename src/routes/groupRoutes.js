import { json, readJson, param, checkCsrf } from '../utils.js';
import { requireSession, rateLimit, pushToGroupMembers } from '../auth.js';

// ======================================================
// GROUP ROUTES
// POST /groups/create        — Gruppe erstellen
// POST /groups/invite        — Mitglied einladen
// POST /groups/leave         — Gruppe verlassen
// POST /groups/rename        — Admin: Gruppe umbenennen
// GET  /groups/list          — Meine Gruppen
// GET  /groups/members       — Mitglieder einer Gruppe
// GET  /groups/auto-delete   — Aktuelles Auto-Delete Setting
// POST /groups/auto-delete   — Admin: Auto-Delete setzen/deaktivieren
// ======================================================

const MAX_GROUP_NAME   = 64;
const MAX_MEMBERS      = 50;   // Phase 1: max 50 Member, skalierbar via GroupChatDO

// UUID-Check (verhindert Handle-Injection als groupId)
const GROUP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidGroupId(id) { return GROUP_ID_RE.test(String(id)); }

export async function handleGroupRoutes(request, env, path, params) {

  const csrfErr = checkCsrf(request);
  if (csrfErr) return csrfErr;

  const session = await requireSession(request, env);
  if (!session) return json(request, { error: "Not authenticated" }, 401);

  const me = String(session.handle || "").toLowerCase();

  switch (path) {

    // ──────────────────────────────────────────────────
    // POST /groups/create
    // Body: { name: string }
    // ──────────────────────────────────────────────────
    case "/groups/create": {
      if (request.method !== "POST") break;

      const rl = await rateLimit(env, `groups_create:${me}`, 60_000, 5);
      if (!rl) return json(request, { error: "Too many requests" }, 429);

      const body = await readJson(request);
      if (!body) return json(request, { error: "Invalid JSON" }, 400);

      const name = String(body.name || "").trim();
      if (!name || name.length > MAX_GROUP_NAME) {
        return json(request, { error: "Invalid group name (1–64 chars)" }, 400);
      }

      const groupId = crypto.randomUUID();
      const now     = Date.now();

      // Konversation anlegen
      await env.RENEX_DB.prepare(
        `INSERT INTO conversations (id, type, name, created_at, created_by)
         VALUES (?, 'group', ?, ?, ?)`
      ).bind(groupId, name, now, me).run();

      // Ersteller als Admin eintragen
      await env.RENEX_DB.prepare(
        `INSERT INTO conversation_members (convo_id, member_handle, role, joined_at)
         VALUES (?, ?, 'admin', ?)`
      ).bind(groupId, me, now).run();

      return json(request, { ok: true, groupId, name });
    }

    // ──────────────────────────────────────────────────
    // POST /groups/invite
    // Body: { groupId, handle }
    // ──────────────────────────────────────────────────
    case "/groups/invite": {
      if (request.method !== "POST") break;

      const body = await readJson(request);
      if (!body) return json(request, { error: "Invalid JSON" }, 400);

      const { groupId, handle } = body;
      if (!isValidGroupId(groupId)) return json(request, { error: "Invalid groupId" }, 400);

      const invitee = String(handle || "").toLowerCase();
      if (!/^[a-z0-9_]+$/.test(invitee)) return json(request, { error: "Invalid handle" }, 400);

      // Rate-Limit: max 20 Einladungen pro User pro Minute
      const rl = await rateLimit(env, `groups_invite:${me}`, 60_000, 20);
      if (!rl) return json(request, { error: "Too many invitations, please wait" }, 429);

      // Nur Admin oder Member darf einladen
      const myMembership = await env.RENEX_DB.prepare(
        "SELECT role FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
      ).bind(groupId, me).first();
      if (!myMembership) return json(request, { error: "Not a member" }, 403);

      // Mitglieder-Limit prüfen
      const countRow = await env.RENEX_DB.prepare(
        "SELECT COUNT(*) as c FROM conversation_members WHERE convo_id = ?"
      ).bind(groupId).first();
      if ((countRow?.c ?? 0) >= MAX_MEMBERS) {
        return json(request, { error: `Group full (max ${MAX_MEMBERS})` }, 400);
      }

      // Handle existiert? (Users in KV: webauthn:{handle})
      const userExists = await env.RENEX_KV.get(`webauthn:${invitee}`);
      if (!userExists) return json(request, { error: "User not found" }, 404);

      // Nur Kontakte können eingeladen werden (status = accepted)
      const areFriends = await env.RENEX_DB.prepare(
        "SELECT 1 FROM contacts WHERE user_handle = ? AND contact_handle = ? AND status = 'accepted'"
      ).bind(me, invitee).first();
      if (!areFriends) return json(request, { error: "Not in your contacts" }, 403);

      // Bereits Mitglied?
      const existing = await env.RENEX_DB.prepare(
        "SELECT 1 FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
      ).bind(groupId, invitee).first();
      if (existing) return json(request, { ok: true, alreadyMember: true });

      // Einladen
      await env.RENEX_DB.prepare(
        `INSERT INTO conversation_members (convo_id, member_handle, role, joined_at)
         VALUES (?, ?, 'member', ?)`
      ).bind(groupId, invitee, Date.now()).run();

      // System-Message persistieren
      const joinTs = Date.now();
      await env.RENEX_DB.prepare(
        `INSERT INTO messages (id, convo_id, from_user, to_user, ts, type, message, e2e)
         VALUES (?, ?, ?, NULL, ?, 'system', ?, 0)`
      ).bind(crypto.randomUUID(), groupId, invitee, joinTs,
        `${invitee} wurde von ${me} eingeladen`).run();

      // Live-Benachrichtigung an alle Mitglieder (inkl. neuem Member)
      const joinEvent = {
        id:   crypto.randomUUID(),
        type: "group_member_joined",
        groupId,
        handle: invitee,
        invitedBy: me,
        ts: joinTs
      };
      await pushToGroupMembers(env, env.RENEX_DB, groupId, null, joinEvent);

      return json(request, { ok: true, groupId, invited: invitee });
    }

    // ──────────────────────────────────────────────────
    // POST /groups/rename
    // Body: { groupId, name }
    // ──────────────────────────────────────────────────
    case "/groups/rename": {
      if (request.method !== "POST") break;

      const body = await readJson(request);
      if (!body) return json(request, { error: "Invalid JSON" }, 400);

      const { groupId, name } = body;
      if (!isValidGroupId(groupId)) return json(request, { error: "Invalid groupId" }, 400);

      const newName = String(name || "").trim();
      if (!newName || newName.length > MAX_GROUP_NAME) {
        return json(request, { error: `Invalid name (1–${MAX_GROUP_NAME} chars)` }, 400);
      }

      // Nur Admin darf umbenennen
      const membership = await env.RENEX_DB.prepare(
        "SELECT role FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
      ).bind(groupId, me).first();
      if (!membership) return json(request, { error: "Not a member" }, 403);
      if (membership.role !== "admin") return json(request, { error: "Admin only" }, 403);

      // Alten Namen holen für System-Message
      const convo = await env.RENEX_DB.prepare(
        "SELECT name FROM conversations WHERE id = ?"
      ).bind(groupId).first();
      const oldName = convo?.name || groupId;

      // Umbenennen
      await env.RENEX_DB.prepare(
        "UPDATE conversations SET name = ? WHERE id = ?"
      ).bind(newName, groupId).run();

      // System-Message an alle
      const ts = Date.now();
      await env.RENEX_DB.prepare(
        `INSERT INTO messages (id, convo_id, from_user, to_user, ts, type, message, e2e)
         VALUES (?, ?, ?, NULL, ?, 'system', ?, 0)`
      ).bind(crypto.randomUUID(), groupId, "__system__", ts,
        `${me} hat die Gruppe in "${newName}" umbenannt`).run();

      // Live-Push an alle Mitglieder
      await pushToGroupMembers(env, env.RENEX_DB, groupId, null, {
        id: crypto.randomUUID(),
        type: "group_renamed",
        groupId,
        newName,
        renamedBy: me,
        ts
      });

      return json(request, { ok: true, groupId, name: newName });
    }

    // ──────────────────────────────────────────────────
    // POST /groups/leave
    // Body: { groupId }
    // ──────────────────────────────────────────────────
    case "/groups/leave": {
      if (request.method !== "POST") break;

      const body = await readJson(request);
      if (!body) return json(request, { error: "Invalid JSON" }, 400);

      const { groupId } = body;
      if (!isValidGroupId(groupId)) return json(request, { error: "Invalid groupId" }, 400);

      const membership = await env.RENEX_DB.prepare(
        "SELECT role FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
      ).bind(groupId, me).first();
      if (!membership) return json(request, { error: "Not a member" }, 403);

      await env.RENEX_DB.prepare(
        "DELETE FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
      ).bind(groupId, me).run();

      // ── Admin-Nachfolge (Option D) ──────────────────────────────────────────
      // War der Verlassende Admin und gibt es keine weiteren Admins mehr?
      let newAdminHandle = null;
      if (membership.role === "admin") {
        const otherAdmin = await env.RENEX_DB.prepare(
          "SELECT member_handle FROM conversation_members WHERE convo_id = ? AND role = 'admin' LIMIT 1"
        ).bind(groupId).first();

        if (!otherAdmin) {
          // Ältestes verbleibendes Mitglied (kleinster joined_at) wird Admin
          const successor = await env.RENEX_DB.prepare(
            "SELECT member_handle FROM conversation_members WHERE convo_id = ? ORDER BY joined_at ASC LIMIT 1"
          ).bind(groupId).first();

          if (successor) {
            newAdminHandle = successor.member_handle;
            await env.RENEX_DB.prepare(
              "UPDATE conversation_members SET role = 'admin' WHERE convo_id = ? AND member_handle = ?"
            ).bind(groupId, newAdminHandle).run();
          }
        }
      }
      // ───────────────────────────────────────────────────────────────────────

      // System-Message persistieren (vor delete-check, weil bei letztem Member alles gelöscht wird)
      const leaveTs = Date.now();
      await env.RENEX_DB.prepare(
        `INSERT INTO messages (id, convo_id, from_user, to_user, ts, type, message, e2e)
         VALUES (?, ?, ?, NULL, ?, 'system', ?, 0)`
      ).bind(crypto.randomUUID(), groupId, me, leaveTs,
        `${me} hat die Gruppe verlassen`).run();

      // Admin-Wechsel System-Message
      if (newAdminHandle) {
        await env.RENEX_DB.prepare(
          `INSERT INTO messages (id, convo_id, from_user, to_user, ts, type, message, e2e)
           VALUES (?, ?, ?, NULL, ?, 'system', ?, 0)`
        ).bind(crypto.randomUUID(), groupId, me, leaveTs + 1,
          `${newAdminHandle} ist jetzt Admin`).run();
      }

      // Verbleibende Members benachrichtigen
      const leaveEvent = {
        id:   crypto.randomUUID(),
        type: "group_member_left",
        groupId,
        handle: me,
        newAdmin: newAdminHandle ?? undefined,
        ts: leaveTs
      };
      await pushToGroupMembers(env, env.RENEX_DB, groupId, null, leaveEvent);

      // Wenn letzter Member: Gruppe löschen
      const remaining = await env.RENEX_DB.prepare(
        "SELECT COUNT(*) as c FROM conversation_members WHERE convo_id = ?"
      ).bind(groupId).first();
      if ((remaining?.c ?? 0) === 0) {
        await env.RENEX_DB.prepare("DELETE FROM conversations WHERE id = ?").bind(groupId).run();
        await env.RENEX_DB.prepare("DELETE FROM messages WHERE convo_id = ?").bind(groupId).run();
      }

      return json(request, { ok: true });
    }

    // ──────────────────────────────────────────────────
    // GET /groups/list
    // Gibt alle Gruppen zurück in denen ich Member bin
    // ──────────────────────────────────────────────────
    case "/groups/list": {
      if (request.method !== "GET") break;

      const rows = await env.RENEX_DB.prepare(`
        SELECT c.id, c.name, c.created_at, cm.role,
               COUNT(DISTINCT cm2.member_handle) AS member_count,
               lm_agg.last_ts,
               lm.from_user  AS last_from,
               lm.type       AS last_type,
               lm.message    AS last_text,
               COALESCE(cm.last_read_ts, 0) AS last_read_ts,
               (
                 SELECT COUNT(*)
                 FROM messages m2
                 WHERE m2.convo_id = c.id
                   AND m2.ts > COALESCE(cm.last_read_ts, 0)
                   AND m2.from_user != ?
               ) AS unread_count
        FROM conversations c
        JOIN conversation_members cm  ON c.id = cm.convo_id AND cm.member_handle = ?
        JOIN conversation_members cm2 ON c.id = cm2.convo_id
        LEFT JOIN (
          SELECT convo_id, MAX(ts) AS last_ts
          FROM messages
          GROUP BY convo_id
        ) lm_agg ON lm_agg.convo_id = c.id
        LEFT JOIN messages lm
               ON lm.convo_id = lm_agg.convo_id AND lm.ts = lm_agg.last_ts
        WHERE c.type = 'group'
        GROUP BY c.id, c.name, c.created_at, cm.role,
                 lm_agg.last_ts, lm.from_user, lm.type, lm.message, cm.last_read_ts
        ORDER BY COALESCE(lm_agg.last_ts, c.created_at) DESC
      `).bind(me, me).all();

      return json(request, { groups: rows.results || [] });
    }

    // ──────────────────────────────────────────────────
    // POST /groups/mark-read  { groupId, lastReadTs }
    // Setzt last_read_ts für den aktuellen User in dieser Gruppe
    // ──────────────────────────────────────────────────
    case "/groups/mark-read": {
      if (request.method !== "POST") break;
      const { groupId, lastReadTs } = await request.json();
      if (!groupId || !lastReadTs) return json(request, { error: "Missing fields" }, 400);
      // Sicherstellen dass User Mitglied ist
      const member = await env.RENEX_DB.prepare(
        "SELECT 1 FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
      ).bind(groupId, me).first();
      if (!member) return json(request, { error: "Not a member" }, 403);
      await env.RENEX_DB.prepare(
        "UPDATE conversation_members SET last_read_ts = ? WHERE convo_id = ? AND member_handle = ?"
      ).bind(Number(lastReadTs), groupId, me).run();
      return json(request, { ok: true });
    }

    // ──────────────────────────────────────────────────
    // GET /groups/members?groupId=...
    // ──────────────────────────────────────────────────
    case "/groups/members": {
      if (request.method !== "GET") break;

      const groupId = param(params, "groupId");
      if (!isValidGroupId(groupId)) return json(request, { error: "Invalid groupId" }, 400);

      // Nur Mitglieder dürfen die Liste sehen
      const membership = await env.RENEX_DB.prepare(
        "SELECT 1 FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
      ).bind(groupId, me).first();
      if (!membership) return json(request, { error: "Not a member" }, 403);

      const rows = await env.RENEX_DB.prepare(
        "SELECT member_handle, role, joined_at FROM conversation_members WHERE convo_id = ? ORDER BY joined_at ASC"
      ).bind(groupId).all();

      const groupInfo = await env.RENEX_DB.prepare(
        "SELECT id, name, created_at, created_by FROM conversations WHERE id = ?"
      ).bind(groupId).first();

      return json(request, {
        group:   groupInfo,
        members: rows.results || []
      });
    }

    // ──────────────────────────────────────────────────
    // GET /groups/auto-delete?groupId=...
    // POST /groups/auto-delete  { groupId, days }  — Admin only
    // ──────────────────────────────────────────────────
    case "/groups/auto-delete": {
      const url2 = new URL(request.url);

      if (request.method === "GET") {
        const groupId = url2.searchParams.get("groupId");
        if (!isValidGroupId(groupId)) return json(request, { error: "Invalid groupId" }, 400);

        const membership = await env.RENEX_DB.prepare(
          "SELECT role FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
        ).bind(groupId, me).first();
        if (!membership) return json(request, { error: "Not a member" }, 403);

        const row = await env.RENEX_DB.prepare(
          "SELECT days, status FROM auto_delete_settings WHERE convo_id = ?"
        ).bind(groupId).first();

        return json(request, {
          ...(row ?? { status: "off" }),
          myRole: membership.role
        });
      }

      if (request.method === "POST") {
        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);
        const { groupId, days } = body;
        if (!isValidGroupId(groupId)) return json(request, { error: "Invalid groupId" }, 400);

        // Admin-Check
        const membership = await env.RENEX_DB.prepare(
          "SELECT role FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
        ).bind(groupId, me).first();
        if (!membership) return json(request, { error: "Not a member" }, 403);
        if (membership.role !== "admin") return json(request, { error: "Only the group admin can change auto-delete" }, 403);

        const ALLOWED_DAYS = new Set([1, 7, 28, 90]);
        const now = Date.now();

        const autoDeleteLabel = (d) => {
          if (d === 1)  return "1 Tag";
          if (d === 7)  return "7 Tage";
          if (d === 28) return "28 Tage";
          if (d === 90) return "90 Tage";
          return `${d} Tage`;
        };

        if (!days) {
          // Deaktivieren
          await env.RENEX_DB.prepare(
            "DELETE FROM auto_delete_settings WHERE convo_id = ?"
          ).bind(groupId).run();
          // System-Message
          await env.RENEX_DB.prepare(
            `INSERT INTO messages (id, convo_id, from_user, to_user, ts, type, message, e2e)
             VALUES (?, ?, ?, NULL, ?, 'system', ?, 0)`
          ).bind(crypto.randomUUID(), groupId, "__system__", now,
            `${me} hat Auto-Delete deaktiviert`).run();
          const ctrl = { id: crypto.randomUUID(), type: "auto_delete_set", action: "cancel", groupId, ts: now };
          await pushToGroupMembers(env, env.RENEX_DB, groupId, me, ctrl);
          return json(request, { ok: true, status: "off" });
        }

        if (!ALLOWED_DAYS.has(Number(days))) return json(request, { error: "Invalid days" }, 400);

        await env.RENEX_DB.prepare(
          `INSERT INTO auto_delete_settings (convo_id, days, proposed_by, status, updated_at)
           VALUES (?, ?, ?, 'active', ?)
           ON CONFLICT(convo_id) DO UPDATE SET days = excluded.days, proposed_by = excluded.proposed_by, status = 'active', updated_at = excluded.updated_at`
        ).bind(groupId, Number(days), me, now).run();
        // System-Message
        await env.RENEX_DB.prepare(
          `INSERT INTO messages (id, convo_id, from_user, to_user, ts, type, message, e2e)
           VALUES (?, ?, ?, NULL, ?, 'system', ?, 0)`
        ).bind(crypto.randomUUID(), groupId, "__system__", now,
          `${me} hat Auto-Delete auf ${autoDeleteLabel(Number(days))} gesetzt`).run();

        const ctrl = { id: crypto.randomUUID(), type: "auto_delete_set", action: "accept", days: Number(days), groupId, ts: now };
        await pushToGroupMembers(env, env.RENEX_DB, groupId, me, ctrl);
        return json(request, { ok: true, status: "active", days: Number(days) });
      }

      break;
    }
  }

  return json(request, { error: "Not found" }, 404);
}
