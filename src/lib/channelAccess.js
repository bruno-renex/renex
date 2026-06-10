// ======================================================
// RENEX — Channel-Access-Resolution (DB-backed, Phase 4b / C2-Fix)
// ======================================================
// Server-seitige Durchsetzung von VIEW_CHANNEL/SEND_MESSAGES auf der
// Message-Ebene (Send / History / Recipient-Set / GSK). Ergänzt den reinen
// List-Filter `getVisibleChannelIds` aus serverRoutes.js — der filtert nur die
// Channel-Liste, NICHT die Nachrichten-Pfade.
//
// Eigene Datei (nicht in serverRoutes.js), weil auth.js (getConvoMembersWithType)
// diese Helfer braucht und auth.js NICHT von serverRoutes.js importieren darf
// (Zyklus: serverRoutes.js → auth.js). lib/permissions.js ist pure → kein Zyklus.
// ======================================================
import { resolvePermissions, Permissions, ALL_PERMISSIONS } from './permissions.js';

/**
 * Effektive Channel-Permissions eines Users auflösen (DB-gestützt).
 *
 * @param {D1Database} db
 * @param {string} channelId  conversations.id
 * @param {string} handle
 * @returns {Promise<number|null>} Bitfield; 0 wenn kein Server-Member;
 *   null wenn die convoId KEIN Server-Channel ist (DM/Group → kein Channel-Gate).
 */
export async function resolveChannelPerms(db, channelId, handle) {
  const convo = await db.prepare(
    "SELECT type, server_id FROM conversations WHERE id = ?"
  ).bind(channelId).first();
  if (!convo || convo.type !== 'channel' || !convo.server_id) return null;

  const m = await db.prepare(
    "SELECT is_owner FROM server_members WHERE server_id = ? AND user_handle = ?"
  ).bind(convo.server_id, handle).first();
  if (!m) return 0;                       // kein Member ⇒ kein Zugriff
  if (m.is_owner === 1) return ALL_PERMISSIONS;

  const ovRes = await db.prepare(
    "SELECT target_kind, target_id, allow_bits, deny_bits FROM channel_permission_overrides WHERE channel_id = ?"
  ).bind(channelId).all();
  const overrides = ovRes.results || [];

  // Fast-Path: Channel OHNE Overrides ist nicht eingeschränkt → Zugriff = Membership
  // (exakt wie vor C2). KRITISCH: ein Member ohne explizite everyone-Role-Zuweisung
  // würde sonst fälschlich VIEW/SEND verlieren — das blockiert u.a. den GSK-Handshake
  // (request_gsk/gsk) und macht Channel-Nachrichten unentschlüsselbar. Restriktionen
  // gelten ausschließlich über Overrides (private / read-only Channels).
  if (overrides.length === 0) {
    return Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;
  }

  const rolesRes = await db.prepare(
    "SELECT sr.id, sr.permissions FROM role_assignments ra JOIN server_roles sr ON ra.role_id = sr.id WHERE ra.server_id = ? AND ra.user_handle = ?"
  ).bind(convo.server_id, handle).all();

  return resolvePermissions({
    isOwner:    false,
    roles:      rolesRes.results || [],
    overrides,
    userHandle: handle,
  });
}

/**
 * Darf `handle` diesen Channel sehen (VIEW_CHANNEL)?
 *
 * @returns {Promise<boolean|null>} null wenn keine Server-Channel-convoId
 *   (Aufrufer behandelt das als "kein Channel-Gate, bestehende Logik gilt").
 */
export async function canViewChannel(db, channelId, handle) {
  const eff = await resolveChannelPerms(db, channelId, handle);
  if (eff === null) return null;
  return (eff & Permissions.VIEW_CHANNEL) === Permissions.VIEW_CHANNEL;
}

/**
 * Handles aller Server-Member, die diesen Channel sehen dürfen (Recipient-Set
 * für Broadcasts/GSK). Ersetzt das frühere "alle server_members".
 *
 * Fast-Path: Channel OHNE Overrides → alle Member (everyone hat VIEW_CHANNEL per
 *   Default). Kein per-Member-Resolve, nur 2 Queries.
 * Slow-Path (nur Channels MIT Overrides = private/Spezial): per-Member-Resolution;
 *   alle Role-Assignments des Servers in EINER Query (kein N+1).
 *
 * @returns {Promise<string[]>}
 */
export async function getChannelViewerHandles(db, serverId, channelId) {
  const [ovRes, memRes] = await Promise.all([
    db.prepare(
      "SELECT target_kind, target_id, allow_bits, deny_bits FROM channel_permission_overrides WHERE channel_id = ?"
    ).bind(channelId).all(),
    db.prepare(
      "SELECT user_handle, is_owner FROM server_members WHERE server_id = ?"
    ).bind(serverId).all(),
  ]);

  const overrides = ovRes.results  || [];
  const members   = memRes.results || [];

  // Fast-Path: keine Overrides ⇒ keine VIEW-Einschränkung ⇒ alle Member
  if (overrides.length === 0) {
    return members.map(m => m.user_handle);
  }

  // Slow-Path: alle Role-Assignments des Servers in einer Query (kein N+1)
  const raRes = await db.prepare(
    "SELECT ra.user_handle, sr.id, sr.permissions FROM role_assignments ra JOIN server_roles sr ON ra.role_id = sr.id WHERE ra.server_id = ?"
  ).bind(serverId).all();

  const rolesByUser = new Map();
  for (const r of (raRes.results || [])) {
    if (!rolesByUser.has(r.user_handle)) rolesByUser.set(r.user_handle, []);
    rolesByUser.get(r.user_handle).push({ id: r.id, permissions: r.permissions });
  }

  const viewers = [];
  for (const mem of members) {
    if (mem.is_owner === 1) { viewers.push(mem.user_handle); continue; }
    const eff = resolvePermissions({
      isOwner:    false,
      roles:      rolesByUser.get(mem.user_handle) || [],
      overrides,
      userHandle: mem.user_handle,
    });
    if ((eff & Permissions.VIEW_CHANNEL) === Permissions.VIEW_CHANNEL) {
      viewers.push(mem.user_handle);
    }
  }
  return viewers;
}
