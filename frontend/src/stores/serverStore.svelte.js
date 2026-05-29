// ======================================================
// serverStore — Reactive Store für Phase 3A Servers
// ======================================================
// Spec: docs/SERVERS.md §6 (API-Surface)
//
// State:
//   - servers: Array<{ id, name, description, iconR2Key, memberCount, isOwner, createdAt }>
//   - selectedServerId: string | null
//   - selectedServerDetail: { server, channels[], roles[], members[], myMembership, myServerPermissions } | null
//   - isLoading: boolean
//   - errorMsg: string | null
//
// Public API:
//   loadServers()             — refresh /servers/list
//   selectServer(id)          — set selected + lazy-load detail
//   createServer({name,...})  — POST /servers/create + reload
//   leaveServer(id)           — POST /servers/<id>/leave + reload
//   reset()                   — clear all state (logout)
// ======================================================

import { apiFetch } from '../lib/api.js';
import { captureException } from '../lib/sentry.js';

let _servers              = $state([]);
let _selectedServerId     = $state(null);
let _selectedServerDetail = $state(null);
let _isLoading            = $state(false);
let _errorMsg             = $state(null);

// Cache: alle bekannten Channels (id → {serverId, name}) aus allen besuchten
// Server-Detail-Loads. Wird vom device_added-Hook in App.svelte gelesen für
// Multi-Device-GSK-Distribution (Spec: GROUPS_MULTIDEVICE.md §4.1, channel-Variante).
const _knownChannels = new Map();

function _indexChannelsFromDetail(detail) {
  if (!detail?.channels || !detail?.server?.id) return;
  for (const c of detail.channels) {
    if (c.id) _knownChannels.set(c.id, { serverId: detail.server.id, name: c.name });
  }
}

async function loadServers() {
  _isLoading = true;
  _errorMsg = null;
  try {
    const r = await apiFetch('/servers/list');
    if (r.ok && Array.isArray(r.data?.servers)) {
      _servers = r.data.servers;
    } else {
      _errorMsg = r.error || 'load_failed';
    }
  } catch (e) {
    captureException(e, { context: 'serverStore.loadServers' });
    _errorMsg = e?.message || 'load_failed';
  } finally {
    _isLoading = false;
  }
}

async function loadServerDetail(serverId) {
  if (!serverId) return;
  try {
    const r = await apiFetch(`/servers/${encodeURIComponent(serverId)}`);
    if (r.ok && r.data?.server) {
      _selectedServerDetail = r.data;
      _indexChannelsFromDetail(r.data);
    } else {
      _errorMsg = r.error || 'detail_failed';
      _selectedServerDetail = null;
    }
  } catch (e) {
    captureException(e, { context: 'serverStore.loadServerDetail', extra: { serverId } });
    _errorMsg = e?.message || 'detail_failed';
    _selectedServerDetail = null;
  }
}

/**
 * Liefert alle bekannten Channels (aus besuchten Server-Details).
 * Verwendung: App.svelte device_added-Hook für GSK-Distribution.
 * Hinweis: unvollständig — User muss Server geöffnet haben, damit dessen
 * Channels gecached sind. Self-Healing via `request_gsk` Control-Message
 * deckt nicht-gecachte Channels automatisch beim nächsten Decrypt-Attempt ab.
 *
 * @returns {Array<{id, serverId, name}>}
 */
function getKnownChannels() {
  return Array.from(_knownChannels.entries()).map(([id, info]) => ({
    id,
    serverId: info.serverId,
    name:     info.name,
  }));
}

/**
 * Lookup für einen einzelnen Channel aus dem Cache besuchter Server-Details.
 * @param {string} channelId
 * @returns {{serverId: string, name: string}|null}
 */
function getChannelInfo(channelId) {
  if (!channelId) return null;
  return _knownChannels.get(channelId) || null;
}

function selectServer(id) {
  _selectedServerId = id;
  _selectedServerDetail = null; // clear stale data
  if (id) void loadServerDetail(id);
}

