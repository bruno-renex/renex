// ======================================================
// Unit-Tests: hybridSession.js — PQXDH-Handshake-Runner (M2, Contract §4.0)
// ======================================================
// End-to-end durch die ECHTEN Module (nur apiFetch gemockt):
//  - ensureHybridSession (Initiator): Bundle-Fetch → initiatorRoot → InitHdr;
//    das per Wire simulierte Gegenüber leitet mit responderRoot DASSELBE RK0 ab.
//  - acceptHybridSession (Responder): lokales Bundle publizieren → ad-hoc-Alice
//    baut InitHdr → accept konsumiert OPK + responderRoot == Alices RK0.
//  - InitHdr-Sig (signInitHdr/verifyInitHdr) + Tie-Break (D4) pure.
// ======================================================
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../frontend/src/lib/api.js', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../frontend/src/lib/api.js';
import { bytesToB64, b64ToBytes } from '../frontend/src/lib/bytes.js';
import { x25519Keygen, ed25519Keygen, mlKemKeygen } from '../frontend/src/lib/pqCrypto.js';
import {
  initiatorRoot, responderRoot, signPrekey,
  signInitHdr, verifyInitHdr,
} from '../frontend/src/lib/pqxdh.js';
import { buildPublishBundle, decodeInitiatorBundle } from '../frontend/src/lib/pqxdhKeys.js';
import {
  ensureHybridSession, acceptHybridSession, myInitWins, compareBytes,
} from '../frontend/src/lib/hybridSession.js';

const ALG = 'pqxdh-x25519-mlkem768';
const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));

// Ad-hoc-„Bob" (das per Wire simulierte Ziel-Gerät) + single-opk-Wire.
function makeBobWire(deviceId, { withOpk = true } = {}) {
  const ikEd = ed25519Keygen(), ikX = x25519Keygen(), spk = x25519Keygen(), pq = mlKemKeygen();
  const opk = withOpk ? x25519Keygen() : null;
  const wire = {
    deviceId,
    ik: { ikX: bytesToB64(ikX.pub), ikEd: bytesToB64(ikEd.pub) },
    spk: { spkId: 's1', spk: bytesToB64(spk.pub), sig: bytesToB64(signPrekey('spk', spk.pub, ikEd.priv)) },
    pqspk: { pqspkId: 'p1', ek: bytesToB64(pq.ek), sig: bytesToB64(signPrekey('pqspk', pq.ek, ikEd.priv)) },
    ...(opk ? { opk: { opkId: 'o1', opk: bytesToB64(opk.pub) } } : { opk: null }),
  };
  return { ikEd, ikX, spk, pq, opk, wire };
}

beforeEach(() => { vi.clearAllMocks(); });

// ── InitHdr-Signatur (pure) ────────────────────────────
describe('signInitHdr / verifyInitHdr (§4.0 canonicalInitHdr)', () => {
  const fields = () => ({
    v: 3, alg: ALG,
    ikA25519: x25519Keygen().pub, ekA25519: x25519Keygen().pub,
    usedSpkId: 's1', usedOpkId: 'o1', usedPqspkId: 'p1', mlkemCt: new Uint8Array(1088).fill(9),
  });
  it('Round-Trip verifiziert', () => {
    const ikEd = ed25519Keygen(); const f = fields();
    expect(verifyInitHdr(f, signInitHdr(f, ikEd.priv), ikEd.pub)).toBe(true);
  });
  it('geändertes usedPqspkId bricht die Sig (PQ-Downgrade-Schutz)', () => {
    const ikEd = ed25519Keygen(); const f = fields();
    const sig = signInitHdr(f, ikEd.priv);
    expect(verifyInitHdr({ ...f, usedPqspkId: 'p2' }, sig, ikEd.pub)).toBe(false);
  });
  it('geänderter mlkemCt bricht die Sig', () => {
    const ikEd = ed25519Keygen(); const f = fields();
    const sig = signInitHdr(f, ikEd.priv);
    const ct2 = new Uint8Array(1088).fill(8);
    expect(verifyInitHdr({ ...f, mlkemCt: ct2 }, sig, ikEd.pub)).toBe(false);
  });
  it('usedOpkId null vs. "" ist identisch (kanonische Normalisierung)', () => {
    const ikEd = ed25519Keygen(); const f = { ...fields(), usedOpkId: null };
    const sig = signInitHdr(f, ikEd.priv);
    expect(verifyInitHdr({ ...f, usedOpkId: '' }, sig, ikEd.pub)).toBe(true);
  });
});

