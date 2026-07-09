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
import {
  initPqState, pqRekeyDue, pqAnnounce, pqSendFields, pqMarkCtSent, pqNoteSend, pqReceivePrep,
} from '../frontend/src/lib/pqRatchet.js';
import { getOrCreateKemIdentity } from '../frontend/src/lib/kemIdentity.js';
import { storePeerDevices } from '../frontend/src/lib/cmk.js';
import { fetchRolloutFlags } from '../frontend/src/lib/rollout.js';
import { e2eEncrypt, e2eDecrypt } from '../frontend/src/lib/chatCrypto.js';
import { verifyMessageSigV4 } from '../frontend/src/lib/messageSig.js';
import {
  ratchetEncrypt, ratchetDecrypt, primeRatchetSession, pqDeviceCount,
  storeV4Plaintext, loadV4Plaintext,
  ratchetEncryptMulti, primePair,
  ratchetSendEnabled, pqRekeyEnabled,
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
beforeEach(async () => {
  vi.clearAllMocks();
  _ls.set('renex_ratchet_send', '1');            // Send-Flag AN für die Round-Trip-Tests
  // Rollout-State vor jedem Test neutralisieren (kein Leak zwischen Tests):
  apiFetch.mockResolvedValue({ ok: true, data: { ratchetSend: false, pqRekey: false } });
  await fetchRolloutFlags();
  vi.clearAllMocks();
});

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

    // Der Responder kann jetzt zurücksenden (v4, dieselbe Session).
    // getRecipientDevices für den Send-Zeit-single-device-Recheck (1 pq-Device).
    getRecipientDevices.mockResolvedValue([{ deviceId: 'adevB', hasKem: true, caps: { hybrid: true } }]);
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

  it('DATENVERLUST-FIX: kaputter Header verbrennt die OPK NICHT (Retry mit gutem Header klappt)', async () => {
    const good = await aliceMakesV4('adevF', 'echte nachricht', true);
    // Erst eine Nachricht mit DEMSELBEN init aber kaputtem Header → muss null +
    // OHNE OPK-Consume sein (Header wird ZUERST validiert).
    const broken = { ...good, header_b64: 'nicht-base64!!!' };
    expect(await ratchetDecrypt('alicef', 'adevF', broken, null)).toBe(null);
    // Danach die intakte Nachricht → accept läuft erst JETZT, Klartext kommt.
    const r = await ratchetDecrypt('alicef', 'adevF', good, null);
    expect(r?.text).toBe('echte nachricht');
  });
});

describe('v4-Klartext-Store (forward-secret History)', () => {
  it('storeV4Plaintext/loadV4Plaintext Round-Trip', async () => {
    await storeV4Plaintext('mid-x', 'geheim', true);
    expect(await loadV4Plaintext('mid-x')).toEqual({ text: 'geheim', verified: true });
    expect(await loadV4Plaintext('unbekannt')).toBe(null);
  });
});

