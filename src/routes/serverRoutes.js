// ======================================================
// RENEX — Server Routes (Phase 3A)
// ======================================================
// Spec: docs/SERVERS.md §6 (API-Surface)
//
// Endpoints (Status-Flag pro Endpoint inline):
//   POST   /servers/create                                   ✅ implemented
//   GET    /servers/list                                     ✅ implemented
//   GET    /servers/<id>                                     ✅ implemented
//   PATCH  /servers/<id>                                     ✅ implemented (Phase 3A.5)
//   DELETE /servers/<id>                                     🚧 stub
//   POST   /servers/<id>/icon                                ✅ implemented (Phase 3A.5)
//   GET    /servers/<id>/icon                                ✅ implemented (Phase 3A.5)
//   DELETE /servers/<id>/icon                                ✅ implemented (Phase 3A.5)
//   POST   /servers/<id>/transfer                            ✅ implemented (Phase 3A.5)
//   POST   /servers/<id>/leave                               ✅ implemented (mit Owner-Pre-Check)
//   GET    /servers/<id>/members                             ✅ implemented
//   PATCH  /servers/<id>/members/me                          🚧 stub (nickname)
//   POST   /servers/<id>/members/<u>/kick                    ✅ implemented
//   POST   /servers/<id>/members/<u>/ban                     ✅ implemented (Phase 3A.5)
//   GET    /servers/<id>/bans                                ✅ implemented (Phase 3A.5)
//   DELETE /servers/<id>/bans/<u>                            ✅ implemented (Phase 3A.5)
//   POST   /servers/<id>/members/<u>/roles                   🚧 stub
//   DELETE /servers/<id>/members/<u>/roles/<rid>             🚧 stub
//   POST   /servers/<id>/channels                            ✅ implemented
//   GET    /servers/<id>/channels                            ✅ implemented (Sidebar-Source)
//   PATCH  /servers/<id>/channels/<cid>                      🚧 stub
//   DELETE /servers/<id>/channels/<cid>                      🚧 stub
//   POST   /servers/<id>/channels/<cid>/permissions          🚧 stub
//   POST   /servers/<id>/channels/<cid>/members              🚧 stub (private channels)
//   DELETE /servers/<id>/channels/<cid>/members/<u>          🚧 stub
//   POST   /servers/<id>/roles                               🚧 stub
//   PATCH  /servers/<id>/roles/<rid>                         🚧 stub
//   DELETE /servers/<id>/roles/<rid>                         🚧 stub
//   GET    /servers/<id>/audit-log                           🚧 stub
//   GET    /servers/<id>/audit-log/me                        🚧 stub
//
// Stubs returnen 501 mit `error: 'not_implemented'` + TODO-Marker. Bewusst:
// damit Frontend-Sidebar gegen den End-to-End-Pfad „create → list → details"
// schon getestet werden kann, bevor Role-Editor / Permission-UI gebaut wird.
// ======================================================

import { json, readJson, checkCsrf, corsHeaders } from '../utils.js';
import { requireSession, rateLimit, pushToUserDO } from '../auth.js';
import {
  Permissions,
  ALL_PERMISSIONS,
  resolvePermissions,
  hasPermission,
  canManageRoleAtPosition,
  sanitizeBits,
  DEFAULT_EVERYONE_PERMISSIONS,
} from '../lib/permissions.js';

// ── Constants ──────────────────────────────────────────
const MAX_SERVER_NAME       = 80;
const MAX_SERVER_DESC       = 500;
const MAX_SERVER_ICON_BYTES = 1024 * 1024;   // 1 MB
const MAX_CHANNEL_NAME      = 64;
const MAX_CHANNEL_TOPIC     = 1024;
const MAX_OWNED_SERVERS_FREE = 3;
const MAX_OWNED_SERVERS_PRO  = 25;

const ALLOWED_ICON_MIME     = new Set(['image/png', 'image/jpeg', 'image/webp']);

const VALID_VISIBILITY      = new Set(['invite', 'private']); // Phase 4+: 'public'
const VALID_CHANNEL_KINDS   = new Set(['text']);              // Phase 8: 'voice'

// ── Rate-Limits (Phase 5-Light) ───────────────────────
// Pro User pro Operation-Bucket. Window=60s. Tuning-Logik in SERVERS.md §8.
// Read-only endpoints (GET /servers/list, /servers/<id>, /audit-log) sind
// nicht rate-limited — Cloudflare-Worker hat sowieso ein globales Limit.
const RL = Object.freeze({
  serverCreate:   { window: 60_000, max:  5 },  // bestehend
  serverUpdate:   { window: 60_000, max: 30 },  // 3A.5: PATCH /servers/<id>
  serverTransfer: { window: 60_000, max:  3 },  // 3A.5: POST /servers/<id>/transfer
  serverIconSet:  { window: 60_000, max: 10 },  // 3A.5: POST /servers/<id>/icon
  channelCreate:  { window: 60_000, max: 30 },
  channelUpdate:  { window: 60_000, max: 60 },
  channelDelete:  { window: 60_000, max: 10 },
  roleCreate:     { window: 60_000, max: 20 },
  roleUpdate:     { window: 60_000, max: 60 },
  roleDelete:     { window: 60_000, max: 10 },
  memberRoleAdd:  { window: 60_000, max: 60 },  // häufig: Multi-Toggle in Members-Tab
  memberRoleDel:  { window: 60_000, max: 60 },
  memberKick:     { window: 60_000, max: 10 },
  memberBan:      { window: 60_000, max: 10 },  // 3A.5: POST /servers/<id>/members/<u>/ban
  memberUnban:    { window: 60_000, max: 10 },  // 3A.5: DELETE /servers/<id>/bans/<u>
  serverLeave:    { window: 60_000, max:  5 },
  inviteCreate:   { window: 60_000, max: 20 },
  serverJoin:     { window: 60_000, max: 10 },
});

/**
 * Helper: prüft Rate-Limit für einen Operation-Bucket.
 * Returns Response-objekt (429) bei Hit, null bei OK.
 */
async function checkRateLimit(env, bucket, me, request) {
  const cfg = RL[bucket];
  if (!cfg) return null;
  const ok = await rateLimit(env, `srv_${bucket}:${me}`, cfg.window, cfg.max);
  if (!ok) {
    return json(request, {
      error: 'rate_limit_exceeded',
      bucket,
      retryAfterMs: cfg.window,
    }, 429);
  }
  return null;
}

// ── Helpers — DB-Queries ───────────────────────────────

/**
 * Lade Server-Membership inkl. is_owner-Flag.
 * @returns {Promise<{user_handle, is_owner, nickname, joined_at} | null>}
 */
export async function getServerMembership(env, serverId, userHandle) {
  return await env.RENEX_DB.prepare(
    `SELECT user_handle, is_owner, nickname, joined_at
     FROM server_members
     WHERE server_id = ? AND user_handle = ?`
  ).bind(serverId, userHandle).first();
}

/**
 * Lade alle Roles eines Users in einem Server (für Permission-Resolution).
 * @returns {Promise<Array<{id, permissions, position}>>}
 */
async function getUserRoles(env, serverId, userHandle) {
  const r = await env.RENEX_DB.prepare(
    `SELECT sr.id, sr.permissions, sr.position
     FROM role_assignments ra
     JOIN server_roles sr ON ra.role_id = sr.id
     WHERE ra.server_id = ? AND ra.user_handle = ?`
  ).bind(serverId, userHandle).all();
  return r.results || [];
}

/**
 * Lade Channel-Permission-Overrides für einen Channel.
 */
async function getChannelOverrides(env, channelId) {
  const r = await env.RENEX_DB.prepare(
    `SELECT target_kind, target_id, allow_bits, deny_bits
     FROM channel_permission_overrides
     WHERE channel_id = ?`
  ).bind(channelId).all();
  return r.results || [];
}

/**
 * Permission-Resolution mit DB-Lookup. Ruft die pure-Function aus permissions.js
 * auf, nachdem alle DB-Daten zusammengetragen sind.
 *
 * @returns {Promise<number>} effective permission bitfield, 0 wenn kein Member
 */
async function getEffectivePermissions(env, serverId, channelId, userHandle) {
  const membership = await getServerMembership(env, serverId, userHandle);
  if (!membership) return 0;

  const roles = await getUserRoles(env, serverId, userHandle);
  const overrides = channelId ? await getChannelOverrides(env, channelId) : [];

  return resolvePermissions({
    isOwner:    membership.is_owner === 1,
    roles,
    overrides,
    userHandle,
  });
}

/**
 * Convenience: prüft ob User bestimmte Permission hat.
 */
export async function userHasPermission(env, serverId, channelId, userHandle, wantedBit) {
  const eff = await getEffectivePermissions(env, serverId, channelId, userHandle);
  return (eff & wantedBit) === wantedBit;
}

/**
 * Höchste Role-Position des Actors für Anti-Privilege-Escalation-Check.
 * Owner: virtuell Position=Infinity (bypassed alle Position-Checks).
 * Member ohne Roles: 0.
 *
 * @returns {Promise<{position: number, isOwner: boolean}>}
 */
async function getActorMaxRolePosition(env, serverId, actor) {
  const m = await getServerMembership(env, serverId, actor);
  if (!m) return { position: 0, isOwner: false };
  if (m.is_owner === 1) return { position: Number.MAX_SAFE_INTEGER, isOwner: true };

  const r = await env.RENEX_DB.prepare(
    `SELECT MAX(sr.position) AS max_pos
     FROM role_assignments ra
     JOIN server_roles sr ON ra.role_id = sr.id
     WHERE ra.server_id = ? AND ra.user_handle = ?`
  ).bind(serverId, actor).first();
  return { position: r?.max_pos ?? 0, isOwner: false };
}

/**
 * Audit-Log-Eintrag schreiben. Fail-safe: Fehler werden nicht propagiert
 * (Audit-Log darf den Haupt-Pfad nicht blockieren).
 */
