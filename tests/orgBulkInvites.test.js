// ======================================================
// Bulk-Issuance + Label + Invite-Liste (eGov 1.2, Häppchen 6)
//
// - POST /invite/bulk: nur Orgs (403), expiresInDays Pflicht, N via labels
//   ODER count (1..500), msg_limit-Default 0, Batch-Inserts in 50er-Chunks.
// - Label org-gated am /invite/create; wandert beim /invite/join aufs Session-Row.
// - GET /invite/list: Status-Ableitung; Session-Tokens werden NIE exponiert,
//   Template-Tokens nur für status=open.
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
const ORG_ROW = {
  org_handle: 'colicotest', display_name: 'Colico Test-Organisation',
  verification_method: 'contract_invoice', verified_at: 1, status: 'active',
};

function buildEnv(scn = {}) {
  const inserts = [];       // direkte .run()-Inserts
  const batches = [];       // db.batch()-Chunks
  const mkBound = (sql, args) => ({ __sql: sql, __args: args,
    run: () => { if (/^\s*INSERT/i.test(sql)) inserts.push({ sql, args }); return Promise.resolve({ success: true, meta: { changes: 1 } }); },
    first: () => {
      if (/FROM orgs/i.test(sql)) return Promise.resolve(scn.orgRow ?? null);
      if (/SELECT 1 FROM guest_sessions WHERE guest_handle/i.test(sql)) return Promise.resolve(null);
      if (/FROM guest_sessions WHERE token/i.test(sql)) return Promise.resolve(scn.inviteRow ?? null);
      if (/FROM conversations/i.test(sql)) return Promise.resolve({ name: null });
      return Promise.resolve(null);
    },
    all: () => {
      if (/FROM guest_sessions WHERE created_by/i.test(sql)) return Promise.resolve({ results: scn.listRows ?? [] });
      return Promise.resolve({ results: [] });
    },
  });
  return {
    RENEX_DB: {
      prepare: (sql) => ({ bind: (...args) => mkBound(sql, args) }),
      batch: (stmts) => { batches.push(stmts); stmts.forEach(s => { if (/^\s*INSERT/i.test(s.__sql)) inserts.push({ sql: s.__sql, args: s.__args }); }); return Promise.resolve(stmts.map(() => ({ success: true }))); },
    },
    RENEX_KV: { get: vi.fn(() => Promise.resolve(null)), put: vi.fn(() => Promise.resolve()), delete: vi.fn(() => Promise.resolve()) },
    _inserts: inserts,
    _batches: batches,
  };
}

function req(method, body, path) {
  return {
    method, url: `https://api.renex.id${path}`,
    headers: { get: (k) => (String(k).toLowerCase() === 'cf-connecting-ip' ? '198.51.100.7' : null) },
    json: () => Promise.resolve(body),
  };
}
const call = (env, method, body, path) =>
  handleInviteRoutes(req(method, body, path), env, path.split('?')[0], new URLSearchParams());

describe('POST /invite/bulk', () => {
  beforeEach(() => auth.requireSession.mockResolvedValue({ handle: 'colicotest', isGuest: false }));

  it('labels bestimmen N; jedes Invite bekommt Token+URL+Label; Batch genutzt', async () => {
    const env = buildEnv({ orgRow: ORG_ROW });
    const res = await call(env, 'POST', { expiresInDays: 90, labels: ['Müller', 'Meier', '  ', 'Patient 0042'] }, '/invite/bulk');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.count).toBe(4);
    expect(body.invites).toHaveLength(4);
    expect(body.invites[0].label).toBe('Müller');
    expect(body.invites[2].label).toBeNull();          // leere Zeile → ohne Label
    expect(body.invites[3].inviteUrl).toContain('/join?token=guest_');
    expect(new Set(body.invites.map(i => i.token)).size).toBe(4);   // eindeutige Tokens
    expect(body.invites[0].msgLimit).toBe(0);          // Org-Default unbegrenzt
    expect(env._batches.length).toBe(1);
    // Label-Insert vs. Plain-Insert korrekt gewählt
    expect(env._inserts.filter(i => /label\)/.test(i.sql)).length).toBe(3);
  });

  it('count ohne labels; 120 Invites → 3 Batch-Chunks à ≤50', async () => {
    const env = buildEnv({ orgRow: ORG_ROW });
    const res = await call(env, 'POST', { expiresInDays: 30, count: 120 }, '/invite/bulk');
    const body = await res.json();
    expect(body.count).toBe(120);
    expect(env._batches.length).toBe(3);
    expect(Math.max(...env._batches.map(b => b.length))).toBe(50);
  });

  it('Gates: Nicht-Org 403; fehlendes/ungültiges expiresInDays 400; N>500 400', async () => {
    expect((await call(buildEnv(), 'POST', { expiresInDays: 90, count: 5 }, '/invite/bulk')).status).toBe(403);
    const env = buildEnv({ orgRow: ORG_ROW });
    expect((await call(env, 'POST', { count: 5 }, '/invite/bulk')).status).toBe(400);
    expect((await call(env, 'POST', { expiresInDays: 90, count: 501 }, '/invite/bulk')).status).toBe(400);
    expect((await call(env, 'POST', { expiresInDays: 90, labels: [] }, '/invite/bulk')).status).toBe(400);
  });
});

