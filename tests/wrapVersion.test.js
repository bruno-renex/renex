// ======================================================
// Unit-Tests: Wrap-Algo-Versionierung (Phase 0.2)
// ======================================================
// Garantien:
//   - WRAP_ALGO/CURRENT_WRAP_ALGO Konstanten stabil.
//   - wrapAlgoOf liest tolerant: Legacy-Wrap (kein Feld) → klassisch (1).
//   - wrapCMKForInboxDevices schreibt algoVersion=1 in jeden Payload, ohne den
//     ECDH-Wrap/Unwrap-Round-Trip zu brechen (additiv).
// ======================================================
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { idbSet } from '../frontend/src/lib/idb.js';
import { WRAP_ALGO, CURRENT_WRAP_ALGO, wrapAlgoOf } from '../frontend/src/lib/wrapVersion.js';
import { wrapCMKForInboxDevices, unwrapCMKFromPeer } from '../frontend/src/lib/cmk.js';

describe('wrapVersion: Konstanten + toleranter Reader', () => {
  it('Konstanten stabil (klassisch=1, hybrid=3, current=1)', () => {
    expect(WRAP_ALGO.ECDH_P256).toBe(1);
    expect(WRAP_ALGO.HYBRID_MLKEM768).toBe(3);
    expect(CURRENT_WRAP_ALGO).toBe(1);
  });
  it('wrapAlgoOf liest explizite Version', () => {
    expect(wrapAlgoOf({ algoVersion: 3 })).toBe(3);
    expect(wrapAlgoOf({ algoVersion: 1 })).toBe(1);
  });
  it('wrapAlgoOf: Legacy/fehlend/ungültig → klassisch (1)', () => {
    expect(wrapAlgoOf({})).toBe(1);
    expect(wrapAlgoOf(null)).toBe(1);
    expect(wrapAlgoOf(undefined)).toBe(1);
    expect(wrapAlgoOf({ algoVersion: 'x' })).toBe(1);
  });
});

describe('wrapCMKForInboxDevices: algoVersion additiv (Round-Trip intakt)', () => {
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
    globalThis.localStorage.setItem('device_id:alice', 'dev_alice');
  });

  it('jeder Payload trägt algoVersion=1 + die bisherigen Felder; Unwrap round-trips', async () => {
    // Alice (= ich) + Bob. Beide extractable — Nicht-Extractability ist Prod-
    // Härtung des Privatkeys, fürs ECDH-Round-Trip irrelevant.
    const alice = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    const bob = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    const aliceJwk = await crypto.subtle.exportKey('jwk', alice.publicKey);
    const bobJwk = await crypto.subtle.exportKey('jwk', bob.publicKey);

    // Wrap als Alice: mein Priv in IDB, Bobs Pubkey als Device.
    await idbSet('e2e-private-key', alice.privateKey);
    await idbSet('e2e-public-key', alice.publicKey);

    const cmk = crypto.getRandomValues(new Uint8Array(32));
    const payloads = await wrapCMKForInboxDevices([{ deviceId: 'dev_bob', jwk: bobJwk }], cmk);

    expect(payloads).toHaveLength(1);
    const p = payloads[0];
    expect(p.algoVersion).toBe(1);              // NEU (Phase 0.2)
    expect(p.deviceId).toBe('dev_bob');         // bestehende Felder unverändert
    expect(typeof p.ivB64).toBe('string');
    expect(typeof p.ctB64).toBe('string');
    expect(wrapAlgoOf(p)).toBe(1);

    // Round-Trip: Bob entschlüsselt mit SEINEM Priv + Alices Pub (ECDH symmetrisch).
    await idbSet('e2e-private-key', bob.privateKey);
    const out = await unwrapCMKFromPeer(p.ivB64, p.ctB64, aliceJwk);
    expect(Array.from(out)).toEqual(Array.from(cmk));
  });
});
