// ======================================================
// Unit-Tests: chatSend v4-Transit (Double-Ratchet, P3.1)
// ======================================================
// Server-Invarianten: v4-DM (1) wird akzeptiert (v-Gate erlaubt 4),
// (2) header_b64 + init reisen im Push + landen in D1 (INSERT-binds),
// (3) fehlendes/zu großes header_b64 → 400, (4) v2 unverändert.
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

const CT = 'A'.repeat(64);
const IV = 'B'.repeat(20);
const HDR = 'aGVhZGVyYjY0';  // "headerb64" b64-ish, > 8 chars

function buildEnv() {
  const binds = [];
  return {
    _binds: binds,
    RENEX_DB: {
      prepare: (sql) => ({
        bind: (...args) => { binds.push({ sql, args }); return {
          run: async () => ({ success: true, meta: { changes: 1 } }),
          first: async () => null, all: async () => ({ results: [] }),
        }; },
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
const v4Body = (extra = {}) => ({
  to: 'bob', e2e: true, v: 4, ivB64: IV, ctB64: CT, sig: 'sig', deviceId: 'dev_alice_1',
  header_b64: HDR, ...extra,
});

beforeEach(() => { vi.clearAllMocks(); requireAnySession.mockResolvedValue({ handle: 'alice' }); });

describe('chatSend v4-Transit', () => {
  it('gültige v4-DM → 200, header_b64 im Push + in D1-INSERT', async () => {
    const env = buildEnv();
    const res = await handleChatSend(req(v4Body()), env);
    expect(res.status).toBe(200);
    const pushed = pushToUserDO.mock.calls.find(c => c[1] === 'bob')?.[2];
    expect(pushed.v).toBe(4);
    expect(pushed.header_b64).toBe(HDR);
    // D1: header_b64 im INSERT-bind (Message-INSERT hat die längste bind-Liste).
    const ins = env._binds.find(b => /INSERT OR IGNORE INTO messages/.test(b.sql));
    expect(ins.args).toContain(HDR);
  });

  it('v4 mit init → init im Push + als JSON in D1', async () => {
    const env = buildEnv();
    const init = { v: 3, alg: 'pqxdh-x25519-mlkem768', ikA25519: 'x' };
    await handleChatSend(req(v4Body({ init })), env);
    const pushed = pushToUserDO.mock.calls.find(c => c[1] === 'bob')?.[2];
    expect(pushed.init).toEqual(init);
    const ins = env._binds.find(b => /INSERT OR IGNORE INTO messages/.test(b.sql));
    expect(ins.args).toContain(JSON.stringify(init));
  });

  it('v4 ohne header_b64 → 400', async () => {
    const b = v4Body(); delete b.header_b64;
    const res = await handleChatSend(req(b), buildEnv());
    expect(res.status).toBe(400);
  });

  it('v4 mit zu großem header_b64 → 400', async () => {
    const res = await handleChatSend(req(v4Body({ header_b64: 'Z'.repeat(513) })), buildEnv());
    expect(res.status).toBe(400);
  });

  it('v4 mit zu großem init → 400', async () => {
    const res = await handleChatSend(req(v4Body({ init: { blob: 'Z'.repeat(5000) } })), buildEnv());
    expect(res.status).toBe(400);
  });

  it('v3 (unbekannte Version) → 400 Unsupported', async () => {
    const res = await handleChatSend(req({ ...v4Body(), v: 3 }), buildEnv());
    expect(res.status).toBe(400);
  });

  it('v4 mit convoId (Gruppe) → 400 (DM-only)', async () => {
    const res = await handleChatSend(req(v4Body({ convoId: 'grp-1' })), buildEnv());
    expect(res.status).toBe(400);
  });

  it('v4 mit Control-Type → 400 (DM-only)', async () => {
    const res = await handleChatSend(req(v4Body({ type: 'pulse' })), buildEnv());
    expect(res.status).toBe(400);
  });

  it('v4 ohne ivB64/ctB64 → 400 (unentschlüsselbar)', async () => {
    const b = v4Body(); delete b.ivB64;
    const res = await handleChatSend(req(b), buildEnv());
    expect(res.status).toBe(400);
  });

  it('v4-MULTI payloads[] → 200, per-Device header_b64/init durchgereicht + persistiert', async () => {
    const env = buildEnv();
    const payloads = [
      { deviceId: 'dev_bob_1', header_b64: HDR, ivB64: IV, ctB64: CT, sig: 's1', init: { v: 3, alg: 'pqxdh-x25519-mlkem768' } },
      { deviceId: 'dev_bob_2', header_b64: HDR, ivB64: IV, ctB64: CT, sig: 's2' },
    ];
    const body = { to: 'bob', e2e: true, v: 4, deviceId: 'dev_alice_1', payloads };   // kein top-level header/iv/ct
    const res = await handleChatSend(req(body), env);
    expect(res.status).toBe(200);
    const pushed = pushToUserDO.mock.calls.find(c => c[1] === 'bob')?.[2];
    expect(pushed.payloads.length).toBe(2);
    expect(pushed.payloads[0].header_b64).toBe(HDR);
    expect(pushed.payloads[0].init).toEqual({ v: 3, alg: 'pqxdh-x25519-mlkem768' });
    expect(pushed.payloads[1].header_b64).toBe(HDR);
    // D1: payloads-JSON enthält header_b64
    const ins = env._binds.find(b => /INSERT OR IGNORE INTO messages/.test(b.sql));
    expect(JSON.stringify(ins.args)).toContain(HDR);
  });

  it('v4-MULTI payload ohne header_b64 → 400 (kein stiller Device-Verlust)', async () => {
    const body = { to: 'bob', e2e: true, v: 4, deviceId: 'dev_alice_1', payloads: [{ deviceId: 'dev_bob_1', ivB64: IV, ctB64: CT }] };
    const res = await handleChatSend(req(body), buildEnv());
    expect(res.status).toBe(400);
  });

  it('v4-MULTI STRIKT: EIN malformtes Payload (kurzes ct) → 400 (all-or-nothing, kein stiller Skip)', async () => {
    const payloads = [
      { deviceId: 'dev_bob_1', header_b64: HDR, ivB64: IV, ctB64: CT },
      { deviceId: 'dev_bob_2', header_b64: HDR, ivB64: IV, ctB64: 'short' },   // ct < 16
    ];
    const res = await handleChatSend(req({ to: 'bob', e2e: true, v: 4, deviceId: 'd', payloads }), buildEnv());
    expect(res.status).toBe(400);
  });

  it('v4-MULTI STRIKT: alle Payloads malformt → leeres Ergebnis → 400 (nicht still gespeichert)', async () => {
    const payloads = [{ deviceId: 'dev_bob_1', header_b64: HDR, ivB64: 'x', ctB64: 'y' }];   // iv/ct zu kurz
    const res = await handleChatSend(req({ to: 'bob', e2e: true, v: 4, deviceId: 'd', payloads }), buildEnv());
    expect(res.status).toBe(400);
  });

  it('v4-MULTI mit convoId → 400 (DM-only gilt auch für multi)', async () => {
    const body = { to: 'bob', convoId: 'grp', e2e: true, v: 4, deviceId: 'd', payloads: [{ deviceId: 'dev_bob_1', header_b64: HDR, ivB64: IV, ctB64: CT }] };
    const res = await handleChatSend(req(body), buildEnv());
    expect(res.status).toBe(400);
  });

  it('v2-DM unverändert → 200, kein header_b64', async () => {
    const env = buildEnv();
    const res = await handleChatSend(req({ to: 'bob', e2e: true, v: 2, sid: 'alice:bob', epoch: 1, ivB64: IV, ctB64: CT, deviceId: 'dev_alice_1' }), env);
    expect(res.status).toBe(200);
    const pushed = pushToUserDO.mock.calls.find(c => c[1] === 'bob')?.[2];
    expect(pushed.header_b64).toBeUndefined();
    expect(pushed.v).toBe(2);
  });

  // ── P3.2-B: pq_kem_ct (per-Device ML-KEM-Rekey-CT) ──────────────────────
  const PQ_CT = 'C'.repeat(1452);   // exakte b64-Länge eines 1088B-ML-KEM-768-CT

  it('v4-MULTI mit gültigem pq_kem_ct → 200, im Push UND im persistierten payloads-JSON', async () => {
    const env = buildEnv();
    const payloads = [
      { deviceId: 'dev_bob_1', header_b64: HDR, ivB64: IV, ctB64: CT, sig: 's1', pq_kem_ct: PQ_CT },
      { deviceId: 'dev_bob_2', header_b64: HDR, ivB64: IV, ctB64: CT, sig: 's2' },   // ohne = ok (optional)
    ];
    const res = await handleChatSend(req({ to: 'bob', e2e: true, v: 4, deviceId: 'dev_alice_1', payloads }), env);
    expect(res.status).toBe(200);
    const pushed = pushToUserDO.mock.calls.find(c => c[1] === 'bob')?.[2];
    expect(pushed.payloads[0].pq_kem_ct).toBe(PQ_CT);
    expect(pushed.payloads[1].pq_kem_ct).toBeUndefined();
    const ins = env._binds.find(b => /INSERT OR IGNORE INTO messages/.test(b.sql));
    expect(JSON.stringify(ins.args)).toContain(PQ_CT);           // reist im payloads-JSON nach D1
  });

  it('v4-MULTI mit 1 Payload + pq_kem_ct → 200 (Rekey-Sends nutzen payloads[] auch bei 1 Ziel)', async () => {
    const env = buildEnv();
    const payloads = [{ deviceId: 'dev_bob_1', header_b64: HDR, ivB64: IV, ctB64: CT, pq_kem_ct: PQ_CT }];
    const res = await handleChatSend(req({ to: 'bob', e2e: true, v: 4, deviceId: 'dev_alice_1', payloads }), env);
    expect(res.status).toBe(200);
    const pushed = pushToUserDO.mock.calls.find(c => c[1] === 'bob')?.[2];
    expect(pushed.payloads.length).toBe(1);
    expect(pushed.payloads[0].pq_kem_ct).toBe(PQ_CT);
  });

  it('v4-MULTI STRIKT: malformtes pq_kem_ct (zu kurz/zu lang/kein String) → 400, nie still gestrippt', async () => {
    for (const bad of ['x'.repeat(100), 'x'.repeat(1700), 12345]) {
      const payloads = [{ deviceId: 'dev_bob_1', header_b64: HDR, ivB64: IV, ctB64: CT, pq_kem_ct: bad }];
      const res = await handleChatSend(req({ to: 'bob', e2e: true, v: 4, deviceId: 'd', payloads }), buildEnv());
      expect(res.status).toBe(400);
    }
  });

  it('v2-MULTI (CMK-Control-Pfad): pq_kem_ct wird gestrippt, kein 400 (v4-Kontrakt gilt nur für v4)', async () => {
    const env = buildEnv();
    const payloads = [{ deviceId: 'dev_bob_1', ivB64: IV, ctB64: CT, pq_kem_ct: PQ_CT }];
    const res = await handleChatSend(req({ to: 'bob', e2e: true, v: 2, type: 'cmk', sid: 'alice:bob', deviceId: 'dev_alice_1', payloads }), env);
    expect(res.status).toBe(200);
    const pushed = pushToUserDO.mock.calls.find(c => c[1] === 'bob')?.[2];
    expect(pushed.payloads[0].pq_kem_ct).toBeUndefined();
  });
});
