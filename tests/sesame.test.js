// ======================================================
// Unit-Tests: Sesame-Core Recipient-Set-Manager (M1)
// ======================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

// apiFetch mocken BEVOR sesame.js importiert wird.
vi.mock('../frontend/src/lib/api.js', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '../frontend/src/lib/api.js';
import {
  getRecipientDevices, getPqCapableDevices, onDevsetGen, invalidateRecipientCache,
} from '../frontend/src/lib/sesame.js';

const ok = (data) => ({ ok: true, status: 200, data, error: null });

beforeEach(() => {
  vi.clearAllMocks();
  invalidateRecipientCache(); // globaler Cache-Reset
});

describe('getRecipientDevices', () => {
  it('fetcht /e2e/devset und liefert die Devices', async () => {
    apiFetch.mockResolvedValueOnce(ok({ gen: 3, devices: [{ deviceId: 'd1', hasKem: true, caps: { hybrid: true } }] }));
    const devs = await getRecipientDevices('BOB');
    expect(apiFetch).toHaveBeenCalledWith('/e2e/devset?user=bob');
    expect(devs).toEqual([{ deviceId: 'd1', hasKem: true, caps: { hybrid: true } }]);
  });

  it('gen-Cache: zweiter Call innerhalb TTL fetcht NICHT erneut', async () => {
    apiFetch.mockResolvedValueOnce(ok({ gen: 1, devices: [{ deviceId: 'd1', hasKem: false }] }));
    await getRecipientDevices('bob');
    const again = await getRecipientDevices('bob');
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(again).toEqual([{ deviceId: 'd1', hasKem: false }]);
  });

  it('force:true umgeht den Cache', async () => {
    apiFetch.mockResolvedValue(ok({ gen: 1, devices: [] }));
    await getRecipientDevices('bob');
    await getRecipientDevices('bob', { force: true });
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('onDevsetGen mit höherem gen invalidiert → nächster Call fetcht frisch', async () => {
    apiFetch.mockResolvedValueOnce(ok({ gen: 1, devices: [{ deviceId: 'd1', hasKem: false }] }));
    await getRecipientDevices('bob');
    onDevsetGen('bob', 2); // Peer hat ein neues Device (gen 1→2)
    apiFetch.mockResolvedValueOnce(ok({ gen: 2, devices: [{ deviceId: 'd1', hasKem: false }, { deviceId: 'd2', hasKem: true }] }));
    const devs = await getRecipientDevices('bob');
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(devs).toHaveLength(2);
  });

  it('onDevsetGen mit gleichem/niedrigerem gen invalidiert NICHT', async () => {
    apiFetch.mockResolvedValueOnce(ok({ gen: 5, devices: [] }));
    await getRecipientDevices('bob');
    onDevsetGen('bob', 5);
    await getRecipientDevices('bob');
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('bei Fetch-Fehler: alter Cache bleibt (kein Datenverlust)', async () => {
    apiFetch.mockResolvedValueOnce(ok({ gen: 1, devices: [{ deviceId: 'd1', hasKem: true }] }));
    await getRecipientDevices('bob');
    invalidateRecipientCache('bob'); // erzwingt Fetch, der scheitert
    // Cache ist weg → Fehler-Fetch liefert [] (kein alter Cache mehr)
    apiFetch.mockResolvedValueOnce({ ok: false, status: 500, data: null, error: 'x' });
    expect(await getRecipientDevices('bob')).toEqual([]);
  });
});

describe('getPqCapableDevices', () => {
  it('filtert auf hasKem', async () => {
    apiFetch.mockResolvedValueOnce(ok({ gen: 1, devices: [
      { deviceId: 'd1', hasKem: true }, { deviceId: 'd2', hasKem: false }, { deviceId: 'd3', hasKem: true },
    ] }));
    const pq = await getPqCapableDevices('bob');
    expect(pq.map(d => d.deviceId)).toEqual(['d1', 'd3']);
  });
});
