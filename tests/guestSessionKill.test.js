// ======================================================
// Session-Kill für aktive Gast-Sessions (eGov 1.2, Häppchen 3)
//
// POST /invite/kill-session — der Alarm-/Widerrufspfad des Einladers:
// - D1 expires_at = jetzt + KV guest_session:-Purge (Auth stirbt sofort)
// - e2e:inbox-Keys geräumt, Membership + Kontakte inline entfernt
// - nur der Einlader (created_by) darf killen; konvertierte Gäste = 404
// ======================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { handleInviteRoutes } from '../src/routes/inviteRoutes.js';
import * as auth from '../src/auth.js';

const GUEST  = 'guest_ab12cd34';
const TOKEN  = 'guest_' + 'f'.repeat(32);

// scn: { sessionRow }
function buildEnv(scn = {}) {
  const runs      = [];
  const kvDeletes = [];
  const prepare = (sql) => ({
    bind: (...args) => ({
      first: () => {
        if (/FROM guest_sessions WHERE guest_handle/i.test(sql)) return Promise.resolve(scn.sessionRow ?? null);
        return Promise.resolve(null);
      },
      run: () => { runs.push({ sql, args }); return Promise.resolve({ success: true, meta: { changes: 1 } }); },
      all: () => Promise.resolve({ results: [] }),
    }),
  });
  return {
    RENEX_DB: { prepare },
    RENEX_KV: {
      get: vi.fn((key) => Promise.resolve(key === `e2e:inbox:index:${GUEST}` ? JSON.stringify(['gdev_1']) : null)),
      put: vi.fn(() => Promise.resolve()),
      delete: vi.fn((key) => { kvDeletes.push(key); return Promise.resolve(); }),
    },
    _runs: runs,
    _kvDeletes: kvDeletes,
  };
}

function buildRequest(body) {
  return {
    method: 'POST',
    url: 'https://api.renex.id/invite/kill-session',
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  };
}

const kill = (env, body) =>
  handleInviteRoutes(buildRequest(body), env, '/invite/kill-session', new URLSearchParams());

const SESSION_ROW = {
  token: TOKEN, convo_id: 'praxis_muster:' + GUEST,
  created_by: 'praxis_muster', converted_to: null,
};

describe('POST /invite/kill-session', () => {
  beforeEach(() => {
    auth.requireSession.mockResolvedValue({ handle: 'praxis_muster', isGuest: false });
  });

  it('Einlader killt aktive Session: D1-Expiry, KV-Purge, e2e-Keys, Membership, Kontakte', async () => {
    const env = buildEnv({ sessionRow: SESSION_ROW });
    const before = Date.now();
    const res = await kill(env, { guestHandle: GUEST });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    // D1: expires_at auf jetzt genullt
    const expiryUpdate = env._runs.find(r => /SET expires_at = \? WHERE token = \?/i.test(r.sql));
    expect(expiryUpdate).toBeTruthy();
    expect(expiryUpdate.args[0]).toBeGreaterThanOrEqual(before);
    expect(expiryUpdate.args[1]).toBe(TOKEN);

    // KV: Session-Cache + e2e-Inbox-Keys weg
    expect(env._kvDeletes).toContain(`guest_session:${TOKEN}`);
    expect(env._kvDeletes).toContain(`e2e:inbox:${GUEST}:gdev_1`);
    expect(env._kvDeletes).toContain(`e2e:inbox:index:${GUEST}`);

    // Membership + Kontakte inline entfernt
    expect(env._runs.some(r => /DELETE FROM conversation_members/i.test(r.sql) && r.args[1] === GUEST)).toBe(true);
    expect(env._runs.filter(r => /UPDATE contacts SET status = 'removed'/i.test(r.sql)).length).toBe(2);

    // Gast live informiert (best-effort)
    expect(auth.pushToUserDO).toHaveBeenCalledWith(expect.anything(), GUEST,
      expect.objectContaining({ type: 'GUEST_SESSION_KILLED' }));
  });

  it('Nicht-Einlader → 403, nichts verändert', async () => {
    auth.requireSession.mockResolvedValue({ handle: 'fremder', isGuest: false });
    const env = buildEnv({ sessionRow: SESSION_ROW });
    const res = await kill(env, { guestHandle: GUEST });
    expect(res.status).toBe(403);
    expect(env._runs.length).toBe(0);
    expect(env._kvDeletes.length).toBe(0);
  });

  it('unbekannter Gast → 404; konvertierter Gast → 404', async () => {
    const res1 = await kill(buildEnv(), { guestHandle: GUEST });
    expect(res1.status).toBe(404);

    const res2 = await kill(buildEnv({ sessionRow: { ...SESSION_ROW, converted_to: 'realuser' } }), { guestHandle: GUEST });
    expect(res2.status).toBe(404);
  });

  it('ungültiges Handle-Format → 400; Gast-Session als Caller → 401', async () => {
    const res1 = await kill(buildEnv(), { guestHandle: 'DROP TABLE' });
    expect(res1.status).toBe(400);

    auth.requireSession.mockResolvedValue(null);
    const res2 = await kill(buildEnv(), { guestHandle: GUEST });
    expect(res2.status).toBe(401);
  });
});
