// ======================================================
// M2 — Atomarer Rate-Limiter (RateLimiterDO) Tests
// ======================================================
// Der DO selbst läuft nur im Workers-Runtime; hier testen wir die pure
// Kern-Logik (rateLimitDecision) deterministisch + das {strict}-Routing /
// den KV-Fallback in rateLimit() über Mocks.
// ======================================================
import { describe, it, expect } from 'vitest';
import { rateLimitDecision } from '../src/rateLimiterDO.js';
import { rateLimit } from '../src/auth.js';

// ── Mocks ─────────────────────────────────────────────
function makeMockDO() {
  const store = new Map(); // id.name → {bucket,count}
  return {
    _store: store,
    idFromName: (key) => ({ name: key }),
    get: (id) => ({
      fetch: async (url) => {
        const u = new URL(url);
        const w = Number(u.searchParams.get('w'));
        const l = Number(u.searchParams.get('l'));
        const prev = store.get(id.name) || null;
        const { allow, state } = rateLimitDecision(prev, Date.now(), w, l);
        if (allow) store.set(id.name, state);
        return { ok: true, json: async () => ({ allow }) };
      },
    }),
  };
}
function makeMockKV() {
  const m = new Map();
  return {
    _m: m,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
  };
}
const throwingDO = {
  idFromName: (k) => ({ name: k }),
  get: () => ({ fetch: async () => { throw new Error('do down'); } }),
};

// ── Pure Kern-Logik ───────────────────────────────────
describe('rateLimitDecision (pure)', () => {
  it('erlaubt den ersten Aufruf (count 1)', () => {
    const r = rateLimitDecision(null, 1000, 1000, 3);
    expect(r.allow).toBe(true);
    expect(r.state).toEqual({ bucket: 1, count: 1 });
  });

  it('erlaubt bis limit, dann harter Cut — kein Overshoot', () => {
    let state = null;
    const out = [];
    for (let i = 0; i < 5; i++) {
      const r = rateLimitDecision(state, 5000, 1000, 3);
      out.push(r.allow);
      state = r.state;
    }
    expect(out).toEqual([true, true, true, false, false]);
    expect(state.count).toBe(3); // bleibt bei limit
  });

  it('setzt den Zähler im neuen Fenster zurück', () => {
    let r = rateLimitDecision({ bucket: 5, count: 2 }, 5000, 1000, 2); // Bucket 5 voll
    expect(r.allow).toBe(false);
    r = rateLimitDecision({ bucket: 5, count: 2 }, 6000, 1000, 2);     // Bucket 6 → reset
    expect(r.allow).toBe(true);
    expect(r.state).toEqual({ bucket: 6, count: 1 });
  });

  it('Rückwärts-Clock setzt den Zähler NICHT zurück (Monotonie, #11)', () => {
    // Bucket 5 voll, dann springt die Wall-Clock zurück auf Bucket 4 → bleibt geblockt.
    const r = rateLimitDecision({ bucket: 5, count: 3 }, 4000, 1000, 3);
    expect(r.allow).toBe(false);
    expect(r.state.bucket).toBe(5);
  });
});

// ── rateLimit() {strict}-Routing + Fallback ───────────
describe('rateLimit() {strict}', () => {
  it('routet auf den DO und cuttet hart bei limit', async () => {
    const env = { RATE_LIMITER_DO: makeMockDO(), RENEX_KV: makeMockKV() };
    const out = [];
    for (let i = 0; i < 4; i++) {
      out.push(await rateLimit(env, 'login_start:1.2.3.4', 60_000, 3, { strict: true }));
    }
    expect(out).toEqual([true, true, true, false]);
  });

  it('non-strict nutzt KV — DO bleibt unangetastet', async () => {
    const kv = makeMockKV();
    const dom = makeMockDO();
    const ok = await rateLimit({ RATE_LIMITER_DO: dom, RENEX_KV: kv }, 'profile:x', 60_000, 5);
    expect(ok).toBe(true);
    expect(dom._store.size).toBe(0);
    expect(kv._m.size).toBe(1);
  });

  it('DO-Fehler → Fallback auf KV (Limit greift weiter)', async () => {
    const env = { RATE_LIMITER_DO: throwingDO, RENEX_KV: makeMockKV() };
    const out = [];
    for (let i = 0; i < 3; i++) {
      out.push(await rateLimit(env, 'register_start:9.9.9.9', 60_000, 2, { strict: true }));
    }
    expect(out).toEqual([true, true, false]);
  });

  it('DO + KV beide kaputt + strict → failClosed (false)', async () => {
    const brokenKV = {
      get: async () => { throw new Error('kv down'); },
      put: async () => { throw new Error('kv down'); },
    };
    const ok = await rateLimit({ RATE_LIMITER_DO: throwingDO, RENEX_KV: brokenKV }, 'recovery_verify:x', 3600_000, 5, { strict: true });
    expect(ok).toBe(false);
  });

  it('strict aber kein DO-Binding → Fallback auf KV', async () => {
    const kv = makeMockKV();
    const ok = await rateLimit({ RENEX_KV: kv }, 'login_start:x', 60_000, 5, { strict: true });
    expect(ok).toBe(true);
    expect(kv._m.size).toBe(1);
  });
});
