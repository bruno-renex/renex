// ======================================================
// Smoke-Test: /chat/send Control-Type Handling
// ======================================================
// Spec: docs/MULTI_DEVICE.md §4 (CMK), §7 (GSK)
//
// Verifizierte Garantien pro Control-Type:
//   1. Backend-Whitelist akzeptiert den Type (kein 400 wegen "unknown")
//   2. Kein D1-Insert in `messages` für reine Signalling-Types
//      (Ausnahme: gsk + request_gsk werden gespeichert für Gast-Polling)
//   3. Kein DM-Self-Push für Control-Types
//   4. Korrekter Rate-Limit-Bucket
//
// Plus negative Tests:
//   - Type > MAX_TYPE_LEN → 400 vor jedem Insert
//   - Unbekannter Kurz-Type → wird wie Chat-Message behandelt (heutiges Verhalten)
//
// Hintergrund: Wenn ein neuer Control-Type eingeführt wird, muss er an mind. 6
// Stellen in chatSend.js gewhitelistet werden (Rate-Limit, E2E-Check, Insert-
// Skip, Self-Push-Skip, Unread-Skip, Web-Push-Skip). Vergessen einer Stelle
// → Daten-Korruption (z.B. Control-Message landet in /chat/list als 🔒-Bubble).
// ======================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock-Layer ─────────────────────────────────────────
// Ersetzt auth.js + pushSend.js mit Spies, damit Tests isoliert laufen.

vi.mock('../src/auth.js', () => ({
  requireAnySession: vi.fn(),
  rateLimit:         vi.fn(() => Promise.resolve(true)),
  isAcceptedContact: vi.fn(() => Promise.resolve(true)),
  pushToUserDO:      vi.fn(() => Promise.resolve(0)),
  pushToGroupMembers: vi.fn(() => Promise.resolve()),
  GUEST_HANDLE_RE:   /^guest_[a-z0-9]+$/,
}));

vi.mock('../src/helpers/pushSend.js', () => ({
  pushToUser:     vi.fn(() => Promise.resolve()),
  detectMentions: vi.fn(() => ({ mentionsAll: false, mentionedHandles: [] })),
}));

import { handleChatSend } from '../src/helpers/chatSend.js';
import * as auth from '../src/auth.js';

// ── Mock-Helpers ───────────────────────────────────────

/** Baut einen Mock-`env` mit DB/KV-Spies. */
function buildEnv() {
  const dbInserts = []; // gesammelte INSERT-Statements für Assertions
  const dbReads   = [];

  const prepare = (sql) => ({
    bind: (...args) => {
      const stmt = { sql, args };
      return {
        run: () => {
          if (/^\s*INSERT/i.test(sql)) dbInserts.push(stmt);
          return Promise.resolve({ success: true, meta: {} });
        },
        first: () => {
          dbReads.push(stmt);
          // SELECT 1 FROM conversation_members → simuliert "ist Mitglied"
          if (/conversation_members/i.test(sql)) return Promise.resolve({ '1': 1 });
          return Promise.resolve(null);
        },
        all: () => {
          dbReads.push(stmt);
          return Promise.resolve({ results: [] });
        },
      };
    },
  });

  return {
    RENEX_DB: { prepare },
    RENEX_KV: {
      get:    vi.fn(() => Promise.resolve(null)),
      put:    vi.fn(() => Promise.resolve()),
      delete: vi.fn(() => Promise.resolve()),
    },
    USER_SESSION_DO: {
      idFromName: () => ({}),
      get: () => ({ fetch: vi.fn(() => Promise.resolve(new Response('{}'))) }),
    },
    _dbInserts: dbInserts,
    _dbReads:   dbReads,
  };
}

/** Baut einen Mock-Request mit JSON-Body. */
function buildRequest(body) {
  return {
    method: 'POST',
    url:    'https://api.renex.id/chat/send',
    headers: {
      get: (k) => {
        const key = String(k || '').toLowerCase();
        if (key === 'origin')        return 'https://app.renex.id';
        if (key === 'content-type')  return 'application/json';
        return null;
      },
    },
    json: () => Promise.resolve(body),
  };
}

/** Standard-Session: anna, nicht-Gast. */
function setSession(handle = 'anna') {
  auth.requireAnySession.mockResolvedValue({
    handle,
    isGuest: false,
    token:   'mock-token',
  });
}

