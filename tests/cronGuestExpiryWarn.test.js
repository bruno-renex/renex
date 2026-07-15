// ======================================================
// Cron: Gast-Ablauf-Vorwarnung (eGov 1.2, Häppchen 3b)
//
// runGuestExpiryWarnings setzt System-Messages __guest_expiry_30d__ /
// __guest_expiry_7d__ für LANGLEBIGE Gast-Sessions:
// - disjunkte Fenster ((7d,30d] bzw. (0,7d]) → nie beide in einem Lauf
// - Gesamtdauer-Gate: 24h-Consumer-Sessions bekommen NIE eine Warnung
// - Idempotenz via KV-Marker (zweiter Lauf = 0 neue Messages)
// ======================================================
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/auth.js', () => ({
  pushToUserDO: vi.fn(() => Promise.resolve(0)),
}));
vi.mock('../src/helpers/pushSend.js', () => ({
  pushToUser: vi.fn(() => Promise.resolve()),
}));

import { runGuestExpiryWarnings } from '../src/cron.js';

const DAY = 86400_000;

// In-memory-Emulation der Sweep-Query (WHERE-Semantik wie in cron.js)
function buildEnv(sessions) {
  const inserts = [];
  const kv = new Map();
  const db = {
    prepare(sql) {
      return {
        bind: (...args) => ({
          all: () => {
            const [lowerBound, upperBound, minDuration] = args;
            const results = sessions.filter(s =>
              !s.converted_to && s.guest_handle && s.guest_handle !== '__used__' && s.convo_id &&
              s.expires_at > lowerBound && s.expires_at <= upperBound &&
              (s.expires_at - s.created_at) >= minDuration
            );
            return Promise.resolve({ results });
          },
          run: () => {
            if (/^\s*INSERT INTO messages/i.test(sql)) inserts.push(args);
            return Promise.resolve({ success: true, meta: { changes: 1 } });
          },
          first: () => Promise.resolve(null),
        }),
      };
    },
  };
  return {
    RENEX_DB: db,
    RENEX_KV: {
      get: (k) => Promise.resolve(kv.get(k) ?? null),
      put: (k, v, opts) => { kv.set(k, v); kv.set(k + ':__opts', opts); return Promise.resolve(); },
      delete: (k) => { kv.delete(k); return Promise.resolve(); },
    },
    _inserts: inserts,
    _kv: kv,
  };
}

const longSession = (remainingDays, token = 'guest_' + 't'.repeat(32)) => ({
  token, convo_id: 'praxis_muster:guest_ab12cd34', guest_handle: 'guest_ab12cd34',
  created_at: Date.now() - (90 - remainingDays) * DAY,
  expires_at: Date.now() + remainingDays * DAY,
  converted_to: null,
});

describe('runGuestExpiryWarnings', () => {
  it('90d-Session mit 20d Restlaufzeit → genau EINE 30d-Warnung + KV-Marker', async () => {
    const env = buildEnv([longSession(20)]);
    const warned = await runGuestExpiryWarnings(env);
    expect(warned).toBe(1);
    expect(env._inserts.length).toBe(1);
    expect(env._inserts[0][4]).toBe('__guest_expiry_30d__');   // message-Bind (5 Platzhalter: id, convo_id, from_user, ts, message)
    expect(env._inserts[0][1]).toBe('praxis_muster:guest_ab12cd34'); // convo_id
    expect(env._kv.has('guest_expiry_warned:30d:' + 'guest_' + 't'.repeat(32))).toBe(true);

    // Idempotenz: zweiter Lauf setzt nichts Neues
    const again = await runGuestExpiryWarnings(env);
    expect(again).toBe(0);
    expect(env._inserts.length).toBe(1);
  });

  it('3d Restlaufzeit → NUR die 7d-Warnung (Fenster disjunkt)', async () => {
    const env = buildEnv([longSession(3)]);
    const warned = await runGuestExpiryWarnings(env);
    expect(warned).toBe(1);
    expect(env._inserts.length).toBe(1);
    expect(env._inserts[0][4]).toBe('__guest_expiry_7d__');
  });

  it('24h-Consumer-Session (10h Rest) → KEINE Warnung (Gesamtdauer-Gate)', async () => {
    const env = buildEnv([{
      token: 'guest_' + 'c'.repeat(32), convo_id: 'demo27:guest_ffffffff',
      guest_handle: 'guest_ffffffff',
      created_at: Date.now() - 14 * 3600_000, expires_at: Date.now() + 10 * 3600_000,
      converted_to: null,
    }]);
    expect(await runGuestExpiryWarnings(env)).toBe(0);
    expect(env._inserts.length).toBe(0);
  });

  it('Template-Rows, konvertierte und abgelaufene Sessions → keine Warnung', async () => {
    const env = buildEnv([
      { ...longSession(20, 'guest_' + '1'.repeat(32)), guest_handle: '' },           // Template
      { ...longSession(20, 'guest_' + '2'.repeat(32)), guest_handle: '__used__' },   // konsumiert
      { ...longSession(20, 'guest_' + '3'.repeat(32)), converted_to: 'realuser' },   // konvertiert
      { ...longSession(-1, 'guest_' + '4'.repeat(32)) },                             // abgelaufen
    ]);
    expect(await runGuestExpiryWarnings(env)).toBe(0);
  });
});
