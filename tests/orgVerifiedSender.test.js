// ======================================================
// Verified-Sender-Fundament (eGov Phase 1.1, Häppchen 1)
//
// - getVerifiedOrg: aktive Org → Badge-Daten; suspended / fehlend /
//   Tabelle-noch-nicht-migriert → null (nie throw — Routen dürfen nicht 500en,
//   wenn der Code vor der Remote-Migration deployed).
// - /invite/info-Wiring: verifiedSender-Feld + displayName = Registername
//   bei verifizierter Org; null + "<handle>'s Chat" sonst.
// ======================================================
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/auth.js', () => ({
  requireSession:      vi.fn(() => Promise.resolve(null)),
  requireGuestSession: vi.fn(() => Promise.resolve(null)),
  getGuestToken:       vi.fn(() => null),
  rateLimit:           vi.fn(() => Promise.resolve(true)),
  pushToGroupMembers:  vi.fn(() => Promise.resolve()),
  pushToUserDO:        vi.fn(() => Promise.resolve(0)),
  GUEST_TOKEN_RE:  /^guest_[a-z0-9]{32}$/,
  GUEST_HANDLE_RE: /^guest_[a-z0-9]{8}$/,
}));

import { getVerifiedOrg } from '../src/lib/orgs.js';
import { handleInviteRoutes } from '../src/routes/inviteRoutes.js';

const ORG_ROW = {
  org_handle: 'praxis_muster',
  display_name: 'Praxis Muster GmbH',
  verification_method: 'medreg_psyreg_refdata',
  verified_at: 1752566400000,
  status: 'active',
};

// scn: { orgRow, orgThrows, inviteRow }
function buildEnv(scn = {}) {
  const prepare = (sql) => ({
    bind: () => ({
      first: () => {
        if (/FROM orgs/i.test(sql)) {
          if (scn.orgThrows) return Promise.reject(new Error('no such table: orgs'));
          return Promise.resolve(scn.orgRow ?? null);
        }
        if (/FROM guest_sessions/i.test(sql)) return Promise.resolve(scn.inviteRow ?? null);
        if (/FROM conversations/i.test(sql))  return Promise.resolve(null);
        return Promise.resolve(null);
      },
      run: () => Promise.resolve({ success: true, meta: { changes: 1 } }),
      all: () => Promise.resolve({ results: [] }),
    }),
  });
  return {
    RENEX_DB: { prepare },
    RENEX_KV: { get: vi.fn(() => Promise.resolve(null)), put: vi.fn(() => Promise.resolve()), delete: vi.fn(() => Promise.resolve()) },
  };
}

describe('getVerifiedOrg', () => {
  it('liefert Badge-Daten für aktive Org', async () => {
    const org = await getVerifiedOrg(buildEnv({ orgRow: ORG_ROW }), 'Praxis_Muster');
    expect(org).toEqual({
      handle: 'praxis_muster',
      name: 'Praxis Muster GmbH',
      verificationMethod: 'medreg_psyreg_refdata',
      verifiedAt: 1752566400000,
    });
  });

  it('null bei status=suspended (Badge verschwindet sofort)', async () => {
    const org = await getVerifiedOrg(buildEnv({ orgRow: { ...ORG_ROW, status: 'suspended' } }), 'praxis_muster');
    expect(org).toBeNull();
  });

  it('null ohne Eintrag und bei ungültigem Handle', async () => {
    expect(await getVerifiedOrg(buildEnv(), 'irgendwer')).toBeNull();
    expect(await getVerifiedOrg(buildEnv({ orgRow: ORG_ROW }), 'DROP TABLE')).toBeNull();
    expect(await getVerifiedOrg(buildEnv({ orgRow: ORG_ROW }), null)).toBeNull();
  });

  it('null (kein throw) wenn orgs-Tabelle noch nicht migriert ist', async () => {
    const org = await getVerifiedOrg(buildEnv({ orgThrows: true }), 'praxis_muster');
    expect(org).toBeNull();
  });
});

describe('/invite/info — verifiedSender-Wiring', () => {
  const TOKEN = 'guest_' + 'a'.repeat(32);

  const inviteRow = (createdBy) => ({
    convo_id: '', convo_type: 'dm', created_by: createdBy,
    expires_at: Date.now() + 60_000, guest_handle: '',
  });

  function buildRequest() {
    return {
      method: 'GET',
      url: `https://api.renex.id/invite/info?token=${TOKEN}`,
      headers: { get: (k) => (String(k).toLowerCase() === 'origin' ? 'https://renex.id' : null) },
    };
  }

  const run = (env) =>
    handleInviteRoutes(buildRequest(), env, '/invite/info', new URLSearchParams({ token: TOKEN }));

  it('verifizierte Org: displayName = Registername + verifiedSender gesetzt', async () => {
    const env = buildEnv({ orgRow: ORG_ROW, inviteRow: inviteRow('praxis_muster') });
    const res = await run(env);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.valid).toBe(true);
    expect(body.displayName).toBe('Praxis Muster GmbH');
    expect(body.verifiedSender).toEqual({
      handle: 'praxis_muster',
      name: 'Praxis Muster GmbH',
      verificationMethod: 'medreg_psyreg_refdata',
      verifiedAt: 1752566400000,
    });
  });

  it('normaler User: verifiedSender null, displayName unverändert', async () => {
    const env = buildEnv({ inviteRow: inviteRow('demo27') });
    const res = await run(env);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.displayName).toBe("demo27's Chat");
    expect(body.verifiedSender).toBeNull();
  });

  it('orgs-Tabelle fehlt: Route antwortet trotzdem 200 ohne Badge', async () => {
    const env = buildEnv({ orgThrows: true, inviteRow: inviteRow('demo27') });
    const res = await run(env);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.valid).toBe(true);
    expect(body.verifiedSender).toBeNull();
  });
});