async function createServer({ name, description }) {
  if (!name?.trim()) return { ok: false, error: 'name_required' };
  try {
    const r = await apiFetch('/servers/create', {
      method: 'POST',
      body: { name: name.trim(), description: description?.trim() || null },
    });
    if (r.ok && r.data?.serverId) {
      await loadServers();
      selectServer(r.data.serverId);
      return { ok: true, serverId: r.data.serverId };
    }
    return { ok: false, error: r.error || 'create_failed' };
  } catch (e) {
    captureException(e, { context: 'serverStore.createServer' });
    return { ok: false, error: e?.message || 'create_failed' };
  }
}

// ── Role Management (Phase 3A backend ready) ──────────

async function createRole(serverId, { name, color, permissions, position, isMentionable }) {
  try {
    const r = await apiFetch(`/servers/${encodeURIComponent(serverId)}/roles`, {
      method: 'POST',
      body: { name, color, permissions, position, isMentionable },
    });
    if (r.ok && r.data?.roleId) {
      await loadServerDetail(serverId); // Refresh
      return { ok: true, roleId: r.data.roleId };
    }
    return { ok: false, error: r.error || 'create_role_failed' };
  } catch (e) {
    captureException(e, { context: 'serverStore.createRole', extra: { serverId } });
    return { ok: false, error: e?.message || 'create_role_failed' };
  }
}

async function updateServer(serverId, partial) {
  try {
    const r = await apiFetch(`/servers/${encodeURIComponent(serverId)}`, {
      method: 'PATCH',
      body: partial,
    });
    if (r.ok) {
      await loadServerDetail(serverId);
      await loadServers();
      return { ok: true, changes: r.data?.changes };
    }
    return { ok: false, error: r.error || 'update_failed' };
  } catch (e) {
    captureException(e, { context: 'serverStore.updateServer', extra: { serverId } });
    return { ok: false, error: e?.message || 'update_failed' };
  }
}

async function uploadServerIcon(serverId, file) {
  try {
    const bytes = await file.arrayBuffer();
    const r = await apiFetch(`/servers/${encodeURIComponent(serverId)}/icon`, {
      method: 'POST',
      body: bytes,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
    });
    if (r.ok) {
      await loadServerDetail(serverId);
      await loadServers();
      return { ok: true, iconR2Key: r.data?.iconR2Key };
    }
    return { ok: false, error: r.error || 'icon_upload_failed' };
  } catch (e) {
    captureException(e, { context: 'serverStore.uploadServerIcon', extra: { serverId } });
    return { ok: false, error: e?.message || 'icon_upload_failed' };
  }
}

async function deleteServerIcon(serverId) {
  try {
    const r = await apiFetch(`/servers/${encodeURIComponent(serverId)}/icon`, {
      method: 'DELETE',
    });
    if (r.ok) {
      await loadServerDetail(serverId);
      await loadServers();
      return { ok: true };
    }
    return { ok: false, error: r.error || 'icon_delete_failed' };
  } catch (e) {
    captureException(e, { context: 'serverStore.deleteServerIcon', extra: { serverId } });
    return { ok: false, error: e?.message || 'icon_delete_failed' };
  }
}

async function updateRole(serverId, roleId, partial) {
  try {
    const r = await apiFetch(`/servers/${encodeURIComponent(serverId)}/roles/${encodeURIComponent(roleId)}`, {
      method: 'PATCH',
      body: partial,
    });
    if (r.ok) {
      await loadServerDetail(serverId);
      return { ok: true };
    }
    return { ok: false, error: r.error || 'update_role_failed' };
  } catch (e) {
    captureException(e, { context: 'serverStore.updateRole', extra: { serverId, roleId } });
    return { ok: false, error: e?.message || 'update_role_failed' };
  }
}

