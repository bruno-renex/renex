// ======================================================
// Unit-Tests für Channel-Access-Resolution (C2-Fix)
// ======================================================
// Verifiziert die server-seitige Durchsetzung von VIEW_CHANNEL auf der
// Message-Ebene (Send / History / Recipient-Set / GSK). Vorher war VIEW_CHANNEL
// NUR im Channel-List-Filter durchgesetzt → private Channels waren gegen andere
// Server-Member nicht vertraulich (lesbar/schreibbar via convoId, GSK an alle).
//
// Diese Tests pinnen das korrekte Verhalten:
//   - resolveChannelPerms: null (kein Channel) / 0 (kein Member) / Owner / Roles+Overrides
//   - canViewChannel: boolean
//   - getChannelViewerHandles: Fast-Path (offen → alle) vs Slow-Path (privat → nur Viewer)
// ======================================================
import { describe, it, expect } from 'vitest';
import {
  resolveChannelPerms,
  canViewChannel,
  getChannelViewerHandles,
} from '../src/lib/channelAccess.js';
import { Permissions, ALL_PERMISSIONS } from '../src/lib/permissions.js';

// ── Mock-D1: dispatch per SQL-Pattern ──────────────────
// data = {
//   convo:       { type, server_id } | null,
//   members:     { handle: { is_owner } },
//   rolesByUser: { handle: [{ id, permissions }] },
//   overrides:   [{ target_kind, target_id, allow_bits, deny_bits }],
// }
function mockDb(data) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => {
              if (/FROM conversations/i.test(sql)) return data.convo ?? null;
              if (/SELECT is_owner FROM server_members/i.test(sql)) {
                const handle = args[1];
                const m = data.members?.[handle];
                return m ? { is_owner: m.is_owner ?? 0 } : null;
              }
              return null;
            },
            all: async () => {
              if (/FROM channel_permission_overrides/i.test(sql)) {
                return { results: data.overrides || [] };
              }
              // single-user roles (resolveChannelPerms): hat "ra.user_handle = ?"
              if (/role_assignments ra JOIN server_roles/i.test(sql) && /ra\.user_handle = \?/i.test(sql)) {
                const handle = args[1];
                return { results: data.rolesByUser?.[handle] || [] };
              }
              // all-server roles (getChannelViewerHandles slow-path)
              if (/SELECT ra\.user_handle, sr\.id, sr\.permissions/i.test(sql)) {
                const rows = [];
                for (const [h, roles] of Object.entries(data.rolesByUser || {})) {
                  for (const r of roles) rows.push({ user_handle: h, id: r.id, permissions: r.permissions });
                }
                return { results: rows };
              }
              if (/SELECT user_handle, is_owner FROM server_members/i.test(sql)) {
                return {
                  results: Object.entries(data.members || {})
                    .map(([h, m]) => ({ user_handle: h, is_owner: m.is_owner ?? 0 })),
                };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  };
}

const everyoneRole = { id: 'everyone', permissions: Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES };

