// ======================================================
// Unit-Tests: ratchetSession.js — REALE v4-Encrypt/Decrypt (P3.1)
// ======================================================
// Beweis, dass der Ratchet ECHTE Nachrichten verschlüsselt+entschlüsselt
// (nicht nur Fingerprints wie der Shadow): A verschlüsselt via ratchetEncrypt,
// B leitet denselben MK ab + entschlüsselt den AES-GCM-Ciphertext (AAD =
// header_b64) → Klartext identisch. Ping-Pong, Sig-Verify, Fehlerpfade.
// api/sesame/sentry gemockt; fake-indexeddb; Signing-Key in IDB (signMessageV4).
// ======================================================
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

vi.mock('../frontend/src/lib/api.js', () => ({ apiFetch: vi.fn() }));
vi.mock('../frontend/src/lib/sesame.js', () => ({ getRecipientDevices: vi.fn() }));
vi.mock('../frontend/src/lib/sentry.js', () => ({ captureException: vi.fn() }));

import { apiFetch } from '../frontend/src/lib/api.js';
import { getRecipientDevices } from '../frontend/src/lib/sesame.js';
import { idbSet } from '../frontend/src/lib/idb.js';
import { bytesToB64, b64ToBytes } from '../frontend/src/lib/bytes.js';
import { x25519Keygen, ed25519Keygen, mlKemKeygen } from '../frontend/src/lib/pqCrypto.js';
import { initiatorRoot, responderRoot, signPrekey, signInitHdr } from '../frontend/src/lib/pqxdh.js';
import { buildPublishBundle, decodeInitiatorBundle } from '../frontend/src/lib/pqxdhKeys.js';
import {
  initInitiator, initResponder, nextSendKey, deriveReceiveKey, decodeRatchetHeader, encodeRatchetHeader,
} from '../frontend/src/lib/ratchet.js';
import { e2eEncrypt, e2eDecrypt } from '../frontend/src/lib/chatCrypto.js';
import { verifyMessageSigV4 } from '../frontend/src/lib/messageSig.js';
import {
  ratchetEncrypt, ratchetDecrypt, primeRatchetSession, pqDeviceCount,
} from '../frontend/src/lib/ratchetSession.js';

const ALG = 'pqxdh-x25519-mlkem768';
const MYDEV = 'dev_local_1';
let sigPub;

const _ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => { _ls.set(k, String(v)); },
  removeItem: (k) => { _ls.delete(k); },
};

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  sigPub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  await idbSet('sig_keypair', { pub: sigPub, priv: await crypto.subtle.exportKey('jwk', pair.privateKey) });
});
beforeEach(() => { vi.clearAllMocks(); _ls.set('renex_ratchet_send', '1'); });   // Send-Flag AN für die Round-Trip-Tests

// AES-GCM-Decrypt mit rohem MK (Gegenseite im Test).
async function aesDecrypt(mk, ivB64, ctB64, aad) {
  const key = await crypto.subtle.importKey('raw', mk, { name: 'AES-GCM' }, false, ['decrypt']);
  return e2eDecrypt(key, ivB64, ctB64, aad);
}
async function aesEncrypt(mk, text, aad) {
  const key = await crypto.subtle.importKey('raw', mk, { name: 'AES-GCM' }, false, ['encrypt']);
  return e2eEncrypt(key, text, aad);
}

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

