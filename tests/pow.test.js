// ======================================================
// Unit-Tests: Proof-of-Work (L1)
// ======================================================
// Garantien:
//   - countLeadingZeroBits + powPreimage sind auf Server (src/powCheck.js) und
//     Client (frontend/src/lib/powCore.js) IDENTISCH.
//   - requiredPowBits: Floor für etablierte, höherer Tier für neue Accounts.
//   - verifyPow: fehlende/zu schwache Nonce korrekt klassifiziert.
//   - CROSS-CHECK: eine vom Client (noble-SHA256) gelöste Nonce wird vom Server
//     (crypto.subtle-SHA256) akzeptiert → beide SHA-256-Impls liefern dieselben
//     Bytes (sonst bricht die ganze L1-Kette).
// ======================================================
import { describe, it, expect } from 'vitest';
import {
  powPreimage as srvPreimage,
  countLeadingZeroBits as srvClz,
  requiredPowBits,
  verifyPow,
  POW_FLOOR_BITS,
  POW_NEW_ACCOUNT_BITS,
} from '../src/powCheck.js';
import {
  powPreimage as cliPreimage,
  countLeadingZeroBits as cliClz,
  solvePow,
} from '../frontend/src/lib/powCore.js';

describe('PoW: countLeadingZeroBits', () => {
  it('zählt volle Null-Bytes', () => {
    expect(srvClz(new Uint8Array([0, 0, 0xff]))).toBe(16);
  });
  it('zählt Teil-Byte korrekt', () => {
    expect(srvClz(new Uint8Array([0x01]))).toBe(7); // 0b00000001
    expect(srvClz(new Uint8Array([0x0f]))).toBe(4); // 0b00001111
    expect(srvClz(new Uint8Array([0x80]))).toBe(0);
    expect(srvClz(new Uint8Array([0x00, 0x10]))).toBe(11); // 8 + (0x10=0b00010000 → 3)
  });
  it('alle Null → volle Bitlänge', () => {
    expect(srvClz(new Uint8Array([0, 0, 0, 0]))).toBe(32);
  });
  it('Server- und Client-clz sind bit-identisch', () => {
    const samples = [[0], [1], [0x0f], [0x80], [0, 0, 5], [255, 0], [0, 0, 0, 0x40]];
    for (const s of samples) {
      const a = new Uint8Array(s);
      expect(cliClz(a)).toBe(srvClz(a));
    }
  });
});

describe('PoW: powPreimage', () => {
  it('bindet sig wenn vorhanden', () => {
    expect(srvPreimage({ sid: 's', epoch: 2, sig: 'SIG', ctB64: 'CT', nonce: '5' })).toBe('s|2|SIG|5');
  });
  it('fällt auf ctB64 zurück ohne sig', () => {
    expect(srvPreimage({ sid: 's', epoch: 0, sig: '', ctB64: 'CT', nonce: '9' })).toBe('s|0|CT|9');
  });
  it('Server- und Client-Preimage identisch', () => {
    const p = { sid: 'abc', epoch: 7, sig: 'zz', ctB64: 'q', nonce: '42' };
    expect(cliPreimage(p)).toBe(srvPreimage(p));
  });
});

describe('PoW: requiredPowBits', () => {
  it('Floor für etablierte Accounts (Default accountAgeMs=Infinity)', () => {
    expect(requiredPowBits()).toBe(POW_FLOOR_BITS);
  });
  it('höherer Tier für neue Accounts (<24h)', () => {
    expect(requiredPowBits({ accountAgeMs: 3600_000 })).toBe(Math.max(POW_FLOOR_BITS, POW_NEW_ACCOUNT_BITS));
  });
  it('custom floor wird respektiert', () => {
    expect(requiredPowBits({ floorBits: 12 })).toBe(12);
  });
});

describe('PoW: verifyPow (Server, async crypto.subtle)', () => {
  it('fehlende Nonce → reason missing, ok=false', async () => {
    const r = await verifyPow({ sid: 's', epoch: 0, sig: 'x', nonce: undefined, requiredBits: 8 });
    expect(r).toMatchObject({ ok: false, reason: 'missing' });
  });
  it('überlange Nonce → missing (defensiv)', async () => {
    const r = await verifyPow({ sid: 's', epoch: 0, sig: 'x', nonce: 'a'.repeat(65), requiredBits: 8 });
    expect(r.reason).toBe('missing');
  });
  it('zu schwache Nonce → reason weak', async () => {
    const r = await verifyPow({ sid: 's', epoch: 0, sig: 'x', ctB64: 'c', nonce: '0', requiredBits: 64 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('weak');
  });
});

describe('PoW: Cross-Check Client-Solve ↔ Server-Verify (gleiche SHA-256)', () => {
  it('Client solvePow (noble) → Server verifyPow (subtle) akzeptiert', async () => {
    const params = { sid: 'conv1', epoch: 3, sig: 'deadbeefSIG', ctB64: 'CIPHER', bits: 12 };
    const solved = solvePow(params, 5_000_000);
    expect(solved).not.toBeNull();
    expect(solved.bits).toBe(12);

    const v = await verifyPow({
      sid: params.sid, epoch: params.epoch, sig: params.sig, ctB64: params.ctB64,
      nonce: solved.nonce, requiredBits: 12,
    });
    expect(v.ok).toBe(true);
    expect(v.bits).toBeGreaterThanOrEqual(12);
    expect(v.reason).toBe('ok');
  });

  it('solvePow ohne sig (ct-Bindung) wird ebenfalls akzeptiert', async () => {
    const params = { sid: 'c2', epoch: 0, sig: '', ctB64: 'XYZ', bits: 10 };
    const solved = solvePow(params, 2_000_000);
    expect(solved).not.toBeNull();
    const v = await verifyPow({ sid: 'c2', epoch: 0, sig: '', ctB64: 'XYZ', nonce: solved.nonce, requiredBits: 10 });
    expect(v.ok).toBe(true);
  });

  it('Nonce für andere Bytes wird NICHT akzeptiert (Bindung greift)', async () => {
    const solved = solvePow({ sid: 'a', epoch: 1, sig: 'S', ctB64: 'C', bits: 12 }, 5_000_000);
    // gleiche Nonce, aber anderes epoch → anderes Preimage → praktisch nie valide bei 12 bits
    const v = await verifyPow({ sid: 'a', epoch: 2, sig: 'S', ctB64: 'C', nonce: solved.nonce, requiredBits: 12 });
    expect(v.ok).toBe(false);
  });
});
