// ======================================================
// Gast-Attachment-Upload (eGov 1.2, Häppchen 7)
//
// POST /upload/file akzeptiert jetzt Gast-Sessions (requireAnySession):
// - Gast darf NUR in seine zugewiesene Konversation hochladen (403 sonst)
// - zusätzliche Tages-Quota (100/Tag) gegen R2-Storage-Abuse
// - Real-User-Verhalten unverändert (DM-Handle-Check, 20/min)
// - Download-Pfad für Gäste war schon offen — Regression mitgeprüft
// ======================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/auth.js', () => ({
  requireSession:      vi.fn(() => Promise.resolve(null)),
  requireAnySession:   vi.fn(() => Promise.resolve(null)),
  rateLimit:           vi.fn(() => Promise.resolve(true)),
}));

import { handleUploadRoutes } from '../src/routes/uploadRoutes.js';
import * as auth from '../src/auth.js';

const GUEST_SESSION = {
  handle: 'guest_c92c8e80', isGuest: true,
  token: 'guest_' + 'a'.repeat(32),
  convoId: 'colicotest:guest_c92c8e80',
};

function buildEnv() {
  const r2Puts = [];
  return {
    RENEX_DB: { prepare: () => ({ bind: () => ({ first: () => Promise.resolve({ 1: 1 }) }) }) },
    RENEX_FILES: {
      put: (key, body) => { r2Puts.push({ key, size: body.byteLength }); return Promise.resolve(); },
      get: () => Promise.resolve(null),
    },
    _r2Puts: r2Puts,
  };
}

function uploadReq(convoId) {
  const bytes = new Uint8Array(64).fill(7);
  return {
    method: 'POST',
    url: 'https://api.renex.id/upload/file',
    headers: { get: (k) => ({
      'x-mime-type':       'image/jpeg',
      'x-file-name':       'versichertenkarte.jpg',
      'x-file-size':       '64',
      'x-attachment-type': 'photo',
      'x-convo-id':        convoId,
    }[String(k).toLowerCase()] ?? null) },
    arrayBuffer: () => Promise.resolve(bytes.buffer),
  };
}

const upload = (env, convoId) =>
  handleUploadRoutes(uploadReq(convoId), env, '/upload/file', new URLSearchParams());

describe('POST /upload/file — Gast', () => {
  beforeEach(() => {
    vi.clearAllMocks();   // Call-Historie leeren (Assertion „nie mit … aufgerufen")
    auth.requireAnySession.mockResolvedValue({ ...GUEST_SESSION });
    auth.rateLimit.mockResolvedValue(true);
  });

  it('Gast lädt in die eigene Konversation hoch → 200 + R2-Key im Konvo-Pfad', async () => {
    const env = buildEnv();
    const res = await upload(env, GUEST_SESSION.convoId);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.r2Key).toMatch(/^files\/colicotest:guest_c92c8e80\/[0-9a-f-]{36}$/);
    expect(env._r2Puts).toHaveLength(1);
  });

  it('fremde Konversation → 403, nichts in R2', async () => {
    const env = buildEnv();
    const res = await upload(env, 'colicotest:guest_ffffffff');
    expect(res.status).toBe(403);
    expect(env._r2Puts).toHaveLength(0);
  });

  it('Tages-Quota erschöpft → 429 (Gast-spezifischer Limiter)', async () => {
    auth.rateLimit.mockImplementation((env, key) =>
      Promise.resolve(!key.startsWith('upload_guest_day:')));
    const env = buildEnv();
    const res = await upload(env, GUEST_SESSION.convoId);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain('Daily');
  });

  it('Real-User unverändert: DM-Mitglied 200, Fremder 403, KEIN Tages-Limiter', async () => {
    auth.requireAnySession.mockResolvedValue({ handle: 'colicotest', isGuest: false });
    const env = buildEnv();
    const res = await upload(env, 'colicotest:guest_c92c8e80');
    expect(res.status).toBe(200);
    expect(auth.rateLimit).not.toHaveBeenCalledWith(expect.anything(),
      expect.stringMatching(/^upload_guest_day:/), expect.anything(), expect.anything());

    auth.requireAnySession.mockResolvedValue({ handle: 'fremder', isGuest: false });
    expect((await upload(buildEnv(), 'colicotest:guest_c92c8e80')).status).toBe(403);
  });
});
