// ======================================================
// Unit-Tests: PQ-Krypto-Fundament (M0.5)
// ======================================================
// „KATs" (Known-Answer-Invarianten): die festen Byte-Längen der ML-KEM-768-
// Artefakte (ek 1184 / dk 2400 / ct 1088 / ss 32) + Round-Trip-Korrektheit.
// Plus: X25519-Symmetrie und die Bindungs-Eigenschaften des CT-bindenden
// Hybrid-Combiners (CT + beide Pubkeys + Domain/sid gebunden).
// ======================================================
import { describe, it, expect } from 'vitest';
import {
  PQ, mlKemKeygen, mlKemEncapsulate, mlKemDecapsulate,
  x25519Keygen, x25519Shared, deriveHybridWrapKey,
} from '../frontend/src/lib/pqCrypto.js';

const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));

describe('ML-KEM-768: KAT-Größen + Round-Trip', () => {
  it('keygen/encapsulate liefern die spezifizierten Byte-Längen', () => {
    const { ek, dk } = mlKemKeygen();
    expect(ek.length).toBe(PQ.ML_KEM_EK);   // 1184
    expect(dk.length).toBe(PQ.ML_KEM_DK);   // 2400
    const { ct, ss } = mlKemEncapsulate(ek);
    expect(ct.length).toBe(PQ.ML_KEM_CT);   // 1088
    expect(ss.length).toBe(PQ.SS);          // 32
  });

  it('encapsulate → decapsulate: Sender-ss == Empfänger-ss', () => {
    const { ek, dk } = mlKemKeygen();
    const { ct, ss } = mlKemEncapsulate(ek);
    const ssR = mlKemDecapsulate(ct, dk);
    expect(eq(ss, ssR)).toBe(true);
  });

  it('decapsulate mit FALSCHEM dk → anderes ss (implizite Rejection, kein Match)', () => {
    const { ek } = mlKemKeygen();
    const { dk: wrongDk } = mlKemKeygen();
    const { ct, ss } = mlKemEncapsulate(ek);
    const ssWrong = mlKemDecapsulate(ct, wrongDk);
    expect(ssWrong.length).toBe(PQ.SS);
    expect(eq(ss, ssWrong)).toBe(false);
  });
});

describe('X25519: Symmetrie', () => {
  it('pub 32B; getSharedSecret(A,pubB) == getSharedSecret(B,pubA)', () => {
    const a = x25519Keygen();
    const b = x25519Keygen();
    expect(a.pub.length).toBe(PQ.X25519_KEY);
    const sAB = x25519Shared(a.priv, b.pub);
    const sBA = x25519Shared(b.priv, a.pub);
    expect(sAB.length).toBe(PQ.SS);
    expect(eq(sAB, sBA)).toBe(true);
  });
});

describe('Hybrid-Combiner: Determinismus + CT/Pubkey/Domain-Bindung', () => {
  const base = () => ({
    ssEcdh: new Uint8Array(32).fill(1),
    ssPq: new Uint8Array(32).fill(2),
    kemCt: new Uint8Array(PQ.ML_KEM_CT).fill(3),
    pubA: new Uint8Array(32).fill(4),
    pubB: new Uint8Array(32).fill(5),
    algoVersion: 3,
    sid: 'conv1',
  });

  it('deterministisch: gleiche Inputs → gleicher 32B-Key', () => {
    const k1 = deriveHybridWrapKey(base());
    const k2 = deriveHybridWrapKey(base());
    expect(k1.length).toBe(32);
    expect(eq(k1, k2)).toBe(true);
  });

  it('CT-BINDUNG: anderer kemCt → anderer Key (ein untergeschobener KEM-CT ändert den Wrap)', () => {
    const k1 = deriveHybridWrapKey(base());
    const p = base(); p.kemCt = new Uint8Array(PQ.ML_KEM_CT).fill(9);
    expect(eq(k1, deriveHybridWrapKey(p))).toBe(false);
  });

  it('PUBKEY-BINDUNG: anderer pubA bzw. pubB → anderer Key', () => {
    const k1 = deriveHybridWrapKey(base());
    const pa = base(); pa.pubA = new Uint8Array(32).fill(9);
    const pb = base(); pb.pubB = new Uint8Array(32).fill(9);
    expect(eq(k1, deriveHybridWrapKey(pa))).toBe(false);
    expect(eq(k1, deriveHybridWrapKey(pb))).toBe(false);
  });

  it('DOMAIN/CONTEXT: anderes sid bzw. algoVersion → anderer Key', () => {
    const k1 = deriveHybridWrapKey(base());
    const ps = base(); ps.sid = 'conv2';
    const pv = base(); pv.algoVersion = 1;
    expect(eq(k1, deriveHybridWrapKey(ps))).toBe(false);
    expect(eq(k1, deriveHybridWrapKey(pv))).toBe(false);
  });

  it('SECRET-BINDUNG: anderes ss_ecdh bzw. ss_pq → anderer Key', () => {
    const k1 = deriveHybridWrapKey(base());
    const pe = base(); pe.ssEcdh = new Uint8Array(32).fill(9);
    const pp = base(); pp.ssPq = new Uint8Array(32).fill(9);
    expect(eq(k1, deriveHybridWrapKey(pe))).toBe(false);
    expect(eq(k1, deriveHybridWrapKey(pp))).toBe(false);
  });

  it('End-to-end: echter X25519+ML-KEM-Hybrid, beide Seiten leiten denselben Wrap-Key ab', () => {
    // Alice (Initiator) ↔ Bob (Empfänger, hat ML-KEM-Prekey + X25519-Prekey)
    const bobKem = mlKemKeygen();
    const bobX = x25519Keygen();
    const aliceX = x25519Keygen();

    // Alice: encapsulate gegen Bobs KEM-ek + X25519(aPriv, bPub)
    const { ct, ss: ssPqA } = mlKemEncapsulate(bobKem.ek);
    const ssEcdhA = x25519Shared(aliceX.priv, bobX.pub);
    const wrapA = deriveHybridWrapKey({
      ssEcdh: ssEcdhA, ssPq: ssPqA, kemCt: ct,
      pubA: aliceX.pub, pubB: bobX.pub, algoVersion: 3, sid: 's',
    });

    // Bob: decapsulate(ct, bobDk) + X25519(bPriv, aPub)
    const ssPqB = mlKemDecapsulate(ct, bobKem.dk);
    const ssEcdhB = x25519Shared(bobX.priv, aliceX.pub);
    const wrapB = deriveHybridWrapKey({
      ssEcdh: ssEcdhB, ssPq: ssPqB, kemCt: ct,
      pubA: aliceX.pub, pubB: bobX.pub, algoVersion: 3, sid: 's',
    });

    expect(eq(wrapA, wrapB)).toBe(true);   // beide kommen auf denselben 32B-Key
  });
});
