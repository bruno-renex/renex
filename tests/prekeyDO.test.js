// ======================================================
// Unit-Tests: PrekeyDO — atomarer One-Time-Prekey-Consume (M2 / PQXDH §4.3)
// ======================================================
// Zwei Ebenen (Muster rateLimiterDO.test.js):
//  1. opkCapDecision (pure) — sliding-bucket Cap-Logik.
//  2. PrekeyDO.fetch mit Mock-Storage + Mock-D1 — Pop, leerer Pool, Cap,
//     Einweg-Garantie (dieselbe OPK wird NIE zweimal ausgegeben).
// ======================================================
import { describe, it, expect } from 'vitest';
import { opkCapDecision, PrekeyDO } from '../src/prekeyDO.js';

// ── Mock DurableObjectState (klassisches KV-Storage + blockConcurrencyWhile) ──
function makeState(store = new Map()) {
  return {
    _store: store,
    storage: {
      get: async (k) => (store.has(k) ? store.get(k) : undefined),
      put: async (k, v) => { store.set(k, v); },
      deleteAll: async () => { store.clear(); },
      setAlarm: async () => {},
    },
    // Serialisierung ist im Test trivial (sequenziell) → callback direkt ausführen.
    blockConcurrencyWhile: async (cb) => cb(),
  };
}

// ── Mock env.RENEX_DB: der UPDATE…RETURNING (Tombstone) pop't die erste
//    verfügbare OPK aus `pool` (Grabstein = aus `pool` entfernt) ──
function makeEnv(pool) {
  return {
    RENEX_DB: {
      prepare: (sql) => ({
        bind: (..._args) => ({
          first: async () => {
            if (/UPDATE pqxdh_opk/i.test(sql)) {
              const row = pool.shift();          // FIFO-Pop (= Tombstone), mutiert `pool`
              return row ? { opkId: row.opkId, opk: row.opk } : null;
            }
            return null;
          },
        }),
      }),
    },
  };
}

function consumeReq({ w = 3600000, l = 3, user = 'bob', deviceId = 'devB', requester = 'alice' } = {}) {
  return new Request(`https://prekey/consume?w=${w}&l=${l}`, {
    method: 'POST',
    body: JSON.stringify({ user, deviceId, requester }),
  });
}

describe('opkCapDecision (pure)', () => {
  it('erlaubt den ersten Consume (count 1)', () => {
    const r = opkCapDecision(null, 1000, 1000, 3);
    expect(r.allow).toBe(true);
    expect(r.state).toEqual({ bucket: 1, count: 1 });
  });

  it('erlaubt bis cap, dann harter Cut — kein Overshoot', () => {
    let state = null;
    const out = [];
    for (let i = 0; i < 5; i++) {
      const r = opkCapDecision(state, 5000, 1000, 3);
      out.push(r.allow);
      state = r.state;
    }
    expect(out).toEqual([true, true, true, false, false]);
    expect(state.count).toBe(3);
  });

  it('Fensterwechsel setzt den Zähler zurück', () => {
    const first = opkCapDecision(null, 1000, 1000, 2).state;   // bucket 1
    const next = opkCapDecision(first, 2000, 1000, 2);          // bucket 2
    expect(next.allow).toBe(true);
    expect(next.state).toEqual({ bucket: 2, count: 1 });
  });

  it('Wall-Clock-Rücksprung setzt den Bucket NICHT zurück (monoton)', () => {
    const ahead = opkCapDecision(null, 10000, 1000, 2).state;  // bucket 10
    const back = opkCapDecision(ahead, 1000, 1000, 2);         // now zeigt zurück
    expect(back.state.bucket).toBe(10);                         // bleibt 10
  });
});

