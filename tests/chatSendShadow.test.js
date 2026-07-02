// ======================================================
// Unit-Tests: chatSend shadowV4-Transit (P3.0 Dark-Launch, §4.4)
// ======================================================
// Server-Invarianten: shadowV4 (1) reist sanitized im Live-Push mit,
// (2) landet NIE in D1 (INSERT bindet explizite Spalten), (3) wird bei
// Control-Type/Gruppe/malformed/zu groß still gedroppt (nie rejecten).
// ======================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/auth.js', () => ({
  requireAnySession: vi.fn(),
  rateLimit: vi.fn(() => Promise.resolve(true)),
  isAcceptedContact: vi.fn(() => Promise.resolve(true)),
  pushToUserDO: vi.fn(() => Promise.resolve(1)),
  pushToGroupMembers: vi.fn(() => Promise.resolve(0)),
  getConvoMemberHandles: vi.fn(() => Promise.resolve([])),
  isConvoMember: vi.fn(() => Promise.resolve(true)),
  GUEST_HANDLE_RE: /^guest_[a-z0-9]+$/,
}));

import { handleChatSend } from '../src/helpers/chatSend.js';
import { requireAnySession, pushToUserDO } from '../src/auth.js';

const CT = 'A'.repeat(64);   // > Mindestlänge 16
const IV = 'B'.repeat(24);

function buildEnv() {
  const binds = [];
  return {
    _binds: binds,
    RENEX_DB: {
      prepare: (sql) => ({
        bind: (...args) => {
          binds.push({ sql, args });
          return {
            run: async () => ({ success: true, meta: { changes: 1 } }),
            first: async () => null,
            all: async () => ({ results: [] }),
          };
        },
      }),
      batch: async () => [],
    },
    RENEX_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
  };
}
function req(body) {
  return {
    method: 'POST', url: 'https://api.renex.id/chat/send',
    headers: { get: (k) => {
      const key = String(k || '').toLowerCase();
      if (key === 'origin') return 'https://app.renex.id';
      if (key === 'content-type') return 'application/json';
      return null;
    } },
    json: async () => body,
  };
}
const dmBody = (extra = {}) => ({
  to: 'bob', e2e: true, v: 2, sid: 'alice:bob', epoch: 1,
  ivB64: IV, ctB64: CT, deviceId: 'dev_alice_123', ...extra,
});
const validShadow = () => ({ v: 4, tgt: 'dev_bob_1', header: 'aGVhZGVy', fp: 'ZnBmcA==' });

beforeEach(() => {
  vi.clearAllMocks();
  requireAnySession.mockResolvedValue({ handle: 'alice' });
});

describe('chatSend shadowV4-Transit', () => {
  it('gültiges shadowV4 → sanitized im Push, NICHT in D1-binds', async () => {
    const env = buildEnv();
    const res = await handleChatSend(req(dmBody({ shadowV4: { ...validShadow(), evil: 'x' } })), env);
    expect(res.status).toBe(200);
    const pushed = pushToUserDO.mock.calls.find(c => c[1] === 'bob')?.[2];
    expect(pushed.shadowV4).toEqual(validShadow());          // sanitized: evil-Feld weg
    // D1: kein bind-Argument trägt Shadow-Material
    const flat = JSON.stringify(env._binds.map(b => b.args));
    expect(flat).not.toContain('dev_bob_1');
    expect(flat).not.toContain('aGVhZGVy');
  });

  it('mit init (Objekt) → bleibt dran', async () => {
    const env = buildEnv();
    await handleChatSend(req(dmBody({ shadowV4: { ...validShadow(), init: { v: 3, alg: 'pqxdh-x25519-mlkem768' } } })), env);
    const pushed = pushToUserDO.mock.calls.find(c => c[1] === 'bob')?.[2];
    expect(pushed.shadowV4.init).toEqual({ v: 3, alg: 'pqxdh-x25519-mlkem768' });
  });

  it('Control-Type (pulse) → shadowV4 gedroppt, Send ok', async () => {
    const env = buildEnv();
    const res = await handleChatSend(req(dmBody({ type: 'pulse', shadowV4: validShadow() })), env);
    expect(res.status).toBe(200);
    for (const call of pushToUserDO.mock.calls) expect(call[2].shadowV4).toBeUndefined();
  });

  it('malformed (v:3 / fehlendes fp) → gedroppt, Send ok (nie rejecten)', async () => {
    const env = buildEnv();
    const res = await handleChatSend(req(dmBody({ shadowV4: { v: 3, tgt: 'dev_bob_1', header: 'x', fp: 'y' } })), env);
    expect(res.status).toBe(200);
    const res2 = await handleChatSend(req(dmBody({ shadowV4: { v: 4, tgt: 'dev_bob_1', header: 'x' } })), env);
    expect(res2.status).toBe(200);
    for (const call of pushToUserDO.mock.calls) expect(call[2].shadowV4).toBeUndefined();
  });

  it('zu groß (>4096 JSON) → gedroppt, Send ok', async () => {
    const env = buildEnv();
    const res = await handleChatSend(req(dmBody({
      shadowV4: { ...validShadow(), init: { blob: 'Z'.repeat(5000) } },
    })), env);
    expect(res.status).toBe(200);
    for (const call of pushToUserDO.mock.calls) expect(call[2].shadowV4).toBeUndefined();
  });

  it('ohne shadowV4 → Verhalten exakt wie bisher', async () => {
    const env = buildEnv();
    const res = await handleChatSend(req(dmBody()), env);
    expect(res.status).toBe(200);
    const pushed = pushToUserDO.mock.calls.find(c => c[1] === 'bob')?.[2];
    expect(pushed.shadowV4).toBeUndefined();
    expect(pushed.ctB64).toBe(CT);
  });
});