describe('P3.2-A Multi-Device-Fan-out (ratchetEncryptMulti)', () => {
  // decrypt eines payload durch das ad-hoc-Device, das das Wire-Bundle stellte.
  async function bobDecryptsPayload(bob, p) {
    const rk0 = responderRoot({
      ikBPriv: bob.ikX.priv, spkBPriv: bob.spk.priv, opkBPriv: bob.opk.priv, pqspkDk: bob.pq.dk,
      ikAX: b64ToBytes(p.init.ikA25519), ekAX: b64ToBytes(p.init.ekA25519),
      kemCt: b64ToBytes(p.init.mlkemCt), usedOpk: !!p.init.usedOpkId,
    });
    const st = initResponder(rk0, { priv: bob.spk.priv, pub: bob.spk.pub });
    const mk = deriveReceiveKey(st, decodeRatchetHeader(p.header_b64));
    return aesDecrypt(mk, p.ivB64, p.ctB64, p.header_b64);
  }

  it('2 Peer-Devices → mode:multi mit 2 Payloads, jedes vom richtigen Device entschlüsselbar', async () => {
    const b1 = makeBobWire('bd1'), b2 = makeBobWire('bd2');
    const wires = { bd1: b1.wire, bd2: b2.wire };
    getRecipientDevices.mockImplementation(async (h) =>
      h === 'bobm' ? [{ deviceId: 'bd1', hasKem: true, caps: { hybrid: true } }, { deviceId: 'bd2', hasKem: true, caps: { hybrid: true } }]
      : h === 'me' ? [{ deviceId: 'medev', hasKem: true, caps: { hybrid: true } }] : []);
    apiFetch.mockImplementation(async (path) => {
      const dev = (path.match(/device=([^&]+)/) || [])[1];
      return (path.startsWith('/e2e/pqxdh/bundle') && wires[dev]) ? { ok: true, status: 200, data: wires[dev] } : { ok: false, status: 404, data: null };
    });

    // 1. Aufruf: nicht bereit → null (Legacy), primet beide im BG.
    expect(await ratchetEncryptMulti('bobm', 'x', { myHandle: 'me', myDeviceId: 'medev' })).toBe(null);
    await primePair('bobm', 'bd1'); await primePair('bobm', 'bd2');

    const out = await ratchetEncryptMulti('bobm', 'hallo multi 🔐', { myHandle: 'me', myDeviceId: 'medev' });
    expect(out.mode).toBe('multi');
    expect(out.payloads.map(p => p.deviceId).sort()).toEqual(['bd1', 'bd2']);
    const pd1 = out.payloads.find(p => p.deviceId === 'bd1');
    const pd2 = out.payloads.find(p => p.deviceId === 'bd2');
    expect(await bobDecryptsPayload(b1, pd1)).toBe('hallo multi 🔐');
    expect(await bobDecryptsPayload(b2, pd2)).toBe('hallo multi 🔐');
  });

  it('1 Ziel-Device → mode:single (P3.1-Wire, unverändert)', async () => {
    const b = makeBobWire('sd1');
    getRecipientDevices.mockImplementation(async (h) =>
      h === 'bobs' ? [{ deviceId: 'sd1', hasKem: true, caps: { hybrid: true } }]
      : h === 'me' ? [{ deviceId: 'medev', hasKem: true, caps: { hybrid: true } }] : []);
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: b.wire });
    expect(await ratchetEncryptMulti('bobs', 'x', { myHandle: 'me', myDeviceId: 'medev' })).toBe(null);
    await primePair('bobs', 'sd1');
    const out = await ratchetEncryptMulti('bobs', 'einzeln', { myHandle: 'me', myDeviceId: 'medev' });
    expect(out.mode).toBe('single');
    expect(out.tgt).toBe('sd1');
    expect(out.header_b64).toBeTruthy();
    expect(out.payloads).toBeUndefined();
  });

  it('Self-Sync: EIGENES anderes Device ist Ziel (2 Payloads: Peer + eigenes)', async () => {
    const bp = makeBobWire('pd'), bm = makeBobWire('mydev2');
    const wires = { pd: bp.wire, mydev2: bm.wire };
    getRecipientDevices.mockImplementation(async (h) =>
      h === 'bobss' ? [{ deviceId: 'pd', hasKem: true, caps: { hybrid: true } }]
      : h === 'me' ? [{ deviceId: 'medev', hasKem: true, caps: { hybrid: true } }, { deviceId: 'mydev2', hasKem: true, caps: { hybrid: true } }] : []);
    apiFetch.mockImplementation(async (path) => {
      const dev = (path.match(/device=([^&]+)/) || [])[1];
      return wires[dev] ? { ok: true, status: 200, data: wires[dev] } : { ok: false, status: 404, data: null };
    });
    await ratchetEncryptMulti('bobss', 'x', { myHandle: 'me', myDeviceId: 'medev' });
    await primePair('bobss', 'pd'); await primePair('me', 'mydev2');
    const out = await ratchetEncryptMulti('bobss', 'self-sync', { myHandle: 'me', myDeviceId: 'medev' });
    expect(out.mode).toBe('multi');
    expect(out.payloads.map(p => p.deviceId).sort()).toEqual(['mydev2', 'pd']);   // Peer + eigenes anderes Device
  });

  it('all-or-nothing: 1 Device unbereit → null (Legacy für alle)', async () => {
    getRecipientDevices.mockImplementation(async (h) =>
      h === 'bobno' ? [{ deviceId: 'r1', hasKem: true, caps: { hybrid: true } }, { deviceId: 'r2', hasKem: true, caps: { hybrid: true } }]
      : h === 'me' ? [{ deviceId: 'medev', hasKem: true, caps: { hybrid: true } }] : []);
    // Nur r1 bekommt ein Bundle; r2 nie → r2-Session nie bereit.
    const b1 = makeBobWire('r1');
    apiFetch.mockImplementation(async (path) => {
      const dev = (path.match(/device=([^&]+)/) || [])[1];
      return (dev === 'r1') ? { ok: true, status: 200, data: b1.wire } : { ok: false, status: 404, data: null };
    });
    await ratchetEncryptMulti('bobno', 'x', { myHandle: 'me', myDeviceId: 'medev' });
    await primePair('bobno', 'r1'); await primePair('bobno', 'r2');   // r2 schlägt fehl
    // r2 unbereit → all-or-nothing greift → null.
    expect(await ratchetEncryptMulti('bobno', 'y', { myHandle: 'me', myDeviceId: 'medev' })).toBe(null);
  });

  it('kein pq-Ziel → null (Legacy)', async () => {
    getRecipientDevices.mockResolvedValue([]);
    expect(await ratchetEncryptMulti('nopq', 'x', { myHandle: 'me', myDeviceId: 'medev' })).toBe(null);
  });

  it('REVIEW-HIGH: gemischte Flotte (1 pq + 1 non-pq Peer-Device) → null (Legacy für ALLE, kein Lock)', async () => {
    // Peer hat ein pq-Gerät UND ein aktives non-pq-Gerät (altes Build / stale SW).
    // v4 darf NICHT engagen — sonst bekäme das non-pq-Gerät nie eine lesbare Kopie.
    const b = makeBobWire('mixed_pq');
    getRecipientDevices.mockImplementation(async (h) =>
      h === 'bobmix' ? [
        { deviceId: 'mixed_pq', hasKem: true, caps: { hybrid: true } },
        { deviceId: 'mixed_old', hasKem: false, caps: null },        // non-pq → blockt v4
      ]
      : h === 'me' ? [{ deviceId: 'medev', hasKem: true, caps: { hybrid: true } }] : []);
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: b.wire });
    await primePair('bobmix', 'mixed_pq');   // Session steht sogar
    expect(await ratchetEncryptMulti('bobmix', 'x', { myHandle: 'me', myDeviceId: 'medev' })).toBe(null);
  });

  it('REVIEW-HIGH: eigenes non-pq Zweitgerät (Self-Sync-Flotte gemischt) → null (Legacy)', async () => {
    const b = makeBobWire('sfp');
    getRecipientDevices.mockImplementation(async (h) =>
      h === 'bobself' ? [{ deviceId: 'sfp', hasKem: true, caps: { hybrid: true } }]
      : h === 'me' ? [
        { deviceId: 'medev', hasKem: true, caps: { hybrid: true } },
        { deviceId: 'myold', hasKem: false, caps: null },            // eigenes non-pq Gerät
      ] : []);
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: b.wire });
    await primePair('bobself', 'sfp');
    expect(await ratchetEncryptMulti('bobself', 'x', { myHandle: 'me', myDeviceId: 'medev' })).toBe(null);
  });

  it('>FANOUT_MAX Ziele → null (Legacy, KEIN stilles Truncaten)', async () => {
    getRecipientDevices.mockImplementation(async (h) =>
      h === 'bobmany' ? Array.from({ length: 12 }, (_, i) => ({ deviceId: 'md' + i, hasKem: true, caps: { hybrid: true } }))
      : h === 'me' ? [{ deviceId: 'medev', hasKem: true, caps: { hybrid: true } }] : []);
    apiFetch.mockResolvedValue({ ok: false, status: 404, data: null });
    expect(await ratchetEncryptMulti('bobmany', 'x', { myHandle: 'me', myDeviceId: 'medev' })).toBe(null);
  });

  it('2026-05-15-REGRESSION: per-Device-Sessions ISOLIERT — kein Cross-Device-Clobber, out-of-order pro Device ok', async () => {
    // Der Vorfall 2026-05-15 war ein GETEILTER-Zustand-Clobber (ein Device
    // zerstörte den State der anderen). v4 hat pro (peer,device) eine EIGENE
    // isolierte Session → strukturell unmöglich. Dieser Test beweist es:
    const b1 = makeBobWire('rd1'), b2 = makeBobWire('rd2');
    const wires = { rd1: b1.wire, rd2: b2.wire };
    getRecipientDevices.mockImplementation(async (h) =>
      h === 'bobiso' ? [{ deviceId: 'rd1', hasKem: true, caps: { hybrid: true } }, { deviceId: 'rd2', hasKem: true, caps: { hybrid: true } }]
      : h === 'me' ? [{ deviceId: 'medev', hasKem: true, caps: { hybrid: true } }] : []);
    apiFetch.mockImplementation(async (path) => {
      const dev = (path.match(/device=([^&]+)/) || [])[1];
      return wires[dev] ? { ok: true, status: 200, data: wires[dev] } : { ok: false, status: 404, data: null };
    });
    await ratchetEncryptMulti('bobiso', 'x', { myHandle: 'me', myDeviceId: 'medev' });
    await primePair('bobiso', 'rd1'); await primePair('bobiso', 'rd2');

    // 3 Fan-out-Sends → je payloads[rd1, rd2].
    const sends = [];
    for (let i = 0; i < 3; i++) sends.push(await ratchetEncryptMulti('bobiso', 'msg' + i, { myHandle: 'me', myDeviceId: 'medev' }));
    const P = (i, dev) => sends[i].payloads.find(p => p.deviceId === dev);

    // Persistente Responder-States je Device (aus dem init der 1. Nachricht).
    const respState = (bob, p) => {
      const rk0 = responderRoot({
        ikBPriv: bob.ikX.priv, spkBPriv: bob.spk.priv, opkBPriv: bob.opk.priv, pqspkDk: bob.pq.dk,
        ikAX: b64ToBytes(p.init.ikA25519), ekAX: b64ToBytes(p.init.ekA25519), kemCt: b64ToBytes(p.init.mlkemCt), usedOpk: !!p.init.usedOpkId,
      });
      return initResponder(rk0, { priv: bob.spk.priv, pub: bob.spk.pub });
    };
    const dec = (st, p) => aesDecrypt(deriveReceiveKey(st, decodeRatchetHeader(p.header_b64)), p.ivB64, p.ctB64, p.header_b64);

    const st1 = respState(b1, P(0, 'rd1'));
    const st2 = respState(b2, P(0, 'rd2'));

    // Device rd1: IN ORDER 0,1,2.
    expect(await dec(st1, P(0, 'rd1'))).toBe('msg0');
    expect(await dec(st1, P(1, 'rd1'))).toBe('msg1');
    expect(await dec(st1, P(2, 'rd1'))).toBe('msg2');

    // Device rd2: OUT OF ORDER 0,2,1 (verpasst 1 kurz) → Skipped-Keys, alle korrekt.
    expect(await dec(st2, P(0, 'rd2'))).toBe('msg0');
    expect(await dec(st2, P(2, 'rd2'))).toBe('msg2');   // überspringt 1
    expect(await dec(st2, P(1, 'rd2'))).toBe('msg1');   // aus dem Skipped-Store

    // Beide Devices vollständig + unabhängig → das rd2-Out-of-Order hat rd1 NICHT
    // beeinflusst (isolierte Chains).
    expect(P(0, 'rd1').header_b64).not.toBe(P(0, 'rd2').header_b64);   // verschiedene Ketten
  });
});

