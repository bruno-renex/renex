// ======================================================
// Unit-Tests: ratchetShadow.js — P3.0 decrypt-only Dark-Launch
// ======================================================
// End-to-end durch die ECHTEN Module (api/sesame/sentry gemockt):
//  A) lokale Partei = Initiator: shadowOnSend baut Handshake+Shadow-Feld,
//     ad-hoc-Bob folgt pure (responderRoot+initResponder) → fp-Match; nach
//     Bobs Antwort (shadowOnReceive) verschwindet init aus dem Wire.
//  B) lokale Partei = Responder: ad-hoc-Alice initiiert gegen unser Bundle;
//     shadowOnReceive accept'et EINMAL (kein doppelter OPK-Consume), matcht,
//     und shadowOnSend antwortet über dieselbe Session.
//  Dazu: Pulse-Ausschluss, Kill-Switch, tgt-Filter, Mismatch-Telemetrie.
// ======================================================
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../frontend/src/lib/api.js', () => ({ apiFetch: vi.fn() }));
vi.mock('../frontend/src/lib/sesame.js', () => ({ getRecipientDevices: vi.fn() }));
vi.mock('../frontend/src/lib/sentry.js', () => ({ captureException: vi.fn() }));

import { apiFetch } from '../frontend/src/lib/api.js';
import { getRecipientDevices } from '../frontend/src/lib/sesame.js';
import { captureException } from '../frontend/src/lib/sentry.js';
import { bytesToB64, b64ToBytes } from '../frontend/src/lib/bytes.js';
import { x25519Keygen, ed25519Keygen, mlKemKeygen } from '../frontend/src/lib/pqCrypto.js';
import { initiatorRoot, responderRoot, signPrekey, signInitHdr } from '../frontend/src/lib/pqxdh.js';
import { buildPublishBundle, decodeInitiatorBundle } from '../frontend/src/lib/pqxdhKeys.js';
import {
  initInitiator, initResponder, nextSendKey, deriveReceiveKey,
  decodeRatchetHeader, encodeRatchetHeader, fingerprintMk,
} from '../frontend/src/lib/ratchet.js';
import { shadowOnSend, shadowOnReceive, shadowStats } from '../frontend/src/lib/ratchetShadow.js';

const ALG = 'pqxdh-x25519-mlkem768';
const MYDEV = 'dev_local_test_1';
const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));

// localStorage-Stub (Node hat keins) — Kill-Switch + Stats.
const _ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => { _ls.set(k, String(v)); },
  removeItem: (k) => { _ls.delete(k); },
};

// Ad-hoc-„Bob" (Ziel-Device) inkl. single-opk-Bundle-Wire (Muster hybridSession.test).
function makeBobWire(deviceId) {
  const ikEd = ed25519Keygen(), ikX = x25519Keygen(), spk = x25519Keygen(), pq = mlKemKeygen(), opk = x25519Keygen();
  const wire = {
    deviceId,
    ik: { ikX: bytesToB64(ikX.pub), ikEd: bytesToB64(ikEd.pub) },
    spk: { spkId: 's1', spk: bytesToB64(spk.pub), sig: bytesToB64(signPrekey('spk', spk.pub, ikEd.priv)) },
    pqspk: { pqspkId: 'p1', ek: bytesToB64(pq.ek), sig: bytesToB64(signPrekey('pqspk', pq.ek, ikEd.priv)) },
    opk: { opkId: 'o1', opk: bytesToB64(opk.pub) },
  };
  return { ikEd, ikX, spk, pq, opk, wire };
}

beforeEach(() => { vi.clearAllMocks(); _ls.delete('renex_ratchet_shadow'); });

describe('Ausschlüsse', () => {
  it('Pulse/Control-Type → null (Rekey-Storm-Guard)', async () => {
    expect(await shadowOnSend('bob', { type: 'pulse' })).toBe(null);
    expect(await shadowOnSend('bob', { type: 'gsk' })).toBe(null);
    expect(getRecipientDevices).not.toHaveBeenCalled();
  });
  it('Kill-Switch renex_ratchet_shadow=0 → null/skip', async () => {
    _ls.set('renex_ratchet_shadow', '0');
    expect(await shadowOnSend('bob')).toBe(null);
    expect(await shadowOnReceive('bob', 'd1', { v: 4, header: 'x', fp: 'y' }, MYDEV)).toBe('skip');
  });
  it('kein pq-fähiges Peer-Device → null (skip)', async () => {
    getRecipientDevices.mockResolvedValue([{ deviceId: 'legacy1', hasKem: false, caps: null }]);
    expect(await shadowOnSend('nopq')).toBe(null);
  });
  it('tgt ≠ eigenes Device → skip (still, kein State)', async () => {
    const r = await shadowOnReceive('bob', 'd1', { v: 4, tgt: 'other_device', header: 'x', fp: 'y' }, MYDEV);
    expect(r).toBe('skip');
  });
});

