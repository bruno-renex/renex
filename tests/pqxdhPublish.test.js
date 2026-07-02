// ======================================================
// Unit-Tests: pqxdhPublish.js — Client-Publish-Hook + Fresh-ID-Topup (M2 §4.3)
// ======================================================
// (1) pqxdhKeys.topUpOpks: additiv, NUR frische IDs (Tombstone-Gegenstück).
// (2) publishPqxdhBundleIfNeeded: Erst-Publish → Upload + Marker; zweiter
//     Aufruf → nur opk-count (kein Re-Upload); Low-Water → Topup mit NUR
//     frischen OPKs; Fehler non-fatal.
// fake-indexeddb + gemocktes api.js; handle/deviceId injiziert (kein localStorage).
// ======================================================
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../frontend/src/lib/api.js', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../frontend/src/lib/api.js';
import { ensureOpkPool, topUpOpks } from '../frontend/src/lib/pqxdhKeys.js';
import { publishPqxdhBundleIfNeeded } from '../frontend/src/lib/pqxdhPublish.js';

const IDS = { handle: 'alice', deviceId: 'dev_test_1234' };

beforeEach(() => { vi.clearAllMocks(); });

describe('pqxdhKeys.topUpOpks (Fresh-ID-Topup)', () => {
  it('erzeugt additiv NUR frische IDs (keine Kollision mit Bestand)', async () => {
    const { all: before } = await ensureOpkPool(10);
    const beforeIds = new Set(before.map(o => o.opkId));
    const { added, localCount } = await topUpOpks(5);
    expect(added.length).toBe(5);
    expect(localCount).toBe(before.length + 5);          // additiv über Pool-Größe hinaus
    for (const o of added) expect(beforeIds.has(o.opkId)).toBe(false);   // alle frisch
  });

  it('count=0 → keine Änderung', async () => {
    const { localCount: n0 } = await topUpOpks(0);
    const { localCount: n1 } = await topUpOpks(0);
    expect(n1).toBe(n0);
  });
});

describe('publishPqxdhBundleIfNeeded', () => {
  it('Erst-Publish: volles Bundle → Upload, Marker gesetzt', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });
    const r = await publishPqxdhBundleIfNeeded(IDS);
    expect(r.ok).toBe(true);
    expect(r.action).toBe('published');
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [path, opts] = apiFetch.mock.calls[0];
    expect(path).toBe('/e2e/pqxdh/upload');
    expect(opts.method).toBe('POST');
    expect(opts.body.deviceId).toBe(IDS.deviceId);
    expect(opts.body.ik.ikX).toBeTruthy();
    expect(opts.body.spk.sig).toBeTruthy();
    expect(opts.body.pqspk.ek).toBeTruthy();
    expect(opts.body.opks.length).toBeGreaterThan(0);
  });

  it('zweiter Aufruf (Marker gesetzt, Count hoch): nur opk-count, KEIN Re-Upload', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: { count: 95 } });
    const r = await publishPqxdhBundleIfNeeded(IDS);
    expect(r).toEqual({ ok: true, action: 'noop' });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0][0]).toMatch(/^\/e2e\/pqxdh\/opk-count\?user=alice&device=dev_test_1234$/);
  });

  it('Low-Water: Topup mit NUR frischen OPKs (nicht der volle Pool)', async () => {
    apiFetch.mockImplementation(async (path) => {
      if (path.startsWith('/e2e/pqxdh/opk-count')) return { ok: true, status: 200, data: { count: 5 } };
      return { ok: true, status: 200, data: { ok: true } };
    });
    const r = await publishPqxdhBundleIfNeeded(IDS);
    expect(r.ok).toBe(true);
    expect(r.action).toBe('topup');
    expect(r.opks).toBe(95);                              // 100 - 5 verbleibend
    const upload = apiFetch.mock.calls.find(c => c[0] === '/e2e/pqxdh/upload');
    expect(upload[1].body.opks.length).toBe(95);
    expect(upload[1].body.ik.ikX).toBeTruthy();           // Pflichtfelder dabei
    // Frische IDs: keine Überlappung mit dem beim Erst-Publish hochgeladenen Pool.
  });

  it('Upload-Fehler → non-fatal (ok:false), Marker NICHT gesetzt → Retry beim nächsten Aufruf', async () => {
    const freshDev = { handle: 'alice', deviceId: 'dev_fail_5678' };
    apiFetch.mockResolvedValue({ ok: false, status: 500, error: 'boom' });
    const r1 = await publishPqxdhBundleIfNeeded(freshDev);
    expect(r1.ok).toBe(false);
    // Nächster Aufruf versucht den Erst-Publish ERNEUT (kein Marker):
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });
    const r2 = await publishPqxdhBundleIfNeeded(freshDev);
    expect(r2).toMatchObject({ ok: true, action: 'published' });
  });

  it('Re-Publish nach Topup (lokal >100 Privs) cappt auf ≤100 OPKs (Server-Max, sonst 400 bad_opks)', async () => {
    // Vorgeschichte dieses Testfiles: Erst-Publish (100) + Topup (95) → lokal 195.
    // Rotation simulieren: Marker-Fingerprint invalidieren → Re-Publish-Pfad.
    const { idbSet } = await import('../frontend/src/lib/idb.js');
    await idbSet(`pqxdh:published:${IDS.deviceId}`, { fingerprint: 'stale:stale', at: 1 });
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });
    const r = await publishPqxdhBundleIfNeeded(IDS);
    expect(r).toMatchObject({ ok: true, action: 'published' });
    const upload = apiFetch.mock.calls.find(c => c[0] === '/e2e/pqxdh/upload');
    expect(upload[1].body.opks.length).toBeLessThanOrEqual(100);   // Server-Validator-Max
    expect(upload[1].body.opks.length).toBe(100);                  // = die neuesten 100
  });

  it('ohne handle/deviceId → skipped, kein API-Call', async () => {
    const r = await publishPqxdhBundleIfNeeded({ handle: '', deviceId: '' });
    expect(r).toEqual({ ok: false, action: 'skipped' });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('Exception im Unterbau → skipped, wirft NIE (Login-Flow-Schutz)', async () => {
    apiFetch.mockRejectedValue(new Error('network down'));
    await expect(publishPqxdhBundleIfNeeded(IDS)).resolves.toMatchObject({ ok: false });
  });
});