describe('P3.2-B PQ-Triple-Rekey (Verkabelung ratchetSession)', () => {
  // Alice = Initiator (pure), spiegelt _encryptForDevice/pqReceivePrep, damit MEIN
  // ratchetSession als Responder getestet wird. Encaps-Ziel = mein echtes kemEk.
  // Ein einziges Schlüsselpaar für initiatorRoot UND initHdr (sonst Root-Mismatch).
  async function makeAlice() {
    const pub = await buildPublishBundle({ opkCount: 3 });
    const usedOpk = pub.opks[0];
    const aIkX = x25519Keygen(), aEk = x25519Keygen(), aIkEd = ed25519Keygen();
    const { rk0, kemCt } = initiatorRoot({
      ikAPriv: aIkX.priv, ekAPriv: aEk.priv,
      bundle: decodeInitiatorBundle({ ik: pub.ik, spk: pub.spk, pqspk: pub.pqspk, opk: usedOpk }),
    });
    const st = initInitiator(rk0, b64ToBytes(pub.spk.spk));
    const pq = initPqState(1);
    const initHdr = {
      v: 3, alg: ALG,
      ikA25519: bytesToB64(aIkX.pub), ikAEd: bytesToB64(aIkEd.pub), ekA25519: bytesToB64(aEk.pub),
      usedSpkId: pub.spk.spkId, usedOpkId: usedOpk.opkId, usedPqspkId: pub.pqspk.pqspkId,
      mlkemCt: bytesToB64(kemCt),
      hdrSig: bytesToB64(signInitHdr({
        v: 3, alg: ALG, ikA25519: aIkX.pub, ekA25519: aEk.pub,
        usedSpkId: pub.spk.spkId, usedOpkId: usedOpk.opkId, usedPqspkId: pub.pqspk.pqspkId, mlkemCt: kemCt,
      }, aIkEd.priv)),
    };
    return { st, pq, initHdr };
  }

  it('EMPFÄNGER e2e: Alice announced+aktiviert gegen mein echtes kemEk → ich harveste, aktiviere, entschlüssele', async () => {
    const myEk = (await getOrCreateKemIdentity()).ek;
    const A = await makeAlice();

    const aliceSend = async (text, withInit) => {
      const pqf = pqSendFields(A.pq);
      const { mk, header } = nextSendKey(A.st);
      const header_b64 = encodeRatchetHeader(pqf ? { ...header, pqTgt: pqf.pqTgt, pqFp: pqf.pqFp, pqConf: pqf.pqConf || null } : header);
      const { ivB64, ctB64 } = await aesEncrypt(mk, text, header_b64);
      if (pqf) pqMarkCtSent(A.pq); pqNoteSend(A.pq);
      return { v: 4, header_b64, ivB64, ctB64, ...(pqf ? { pq_kem_ct: pqf.pqCtB64 } : {}), ...(withInit ? { init: A.initHdr } : {}) };
    };
    const aliceRecv = (msg) => {
      const header = decodeRatchetHeader(msg.header_b64);
      const prep = pqReceivePrep(A.pq, A.st, header, { now: 2 });
      deriveReceiveKey(A.st, header, prep.hooks);
    };

    // 1) Alice → init → ich werde Responder (kemEpoch 0).
    const r1 = await ratchetDecrypt('alicepq', 'apqdev', await aliceSend('hallo', true), null);
    expect(r1?.text).toBe('hallo');

    // 2) Alice announced gegen mein kemEk (Rolle initiator).
    expect(pqAnnounce(A.pq, A.st, myEk)).toBe(true);
    expect(A.pq.pendingOut.tgt).toBe(1);

    // 3) Ich sende zurück → Alice ratcht auf meinen neuen Pub → preR2 aktiviert.
    getRecipientDevices.mockResolvedValue([{ deviceId: 'apqdev', hasKem: true, caps: { hybrid: true } }]);
    const back = await ratchetEncrypt('alicepq', 'antwort');
    expect(back?.v).toBe(4);
    aliceRecv(back);
    expect(A.st.kemEpoch).toBe(1);
    expect(A.pq.pendingOut.confB64).toBeTruthy();

    // 4) Alice sendet kemEpoch=1 + CT + pqConf → ich harveste+aktiviere+entschlüssele.
    const m2 = await aliceSend('nach rekey 🔐', false);
    expect(decodeRatchetHeader(m2.header_b64).kemEpoch).toBe(1);
    expect(m2.pq_kem_ct).toBeTruthy();
    const r2 = await ratchetDecrypt('alicepq', 'apqdev', m2, null);
    expect(r2?.text).toBe('nach rekey 🔐');

    // 5) Folge-Nachricht der neuen Epoche bleibt lesbar (Root synchron geblieben).
    const m3 = await aliceSend('folge', false);
    expect((await ratchetDecrypt('alicepq', 'apqdev', m3, null))?.text).toBe('folge');
  });

  it('SENDER: nach MSG_LIMIT Sends announct der Fan-out (pq_kem_ct + mode:multi), Capability-gegated', async () => {
    _ls.set('renex_ratchet_send', '1');
    _ls.set('renex_pq_rekey', '1');
    const peerKem = mlKemKeygen();
    const bob = makeBobWire('bpq1');
    // Peer-Device-Cache mit kemEk + caps.pqrekey (Encaps-Ziel; KEIN Netz).
    await storePeerDevices('bobpqs', [{ deviceId: 'bpq1', kemEk: bytesToB64(peerKem.ek) }]);
    getRecipientDevices.mockImplementation(async (h) =>
      h === 'bobpqs' ? [{ deviceId: 'bpq1', hasKem: true, caps: { hybrid: true, pqrekey: true } }]
      : h === 'me' ? [{ deviceId: 'medev', hasKem: true, caps: { hybrid: true } }] : []);
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: bob.wire });

    await ratchetEncryptMulti('bobpqs', 'x', { myHandle: 'me', myDeviceId: 'medev' });
    await primePair('bobpqs', 'bpq1');

    // MSG_LIMIT (50) Sends: alle single, KEIN pq_kem_ct.
    let announced = null;
    for (let i = 0; i < 51; i++) {
      const out = await ratchetEncryptMulti('bobpqs', 'm' + i, { myHandle: 'me', myDeviceId: 'medev' });
      const p = out.mode === 'multi' ? out.payloads[0] : out;
      if (p.pq_kem_ct) { announced = out; break; }
      expect(out.mode).toBe('single');   // vor dem Rekey: single-Wire
    }
    expect(announced).not.toBeNull();
    expect(announced.mode).toBe('multi');                 // Rekey erzwingt payloads[]-Format
    expect(announced.payloads[0].pq_kem_ct.length).toBeGreaterThan(1400);
    const stats = JSON.parse(_ls.get('renex_pqrk_stats') || '{}');
    expect(stats.announce).toBeGreaterThanOrEqual(1);
  });

  it('DEBUG-Override renex_pq_rekey_msglimit=2 → Announce schon nach ~2 Sends (Live-Verify-Pfad)', async () => {
    _ls.set('renex_ratchet_send', '1');
    _ls.set('renex_pq_rekey', '1');
    _ls.set('renex_pq_rekey_msglimit', '2');
    const peerKem = mlKemKeygen();
    const bob = makeBobWire('bpqd');
    await storePeerDevices('bobdbg', [{ deviceId: 'bpqd', kemEk: bytesToB64(peerKem.ek) }]);
    getRecipientDevices.mockImplementation(async (h) =>
      h === 'bobdbg' ? [{ deviceId: 'bpqd', hasKem: true, caps: { hybrid: true, pqrekey: true } }]
      : h === 'me' ? [{ deviceId: 'medev', hasKem: true, caps: { hybrid: true } }] : []);
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: bob.wire });
    await ratchetEncryptMulti('bobdbg', 'x', { myHandle: 'me', myDeviceId: 'medev' });
    await primePair('bobdbg', 'bpqd');

    let announced = null;
    for (let i = 0; i < 5; i++) {
      const out = await ratchetEncryptMulti('bobdbg', 'm' + i, { myHandle: 'me', myDeviceId: 'medev' });
      const p = out.mode === 'multi' ? out.payloads[0] : out;
      if (p.pq_kem_ct) { announced = i; break; }
    }
    expect(announced).not.toBeNull();
    expect(announced).toBeLessThanOrEqual(2);   // gesenkte Schwelle greift früh
    _ls.delete('renex_pq_rekey_msglimit');
  });

  it('SENDER: Peer OHNE caps.pqrekey → nie ein Announce (alte v4-Empfänger würden locken)', async () => {
    _ls.set('renex_ratchet_send', '1');
    _ls.set('renex_pq_rekey', '1');
    const peerKem = mlKemKeygen();
    const bob = makeBobWire('bpq2');
    await storePeerDevices('bobnopq', [{ deviceId: 'bpq2', kemEk: bytesToB64(peerKem.ek) }]);
    getRecipientDevices.mockImplementation(async (h) =>
      h === 'bobnopq' ? [{ deviceId: 'bpq2', hasKem: true, caps: { hybrid: true } }]   // KEIN pqrekey
      : h === 'me' ? [{ deviceId: 'medev', hasKem: true, caps: { hybrid: true } }] : []);
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: bob.wire });
    await ratchetEncryptMulti('bobnopq', 'x', { myHandle: 'me', myDeviceId: 'medev' });
    await primePair('bobnopq', 'bpq2');
    for (let i = 0; i < 55; i++) {
      const out = await ratchetEncryptMulti('bobnopq', 'm' + i, { myHandle: 'me', myDeviceId: 'medev' });
      const p = out.mode === 'multi' ? out.payloads[0] : out;
      expect(p.pq_kem_ct).toBeUndefined();               // Capability-Gate: nie ein CT
    }
  });

  it('SENDER: pq-Flag AUS → nie ein Announce (auch wenn fällig+capable)', async () => {
    _ls.set('renex_ratchet_send', '1');
    _ls.delete('renex_pq_rekey');
    const peerKem = mlKemKeygen();
    const bob = makeBobWire('bpq3');
    await storePeerDevices('bobflag', [{ deviceId: 'bpq3', kemEk: bytesToB64(peerKem.ek) }]);
    getRecipientDevices.mockImplementation(async (h) =>
      h === 'bobflag' ? [{ deviceId: 'bpq3', hasKem: true, caps: { hybrid: true, pqrekey: true } }]
      : h === 'me' ? [{ deviceId: 'medev', hasKem: true, caps: { hybrid: true } }] : []);
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: bob.wire });
    await ratchetEncryptMulti('bobflag', 'x', { myHandle: 'me', myDeviceId: 'medev' });
    await primePair('bobflag', 'bpq3');
    for (let i = 0; i < 55; i++) {
      const out = await ratchetEncryptMulti('bobflag', 'm' + i, { myHandle: 'me', myDeviceId: 'medev' });
      const p = out.mode === 'multi' ? out.payloads[0] : out;
      expect(p.pq_kem_ct).toBeUndefined();
    }
  });
});

