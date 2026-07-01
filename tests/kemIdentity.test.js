// ======================================================
// Unit-Tests: ML-KEM-768 Device-Identität (M1 — Sesame-Core)
// ======================================================
// Garantien:
//   - getOrCreateKemIdentity erzeugt ek(1184)/dk(2400) und ist IDEMPOTENT
//     (persistiert, zweiter Call liefert dieselbe Identität).
//   - dk liegt AT-REST verschlüsselt (IDB-Blob != rohe dk-Bytes).
//   - gespeicherte/geladene Identität ist FUNKTIONAL (encapsulate/decapsulate
//     matcht) — der Storage-Round-Trip bewahrt die Keys bitgenau.
//   - importKemIdentity (Recovery-Restore) überschreibt + funktioniert; Größen-
//     Mismatch wirft.
// ======================================================
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { idbGet } from '../frontend/src/lib/idb.js';
import { b64ToBytes } from '../frontend/src/lib/bytes.js';
import {
  getOrCreateKemIdentity, getKemPublicKey, exportKemSecretForBundle, importKemIdentity,
} from '../frontend/src/lib/kemIdentity.js';
import { PQ, mlKemKeygen, mlKemEncapsulate, mlKemDecapsulate } from '../frontend/src/lib/pqCrypto.js';

const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));

describe('kemIdentity: erzeugen + persistieren', () => {
  it('erzeugt ek(1184)/dk(2400)', async () => {
    const { ek, dk } = await getOrCreateKemIdentity();
    expect(ek.length).toBe(PQ.ML_KEM_EK);
    expect(dk.length).toBe(PQ.ML_KEM_DK);
  });

  it('idempotent: zweiter Call liefert dieselbe Identität (persistiert)', async () => {
    const a = await getOrCreateKemIdentity();
    const b = await getOrCreateKemIdentity();
    expect(eq(a.ek, b.ek)).toBe(true);
    expect(eq(a.dk, b.dk)).toBe(true);
  });

  it('getKemPublicKey == ek der Identität', async () => {
    const { ek } = await getOrCreateKemIdentity();
    expect(eq(await getKemPublicKey(), ek)).toBe(true);
  });

  it('dk liegt AT-REST verschlüsselt (IDB-Blob != rohe dk)', async () => {
    const { dk } = await getOrCreateKemIdentity();
    const saved = await idbGet('pqxdh:kem-identity');
    expect(saved?.ctB64).toBeTruthy();
    const ctBytes = b64ToBytes(saved.ctB64);
    expect(ctBytes.length).toBe(PQ.ML_KEM_DK + 16); // AES-GCM-Tag
    expect(eq(ctBytes.slice(0, PQ.ML_KEM_DK), dk)).toBe(false); // nicht im Klartext
  });

  it('gespeicherte Identität ist FUNKTIONAL: encapsulate(ek) → decapsulate(dk) matcht', async () => {
    const { ek, dk } = await getOrCreateKemIdentity();
    const { ct, ss } = mlKemEncapsulate(ek);
    expect(eq(ss, mlKemDecapsulate(ct, dk))).toBe(true);
  });
});

describe('kemIdentity: export/import (Recovery-Bundle P5)', () => {
  it('exportKemSecretForBundle liefert dk(2400) == Identität', async () => {
    const { dk } = await getOrCreateKemIdentity();
    expect(eq(await exportKemSecretForBundle(), dk)).toBe(true);
  });

  it('importKemIdentity überschreibt + bleibt funktional', async () => {
    const fresh = mlKemKeygen(); // { ek, dk }
    await importKemIdentity(fresh.ek, fresh.dk);
    const loaded = await getOrCreateKemIdentity();
    expect(eq(loaded.ek, fresh.ek)).toBe(true);
    // funktional nach Storage-Round-Trip
    const { ct, ss } = mlKemEncapsulate(loaded.ek);
    expect(eq(ss, mlKemDecapsulate(ct, loaded.dk))).toBe(true);
  });

  it('importKemIdentity mit falschen Größen → wirft', async () => {
    await expect(importKemIdentity(new Uint8Array(10), new Uint8Array(PQ.ML_KEM_DK))).rejects.toThrow('size mismatch');
    await expect(importKemIdentity(new Uint8Array(PQ.ML_KEM_EK), new Uint8Array(10))).rejects.toThrow('size mismatch');
  });
});