describe('A) Lokale Partei = Sender (Initiator)', () => {
  it('ratchetEncrypt → ad-hoc-Bob leitet MK ab + entschlüsselt echten Klartext; Sig verifiziert', async () => {
    const bob = makeBobWire('bobA');
    getRecipientDevices.mockResolvedValue([{ deviceId: 'bobA', hasKem: true, caps: { hybrid: true } }]);
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: bob.wire });

    expect(await ratchetEncrypt('bobr', 'x')).toBe(null);        // erste Nachricht: Session baut sich auf → Legacy
    await primeRatchetSession('bobr');

    const m1 = await ratchetEncrypt('bobr', 'geheime nachricht 🔐');
    expect(m1.v).toBe(4);
    expect(m1.init).toBeTruthy();
    expect(typeof m1.ctB64).toBe('string');

    // Sig deckt den Header ab.
    expect(await verifyMessageSigV4(m1.header_b64, m1.ivB64, m1.ctB64, m1.sig, sigPub)).toBe(true);

    // Bob (pure) folgt: responderRoot → initResponder → deriveReceiveKey → AES-Decrypt.
    const rk0 = responderRoot({
      ikBPriv: bob.ikX.priv, spkBPriv: bob.spk.priv, opkBPriv: bob.opk.priv, pqspkDk: bob.pq.dk,
      ikAX: b64ToBytes(m1.init.ikA25519), ekAX: b64ToBytes(m1.init.ekA25519),
      kemCt: b64ToBytes(m1.init.mlkemCt), usedOpk: !!m1.init.usedOpkId,
    });
    const bobState = initResponder(rk0, { priv: bob.spk.priv, pub: bob.spk.pub });
    const mk1 = deriveReceiveKey(bobState, decodeRatchetHeader(m1.header_b64));
    expect(await aesDecrypt(mk1, m1.ivB64, m1.ctB64, m1.header_b64)).toBe('geheime nachricht 🔐');

    // Zweite Nachricht (Kette schreitet fort).
    const m2 = await ratchetEncrypt('bobr', 'zweite');
    const mk2 = deriveReceiveKey(bobState, decodeRatchetHeader(m2.header_b64));
    expect(await aesDecrypt(mk2, m2.ivB64, m2.ctB64, m2.header_b64)).toBe('zweite');
    expect(apiFetch).toHaveBeenCalledTimes(1);                   // ein Handshake, Session wiederverwendet
  });

  it('falsche AAD (manipulierter Header) → Decrypt schlägt fehl (Tag-Mismatch)', async () => {
    const bob = makeBobWire('bobA2');
    getRecipientDevices.mockResolvedValue([{ deviceId: 'bobA2', hasKem: true, caps: { hybrid: true } }]);
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: bob.wire });
    await primeRatchetSession('bobr2');
    const m = await ratchetEncrypt('bobr2', 'tamper-test');
    const rk0 = responderRoot({
      ikBPriv: bob.ikX.priv, spkBPriv: bob.spk.priv, opkBPriv: bob.opk.priv, pqspkDk: bob.pq.dk,
      ikAX: b64ToBytes(m.init.ikA25519), ekAX: b64ToBytes(m.init.ekA25519),
      kemCt: b64ToBytes(m.init.mlkemCt), usedOpk: true,
    });
    const bobState = initResponder(rk0, { priv: bob.spk.priv, pub: bob.spk.pub });
    const mk = deriveReceiveKey(bobState, decodeRatchetHeader(m.header_b64));
    const wrongAad = encodeRatchetHeader({ dh: b64ToBytes(m.init.ekA25519), pn: 0, n: 99 });
    await expect(aesDecrypt(mk, m.ivB64, m.ctB64, wrongAad)).rejects.toBeTruthy();
  });
});

