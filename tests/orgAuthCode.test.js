// ======================================================
// Empfänger-Auth per Aktivierungscode (eGov 1.3)
//
// Entscheid 2026-07-15: KEINE SMS/Telefonnummer bei RENEX — der Zweitfaktor
// gehört der Org und dem Papier. Hash+Salt kommen fertig aus dem Org-Browser,
// RENEX sieht den Klartext-Code NIE.
//
// Kern-Garantien:
//  - /invite/create + /invite/bulk: codeSalt/codeHash nur für verifizierte Orgs,
//    b64-validiert, auth_level='code' persistiert
//  - /invite/info: liefert requiresCode + codeSalt, aber NIEMALS den Hash
//  - /invite/join: falscher/fehlender Code → 403 + attempts++, KEINE Session;
//    korrekter Code → Join läuft; ab 5 Fehlversuchen gesperrt
//  - /invite/accept + /invite/join-auth (eingeloggte Einlöser) sind ebenfalls
//    gegated — sonst umginge ein Konto-Inhaber die Empfänger-Auth
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
const SALT = 'c2FsdHNhbHRzYWx0c2FsdA==';               // b64
const HASH = 'aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo';       // b64 (Server vergleicht nur)
const WRONG = 'd3Jvbmd3cm9uZ3dyb25nd3Jvbmd3cm9uZw==';

const ORG_ROW = {
  org_handle: 'colicotest', display_name: 'Colico Test-Organisation',
  verification_method: 'contract_invoice', verified_at: 1, status: 'active',
};

// Org-Invite-Template mit Code (90 Tage)
const codeRow = (extra = {}) => ({
  token: TOKEN, convo_id: '', convo_type: 'dm', created_by: 'colicotest',
  created_at: Date.now() - DAY, expires_at: Date.now() + 89 * DAY,
  msg_limit: 0, msg_count: 0, guest_handle: '', converted_to: null, label: 'Patient 0042',
  auth_level: 'code', code_salt: SALT, code_hash: HASH, code_attempts: 0, ...extra,
});

function buildEnv(scn = {}) {
  const runs = [], inserts = [], batches = [];
  const mk = (sql, args) => ({
    __sql: sql, __args: args,
    first: () => {
      if (/FROM orgs/i.test(sql)) return Promise.resolve(scn.orgRow ?? null);
      if (/SELECT 1 FROM guest_sessions WHERE guest_handle/i.test(sql)) return Promise.resolve(null);
      // Re-Entry-Suche (NUR __used__) → hier nie relevant; muss VOR dem
      // allgemeinen Token-Select stehen, aber der /invite/info-Select enthält
      // '__used__' ebenfalls (als OR-Zweig) → präzise auf die Re-Entry-Form prüfen.
      if (/WHERE token = \? AND guest_handle = '__used__'/.test(sql)) return Promise.resolve(null);
      if (/FROM guest_sessions WHERE token/i.test(sql)) return Promise.resolve(scn.inviteRow ?? null);
      if (/FROM conversations/i.test(sql)) return Promise.resolve({ name: null });
      return Promise.resolve(null);
    },
    all: () => Promise.resolve({ results: scn.listRows ?? [] }),
    run: () => {
      runs.push({ sql, args });
      if (/^\s*INSERT/i.test(sql)) inserts.push({ sql, args });
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    },
  });
  return {
    RENEX_DB: {
      prepare: (sql) => ({ bind: (...args) => mk(sql, args) }),
      batch: (s) => { batches.push(s); s.forEach(x => inserts.push({ sql: x.__sql, args: x.__args })); return Promise.resolve([]); },
    },
    RENEX_KV: { get: vi.fn(() => Promise.resolve(null)), put: vi.fn(() => Promise.resolve()), delete: vi.fn(() => Promise.resolve()) },
    _runs: runs, _inserts: inserts, _batches: batches,
  };
}

const req = (method, body, path) => ({
  method, url: `https://api.renex.id${path}`,
  headers: { get: (k) => (String(k).toLowerCase() === 'cf-connecting-ip' ? '198.51.100.7' : null) },
  json: () => Promise.resolve(body),
});
const call = (env, method, body, path, params) =>
  handleInviteRoutes(req(method, body, path), env, path.split('?')[0], params ?? new URLSearchParams());