describe('PrekeyDO.fetch — atomarer Consume', () => {
  it('pop\'t genau eine OPK und gibt Pub zurück', async () => {
    const pool = [{ opkId: 'o1', opk: 'PUB1' }, { opkId: 'o2', opk: 'PUB2' }];
    const do_ = new PrekeyDO(makeState(), makeEnv(pool));
    const res = await do_.fetch(consumeReq());
    const data = await res.json();
    expect(data).toEqual({ opk: { opkId: 'o1', opk: 'PUB1' }, reason: 'ok' });
    expect(pool.length).toBe(1);   // eine konsumiert
  });

  it('leerer Pool → opk:null (SPK-only-Fallback), kein Fehler', async () => {
    const do_ = new PrekeyDO(makeState(), makeEnv([]));
    const res = await do_.fetch(consumeReq());
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.opk).toBe(null);
    expect(data.reason).toBe('empty');
  });

  it('D1-Fehler → opk:null (reason error), kein 500', async () => {
    const env = { RENEX_DB: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('no such table'); } }) }) } };
    const do_ = new PrekeyDO(makeState(), env);
    const res = await do_.fetch(consumeReq());
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toEqual({ opk: null, reason: 'error' });
  });

  it('Einweg-Garantie: aufeinanderfolgende Consumes geben NIE dieselbe OPK', async () => {
    const pool = [{ opkId: 'o1', opk: 'P1' }, { opkId: 'o2', opk: 'P2' }, { opkId: 'o3', opk: 'P3' }];
    const state = makeState();
    const env = makeEnv(pool);
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const res = await new PrekeyDO(state, env).fetch(consumeReq({ l: 100 }));
      seen.push((await res.json()).opk.opkId);
    }
    expect(new Set(seen).size).toBe(3);        // alle verschieden
    expect(seen).toEqual(['o1', 'o2', 'o3']);
  });

  it('Per-Requester-Cap: über cap hinaus → opk:null (capped), Pool bleibt für andere', async () => {
    const pool = [{ opkId: 'o1', opk: 'P1' }, { opkId: 'o2', opk: 'P2' }, { opkId: 'o3', opk: 'P3' }];
    const state = makeState();
    const env = makeEnv(pool);
    // cap=2 für Requester "eve"
    const r1 = await (await new PrekeyDO(state, env).fetch(consumeReq({ l: 2, requester: 'eve' }))).json();
    const r2 = await (await new PrekeyDO(state, env).fetch(consumeReq({ l: 2, requester: 'eve' }))).json();
    const r3 = await (await new PrekeyDO(state, env).fetch(consumeReq({ l: 2, requester: 'eve' }))).json();
    expect(r1.reason).toBe('ok');
    expect(r2.reason).toBe('ok');
    expect(r3.reason).toBe('capped');
    expect(r3.opk).toBe(null);
    expect(pool.length).toBe(1);               // nur 2 konsumiert, 1 bleibt übrig
    // Anderer Requester ist NICHT gedrosselt.
    const other = await (await new PrekeyDO(state, env).fetch(consumeReq({ l: 2, requester: 'mallory' }))).json();
    expect(other.reason).toBe('ok');
    expect(other.opk.opkId).toBe('o3');
  });

  it('capped verbraucht keine OPK; leerer Pop verbraucht keinen Cap-Slot', async () => {
    // Pool mit 1 OPK, cap 3: erster Pop ok, danach Pool leer → reason empty,
    // Cap-Zähler bleibt bei 1 (empty spendet keinen Slot).
    const pool = [{ opkId: 'o1', opk: 'P1' }];
    const state = makeState();
    const env = makeEnv(pool);
    await new PrekeyDO(state, env).fetch(consumeReq({ l: 3, requester: 'alice' }));
    const capState = state._store.get('cap:alice');
    expect(capState.count).toBe(1);
    const empty = await (await new PrekeyDO(state, env).fetch(consumeReq({ l: 3, requester: 'alice' }))).json();
    expect(empty.reason).toBe('empty');
    expect(state._store.get('cap:alice').count).toBe(1);  // unverändert
  });

  it('bad params → 400', async () => {
    const do_ = new PrekeyDO(makeState(), makeEnv([]));
    const res = await do_.fetch(new Request('https://prekey/consume?w=3600000&l=3', {
      method: 'POST', body: JSON.stringify({ user: '', deviceId: 'x', requester: 'y' }),
    }));
    expect(res.status).toBe(400);
  });

  it('falscher Pfad → 404', async () => {
    const do_ = new PrekeyDO(makeState(), makeEnv([]));
    const res = await do_.fetch(new Request('https://prekey/nope', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(404);
  });

  it('Consume nutzt TOMBSTONE (UPDATE consumed_at), KEIN Hard-DELETE — Reuse-Resistenz', async () => {
    // Fängt die tatsächlich abgesetzte SQL ab: muss ein UPDATE mit
    // consumed_at-Guard sein (Grabstein), NICHT DELETE (sonst Resurrection möglich).
    let seenSql = '';
    const env = {
      RENEX_DB: {
        prepare: (sql) => { seenSql = sql; return { bind: () => ({ first: async () => ({ opkId: 'o1', opk: 'P1' }) }) }; },
      },
    };
    await new PrekeyDO(makeState(), env).fetch(consumeReq());
    expect(seenSql).toMatch(/UPDATE pqxdh_opk SET consumed_at/i);
    expect(seenSql).toMatch(/consumed_at IS NULL/i);
    expect(seenSql).not.toMatch(/DELETE/i);
  });
});