async function audit(env, serverId, actor, action, target = null, details = null) {
  try {
    await env.RENEX_DB.prepare(
      `INSERT INTO server_audit_log (id, server_id, actor, action, target, details_json, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      serverId,
      actor,
      action,
      target,
      details ? JSON.stringify(details) : null,
      Date.now()
    ).run();
  } catch (e) {
    console.warn(`[audit] failed: ${action} on ${serverId}: ${e?.message}`);
  }
}

/**
 * Recipient-Set-Cache invalidieren (Spec §4.3).
 * Wird bei Member/Role/Permission-Änderungen aufgerufen, damit der nächste
 * `/chat/send` an diesen Channel den frischen Recipient-Set aus D1 lädt
 * statt der gestorbenen 5min-Cache-Liste zu trauen.
 *
 * Cache-Key ist derselbe wie in `pushToGroupMembers`: `grp_members:<convoId>`.
 *
 * @param {string} serverId
 * @param {string?} channelId — wenn null: alle Channels des Servers
 */
async function invalidateRecipientCache(env, serverId, channelId = null) {
  try {
    if (channelId) {
      await env.RENEX_KV.delete(`grp_members:${channelId}`);
    } else {
      // Alle Channels des Servers betroffen → list + bulk-delete
      const channels = await env.RENEX_DB.prepare(
        `SELECT id FROM conversations WHERE server_id = ? AND type = 'channel'`
      ).bind(serverId).all();
      const ids = (channels.results || []).map(c => c.id);
      await Promise.allSettled(
        ids.map(id => env.RENEX_KV.delete(`grp_members:${id}`))
      );
    }
  } catch (e) {
    console.warn(`[recipient-cache] invalidate failed: ${e?.message}`);
  }
}

/**
 * Push WS-Event an alle Server-Members.
 */
async function pushToServerMembers(env, serverId, event, excludeHandle = null) {
  const r = await env.RENEX_DB.prepare(
    `SELECT user_handle FROM server_members WHERE server_id = ?`
  ).bind(serverId).all();
  const handles = (r.results || [])
    .map(row => row.user_handle)
    .filter(h => h !== excludeHandle);
  await Promise.allSettled(handles.map(h => pushToUserDO(env, h, event)));
}

// ── Path-Matching ──────────────────────────────────────
// Pfade sind nested: /servers/<id>/channels/<cid>/permissions etc.
// Wir nutzen regex-pattern um id-Parameter zu extrahieren.
const SERVER_ID_RE = '([a-f0-9-]{36})';   // UUID v4 lowercase
const HANDLE_RE    = '([a-z0-9_]+)';
const INVITE_TOKEN_RE = '(srv_inv_[a-f0-9]{32})';

const ROUTES = [
  { pattern: new RegExp(`^/servers/create$`),                                           handler: 'createServer'      },
  { pattern: new RegExp(`^/servers/list$`),                                             handler: 'listServers'       },
  { pattern: new RegExp(`^/servers/join/${INVITE_TOKEN_RE}$`),                          handler: 'joinByToken'       },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}/invites$`),                          handler: 'invites'           },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}/invites/${INVITE_TOKEN_RE}$`),       handler: 'inviteDetail'      },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}$`),                                  handler: 'serverDetail'      },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}/icon$`),                             handler: 'serverIcon'        },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}/leave$`),                            handler: 'leaveServer'       },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}/transfer$`),                         handler: 'transferServer'    },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}/members$`),                          handler: 'listMembers'       },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}/members/me$`),                       handler: 'updateOwnMember'   },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}/members/${HANDLE_RE}/kick$`),        handler: 'kickMember'        },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}/members/${HANDLE_RE}/ban$`),         handler: 'banMember'         },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}/bans$`),                             handler: 'bansList'          },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}/bans/${HANDLE_RE}$`),                handler: 'banDetail'         },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}/members/${HANDLE_RE}/roles$`),       handler: 'assignRole'        },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}/members/${HANDLE_RE}/roles/([a-f0-9-]{36})$`), handler: 'revokeRole' },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}/channels$`),                         handler: 'channels'          },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}/channels/([a-f0-9-]{36})$`),         handler: 'channelDetail'     },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}/channels/([a-f0-9-]{36})/permissions$`), handler: 'channelPermissions' },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}/channels/([a-f0-9-]{36})/members$`), handler: 'channelMembers'    },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}/roles$`),                            handler: 'roles'             },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}/roles/([a-f0-9-]{36})$`),            handler: 'roleDetail'        },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}/audit-log$`),                        handler: 'auditLog'          },
  { pattern: new RegExp(`^/servers/${SERVER_ID_RE}/audit-log/me$`),                     handler: 'auditLogMe'        },
];

function matchRoute(path) {
  for (const r of ROUTES) {
    const m = r.pattern.exec(path);
    if (m) return { handler: r.handler, args: m.slice(1) };
  }
  return null;
}

// ======================================================
// MAIN HANDLER
// ======================================================
export async function handleServerRoutes(request, env, path, params) {
  const csrfErr = checkCsrf(request);
  if (csrfErr) return csrfErr;

  const session = await requireSession(request, env);
  if (!session) return json(request, { error: 'Not authenticated' }, 401);

  const me = String(session.handle || '').toLowerCase();
  const isGuest = session.isGuest === true;
  if (isGuest) return json(request, { error: 'Not authorized' }, 403);

  const route = matchRoute(path);
  if (!route) return json(request, { error: 'Not found' }, 404);

  const ctx = { request, env, params, me, session };

  // Dispatch
  switch (route.handler) {
    case 'createServer':       return await createServer(ctx);
    case 'listServers':        return await listServers(ctx);
    case 'serverDetail': {
      if (request.method === 'GET')   return await serverDetail(ctx, route.args[0]);
      if (request.method === 'PATCH') return await updateServer(ctx, route.args[0]);
      return json(request, { error: 'Method not allowed' }, 405);
    }
    case 'serverIcon': {
      if (request.method === 'POST')   return await uploadServerIcon(ctx, route.args[0]);
      if (request.method === 'GET')    return await serveServerIcon(ctx, route.args[0]);
      if (request.method === 'DELETE') return await deleteServerIcon(ctx, route.args[0]);
      return json(request, { error: 'Method not allowed' }, 405);
    }
    case 'transferServer':     return await transferServer(ctx, route.args[0]);
    case 'leaveServer':        return await leaveServer(ctx, route.args[0]);
    case 'listMembers':        return await listMembers(ctx, route.args[0]);
    case 'channels':           return await channelsHandler(ctx, route.args[0]);
    case 'roles':              return await rolesHandler(ctx, route.args[0]);
    case 'roleDetail':         return await roleDetailHandler(ctx, route.args[0], route.args[1]);
    case 'assignRole':         return await assignRoleHandler(ctx, route.args[0], route.args[1]);
    case 'revokeRole':         return await revokeRoleHandler(ctx, route.args[0], route.args[1], route.args[2]);
    case 'kickMember':         return await kickMemberHandler(ctx, route.args[0], route.args[1]);
    case 'banMember':          return await banMemberHandler(ctx, route.args[0], route.args[1]);
    case 'bansList':           return await bansListHandler(ctx, route.args[0]);
    case 'banDetail':          return await banDetailHandler(ctx, route.args[0], route.args[1]);
    case 'auditLog':           return await auditLogHandler(ctx, route.args[0]);
    case 'auditLogMe':         return await auditLogMeHandler(ctx, route.args[0]);
    case 'channelDetail':      return await channelDetailHandler(ctx, route.args[0], route.args[1]);
    case 'invites':            return await invitesHandler(ctx, route.args[0]);
    case 'inviteDetail':       return await inviteDeleteHandler(ctx, route.args[0], route.args[1]);
    case 'joinByToken':        return await joinByTokenHandler(ctx, route.args[0]);

    // 🚧 Stubs — TODO Phase 3A.5+
    case 'updateOwnMember':    return stub('updateOwnMember', route.args);
    case 'channelPermissions': return stub('channelPermissions', route.args);
    case 'channelMembers':     return stub('channelMembers', route.args);
  }

  return json(request, { error: 'Not implemented' }, 501);

  function stub(name, args) {
    return json(request, {
      error: 'not_implemented',
      todo: `serverRoutes.${name} (args=${JSON.stringify(args)})`,
      spec: 'docs/SERVERS.md §6',
    }, 501);
  }
}

// ======================================================
// HANDLERS — Implemented
// ======================================================

/**
 * POST /servers/create
 * Body: { name: string, description?: string }
 *
 * Creates: servers row + server_members(is_owner=1) + default everyone-role
 *          + role_assignment + #general channel.
 * Atomicity: D1 batch.
 */
async function createServer({ request, env, me }) {
  if (request.method !== 'POST') return json(request, { error: 'Method not allowed' }, 405);

  const rlErr = await checkRateLimit(env, 'serverCreate', me, request);
  if (rlErr) return rlErr;

  const body = await readJson(request);
  if (!body) return json(request, { error: 'Invalid JSON' }, 400);

  const name = String(body.name || '').trim();
  if (!name || name.length > MAX_SERVER_NAME) {
    return json(request, { error: 'Invalid server name (1-80 chars)' }, 400);
  }
  const description = body.description != null
    ? String(body.description).trim().slice(0, MAX_SERVER_DESC)
    : null;

  // TODO Phase 3.5: users.tier-Lookup + Limit-Check (Free=3, Pro=25)
  // Provisorisch: hartes Free-Limit für alle bis Tier-Feld da ist.
  const ownedCount = await env.RENEX_DB.prepare(
    `SELECT COUNT(*) AS c FROM server_members WHERE user_handle = ? AND is_owner = 1`
  ).bind(me).first();
  if ((ownedCount?.c || 0) >= MAX_OWNED_SERVERS_FREE) {
    return json(request, { error: 'server_limit_reached', limit: MAX_OWNED_SERVERS_FREE }, 403);
  }

  const serverId      = crypto.randomUUID();
  const defaultRoleId = crypto.randomUUID();
  const channelId     = crypto.randomUUID();
  const now           = Date.now();

  // D1 batch — alle 5 INSERTs atomar
  await env.RENEX_DB.batch([
    env.RENEX_DB.prepare(
      `INSERT INTO servers (id, name, description, visibility, created_at, created_by, member_limit)
       VALUES (?, ?, ?, 'invite', ?, ?, ?)`
    ).bind(serverId, name, description, now, me, 1000),

    env.RENEX_DB.prepare(
      `INSERT INTO server_members (server_id, user_handle, joined_at, is_owner)
       VALUES (?, ?, ?, 1)`
    ).bind(serverId, me, now),

    env.RENEX_DB.prepare(
      `INSERT INTO server_roles (id, server_id, name, color, permissions, position, is_default, is_mentionable, created_at)
       VALUES (?, ?, 'everyone', NULL, ?, 0, 1, 0, ?)`
    ).bind(defaultRoleId, serverId, DEFAULT_EVERYONE_PERMISSIONS, now),

    env.RENEX_DB.prepare(
      `INSERT INTO role_assignments (server_id, user_handle, role_id, assigned_at)
       VALUES (?, ?, ?, ?)`
    ).bind(serverId, me, defaultRoleId, now),

    env.RENEX_DB.prepare(
      `INSERT INTO conversations (id, type, name, created_at, created_by, server_id, channel_kind, position, topic)
       VALUES (?, 'channel', 'general', ?, ?, ?, 'text', 0, NULL)`
    ).bind(channelId, now, me, serverId),
  ]);

  await audit(env, serverId, me, 'server_create', null, { name });

  return json(request, {
    ok:               true,
    serverId,
    defaultChannelId: channelId,
    defaultRoleId,
  });
}

