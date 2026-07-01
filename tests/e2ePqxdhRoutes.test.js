// ======================================================
// Unit-Tests: /e2e/pqxdh/* Routen + Bundle-Validator (M2 / PQXDH §4.3)
// ======================================================
// (1) validatePqxdhUploadBundle (pure) — strukturelle Wohlgeformtheit.
// (2) upload / bundle / opk-count via Mock-Auth + Mock-env (DB/KV/PrekeyDO),
//     Muster channelSendGate.test.js. Prüft: KV/D1-Persistenz, atomarer
//     OPK-Consume via DO, SPK-only-Fallback ohne DO, 3-Wege-Access-Gate.
// ======================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/auth.js', () => ({
  requireSession: vi.fn(),
  requireAnySession: vi.fn(),
  rateLimit: vi.fn(() => Promise.resolve(true)),
  isAcceptedContact: vi.fn(() => Promise.resolve(false)),
  pushToUserDO: vi.fn(() => Promise.resolve(0)),
  revokeAllSessions: vi.fn(() => Promise.resolve()),
  getToken: vi.fn(() => null),
}));

import {
  handleE2eRoutes,
  validatePqxdhUploadBundle,
  isValid32ByteKeyB64,
  isValidEd25519SigB64,
} from '../src/routes/e2eRoutes.js';
import { requireSession, requireAnySession, isAcceptedContact } from '../src/auth.js';

const K32 = Buffer.alloc(32, 7).toString('base64');    // 44 Zeichen → atob === 32
const SIG = Buffer.alloc(64, 7).toString('base64');    // 88 → atob === 64
const EK = Buffer.alloc(1184, 7).toString('base64');   // 1580 → atob === 1184

const validBundle = () => ({
  deviceId: 'devicebbb',
  ik: { ikX: K32, ikEd: K32 },
  spk: { spkId: 'spk1', spk: K32, sig: SIG },
  pqspk: { pqspkId: 'pq1', ek: EK, sig: SIG },
  opks: [{ opkId: 'o1', opk: K32 }, { opkId: 'o2', opk: K32 }],
});

function buildEnv({ kv = {}, opkCount = 0, doOpk = { opkId: 'o1', opk: K32 }, doReason = 'ok', hasDO = true } = {}) {
  const kvStore = new Map(Object.entries(kv));
  return {
    _kv: kvStore,
    RENEX_KV: {
      get: async (k) => (kvStore.has(k) ? kvStore.get(k) : null),
      put: async (k, v) => { kvStore.set(k, v); },
    },
    RENEX_DB: {
      prepare: (sql) => ({
        bind: (..._a) => ({
          first: async () => (/COUNT\(\*\)/i.test(sql) ? { n: opkCount } : null),
          run: async () => ({ meta: { changes: 0 } }),
          all: async () => ({ results: [] }),
        }),
      }),
      batch: async (stmts) => stmts.map(() => ({ meta: { changes: 1 } })),
    },
    PREKEY_DO: hasDO ? {
      idFromName: (n) => ({ name: n }),
      get: () => ({ fetch: async () => ({ ok: true, json: async () => ({ opk: doOpk, reason: doReason }) }) }),
    } : undefined,
  };
}

function req({ method = 'GET', origin = 'https://app.renex.id', body = null, ct = 'application/json' } = {}) {
  return {
    method,
    url: 'https://api.renex.id/e2e/pqxdh/x',
    headers: { get: (k) => {
      const key = String(k || '').toLowerCase();
      if (key === 'origin') return origin;
      if (key === 'content-type') return ct;
      return null;
    } },
    json: async () => body,
  };
}
const P = (obj = {}) => new URLSearchParams(obj);

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue(null);
  requireAnySession.mockResolvedValue(null);
  isAcceptedContact.mockResolvedValue(false);
});

