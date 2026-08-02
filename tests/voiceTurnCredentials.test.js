// ======================================================
// V1: TURN-Credentials enthalten KEINEN Klartext-Handle
// ======================================================
// Sichert ab, dass /voice/turn-credentials einen handle-freien Pseudonym im
// TURN-username verwendet (coturn loggt usernames → kein Identitäts-Leak am
// Relay / A2-Adversary) und ohne COTURN_SECRET auf STUN-only zurückfällt.
// ======================================================
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/auth.js', () => ({
  requireSession:    vi.fn(() => Promise.resolve({ handle: 'alice' })),
  isAcceptedContact: vi.fn(() => Promise.resolve(true)),
  pushToUserDO:      vi.fn(() => Promise.resolve(0)),
  rateLimit:         vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../src/helpers/pushSend.js', () => ({ pushToUser: vi.fn(() => Promise.resolve()) }));

import { handleVoiceRoutes } from '../src/routes/voiceRoutes.js';

function req() {
  return {
    method: 'GET',
    url: 'https://api.renex.id/voice/turn-credentials',
    headers: { get: (k) => (String(k).toLowerCase() === 'origin' ? 'https://app.renex.id' : null) },
  };
}
// Seit dem globalen Voice-Kill-Switch (2026-07-27) gaten die initiierenden
// /voice-Pfade auf KV `rollout:flags` {"voice":true}. Diese Tests pruefen die
// Credential-LOGIK, die nur bei aktivem Voice erreichbar ist → Flag im Mock-Env.
const voiceOn = (env = {}) => ({
  ...env,
  RENEX_KV: { get: (k) => Promise.resolve(k === 'rollout:flags' ? '{"voice":true}' : null) },
});
const run = (env) => handleVoiceRoutes(req(), voiceOn(env), '/voice/turn-credentials', new URLSearchParams());

describe('V1 — TURN credentials sind handle-frei', () => {
  it('username = "<expiry>:<pseudonym>" und enthält NICHT den Handle', async () => {
    const res = await run({ COTURN_SECRET: 'test-secret-xyz-123' });
    const body = await res.json();
    const turn = (body.iceServers || []).find(s => String(s.urls).startsWith('turn:'));
    expect(turn).toBeTruthy();
    expect(turn.username).toMatch(/^\d+:[A-Za-z0-9_-]+$/);
    expect(turn.username.includes('alice')).toBe(false);
    expect(typeof turn.credential).toBe('string');
    expect(turn.credential.length).toBeGreaterThan(0);
  });

  it('Pseudonym ist pro User stabil (deterministisch) → quota-bindbar', async () => {
    const env = { COTURN_SECRET: 'test-secret-xyz-123' };
    const a = await (await run(env)).json();
    const b = await (await run(env)).json();
    const uidA = a.iceServers.find(s => String(s.urls).startsWith('turn:')).username.split(':')[1];
    const uidB = b.iceServers.find(s => String(s.urls).startsWith('turn:')).username.split(':')[1];
    expect(uidA).toBe(uidB);
  });

  it('ohne COTURN_SECRET → STUN-only (keine username/credential)', async () => {
    const res = await run({});
    const body = await res.json();
    expect(body.iceServers.every(s => String(s.urls).startsWith('stun:'))).toBe(true);
    expect(body.iceServers.some(s => s.username || s.credential)).toBe(false);
  });
});
