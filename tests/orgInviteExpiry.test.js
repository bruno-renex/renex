// ======================================================
// Org-gated expiresIn + TTL-Konsistenz (eGov Phase 1.2, Häppchen 2)
//
// - /invite/create: expiresInDays NUR für verifizierte Orgs (403 sonst),
//   Validierung 1..365 (400 sonst), Consumer ohne Parameter → 24h unverändert.
// - /invite/join: Gast-Session lebt so lange wie die Template-Dauer
//   (expires_at − created_at); e2e-Key-TTL + KV-Session-TTL wachsen mit.
// - Langlebige Invites einer suspendierten Org → 410 an info/join/accept.
// ======================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

const DAY = 86400_000;
const TOKEN = 'guest_' + 'a'.repeat(32);

const ORG_ROW = {
  org_handle: 'praxis_muster',
  display_name: 'Praxis Muster GmbH',
  verification_method: 'medreg_psyreg_refdata',
  verified_at: 1752566400000,
  status: 'active',
};

// scn: { orgRow, inviteRow }
function buildEnv(scn = {}) {
  const inserts = [];
  const kvPuts  = [];
  const prepare = (sql) => ({
    bind: (...args) => ({
      first: () => {
        if (/FROM orgs/i.test(sql))       return Promise.resolve(scn.orgRow ?? null);
        if (/SELECT 1 FROM guest_sessions WHERE guest_handle/i.test(sql)) return Promise.resolve(null);
        if (/FROM guest_sessions WHERE token/i.test(sql)) return Promise.resolve(scn.inviteRow ?? null);
        if (/FROM conversations/i.test(sql)) return Promise.resolve({ name: null });
        return Promise.resolve(null);
      },
      run: () => {
        if (/^\s*INSERT/i.test(sql)) inserts.push({ sql, args });
        return Promise.resolve({ success: true, meta: { changes: 1 } });
      },
      all: () => Promise.resolve({ results: [] }),
    }),
  });
  return {
    RENEX_DB: { prepare },
    RENEX_KV: {
      get: vi.fn(() => Promise.resolve(null)),
      put: vi.fn((key, value, opts) => { kvPuts.push({ key, value, opts }); return Promise.resolve(); }),
      delete: vi.fn(() => Promise.resolve()),
    },
    _inserts: inserts,
    _kvPuts:  kvPuts,
  };
}

function buildRequest(method, body, urlPath) {
  return {
    method,
    url: `https://api.renex.id${urlPath}`,
    headers: { get: (k) => {
      const key = String(k).toLowerCase();
      if (key === 'origin')           return 'https://renex.id';
      if (key === 'cf-connecting-ip') return '198.51.100.7';
      return null;
    } },
    json: () => Promise.resolve(body),
  };
}

describe('/invite/create — expiresInDays org-gated', () => {
  beforeEach(() => {
    auth.requireSession.mockResolvedValue({ handle: 'praxis_muster', isGuest: false });
  });

  const create = (env, body) =>
    handleInviteRoutes(buildRequest('POST', body, '/invite/create'), env, '/invite/create', new URLSearchParams());

  it('verifizierte Org: 90 Tage Template-Expiry', async () => {
    const env = buildEnv({ orgRow: ORG_ROW });
    const before = Date.now();
    const res = await create(env, { expiresInDays: 90 });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 90 * DAY);
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 90 * DAY);
  });

  it('Nicht-Org mit expiresInDays → 403 org_required', async () => {
    const env = buildEnv(); // keine Org-Row
    const res = await create(env, { expiresInDays: 90 });
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.code).toBe('org_required');
  });

  it('ungültige Werte → 400 (0, >365, Nicht-Integer)', async () => {
    const env = buildEnv({ orgRow: ORG_ROW });
    for (const bad of [0, 366, 1.5, '90']) {
      const res = await create(env, { expiresInDays: bad });
      expect(res.status).toBe(400);
    }
  });

  it('Consumer ohne Parameter: 24h unverändert (Scope-Freeze)', async () => {
    const env = buildEnv(); // kein Org nötig
    const before = Date.now();
    const res = await create(env, {});
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + DAY);
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + DAY);
  });
});