/**
 * GET /servers/list
 * Returns: { servers: [{ id, name, description, icon, memberCount, isOwner }] }
 */
async function listServers({ request, env, me }) {
  if (request.method !== 'GET') return json(request, { error: 'Method not allowed' }, 405);

  const r = await env.RENEX_DB.prepare(
    `SELECT s.id, s.name, s.description, s.icon_r2_key, s.created_at,
            sm.is_owner,
            (SELECT COUNT(*) FROM server_members sm2 WHERE sm2.server_id = s.id) AS member_count
     FROM servers s
     JOIN server_members sm ON sm.server_id = s.id
     WHERE sm.user_handle = ?
     ORDER BY s.created_at ASC`
  ).bind(me).all();

  const servers = (r.results || []).map(row => ({
    id:          row.id,
    name:        row.name,
    description: row.description,
    iconR2Key:   row.icon_r2_key,
    memberCount: row.member_count,
    isOwner:     row.is_owner === 1,
    createdAt:   row.created_at,
  }));

  return json(request, { servers });
}

/**
 * GET /servers/<id>
 * Returns: { server, channels[], roles[], members[], myMembership, myPermissions }
 *
 * Achtung: skaliert linear mit Member-Count. Bei 10k-Member-Pro-Server kann
 * /members einen eigenen Endpoint mit Pagination kriegen (Phase 3.5).
 */
async function serverDetail({ request, env, me }, serverId) {
  if (request.method !== 'GET') return json(request, { error: 'Method not allowed' }, 405);

  const membership = await getServerMembership(env, serverId, me);
  if (!membership) return json(request, { error: 'Not a member' }, 403);

  const server = await env.RENEX_DB.prepare(
    `SELECT id, name, description, icon_r2_key, visibility, custom_slug,
            created_at, created_by, member_limit
     FROM servers WHERE id = ?`
  ).bind(serverId).first();
  if (!server) return json(request, { error: 'Server not found' }, 404);

  const [channels, roles, members, myRoles] = await Promise.all([
    env.RENEX_DB.prepare(
      `SELECT id, name, channel_kind, position, topic
       FROM conversations
       WHERE server_id = ? AND type = 'channel'
       ORDER BY position ASC`
    ).bind(serverId).all(),

    env.RENEX_DB.prepare(
      `SELECT id, name, color, permissions, position, is_default, is_mentionable
       FROM server_roles WHERE server_id = ?
       ORDER BY position DESC`
    ).bind(serverId).all(),

    env.RENEX_DB.prepare(
      `SELECT user_handle, nickname, is_owner, joined_at
       FROM server_members WHERE server_id = ?
       ORDER BY joined_at ASC`
    ).bind(serverId).all(),

    getUserRoles(env, serverId, me),
  ]);

  // My-Permissions auf Server-Ebene (ohne Channel-Override).
  // Frontend kann pro Channel separat berechnen via permissions.js.
  const myServerPermissions = resolvePermissions({
    isOwner:    membership.is_owner === 1,
    roles:      myRoles,
    overrides:  [],
    userHandle: me,
  });

  return json(request, {
    server: {
      id:          server.id,
      name:        server.name,
      description: server.description,
      iconR2Key:   server.icon_r2_key,
      visibility:  server.visibility,
      customSlug:  server.custom_slug,
      createdAt:   server.created_at,
      createdBy:   server.created_by,
      memberLimit: server.member_limit,
    },
    channels: (channels.results || []).map(c => ({
      id:       c.id,
      name:     c.name,
      kind:     c.channel_kind,
      position: c.position,
      topic:    c.topic,
    })),
    roles: (roles.results || []).map(r => ({
      id:            r.id,
      name:          r.name,
      color:         r.color,
      permissions:   r.permissions,
      position:      r.position,
      isDefault:     r.is_default === 1,
      isMentionable: r.is_mentionable === 1,
    })),
    members: (members.results || []).map(m => ({
      handle:   m.user_handle,
      nickname: m.nickname,
      isOwner:  m.is_owner === 1,
      joinedAt: m.joined_at,
    })),
    myMembership: {
      handle:    me,
      nickname:  membership.nickname,
      isOwner:   membership.is_owner === 1,
      joinedAt:  membership.joined_at,
      roleIds:   myRoles.map(r => r.id),
    },
    myServerPermissions,
  });
}

/**
 * POST /servers/<id>/leave
 *
 * Owner-Pre-Check: wenn andere Members existieren → Transfer-Required-Error.
 * Wenn keine anderen Members → Server wird CASCADE-deleted.
 */
async function leaveServer({ request, env, me }, serverId) {
  if (request.method !== 'POST') return json(request, { error: 'Method not allowed' }, 405);

  const rlErr = await checkRateLimit(env, 'serverLeave', me, request);
  if (rlErr) return rlErr;

  const membership = await getServerMembership(env, serverId, me);
  if (!membership) return json(request, { error: 'Not a member' }, 403);

  if (membership.is_owner === 1) {
    const others = await env.RENEX_DB.prepare(
      `SELECT COUNT(*) AS c FROM server_members WHERE server_id = ? AND user_handle != ?`
    ).bind(serverId, me).first();

    if ((others?.c || 0) > 0) {
      return json(request, {
        error: 'owner_transfer_required',
        message: 'Transfer ownership before leaving (or delete the server)',
      }, 409);
    }

    // Solo-Owner → Server löschen (CASCADE)
    await env.RENEX_DB.prepare(`DELETE FROM servers WHERE id = ?`).bind(serverId).run();
    await invalidateRecipientCache(env, serverId);
    return json(request, { ok: true, serverDeleted: true });
  }

  // Regulärer Leave: Member entfernen, Role-Assignments mit cleanup
  await env.RENEX_DB.batch([
    env.RENEX_DB.prepare(
      `DELETE FROM server_members WHERE server_id = ? AND user_handle = ?`
    ).bind(serverId, me),
    env.RENEX_DB.prepare(
      `DELETE FROM role_assignments WHERE server_id = ? AND user_handle = ?`
    ).bind(serverId, me),
    // Member-Overrides in private Channels
    env.RENEX_DB.prepare(
      `DELETE FROM channel_permission_overrides
       WHERE target_kind = 'member' AND target_id = ?
         AND channel_id IN (SELECT id FROM conversations WHERE server_id = ?)`
    ).bind(me, serverId),
    // Channel-Memberships in Private-Channels des Servers
    env.RENEX_DB.prepare(
      `DELETE FROM conversation_members
       WHERE member_handle = ?
         AND convo_id IN (SELECT id FROM conversations WHERE server_id = ?)`
    ).bind(me, serverId),
  ]);

  await invalidateRecipientCache(env, serverId);
  await audit(env, serverId, me, 'server_leave');
  await pushToServerMembers(env, serverId, {
    id:     crypto.randomUUID(),
    type:   'server_member_left',
    serverId,
    handle: me,
    ts:     Date.now(),
  });

  return json(request, { ok: true });
}

/**
 * POST /servers/<id>/transfer
 * Body: { to: <user_handle> }
 *
 * Owner-only — ADMINISTRATOR-Bit reicht nicht (Spec §5: Owner-only-Aktion).
 * Target muss bereits Server-Member sein. Self-Transfer abgelehnt.
 * Atomar via D1-batch: alter Owner → is_owner=0, neuer Owner → is_owner=1.
 */
async function transferServer({ request, env, me }, serverId) {
  if (request.method !== 'POST') return json(request, { error: 'Method not allowed' }, 405);

  const rlErr = await checkRateLimit(env, 'serverTransfer', me, request);
  if (rlErr) return rlErr;

  const membership = await getServerMembership(env, serverId, me);
  if (!membership) return json(request, { error: 'Not a member' }, 403);
  if (membership.is_owner !== 1) return json(request, { error: 'not_owner' }, 403);

  const body = await readJson(request);
  if (!body) return json(request, { error: 'Invalid JSON' }, 400);

  const to = String(body.to || '').toLowerCase().trim();
  if (!to) return json(request, { error: 'missing_target' }, 400);
  if (to === me) return json(request, { error: 'cannot_transfer_to_self' }, 400);

  const targetMembership = await getServerMembership(env, serverId, to);
  if (!targetMembership) return json(request, { error: 'target_not_member' }, 404);

  await env.RENEX_DB.batch([
    env.RENEX_DB.prepare(
      `UPDATE server_members SET is_owner = 0 WHERE server_id = ? AND user_handle = ?`
    ).bind(serverId, me),
    env.RENEX_DB.prepare(
      `UPDATE server_members SET is_owner = 1 WHERE server_id = ? AND user_handle = ?`
    ).bind(serverId, to),
  ]);

  await audit(env, serverId, me, 'server_transfer', to);
  await pushToServerMembers(env, serverId, {
    id:       crypto.randomUUID(),
    type:     'server_owner_changed',
    serverId,
    from:     me,
    to,
    ts:       Date.now(),
  });

  return json(request, { ok: true });
}

/**
 * PATCH /servers/<id>
 * Body: { name?, description? } — beide optional, mindestens eines erforderlich.
 *
 * Permission: MANAGE_SERVER (Owner bypassed via Permission-Resolution).
 * Validation: name 1-80 chars (gleich wie Create), description max 500.
 */