describe('/invite/create — Code anlegen', () => {
  beforeEach(() => auth.requireSession.mockResolvedValue({ handle: 'colicotest', isGuest: false }));

  it('Org: salt+hash → auth_level=code persistiert, Response meldet authLevel', async () => {
    const env = buildEnv({ orgRow: ORG_ROW });
    const res = await call(env, 'POST', { expiresInDays: 90, codeSalt: SALT, codeHash: HASH }, '/invite/create');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.authLevel).toBe('code');
    const ins = env._inserts[0];
    expect(ins.sql).toContain('auth_level');
    expect(ins.args.slice(-3)).toEqual(['code', SALT, HASH]);
  });

  it('Nicht-Org → 403 org_required', async () => {
    const res = await call(buildEnv(), 'POST', { codeSalt: SALT, codeHash: HASH }, '/invite/create');
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('org_required');
  });

  it('ungültige Formate / Hash ohne Salt → 400', async () => {
    const env = buildEnv({ orgRow: ORG_ROW });
    expect((await call(env, 'POST', { codeSalt: 'kurz', codeHash: HASH }, '/invite/create')).status).toBe(400);
    expect((await call(env, 'POST', { codeSalt: SALT, codeHash: '!!nicht b64!!' }, '/invite/create')).status).toBe(400);
    expect((await call(env, 'POST', { codeHash: HASH }, '/invite/create')).status).toBe(400);
  });

  it('ohne Code-Felder: kein auth_level (Consumer/Org-ohne-Code unverändert)', async () => {
    const env = buildEnv({ orgRow: ORG_ROW });
    await call(env, 'POST', { expiresInDays: 90 }, '/invite/create');
    expect(env._inserts[0].sql).not.toContain('auth_level');
  });
});

describe('/invite/info — Salt öffentlich, Hash NIE', () => {
  it('requiresCode + codeSalt geliefert, code_hash NICHT im Body', async () => {
    const env = buildEnv({ orgRow: ORG_ROW, inviteRow: codeRow() });
    const res = await call(env, 'GET', null, `/invite/info?token=${TOKEN}`, new URLSearchParams({ token: TOKEN }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.requiresCode).toBe(true);
    expect(body.codeSalt).toBe(SALT);
    expect(JSON.stringify(body)).not.toContain(HASH);      // Hash NIEMALS ausgeliefert
    expect(body.codeLocked).toBe(false);
  });

  it('gesperrte Karte → codeLocked true', async () => {
    const env = buildEnv({ orgRow: ORG_ROW, inviteRow: codeRow({ code_attempts: 5 }) });
    const body = await (await call(env, 'GET', null, `/invite/info?token=${TOKEN}`, new URLSearchParams({ token: TOKEN }))).json();
    expect(body.codeLocked).toBe(true);
  });

  it('Invite ohne Code → requiresCode false, codeSalt null', async () => {
    const env = buildEnv({ orgRow: ORG_ROW, inviteRow: codeRow({ auth_level: null, code_salt: null, code_hash: null }) });
    const body = await (await call(env, 'GET', null, `/invite/info?token=${TOKEN}`, new URLSearchParams({ token: TOKEN }))).json();
    expect(body.requiresCode).toBe(false);
    expect(body.codeSalt).toBeNull();
  });
});

describe('/invite/join — Code-Gate', () => {
  const joinBody = (codeHash) => ({
    token: TOKEN, termsVersion: '2026-04-15', cfTurnstileToken: 't',
    ...(codeHash !== undefined ? { codeHash } : {}),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    auth.rateLimit.mockResolvedValue(true);
    auth.getGuestToken.mockReturnValue(null);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ success: true }) })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('korrekter Code → Join läuft (Session angelegt)', async () => {
    const env = buildEnv({ orgRow: ORG_ROW, inviteRow: codeRow() });
    const res = await call(env, 'POST', joinBody(HASH), '/invite/join');
    expect(res.status).toBe(200);
    expect(env._inserts.some(i => /terms_version/.test(i.sql))).toBe(true);
  });

  it('falscher Code → 403, attempts++, KEINE Session', async () => {
    const env = buildEnv({ orgRow: ORG_ROW, inviteRow: codeRow() });
    const res = await call(env, 'POST', joinBody(WRONG), '/invite/join');
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.code).toBe('code_invalid');
    expect(body.attemptsLeft).toBe(4);
    expect(env._runs.some(r => /SET code_attempts = \?/.test(r.sql) && r.args[0] === 1)).toBe(true);
    expect(env._inserts.some(i => /terms_version/.test(i.sql))).toBe(false);   // keine Session!
  });

  it('fehlender Code bei Code-Invite → 403', async () => {
    const env = buildEnv({ orgRow: ORG_ROW, inviteRow: codeRow() });
    const res = await call(env, 'POST', joinBody(undefined), '/invite/join');
    expect(res.status).toBe(403);
    expect(env._inserts.some(i => /terms_version/.test(i.sql))).toBe(false);
  });

  it('letzter Fehlversuch → code_locked', async () => {
    const env = buildEnv({ orgRow: ORG_ROW, inviteRow: codeRow({ code_attempts: 4 }) });
    const body = await (await call(env, 'POST', joinBody(WRONG), '/invite/join')).json();
    expect(body.code).toBe('code_locked');
    expect(body.attemptsLeft).toBe(0);
  });

  it('bereits gesperrt (5 Versuche) → 403 code_locked, kein weiterer Zähler', async () => {
    const env = buildEnv({ orgRow: ORG_ROW, inviteRow: codeRow({ code_attempts: 5 }) });
    const res = await call(env, 'POST', joinBody(HASH), '/invite/join');   // selbst korrekter Code
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('code_locked');
    expect(env._runs.some(r => /SET code_attempts/.test(r.sql))).toBe(false);
  });

  it('Rate-Limit erschöpft → 429 code_rate_limit', async () => {
    auth.rateLimit.mockImplementation((e, key) => Promise.resolve(!key.startsWith('invite_code:')));
    const env = buildEnv({ orgRow: ORG_ROW, inviteRow: codeRow() });
    const res = await call(env, 'POST', joinBody(WRONG), '/invite/join');
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('code_rate_limit');
  });

  it('Invite OHNE Code: join unverändert ohne codeHash', async () => {
    const env = buildEnv({ orgRow: ORG_ROW, inviteRow: codeRow({ auth_level: null, code_salt: null, code_hash: null }) });
    const res = await call(env, 'POST', joinBody(undefined), '/invite/join');
    expect(res.status).toBe(200);
  });
});