// ── Tie-Break (D4, pure) ───────────────────────────────
describe('Tie-Break (D4)', () => {
  it('compareBytes lexikografisch', () => {
    expect(compareBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(-1);
    expect(compareBytes(new Uint8Array([2]), new Uint8Array([1, 9]))).toBe(1);
    expect(compareBytes(new Uint8Array([1]), new Uint8Array([1]))).toBe(0);
  });
  it('niedrigerer IK gewinnt', () => {
    expect(myInitWins(new Uint8Array([1]), new Uint8Array([2]))).toBe(true);
    expect(myInitWins(new Uint8Array([9]), new Uint8Array([2]))).toBe(false);
  });
});

// ── Initiator ──────────────────────────────────────────
describe('ensureHybridSession (Initiator)', () => {
  it('leitet dasselbe RK0 ab wie der Responder (mit OPK) + wohlgeformter InitHdr', async () => {
    const bob = makeBobWire('bobdeviceA1', { withOpk: true });
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: bob.wire });

    const rec = await ensureHybridSession('bob', 'bobdeviceA1');
    expect(rec.role).toBe('initiator');
    expect(rec.algoVersion).toBe(3);
    expect(rec.rootKey.length).toBe(32);
    expect(rec.initHdr.usedSpkId).toBe('s1');
    expect(rec.initHdr.usedOpkId).toBe('o1');
    expect(rec.initHdr.usedPqspkId).toBe('p1');

    // hdrSig verifiziert gegen das mitgelieferte ikAEd.
    const ok = verifyInitHdr({
      v: 3, alg: ALG,
      ikA25519: b64ToBytes(rec.initHdr.ikA25519), ekA25519: b64ToBytes(rec.initHdr.ekA25519),
      usedSpkId: rec.initHdr.usedSpkId, usedOpkId: rec.initHdr.usedOpkId, usedPqspkId: rec.initHdr.usedPqspkId,
      mlkemCt: b64ToBytes(rec.initHdr.mlkemCt),
    }, b64ToBytes(rec.initHdr.hdrSig), b64ToBytes(rec.initHdr.ikAEd));
    expect(ok).toBe(true);

    // Bob leitet aus dem InitHdr dasselbe RK0 ab.
    const rk0Bob = responderRoot({
      ikBPriv: bob.ikX.priv, spkBPriv: bob.spk.priv, opkBPriv: bob.opk.priv, pqspkDk: bob.pq.dk,
      ikAX: b64ToBytes(rec.initHdr.ikA25519), ekAX: b64ToBytes(rec.initHdr.ekA25519),
      kemCt: b64ToBytes(rec.initHdr.mlkemCt), usedOpk: true,
    });
    expect(eq(rec.rootKey, rk0Bob)).toBe(true);
  });

  it('SPK-only (opk=null) → RK0 stimmt trotzdem überein', async () => {
    const bob = makeBobWire('bobdeviceA2', { withOpk: false });
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: bob.wire });

    const rec = await ensureHybridSession('bob', 'bobdeviceA2');
    expect(rec.initHdr.usedOpkId).toBe(null);
    const rk0Bob = responderRoot({
      ikBPriv: bob.ikX.priv, spkBPriv: bob.spk.priv, opkBPriv: null, pqspkDk: bob.pq.dk,
      ikAX: b64ToBytes(rec.initHdr.ikA25519), ekAX: b64ToBytes(rec.initHdr.ekA25519),
      kemCt: b64ToBytes(rec.initHdr.mlkemCt), usedOpk: false,
    });
    expect(eq(rec.rootKey, rk0Bob)).toBe(true);
  });

  it('idempotent: zweiter Aufruf fetcht NICHT erneut (kein doppelter OPK-Verbrauch)', async () => {
    const bob = makeBobWire('bobdeviceA3');
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: bob.wire });
    const r1 = await ensureHybridSession('bob', 'bobdeviceA3');
    const r2 = await ensureHybridSession('bob', 'bobdeviceA3');
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(eq(r1.rootKey, r2.rootKey)).toBe(true);
  });

  it('single-flight: nebenläufige Aufrufe teilen einen Fetch', async () => {
    const bob = makeBobWire('bobdeviceA4');
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: bob.wire });
    const [a, b] = await Promise.all([
      ensureHybridSession('bob', 'bobdeviceA4'),
      ensureHybridSession('bob', 'bobdeviceA4'),
    ]);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(eq(a.rootKey, b.rootKey)).toBe(true);
  });

  it('Bundle-Fetch fehlgeschlagen → wirft', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 404, error: 'not_found', data: null });
    await expect(ensureHybridSession('bob', 'bobdeviceA5')).rejects.toThrow(/bundle fetch failed/);
  });
});