async function updateServer({ request, env, me }, serverId) {
  const membership = await getServerMembership(env, serverId, me);
  if (!membership) return json(request, { error: 'Not a member' }, 403);

  if (!(await userHasPermission(env, serverId, null, me, Permissions.MANAGE_SERVER))) {
    return json(request, { error: 'forbidden_manage_server' }, 403);
  }

  const rlErr = await checkRateLimit(env, 'serverUpdate', me, request);
  if (rlErr) return rlErr;

  const server = await env.RENEX_DB.prepare(
    `SELECT id, name, description FROM servers WHERE id = ?`
  ).bind(serverId).first();
  if (!server) return json(request, { error: 'Server not found' }, 404);

  const body = await readJson(request);
  if (!body) return json(request, { error: 'Invalid JSON' }, 400);

  const updates = [];
  const params  = [];
  const auditDetails = {};

  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name || name.length > MAX_SERVER_NAME) {
      return json(request, { error: 'Invalid server name (1-80 chars)' }, 400);
    }
    updates.push('name = ?'); params.push(name);
    auditDetails.oldName = server.name; auditDetails.newName = name;
  }
  if ('description' in body) {
    const description = body.description == null
      ? null
      : String(body.description).trim().slice(0, MAX_SERVER_DESC) || null;
    updates.push('description = ?'); params.push(description);
    auditDetails.oldDescription = server.description; auditDetails.newDescription = description;
  }

  if (updates.length === 0) return json(request, { ok: true, noChange: true });

  params.push(serverId);
  await env.RENEX_DB.prepare(
    `UPDATE servers SET ${updates.join(', ')} WHERE id = ?`
  ).bind(...params).run();

  await audit(env, serverId, me, 'server_update', null, auditDetails);
  await pushToServerMembers(env, serverId, {
    id:       crypto.randomUUID(),
    type:     'server_updated',
    serverId,
    changes:  auditDetails,
    ts:       Date.now(),
  });

  return json(request, { ok: true, changes: auditDetails });
}

/**
 * POST /servers/<id>/icon
 *
 * Body: raw image bytes (arrayBuffer). Content-Type header → MIME.
 * Permission: MANAGE_SERVER. Validation: PNG/JPEG/WebP, ≤ 1 MB.
 * Side-effects: alter Icon-Key wird best-effort aus R2 gelöscht,
 * neuer Key `server-icons/<serverId>/<uuid>` wird in DB persistiert,
 * audit + WS broadcast 'server_updated' mit iconR2Key-diff.
 */
async function uploadServerIcon({ request, env, me }, serverId) {
  const membership = await getServerMembership(env, serverId, me);
  if (!membership) return json(request, { error: 'Not a member' }, 403);

  if (!(await userHasPermission(env, serverId, null, me, Permissions.MANAGE_SERVER))) {
    return json(request, { error: 'forbidden_manage_server' }, 403);
  }

  const rlErr = await checkRateLimit(env, 'serverIconSet', me, request);
  if (rlErr) return rlErr;

  if (!env.RENEX_FILES) return json(request, { error: 'R2 not configured' }, 503);

  const mimeType = (request.headers.get('Content-Type') || '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_ICON_MIME.has(mimeType)) {
    return json(request, { error: 'invalid_mime', allowed: [...ALLOWED_ICON_MIME] }, 400);
  }

  const body = await request.arrayBuffer();
  if (!body || body.byteLength === 0) {
    return json(request, { error: 'empty_body' }, 400);
  }
  if (body.byteLength > MAX_SERVER_ICON_BYTES) {
    return json(request, { error: 'file_too_large', maxBytes: MAX_SERVER_ICON_BYTES }, 400);
  }

  const server = await env.RENEX_DB.prepare(
    `SELECT id, icon_r2_key FROM servers WHERE id = ?`
  ).bind(serverId).first();
  if (!server) return json(request, { error: 'Server not found' }, 404);

  const previousKey = server.icon_r2_key;
  const newKey      = `server-icons/${serverId}/${crypto.randomUUID()}`;

  await env.RENEX_FILES.put(newKey, body, {
    httpMetadata: { contentType: mimeType }
  });

  await env.RENEX_DB.prepare(
    `UPDATE servers SET icon_r2_key = ? WHERE id = ?`
  ).bind(newKey, serverId).run();

  // Alten R2-Key best-effort entfernen (Fehler nicht propagieren)
  if (previousKey && previousKey !== newKey) {
    env.RENEX_FILES.delete(previousKey).catch(() => {});
  }

  const auditDetails = { oldIconR2Key: previousKey, newIconR2Key: newKey };
  await audit(env, serverId, me, 'server_icon_set', null, auditDetails);
  await pushToServerMembers(env, serverId, {
    id:       crypto.randomUUID(),
    type:     'server_updated',
    serverId,
    changes:  auditDetails,
    ts:       Date.now(),
  });

  return json(request, { ok: true, iconR2Key: newKey });
}

/**
 * GET /servers/<id>/icon
 *
 * Member-only. Streamt R2-Object zurück mit gespeicherter Content-Type.
 * Frontend lädt typischerweise via fetch+credentials → blobURL für `<img>`.
 */
async function serveServerIcon({ request, env, me }, serverId) {
  const membership = await getServerMembership(env, serverId, me);
  if (!membership) return json(request, { error: 'Not a member' }, 403);

  if (!env.RENEX_FILES) return json(request, { error: 'R2 not configured' }, 503);

  const server = await env.RENEX_DB.prepare(
    `SELECT icon_r2_key FROM servers WHERE id = ?`
  ).bind(serverId).first();
  if (!server) return json(request, { error: 'Server not found' }, 404);
  if (!server.icon_r2_key) return json(request, { error: 'no_icon' }, 404);

  const obj = await env.RENEX_FILES.get(server.icon_r2_key);
  if (!obj) {
    // R2-Object fehlt obwohl DB ihn referenziert (Drift) — als 404 melden, DB nicht hier reparieren
    return json(request, { error: 'icon_missing_in_r2' }, 404);
  }

  const contentType = obj.httpMetadata?.contentType || 'application/octet-stream';
  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type':  contentType,
      'Cache-Control': 'private, max-age=300',
      ...corsHeaders(request),
    }
  });
}

/**
 * DELETE /servers/<id>/icon
 *
 * Permission: MANAGE_SERVER. R2-Object wird best-effort gelöscht,
 * `icon_r2_key`-Spalte auf NULL gesetzt, audit + WS broadcast.
 */
async function deleteServerIcon({ request, env, me }, serverId) {
  const membership = await getServerMembership(env, serverId, me);
  if (!membership) return json(request, { error: 'Not a member' }, 403);

  if (!(await userHasPermission(env, serverId, null, me, Permissions.MANAGE_SERVER))) {
    return json(request, { error: 'forbidden_manage_server' }, 403);
  }

  const server = await env.RENEX_DB.prepare(
    `SELECT icon_r2_key FROM servers WHERE id = ?`
  ).bind(serverId).first();
  if (!server) return json(request, { error: 'Server not found' }, 404);

  const previousKey = server.icon_r2_key;
  if (!previousKey) return json(request, { ok: true, noChange: true });

  await env.RENEX_DB.prepare(
    `UPDATE servers SET icon_r2_key = NULL WHERE id = ?`
  ).bind(serverId).run();

  if (env.RENEX_FILES) {
    env.RENEX_FILES.delete(previousKey).catch(() => {});
  }

  const auditDetails = { oldIconR2Key: previousKey, newIconR2Key: null };
  await audit(env, serverId, me, 'server_icon_removed', null, auditDetails);
  await pushToServerMembers(env, serverId, {
    id:       crypto.randomUUID(),
    type:     'server_updated',
    serverId,
    changes:  auditDetails,
    ts:       Date.now(),
  });

  return json(request, { ok: true });
}

/**
 * GET /servers/<id>/members
 * Pagination kommt in Phase 3.5.
 */
async function listMembers({ request, env, me }, serverId) {
  if (request.method !== 'GET') return json(request, { error: 'Method not allowed' }, 405);

  const membership = await getServerMembership(env, serverId, me);
  if (!membership) return json(request, { error: 'Not a member' }, 403);

  const r = await env.RENEX_DB.prepare(
    `SELECT sm.user_handle, sm.nickname, sm.is_owner, sm.joined_at,
            GROUP_CONCAT(ra.role_id) AS role_ids
     FROM server_members sm
     LEFT JOIN role_assignments ra
       ON ra.server_id = sm.server_id AND ra.user_handle = sm.user_handle
     WHERE sm.server_id = ?
     GROUP BY sm.user_handle, sm.nickname, sm.is_owner, sm.joined_at
     ORDER BY sm.is_owner DESC, sm.joined_at ASC`
  ).bind(serverId).all();

  const members = (r.results || []).map(row => ({
    handle:   row.user_handle,
    nickname: row.nickname,
    isOwner:  row.is_owner === 1,
    joinedAt: row.joined_at,
    roleIds:  row.role_ids ? row.role_ids.split(',') : [],
  }));

  return json(request, { members, total: members.length });
}

/**
 * POST /servers/<id>/channels  — Create channel
 * GET  /servers/<id>/channels  — List channels (Sidebar-Source)
 */
async function channelsHandler({ request, env, me }, serverId) {
  if (request.method === 'GET') {
    const membership = await getServerMembership(env, serverId, me);
    if (!membership) return json(request, { error: 'Not a member' }, 403);

    const r = await env.RENEX_DB.prepare(
      `SELECT id, name, channel_kind, position, topic
       FROM conversations
       WHERE server_id = ? AND type = 'channel'
       ORDER BY position ASC`
    ).bind(serverId).all();

    return json(request, {
      channels: (r.results || []).map(c => ({
        id:       c.id,
        name:     c.name,
        kind:     c.channel_kind,
        position: c.position,
        topic:    c.topic,
      })),
    });
  }

  if (request.method !== 'POST') return json(request, { error: 'Method not allowed' }, 405);

  const rlErr = await checkRateLimit(env, 'channelCreate', me, request);
  if (rlErr) return rlErr;

  // Permission-Check: MANAGE_CHANNELS auf Server-Ebene
  if (!(await userHasPermission(env, serverId, null, me, Permissions.MANAGE_CHANNELS))) {
    return json(request, { error: 'forbidden_manage_channels' }, 403);
  }

  const body = await readJson(request);
  if (!body) return json(request, { error: 'Invalid JSON' }, 400);

  const name = String(body.name || '').trim();
  if (!name || name.length > MAX_CHANNEL_NAME) {
    return json(request, { error: 'Invalid channel name (1-64 chars)' }, 400);
  }
  const kind = String(body.kind || 'text');
  if (!VALID_CHANNEL_KINDS.has(kind)) {
    return json(request, { error: `Channel kind '${kind}' not supported in Phase 3A (voice=Phase 8)` }, 400);
  }
  const topic = body.topic != null
    ? String(body.topic).trim().slice(0, MAX_CHANNEL_TOPIC)
    : null;

  // Position = max(existing) + 1
  const posRow = await env.RENEX_DB.prepare(
    `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM conversations WHERE server_id = ?`
  ).bind(serverId).first();
  const position = posRow?.p ?? 0;

  const channelId = crypto.randomUUID();
  const now = Date.now();

  await env.RENEX_DB.prepare(
    `INSERT INTO conversations (id, type, name, created_at, created_by, server_id, channel_kind, position, topic)
     VALUES (?, 'channel', ?, ?, ?, ?, ?, ?, ?)`
  ).bind(channelId, name, now, me, serverId, kind, position, topic).run();

  await invalidateRecipientCache(env, serverId, channelId);
  await audit(env, serverId, me, 'channel_create', channelId, { name, kind });
  await pushToServerMembers(env, serverId, {
    id:     crypto.randomUUID(),
    type:   'channel_created',
    serverId,
    channel: { id: channelId, name, kind, position, topic },
    ts:     now,
  });

  return json(request, { ok: true, channelId, name, kind, position });
}

