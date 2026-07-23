// ======================================================
// v4-Session-Reset (Deadlock-Heilung, nutzer-getriggert) — 2026-07-22
//
// Ersetzt den (in der adversarialen Review verworfenen) Auto-Heal. Prüft, dass
// resetV4Session ALLE relevanten Records eines Peers orphant:
//   - ratchet:g2:<peer>:*  + ratchetarch:g2:<peer>:*
//   - hybridsession:g2:<peer>:* + hybridsession:archive:g2:<peer>:*  (KRITISCH:
//     sonst liefert ensureHybridSession den alten rk0 → Send-Chain-Rewind)
//   - localStorage renex_staleinit:<peer>:* / renex_reinit:<peer>:*
// und den v4-Klartext-Store (v4msg:) + FREMDE Peers NICHT anfasst.
// ======================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory IDB, von beiden Modulen (ratchetSession + hybridSession) geteilt.
const _idb = new Map();
vi.mock('../frontend/src/lib/idb.js', () => ({
  idbGet: vi.fn((k) => Promise.resolve(_idb.get(k) ?? null)),
  idbSet: vi.fn((k, v) => { _idb.set(k, v); return Promise.resolve(); }),
  idbDelete: vi.fn((k) => { _idb.delete(k); return Promise.resolve(); }),
  idbListKeys: vi.fn((pfx) => Promise.resolve([..._idb.keys()].filter(k => k.startsWith(pfx)))),
}));
vi.mock('../frontend/src/lib/deviceStore.js', () => ({
  deriveStorageKey: vi.fn(() => Promise.resolve('k')), sealJson: vi.fn(), openJson: vi.fn(),
}));
// primeRatchetSession soll im Reset nur gefeuert werden — Netz stubben.
vi.mock('../frontend/src/lib/sesame.js', () => ({ getRecipientDevices: vi.fn(() => Promise.resolve([])) }));

import { resetV4Session } from '../frontend/src/lib/ratchetSession.js';

function seed() {
  _idb.clear();
  // xyz (Ziel) — alle Record-Arten, 2 Geräte
  _idb.set('ratchet:g2:xyz:dev_a', 's1');
  _idb.set('ratchet:g2:xyz:dev_b', 's2');
  _idb.set('ratchetarch:g2:xyz:dev_a', 's3');
  _idb.set('hybridsession:g2:xyz:dev_a', 'h1');
  _idb.set('hybridsession:g2:xyz:dev_b', 'h2');
  _idb.set('hybridsession:archive:g2:xyz:dev_a', 'h3');
  _idb.set('v4msg:msg-123', 'plaintext');           // MUSS bleiben (entschlüsselte History)
  // abc (fremder Peer) — MUSS unangetastet bleiben
  _idb.set('ratchet:g2:abc:dev_a', 'x1');
  _idb.set('hybridsession:g2:abc:dev_a', 'x2');
}

describe('resetV4Session', () => {
  beforeEach(() => {
    seed();
    // localStorage als Objekt mit enumerierbaren Keys (der Reset-Code nutzt
    // Object.keys(localStorage)) PLUS getItem/setItem/removeItem-Methoden.
    const s = {
      'renex_staleinit:xyz:dev_a': '{}',
      'renex_reinit:xyz:dev_a': '[]',
      'renex_staleinit:abc:dev_a': '{}',   // fremder Peer → bleibt
    };
    Object.defineProperties(s, {
      getItem:    { value: (k) => (k in s ? s[k] : null), enumerable: false },
      setItem:    { value: (k, v) => { s[k] = v; }, enumerable: false },
      removeItem: { value: (k) => { delete s[k]; }, enumerable: false },
    });
    vi.stubGlobal('localStorage', s);
    globalThis.__store2 = s;
  });

  it('löscht ratchet + arch + hybridsession + hybrid-archive für den Ziel-Peer', async () => {
    const r = await resetV4Session('xyz');
    expect(r.ratchet).toBe(3);   // 2 ratchet + 1 arch
    expect(r.hybrid).toBe(3);    // 2 hybridsession + 1 archive
    expect(_idb.has('ratchet:g2:xyz:dev_a')).toBe(false);
    expect(_idb.has('ratchet:g2:xyz:dev_b')).toBe(false);
    expect(_idb.has('ratchetarch:g2:xyz:dev_a')).toBe(false);
    expect(_idb.has('hybridsession:g2:xyz:dev_a')).toBe(false);
    expect(_idb.has('hybridsession:g2:xyz:dev_b')).toBe(false);
    expect(_idb.has('hybridsession:archive:g2:xyz:dev_a')).toBe(false);
  });

  it('lässt v4-Klartext-Store (History) UND fremde Peers unberührt', async () => {
    await resetV4Session('xyz');
    expect(_idb.get('v4msg:msg-123')).toBe('plaintext');   // entschlüsselte History bleibt
    expect(_idb.get('ratchet:g2:abc:dev_a')).toBe('x1');   // fremder Peer bleibt
    expect(_idb.get('hybridsession:g2:abc:dev_a')).toBe('x2');
  });

  it('räumt den Deadlock-/Reinit-Ledger nur des Ziel-Peers', async () => {
    await resetV4Session('xyz');
    const s = globalThis.__store2;
    expect(s['renex_staleinit:xyz:dev_a']).toBeUndefined();
    expect(s['renex_reinit:xyz:dev_a']).toBeUndefined();
    expect(s['renex_staleinit:abc:dev_a']).toBe('{}');     // fremder Peer bleibt
  });

  it('leerer/ungültiger Handle → no-op', async () => {
    const before = _idb.size;
    const r = await resetV4Session('');
    expect(r).toEqual({ ratchet: 0, hybrid: 0 });
    expect(_idb.size).toBe(before);
  });
});
