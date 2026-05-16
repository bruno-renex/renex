// ======================================================
// Unit-Tests für Server-Permissions (Bitfield + Resolution)
// ======================================================
// Spec: docs/SERVERS.md §5
//
// Test-Vorschriften aus Spec §5.4:
//   1. Member mit MANAGE_ROLES Position=50 versucht Role Position=100 → 403
//   2. dito versucht Role Position=50 → 403 (gleich, nicht erlaubt)
//   3. dito versucht Role Position=49 → 200
//   4. Owner bypassed alle Checks → 200 für Position=999
//   5. Permissions-Overrides kombiniert: role-deny gewinnt über role-allow,
//      member-deny gewinnt über role-deny, member-allow gewinnt über alles
//
// Plus:
//   - Bitfield-Konstanten Konsistenz Backend ↔ Frontend
//   - resolvePermissions Owner-Bypass
//   - ADMINISTRATOR-Bit
//   - sanitizeBits Forward-Compat
// ======================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Permissions,
  ALL_PERMISSIONS,
  resolvePermissions,
  hasPermission,
  canManageRoleAtPosition,
  sanitizeBits,
  DEFAULT_EVERYONE_PERMISSIONS,
  DEFAULT_MODERATOR_PERMISSIONS,
} from '../src/lib/permissions.js';

// ──────────────────────────────────────────────────────
// Sync-Check: Backend ↔ Frontend müssen byte-identisch sein
// ──────────────────────────────────────────────────────
describe('Backend === Frontend (permissions.js)', () => {
  it('src/lib/permissions.js und frontend/src/lib/permissions.js sind byte-identisch', () => {
    const backend  = readFileSync(resolve(__dirname, '../src/lib/permissions.js'), 'utf8');
    const frontend = readFileSync(resolve(__dirname, '../frontend/src/lib/permissions.js'), 'utf8');
    expect(backend).toBe(frontend);
  });
});

// ──────────────────────────────────────────────────────
// Bitfield-Konstanten
// ──────────────────────────────────────────────────────
describe('Permission-Bitfield', () => {
  it('alle Bits sind unique Powers of 2', () => {
    const bits = Object.values(Permissions);
    const set = new Set(bits);
    expect(set.size).toBe(bits.length);
    for (const b of bits) {
      // Power of 2: nur ein Bit gesetzt
      expect((b & (b - 1)) === 0 && b > 0).toBe(true);
    }
  });

  it('ALL_PERMISSIONS enthält alle definierten Bits', () => {
    for (const b of Object.values(Permissions)) {
      expect(ALL_PERMISSIONS & b).toBe(b);
    }
  });

  it('VIEW_CHANNEL und SEND_MESSAGES sind in DEFAULT_EVERYONE', () => {
    expect(DEFAULT_EVERYONE_PERMISSIONS & Permissions.VIEW_CHANNEL).toBe(Permissions.VIEW_CHANNEL);
    expect(DEFAULT_EVERYONE_PERMISSIONS & Permissions.SEND_MESSAGES).toBe(Permissions.SEND_MESSAGES);
  });

  it('DEFAULT_MODERATOR enthält KICK_MEMBERS aber NICHT BAN_MEMBERS', () => {
    expect(DEFAULT_MODERATOR_PERMISSIONS & Permissions.KICK_MEMBERS).toBe(Permissions.KICK_MEMBERS);
    expect(DEFAULT_MODERATOR_PERMISSIONS & Permissions.BAN_MEMBERS).toBe(0);
  });
});