// ======================================================
// ROLES — Phase 3A Stubs nun implementiert
// ======================================================

const MAX_ROLE_NAME = 64;
const HEX_COLOR_RE  = /^#[0-9a-fA-F]{6}$/;

function _validateRoleColor(c) {
  if (c == null || c === '') return null;
  if (typeof c !== 'string' || !HEX_COLOR_RE.test(c)) return undefined; // marker für invalid
  return c;
}

/**
 * GET  /servers/<sid>/roles      — list roles of a server (any member can see)
 * POST /servers/<sid>/roles      — create role (MANAGE_ROLES + position-check)
 */
async function rolesHandler({ request, env, me }, serverId) {
  const membership = await getServerMembership(env, serverId, me);
  if (!membership) return json(request, { error: 'Not a member' }, 403);

  if (request.method === 'GET') {
    const r = await env.RENEX_DB.prepare(
      `SELECT id, name, color, permissions, position, is_default, is_mentionable, created_at
       FROM server_roles WHERE server_id = ?
       ORDER BY position DESC`
    ).bind(serverId).all();
    return json(request, {
      roles: (r.results || []).map(row => ({
        id:            row.id,
        name:          row.name,
        color:         row.color,
        permissions:   row.permissions,
        position:      row.position,
        isDefault:     row.is_default === 1,
        isMentionable: row.is_mentionable === 1,
        createdAt:     row.created_at,
      })),
    });
  }

  if (request.method !== 'POST') return json(request, { error: 'Method not allowed' }, 405);

  const rlErr = await checkRateLimit(env, 'roleCreate', me, request);
  if (rlErr) return rlErr;

  if (!(await userHasPermission(env, serverId, null, me, Permissions.MANAGE_ROLES))) {
    return json(request, { error: 'forbidden_manage_roles' }, 403);
  }

  const body = await readJson(request);
  if (!body) return json(request, { error: 'Invalid JSON' }, 400);

  const name = String(body.name || '').trim();
  if (!name || name.length > MAX_ROLE_NAME) {
    return json(request, { error: 'Invalid role name (1-64 chars)' }, 400);
  }
  if (name === 'everyone') {
    return json(request, { error: 'Reserved role name' }, 400);
  }

  const color = _validateRoleColor(body.color);
  if (color === undefined) return json(request, { error: 'Invalid color (must be #RRGGBB)' }, 400);

  const permissions = sanitizeBits(body.permissions);
  const position    = Number.isInteger(body.position) ? Math.max(0, body.position) : 1;

  // Anti-Privilege-Escalation: actor darf keine Role >= eigene max position erstellen
  const actorPos = await getActorMaxRolePosition(env, serverId, me);
  if (!canManageRoleAtPosition(actorPos.position, position, actorPos.isOwner)) {
    return json(request, { error: 'forbidden_role_position' }, 403);
  }

  // ADMINISTRATOR-Bit darf nur Owner setzen (sonst privilege escalation)
  if ((permissions & Permissions.ADMINISTRATOR) && !actorPos.isOwner) {
    return json(request, { error: 'forbidden_administrator_bit' }, 403);
  }

  const roleId = crypto.randomUUID();
  const now    = Date.now();

  await env.RENEX_DB.prepare(
    `INSERT INTO server_roles (id, server_id, name, color, permissions, position, is_default, is_mentionable, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).bind(
    roleId, serverId, name, color || null, permissions, position,
    body.isMentionable === true ? 1 : 0,
    now,
  ).run();

  await audit(env, serverId, me, 'role_create', roleId, { name, permissions, position });
  await pushToServerMembers(env, serverId, {
    id:   crypto.randomUUID(),
    type: 'role_created',
    serverId,
    role: { id: roleId, name, color: color || null, permissions, position, isDefault: false, isMentionable: body.isMentionable === true },
    ts:   now,
  });

  return json(request, { ok: true, roleId });
}

/**
 * PATCH  /servers/<sid>/roles/<rid>  — update role (MANAGE_ROLES + position-check)
 * DELETE /servers/<sid>/roles/<rid>  — delete role (MANAGE_ROLES + position-check, NICHT default-role)
 */
async function roleDetailHandler({ request, env, me }, serverId, roleId) {
  const membership = await getServerMembership(env, serverId, me);
  if (!membership) return json(request, { error: 'Not a member' }, 403);

  if (!(await userHasPermission(env, serverId, null, me, Permissions.MANAGE_ROLES))) {
    return json(request, { error: 'forbidden_manage_roles' }, 403);
  }

  const role = await env.RENEX_DB.prepare(
    `SELECT id, server_id, name, color, permissions, position, is_default, is_mentionable
     FROM server_roles WHERE id = ? AND server_id = ?`
  ).bind(roleId, serverId).first();
  if (!role) return json(request, { error: 'Role not found' }, 404);

  // Position-Check vs aktuelle Role
  const actorPos = await getActorMaxRolePosition(env, serverId, me);
  if (!canManageRoleAtPosition(actorPos.position, role.position, actorPos.isOwner)) {
    return json(request, { error: 'forbidden_role_position' }, 403);
  }

  if (request.method === 'PATCH') {
    const rlErr = await checkRateLimit(env, 'roleUpdate', me, request);
    if (rlErr) return rlErr;

    const body = await readJson(request);
    if (!body) return json(request, { error: 'Invalid JSON' }, 400);

    const updates = [];
    const params  = [];
    const auditDetails = {};

    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name || name.length > MAX_ROLE_NAME) return json(request, { error: 'Invalid role name' }, 400);
      if (name === 'everyone' && role.is_default !== 1) return json(request, { error: 'Reserved role name' }, 400);
      updates.push('name = ?'); params.push(name);
      auditDetails.oldName = role.name; auditDetails.newName = name;
    }
    if ('color' in body) {
      const color = _validateRoleColor(body.color);
      if (color === undefined) return json(request, { error: 'Invalid color' }, 400);
      updates.push('color = ?'); params.push(color || null);
    }
    if (Number.isInteger(body.permissions)) {
      const newPerms = sanitizeBits(body.permissions);
      if ((newPerms & Permissions.ADMINISTRATOR) && !actorPos.isOwner) {
        return json(request, { error: 'forbidden_administrator_bit' }, 403);
      }
      updates.push('permissions = ?'); params.push(newPerms);
      auditDetails.oldPermissions = role.permissions; auditDetails.newPermissions = newPerms;
    }
    if (Number.isInteger(body.position)) {
      const newPos = Math.max(0, body.position);
      // Neue Position muss auch unter Actor-Position sein (sonst kann ein
      // mid-tier-Manager eine Role auf Owner-Niveau hochheben).
      if (!canManageRoleAtPosition(actorPos.position, newPos, actorPos.isOwner)) {
        return json(request, { error: 'forbidden_role_position' }, 403);
      }
      updates.push('position = ?'); params.push(newPos);
      auditDetails.oldPosition = role.position; auditDetails.newPosition = newPos;
    }
    if (typeof body.isMentionable === 'boolean') {
      updates.push('is_mentionable = ?'); params.push(body.isMentionable ? 1 : 0);
    }

    if (updates.length === 0) return json(request, { ok: true, noChange: true });

    params.push(roleId);
    await env.RENEX_DB.prepare(
      `UPDATE server_roles SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...params).run();

    // Permissions-Änderung → Recipient-Cache invalidieren (Send-Path muss neu auflösen)
    if ('permissions' in auditDetails) {
      await invalidateRecipientCache(env, serverId);
    }

    await audit(env, serverId, me, 'role_update', roleId, auditDetails);
    await pushToServerMembers(env, serverId, {
      id: crypto.randomUUID(), type: 'role_updated', serverId, roleId, changes: auditDetails, ts: Date.now(),
    });
    return json(request, { ok: true });
  }

  if (request.method === 'DELETE') {
    const rlErr = await checkRateLimit(env, 'roleDelete', me, request);
    if (rlErr) return rlErr;

    if (role.is_default === 1) {
      return json(request, { error: 'cannot_delete_default_role' }, 400);
    }

    // Re-Assign betroffener Members zur Default-Role (sonst hätten sie keine Permissions)
    const defaultRole = await env.RENEX_DB.prepare(
      `SELECT id FROM server_roles WHERE server_id = ? AND is_default = 1`
    ).bind(serverId).first();

    await env.RENEX_DB.batch([
      env.RENEX_DB.prepare(
        `DELETE FROM role_assignments WHERE server_id = ? AND role_id = ?`
      ).bind(serverId, roleId),
      env.RENEX_DB.prepare(
        `DELETE FROM server_roles WHERE id = ?`
      ).bind(roleId),
    ]);

    await invalidateRecipientCache(env, serverId);
    await audit(env, serverId, me, 'role_delete', roleId, { name: role.name, fallbackRoleId: defaultRole?.id });
    await pushToServerMembers(env, serverId, {
      id: crypto.randomUUID(), type: 'role_deleted', serverId, roleId, ts: Date.now(),
    });
    return json(request, { ok: true });
  }

  return json(request, { error: 'Method not allowed' }, 405);
}

/**
 * POST /servers/<sid>/members/<u>/roles  — assign a role to a member
 * Body: { roleId }
 */
