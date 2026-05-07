// ======================================================
// Unit-Tests: Auto-Revoke Cron-Sweep
// ======================================================
// Spec: docs/MULTI_DEVICE.md §3.2 — Hybrid Revoke
//
// Garantien:
//   - Devices mit state='active' UND last_seen_at < (now - 30d) werden auf
//     'revoked' gesetzt (revoked_by='auto').
//   - KV inbox + sigpub für das geleakte Device werden gelöscht.
//   - KV-Index wird aus D1 neu abgeleitet (verbleibende active/syncing).
//   - Self-Push 'device_removed' (reason='auto') wird abgesetzt.
//   - KEINE Authority-Pushes an Kontakte (keine CMK-Rotation bei auto).
//   - Recently-active Devices bleiben unangetastet.
//   - Bereits revoked Devices werden nicht erneut bearbeitet.
// ======================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock pushToUserDO BEFORE import
vi.mock('../src/auth.js', () => ({
  pushToUserDO: vi.fn(() => Promise.resolve(0)),
}));

import { runAutoRevokeStaleDevices } from '../src/cron.js';
import * as auth from '../src/auth.js';

// ── Mock-Layer ─────────────────────────────────────────

/** Baut einen Mock-`env` mit in-memory D1 + KV. */
function buildEnv(seed = {}) {
  const devices = [...(seed.devices || [])];     // [{ device_id, user_handle, state, last_seen_at, ... }]
  const kv      = new Map(seed.kv || []);

  const db = {
    prepare(sql) {
      return {
        bind: (...args) => ({
          run: () => {
            // UPDATE devices SET state = 'revoked', revoked_at = ?, revoked_by = 'auto' WHERE device_id = ?
            const m = sql.match(/UPDATE\s+devices\s+SET\s+state\s*=\s*'revoked'/i);
            if (m) {
              const [revokedAt, deviceId] = args;
              const dev = devices.find(d => d.device_id === deviceId);
              if (dev) {
                dev.state = 'revoked';
                dev.revoked_at = revokedAt;
                dev.revoked_by = 'auto';
                return Promise.resolve({ meta: { changes: 1 } });
              }
              return Promise.resolve({ meta: { changes: 0 } });
            }
            return Promise.resolve({ meta: { changes: 0 } });
          },
          first: () => Promise.resolve(null),
          all: () => {
            // SELECT device_id, user_handle FROM devices WHERE state = 'active' AND last_seen_at < ?
            const mStale = sql.match(/SELECT\s+device_id,\s*user_handle\s+FROM\s+devices\s+WHERE\s+state\s*=\s*'active'\s+AND\s+last_seen_at\s*<\s*\?/i);
            if (mStale) {
              const [cutoff] = args;
              const results = devices
                .filter(d => d.state === 'active' && d.last_seen_at < cutoff)
                .map(d => ({ device_id: d.device_id, user_handle: d.user_handle }));
              return Promise.resolve({ results });
            }
            // SELECT device_id FROM devices WHERE user_handle = ? AND state IN ('active','syncing') ORDER BY created_at
            const mIdx = sql.match(/SELECT\s+device_id\s+FROM\s+devices\s+WHERE\s+user_handle\s*=\s*\?\s+AND\s+state\s+IN\s*\(\s*'active'\s*,\s*'syncing'\s*\)/i);
            if (mIdx) {
              const [userHandle] = args;
              const results = devices
                .filter(d => d.user_handle === userHandle && (d.state === 'active' || d.state === 'syncing'))
                .sort((a, b) => (a.created_at || 0) - (b.created_at || 0))
                .map(d => ({ device_id: d.device_id }));
              return Promise.resolve({ results });
            }
            return Promise.resolve({ results: [] });
          },
        }),
      };
    },
  };

  const kvMock = {
    get:    vi.fn((key) => Promise.resolve(kv.get(key) ?? null)),
    put:    vi.fn((key, val) => { kv.set(key, val); return Promise.resolve(); }),
    delete: vi.fn((key) => { kv.delete(key); return Promise.resolve(); }),
  };

  return {
    RENEX_DB: db,
    RENEX_KV: kvMock,
    _devices: devices,
    _kv:      kv,
    _kvSpy:   kvMock,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.pushToUserDO.mockResolvedValue(0);
});

const NOW         = Date.now();
const DAYS_AGO    = (n) => NOW - n * 86400_000;
const THIRTY_DAYS = 30 * 86400_000;

// ────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────

