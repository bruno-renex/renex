// ======================================================
// Gast-Quota-Redesign (eGov 1.2, Häppchen 5)
//
// - /invite/create: Org-Langzeit-Invites → msg_limit 0 (unbegrenzt) by default;
//   explizites msgLimit optional (org-gated, 0..100000); Consumer bleibt 20.
// - chatSend: msg_limit 0 → Quota-Check übersprungen, msg_count zählt weiter.
// - /invite/ping: unbegrenzt → msgsLeft null (Banner blendet Zähler aus).
// ======================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/auth.js', () => ({
  requireSession:      vi.fn(() => Promise.resolve(null)),
  requireGuestSession: vi.fn(() => Promise.resolve(null)),
  requireAnySession:   vi.fn(() => Promise.resolve(null)),
  getGuestToken:       vi.fn(() => null),
  rateLimit:           vi.fn(() => Promise.resolve(true)),
  isAcceptedContact:   vi.fn(() => Promise.resolve(true)),
  isConvoMember:       vi.fn(() => Promise.resolve(true)),
  getConvoMemberHandles: vi.fn(() => Promise.resolve([])),
  pushToGroupMembers:  vi.fn(() => Promise.resolve()),
  pushToUserDO:        vi.fn(() => Promise.resolve(0)),
  GUEST_TOKEN_RE:  /^guest_[a-z0-9]{32}$/,
  GUEST_HANDLE_RE: /^guest_[a-z0-9]{8}$/,
}));

import { handleInviteRoutes } from '../src/routes/inviteRoutes.js';
import * as auth from '../src/auth.js';

const TOKEN = 'guest_' + 'a'.repeat(32);
const ORG_ROW = {
  org_handle: 'colicotest', display_name: 'Colico Test-Organisation',
  verification_method: 'contract_invoice', verified_at: 1, status: 'active',
};

function buildEnv(scn = {}) {
  const inserts = [];
  const prepare = (sql) => ({
    bind: (...args) => ({
      first: () => {
        if (/FROM orgs/i.test(sql)) return Promise.resolve(scn.orgRow ?? null);
        if (/FROM guest_sessions WHERE token/i.test(sql)) return Promise.resolve(scn.sessionRow ?? null);
        return Promise.resolve(null);
      },
      run: () => { if (/^\s*INSERT/i.test(sql)) inserts.push({ sql, args }); return Promise.resolve({ success: true, meta: { changes: 1 } }); },
      all: () => Promise.resolve({ results: [] }),
    }),
  });
  return {
    RENEX_DB: { prepare },
    RENEX_KV: { get: vi.fn(() => Promise.resolve(null)), put: vi.fn(() => Promise.resolve()), delete: vi.fn(() => Promise.resolve()) },
    _inserts: inserts,
  };
}

function buildRequest(body, urlPath) {
  return {
    method: 'POST', url: `https://api.renex.id${urlPath}`,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  };
}

describe('/invite/create — Quota org-gated', () => {
  beforeEach(() => auth.requireSession.mockResolvedValue({ handle: 'colicotest', isGuest: false }));
  const create = (env, body) =>
    handleInviteRoutes(buildRequest(body, '/invite/create'), env, '/invite/create', new URLSearchParams());

  // INSERT-Binds: token, convo_id, convo_type, created_by, created_at, expires_at, msg_limit
  const insertedMsgLimit = (env) => env._inserts[0].args[6];

  it('Org-Langzeit-Invite (nur expiresInDays) → msg_limit 0 = unbegrenzt', async () => {
    const env = buildEnv({ orgRow: ORG_ROW });
    const res = await create(env, { expiresInDays: 90 });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.msgLimit).toBe(0);
    expect(insertedMsgLimit(env)).toBe(0);
  });

  it('explizites msgLimit (Org): 500 endlich, 0 unbegrenzt; auch ohne expiresInDays', async () => {
    const env1 = buildEnv({ orgRow: ORG_ROW });
    expect((await (await create(env1, { expiresInDays: 90, msgLimit: 500 })).json()).msgLimit).toBe(500);
    expect(insertedMsgLimit(env1)).toBe(500);

    const env2 = buildEnv({ orgRow: ORG_ROW });
    expect((await (await create(env2, { msgLimit: 0 })).json()).msgLimit).toBe(0);
  });

  it('Nicht-Org mit msgLimit → 403 org_required; ungültig → 400', async () => {
    const res1 = await create(buildEnv(), { msgLimit: 0 });
    expect(res1.status).toBe(403);
    expect((await res1.json()).code).toBe('org_required');

    for (const bad of [-1, 1.5, 100_001, '20']) {
      const res = await create(buildEnv({ orgRow: ORG_ROW }), { msgLimit: bad });
      expect(res.status).toBe(400);
    }
  });

  it('Consumer ohne Parameter: msg_limit bleibt 20 (Scope-Freeze)', async () => {
    const env = buildEnv();
    const body = await (await create(env, {})).json();
    expect(body.msgLimit).toBe(20);
    expect(insertedMsgLimit(env)).toBe(20);
  });
});

describe('chatSend — msg_limit 0 überspringt Quota', () => {
  it('unbegrenzter Gast (count 50, limit 0) wird NICHT geblockt; limit 20 weiterhin 429', async () => {
    const { handleChatSend } = await import('../src/helpers/chatSend.js');
    auth.requireAnySession.mockResolvedValue({ handle: 'guest_ab12cd34', isGuest: true, token: TOKEN, convoId: 'colicotest:guest_ab12cd34' });

    const mkEnv = (limit, count) => buildEnv({ sessionRow: { msg_count: count, msg_limit: limit, expires_at: Date.now() + 86400_000, converted_to: null } });
    const mkReq = () => ({
      method: 'POST', url: 'https://api.renex.id/chat/send',
      headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: () => Promise.resolve({ to: 'colicotest', message: 'hallo', v: 2, e2e: true, ivB64: 'aXY=', ctB64: 'Y3Q=', sid: 'sid_12345', epoch: 1 }),
    });

    // limit 0, count 50 → Quota-Gate passiert (Fehler erst später/anders, aber KEIN 429)
    const resUnlimited = await handleChatSend(mkReq(), mkEnv(0, 50));
    expect(resUnlimited.status).not.toBe(429);

    // limit 20, count 20 → weiterhin 429 mit convertUrl
    const resLimited = await handleChatSend(mkReq(), mkEnv(20, 20));
    expect(resLimited.status).toBe(429);
    expect((await resLimited.json()).convertUrl).toContain('convert=1');
  });
});

describe('/invite/ping — msgsLeft null bei unbegrenzt', () => {
  it('limit 0 → msgsLeft null; limit 20/count 5 → 15', async () => {
    auth.requireGuestSession.mockResolvedValue({ handle: 'guest_ab12cd34', isGuest: true, token: TOKEN });

    const ping = (row) => handleInviteRoutes(
      buildRequest({}, '/invite/ping'),
      buildEnv({ sessionRow: { ...row, expires_at: Date.now() + 1000, converted_to: null } }),
      '/invite/ping', new URLSearchParams());

    const b1 = await (await ping({ msg_count: 7, msg_limit: 0 })).json();
    expect(b1.msgsLeft).toBeNull();
    expect(b1.msgLimit).toBe(0);

    const b2 = await (await ping({ msg_count: 5, msg_limit: 20 })).json();
    expect(b2.msgsLeft).toBe(15);
  });
});
