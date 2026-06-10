// ======================================================
// Handler-Wiring-Test: C2 Channel-Send-Gate in handleChatSend
// ======================================================
// channelAccess.test.js testet die Resolution-LOGIK. Dieser Test prüft die
// VERDRAHTUNG: dass handleChatSend bei einem privaten Channel real mit 403
// antwortet (Nicht-Viewer kann nicht senden) bzw. normale Channels durchlässt
// (Fast-Path, auch für role-lose Member — der GSK-Handshake-Regression-Guard).
// ======================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/auth.js', () => ({
  requireAnySession:  vi.fn(),
  rateLimit:          vi.fn(() => Promise.resolve(true)),
  isAcceptedContact:  vi.fn(() => Promise.resolve(true)),
  pushToUserDO:       vi.fn(() => Promise.resolve(0)),
  pushToGroupMembers: vi.fn(() => Promise.resolve()),
  getConvoMemberHandles: vi.fn(() => Promise.resolve([])),
  isConvoMember:      vi.fn(() => Promise.resolve(true)),
  GUEST_HANDLE_RE:    /^guest_[a-z0-9]+$/,
}));
vi.mock('../src/helpers/pushSend.js', () => ({
  pushToUser:     vi.fn(() => Promise.resolve()),
  detectMentions: vi.fn(() => ({ mentionsAll: false, mentionedHandles: [] })),
}));

import { handleChatSend } from '../src/helpers/chatSend.js';
import * as auth from '../src/auth.js';
import { Permissions } from '../src/lib/permissions.js';

const CHANNEL_ID = '11111111-2222-3333-4444-555555555555';
const everyoneRole = { id: 'everyone', permissions: Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES };

// env, dessen DB ein konfigurierbares Channel-Szenario für resolveChannelPerms liefert.
function buildEnv(scn) {
  const prepare = (sql) => ({
    bind: () => ({
      run:   () => Promise.resolve({ success: true, meta: {} }),
      first: () => {
        if (/FROM conversations WHERE id/i.test(sql))       return Promise.resolve(scn.channel ?? null);
        if (/SELECT is_owner FROM server_members/i.test(sql)) return Promise.resolve(scn.member ?? null);
        return Promise.resolve(null);
      },
      all: () => {
        if (/channel_permission_overrides/i.test(sql))           return Promise.resolve({ results: scn.overrides ?? [] });
        if (/role_assignments ra JOIN server_roles/i.test(sql))  return Promise.resolve({ results: scn.roles ?? [] });
        return Promise.resolve({ results: [] });
      },
    }),
  });
  return {
    RENEX_DB: { prepare, batch: () => Promise.resolve([]) },
    RENEX_KV: { get: vi.fn(() => Promise.resolve(null)), put: vi.fn(() => Promise.resolve()), delete: vi.fn(() => Promise.resolve()) },
    USER_SESSION_DO: { idFromName: () => ({}), get: () => ({ fetch: vi.fn(() => Promise.resolve(new Response('{}'))) }) },
  };
}

function buildRequest(body) {
  return {
    method: 'POST', url: 'https://api.renex.id/chat/send',
    headers: { get: (k) => {
      const key = String(k || '').toLowerCase();
      if (key === 'origin')       return 'https://app.renex.id';
      if (key === 'content-type') return 'application/json';
      return null;
    } },
    json: () => Promise.resolve(body),
  };
}

const sendAs = (handle, env) => handleChatSend(buildRequest({
  to: 'renex', convoId: CHANNEL_ID, message: 'hi', deviceId: 'dev1', e2e: false,
}), env);

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAnySession.mockResolvedValue({ handle: 'eve', isGuest: false, token: 't' });
  auth.rateLimit.mockResolvedValue(true);
  auth.isConvoMember.mockResolvedValue(true);
  auth.pushToGroupMembers.mockResolvedValue();
});

describe('C2 — handleChatSend Channel-Access-Gate (Verdrahtung)', () => {
  it('privater Channel, Nicht-Viewer → 403 (kein Senden)', async () => {
    const res = await sendAs('eve', buildEnv({
      channel: { type: 'channel', server_id: 'srv1' },
      member:  { is_owner: 0 },
      overrides: [{ target_kind: 'role', target_id: 'everyone', allow_bits: 0, deny_bits: Permissions.VIEW_CHANNEL }],
      roles: [everyoneRole],
    }));
    expect(res.status).toBe(403);
  });

  it('normaler Channel ohne Overrides → kein 403 (Fast-Path, auch role-los)', async () => {
    const res = await sendAs('eve', buildEnv({
      channel: { type: 'channel', server_id: 'srv1' },
      member:  { is_owner: 0 },
      overrides: [],   // Fast-Path → VIEW+SEND
      roles: [],       // KEINE Rolle → Regression-Guard (GSK-Handshake darf nicht 403en)
    }));
    expect(res.status).not.toBe(403);
  });

  it('privater Channel, Member mit member-allow VIEW+SEND → kein 403', async () => {
    const res = await sendAs('eve', buildEnv({
      channel: { type: 'channel', server_id: 'srv1' },
      member:  { is_owner: 0 },
      overrides: [
        { target_kind: 'role',   target_id: 'everyone', allow_bits: 0, deny_bits: Permissions.VIEW_CHANNEL },
        { target_kind: 'member', target_id: 'eve',      allow_bits: Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES, deny_bits: 0 },
      ],
      roles: [everyoneRole],
    }));
    expect(res.status).not.toBe(403);
  });

  it('read-only Channel (everyone deny SEND), Viewer → 403 (VIEW ja, SEND nein)', async () => {
    const res = await sendAs('eve', buildEnv({
      channel: { type: 'channel', server_id: 'srv1' },
      member:  { is_owner: 0 },
      overrides: [{ target_kind: 'role', target_id: 'everyone', allow_bits: 0, deny_bits: Permissions.SEND_MESSAGES }],
      roles: [everyoneRole],
    }));
    expect(res.status).toBe(403);
  });
});
