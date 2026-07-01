// ======================================================
// Unit-Tests: PQXDH hybrider Handshake-Root (M2)
// ======================================================
// Kern-Garantie: Initiator und Responder leiten aus X3DH-DHs + ML-KEM DASSELBE
// RK0 ab (mit + ohne One-Time-Prekey). Prekey-Signaturen werden erzwungen;
// Tampering an kemCt/Identität bricht die Übereinstimmung.
// ======================================================
import { describe, it, expect } from 'vitest';
import {
  x25519Keygen, ed25519Keygen, mlKemKeygen,
} from '../frontend/src/lib/pqCrypto.js';
import {
  initiatorRoot, responderRoot, signPrekey, verifyPrekey,
} from '../frontend/src/lib/pqxdh.js';

const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));

// Baut Bobs Prekey-Bundle + Privs (mit/ohne OPK).
function makeBob({ withOpk = true } = {}) {
  const ikEd = ed25519Keygen();   // Identitäts-Sig-Key
  const ikX = x25519Keygen();     // Identitäts-DH-Key
  const spk = x25519Keygen();
  const pqspk = mlKemKeygen();
  const opk = withOpk ? x25519Keygen() : null;
  const bundle = {
    ikEdPub: ikEd.pub,
    ikX: ikX.pub,
    spkX: spk.pub,
    spkSig: signPrekey('spk', spk.pub, ikEd.priv),
    ...(opk ? { opkX: opk.pub } : {}),
    pqspkEk: pqspk.ek,
    pqspkSig: signPrekey('pqspk', pqspk.ek, ikEd.priv),
  };
  return { ikEd, ikX, spk, pqspk, opk, bundle };
}
function makeAlice() {
  return { ikA: x25519Keygen(), ekA: x25519Keygen() };
}

describe('PQXDH Root: Initiator ↔ Responder Übereinstimmung', () => {
  it('mit One-Time-Prekey (DH4): beide leiten dasselbe RK0 ab', () => {
    const bob = makeBob({ withOpk: true });
    const { ikA, ekA } = makeAlice();

    const a = initiatorRoot({ ikAPriv: ikA.priv, ekAPriv: ekA.priv, bundle: bob.bundle });
    expect(a.rk0.length).toBe(32);
    expect(a.usedOpk).toBe(true);

    const b = responderRoot({
      ikBPriv: bob.ikX.priv, spkBPriv: bob.spk.priv, opkBPriv: bob.opk.priv,
      pqspkDk: bob.pqspk.dk, ikAX: ikA.pub, ekAX: ekA.pub, kemCt: a.kemCt, usedOpk: a.usedOpk,
    });
    expect(eq(a.rk0, b)).toBe(true);
  });

  it('OHNE One-Time-Prekey (SPK-only): beide leiten dasselbe RK0 ab', () => {
    const bob = makeBob({ withOpk: false });
    const { ikA, ekA } = makeAlice();

    const a = initiatorRoot({ ikAPriv: ikA.priv, ekAPriv: ekA.priv, bundle: bob.bundle });
    expect(a.usedOpk).toBe(false);

    const b = responderRoot({
      ikBPriv: bob.ikX.priv, spkBPriv: bob.spk.priv, opkBPriv: null,
      pqspkDk: bob.pqspk.dk, ikAX: ikA.pub, ekAX: ekA.pub, kemCt: a.kemCt, usedOpk: false,
    });
    expect(eq(a.rk0, b)).toBe(true);
  });

  it('verschiedene Handshakes → verschiedene RK0 (frische Ephemerals/KEM)', () => {
    const bob = makeBob();
    const a1 = initiatorRoot({ ...alice(), bundle: bob.bundle });
    const a2 = initiatorRoot({ ...alice(), bundle: bob.bundle });
    expect(eq(a1.rk0, a2.rk0)).toBe(false);
    function alice() { const { ikA, ekA } = makeAlice(); return { ikAPriv: ikA.priv, ekAPriv: ekA.priv }; }
  });
});

describe('PQXDH Root: Sicherheit', () => {
  it('ungültige SPK-Signatur → wirft', () => {
    const bob = makeBob();
    bob.bundle.spkSig = new Uint8Array(64); // kaputt
    const { ikA, ekA } = makeAlice();
    expect(() => initiatorRoot({ ikAPriv: ikA.priv, ekAPriv: ekA.priv, bundle: bob.bundle })).toThrow('spk_sig_invalid');
  });

  it('ungültige PQSPK-Signatur → wirft', () => {
    const bob = makeBob();
    bob.bundle.pqspkSig = new Uint8Array(64);
    const { ikA, ekA } = makeAlice();
    expect(() => initiatorRoot({ ikAPriv: ikA.priv, ekAPriv: ekA.priv, bundle: bob.bundle })).toThrow('pqspk_sig_invalid');
  });

  it('manipulierter kemCt beim Responder → anderes RK0 (kein Match)', () => {
    const bob = makeBob();
    const { ikA, ekA } = makeAlice();
    const a = initiatorRoot({ ikAPriv: ikA.priv, ekAPriv: ekA.priv, bundle: bob.bundle });
    const badCt = new Uint8Array(a.kemCt); badCt[0] ^= 0xff;
    const b = responderRoot({
      ikBPriv: bob.ikX.priv, spkBPriv: bob.spk.priv, opkBPriv: bob.opk.priv,
      pqspkDk: bob.pqspk.dk, ikAX: ikA.pub, ekAX: ekA.pub, kemCt: badCt, usedOpk: true,
    });
    expect(eq(a.rk0, b)).toBe(false);
  });

  it('verifyPrekey: gültig true, falsches Label/Pub false', () => {
    const ikEd = ed25519Keygen();
    const spk = x25519Keygen();
    const sig = signPrekey('spk', spk.pub, ikEd.priv);
    expect(verifyPrekey('spk', spk.pub, sig, ikEd.pub)).toBe(true);
    expect(verifyPrekey('pqspk', spk.pub, sig, ikEd.pub)).toBe(false);   // Label-Mismatch
    const other = x25519Keygen();
    expect(verifyPrekey('spk', other.pub, sig, ikEd.pub)).toBe(false);   // anderer Pubkey
  });
});