async function deleteRole(serverId, roleId) {
  try {
    const r = await apiFetch(`/servers/${encodeURIComponent(serverId)}/roles/${encodeURIComponent(roleId)}`, {
      method: 'DELETE',
    });
    if (r.ok) {
      await loadServerDetail(serverId);
      return { ok: true };
    }
    return { ok: false, error: r.error || 'delete_role_failed' };
  } catch (e) {
    captureException(e, { context: 'serverStore.deleteRole', extra: { serverId, roleId } });
    return { ok: false, error: e?.message || 'delete_role_failed' };
  }
}

async function assignRole(serverId, handle, roleId) {
  try {
    const r = await apiFetch(`/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(handle)}/roles`, {
      method: 'POST',
      body: { roleId },
    });
    if (r.ok) {
      await loadServerDetail(serverId);
      return { ok: true };
    }
    return { ok: false, error: r.error || 'assign_role_failed' };
  } catch (e) {
    captureException(e, { context: 'serverStore.assignRole', extra: { serverId, handle, roleId } });
    return { ok: false, error: e?.message || 'assign_role_failed' };
  }
}

async function revokeRole(serverId, handle, roleId) {
  try {
    const r = await apiFetch(`/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(handle)}/roles/${encodeURIComponent(roleId)}`, {
      method: 'DELETE',
    });
    if (r.ok) {
      await loadServerDetail(serverId);
      return { ok: true };
    }
    return { ok: false, error: r.error || 'revoke_role_failed' };
  } catch (e) {
    captureException(e, { context: 'serverStore.revokeRole', extra: { serverId, handle, roleId } });
    return { ok: false, error: e?.message || 'revoke_role_failed' };
  }
}

// Phase 3A.5: Ban-Event-Version — wird in App.svelte hochgezählt wenn WS
// server_member_banned/unbanned ankommt. ServerSettingsModal beobachtet
// das, um die Banned-Liste live nachzuladen ohne Tab-Click.
let _banEventVersion = $state(0);

function incrementBanEventVersion() {
  _banEventVersion++;
}

async function banMember(serverId, handle, reason = null) {
  try {
    const r = await apiFetch(`/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(handle)}/ban`, {
      method: 'POST',
      body: reason ? { reason } : {},
    });
    if (r.ok) {
      await loadServerDetail(serverId);
      await loadServers();
      return { ok: true };
    }
    return { ok: false, error: r.error || 'ban_failed' };
  } catch (e) {
    captureException(e, { context: 'serverStore.banMember', extra: { serverId, handle } });
    return { ok: false, error: e?.message || 'ban_failed' };
  }
}

async function listBans(serverId) {
  try {
    const r = await apiFetch(`/servers/${encodeURIComponent(serverId)}/bans`);
    if (r.ok && Array.isArray(r.data?.bans)) {
      return { ok: true, bans: r.data.bans };
    }
    return { ok: false, error: r.error || 'list_bans_failed' };
  } catch (e) {
    captureException(e, { context: 'serverStore.listBans', extra: { serverId } });
    return { ok: false, error: e?.message || 'list_bans_failed' };
  }
}

async function unbanMember(serverId, handle) {
  try {
    const r = await apiFetch(`/servers/${encodeURIComponent(serverId)}/bans/${encodeURIComponent(handle)}`, {
      method: 'DELETE',
    });
    if (r.ok) {
      return { ok: true };
    }
    return { ok: false, error: r.error || 'unban_failed' };
  } catch (e) {
    captureException(e, { context: 'serverStore.unbanMember', extra: { serverId, handle } });
    return { ok: false, error: e?.message || 'unban_failed' };
  }
}

async function leaveServer(serverId) {
  try {
    const r = await apiFetch(`/servers/${encodeURIComponent(serverId)}/leave`, {
      method: 'POST',
    });
    if (r.ok) {
      if (_selectedServerId === serverId) selectServer(null);
      await loadServers();
      return { ok: true, serverDeleted: r.data?.serverDeleted === true };
    }
    return { ok: false, error: r.error || 'leave_failed' };
  } catch (e) {
    captureException(e, { context: 'serverStore.leaveServer' });
    return { ok: false, error: e?.message || 'leave_failed' };
  }
}