async function assignRoleHandler({ request, env, me }, serverId, targetHandle) {
  if (request.method !== 'POST') return json(request, { error: 'Method not allowed' }, 405);

  const rlErr = await checkRateLimit(env, 'memberRoleAdd', me, request);
  if (rlErr) return rlErr;

  const membership = await getServerMembership(env, serverId, me);
  if (!membership) return json(request, { error: 'Not a member' }, 403);

  if (!(await userHasPermission(env, serverId, null, me, Permissions.MANAGE_ROLES))) {
    return json(request, { error: 'forbidden_manage_roles' }, 403);
  }

  const body = await readJson(request);
  if (!body || typeof body.roleId !== 'string') {
    return json(request, { error: 'Missing roleId' }, 400);
  }

  const targetMember = await getServerMembership(env, serverId, targetHandle);
  if (!targetMember) return json(request, { error: 'Target not a member' }, 404);

  const role = await env.RENEX_DB.prepare(
    `SELECT id, position FROM server_roles WHERE id = ? AND server_id = ?`
  ).bind(body.roleId, serverId).first();
  if (!role) return json(request, { error: 'Role not found' }, 404);

  // Position-Check: actor muss strikt höher sein als Ziel-Role
  const actorPos = await getActorMaxRolePosition(env, serverId, me);
  if (!canManageRoleAtPosition(actorPos.position, role.position, actorPos.isOwner)) {
    return json(request, { error: 'forbidden_role_position' }, 403);
  }

  await env.RENEX_DB.prepare(
    `INSERT OR IGNORE INTO role_assignments (server_id, user_handle, role_id, assigned_at)
     VALUES (?, ?, ?, ?)`
  ).bind(serverId, targetHandle, body.roleId, Date.now()).run();

  await invalidateRecipientCache(env, serverId);
  await audit(env, serverId, me, 'role_assign', targetHandle, { roleId: body.roleId });
  await pushToServerMembers(env, serverId, {
    id: crypto.randomUUID(), type: 'member_role_assigned', serverId,
    handle: targetHandle, roleId: body.roleId, ts: Date.now(),
  });

  return json(request, { ok: true });
}

/**
 * DELETE /servers/<sid>/members/<u>/roles/<rid>  — revoke a role from a member
 */
async function revokeRoleHandler({ request, env, me }, serverId, targetHandle, roleId) {
  if (request.method !== 'DELETE') return json(request, { error: 'Method not allowed' }, 405);

  const rlErr = await checkRateLimit(env, 'memberRoleDel', me, request);
  if (rlErr) return rlErr;

  const membership = await getServerMembership(env, serverId, me);
  if (!membership) return json(request, { error: 'Not a member' }, 403);

  if (!(await userHasPermission(env, serverId, null, me, Permissions.MANAGE_ROLES))) {
    return json(request, { error: 'forbidden_manage_roles' }, 403);
  }

  const role = await env.RENEX_DB.prepare(
    `SELECT id, position, is_default FROM server_roles WHERE id = ? AND server_id = ?`
  ).bind(roleId, serverId).first();
  if (!role) return json(request, { error: 'Role not found' }, 404);

  if (role.is_default === 1) {
    return json(request, { error: 'cannot_revoke_default_role' }, 400);
  }

  // Position-Check
  const actorPos = await getActorMaxRolePosition(env, serverId, me);
  if (!canManageRoleAtPosition(actorPos.position, role.position, actorPos.isOwner)) {
    return json(request, { error: 'forbidden_role_position' }, 403);
  }

  await env.RENEX_DB.prepare(
    `DELETE FROM role_assignments
     WHERE server_id = ? AND user_handle = ? AND role_id = ?`
  ).bind(serverId, targetHandle, roleId).run();

  await invalidateRecipientCache(env, serverId);
  await audit(env, serverId, me, 'role_revoke', targetHandle, { roleId });
  await pushToServerMembers(env, serverId, {
    id: crypto.randomUUID(), type: 'member_role_revoked', serverId,
    handle: targetHandle, roleId, ts: Date.now(),
  });

  return json(request, { ok: true });
}

// ======================================================
// MEMBER MANAGEMENT — kick (ban deferred wegen server_bans-Tabelle)
// ======================================================

/**
 * POST /servers/<sid>/members/<u>/kick — entfernt Member ohne Re-Join-Block
 *
 * Permission: KICK_MEMBERS + Position-Check (actor max-position > target max-position).
 * Blockiert: Owner-Kick (must transfer first), Self-Kick (User soll /leave nutzen).
 * Side-Effects: Member-DELETE + Role-Cleanup + Channel-Member-Cleanup +
 *   Recipient-Cache-Invalidation + WS-Push + Audit-Log.
 *
 * Re-Join möglich via neuem Invite (Ban kommt in Phase 3A.5 mit server_bans-Tabelle).
 */
async function kickMemberHandler({ request, env, me }, serverId, targetHandle) {
  if (request.method !== 'POST') return json(request, { error: 'Method not allowed' }, 405);

  const rlErr = await checkRateLimit(env, 'memberKick', me, request);
  if (rlErr) return rlErr;

  const myMembership = await getServerMembership(env, serverId, me);
  if (!myMembership) return json(request, { error: 'Not a member' }, 403);

  if (targetHandle === me) {
    return json(request, { error: 'self_kick_not_allowed', hint: 'Use POST /servers/<id>/leave' }, 400);
  }

  if (!(await userHasPermission(env, serverId, null, me, Permissions.KICK_MEMBERS))) {
    return json(request, { error: 'forbidden_kick_members' }, 403);
  }

  const targetMembership = await getServerMembership(env, serverId, targetHandle);
  if (!targetMembership) return json(request, { error: 'Target not a member' }, 404);

  if (targetMembership.is_owner === 1) {
    return json(request, { error: 'cannot_kick_owner', hint: 'Owner must transfer or leave first' }, 403);
  }

  // Position-Check: Owner-Bypass oder actor-max-pos > target-max-pos
  const [actorPos, targetPos] = await Promise.all([
    getActorMaxRolePosition(env, serverId, me),
    getActorMaxRolePosition(env, serverId, targetHandle),
  ]);
  if (!actorPos.isOwner && targetPos.position >= actorPos.position) {
    return json(request, { error: 'forbidden_target_higher_or_equal' }, 403);
  }

  // CASCADE-Delete in einer Batch
  await env.RENEX_DB.batch([
    env.RENEX_DB.prepare(
      `DELETE FROM server_members WHERE server_id = ? AND user_handle = ?`
    ).bind(serverId, targetHandle),
    env.RENEX_DB.prepare(
      `DELETE FROM role_assignments WHERE server_id = ? AND user_handle = ?`
    ).bind(serverId, targetHandle),
    env.RENEX_DB.prepare(
      `DELETE FROM channel_permission_overrides
       WHERE target_kind = 'member' AND target_id = ?
         AND channel_id IN (SELECT id FROM conversations WHERE server_id = ?)`
    ).bind(targetHandle, serverId),
    env.RENEX_DB.prepare(
      `DELETE FROM conversation_members
       WHERE member_handle = ?
         AND convo_id IN (SELECT id FROM conversations WHERE server_id = ?)`
    ).bind(targetHandle, serverId),
  ]);

  await invalidateRecipientCache(env, serverId);
  await audit(env, serverId, me, 'member_kick', targetHandle, {
    targetMaxPosition: targetPos.position,
    actorMaxPosition: actorPos.isOwner ? 'owner' : actorPos.position,
  });

  // WS-Push an alle verbleibenden Members + an gekickten User selbst
  // (er soll wissen dass er weg ist, nicht erst beim nächsten Reload)
  const event = {
    id:     crypto.randomUUID(),
    type:   'server_member_kicked',
    serverId,
    handle: targetHandle,
    by:     me,
    ts:     Date.now(),
  };
  await pushToServerMembers(env, serverId, event);
  // Gekickter User selbst (nicht mehr im Server, also nicht via pushToServerMembers)
  pushToUserDO(env, targetHandle, event).catch(() => {});

  return json(request, { ok: true });
}

/**
 * POST /servers/<id>/members/<u>/ban
 * Body (optional): { reason?: string }
 *
 * Permission: BAN_MEMBERS. Owner-Bypass für Position-Check. Owner kann nicht
 * gebannt werden (er muss vorher transferren). Self-Ban abgelehnt.
 * Effekt: row in server_bans + CASCADE-Delete aus server_members,
 * role_assignments, channel_permission_overrides (member), conversation_members
 * (private Channels). Banned User kann nicht via Invite re-joinen.
 */
