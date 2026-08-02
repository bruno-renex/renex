// ======================================================
// Globaler Voice-Kill-Switch (2026-07-27)
//
// Anlass: der self-hosted coturn-Relay (turn.renex.id) wird abgebaut. Ohne
// Relay scheitern Calls erst NACH dem Klingeln im ICE-Timeout — schlechter als
// gar kein Angebot. KV `rollout:flags` {"voice":true} schaltet Voice global,
// ohne Redeploy und ohne Code zu löschen.
//
// Garantien:
//  - Fail-safe AUS: Key fehlt / kaputtes JSON / KV-Fehler → 503 voice_disabled
//  - Initiierende Pfade (ring/answer/ice/turn-credentials) sind gegated —
//    auch für einen gecachten ALTEN Client, der den Button noch zeigt
//  - Teardown (hangup/decline/cancel) + history bleiben IMMER offen, damit
//    in-flight-Zustand abgeräumt werden kann
//  - voice:true → Pfade laufen wieder in die normale Logik
// ======================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/auth.js', () => ({
  requireSession: vi.fn(() => Promise.resolve({ handle: 'alice', isGuest: false })),
  requireAnySession: vi.fn(() => Promise.resolve({ handle: 'alice', isGuest: false })),
  rateLimit: vi.fn(() => Promise.resolve(true)),
  pushToUserDO: vi.fn(() => Promise.resolve(0)),
  isAcceptedContact: vi.fn(() => Promise.resolve(true)),
  getUserTier: vi.fn(() => Promise.resolve('free')),
}));
vi.mock('../src/helpers/pushSend.js', () => ({ pushToUser: vi.fn(() => Promise.resolve()) }));

import { handleVoiceRoutes } from '../src/routes/voiceRoutes.js';

// flagsRaw: der rohe KV-Wert von `rollout:flags` (null = Key fehlt)
function buildEnv(flagsRaw, { kvThrows = false } = {}) {
  return {
    RENEX_KV: {
      get: vi.fn((k) => {
        if (kvThrows) return Promise.reject(new Error('KV down'));
        return Promise.resolve(k === 'rollout:flags' ? flagsRaw : null);
      }),
      put: vi.fn(() => Promise.resolve()),
      delete: vi.fn(() => Promise.resolve()),
    },
    RENEX_DB: { prepare: () => ({ bind: () => ({ first: () => Promise.resolve(null), run: () => Promise.resolve({ meta: {} }), all: () => Promise.resolve({ results: [] }) }) }) },
  };
}

function req(path) {
  return {
    method: 'POST',
    url: `https://api.renex.id${path}`,
    headers: { get: (k) => {
      const key = String(k).toLowerCase();
      if (key === 'origin') return 'https://app.renex.id';
      if (key === 'content-type') return 'application/json';
      return null;
    } },
    json: () => Promise.resolve({ to: 'bob' }),
  };
}
const call = (env, path) => handleVoiceRoutes(req(path), env, path, new URLSearchParams(), {});

const INITIATING = ['/voice/ring', '/voice/answer', '/voice/ice', '/voice/turn-credentials'];
const TEARDOWN = ['/voice/hangup', '/voice/decline', '/voice/cancel'];

describe('Voice-Kill-Switch — AUS (fail-safe)', () => {
  it('Key fehlt → alle initiierenden Pfade 503 voice_disabled', async () => {
    for (const p of INITIATING) {
      const res = await call(buildEnv(null), p);
      expect(res.status, p).toBe(503);
      expect((await res.json()).code, p).toBe('voice_disabled');
    }
  });

  it('voice:false explizit → ebenfalls 503', async () => {
    const res = await call(buildEnv('{"ratchetSend":true,"pqRekey":false,"voice":false}'), '/voice/ring');
    expect(res.status).toBe(503);
  });

  it('kaputtes JSON → 503 (kein Durchrutschen)', async () => {
    const res = await call(buildEnv('{kaputt'), '/voice/ring');
    expect(res.status).toBe(503);
  });

  it('KV-Fehler → 503 (fail-safe, nicht fail-open)', async () => {
    const res = await call(buildEnv(null, { kvThrows: true }), '/voice/turn-credentials');
    expect(res.status).toBe(503);
  });

  it('Teardown-Pfade bleiben offen (kein 503) — in-flight aufräumbar', async () => {
    for (const p of TEARDOWN) {
      const res = await call(buildEnv(null), p);
      expect(res.status, p).not.toBe(503);
    }
  });

  it('/voice/history bleibt offen (reines Lesen der Anrufliste)', async () => {
    const res = await call(buildEnv(null), '/voice/history');
    expect(res.status).not.toBe(503);
  });
});

describe('Voice-Kill-Switch — AN', () => {
  it('voice:true → initiierende Pfade laufen in die normale Logik (kein 503)', async () => {
    const env = buildEnv('{"ratchetSend":true,"pqRekey":false,"voice":true}');
    for (const p of INITIATING) {
      const res = await call(env, p);
      expect(res.status, p).not.toBe(503);
    }
  });
});
