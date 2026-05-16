// ======================================================
// RENEX Permissions — Bitfield + Resolution-Algorithmus
// ======================================================
// Spec: docs/SERVERS.md §5
//
// DIESES FILE MUSS IDENTISCH SEIN ZU frontend/src/lib/permissions.js
// — pure JS ohne Imports, damit 1:1 kopierbar zwischen Backend (Worker)
// und Frontend (Vite/Svelte). Sync-Check via Test in
// tests/serverPermissions.test.js (siehe Test "Backend === Frontend").
//
// Backend ist die AUTORITATIVE Quelle. Frontend-Checks sind UX-Optimierung
// (UI-Hiding) — Backend MUSS bei jeder Permission-relevanten Aktion
// gegenchecken.
// ======================================================

/**
 * Permission-Bits. Discord-inspired, reduziert auf Beta-relevante Bits.
 * Forward-Compat: neue Bits werden hier angehängt, alte NIE umnummeriert.
 */
export const Permissions = {
  VIEW_CHANNEL:     0x0001,
  SEND_MESSAGES:    0x0002,
  MANAGE_MESSAGES:  0x0004,  // pin, delete others' messages
  MANAGE_CHANNELS:  0x0008,  // create/delete/rename channels
  KICK_MEMBERS:     0x0010,
  BAN_MEMBERS:      0x0020,
  MANAGE_SERVER:    0x0040,  // name, icon, description, invites
  MANAGE_ROLES:     0x0080,
  INVITE_MEMBERS:   0x0100,
  VOICE_CONNECT:    0x0200,  // Phase 8 — voice deferred
  VOICE_SPEAK:      0x0400,  // Phase 8
  MENTION_EVERYONE: 0x0800,
  ADMINISTRATOR:    0x1000,  // bypass alles ausser Owner-only-Aktionen (Server-Delete, Transfer)
};

/** Alle bekannten Bits OR-verknüpft (für Owner-Bypass + Bitfield-Validierung). */
export const ALL_PERMISSIONS = Object.values(Permissions).reduce((a, b) => a | b, 0);

/**
 * Resolve effective permissions for a user in a channel.
 *
 * Algorithmus (Spec §5.3):
 *   1. Owner-Short-Circuit → ALL_PERMISSIONS
 *   2. Base = OR aller Role-Permissions
 *   3. ADMINISTRATOR-Bit → ALL_PERMISSIONS
 *   4. Channel-Overrides anwenden in Order: role-deny, role-allow, member-deny, member-allow
 *
 * @param {object} ctx
 * @param {boolean} ctx.isOwner — server_members.is_owner=1?
 * @param {Array<{id: string, permissions: number}>} ctx.roles — Roles des Users (aus role_assignments JOIN server_roles)
 * @param {Array<{target_kind: 'role'|'member', target_id: string, allow_bits: number, deny_bits: number}>} ctx.overrides
 *        — channel_permission_overrides für DIESEN Channel (gefiltert)
 * @param {string} ctx.userHandle — für member-override matching
 * @returns {number} effective permission bitfield (unsigned 32-bit)
 */
export function resolvePermissions(ctx) {
  // 1. Owner-Bypass
  if (ctx.isOwner) return ALL_PERMISSIONS;

  // 2. Base = OR aller Role-Permissions
  let base = 0;
  const userRoleIds = new Set();
  for (const r of ctx.roles || []) {
    base |= (r.permissions | 0);
    userRoleIds.add(r.id);
  }

  // 3. ADMINISTRATOR = alles ausser Owner-Aktionen
  if (base & Permissions.ADMINISTRATOR) return ALL_PERMISSIONS;

  // 4. Channel-Overrides aggregieren
  let roleAllow = 0, roleDeny = 0;
  let memberAllow = 0, memberDeny = 0;

  for (const ov of ctx.overrides || []) {
    const allow = ov.allow_bits | 0;
    const deny  = ov.deny_bits  | 0;
    if (ov.target_kind === 'role' && userRoleIds.has(ov.target_id)) {
      roleAllow |= allow;
      roleDeny  |= deny;
    } else if (ov.target_kind === 'member' && ov.target_id === ctx.userHandle) {
      memberAllow |= allow;
      memberDeny  |= deny;
    }
  }

  // Apply-Order (Spec §5.3):
  //   final = base
  //   final &= ~roleDeny   ← role-deny gewinnt über base
  //   final |= roleAllow   ← role-allow gewinnt über role-deny
  //   final &= ~memberDeny ← member-deny gewinnt über role-allow
  //   final |= memberAllow ← member-allow gewinnt über alles
  let final = base;
  final &= ~roleDeny;
  final |= roleAllow;
  final &= ~memberDeny;
  final |= memberAllow;

  return final >>> 0; // Force unsigned
}

/**
 * Check ob User eine bestimmte Permission im Channel hat.
 *
 * @param {object} ctx — siehe resolvePermissions
 * @param {number} wanted — Permissions.SEND_MESSAGES etc.
 * @returns {boolean}
 */
export function hasPermission(ctx, wanted) {
  const eff = resolvePermissions(ctx);
  return (eff & wanted) === wanted;
}

/**
 * Anti-Privilege-Escalation: darf actor eine Role auf targetPosition
 * erstellen/ändern/zuweisen?
 *
 * Regel (Discord-Standard): Actor darf NUR Roles mit STRIKT NIEDRIGERER
 * Position als seine eigene höchste Role manipulieren. Owner bypassed.
 *
 * @param {number} actorMaxPosition — höchste Role-Position des Actors
 *                                    (oder 0 wenn keine Roles)
 * @param {number} targetPosition — Position der Ziel-Role
 * @param {boolean} actorIsOwner
 * @returns {boolean}
 */
export function canManageRoleAtPosition(actorMaxPosition, targetPosition, actorIsOwner) {
  if (actorIsOwner) return true;
  return (targetPosition | 0) < (actorMaxPosition | 0);
}

/**
 * Sanitize raw bitfield from untrusted input (Frontend, API-Body).
 * Schneidet unbekannte Bits weg → Forward-Compat-Schutz.
 *
 * @param {number} rawBits
 * @returns {number}
 */
export function sanitizeBits(rawBits) {
  return ((rawBits | 0) & ALL_PERMISSIONS) >>> 0;
}

/**
 * Default-Permissions für die `everyone`-Role bei Server-Create.
 * Member kann Channels sehen, schreiben, Voice (Phase 8) beitreten.
 */
export const DEFAULT_EVERYONE_PERMISSIONS =
  Permissions.VIEW_CHANNEL |
  Permissions.SEND_MESSAGES |
  Permissions.VOICE_CONNECT |
  Permissions.VOICE_SPEAK;

/**
 * Default-Permissions für „Moderator"-Vorschlag-Role (Server-Create-Helper).
 * Wird nicht automatisch angelegt — Spec sagt nur `everyone` ist Pflicht.
 */
export const DEFAULT_MODERATOR_PERMISSIONS =
  DEFAULT_EVERYONE_PERMISSIONS |
  Permissions.KICK_MEMBERS |
  Permissions.MANAGE_MESSAGES;
