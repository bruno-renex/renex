// ======================================================
// Unit-Tests: Bundle-Forward-Kompatibilität (Phase 0)
// ======================================================
// Härtet die DREI hartcodierten Versions-Gates, die ein künftiges (z.B. PQ-v3)
// Recovery-Bundle STILL verworfen hätten → permanenter CMK/GSK-Verlust. Genau
// dieser Mechanismus hat 2026 schon einmal live alle CMKs beim Recovery
// vernichtet (dok. in cmkBundleSync.js).
//
// Garantien:
//   - decryptBundle akzeptiert JEDE authentifizierte Version (v=1/2/3+),
//     nicht nur eine Whitelist; unbekannte Felder bleiben erhalten.
//   - Sicherheit UNVERÄNDERT: falscher Key / falscher Handle (AAD-Mismatch)
//     wirft weiterhin.
//   - restoreCmksFromBundle importiert CMKs aus einem v3-Bundle (kein
//     stiller Early-Return mehr), ohne Versions-Whitelist.
// ======================================================
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { encryptBundle, decryptBundle } from '../frontend/src/lib/recovery.js';
import { restoreCmksFromBundle } from '../frontend/src/lib/cmkBundleSync.js';
import { getCMKIfExists } from '../frontend/src/lib/cmk.js';

const AES_IV_SIZE = 12;

async function makeKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function aadFor(handle) {
  return handle ? new TextEncoder().encode(`renex:bundle:${String(handle).toLowerCase()}`) : null;
}
// Simuliert ein ZUKÜNFTIGES Bundle mit beliebiger Version (encryptBundle hardcodet v=1/2).
async function makeFutureBlob(bundleObj, masterKey, handle) {
  const aad = aadFor(handle);
  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_SIZE));
  const pt = new TextEncoder().encode(JSON.stringify(bundleObj));
  const params = aad ? { name: 'AES-GCM', iv, additionalData: aad } : { name: 'AES-GCM', iv };
  const ct = await crypto.subtle.encrypt(params, masterKey, pt);
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return out;
}
function b64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

describe('decryptBundle: Forward-Kompatibilität', () => {
  it('Regression: v=1 (legacy, ohne Handle) round-trips', async () => {
    const key = await makeKey();
    const blob = await encryptBundle({ cmks: { a: 'x' }, ts: 1 }, key);
    const out = await decryptBundle(blob, key);
    expect(out.v).toBe(1);
    expect(out.cmks).toEqual({ a: 'x' });
  });

  it('Regression: v=2 (mit Handle-AAD) round-trips', async () => {
    const key = await makeKey();
    const blob = await encryptBundle({ cmks: { a: 'x' }, ts: 1 }, key, 'anna');
    const out = await decryptBundle(blob, key, 'anna');
    expect(out.v).toBe(2);
  });

  it('FIX: zukünftiges v=3-Bundle (mit AAD) wird AKZEPTIERT, nicht verworfen', async () => {
    const key = await makeKey();
    const blob = await makeFutureBlob({ v: 3, cmks: { a: 'x' }, ts: 1, pqField: 'kem768' }, key, 'anna');
    const out = await decryptBundle(blob, key, 'anna'); // würde VOR dem Fix werfen
    expect(out.v).toBe(3);
    expect(out.cmks).toEqual({ a: 'x' });
    expect(out.pqField).toBe('kem768'); // unbekanntes Feld bleibt erhalten
  });

  it('FIX: zukünftiges v=3-Bundle ohne AAD (legacy-Pfad) wird akzeptiert', async () => {
    const key = await makeKey();
    const blob = await makeFutureBlob({ v: 3, cmks: { b: 'y' } }, key); // kein handle
    const out = await decryptBundle(blob, key);
    expect(out.v).toBe(3);
    expect(out.cmks).toEqual({ b: 'y' });
  });

  it('Sicherheit: falscher masterKey wirft weiterhin', async () => {
    const key = await makeKey();
    const wrong = await makeKey();
    const blob = await makeFutureBlob({ v: 3, cmks: {} }, key, 'anna');
    await expect(decryptBundle(blob, wrong, 'anna')).rejects.toThrow();
  });

  it('Sicherheit: falscher Handle (AAD-Mismatch) wirft weiterhin', async () => {
    const key = await makeKey();
    const blob = await makeFutureBlob({ v: 3, cmks: {} }, key, 'anna');
    await expect(decryptBundle(blob, key, 'bertha')).rejects.toThrow();
  });
});

describe('restoreCmksFromBundle: Forward-Kompatibilität', () => {
  beforeEach(() => {
    if (typeof globalThis.localStorage === 'undefined') {
      const store = new Map();
      globalThis.localStorage = {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear(),
      };
    }
    globalThis.localStorage.setItem('my_user', 'alice');
  });

  it('FIX: v=3-Bundle importiert CMKs (kein stiller Early-Return)', async () => {
    const cmk = crypto.getRandomValues(new Uint8Array(32));
    const res = await restoreCmksFromBundle({ v: 3, cmks: { peer_fc_v3: b64(cmk) } });
    expect(res.imported).toBe(1); // VOR dem Fix: 0 (Gate verwarf v=3)
    expect(await getCMKIfExists('peer_fc_v3')).toBeTruthy();
  });

  it('Regression: v=2-Bundle importiert weiterhin', async () => {
    const cmk = crypto.getRandomValues(new Uint8Array(32));
    const res = await restoreCmksFromBundle({ v: 2, cmks: { peer_fc_v2: b64(cmk) } });
    expect(res.imported).toBe(1);
  });

  it('Bundle ohne cmks → {imported:0} (Guard bleibt)', async () => {
    const res = await restoreCmksFromBundle({ v: 3 });
    expect(res).toEqual({ imported: 0, skipped: 0 });
  });

  it('null/Nicht-Objekt → {imported:0} (Guard bleibt)', async () => {
    expect(await restoreCmksFromBundle(null)).toEqual({ imported: 0, skipped: 0 });
    expect(await restoreCmksFromBundle('nope')).toEqual({ imported: 0, skipped: 0 });
  });
});