// ── (1) Validator ──────────────────────────────────────
describe('validatePqxdhUploadBundle (pure)', () => {
  it('gültiges Bundle → null', () => {
    expect(validatePqxdhUploadBundle(validBundle())).toBe(null);
  });
  it('leere OPK-Liste erlaubt (SPK-only-Device)', () => {
    expect(validatePqxdhUploadBundle({ ...validBundle(), opks: [] })).toBe(null);
  });
  it('fehlender/kaputter IK → bad_ik', () => {
    expect(validatePqxdhUploadBundle({ ...validBundle(), ik: { ikX: 'x', ikEd: K32 } })).toBe('bad_ik');
  });
  it('kaputte SPK-Sig → bad_spk', () => {
    const b = validBundle(); b.spk.sig = K32;   // 32B statt 64B
    expect(validatePqxdhUploadBundle(b)).toBe('bad_spk');
  });
  it('kaputter PQSPK-ek → bad_pqspk', () => {
    const b = validBundle(); b.pqspk.ek = K32;
    expect(validatePqxdhUploadBundle(b)).toBe('bad_pqspk');
  });
  it('zu kurzer deviceId → bad_deviceId', () => {
    expect(validatePqxdhUploadBundle({ ...validBundle(), deviceId: 'short' })).toBe('bad_deviceId');
  });
  it('kaputter OPK-Eintrag → bad_opk_entry', () => {
    expect(validatePqxdhUploadBundle({ ...validBundle(), opks: [{ opkId: 'o1', opk: 'nope' }] })).toBe('bad_opk_entry');
  });
  it('doppelte opkId → dup_opkId', () => {
    expect(validatePqxdhUploadBundle({ ...validBundle(), opks: [{ opkId: 'o1', opk: K32 }, { opkId: 'o1', opk: K32 }] })).toBe('dup_opkId');
  });
  it('>100 OPKs → bad_opks', () => {
    const opks = Array.from({ length: 101 }, (_, i) => ({ opkId: 'o' + i, opk: K32 }));
    expect(validatePqxdhUploadBundle({ ...validBundle(), opks })).toBe('bad_opks');
  });
  it('null → missing_body', () => {
    expect(validatePqxdhUploadBundle(null)).toBe('missing_body');
  });

  it('isValid32ByteKeyB64 / isValidEd25519SigB64 Randfälle', () => {
    expect(isValid32ByteKeyB64(K32)).toBe(true);
    expect(isValid32ByteKeyB64(SIG)).toBe(false);
    expect(isValidEd25519SigB64(SIG)).toBe(true);
    expect(isValidEd25519SigB64(K32)).toBe(false);
    expect(isValid32ByteKeyB64('!'.repeat(44))).toBe(false);
  });
});

// ── (2) Routen ─────────────────────────────────────────
describe('POST /e2e/pqxdh/upload', () => {
  it('gültiges Bundle → 200, KV + D1-OPKs persistiert', async () => {
    requireSession.mockResolvedValue({ handle: 'alice' });
    const env = buildEnv();
    const res = await handleE2eRoutes(req({ method: 'POST', body: validBundle() }), env, '/e2e/pqxdh/upload', P());
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toEqual({ ok: true, opks: 2 });
    const stored = JSON.parse(env._kv.get('e2e:pqxdh:bundle:alice:devicebbb'));
    expect(stored.pqspk.pqspkId).toBe('pq1');
    expect(stored.spk.spkId).toBe('spk1');
  });

  it('ungültiges Bundle → 400', async () => {
    requireSession.mockResolvedValue({ handle: 'alice' });
    const bad = validBundle(); bad.ik = null;
    const res = await handleE2eRoutes(req({ method: 'POST', body: bad }), buildEnv(), '/e2e/pqxdh/upload', P());
    expect(res.status).toBe(400);
  });

  it('nicht authentifiziert → 401', async () => {
    requireSession.mockResolvedValue(null);
    const res = await handleE2eRoutes(req({ method: 'POST', body: validBundle() }), buildEnv(), '/e2e/pqxdh/upload', P());
    expect(res.status).toBe(401);
  });

  it('D1-Fehler (Tabelle fehlt) → 200 SPK-only-Bundle in KV, opks=0', async () => {
    requireSession.mockResolvedValue({ handle: 'alice' });
    const env = buildEnv();
    env.RENEX_DB.batch = async () => { throw new Error('no such table: pqxdh_opk'); };
    const res = await handleE2eRoutes(req({ method: 'POST', body: validBundle() }), env, '/e2e/pqxdh/upload', P());
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.opks).toBe(0);
    expect(env._kv.has('e2e:pqxdh:bundle:alice:devicebbb')).toBe(true);   // Bundle trotzdem gespeichert
  });
});