describe('B) Lokale Partei = Empfänger (Responder)', () => {
  async function aliceMakesV4(peerDev, text, withInit) {
    const pub = await buildPublishBundle({ opkCount: 3 });
    const usedOpk = pub.opks[0];
    const aIkX = x25519Keygen(), aEk = x25519Keygen(), aIkEd = ed25519Keygen();
    const { rk0, kemCt } = initiatorRoot({
      ikAPriv: aIkX.priv, ekAPriv: aEk.priv,
      bundle: decodeInitiatorBundle({ ik: pub.ik, spk: pub.spk, pqspk: pub.pqspk, opk: usedOpk }),
    });
    // Alice hält ihren Ratchet über Aufrufe hinweg → static Map je peerDev.
    aliceMakesV4._st ||= {};
    if (!aliceMakesV4._st[peerDev]) aliceMakesV4._st[peerDev] = initInitiator(rk0, b64ToBytes(pub.spk.spk));
    const st = aliceMakesV4._st[peerDev];
    const { mk, header } = nextSendKey(st);
    const header_b64 = encodeRatchetHeader(header);
    const { ivB64, ctB64 } = await aesEncrypt(mk, text, header_b64);
    const initHdr = withInit ? {
      v: 3, alg: ALG,
      ikA25519: bytesToB64(aIkX.pub), ikAEd: bytesToB64(aIkEd.pub), ekA25519: bytesToB64(aEk.pub),
      usedSpkId: pub.spk.spkId, usedOpkId: usedOpk.opkId, usedPqspkId: pub.pqspk.pqspkId,
      mlkemCt: bytesToB64(kemCt),
      hdrSig: bytesToB64(signInitHdr({
        v: 3, alg: ALG, ikA25519: aIkX.pub, ekA25519: aEk.pub,
        usedSpkId: pub.spk.spkId, usedOpkId: usedOpk.opkId, usedPqspkId: pub.pqspk.pqspkId, mlkemCt: kemCt,
      }, aIkEd.priv)),
    } : undefined;
    return { v: 4, header_b64, ivB64, ctB64, ...(initHdr ? { init: initHdr } : {}) };
  }

  it('ratchetDecrypt: init-Nachricht → accept + echter Klartext; danach Antwort v4', async () => {
    const m1 = await aliceMakesV4('adevB', 'hallo responder', true);
    const r1 = await ratchetDecrypt('aliceb', 'adevB', m1, null);
    expect(r1).not.toBe(null);
    expect(r1.text).toBe('hallo responder');
    expect(r1.verified).toBe(null);                              // kein sigPub übergeben

    // Der Responder kann jetzt zurücksenden (v4, dieselbe Session, kein Netz).
    getRecipientDevices.mockResolvedValue([]);                   // darf nicht gebraucht werden
    const back = await ratchetEncrypt('aliceb', 'antwort');
    expect(back?.v).toBe(4);
    expect(back.init).toBeUndefined();                           // Responder sendet nie init
  });

  it('v4 ohne Session und ohne init → null (retry/locked, kein Crash)', async () => {
    const m = await aliceMakesV4('adevC', 'x', false);
    expect(await ratchetDecrypt('alicec', 'adevC', m, null)).toBe(null);
  });

  it('kaputte Felder → null', async () => {
    expect(await ratchetDecrypt('x', 'y', { header_b64: 'z' }, null)).toBe(null);
    expect(await ratchetDecrypt('x', 'y', null, null)).toBe(null);
  });
});

describe('pqDeviceCount (single-device-Gate)', () => {
  it('zählt pq-fähige Peer-Devices', async () => {
    getRecipientDevices.mockResolvedValue([
      { deviceId: 'a', hasKem: true, caps: { hybrid: true } },
      { deviceId: 'b', hasKem: false, caps: null },
      { deviceId: 'c', hasKem: true, caps: { hybrid: true } },
    ]);
    expect(await pqDeviceCount('peer')).toBe(2);
  });
});

describe('Gates: Flag + single-device', () => {
  it('Flag AUS → ratchetEncrypt immer null (inert by default)', async () => {
    _ls.delete('renex_ratchet_send');
    getRecipientDevices.mockResolvedValue([{ deviceId: 'x', hasKem: true, caps: { hybrid: true } }]);
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: makeBobWire('x').wire });
    expect(await ratchetEncrypt('flagoff', 'hi')).toBe(null);
    await primeRatchetSession('flagoff');                     // Prime tut nichts ohne Flag
    expect(await ratchetEncrypt('flagoff', 'hi')).toBe(null);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('Peer multi-device → keine Session (null), kein Handshake', async () => {
    _ls.set('renex_ratchet_send', '1');
    getRecipientDevices.mockResolvedValue([
      { deviceId: 'd1', hasKem: true, caps: { hybrid: true } },
      { deviceId: 'd2', hasKem: true, caps: { hybrid: true } },
    ]);
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: makeBobWire('d1').wire });
    expect(await ratchetEncrypt('multi', 'hi')).toBe(null);
    expect(await primeRatchetSession('multi')).toBe(null);    // 2 Geräte → nicht single-device
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('ICH multi-device → keine Session (Self-Sync-Schutz)', async () => {
    _ls.set('renex_ratchet_send', '1');
    getRecipientDevices.mockImplementation(async (h) =>
      h === 'me' ? [{ deviceId: 'm1' }, { deviceId: 'm2' }]
                 : [{ deviceId: 'p1', hasKem: true, caps: { hybrid: true } }]);
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: makeBobWire('p1').wire });
    expect(await primeRatchetSession('peerx', { myHandle: 'me' })).toBe(null);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