describe('resolveChannelPerms', () => {
  it('gibt null zurück für eine DM/Group convoId (kein Server-Channel)', async () => {
    const db = mockDb({ convo: { type: 'group', server_id: null } });
    expect(await resolveChannelPerms(db, 'cid', 'anna')).toBe(null);
  });

  it('gibt null zurück wenn convo nicht existiert', async () => {
    const db = mockDb({ convo: null });
    expect(await resolveChannelPerms(db, 'cid', 'anna')).toBe(null);
  });

  it('gibt 0 zurück wenn User KEIN Server-Member ist', async () => {
    const db = mockDb({ convo: { type: 'channel', server_id: 'srv1' }, members: {} });
    expect(await resolveChannelPerms(db, 'cid', 'eve')).toBe(0);
  });

  it('Owner bekommt ALL_PERMISSIONS', async () => {
    const db = mockDb({
      convo: { type: 'channel', server_id: 'srv1' },
      members: { anna: { is_owner: 1 } },
    });
    expect(await resolveChannelPerms(db, 'cid', 'anna')).toBe(ALL_PERMISSIONS);
  });

  it('Member mit everyone-Role ohne Overrides hat VIEW_CHANNEL', async () => {
    const db = mockDb({
      convo: { type: 'channel', server_id: 'srv1' },
      members: { bob: { is_owner: 0 } },
      rolesByUser: { bob: [everyoneRole] },
      overrides: [],
    });
    const eff = await resolveChannelPerms(db, 'cid', 'bob');
    expect((eff & Permissions.VIEW_CHANNEL) === Permissions.VIEW_CHANNEL).toBe(true);
  });

  it('Privater Channel (everyone deny VIEW): Member ohne Allow hat KEIN VIEW', async () => {
    const db = mockDb({
      convo: { type: 'channel', server_id: 'srv1' },
      members: { eve: { is_owner: 0 } },
      rolesByUser: { eve: [everyoneRole] },
      overrides: [
        { target_kind: 'role', target_id: 'everyone', allow_bits: 0, deny_bits: Permissions.VIEW_CHANNEL },
      ],
    });
    const eff = await resolveChannelPerms(db, 'cid', 'eve');
    expect((eff & Permissions.VIEW_CHANNEL) === Permissions.VIEW_CHANNEL).toBe(false);
  });

  it('Privater Channel: Member mit member-allow VIEW sieht den Channel', async () => {
    const db = mockDb({
      convo: { type: 'channel', server_id: 'srv1' },
      members: { bob: { is_owner: 0 } },
      rolesByUser: { bob: [everyoneRole] },
      overrides: [
        { target_kind: 'role', target_id: 'everyone', allow_bits: 0, deny_bits: Permissions.VIEW_CHANNEL },
        { target_kind: 'member', target_id: 'bob', allow_bits: Permissions.VIEW_CHANNEL, deny_bits: 0 },
      ],
    });
    const eff = await resolveChannelPerms(db, 'cid', 'bob');
    expect((eff & Permissions.VIEW_CHANNEL) === Permissions.VIEW_CHANNEL).toBe(true);
  });
});

describe('canViewChannel', () => {
  it('gibt null für Nicht-Channel zurück (Aufrufer fällt auf bestehende Logik zurück)', async () => {
    const db = mockDb({ convo: { type: 'dm', server_id: null } });
    expect(await canViewChannel(db, 'alice:bob', 'anna')).toBe(null);
  });

  it('false für Nicht-Viewer eines privaten Channels', async () => {
    const db = mockDb({
      convo: { type: 'channel', server_id: 'srv1' },
      members: { eve: { is_owner: 0 } },
      rolesByUser: { eve: [everyoneRole] },
      overrides: [{ target_kind: 'role', target_id: 'everyone', allow_bits: 0, deny_bits: Permissions.VIEW_CHANNEL }],
    });
    expect(await canViewChannel(db, 'cid', 'eve')).toBe(false);
  });
});

describe('getChannelViewerHandles', () => {
  it('Fast-Path: Channel OHNE Overrides → alle Member sind Recipients', async () => {
    const db = mockDb({
      members: { anna: { is_owner: 1 }, bob: { is_owner: 0 }, charlie: { is_owner: 0 } },
      overrides: [],
    });
    const viewers = await getChannelViewerHandles(db, 'srv1', 'cid');
    expect(viewers.sort()).toEqual(['anna', 'bob', 'charlie']);
  });

  it('Slow-Path: privater Channel → nur Owner + explizit berechtigte Member', async () => {
    const db = mockDb({
      members: { anna: { is_owner: 1 }, bob: { is_owner: 0 }, eve: { is_owner: 0 } },
      rolesByUser: { bob: [everyoneRole], eve: [everyoneRole] },
      overrides: [
        // everyone darf NICHT sehen ...
        { target_kind: 'role', target_id: 'everyone', allow_bits: 0, deny_bits: Permissions.VIEW_CHANNEL },
        // ... ausser bob explizit
        { target_kind: 'member', target_id: 'bob', allow_bits: Permissions.VIEW_CHANNEL, deny_bits: 0 },
      ],
    });
    const viewers = await getChannelViewerHandles(db, 'srv1', 'cid');
    // anna = Owner (immer), bob = member-allow, eve = NICHT (kein VIEW)
    expect(viewers.sort()).toEqual(['anna', 'bob']);
    expect(viewers).not.toContain('eve');
  });
});