describe('GET /e2e/pqxdh/bundle', () => {
  const storedKv = () => ({
    'e2e:pqxdh:bundle:bob:devicebbb': JSON.stringify({
      ik: { ikX: K32, ikEd: K32 }, spk: { spkId: 'spk1', spk: K32, sig: SIG }, pqspk: { pqspkId: 'pq1', ek: EK, sig: SIG },
    }),
  });

  it('self → Wire mit atomar konsumierter OPK', async () => {
    requireAnySession.mockResolvedValue({ handle: 'bob' });
    const env = buildEnv({ kv: storedKv(), doOpk: { opkId: 'o7', opk: K32 }, doReason: 'ok' });
    const res = await handleE2eRoutes(req(), env, '/e2e/pqxdh/bundle', P({ user: 'bob', device: 'devicebbb' }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.deviceId).toBe('devicebbb');
    expect(data.pqspk.pqspkId).toBe('pq1');
    expect(data.opk).toEqual({ opkId: 'o7', opk: K32 });
  });

  it('kein Trust-Kontext → 404 (kein Leak)', async () => {
    requireAnySession.mockResolvedValue({ handle: 'alice' });
    isAcceptedContact.mockResolvedValue(false);
    const env = buildEnv({ kv: storedKv() });   // _sharesTrustContext-D1 → null
    const res = await handleE2eRoutes(req(), env, '/e2e/pqxdh/bundle', P({ user: 'bob', device: 'devicebbb' }));
    expect(res.status).toBe(404);
  });

  it('mit Trust-Kontext (Kontakt) → 200', async () => {
    requireAnySession.mockResolvedValue({ handle: 'alice' });
    isAcceptedContact.mockResolvedValue(true);
    const env = buildEnv({ kv: storedKv() });
    const res = await handleE2eRoutes(req(), env, '/e2e/pqxdh/bundle', P({ user: 'bob', device: 'devicebbb' }));
    expect(res.status).toBe(200);
    expect((await res.json()).opk).not.toBe(null);
  });

  it('PrekeyDO ungebunden → opk=null (SPK-only-Fallback)', async () => {
    requireAnySession.mockResolvedValue({ handle: 'bob' });
    const env = buildEnv({ kv: storedKv(), hasDO: false });
    const res = await handleE2eRoutes(req(), env, '/e2e/pqxdh/bundle', P({ user: 'bob', device: 'devicebbb' }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.opk).toBe(null);
    expect(data.pqspk.pqspkId).toBe('pq1');   // SPK/PQSPK trotzdem da
  });

  it('kein Bundle vorhanden → 404', async () => {
    requireAnySession.mockResolvedValue({ handle: 'bob' });
    const env = buildEnv({ kv: {} });
    const res = await handleE2eRoutes(req(), env, '/e2e/pqxdh/bundle', P({ user: 'bob', device: 'devicebbb' }));
    expect(res.status).toBe(404);
  });

  it('fehlender device-Param → 400', async () => {
    requireAnySession.mockResolvedValue({ handle: 'bob' });
    const res = await handleE2eRoutes(req(), buildEnv(), '/e2e/pqxdh/bundle', P({ user: 'bob' }));
    expect(res.status).toBe(400);
  });
});

describe('GET /e2e/pqxdh/opk-count', () => {
  it('self → Count aus D1', async () => {
    requireAnySession.mockResolvedValue({ handle: 'bob' });
    const env = buildEnv({ opkCount: 42 });
    const res = await handleE2eRoutes(req(), env, '/e2e/pqxdh/opk-count', P({ user: 'bob', device: 'devicebbb' }));
    expect(await res.json()).toEqual({ count: 42 });
  });

  it('kein Trust → count 0 (kein Leak)', async () => {
    requireAnySession.mockResolvedValue({ handle: 'alice' });
    isAcceptedContact.mockResolvedValue(false);
    const env = buildEnv({ opkCount: 42 });
    const res = await handleE2eRoutes(req(), env, '/e2e/pqxdh/opk-count', P({ user: 'bob', device: 'devicebbb' }));
    expect(await res.json()).toEqual({ count: 0 });
  });
});