describe('Auto-Revoke: Stale-Detection', () => {
  it('Stale active Device (>30d inaktiv) → revoked + KV-Cleanup + Push', async () => {
    const env = buildEnv({
      devices: [{
        device_id:    'dev_anna_phone',
        user_handle:  'anna',
        state:        'active',
        last_seen_at: DAYS_AGO(31),
        created_at:   DAYS_AGO(60),
      }],
      kv: [
        ['e2e:inbox:anna:dev_anna_phone', 'pubkey-data'],
        ['e2e:inbox:sigpub:anna:dev_anna_phone', 'sigpub-data'],
        ['e2e:inbox:index:anna', JSON.stringify(['dev_anna_phone'])],
      ],
    });

    const result = await runAutoRevokeStaleDevices(env);

    expect(result.revoked).toBe(1);
    expect(result.errors).toBe(0);

    // D1: state='revoked', revoked_by='auto'
    const dev = env._devices[0];
    expect(dev.state).toBe('revoked');
    expect(dev.revoked_by).toBe('auto');

    // KV: inbox + sigpub gelöscht
    expect(env._kv.has('e2e:inbox:anna:dev_anna_phone')).toBe(false);
    expect(env._kv.has('e2e:inbox:sigpub:anna:dev_anna_phone')).toBe(false);

    // KV-Index: leer (keine aktiven Devices mehr)
    expect(JSON.parse(env._kv.get('e2e:inbox:index:anna'))).toEqual([]);

    // Self-Push gefeuert mit reason='auto'
    expect(auth.pushToUserDO).toHaveBeenCalledTimes(1);
    const [, handle, evt] = auth.pushToUserDO.mock.calls[0];
    expect(handle).toBe('anna');
    expect(evt).toMatchObject({
      type: 'device_removed',
      from: 'anna',
      to:   'anna',
      deviceId: 'dev_anna_phone',
      reason: 'auto',
    });
  });

  it('Recently-active Device (<30d) bleibt unangetastet', async () => {
    const env = buildEnv({
      devices: [{
        device_id:    'dev_anna_phone',
        user_handle:  'anna',
        state:        'active',
        last_seen_at: DAYS_AGO(15),
        created_at:   DAYS_AGO(60),
      }],
    });

    const result = await runAutoRevokeStaleDevices(env);

    expect(result.revoked).toBe(0);
    expect(env._devices[0].state).toBe('active');
    expect(auth.pushToUserDO).not.toHaveBeenCalled();
  });

  it('Bereits revoked Device wird nicht erneut bearbeitet', async () => {
    const env = buildEnv({
      devices: [{
        device_id:    'dev_anna_old',
        user_handle:  'anna',
        state:        'revoked',
        last_seen_at: DAYS_AGO(60),
        revoked_at:   DAYS_AGO(45),
        revoked_by:   'user',
      }],
    });

    const result = await runAutoRevokeStaleDevices(env);

    expect(result.revoked).toBe(0);
    // revoked_by bleibt 'user' (nicht auf 'auto' überschrieben)
    expect(env._devices[0].revoked_by).toBe('user');
    expect(auth.pushToUserDO).not.toHaveBeenCalled();
  });

  it('Syncing Device wird nicht via Auto-Revoke berührt (Stuck-Cleanup ist separat)', async () => {
    const env = buildEnv({
      devices: [{
        device_id:    'dev_anna_new',
        user_handle:  'anna',
        state:        'syncing',
        last_seen_at: DAYS_AGO(40),
        created_at:   DAYS_AGO(40),
      }],
    });

    const result = await runAutoRevokeStaleDevices(env);
    expect(result.revoked).toBe(0);
    expect(env._devices[0].state).toBe('syncing');
  });
});

describe('Auto-Revoke: KV-Index-Konsistenz', () => {
  it('Mehrere Devices, ein staler — Index enthält nur die aktiven', async () => {
    const env = buildEnv({
      devices: [
        { device_id: 'dev_anna_phone',  user_handle: 'anna', state: 'active', last_seen_at: DAYS_AGO(40), created_at: DAYS_AGO(60) },
        { device_id: 'dev_anna_laptop', user_handle: 'anna', state: 'active', last_seen_at: DAYS_AGO(2),  created_at: DAYS_AGO(30) },
        { device_id: 'dev_anna_tablet', user_handle: 'anna', state: 'active', last_seen_at: DAYS_AGO(5),  created_at: DAYS_AGO(50) },
      ],
      kv: [
        ['e2e:inbox:anna:dev_anna_phone', 'old-key'],
        ['e2e:inbox:index:anna', JSON.stringify(['dev_anna_phone', 'dev_anna_laptop', 'dev_anna_tablet'])],
      ],
    });

    const result = await runAutoRevokeStaleDevices(env);

    expect(result.revoked).toBe(1);
    const idx = JSON.parse(env._kv.get('e2e:inbox:index:anna'));
    expect(idx).toEqual(['dev_anna_tablet', 'dev_anna_laptop']);  // sortiert by created_at
    expect(idx).not.toContain('dev_anna_phone');
  });

  it('Mehrere Stale Devices verschiedener User → alle revoked, je User Index korrekt', async () => {
    const env = buildEnv({
      devices: [
        { device_id: 'dev_anna_old',   user_handle: 'anna',   state: 'active', last_seen_at: DAYS_AGO(35), created_at: DAYS_AGO(50) },
        { device_id: 'dev_anna_now',   user_handle: 'anna',   state: 'active', last_seen_at: DAYS_AGO(2),  created_at: DAYS_AGO(20) },
        { device_id: 'dev_bertha_old', user_handle: 'bertha', state: 'active', last_seen_at: DAYS_AGO(40), created_at: DAYS_AGO(50) },
      ],
    });

    const result = await runAutoRevokeStaleDevices(env);

    expect(result.revoked).toBe(2);

    // anna's Index: nur dev_anna_now
    const annaIdx = JSON.parse(env._kv.get('e2e:inbox:index:anna'));
    expect(annaIdx).toEqual(['dev_anna_now']);

    // bertha's Index: leer (war ihr einziges Device)
    const berthaIdx = JSON.parse(env._kv.get('e2e:inbox:index:bertha'));
    expect(berthaIdx).toEqual([]);

    // Zwei Self-Pushes
    expect(auth.pushToUserDO).toHaveBeenCalledTimes(2);
  });
});

