// ======================================================
// Re-Entry per QR-Karte (eGov 1.4-light, Häppchen 8)
//
// Verbrauchte LANGLEBIGE Org-Karten dürfen neu aktiviert werden
// (iOS-Eviction-Rettung). Sicherheitsmodell: Karten-Besitz = Auth-Anker;
// die alte Session stirbt beim Re-Entry SOFORT (sichtbar, nie still).
// - /invite/info: bietet reEntry an (statt 410) — außer Consumer-Token,
//   konvertierter Inhaber, abgelaufene Karte
// - /invite/join: Re-Entry-Pfad + origin_token + Ablösung + RL 3/Tag
// - /invite/revoke: sperrt die Karte endgültig (expires_at = jetzt)
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
const TOKEN     = 'guest_' + 'a'.repeat(32);
const OLD_TOKEN = 'guest_' + 'b'.repeat(32);

const ORG_ROW = {
  org_handle: 'colicotest', display_name: 'Colico Test-Organisation',
  verification_method: 'contract_invoice', verified_at: 1, status: 'active',
};

// Verbrauchtes 90d-Org-Template (Karte)
const usedOrgTemplate = (extra = {}) => ({
  token: TOKEN, convo_id: '', convo_type: 'dm', created_by: 'colicotest',
  created_at: Date.now() - 2 * DAY, expires_at: Date.now() + 88 * DAY,
  msg_limit: 0, msg_count: 0, guest_handle: '__used__', converted_to: null,
  label: 'Mitglied Müller', ...extra,
});

// scn: { orgRow, usedRow, convertedRow, oldSessions, revokeRow }
function buildEnv(scn = {}) {
  const runs = [];
  const kvDeletes = [];
  const prepare = (sql) => ({
    bind: (...args) => ({
      first: () => {
        if (/FROM orgs/i.test(sql)) return Promise.resolve(scn.orgRow ?? null);
        if (/guest_handle = '__used__'/.test(sql) && /SELECT \*/.test(sql)) return Promise.resolve(scn.usedRow ?? null);
        if (/origin_token = \? AND converted_to IS NOT NULL/.test(sql)) return Promise.resolve(scn.convertedRow ?? null);
        if (/SELECT 1 FROM guest_sessions WHERE guest_handle/.test(sql)) return Promise.resolve(null);
        if (/SELECT created_by, guest_handle FROM guest_sessions WHERE token/.test(sql)) return Promise.resolve(scn.revokeRow ?? null);
        // /invite/info-Template-Select (inkl. __used__-Matcher in der WHERE-Klausel)
        if (/SELECT convo_id, convo_type, created_by, created_at/.test(sql)) return Promise.resolve(scn.usedRow ?? null);
        // /invite/join-Template-Select (nur unbenutzt) → bei Re-Entry-Szenario leer
        if (/FROM guest_sessions WHERE token = \? AND \(guest_handle IS NULL/.test(sql)) return Promise.resolve(scn.unusedRow ?? null);
        if (/FROM conversations/i.test(sql)) return Promise.resolve({ name: null });
        return Promise.resolve(null);
      },
      all: () => {
        if (/origin_token = \? AND converted_to IS NULL/.test(sql)) return Promise.resolve({ results: scn.oldSessions ?? [] });
        return Promise.resolve({ results: [] });
      },
      run: () => { runs.push({ sql, args }); return Promise.resolve({ success: true, meta: { changes: 1 } }); },
    }),
  });
  return {
    RENEX_DB: { prepare },
    RENEX_KV: {
      get: vi.fn(() => Promise.resolve(null)),
      put: vi.fn(() => Promise.resolve()),
      delete: vi.fn((k) => { kvDeletes.push(k); return Promise.resolve(); }),
    },
    _runs: runs,
    _kvDeletes: kvDeletes,
  };
}

function req(method, body, path) {
  return {
    method, url: `https://api.renex.id${path}`,
    headers: { get: (k) => (String(k).toLowerCase() === 'cf-connecting-ip' ? '198.51.100.7' : null) },
    json: () => Promise.resolve(body),
  };
}
const call = (env, method, body, path, params) =>
  handleInviteRoutes(req(method, body, path), env, path.split('?')[0], params ?? new URLSearchParams());

describe('/invite/info — Re-Entry-Angebot', () => {
  const info = (env) => call(env, 'GET', null, `/invite/info?token=${TOKEN}`, new URLSearchParams({ token: TOKEN }));

  it('verbrauchte Org-Karte → valid + reEntry + verifiedSender', async () => {
    const env = buildEnv({ orgRow: ORG_ROW, usedRow: usedOrgTemplate() });
    const res = await info(env);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.valid).toBe(true);
    expect(body.reEntry).toBe(true);
    expect(body.displayName).toBe('Colico Test-Organisation');
    expect(body.verifiedSender?.handle).toBe('colicotest');
  });

  it('Consumer-Token (24h) bleibt strikt einmalig → 410 already_used', async () => {
    const env = buildEnv({ usedRow: usedOrgTemplate({
      created_at: Date.now() - 1000, expires_at: Date.now() - 1000 + DAY, label: null,
    }) });
    const res = await info(env);
    expect(res.status).toBe(410);
    expect((await res.json()).reason).toBe('already_used');
  });

  it('Inhaber hat Konto erstellt → Karte tot (410)', async () => {
    const env = buildEnv({ orgRow: ORG_ROW, usedRow: usedOrgTemplate(), convertedRow: { 1: 1 } });
    const res = await info(env);
    expect(res.status).toBe(410);
  });

  it('Org suspendiert → 410', async () => {
    const env = buildEnv({ orgRow: { ...ORG_ROW, status: 'suspended' }, usedRow: usedOrgTemplate() });
    expect((await info(env)).status).toBe(410);
  });
});

