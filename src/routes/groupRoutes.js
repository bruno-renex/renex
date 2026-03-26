import { json, readJson, param } from '../utils.js';
import { requireSession, rateLimit, pushToGroupMembers } from '../auth.js';

// ======================================================
// GROUP ROUTES
// POST /groups/create   — Gruppe erstellen
// POST /groups/invite   — Mitglied einladen
// POST /groups/leave    — Gruppe verlassen
// GET  /groups/list     — Meine Gruppen
// GET  /groups/members  — Mitglieder einer Gruppe
// ======================================================

const MAX_GROUP_NAME   = 64;
const MAX_MEMBERS      = 50;   // Phase 1: max 50 Member, skalierbar via GroupChatDO

// UUID-Check (verhindert Handle-Injection als groupId)
const GROUP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidGroupId(id) { return GROUP_ID_RE.test(String(id)); }

export async function handleGroupRoutes(request, env, path, params) {

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

      // System-Message persistieren (vor delete-check, weil bei letztem Member alles gelöscht wird)
      const leaveTs = Date.now();
      await env.RENEX_DB.prepare(
        `INSERT INTO messages (id, convo_id, from_user, to_user, ts, type, message, e2e)
         VALUES (?, ?, ?, NULL, ?, 'system', ?, 0)`
      ).bind(crypto.randomUUID(), groupId, me, leaveTs,
        `${me} hat die Gruppe verlassen`).run();

      // Verbleibende Members benachrichtigen
      const leaveEvent = {
        id:   crypto.randomUUID(),
        type: "group_member_left",
        groupId,
        handle: me,
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
               (SELECT COUNT(*) FROM conversation_members WHERE convo_id = c.id) as member_count
        FROM conversations c
        JOIN conversation_members cm ON c.id = cm.convo_id
        WHERE cm.member_handle = ? AND c.type = 'group'
        ORDER BY c.created_at DESC
      `).bind(me).all();

      return json(request, { groups: rows.results || [] });
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
  }

  return json(request, { error: "Not found" }, 404);
}