async function banMemberHandler({ request, env, me }, serverId, targetHandle) {
  if (request.method !== 'POST') return json(request, { error: 'Method not allowed' }, 405);

  const rlErr = await checkRateLimit(env, 'memberBan', me, request);
  if (rlErr) return rlErr;

  const myMembership = await getServerMembership(env, serverId, me);
  if (!myMembership) return json(request, { error: 'Not a member' }, 403);

  if (targetHandle === me) {
    return json(request, { error: 'self_ban_not_allowed' }, 400);
  }

  if (!(await userHasPermission(env, serverId, null, me, Permissions.BAN_MEMBERS))) {
    return json(request, { error: 'forbidden_ban_members' }, 403);
  }

  const targetMembership = await getServerMembership(env, serverId, targetHandle);
  if (!targetMembership) return json(request, { error: 'Target not a member' }, 404);

  if (targetMembership.is_owner === 1) {
    return json(request, { error: 'cannot_ban_owner', hint: 'Owner must transfer first' }, 403);
  }

  // Position-Check: actor muss strikt höher als Target sein (Owner bypassed)
  const [actorPos, targetPos] = await Promise.all([
    getActorMaxRolePosition(env, serverId, me),
    getActorMaxRolePosition(env, serverId, targetHandle),
  ]);
  if (!actorPos.isOwner && targetPos.position >= actorPos.position) {
    return json(request, { error: 'forbidden_target_higher_or_equal' }, 403);
  }

  // Reason aus Body (optional, max 500 chars)
  let reason = null;
  if (request.headers.get('content-type')?.includes('application/json')) {
    const body = await readJson(request);
    if (body?.reason != null) {
      reason = String(body.reason).trim().slice(0, 500) || null;
    }
  }

  const now = Date.now();

  // Atomic: ban-row + CASCADE-Delete in einer Batch
  await env.RENEX_DB.batch([
    env.RENEX_DB.prepare(
      `INSERT OR REPLACE INTO server_bans (server_id, user_handle, banned_by, reason, ts)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(serverId, targetHandle, me, reason, now),
    env.RENEX_DB.prepare(
      `DELETE FROM server_members WHERE server_id = ? AND user_handle = ?`
    ).bind(serverId, targetHandle),
    env.RENEX_DB.prepare(
      `DELETE FROM role_assignments WHERE server_id = ? AND user_handle = ?`
    ).bind(serverId, targetHandle),
    env.RENEX_DB.prepare(
      `DELETE FROM channel_permission_overrides
       WHERE target_kind = 'member' AND target_id = ?
         AND channel_id IN (SELECT id FROM conversations WHERE server_id = ?)`
    ).bind(targetHandle, serverId),
    env.RENEX_DB.prepare(
      `DELETE FROM conversation_members
       WHERE member_handle = ?
         AND convo_id IN (SELECT id FROM conversations WHERE server_id = ?)`
    ).bind(targetHandle, serverId),
  ]);

  await invalidateRecipientCache(env, serverId);
  await audit(env, serverId, me, 'member_ban', targetHandle, { reason });

  const event = {
    id:     crypto.randomUUID(),
    type:   'server_member_banned',
    serverId,
    handle: targetHandle,
    by:     me,
    reason,
    ts:     now,
  };
  await pushToServerMembers(env, serverId, event);
  // Gebannter User selbst (nicht mehr im Server) — bekommt Event direkt
  pushToUserDO(env, targetHandle, event).catch(() => {});

  return json(request, { ok: true });
}

/**
 * GET /servers/<id>/bans
 *
 * Permission: BAN_MEMBERS. Listet alle aktiven Bans dieses Servers.
 */
async function bansListHandler({ request, env, me }, serverId) {
  if (request.method !== 'GET') return json(request, { error: 'Method not allowed' }, 405);

  const myMembership = await getServerMembership(env, serverId, me);
  if (!myMembership) return json(request, { error: 'Not a member' }, 403);

  if (!(await userHasPermission(env, serverId, null, me, Permissions.BAN_MEMBERS))) {
    return json(request, { error: 'forbidden_ban_members' }, 403);
  }

  const r = await env.RENEX_DB.prepare(
    `SELECT user_handle, banned_by, reason, ts
     FROM server_bans
     WHERE server_id = ?
     ORDER BY ts DESC`
  ).bind(serverId).all();

  const bans = (r.results || []).map(row => ({
    handle:    row.user_handle,
    bannedBy:  row.banned_by,
    reason:    row.reason,
    ts:        row.ts,
  }));

  return json(request, { bans, total: bans.length });
}

/**
 * DELETE /servers/<id>/bans/<u>
 *
 * Permission: BAN_MEMBERS. Unban — danach kann User wieder via Invite joinen.
 * (Re-Join muss aktiv passieren, kein Auto-Add zurück in server_members.)
 */
async function banDetailHandler({ request, env, me }, serverId, targetHandle) {
  if (request.method !== 'DELETE') return json(request, { error: 'Method not allowed' }, 405);

  const rlErr = await checkRateLimit(env, 'memberUnban', me, request);
  if (rlErr) return rlErr;

  const myMembership = await getServerMembership(env, serverId, me);
  if (!myMembership) return json(request, { error: 'Not a member' }, 403);

  if (!(await userHasPermission(env, serverId, null, me, Permissions.BAN_MEMBERS))) {
    return json(request, { error: 'forbidden_ban_members' }, 403);
  }

  const existing = await env.RENEX_DB.prepare(
    `SELECT user_handle FROM server_bans WHERE server_id = ? AND user_handle = ?`
  ).bind(serverId, targetHandle).first();
  if (!existing) return json(request, { error: 'not_banned' }, 404);

  await env.RENEX_DB.prepare(
    `DELETE FROM server_bans WHERE server_id = ? AND user_handle = ?`
  ).bind(serverId, targetHandle).run();

  await audit(env, serverId, me, 'member_unban', targetHandle, null);

  // WS an verbleibende Members — Banned-Liste in UI updaten
  await pushToServerMembers(env, serverId, {
    id:     crypto.randomUUID(),
    type:   'server_member_unbanned',
    serverId,
    handle: targetHandle,
    by:     me,
    ts:     Date.now(),
  });

  return json(request, { ok: true });
}

// ======================================================
// AUDIT-LOG — Read-only Endpoints
// ======================================================

const AUDIT_LIMIT_DEFAULT = 50;
const AUDIT_LIMIT_MAX     = 200;

/**
 * GET /servers/<sid>/audit-log
 * Permission: MANAGE_SERVER (oder Owner)
 * Query: ?action=<action>&actor=<handle>&target=<handle>&before=<ts>&limit=<n>
 *
 * Pagination: cursor-style via `before` (vorheriger Page's ältester ts).
 */
async function auditLogHandler({ request, env, params, me }, serverId) {
  if (request.method !== 'GET') return json(request, { error: 'Method not allowed' }, 405);

  const membership = await getServerMembership(env, serverId, me);
  if (!membership) return json(request, { error: 'Not a member' }, 403);

  if (!(await userHasPermission(env, serverId, null, me, Permissions.MANAGE_SERVER))) {
    return json(request, { error: 'forbidden_manage_server' }, 403);
  }

  const action = params.get('action');
  const actor  = params.get('actor');
  const target = params.get('target');
  const before = parseInt(params.get('before') || '', 10);
  const limit  = Math.min(
    Math.max(parseInt(params.get('limit') || '', 10) || AUDIT_LIMIT_DEFAULT, 1),
    AUDIT_LIMIT_MAX,
  );

  // Build dynamic query
  const conds  = ['server_id = ?'];
  const binds  = [serverId];
  if (action) { conds.push('action = ?'); binds.push(action); }
  if (actor)  { conds.push('actor = ?');  binds.push(actor); }
  if (target) { conds.push('target = ?'); binds.push(target); }
  if (Number.isFinite(before)) { conds.push('ts < ?'); binds.push(before); }
  binds.push(limit);

  const r = await env.RENEX_DB.prepare(
    `SELECT id, actor, action, target, details_json, ts
     FROM server_audit_log
     WHERE ${conds.join(' AND ')}
     ORDER BY ts DESC
     LIMIT ?`
  ).bind(...binds).all();

  const entries = (r.results || []).map(row => ({
    id:      row.id,
    actor:   row.actor,
    action:  row.action,
    target:  row.target,
    details: row.details_json ? safeParseJson(row.details_json) : null,
    ts:      row.ts,
  }));

  // Cursor für nächste Seite (oldest ts der aktuellen Seite)
  const nextBefore = entries.length === limit ? entries[entries.length - 1].ts : null;

  return json(request, { entries, nextBefore, limit });
}

/**
 * GET /servers/<sid>/audit-log/me
 * Eigene Einträge wo actor=me ODER target=me — Schweizer-DSG-Auskunftsrecht.
 * Jeder Server-Member darf seine eigenen Einträge sehen.
 */
async function auditLogMeHandler({ request, env, params, me }, serverId) {
  if (request.method !== 'GET') return json(request, { error: 'Method not allowed' }, 405);

  const membership = await getServerMembership(env, serverId, me);
  if (!membership) return json(request, { error: 'Not a member' }, 403);

  const before = parseInt(params.get('before') || '', 10);
  const limit  = Math.min(
    Math.max(parseInt(params.get('limit') || '', 10) || AUDIT_LIMIT_DEFAULT, 1),
    AUDIT_LIMIT_MAX,
  );

  const conds = ['server_id = ?', '(actor = ? OR target = ?)'];
  const binds = [serverId, me, me];
  if (Number.isFinite(before)) { conds.push('ts < ?'); binds.push(before); }
  binds.push(limit);

  const r = await env.RENEX_DB.prepare(
    `SELECT id, actor, action, target, details_json, ts
     FROM server_audit_log
     WHERE ${conds.join(' AND ')}
     ORDER BY ts DESC
     LIMIT ?`
  ).bind(...binds).all();

  const entries = (r.results || []).map(row => ({
    id:      row.id,
    actor:   row.actor,
    action:  row.action,
    target:  row.target,
    details: row.details_json ? safeParseJson(row.details_json) : null,
    ts:      row.ts,
  }));
  const nextBefore = entries.length === limit ? entries[entries.length - 1].ts : null;

  return json(request, { entries, nextBefore, limit });
}

function safeParseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ======================================================
// CHANNEL DETAIL — PATCH (rename/topic/position) + DELETE (cascade messages)
// ======================================================

/**
 * PATCH  /servers/<sid>/channels/<cid>  — rename/topic/position
 * DELETE /servers/<sid>/channels/<cid>  — cascade messages + invalidate cache
 *
 * Permission: MANAGE_CHANNELS auf Server-Ebene.
 * Hinweis: `general`-Channel-Schutz nicht enforced — User kann jeden Channel
 * löschen. Discord schützt nur Categories. Falls später gewünscht: in DB
 * via Marker-Spalte oder im App-Layer.
 */
async function channelDetailHandler({ request, env, me }, serverId, channelId) {
  const membership = await getServerMembership(env, serverId, me);
  if (!membership) return json(request, { error: 'Not a member' }, 403);

  if (!(await userHasPermission(env, serverId, null, me, Permissions.MANAGE_CHANNELS))) {
    return json(request, { error: 'forbidden_manage_channels' }, 403);
  }

  // Channel laden + verifizieren dass er zu diesem Server gehört
  const channel = await env.RENEX_DB.prepare(
    `SELECT id, server_id, type, name, channel_kind, position, topic
     FROM conversations WHERE id = ?`
  ).bind(channelId).first();
  if (!channel || channel.server_id !== serverId || channel.type !== 'channel') {
    return json(request, { error: 'Channel not found' }, 404);
  }

  if (request.method === 'PATCH') {
    const rlErr = await checkRateLimit(env, 'channelUpdate', me, request);
    if (rlErr) return rlErr;

    const body = await readJson(request);
    if (!body) return json(request, { error: 'Invalid JSON' }, 400);

    const updates = [];
    const params  = [];
    const auditDetails = {};

    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name || name.length > MAX_CHANNEL_NAME) {
        return json(request, { error: 'Invalid channel name (1-64 chars)' }, 400);
      }
      updates.push('name = ?'); params.push(name);
      auditDetails.oldName = channel.name; auditDetails.newName = name;
    }
    if ('topic' in body) {
      const topic = body.topic == null
        ? null
        : String(body.topic).trim().slice(0, MAX_CHANNEL_TOPIC) || null;
      updates.push('topic = ?'); params.push(topic);
      auditDetails.oldTopic = channel.topic; auditDetails.newTopic = topic;
    }
    if (Number.isInteger(body.position)) {
      const pos = Math.max(0, body.position);
      updates.push('position = ?'); params.push(pos);
      auditDetails.oldPosition = channel.position; auditDetails.newPosition = pos;
    }

    if (updates.length === 0) return json(request, { ok: true, noChange: true });

    params.push(channelId);
    await env.RENEX_DB.prepare(
      `UPDATE conversations SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...params).run();

    await audit(env, serverId, me, 'channel_update', channelId, auditDetails);
    await pushToServerMembers(env, serverId, {
      id: crypto.randomUUID(), type: 'channel_renamed', serverId, channelId,
      changes: auditDetails, ts: Date.now(),
    });
    return json(request, { ok: true });
  }

  if (request.method === 'DELETE') {
    const rlErr = await checkRateLimit(env, 'channelDelete', me, request);
    if (rlErr) return rlErr;

    // Cascade: messages, channel_permission_overrides, conversation_members
    // (für Private-Channels), conversation
    await env.RENEX_DB.batch([
      env.RENEX_DB.prepare(`DELETE FROM messages WHERE convo_id = ?`).bind(channelId),
      env.RENEX_DB.prepare(`DELETE FROM channel_permission_overrides WHERE channel_id = ?`).bind(channelId),
      env.RENEX_DB.prepare(`DELETE FROM conversation_members WHERE convo_id = ?`).bind(channelId),
      env.RENEX_DB.prepare(`DELETE FROM unread_counters WHERE sender = ?`).bind(channelId),
      env.RENEX_DB.prepare(`DELETE FROM conversations WHERE id = ?`).bind(channelId),
    ]);

    // KV-Cache aufräumen
    await invalidateRecipientCache(env, serverId, channelId);
    await env.RENEX_KV.delete(`grp_members:${channelId}`).catch(() => {});

    await audit(env, serverId, me, 'channel_delete', channelId, {
      name: channel.name, kind: channel.channel_kind,
    });
    await pushToServerMembers(env, serverId, {
      id: crypto.randomUUID(), type: 'channel_deleted', serverId, channelId, ts: Date.now(),
    });
    return json(request, { ok: true });
  }

  return json(request, { error: 'Method not allowed' }, 405);
}

// ======================================================
// INVITE HANDLERS (Spec SERVERS.md §3.3 + §6.5)
// ======================================================

const MAX_INVITES_PER_SERVER = 25;

function genInviteToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `srv_inv_${hex}`;
}