describe('Eingeloggte Einlöse-Pfade sind ebenfalls gegated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.rateLimit.mockResolvedValue(true);
    auth.requireSession.mockResolvedValue({ handle: 'buerger42', isGuest: false });
  });

  it('/invite/accept ohne Code → 403', async () => {
    const env = buildEnv({ orgRow: ORG_ROW, inviteRow: codeRow() });
    const res = await call(env, 'POST', { token: TOKEN }, '/invite/accept');
    expect(res.status).toBe(403);
  });

  it('/invite/accept mit korrektem Code → läuft durch', async () => {
    const env = buildEnv({ orgRow: ORG_ROW, inviteRow: codeRow() });
    const res = await call(env, 'POST', { token: TOKEN, codeHash: HASH }, '/invite/accept');
    expect(res.status).toBe(200);
  });

  it('/invite/join-auth ohne Code → 403', async () => {
    const env = buildEnv({ orgRow: ORG_ROW, inviteRow: codeRow() });
    const res = await call(env, 'POST', { token: TOKEN }, '/invite/join-auth');
    expect(res.status).toBe(403);
  });
});

describe('/invite/bulk — ein Code pro Empfänger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.rateLimit.mockResolvedValue(true);
    auth.requireSession.mockResolvedValue({ handle: 'colicotest', isGuest: false });
  });

  it('codes[] parallel zu labels[]; null-Eintrag = Invite ohne Code', async () => {
    const env = buildEnv({ orgRow: ORG_ROW });
    const res = await call(env, 'POST', {
      expiresInDays: 90,
      labels: ['Müller', 'Meier'],
      codes: [{ salt: SALT, hash: HASH }, null],
    }, '/invite/bulk');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.invites[0].authLevel).toBe('code');
    expect(body.invites[1].authLevel).toBeNull();
    expect(env._inserts.filter(i => /auth_level/.test(i.sql)).length).toBe(1);
  });

  it('codes-Länge ≠ N → 400', async () => {
    const env = buildEnv({ orgRow: ORG_ROW });
    const res = await call(env, 'POST', {
      expiresInDays: 90, count: 3, codes: [{ salt: SALT, hash: HASH }],
    }, '/invite/bulk');
    expect(res.status).toBe(400);
  });

  it('ungültiges Code-Paar → 400', async () => {
    const env = buildEnv({ orgRow: ORG_ROW });
    const res = await call(env, 'POST', {
      expiresInDays: 90, count: 1, codes: [{ salt: 'kurz', hash: HASH }],
    }, '/invite/bulk');
    expect(res.status).toBe(400);
  });
});