// ── Responder ──────────────────────────────────────────
describe('acceptHybridSession (Responder)', () => {
  // Baut einen gültigen InitHdr von ad-hoc-Alice gegen UNSER (lokales) Bundle.
  async function aliceInitAgainstLocal(opkIndex) {
    const pub = await buildPublishBundle({ opkCount: 3 });
    const usedOpk = pub.opks[opkIndex];
    const bobWire = { ik: pub.ik, spk: pub.spk, pqspk: pub.pqspk, opk: usedOpk };
    const aIkX = x25519Keygen(), aEk = x25519Keygen(), aIkEd = ed25519Keygen();
    const { rk0, kemCt } = initiatorRoot({
      ikAPriv: aIkX.priv, ekAPriv: aEk.priv, bundle: decodeInitiatorBundle(bobWire),
    });
    const sigFields = {
      v: 3, alg: ALG, ikA25519: aIkX.pub, ekA25519: aEk.pub,
      usedSpkId: pub.spk.spkId, usedOpkId: usedOpk.opkId, usedPqspkId: pub.pqspk.pqspkId, mlkemCt: kemCt,
    };
    const initHdr = {
      v: 3, alg: ALG,
      ikA25519: bytesToB64(aIkX.pub), ikAEd: bytesToB64(aIkEd.pub), ekA25519: bytesToB64(aEk.pub),
      usedSpkId: pub.spk.spkId, usedOpkId: usedOpk.opkId, usedPqspkId: pub.pqspk.pqspkId,
      mlkemCt: bytesToB64(kemCt), hdrSig: bytesToB64(signInitHdr(sigFields, aIkEd.priv)),
    };
    return { rk0, initHdr };
  }

  it('konsumiert OPK + leitet dasselbe RK0 ab wie der Initiator', async () => {
    const { rk0, initHdr } = await aliceInitAgainstLocal(0);
    const rec = await acceptHybridSession('alice', 'alicedevB1', initHdr);
    expect(rec.role).toBe('responder');
    expect(rec.hdrSigOk).toBe(true);
    expect(eq(rec.rootKey, rk0)).toBe(true);
  });

  it('ungültige hdrSig: enforce=false → verify+log (hdrSigOk false, kein Throw), RK0 stimmt', async () => {
    const { rk0, initHdr } = await aliceInitAgainstLocal(1);
    initHdr.hdrSig = bytesToB64(new Uint8Array(64));   // kaputte Sig, Felder intakt
    const rec = await acceptHybridSession('alice', 'alicedevB2', initHdr);
    expect(rec.hdrSigOk).toBe(false);
    expect(eq(rec.rootKey, rk0)).toBe(true);   // Felder unangetastet → RK0 korrekt
  });

  it('ungültige hdrSig: enforce=true → wirft (vor OPK-Consume)', async () => {
    const { initHdr } = await aliceInitAgainstLocal(2);
    initHdr.hdrSig = bytesToB64(new Uint8Array(64));
    await expect(acceptHybridSession('alice', 'alicedevB3', initHdr, { enforce: true }))
      .rejects.toThrow(/sig invalid/);
  });

  it('falsche Version/alg → wirft', async () => {
    await expect(acceptHybridSession('alice', 'alicedevB4', { v: 1, alg: 'legacy' }))
      .rejects.toThrow(/bad initHdr/);
  });
});