describe('/invite/join — Session-/TTL-Konsistenz + Org-Suspendierung', () => {
  const now = () => Date.now();

  // Org-Invite: 90-Tage-Template (created vor 2 Tagen, läuft noch 88 Tage)
  const orgInviteRow = () => ({
    token: TOKEN, convo_id: '', convo_type: 'dm', created_by: 'praxis_muster',
    created_at: now() - 2 * DAY, expires_at: now() + 88 * DAY,
    msg_limit: 20, msg_count: 0, guest_handle: '', converted_to: null,
  });
  // Consumer-Invite: 24h-Template
  const consumerInviteRow = () => ({
    token: TOKEN, convo_id: '', convo_type: 'dm', created_by: 'demo27',
    created_at: now() - 1000, expires_at: now() - 1000 + DAY,
    msg_limit: 20, msg_count: 0, guest_handle: '', converted_to: null,
  });

  const joinBody = {
    token: TOKEN,
    termsVersion: '2026-04-15',
    cfTurnstileToken: 'tok',
    publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    guestDeviceId: 'gdev_' + 'ab12ef'.repeat(4),
  };

  beforeEach(() => {
    // Turnstile-Verify stubben (echter fetch zu challenges.cloudflare.com)
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ success: true }) })));
  });
  afterEach(() => vi.unstubAllGlobals());

  const join = (env) =>
    handleInviteRoutes(buildRequest('POST', joinBody, '/invite/join'), env, '/invite/join', new URLSearchParams());

  it('90d-Org-Invite: Session ≈ 90 Tage, e2e-Key- und KV-Session-TTL wachsen mit', async () => {
    const env = buildEnv({ orgRow: ORG_ROW, inviteRow: orgInviteRow() });
    const before = now();
    const res = await join(env);
    const body = await res.json();
    expect(res.status).toBe(200);
    // Session-Dauer = Template-DAUER (90d), nicht Restlaufzeit
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 90 * DAY - 5000);
    expect(body.expiresAt).toBeLessThanOrEqual(now() + 90 * DAY + 5000);
    // Alle KV-TTLs (e2e-Key, e2e-Index, guest_session) ≈ 90 Tage in Sekunden
    const ttlPuts = env._kvPuts.filter(p => p.opts?.expirationTtl);
    expect(ttlPuts.length).toBeGreaterThanOrEqual(3);
    for (const p of ttlPuts) {
      expect(p.opts.expirationTtl).toBeGreaterThan(89 * 86400);
      expect(p.opts.expirationTtl).toBeLessThanOrEqual(90 * 86400 + 60);
    }
  });

  it('Consumer-Invite: Session bleibt 24h (Scope-Freeze)', async () => {
    const env = buildEnv({ inviteRow: consumerInviteRow() });
    const before = now();
    const res = await join(env);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + DAY - 5000);
    expect(body.expiresAt).toBeLessThanOrEqual(now() + DAY + 5000);
  });

  it('langlebiger Invite + Org suspendiert → 410 inviter_suspended', async () => {
    const env = buildEnv({ orgRow: { ...ORG_ROW, status: 'suspended' }, inviteRow: orgInviteRow() });
    const res = await join(env);
    const body = await res.json();
    expect(res.status).toBe(410);
    expect(body.code).toBe('inviter_suspended');
  });
});

describe('/invite/info + /invite/accept — Org-Suspendierungs-Gate', () => {
  const longRow = (extra = {}) => ({
    token: TOKEN, convo_id: '', convo_type: 'dm', created_by: 'praxis_muster',
    created_at: Date.now() - DAY, expires_at: Date.now() + 89 * DAY,
    msg_limit: 20, msg_count: 0, guest_handle: '', converted_to: null, ...extra,
  });

  it('/invite/info: suspendierte Org → 410 inviter_suspended; aktive Org → valid', async () => {
    const suspended = buildEnv({ orgRow: { ...ORG_ROW, status: 'suspended' }, inviteRow: longRow() });
    const res1 = await handleInviteRoutes(
      buildRequest('GET', null, `/invite/info?token=${TOKEN}`), suspended, '/invite/info', new URLSearchParams({ token: TOKEN }));
    const body1 = await res1.json();
    expect(res1.status).toBe(410);
    expect(body1.reason).toBe('inviter_suspended');

    const active = buildEnv({ orgRow: ORG_ROW, inviteRow: longRow() });
    const res2 = await handleInviteRoutes(
      buildRequest('GET', null, `/invite/info?token=${TOKEN}`), active, '/invite/info', new URLSearchParams({ token: TOKEN }));
    const body2 = await res2.json();
    expect(res2.status).toBe(200);
    expect(body2.valid).toBe(true);
    expect(body2.verifiedSender?.name).toBe('Praxis Muster GmbH');
  });

  it('/invite/accept: suspendierte Org → 410', async () => {
    auth.requireSession.mockResolvedValue({ handle: 'buerger42', isGuest: false });
    const env = buildEnv({ orgRow: { ...ORG_ROW, status: 'suspended' }, inviteRow: longRow() });
    const res = await handleInviteRoutes(
      buildRequest('POST', { token: TOKEN }, '/invite/accept'), env, '/invite/accept', new URLSearchParams());
    const body = await res.json();
    expect(res.status).toBe(410);
    expect(body.code).toBe('inviter_suspended');
  });
});
