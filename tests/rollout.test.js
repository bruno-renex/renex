// ======================================================
// Unit-Tests: rollout.js — server-gesteuerte v4-Rollout-Flags (P3.2 GA)
// ======================================================
// Garantien: fail-safe AUS (nie gefetcht/Fehler → false), Server-Wert wird
// übernommen + gecacht, malformte Antwort → AUS, Kill (Server flippt auf false)
// propagiert beim nächsten Fetch.
// ======================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../frontend/src/lib/api.js', () => ({ apiFetch: vi.fn() }));

const _ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => { _ls.set(k, String(v)); },
  removeItem: (k) => { _ls.delete(k); },
};

import { apiFetch } from '../frontend/src/lib/api.js';
import { rolloutDefault, fetchRolloutFlags } from '../frontend/src/lib/rollout.js';

beforeEach(() => { vi.clearAllMocks(); _ls.clear(); });

describe('fail-safe AUS', () => {
  it('nie gefetcht → beide Defaults false', () => {
    expect(rolloutDefault('ratchetSend')).toBe(false);
    expect(rolloutDefault('pqRekey')).toBe(false);
  });
  it('Netzfehler beim Fetch → bleibt false', async () => {
    apiFetch.mockRejectedValue(new Error('offline'));
    await fetchRolloutFlags();
    expect(rolloutDefault('ratchetSend')).toBe(false);
  });
  it('malformte Antwort → false', async () => {
    apiFetch.mockResolvedValue({ ok: true, data: 'nicht-objekt' });
    await fetchRolloutFlags();
    expect(rolloutDefault('ratchetSend')).toBe(false);
    apiFetch.mockResolvedValue({ ok: false, data: null });
    await fetchRolloutFlags();
    expect(rolloutDefault('ratchetSend')).toBe(false);
  });
});

describe('Server-Wert übernehmen + Kill', () => {
  it('ratchetSend:true → rolloutDefault true, wird gecacht', async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { ratchetSend: true, pqRekey: false } });
    await fetchRolloutFlags();
    expect(rolloutDefault('ratchetSend')).toBe(true);
    expect(rolloutDefault('pqRekey')).toBe(false);
    expect(JSON.parse(_ls.get('renex_rollout')).flags.ratchetSend).toBe(true);
  });
  it('Kill: Server flippt auf false → nächster Fetch nimmt AUS', async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { ratchetSend: true, pqRekey: true } });
    await fetchRolloutFlags();
    expect(rolloutDefault('ratchetSend')).toBe(true);
    apiFetch.mockResolvedValue({ ok: true, data: { ratchetSend: false, pqRekey: false } });
    await fetchRolloutFlags();
    expect(rolloutDefault('ratchetSend')).toBe(false);
    expect(rolloutDefault('pqRekey')).toBe(false);
  });
  it('nur truthy===true zählt (kein truthy-Cast)', async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { ratchetSend: 1, pqRekey: 'yes' } });
    await fetchRolloutFlags();
    expect(rolloutDefault('ratchetSend')).toBe(false);
    expect(rolloutDefault('pqRekey')).toBe(false);
  });
});