// ── Invites (Phase 3A — Server-Join via Token-Link) ──

async function createInvite(serverId, { maxUses = 0, ttlMin = 0, initialRoleId = null } = {}) {
  try {
    const r = await apiFetch(`/servers/${encodeURIComponent(serverId)}/invites`, {
      method: 'POST',
      body: { maxUses, ttlMin, initialRoleId },
    });
    if (r.ok && r.data?.token) {
      return { ok: true, token: r.data.token, url: r.data.url };
    }
    return { ok: false, error: r.error || 'invite_create_failed' };
  } catch (e) {
    captureException(e, { context: 'serverStore.createInvite', extra: { serverId } });
    return { ok: false, error: e?.message || 'invite_create_failed' };
  }
}

async function getInviteInfo(token) {
  try {
    const r = await apiFetch(`/servers/join/${encodeURIComponent(token)}`);
    if (r.ok) return { ok: true, info: r.data };
    return { ok: false, error: r.error || 'invite_info_failed' };
  } catch (e) {
    captureException(e, { context: 'serverStore.getInviteInfo' });
    return { ok: false, error: e?.message || 'invite_info_failed' };
  }
}

async function listInvites(serverId) {
  try {
    const r = await apiFetch(`/servers/${encodeURIComponent(serverId)}/invites`);
    if (r.ok && Array.isArray(r.data?.invites)) return { ok: true, invites: r.data.invites };
    return { ok: false, error: r.error || 'list_invites_failed' };
  } catch (e) {
    captureException(e, { context: 'serverStore.listInvites', extra: { serverId } });
    return { ok: false, error: e?.message || 'list_invites_failed' };
  }
}

async function deleteInvite(serverId, token) {
  try {
    const r = await apiFetch(`/servers/${encodeURIComponent(serverId)}/invites/${encodeURIComponent(token)}`, {
      method: 'DELETE',
    });
    if (r.ok) return { ok: true };
    return { ok: false, error: r.error || 'delete_invite_failed' };
  } catch (e) {
    captureException(e, { context: 'serverStore.deleteInvite', extra: { serverId, token } });
    return { ok: false, error: e?.message || 'delete_invite_failed' };
  }
}

async function joinByToken(token) {
  try {
    const r = await apiFetch(`/servers/join/${encodeURIComponent(token)}`, { method: 'POST' });
    if (r.ok && r.data?.serverId) {
      await loadServers();
      selectServer(r.data.serverId);
      return { ok: true, serverId: r.data.serverId, alreadyMember: r.data.alreadyMember === true };
    }
    return { ok: false, error: r.error || 'join_failed' };
  } catch (e) {
    captureException(e, { context: 'serverStore.joinByToken' });
    return { ok: false, error: e?.message || 'join_failed' };
  }
}

function reset() {
  _servers = [];
  _selectedServerId = null;
  _selectedServerDetail = null;
  _isLoading = false;
  _errorMsg = null;
}

export const serverStore = {
  get servers()              { return _servers; },
  get selectedServerId()     { return _selectedServerId; },
  get selectedServerDetail() { return _selectedServerDetail; },
  get isLoading()            { return _isLoading; },
  get errorMsg()             { return _errorMsg; },

  loadServers,
  loadServerDetail,
  selectServer,
  createServer,
  updateServer,
  uploadServerIcon,
  deleteServerIcon,
  banMember,
  listBans,
  unbanMember,
  incrementBanEventVersion,
  get banEventVersion() { return _banEventVersion; },
  leaveServer,
  createRole,
  updateRole,
  deleteRole,
  assignRole,
  revokeRole,
  getKnownChannels,
  getChannelInfo,
  createInvite,
  listInvites,
  deleteInvite,
  getInviteInfo,
  joinByToken,
  reset,
};