/** Reset aller Spies + neuer env vor jedem Test. */
let env;
beforeEach(() => {
  vi.clearAllMocks();
  auth.rateLimit.mockResolvedValue(true);
  auth.isAcceptedContact.mockResolvedValue(true);
  auth.pushToUserDO.mockResolvedValue(0);
  auth.pushToGroupMembers.mockResolvedValue();
  setSession('anna');
  env = buildEnv();
});

// ────────────────────────────────────────────────────────
// Liste der Control-Types die im Backend gewhitelistet sind.
// Quelle der Wahrheit: chatSend.js (Stand 2026-05).
// ────────────────────────────────────────────────────────

// Reine Signalling-Types: KEIN D1-Insert, KEIN DM-Self-Push, KEIN Web-Push.
// Werden via WS direkt an Empfänger gepusht.
const SIGNALLING_DM = ['cmk', 'cmk_req', 'cmk_unavailable', 'epoch_rotate', 'cmk_rotate', 'cmk_reset'];

// Auto-Delete: Control für Gruppen, kein Insert.
const SIGNALLING_GROUP = ['auto_delete_set'];

// GSK-Types: WERDEN inserted (für Gast-Polling-Fallback) aber sind Control-flagged.
const GSK_TYPES = ['gsk', 'request_gsk'];

// Alle bekannten Control-Types
const ALL_CONTROL = [...SIGNALLING_DM, ...SIGNALLING_GROUP, ...GSK_TYPES];

// ────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────

describe('Control-Type Whitelist Acceptance', () => {
  for (const type of SIGNALLING_DM) {
    it(`akzeptiert "${type}" als bekannten Type (kein 400)`, async () => {
      const req = buildRequest({
        to: 'bertha',
        type,
        deviceId: 'dev_anna_1',
        // CMK-Types: Backend setzt v=2/e2e=true selbst, hier nur Minimum
      });
      const res = await handleChatSend(req, env);
      const body = await res.json();
      expect(res.status).not.toBe(400);
      // Wenn ein Error-Feld zurückkommt, darf es kein Whitelist-Reject sein
      if (body.error) {
        expect(body.error).not.toMatch(/Unsupported|Invalid type/i);
      }
    });
  }

  for (const type of GSK_TYPES) {
    it(`akzeptiert "${type}" mit gültigem groupId-Kontext`, async () => {
      const groupId = '11111111-2222-3333-4444-555555555555';
      const req = buildRequest({
        to: 'bertha',
        convoId: groupId,
        type,
        deviceId: 'dev_anna_1',
        ...(type === 'request_gsk' ? { requestedFrom: 'bertha' } : {}),
        ...(type === 'gsk' ? {
          payloads: [{ deviceId: 'dev_b1', ivB64: 'AAAAAAAAAAAAAAAA', ctB64: 'BBBBBBBBBBBBBBBB' }],
        } : {}),
      });
      const res = await handleChatSend(req, env);
      const body = await res.json();
      expect(res.status).not.toBe(400);
      if (body.error) {
        expect(body.error).not.toMatch(/Unsupported|require a valid group/i);
      }
    });
  }
});

describe('D1-Insert-Behavior', () => {
  for (const type of SIGNALLING_DM) {
    it(`"${type}" triggert KEIN INSERT in messages`, async () => {
      const req = buildRequest({
        to: 'bertha',
        type,
        deviceId: 'dev_anna_1',
      });
      await handleChatSend(req, env);
      const messageInserts = env._dbInserts.filter(s => /INSERT.+INTO messages/i.test(s.sql));
      expect(messageInserts.length).toBe(0);
    });
  }

  it('"auto_delete_set" triggert KEIN INSERT in messages', async () => {
    const groupId = '11111111-2222-3333-4444-555555555555';
    const req = buildRequest({
      to:      'bertha',
      convoId: groupId,
      type:    'auto_delete_set',
      deviceId: 'dev_anna_1',
    });
    await handleChatSend(req, env);
    const messageInserts = env._dbInserts.filter(s => /INSERT.+INTO messages/i.test(s.sql));
    expect(messageInserts.length).toBe(0);
  });

  for (const type of GSK_TYPES) {
    it(`"${type}" WIRD inserted (für Gast-Polling-Fallback)`, async () => {
      const groupId = '11111111-2222-3333-4444-555555555555';
      const req = buildRequest({
        to:      'bertha',
        convoId: groupId,
        type,
        deviceId: 'dev_anna_1',
        ...(type === 'request_gsk' ? { requestedFrom: 'bertha' } : {}),
        ...(type === 'gsk' ? {
          payloads: [{ deviceId: 'dev_b1', ivB64: 'AAAAAAAAAAAAAAAA', ctB64: 'BBBBBBBBBBBBBBBB' }],
        } : {}),
      });
      await handleChatSend(req, env);
      const messageInserts = env._dbInserts.filter(s => /INSERT.+INTO messages/i.test(s.sql));
      expect(messageInserts.length).toBe(1);
    });
  }

  it('Chat-Message OHNE Type WIRD inserted (Regular Message)', async () => {
    const req = buildRequest({
      to: 'bertha',
      message: 'hello',
      deviceId: 'dev_anna_1',
    });
    await handleChatSend(req, env);
    const messageInserts = env._dbInserts.filter(s => /INSERT.+INTO messages/i.test(s.sql));
    expect(messageInserts.length).toBe(1);
  });
});

