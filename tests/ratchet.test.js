// ======================================================
// Unit-Tests: ratchet.js — Double-Ratchet-Kern (P3.0, §4.4)
// ======================================================
// Kern-Garantie: Sender-MK (nextSendKey) == Empfänger-MK (deriveReceiveKey)
// über sequenzielle Ketten, Ping-Pong-DH-Steps, Out-of-Order (auch über
// DH-Steps hinweg), Serialize-Round-Trip mitten in der Konversation und
// einen 1000+-Nachrichten-Marathon (§4.4 P3.0: „muss matchen").
// ======================================================
import { describe, it, expect } from 'vitest';
import { x25519Keygen } from '../frontend/src/lib/pqCrypto.js';
import {
  kdfRootKey, kdfChainKey, fingerprintMk,
  initInitiator, initResponder,
  nextSendKey, deriveReceiveKey,
  encodeRatchetHeader, decodeRatchetHeader,
  serializeRatchetState, deserializeRatchetState,
  MAX_SKIP,
} from '../frontend/src/lib/ratchet.js';

const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const rk0 = () => new Uint8Array(32).fill(7);

// Frisches A/B-Paar mit geteiltem RK0 + SPK-Konvention.
function makePair() {
  const rk = crypto.getRandomValues(new Uint8Array(32));
  const spk = x25519Keygen();
  const alice = initInitiator(rk, spk.pub);
  const bob = initResponder(new Uint8Array(rk), spk);
  return { alice, bob };
}
// Header über den Wire-Codec schicken (wie im echten Pfad).
const viaWire = (header) => decodeRatchetHeader(encodeRatchetHeader(header));

describe('KDFs (fixiert §4.4)', () => {
  it('kdfRootKey deterministisch, 2×32B, RK≠CK', () => {
    const a = kdfRootKey(rk0(), new Uint8Array(32).fill(1));
    const b = kdfRootKey(rk0(), new Uint8Array(32).fill(1));
    expect(eq(a.rk, b.rk)).toBe(true);
    expect(eq(a.ck, b.ck)).toBe(true);
    expect(a.rk.length).toBe(32);
    expect(eq(a.rk, a.ck)).toBe(false);
  });
  it('kdfChainKey: MK=HMAC(CK,0x01) ≠ CK\'=HMAC(CK,0x02), Kette schreitet fort', () => {
    const s1 = kdfChainKey(rk0());
    const s2 = kdfChainKey(s1.ck);
    expect(eq(s1.mk, s1.ck)).toBe(false);
    expect(eq(s1.mk, s2.mk)).toBe(false);
  });
  it('fingerprintMk: 8B, deterministisch, one-way-domain', () => {
    const mk = rk0();
    expect(fingerprintMk(mk).length).toBe(8);
    expect(eq(fingerprintMk(mk), fingerprintMk(new Uint8Array(32).fill(7)))).toBe(true);
  });
});

describe('Header-Codec', () => {
  it('Round-Trip {v:4, dh, pn, n, kemEpoch}', () => {
    const dh = x25519Keygen().pub;
    const h = viaWire({ dh, pn: 3, n: 17, kemEpoch: 0 });
    expect(h.v).toBe(4);
    expect(eq(h.dh, dh)).toBe(true);
    expect(h.pn).toBe(3);
    expect(h.n).toBe(17);
  });
  it('kaputte Header werfen', () => {
    expect(() => decodeRatchetHeader('not-base64!!!')).toThrow();
    const bad = Buffer.from(JSON.stringify({ v: 3, dh: 'x', pn: 0, n: 0 })).toString('base64');
    expect(() => decodeRatchetHeader(bad)).toThrow('ratchet_header_invalid');
  });
});

describe('Sequenzielle Kette A→B', () => {
  it('5 Nachrichten in Reihe: MKs matchen', () => {
    const { alice, bob } = makePair();
    for (let i = 0; i < 5; i++) {
      const { mk, header } = nextSendKey(alice);
      const mkB = deriveReceiveKey(bob, viaWire(header));
      expect(eq(mk, mkB)).toBe(true);
      expect(header.n).toBe(i);
    }
  });
  it('Responder kann nicht senden, bevor er empfangen hat', () => {
    const { bob } = makePair();
    expect(() => nextSendKey(bob)).toThrow('ratchet_no_send_chain');
  });
});

describe('Ping-Pong (DH-Ratchet-Steps)', () => {
  it('A→B, B→A, A→B … über 6 Runden: alle MKs matchen, RK wandert', () => {
    const { alice, bob } = makePair();
    const rkStart = Buffer.from(alice.rk).toString('hex');
    let sender = alice, receiver = bob;
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 3; i++) {
        const { mk, header } = nextSendKey(sender);
        expect(eq(mk, deriveReceiveKey(receiver, viaWire(header)))).toBe(true);
      }
      [sender, receiver] = [receiver, sender];   // Richtungswechsel → DH-Step
    }
    expect(Buffer.from(alice.rk).toString('hex')).not.toBe(rkStart);  // Root ratchte weiter
  });
});