describe('Auto-Revoke: Reason-Constraint', () => {
  it('Push enthält reason="auto" — KEINE CMK-Rotation getriggert', async () => {
    const env = buildEnv({
      devices: [{
        device_id:    'dev_anna_phone',
        user_handle:  'anna',
        state:        'active',
        last_seen_at: DAYS_AGO(31),
        created_at:   DAYS_AGO(60),
      }],
    });

    await runAutoRevokeStaleDevices(env);

    const pushedEvents = auth.pushToUserDO.mock.calls.map(c => c[2]);
    for (const evt of pushedEvents) {
      expect(evt.reason).toBe('auto');
    }
  });

  it('Nur self-push (an own user-handle), KEINE Push-Calls an andere Handles', async () => {
    const env = buildEnv({
      devices: [{
        device_id:    'dev_anna_phone',
        user_handle:  'anna',
        state:        'active',
        last_seen_at: DAYS_AGO(31),
      }],
    });

    await runAutoRevokeStaleDevices(env);

    const pushedHandles = auth.pushToUserDO.mock.calls.map(c => c[1]);
    expect(pushedHandles).toEqual(['anna']);  // nicht zu peers
  });
});

describe('Auto-Revoke: Konfigurierbare Inactivity', () => {
  it('opts.inactivityMs steuert die Schwelle (Test-Override)', async () => {
    const env = buildEnv({
      devices: [{
        device_id:    'dev_anna_phone',
        user_handle:  'anna',
        state:        'active',
        last_seen_at: DAYS_AGO(10),  // 10 Tage alt
      }],
    });

    // Cutoff = 5 Tage — Device ist 10 Tage alt → stale
    const result = await runAutoRevokeStaleDevices(env, { inactivityMs: 5 * 86400_000 });
    expect(result.revoked).toBe(1);
  });

  it('Default-Schwelle 30d: 29-Tage-Device bleibt aktiv', async () => {
    const env = buildEnv({
      devices: [{
        device_id:    'dev_anna_phone',
        user_handle:  'anna',
        state:        'active',
        last_seen_at: DAYS_AGO(29),
      }],
    });

    const result = await runAutoRevokeStaleDevices(env);
    expect(result.revoked).toBe(0);
    expect(env._devices[0].state).toBe('active');
  });
});

describe('Auto-Revoke: Resilience', () => {
  it('DB-Fehler bei einem Device → andere Devices werden weiter bearbeitet', async () => {
    const env = buildEnv({
      devices: [
        { device_id: 'dev_a', user_handle: 'anna', state: 'active', last_seen_at: DAYS_AGO(40) },
        { device_id: 'dev_b', user_handle: 'anna', state: 'active', last_seen_at: DAYS_AGO(40) },
      ],
    });

    // 1. Aufruf wirft, 2. Aufruf normal
    let updateCallCount = 0;
    const origPrepare = env.RENEX_DB.prepare;
    env.RENEX_DB.prepare = (sql) => {
      const stmt = origPrepare(sql);
      const origBind = stmt.bind;
      stmt.bind = (...args) => {
        const inner = origBind(...args);
        if (/UPDATE\s+devices/i.test(sql)) {
          const origRun = inner.run;
          inner.run = () => {
            updateCallCount++;
            if (updateCallCount === 1) {
              return Promise.reject(new Error('simulated D1 failure'));
            }
            return origRun();
          };
        }
        return inner;
      };
      return stmt;
    };

    const result = await runAutoRevokeStaleDevices(env);
    expect(result.revoked).toBe(1);    // dev_b revoked
    expect(result.errors).toBe(1);     // dev_a fehlgeschlagen
  });

  it('Leere Stale-Liste → keine Errors, kein Push', async () => {
    const env = buildEnv({ devices: [] });
    const result = await runAutoRevokeStaleDevices(env);
    expect(result.revoked).toBe(0);
    expect(result.errors).toBe(0);
    expect(auth.pushToUserDO).not.toHaveBeenCalled();
  });
});
