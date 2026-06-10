// ======================================================
// Handler-Wiring-Test: C1 — Invite-initialRoleId Privilege-Escalation
// ======================================================
// serverPermissions.test.js testet canManageRoleAtPosition (Logik). Dieser Test
// prüft die VERDRAHTUNG im Invite-Handler: dass handleServerRoutes → invitesHandler
// real mit 403 antwortet, wenn ein Nicht-Owner mit INVITE_MEMBERS versucht, per
// Invite eine zu hohe / ADMINISTRATOR-Rolle zu vergeben — und Owner / niedrige
// Rollen korrekt durchlässt.
//
// auth.js wird gemockt (Session/RateLimit), die Permission-/Position-Logik
// (lib/permissions.js) + die Handler-internen Helfer (getServerMembership,
// userHasPermission, getActorMaxRolePosition) laufen ECHT gegen das DB-Mock.
// ======================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/auth.js', () => ({
  requireSession:  vi.fn(),
  rateLimit:       vi.fn(() => Promise.resolve(true)),
  pushToUserDO:    vi.fn(() => Promise.resolve(0)),
  getUserTier:     vi.fn(() => Promise.resolve('free')),
  verifyTurnstile: vi.fn(() => Promise.resolve(true)),
}));

import { handleServerRoutes } from '../src/routes/serverRoutes.js';
import * as auth from '../src/auth.js';
import { Permissions } from '../src/lib/permissions.js';

const SERVER_ID     = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ADMIN_ROLE_ID = 'dddddddd-1111-2222-3333-444444444444';
const PATH          = `/servers/${SERVER_ID}/invites`;

// scn: { membership, actorRoles[], actorMaxPos, targetRole }
function buildEnv(scn) {
  const inserts = [];
  const prepare = (sql) => ({
    bind: (...args) => ({
      run: () => {
        if (/^\s*INSERT/i.test(sql)) inserts.push({ sql, args });
        return Promise.resolve({ success: true, meta: { changes: 1 } });
      },
      first: () => {
        if (/SELECT user_handle, is_owner, nickname, joined_at/i.test(sql)) return Promise.resolve(scn.membership ?? null);
        if (/SELECT MAX\(sr\.position\)/i.test(sql))                         return Promise.resolve({ max_pos: scn.actorMaxPos ?? 0 });
        if (/SELECT id, is_default, position, permissions FROM server_roles/i.test(sql)) return Promise.resolve(scn.targetRole ?? null);
        if (/SELECT COUNT\(\*\) AS c FROM server_invites/i.test(sql))        return Promise.resolve({ c: 0 });
        return Promise.resolve(null);
      },
      all: () => {
        if (/SELECT sr\.id, sr\.permissions, sr\.position/i.test(sql)) return Promise.resolve({ results: scn.actorRoles ?? [] });
        return Promise.resolve({ results: [] });
      },
    }),
  });
  return {
    RENEX_DB: { prepare },
    RENEX_KV: { get: vi.fn(() => Promise.resolve(null)), put: vi.fn(() => Promise.resolve()), delete: vi.fn(() => Promise.resolve()) },
    _inserts: inserts,
  };
}

function buildRequest(body) {
  return {
    method: 'POST', url: `https://api.renex.id${PATH}`,
    headers: { get: (k) => {
      const key = String(k || '').toLowerCase();
      if (key === 'origin')       return 'https://app.renex.id';
      if (key === 'content-type') return 'application/json';
      return null;
    } },
    json: () => Promise.resolve(body),
  };
}

const run = (env, body) => handleServerRoutes(buildRequest(body), env, PATH, new URLSearchParams());

// Greeter = Nicht-Owner mit INVITE_MEMBERS auf Position 5.
const greeter = {
  membership:  { user_handle: 'greeter', is_owner: 0, nickname: null, joined_at: 1 },
  actorRoles:  [{ id: 'greeter-role', permissions: Permissions.INVITE_MEMBERS, position: 5 }],
  actorMaxPos: 5,
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.rateLimit.mockResolvedValue(true);
  auth.requireSession.mockResolvedValue({ handle: 'greeter', isGuest: false });
});

describe('C1 — Invite-initialRoleId Anti-Escalation (Verdrahtung)', () => {
  it('Nicht-Owner + ADMINISTRATOR-Rolle als initialRoleId → 403 forbidden_administrator_bit', async () => {
    const env = buildEnv({
      ...greeter,
      targetRole: { id: ADMIN_ROLE_ID, is_default: 0, position: 3, permissions: Permissions.ADMINISTRATOR },
    });
    const res = await run(env, { initialRoleId: ADMIN_ROLE_ID });
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error).toBe('forbidden_administrator_bit');
    expect(env._inserts.some(i => /INSERT INTO server_invites/i.test(i.sql))).toBe(false);
  });

  it('Nicht-Owner + Rolle ÜBER eigener Position → 403 forbidden_role_position', async () => {
    const env = buildEnv({
      ...greeter,
      targetRole: { id: 'high-role', is_default: 0, position: 10, permissions: Permissions.MANAGE_SERVER },
    });
    const res = await run(env, { initialRoleId: 'high-role' });
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error).toBe('forbidden_role_position');
    expect(env._inserts.some(i => /INSERT INTO server_invites/i.test(i.sql))).toBe(false);
  });

  it('Nicht-Owner + Rolle UNTER eigener Position (kein Admin) → OK (Invite erstellt)', async () => {
    const env = buildEnv({
      ...greeter,
      targetRole: { id: 'low-role', is_default: 0, position: 2, permissions: Permissions.SEND_MESSAGES },
    });
    const res = await run(env, { initialRoleId: 'low-role' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(env._inserts.some(i => /INSERT INTO server_invites/i.test(i.sql))).toBe(true);
  });

  it('Owner darf jede Rolle (inkl. ADMINISTRATOR) als initialRoleId → OK', async () => {
    auth.requireSession.mockResolvedValue({ handle: 'owner', isGuest: false });
    const env = buildEnv({
      membership:  { user_handle: 'owner', is_owner: 1, nickname: null, joined_at: 1 },
      actorRoles:  [],            // Owner braucht keine Rolle (Bypass)
      actorMaxPos: 0,
      targetRole:  { id: ADMIN_ROLE_ID, is_default: 0, position: 99, permissions: Permissions.ADMINISTRATOR },
    });
    const res = await run(env, { initialRoleId: ADMIN_ROLE_ID });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });
});