describe('/invite/join — Re-Entry-Durchführung', () => {
  const joinBody = { token: TOKEN, termsVersion: '2026-04-15', cfTurnstileToken: 't' };
  const OLD_SESSION = { token: OLD_TOKEN, convo_id: 'colicotest:guest_ab12cd34', guest_handle: 'guest_ab12cd34' };

  beforeEach(() => {
    vi.clearAllMocks();
    auth.getGuestToken.mockReturnValue(null);
    auth.rateLimit.mockResolvedValue(true);
    auth.pushToUserDO.mockResolvedValue(0);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ success: true }) })));
  });
  afterEach(() => vi.unstubAllGlobals());

  const join = (env) => call(env, 'POST', joinBody, '/invite/join');

  it('Re-Entry: neue Session mit origin_token+label, alte Session abgelöst, reEntry-Flag', async () => {
    const env = buildEnv({ orgRow: ORG_ROW, usedRow: usedOrgTemplate(), oldSessions: [OLD_SESSION] });
    const res = await join(env);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.reEntry).toBe(true);

    // Neue Session-Row trägt label UND origin_token (= Karten-Token)
    const ins = env._runs.find(r => /INSERT INTO guest_sessions/.test(r.sql) && /terms_version/.test(r.sql));
    expect(ins.sql).toContain('label');
    expect(ins.sql).toContain('origin_token');
    expect(ins.args[ins.args.length - 1]).toBe(TOKEN);
    expect(ins.args[ins.args.length - 2]).toBe('Mitglied Müller');

    // Alte Session abgelöst: D1-Expiry + KV-Purge + Kill-Push
    expect(env._runs.some(r => /SET expires_at = \? WHERE token = \?/.test(r.sql) && r.args[1] === OLD_TOKEN)).toBe(true);
    expect(env._kvDeletes).toContain(`guest_session:${OLD_TOKEN}`);
    expect(auth.pushToUserDO).toHaveBeenCalledWith(expect.anything(), 'guest_ab12cd34',
      expect.objectContaining({ type: 'GUEST_SESSION_KILLED' }));
  });

  it('Re-Entry-Limit erschöpft → 429, keine Session angelegt', async () => {
    auth.rateLimit.mockImplementation((e, key) => Promise.resolve(!key.startsWith('invite_reentry:')));
    const env = buildEnv({ orgRow: ORG_ROW, usedRow: usedOrgTemplate() });
    const res = await join(env);
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('reentry_limit');
    expect(env._runs.filter(r => /INSERT INTO guest_sessions/.test(r.sql)).length).toBe(0);
  });

  it('Consumer-Token verbraucht → weiterhin 404', async () => {
    const env = buildEnv({ usedRow: usedOrgTemplate({
      created_at: Date.now() - 1000, expires_at: Date.now() - 1000 + DAY,
    }) });
    expect((await join(env)).status).toBe(404);
  });

  it('normaler Erst-Join: KEIN origin_token bei Consumer-Invite (24h)', async () => {
    const env = buildEnv({ unusedRow: {
      token: TOKEN, convo_id: '', convo_type: 'dm', created_by: 'demo27',
      created_at: Date.now() - 1000, expires_at: Date.now() - 1000 + DAY,
      msg_limit: 20, msg_count: 0, guest_handle: '', converted_to: null, label: null,
    } });
    const res = await join(env);
    expect(res.status).toBe(200);
    const ins = env._runs.find(r => /INSERT INTO guest_sessions/.test(r.sql) && /terms_version/.test(r.sql));
    expect(ins.sql).not.toContain('origin_token');
    expect(ins.sql).not.toContain('label');
  });
});

describe('/invite/revoke — Karte endgültig sperren', () => {
  it('setzt expires_at = jetzt (blockiert auch Re-Entry)', async () => {
    auth.requireSession.mockResolvedValue({ handle: 'colicotest', isGuest: false });
    const env = buildEnv({ revokeRow: { created_by: 'colicotest', guest_handle: '__used__' } });
    const before = Date.now();
    const res = await call(env, 'POST', { token: TOKEN }, '/invite/revoke');
    expect(res.status).toBe(200);
    const upd = env._runs.find(r => /SET guest_handle = '__used__', expires_at = \?/.test(r.sql));
    expect(upd).toBeTruthy();
    expect(upd.args[0]).toBeGreaterThanOrEqual(before);
    expect(upd.args[1]).toBe(TOKEN);
  });
});