describe('Send-Zeit-Recheck (Peer wird multi-device)', () => {
  it('Session existiert, aber Peer jetzt 2 Geräte → ratchetEncrypt null (Legacy-Fallback)', async () => {
    const bob = makeBobWire('bobH');
    getRecipientDevices.mockResolvedValue([{ deviceId: 'bobH', hasKem: true, caps: { hybrid: true } }]);
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: bob.wire });
    await primeRatchetSession('bobh');
    expect((await ratchetEncrypt('bobh', 'eins'))?.v).toBe(4);   // 1 Gerät → v4
    // Peer fügt ein Gerät hinzu:
    getRecipientDevices.mockResolvedValue([
      { deviceId: 'bobH', hasKem: true, caps: { hybrid: true } },
      { deviceId: 'bobH2', hasKem: true, caps: { hybrid: true } },
    ]);
    expect(await ratchetEncrypt('bobh', 'zwei')).toBe(null);      // jetzt multi-device → Legacy
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

describe('Rollout-Default + pqRekey-Präzedenz (Review-Fixes)', () => {
  // Rollout-State AN setzen (danach neutralisiert die File-beforeEach ihn wieder).
  async function rolloutOn(flags) {
    apiFetch.mockResolvedValue({ ok: true, data: flags });
    await fetchRolloutFlags();
    vi.clearAllMocks();
  }

  it('Rollout ratchetSend=true → v4-Senden default AN ohne explizites Flag', async () => {
    await rolloutOn({ ratchetSend: true, pqRekey: false });
    _ls.delete('renex_ratchet_send');
    expect(ratchetSendEnabled()).toBe(true);
    expect(pqRekeyEnabled()).toBe(false);
  });

  it('per-Device renex_ratchet_send=0 übersteuert Rollout-AN (Opt-out)', async () => {
    await rolloutOn({ ratchetSend: true, pqRekey: false });
    _ls.set('renex_ratchet_send', '0');
    expect(ratchetSendEnabled()).toBe(false);
  });

  it('REVIEW-LOW: stray renex_pq_rekey=1 wird NICHT durch Rollout-send scharf', async () => {
    await rolloutOn({ ratchetSend: true, pqRekey: false });
    _ls.delete('renex_ratchet_send');            // send kommt nur aus dem Rollout
    _ls.set('renex_pq_rekey', '1');              // vergessenes Flag
    expect(ratchetSendEnabled()).toBe(true);
    expect(pqRekeyEnabled()).toBe(false);        // bleibt AUS (un-GA PQ-Triple nicht scharf)
  });

  it('echtes Testgerät (beide Flags explizit) → pqRekey AN', () => {
    _ls.set('renex_ratchet_send', '1');
    _ls.set('renex_pq_rekey', '1');
    expect(pqRekeyEnabled()).toBe(true);
  });

  it('per-Device renex_pq_rekey=0 killt trotz Rollout pqRekey=true', async () => {
    await rolloutOn({ ratchetSend: true, pqRekey: true });
    _ls.set('renex_pq_rekey', '0');
    expect(pqRekeyEnabled()).toBe(false);
  });
});
