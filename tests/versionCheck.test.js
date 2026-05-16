// ======================================================
// Unit-Tests: Version-Polling
// ======================================================
// Garantien:
//   - getCurrentVersion liest <meta name="renex-version">
//   - fetchServerVersion parst /version.json korrekt
//   - isVersionMismatch: nur bei sauberen != Werten, null/null = false
//   - startVersionPolling ruft onMismatch genau 1× pro Lifetime
//   - Polling wird via stop()-Funktion gecanceled
//   - Erste Prüfung erst nach intervalMs (nicht sofort)
// ======================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getCurrentVersion,
  fetchServerVersion,
  isVersionMismatch,
  startVersionPolling,
} from '../frontend/src/lib/versionCheck.js';

// ── DOM-Polyfill für getCurrentVersion ─────────────────
function setMetaTag(version) {
  if (typeof globalThis.document === 'undefined') {
    let _meta = null;
    globalThis.document = {
      querySelector: (sel) => {
        if (sel === 'meta[name="renex-version"]') return _meta;
        return null;
      },
      _setMeta: (v) => { _meta = v ? { getAttribute: () => v } : null; },
    };
  }
  globalThis.document._setMeta?.(version);
}

beforeEach(() => {
  setMetaTag(null);
  vi.useRealTimers();
  if (globalThis.fetch?.mockReset) globalThis.fetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ────────────────────────────────────────────────────────
// getCurrentVersion
// ────────────────────────────────────────────────────────
describe('getCurrentVersion', () => {
  it('returns null wenn Meta-Tag fehlt', () => {
    setMetaTag(null);
    expect(getCurrentVersion()).toBe(null);
  });

  it('returns Wert aus content-Attribut', () => {
    setMetaTag('2026-05-04-24');
    expect(getCurrentVersion()).toBe('2026-05-04-24');
  });
});

// ────────────────────────────────────────────────────────
// isVersionMismatch
// ────────────────────────────────────────────────────────
describe('isVersionMismatch', () => {
  it('false bei null-Inputs', () => {
    expect(isVersionMismatch(null, null)).toBe(false);
    expect(isVersionMismatch(null, '1')).toBe(false);
    expect(isVersionMismatch('1', null)).toBe(false);
  });

  it('false bei gleichen Werten', () => {
    expect(isVersionMismatch('2026-05-04-24', '2026-05-04-24')).toBe(false);
  });

  it('true bei verschiedenen Werten', () => {
    expect(isVersionMismatch('2026-05-04-24', '2026-05-04-25')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────
// fetchServerVersion
// ────────────────────────────────────────────────────────
describe('fetchServerVersion', () => {
  it('liest version-Feld aus JSON', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ version: '2026-05-05-1' }),
    }));
    const v = await fetchServerVersion();
    expect(v).toBe('2026-05-05-1');
  });

  it('liefert null bei HTTP-Fehler', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false, json: () => ({}) }));
    expect(await fetchServerVersion()).toBe(null);
  });

  it('liefert null bei Network-Fehler', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('offline')));
    expect(await fetchServerVersion()).toBe(null);
  });

  it('liefert null bei korruptem JSON', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ noVersionField: true }),
    }));
    expect(await fetchServerVersion()).toBe(null);
  });

  it('benutzt cache: no-store + cache-buster Param', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ version: 'x' }),
    }));
    await fetchServerVersion();
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toMatch(/^\/version\.json\?_=\d+/);
    expect(opts.cache).toBe('no-store');
  });
});

// ────────────────────────────────────────────────────────
// startVersionPolling
// ────────────────────────────────────────────────────────
describe('startVersionPolling', () => {
  it('Erste Prüfung NICHT sofort, erst nach initialDelayMs', async () => {
    setMetaTag('v1');
    let serverVersion = 'v2';
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true, json: () => Promise.resolve({ version: serverVersion }),
    }));

    const onMismatch = vi.fn();
    vi.useFakeTimers();
    const stop = startVersionPolling(onMismatch, { intervalMs: 100, initialDelayMs: 100 });
    expect(globalThis.fetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(onMismatch).toHaveBeenCalledTimes(1);
    expect(onMismatch).toHaveBeenCalledWith('v2', 'v1');

    stop();
  });

  it('onMismatch wird nur EINMAL aufgerufen, auch wenn Mismatch persistiert', async () => {
    setMetaTag('v1');
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true, json: () => Promise.resolve({ version: 'v2' }),
    }));

    const onMismatch = vi.fn();
    vi.useFakeTimers();
    const stop = startVersionPolling(onMismatch, { intervalMs: 100, initialDelayMs: 100 });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(onMismatch).toHaveBeenCalledTimes(1);  // einmalig

    stop();
  });

  it('Kein onMismatch wenn Versionen gleich', async () => {
    setMetaTag('v1');
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true, json: () => Promise.resolve({ version: 'v1' }),
    }));

    const onMismatch = vi.fn();
    vi.useFakeTimers();
    const stop = startVersionPolling(onMismatch, { intervalMs: 100, initialDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(500);
    expect(onMismatch).not.toHaveBeenCalled();

    stop();
  });

  it('stop() verhindert weitere Pollings', async () => {
    setMetaTag('v1');
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true, json: () => Promise.resolve({ version: 'v1' }),
    }));

    vi.useFakeTimers();
    const stop = startVersionPolling(() => {}, { intervalMs: 100, initialDelayMs: 100 });

    await vi.advanceTimersByTimeAsync(100);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);  // keine weiteren Calls
  });

  it('Returnt no-op stop() wenn Meta-Tag fehlt (kein Polling sinnvoll)', () => {
    setMetaTag(null);
    const onMismatch = vi.fn();
    const stop = startVersionPolling(onMismatch);
    expect(typeof stop).toBe('function');
    stop();  // should not throw
  });

  it('Network-Fehler bei Poll → kein Crash, retry beim nächsten tick', async () => {
    setMetaTag('v1');
    let callCount = 0;
    globalThis.fetch = vi.fn(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('offline'));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ version: 'v2' }) });
    });

    const onMismatch = vi.fn();
    vi.useFakeTimers();
    const stop = startVersionPolling(onMismatch, { intervalMs: 100, initialDelayMs: 100 });

    await vi.advanceTimersByTimeAsync(100);
    expect(onMismatch).not.toHaveBeenCalled();  // erster Call schlug fehl
    await vi.advanceTimersByTimeAsync(100);
    expect(onMismatch).toHaveBeenCalledTimes(1);  // zweiter Call ok → Mismatch erkannt

    stop();
  });
});