describe('Self-Push-Behavior (DM)', () => {
  for (const type of SIGNALLING_DM) {
    it(`"${type}" triggert KEINEN DM-Self-Push (nur Empfänger-Push)`, async () => {
      const req = buildRequest({
        to: 'bertha',
        type,
        deviceId: 'dev_anna_1',
      });
      await handleChatSend(req, env);

      // pushToUserDO sollte für 'bertha' (Empfänger) gerufen werden, NICHT für 'anna' (Sender).
      const pushedHandles = auth.pushToUserDO.mock.calls.map(c => c[1]);
      expect(pushedHandles).toContain('bertha');
      expect(pushedHandles).not.toContain('anna');
    });
  }

  it('Regular Chat-Message triggert DM-Self-Push (Multi-Device-Sync)', async () => {
    const req = buildRequest({
      to:       'bertha',
      message:  'hello',
      deviceId: 'dev_anna_1',
    });
    await handleChatSend(req, env);
    const pushedHandles = auth.pushToUserDO.mock.calls.map(c => c[1]);
    expect(pushedHandles).toContain('bertha');
    expect(pushedHandles).toContain('anna');
  });
});

describe('Rate-Limit-Buckets', () => {
  it('Regular Chat-Message → Bucket "chat_send:<me>:<deviceId>" (HARD)', async () => {
    const req = buildRequest({
      to: 'bertha', message: 'hi', deviceId: 'dev_anna_1',
    });
    await handleChatSend(req, env);
    const keys = auth.rateLimit.mock.calls.map(c => c[1]);
    expect(keys).toContain('chat_send:anna:dev_anna_1');
  });

  for (const type of SIGNALLING_DM) {
    if (type === 'cmk_req' || type === 'cmk_unavailable' || type === 'cmk' || type === 'epoch_rotate' || type === 'cmk_rotate') {
      it(`"${type}" → Bucket "control_send:<me>" (Control-Bucket)`, async () => {
        const req = buildRequest({
          to: 'bertha', type, deviceId: 'dev_anna_1',
        });
        await handleChatSend(req, env);
        const keys = auth.rateLimit.mock.calls.map(c => c[1]);
        expect(keys).toContain('control_send:anna');
        // Hard-Send-Limit-Bucket darf NICHT verwendet werden für Control-Types
        expect(keys).not.toContain('chat_send:anna:dev_anna_1');
      });
    }
  }

  it('"gsk" (Group-Context) → Bucket "control_send:<me>"', async () => {
    const groupId = '11111111-2222-3333-4444-555555555555';
    const req = buildRequest({
      to: 'bertha', convoId: groupId, type: 'gsk', deviceId: 'dev_anna_1',
      payloads: [{ deviceId: 'dev_b1', ivB64: 'AAAAAAAAAAAAAAAA', ctB64: 'BBBBBBBBBBBBBBBB' }],
    });
    await handleChatSend(req, env);
    const keys = auth.rateLimit.mock.calls.map(c => c[1]);
    expect(keys).toContain('control_send:anna');
  });

  it('"request_gsk" → eigenes Bucket "gsk_req:<me>" (60/min)', async () => {
    const groupId = '11111111-2222-3333-4444-555555555555';
    const req = buildRequest({
      to: 'bertha', convoId: groupId, type: 'request_gsk',
      deviceId: 'dev_anna_1', requestedFrom: 'bertha',
    });
    await handleChatSend(req, env);
    const keys = auth.rateLimit.mock.calls.map(c => c[1]);
    expect(keys).toContain('gsk_req:anna');
  });

  it('Rate-Limit überschritten → 429 + kein DB-Insert', async () => {
    auth.rateLimit.mockResolvedValueOnce(false);
    const req = buildRequest({
      to: 'bertha', message: 'hi', deviceId: 'dev_anna_1',
    });
    const res = await handleChatSend(req, env);
    expect(res.status).toBe(429);
    expect(env._dbInserts.length).toBe(0);
  });
});