describe('Out-of-Order (Skipped-Keys)', () => {
  it('innerhalb einer Kette: 0,2,1,4,3 → alle matchen, skipped konsumiert (one-time)', () => {
    const { alice, bob } = makePair();
    const sent = Array.from({ length: 5 }, () => nextSendKey(alice));
    const order = [0, 2, 1, 4, 3];
    for (const i of order) {
      expect(eq(sent[i].mk, deriveReceiveKey(bob, viaWire(sent[i].header)))).toBe(true);
    }
    expect(Object.keys(bob.skipped).length).toBe(0);
    // one-time: dieselbe Nachricht nochmal → kein cached Key mehr → falscher MK oder Fehler
    let replayOk = false;
    try { replayOk = eq(sent[1].mk, deriveReceiveKey(bob, viaWire(sent[1].header))); } catch { /* erwartbar */ }
    expect(replayOk).toBe(false);
  });

  it('über DH-Step hinweg: alte Kette via pn nachziehbar', () => {
    const { alice, bob } = makePair();
    const a1 = nextSendKey(alice);           // Kette 1, n=0
    const a2 = nextSendKey(alice);           // Kette 1, n=1  (kommt SPÄT an)
    expect(eq(a1.mk, deriveReceiveKey(bob, viaWire(a1.header)))).toBe(true);
    const b1 = nextSendKey(bob);             // Antwort → Alice macht DH-Step
    expect(eq(b1.mk, deriveReceiveKey(alice, viaWire(b1.header)))).toBe(true);
    const a3 = nextSendKey(alice);           // Kette 2 (neuer dh), pn=2, n=0
    expect(a3.header.pn).toBe(2);
    // Bob empfängt Kette-2-Msg VOR der verspäteten Kette-1-Msg:
    expect(eq(a3.mk, deriveReceiveKey(bob, viaWire(a3.header)))).toBe(true);
    // … und die verspätete alte kommt aus dem Skipped-Store:
    expect(eq(a2.mk, deriveReceiveKey(bob, viaWire(a2.header)))).toBe(true);
  });

  it('MAX_SKIP-Schutz wirft ratchet_skip_limit', () => {
    const { alice, bob } = makePair();
    for (let i = 0; i < MAX_SKIP + 1; i++) nextSendKey(alice);
    const far = nextSendKey(alice);          // n = MAX_SKIP+1
    expect(() => deriveReceiveKey(bob, viaWire(far.header))).toThrow('ratchet_skip_limit');
  });
});

describe('Serialisierung', () => {
  it('Round-Trip mitten in der Konversation → weiter matchend', () => {
    let { alice, bob } = makePair();
    for (let i = 0; i < 3; i++) {
      const { mk, header } = nextSendKey(alice);
      expect(eq(mk, deriveReceiveKey(bob, viaWire(header)))).toBe(true);
    }
    // Bob „neu laden" (IDB-Zyklus simuliert)
    bob = deserializeRatchetState(JSON.parse(JSON.stringify(serializeRatchetState(bob))));
    const b1 = nextSendKey(bob);
    expect(eq(b1.mk, deriveReceiveKey(alice, viaWire(b1.header)))).toBe(true);
    const a1 = nextSendKey(alice);
    expect(eq(a1.mk, deriveReceiveKey(bob, viaWire(a1.header)))).toBe(true);
  });
});

describe('Marathon: ≥1000 Nachrichten, zufälliges Ping-Pong + Out-of-Order', () => {
  it('1200 Nachrichten, seeded random: 100% MK-Match', () => {
    const { alice, bob } = makePair();
    // deterministisches LCG (kein Math.random → reproduzierbar)
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    let matches = 0;
    const TOTAL = 1200;
    let sent = 0;
    let dir = 'a2b';
    const pending = [];                      // in-flight (out-of-order Fenster)
    const party = { a2b: [() => alice, () => bob], b2a: [() => bob, () => alice] };

    while (matches < TOTAL) {
      const canSend = sent < TOTAL && (dir === 'a2b' || bob.cks);
      if (canSend && (pending.length === 0 || rnd() < 0.7)) {
        const s = party[dir][0]();
        const { mk, header } = nextSendKey(s);
        pending.push({ mk, header, dir });
        sent++;
        if (rnd() < 0.25) dir = dir === 'a2b' ? 'b2a' : 'a2b';   // Richtungswechsel
      } else if (pending.length) {
        // zufällige der wartenden zustellen — aber nur innerhalb derselben
        // Richtung out-of-order (Kanal pro Richtung ist quasi-FIFO mit Jitter)
        const idx = Math.min(pending.length - 1, Math.floor(rnd() * 3));
        // nimm die idx-te Nachricht DERSELBEN Richtung wie die älteste
        const d0 = pending[0].dir;
        const cand = pending.filter(p => p.dir === d0);
        const pick = cand[Math.min(cand.length - 1, idx)];
        pending.splice(pending.indexOf(pick), 1);
        const r = pick.dir === 'a2b' ? bob : alice;
        const mkR = deriveReceiveKey(r, viaWire(pick.header));
        if (eq(pick.mk, mkR)) matches++;
        else throw new Error(`MK-Mismatch bei Nachricht ${matches}`);
      }
    }
    expect(matches).toBe(TOTAL);
  }, 30_000);
});