/**
 * GET  /servers/<id>/invites  — Liste aktiver Invites (INVITE_MEMBERS)
 * POST /servers/<id>/invites  — Invite erstellen (INVITE_MEMBERS)
 *   Body: { maxUses?: number (0=unbegrenzt), ttlMin?: number (0/null=nie), initialRoleId?: string }
 */
async function invitesHandler({ request, env, me }, serverId) {
  const membership = await getServerMembership(env, serverId, me);
  if (!membership) return json(request, { error: 'Not a member' }, 403);
  if (!(await userHasPermission(env, serverId, null, me, Permissions.INVITE_MEMBERS))) {
    return json(request, { error: 'forbidden_invite_members' }, 403);
  }

  if (request.method === 'GET') {
    const r = await env.RENEX_DB.prepare(
      `SELECT token, created_by, initial_role_id, max_uses, uses, expires_at, created_at
       FROM server_invites WHERE server_id = ? ORDER BY created_at DESC`
    ).bind(serverId).all();
    return json(request, { invites: r.results || [] });
  }

  if (request.method === 'POST') {
    const rlErr = await checkRateLimit(env, 'inviteCreate', me, request);
    if (rlErr) return rlErr;

    const body = await readJson(request) || {};

    const maxUses = Number.isInteger(body.maxUses) ? body.maxUses : 0;
    if (maxUses < 0 || maxUses > 1000) return json(request, { error: 'Invalid maxUses (0-1000)' }, 400);

    let expiresAt = null;
    if (body.ttlMin != null && body.ttlMin !== 0) {
      const ttl = Number(body.ttlMin);
      if (!Number.isFinite(ttl) || ttl < 5 || ttl > 43200) {
        return json(request, { error: 'Invalid ttlMin (5-43200)' }, 400);
      }
      expiresAt = Date.now() + ttl * 60_000;
    }

    let initialRoleId = null;
    if (body.initialRoleId) {
      const role = await env.RENEX_DB.prepare(
        `SELECT id, is_default FROM server_roles WHERE id = ? AND server_id = ?`
      ).bind(body.initialRoleId, serverId).first();
      if (!role) return json(request, { error: 'Invalid initialRoleId' }, 400);
      // default-Role wird beim Join sowieso zugewiesen → nur non-default als Extra speichern
      if (role.is_default !== 1) initialRoleId = role.id;
    }

    const cnt = await env.RENEX_DB.prepare(
      `SELECT COUNT(*) AS c FROM server_invites WHERE server_id = ?`
    ).bind(serverId).first();
    if ((cnt?.c || 0) >= MAX_INVITES_PER_SERVER) {
      return json(request, { error: 'invite_limit_reached', limit: MAX_INVITES_PER_SERVER }, 403);
    }

    const token = genInviteToken();
    const now = Date.now();
    await env.RENEX_DB.prepare(
      `INSERT INTO server_invites (token, server_id, created_by, initial_role_id, max_uses, uses, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
    ).bind(token, serverId, me, initialRoleId, maxUses, expiresAt, now).run();

    await audit(env, serverId, me, 'invite_create', token, { maxUses, expiresAt });

    return json(request, {
      ok: true,
      token,
      url: `https://app.renex.id/?join-server=${token}`,
      maxUses, expiresAt, initialRoleId,
    });
  }

  return json(request, { error: 'Method not allowed' }, 405);
}

/**
 * DELETE /servers/<id>/invites/<token> — Invite widerrufen (INVITE_MEMBERS)
 */
async function inviteDeleteHandler({ request, env, me }, serverId, token) {
  if (request.method !== 'DELETE') return json(request, { error: 'Method not allowed' }, 405);

  const membership = await getServerMembership(env, serverId, me);
  if (!membership) return json(request, { error: 'Not a member' }, 403);
  if (!(await userHasPermission(env, serverId, null, me, Permissions.INVITE_MEMBERS))) {
    return json(request, { error: 'forbidden_invite_members' }, 403);
  }

  const res = await env.RENEX_DB.prepare(
    `DELETE FROM server_invites WHERE token = ? AND server_id = ?`
  ).bind(token, serverId).run();
  if ((res.meta?.changes ?? 0) === 0) return json(request, { error: 'Invite not found' }, 404);

  await audit(env, serverId, me, 'invite_revoke', token, null);
  return json(request, { ok: true });
}

/**
 * GET  /servers/join/<token>  — Invite-Vorschau (eingeloggter User, noch kein Member)
 * POST /servers/join/<token>  — Server beitreten: server_members + default-Role,
 *   Use-Count++, WS server_member_joined, Audit, Recipient-Cache-Invalidate.
 *   GSK-Distribution erfolgt pull-based via request_gsk (Spec §5) beim Channel-Open.
 */
async function joinByTokenHandler({ request, env, me }, token) {
  const inv = await env.RENEX_DB.prepare(
    `SELECT token, server_id, created_by, initial_role_id, max_uses, uses, expires_at
     FROM server_invites WHERE token = ?`
  ).bind(token).first();
  if (!inv) return json(request, { error: 'invite_not_found' }, 404);
  if (inv.expires_at != null && Date.now() > inv.expires_at) {
    return json(request, { error: 'invite_expired' }, 410);
  }
  if (inv.max_uses > 0 && inv.uses >= inv.max_uses) {
    return json(request, { error: 'invite_used_up' }, 410);
  }

  const server = await env.RENEX_DB.prepare(
    `SELECT id, name, description, member_limit FROM servers WHERE id = ?`
  ).bind(inv.server_id).first();
  if (!server) return json(request, { error: 'server_gone' }, 404);

  const memberCountRow = await env.RENEX_DB.prepare(
    `SELECT COUNT(*) AS c FROM server_members WHERE server_id = ?`
  ).bind(inv.server_id).first();
  const memberCount = memberCountRow?.c || 0;
  const alreadyMember = !!(await getServerMembership(env, inv.server_id, me));

  // Ban-Check (Phase 3A.5): gebannte User sehen weder Invite-Detail noch joinen
  const ban = await env.RENEX_DB.prepare(
    `SELECT reason FROM server_bans WHERE server_id = ? AND user_handle = ?`
  ).bind(inv.server_id, me).first();
  if (ban) {
    return json(request, { error: 'user_banned', reason: ban.reason }, 403);
  }

  if (request.method === 'GET') {
    return json(request, {
      serverId: server.id,
      name: server.name,
      description: server.description,
      memberCount,
      inviterHandle: inv.created_by,
      alreadyMember,
    });
  }

  if (request.method === 'POST') {
    const rlErr = await checkRateLimit(env, 'serverJoin', me, request);
    if (rlErr) return rlErr;

    if (alreadyMember) {
      return json(request, { ok: true, serverId: server.id, alreadyMember: true });
    }
    if (memberCount >= (server.member_limit || 1000)) {
      return json(request, { error: 'server_full' }, 403);
    }

    const defRole = await env.RENEX_DB.prepare(
      `SELECT id FROM server_roles WHERE server_id = ? AND is_default = 1`
    ).bind(inv.server_id).first();

    const now = Date.now();
    const stmts = [
      env.RENEX_DB.prepare(
        `INSERT OR IGNORE INTO server_members (server_id, user_handle, joined_at, is_owner)
         VALUES (?, ?, ?, 0)`
      ).bind(inv.server_id, me, now),
    ];
    if (defRole?.id) {
      stmts.push(env.RENEX_DB.prepare(
        `INSERT OR IGNORE INTO role_assignments (server_id, user_handle, role_id, assigned_at)
         VALUES (?, ?, ?, ?)`
      ).bind(inv.server_id, me, defRole.id, now));
    }
    if (inv.initial_role_id) {
      stmts.push(env.RENEX_DB.prepare(
        `INSERT OR IGNORE INTO role_assignments (server_id, user_handle, role_id, assigned_at)
         VALUES (?, ?, ?, ?)`
      ).bind(inv.server_id, me, inv.initial_role_id, now));
    }
    stmts.push(env.RENEX_DB.prepare(
      `UPDATE server_invites SET uses = uses + 1 WHERE token = ?`
    ).bind(token));
    await env.RENEX_DB.batch(stmts);

    await invalidateRecipientCache(env, inv.server_id);
    await audit(env, inv.server_id, me, 'member_join', me, { via: 'invite', token });
    await pushToServerMembers(env, inv.server_id, {
      id: crypto.randomUUID(), type: 'server_member_joined',
      serverId: inv.server_id, handle: me, ts: now,
    }, me);

    return json(request, { ok: true, serverId: server.id });
  }

  return json(request, { error: 'Method not allowed' }, 405);
}