describe('Label am /invite/create + Join-Mitnahme', () => {
  beforeEach(() => auth.requireSession.mockResolvedValue({ handle: 'colicotest', isGuest: false }));

  it('create mit label (Org) → label im INSERT + Response; Nicht-Org → 403', async () => {
    const env = buildEnv({ orgRow: ORG_ROW });
    const res = await call(env, 'POST', { expiresInDays: 90, label: '  Mitglied Müller ' }, '/invite/create');
    const body = await res.json();
    expect(body.label).toBe('Mitglied Müller');
    const ins = env._inserts[0];
    expect(ins.sql).toContain('label');
    expect(ins.args[ins.args.length - 1]).toBe('Mitglied Müller');

    expect((await call(buildEnv(), 'POST', { label: 'x' }, '/invite/create')).status).toBe(403);
  });

  it('join kopiert Template-Label auf die Session-Row', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ success: true }) })));
    const env = buildEnv({
      orgRow: ORG_ROW,
      inviteRow: {
        token: 'guest_' + 'a'.repeat(32), convo_id: '', convo_type: 'dm', created_by: 'colicotest',
        created_at: Date.now() - DAY, expires_at: Date.now() + 89 * DAY,
        msg_limit: 0, msg_count: 0, guest_handle: '', converted_to: null, label: 'Mitglied Müller',
      },
    });
    const res = await call(env, 'POST', {
      token: 'guest_' + 'a'.repeat(32), termsVersion: '2026-04-15', cfTurnstileToken: 't',
    }, '/invite/join');
    expect(res.status).toBe(200);
    const sessionInsert = env._inserts.find(i => /terms_version/.test(i.sql));
    expect(sessionInsert.sql).toContain('label');
    expect(sessionInsert.sql).toContain('origin_token');   // H8: Org-Invites tragen Karten-Token
    expect(sessionInsert.args[sessionInsert.args.length - 2]).toBe('Mitglied Müller');
    expect(sessionInsert.args[sessionInsert.args.length - 1]).toBe('guest_' + 'a'.repeat(32));
    vi.unstubAllGlobals();
  });
});

describe('GET /invite/list', () => {
  beforeEach(() => auth.requireSession.mockResolvedValue({ handle: 'colicotest', isGuest: false }));

  it('Status-Ableitung + Token-Hygiene (Session-Token NIE exponiert)', async () => {
    const now = Date.now();
    const env = buildEnv({ orgRow: ORG_ROW, listRows: [
      { token: 'guest_' + '1'.repeat(32), guest_handle: '',            converted_to: null,   created_at: now, expires_at: now + DAY, msg_limit: 0,  msg_count: 0, label: 'Offen' },
      { token: 'guest_' + '2'.repeat(32), guest_handle: '__used__',    converted_to: null,   created_at: now, expires_at: now + DAY, msg_limit: 0,  msg_count: 0, label: 'Konsumiert' },
      { token: 'guest_' + '3'.repeat(32), guest_handle: 'guest_ab12cd34', converted_to: null, created_at: now, expires_at: now + DAY, msg_limit: 0,  msg_count: 7, label: 'Aktiv' },
      { token: 'guest_' + '4'.repeat(32), guest_handle: 'guest_ff12cd34', converted_to: null, created_at: now - 2 * DAY, expires_at: now - DAY, msg_limit: 20, msg_count: 3, label: null },
      { token: 'guest_' + '5'.repeat(32), guest_handle: 'guest_aa12cd34', converted_to: 'realuser', created_at: now, expires_at: now + DAY, msg_limit: 20, msg_count: 9, label: null },
    ]});
    const res = await call(env, 'GET', null, '/invite/list');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.invites.map(i => i.status)).toEqual(['open', 'consumed', 'active', 'expired', 'converted']);
    // Token nur beim offenen Template:
    expect(body.invites[0].token).toBe('guest_' + '1'.repeat(32));
    expect(body.invites.slice(1).every(i => i.token === null && i.inviteUrl === null)).toBe(true);
    // Label-Brücke + Aktivität:
    expect(body.invites[2].guestHandle).toBe('guest_ab12cd34');
    expect(body.invites[2].label).toBe('Aktiv');
    expect(body.invites[2].msgCount).toBe(7);
  });

  it('Nicht-Org → 403 (Consumer-UI erkennt daran den Modus)', async () => {
    const res = await call(buildEnv(), 'GET', null, '/invite/list');
    expect(res.status).toBe(403);
  });
});