// ──────────────────────────────────────────────────────
// resolvePermissions — Owner-Bypass
// ──────────────────────────────────────────────────────
describe('resolvePermissions — Owner-Bypass', () => {
  it('Owner hat ALL_PERMISSIONS, ignoriert Roles und Overrides', () => {
    const ctx = {
      isOwner: true,
      roles: [], // KEINE Roles
      overrides: [
        { target_kind: 'member', target_id: 'bertha004', allow_bits: 0, deny_bits: ALL_PERMISSIONS },
      ],
      userHandle: 'bertha004',
    };
    expect(resolvePermissions(ctx)).toBe(ALL_PERMISSIONS);
    expect(hasPermission(ctx, Permissions.BAN_MEMBERS)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────
// resolvePermissions — Base aus Roles
// ──────────────────────────────────────────────────────
describe('resolvePermissions — Base aus Role-Aggregation', () => {
  it('Member ohne Roles hat keine Permissions', () => {
    const ctx = { isOwner: false, roles: [], overrides: [], userHandle: 'eve' };
    expect(resolvePermissions(ctx)).toBe(0);
  });

  it('Member mit einer Role bekommt deren Permissions', () => {
    const ctx = {
      isOwner: false,
      roles: [{ id: 'r1', permissions: Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES }],
      overrides: [],
      userHandle: 'bertha004',
    };
    expect(hasPermission(ctx, Permissions.VIEW_CHANNEL)).toBe(true);
    expect(hasPermission(ctx, Permissions.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(ctx, Permissions.KICK_MEMBERS)).toBe(false);
  });

  it('Mehrere Roles werden OR-aggregiert', () => {
    const ctx = {
      isOwner: false,
      roles: [
        { id: 'r1', permissions: Permissions.VIEW_CHANNEL },
        { id: 'r2', permissions: Permissions.KICK_MEMBERS },
      ],
      overrides: [],
      userHandle: 'bertha004',
    };
    expect(hasPermission(ctx, Permissions.VIEW_CHANNEL)).toBe(true);
    expect(hasPermission(ctx, Permissions.KICK_MEMBERS)).toBe(true);
    expect(hasPermission(ctx, Permissions.BAN_MEMBERS)).toBe(false);
  });

  it('ADMINISTRATOR-Bit gewährt alle Permissions ausser Owner', () => {
    const ctx = {
      isOwner: false,
      roles: [{ id: 'admin', permissions: Permissions.ADMINISTRATOR }],
      overrides: [
        { target_kind: 'member', target_id: 'bertha004', allow_bits: 0, deny_bits: Permissions.SEND_MESSAGES },
      ],
      userHandle: 'bertha004',
    };
    // ADMINISTRATOR ignoriert Overrides
    expect(resolvePermissions(ctx)).toBe(ALL_PERMISSIONS);
    expect(hasPermission(ctx, Permissions.SEND_MESSAGES)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────
// Spec §5.4 Test-Vorschrift #5:
// role-deny < role-allow < member-deny < member-allow
// ──────────────────────────────────────────────────────
describe('resolvePermissions — Override-Order (Spec §5.3/§5.4)', () => {
  const baseRole = { id: 'everyone', permissions: Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES };

  it('role-deny entzieht Permission aus base', () => {
    const ctx = {
      isOwner: false,
      roles: [baseRole],
      overrides: [
        { target_kind: 'role', target_id: 'everyone', allow_bits: 0, deny_bits: Permissions.SEND_MESSAGES },
      ],
      userHandle: 'bertha004',
    };
    expect(hasPermission(ctx, Permissions.VIEW_CHANNEL)).toBe(true);
    expect(hasPermission(ctx, Permissions.SEND_MESSAGES)).toBe(false);
  });

  it('role-allow gewinnt über role-deny', () => {
    const ctx = {
      isOwner: false,
      roles: [baseRole, { id: 'mod', permissions: 0 }],
      overrides: [
        { target_kind: 'role', target_id: 'everyone', allow_bits: 0, deny_bits: Permissions.SEND_MESSAGES },
        { target_kind: 'role', target_id: 'mod',      allow_bits: Permissions.SEND_MESSAGES, deny_bits: 0 },
      ],
      userHandle: 'bertha004',
    };
    expect(hasPermission(ctx, Permissions.SEND_MESSAGES)).toBe(true);
  });

  it('member-deny gewinnt über role-allow', () => {
    const ctx = {
      isOwner: false,
      roles: [baseRole],
      overrides: [
        { target_kind: 'role',   target_id: 'everyone',  allow_bits: Permissions.SEND_MESSAGES, deny_bits: 0 },
        { target_kind: 'member', target_id: 'bertha004', allow_bits: 0, deny_bits: Permissions.SEND_MESSAGES },
      ],
      userHandle: 'bertha004',
    };
    expect(hasPermission(ctx, Permissions.SEND_MESSAGES)).toBe(false);
  });

  it('member-allow gewinnt über member-deny im selben Override-Set (sequential OR)', () => {
    // Hinweis: zwei separate member-Einträge sind eigentlich PK-verletzend (Spec hat
    // PRIMARY KEY (channel_id, target_kind, target_id)). Wir testen hier den
    // theoretischen Pfad falls Backend sich falsch verhält. Member-Override-Row mit
    // beiden bits gleichzeitig: allow gewinnt am Ende der Apply-Sequence.
    const ctx = {
      isOwner: false,
      roles: [{ id: 'r1', permissions: 0 }],
      overrides: [
        { target_kind: 'member', target_id: 'bertha004', allow_bits: Permissions.SEND_MESSAGES, deny_bits: Permissions.SEND_MESSAGES },
      ],
      userHandle: 'bertha004',
    };
    // Sequence: final &= ~deny  → 0, dann final |= allow → SEND. Allow gewinnt.
    expect(hasPermission(ctx, Permissions.SEND_MESSAGES)).toBe(true);
  });

  it('member-override target_id muss exakt matchen', () => {
    const ctx = {
      isOwner: false,
      roles: [baseRole],
      overrides: [
        // Override für ANDEREN User, nicht für bertha004
        { target_kind: 'member', target_id: 'eve', allow_bits: 0, deny_bits: Permissions.SEND_MESSAGES },
      ],
      userHandle: 'bertha004',
    };
    expect(hasPermission(ctx, Permissions.SEND_MESSAGES)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────
// Spec §5.4 Test-Vorschriften #1-4:
// Anti-Privilege-Escalation via Position-Check
// ──────────────────────────────────────────────────────
describe('canManageRoleAtPosition — Anti-Privilege-Escalation', () => {
  it('#1: Position=50 versucht Role Position=100 → false', () => {
    expect(canManageRoleAtPosition(50, 100, false)).toBe(false);
  });

  it('#2: Position=50 versucht Role Position=50 → false (gleich, nicht erlaubt)', () => {
    expect(canManageRoleAtPosition(50, 50, false)).toBe(false);
  });

  it('#3: Position=50 versucht Role Position=49 → true (strikt niedriger)', () => {
    expect(canManageRoleAtPosition(50, 49, false)).toBe(true);
  });

  it('#4: Owner bypassed Position=999 → true', () => {
    expect(canManageRoleAtPosition(0, 999, true)).toBe(true);
  });

  it('Member ohne Roles (Position=0) kann NICHTS', () => {
    expect(canManageRoleAtPosition(0, 0, false)).toBe(false);
    expect(canManageRoleAtPosition(0, 1, false)).toBe(false);
  });

  it('Defensive: negative oder NaN-Positions werden als 0 behandelt', () => {
    expect(canManageRoleAtPosition(NaN, 0, false)).toBe(false);
    expect(canManageRoleAtPosition(50, NaN, false)).toBe(true); // NaN|0 = 0, 0 < 50
  });
});

// ──────────────────────────────────────────────────────
// sanitizeBits — Forward-Compat
// ──────────────────────────────────────────────────────
describe('sanitizeBits', () => {
  it('entfernt unbekannte Bits', () => {
    const dirty = Permissions.SEND_MESSAGES | 0x80000000; // unbekanntes High-Bit
    const clean = sanitizeBits(dirty);
    expect(clean & Permissions.SEND_MESSAGES).toBe(Permissions.SEND_MESSAGES);
    expect(clean & 0x80000000).toBe(0);
  });

  it('akzeptiert ALL_PERMISSIONS unverändert', () => {
    expect(sanitizeBits(ALL_PERMISSIONS)).toBe(ALL_PERMISSIONS);
  });

  it('coerced non-integer input zu 0', () => {
    expect(sanitizeBits(null)).toBe(0);
    expect(sanitizeBits(undefined)).toBe(0);
    expect(sanitizeBits('foo')).toBe(0);
  });
});

// ──────────────────────────────────────────────────────
// Integrations-Szenarien (mehrere Mechanismen kombiniert)
// ──────────────────────────────────────────────────────
describe('Integrations-Szenarien', () => {
  it('Private-Channel: User OHNE Channel-Member-Eintrag UND OHNE Role-Override hat KEIN VIEW', () => {
    // Server-Default-Role hat KEIN VIEW_CHANNEL für diesen private Channel
    // (override entzieht es)
    const ctx = {
      isOwner: false,
      roles: [{ id: 'everyone', permissions: Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES }],
      overrides: [
        { target_kind: 'role', target_id: 'everyone', allow_bits: 0, deny_bits: Permissions.VIEW_CHANNEL },
      ],
      userHandle: 'eve',
    };
    expect(hasPermission(ctx, Permissions.VIEW_CHANNEL)).toBe(false);
  });

  it('Private-Channel: User MIT expliziter member-allow Override sieht den Channel', () => {
    const ctx = {
      isOwner: false,
      roles: [{ id: 'everyone', permissions: Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES }],
      overrides: [
        { target_kind: 'role',   target_id: 'everyone',  allow_bits: 0, deny_bits: Permissions.VIEW_CHANNEL },
        { target_kind: 'member', target_id: 'bertha004', allow_bits: Permissions.VIEW_CHANNEL, deny_bits: 0 },
      ],
      userHandle: 'bertha004',
    };
    expect(hasPermission(ctx, Permissions.VIEW_CHANNEL)).toBe(true);
  });

  it('Moderator hat KICK aber nicht BAN (DEFAULT_MODERATOR_PERMISSIONS)', () => {
    const ctx = {
      isOwner: false,
      roles: [{ id: 'mod', permissions: DEFAULT_MODERATOR_PERMISSIONS }],
      overrides: [],
      userHandle: 'mod_alice',
    };
    expect(hasPermission(ctx, Permissions.KICK_MEMBERS)).toBe(true);
    expect(hasPermission(ctx, Permissions.BAN_MEMBERS)).toBe(false);
    expect(hasPermission(ctx, Permissions.MANAGE_MESSAGES)).toBe(true);
  });
});