describe('A) Lokale Partei = Initiator', () => {
  const bob = makeBobWire('bobdevA');

  it('shadowOnSend: Handshake + Shadow-Feld; ad-hoc-Bob matcht die fp über 3 Nachrichten', async () => {
    getRecipientDevices.mockResolvedValue([{ deviceId: 'bobdevA', hasKem: true, caps: { hybrid: true } }]);
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: bob.wire });

    const s1 = await shadowOnSend('bobinit');
    expect(s1).not.toBe(null);
    expect(s1.v).toBe(4);
    expect(s1.tgt).toBe('bobdevA');
    expect(s1.init).toBeTruthy();                 // InitHdr reist mit (noch keine Antwort)

    // Bob folgt pure: responderRoot aus dem InitHdr → initResponder.
    const rk0B = responderRoot({
      ikBPriv: bob.ikX.priv, spkBPriv: bob.spk.priv, opkBPriv: bob.opk.priv, pqspkDk: bob.pq.dk,
      ikAX: b64ToBytes(s1.init.ikA25519), ekAX: b64ToBytes(s1.init.ekA25519),
      kemCt: b64ToBytes(s1.init.mlkemCt), usedOpk: !!s1.init.usedOpkId,
    });
    const bobState = initResponder(rk0B, { priv: bob.spk.priv, pub: bob.spk.pub });

    for (const s of [s1, await shadowOnSend('bobinit'), await shadowOnSend('bobinit')]) {
      const mk = deriveReceiveKey(bobState, decodeRatchetHeader(s.header));
      expect(bytesToB64(fingerprintMk(mk))).toBe(s.fp);
    }

    // Bob antwortet → Initiator-Seite empfängt → peerSeen → init verschwindet.
    const { mk: mkB, header: hB } = nextSendKey(bobState);
    const shadowB = { v: 4, tgt: MYDEV, header: encodeRatchetHeader(hB), fp: bytesToB64(fingerprintMk(mkB)) };
    expect(await shadowOnReceive('bobinit', 'bobdevA', shadowB, MYDEV)).toBe('match');

    const s4 = await shadowOnSend('bobinit');
    expect(s4.init).toBeUndefined();              // Antwort gesehen → kein init mehr
    // Bob kann auch die Post-DH-Step-Nachricht folgen:
    const mk4 = deriveReceiveKey(bobState, decodeRatchetHeader(s4.header));
    expect(bytesToB64(fingerprintMk(mk4))).toBe(s4.fp);
    expect(apiFetch).toHaveBeenCalledTimes(1);    // genau EIN Bundle-Fetch (Session wiederverwendet)
  });
});

describe('B) Lokale Partei = Responder', () => {
  // Ad-hoc-Alice initiiert gegen UNSER publiziertes Bundle + führt ihren Ratchet pure.
  async function makeAlice(peerDev) {
    const pub = await buildPublishBundle({ opkCount: 3 });
    const usedOpk = pub.opks[0];
    const aIkX = x25519Keygen(), aEk = x25519Keygen(), aIkEd = ed25519Keygen();
    const { rk0, kemCt } = initiatorRoot({
      ikAPriv: aIkX.priv, ekAPriv: aEk.priv,
      bundle: decodeInitiatorBundle({ ik: pub.ik, spk: pub.spk, pqspk: pub.pqspk, opk: usedOpk }),
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
    const state = initInitiator(rk0, b64ToBytes(pub.spk.spk));
    return { state, initHdr, peerDev };
  }
  const aliceShadow = (alice, withInit) => {
    const { mk, header } = nextSendKey(alice.state);
    return {
      v: 4, tgt: MYDEV, header: encodeRatchetHeader(header), fp: bytesToB64(fingerprintMk(mk)),
      ...(withInit ? { init: alice.initHdr } : {}),
    };
  };

  it('accept genau EINMAL (kein doppelter OPK-Consume), matcht, antwortet über dieselbe Session', async () => {
    const alice = await makeAlice('alicedevB');
    // Msg 1+2 tragen beide init (Alice sah noch keine Antwort) → 2. accept wird übersprungen.
    expect(await shadowOnReceive('aliceb', 'alicedevB', aliceShadow(alice, true), MYDEV)).toBe('match');
    expect(await shadowOnReceive('aliceb', 'alicedevB', aliceShadow(alice, true), MYDEV)).toBe('match');

    // Unsere Antwort: nutzt die EXISTIERENDE Responder-Session (kein sesame/ensure).
    const s = await shadowOnSend('aliceb');
    expect(s).not.toBe(null);
    expect(s.tgt).toBe('alicedevB');
    expect(getRecipientDevices).not.toHaveBeenCalled();
    const mk = deriveReceiveKey(alice.state, decodeRatchetHeader(s.header));
    expect(bytesToB64(fingerprintMk(mk))).toBe(s.fp);
  });

  it('ohne init und ohne State → skip (Init verpasst, kein Crash)', async () => {
    const alice = await makeAlice('alicedevC');
    expect(await shadowOnReceive('alicec', 'alicedevC', aliceShadow(alice, false), MYDEV)).toBe('skip');
  });

  it('kaputte fp → mismatch + Sentry (Muster logWrapVerify invalid)', async () => {
    const alice = await makeAlice('alicedevD');
    const s = aliceShadow(alice, true);
    s.fp = bytesToB64(new Uint8Array(8));
    const before = shadowStats().mismatch;
    expect(await shadowOnReceive('aliced', 'alicedevD', s, MYDEV)).toBe('mismatch');
    expect(shadowStats().mismatch).toBe(before + 1);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ context: 'ratchetShadow' }));
  });
});