describe('Negative Tests', () => {
  it('Type > 32 Zeichen → 400 + kein DB-Insert', async () => {
    const req = buildRequest({
      to: 'bertha',
      type: 'a'.repeat(33),
      message: 'hi',
      deviceId: 'dev_anna_1',
    });
    const res = await handleChatSend(req, env);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/type too large/i);
    expect(env._dbInserts.length).toBe(0);
  });

  it('Unbekannter Kurz-Type wird wie Chat-Message behandelt (heutiges Verhalten)', async () => {
    // Dokumentiert das heutige Verhalten: kein Whitelist-Reject für kurze unbekannte
    // Types — sie laufen durch den Chat-Message-Pfad inkl. Rate-Limit + Insert.
    const req = buildRequest({
      to: 'bertha',
      type: 'voice_ring',  // erfunden
      message: 'hi',
      deviceId: 'dev_anna_1',
    });
    const res = await handleChatSend(req, env);
    expect(res.status).not.toBe(400);
    // Da kein bekannter Control-Type → Hard-Send-Bucket greift
    const keys = auth.rateLimit.mock.calls.map(c => c[1]);
    expect(keys).toContain('chat_send:anna:dev_anna_1');
    // Insert in `messages` findet statt (zusätzlich gibts unread-Counter-INSERT)
    const messageInserts = env._dbInserts.filter(s => /INSERT.+INTO messages/i.test(s.sql));
    expect(messageInserts.length).toBe(1);
  });

  it('"request_gsk" ohne requestedFrom → 400', async () => {
    const groupId = '11111111-2222-3333-4444-555555555555';
    const req = buildRequest({
      to: 'bertha', convoId: groupId, type: 'request_gsk', deviceId: 'dev_anna_1',
    });
    const res = await handleChatSend(req, env);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/requestedFrom/i);
  });

  it('"request_gsk" mit requestedFrom == sender → 400 (Self-Request verboten)', async () => {
    const groupId = '11111111-2222-3333-4444-555555555555';
    const req = buildRequest({
      to: 'bertha', convoId: groupId, type: 'request_gsk',
      deviceId: 'dev_anna_1', requestedFrom: 'anna',
    });
    const res = await handleChatSend(req, env);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/Cannot request own GSK/i);
  });

  it('"gsk" ohne valid groupId → 400', async () => {
    const req = buildRequest({
      to: 'bertha', type: 'gsk', deviceId: 'dev_anna_1',
      payloads: [{ deviceId: 'dev_b1', ivB64: 'AAAAAAAAAAAAAAAA', ctB64: 'BBBBBBBBBBBBBBBB' }],
    });
    const res = await handleChatSend(req, env);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/group context/i);
  });
});

describe('Whitelist-Konsistenz', () => {
  // Defensive: stellt sicher dass alle bekannten Control-Types den gleichen
  // Insert/Push/Rate-Limit-Pfad nehmen. Wenn ein Type an einer Stelle vergessen
  // wird (z.B. neuer Type wird zu RATE_LIMIT_LIST hinzugefügt aber nicht zu
  // INSERT_SKIP_LIST), schlägt dieser Test fehl.
  for (const type of SIGNALLING_DM) {
    it(`"${type}" — alle Pfade konsistent (kein Insert UND kein Self-Push UND Control-Bucket)`, async () => {
      const req = buildRequest({
        to: 'bertha', type, deviceId: 'dev_anna_1',
      });
      await handleChatSend(req, env);

      const messageInserts = env._dbInserts.filter(s => /INSERT.+INTO messages/i.test(s.sql));
      const pushedHandles  = auth.pushToUserDO.mock.calls.map(c => c[1]);
      const rateLimitKeys  = auth.rateLimit.mock.calls.map(c => c[1]);

      expect(messageInserts.length, `${type}: kein Insert`).toBe(0);
      expect(pushedHandles, `${type}: kein Self-Push`).not.toContain('anna');
      expect(rateLimitKeys.some(k => k.startsWith('control_send:') || k.startsWith('gsk_req:')),
        `${type}: Control-Rate-Limit-Bucket`).toBe(true);
    });
  }
});
