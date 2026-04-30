// ======================================================
// Unit-Tests für CMK-Storage + Wrap/Unwrap
// ======================================================
// Spec: docs/MULTI_DEVICE.md §4.4 (CMK-Distribution)
//
// Kritische Garantien:
//   - getOrCreateCMK ist deterministisch (gleicher Peer → gleicher CMK)
//   - CMK-Storage ist verschlüsselt (Storage-Key isoliert pro User)
//   - importAndStoreCMKFromPeer round-trip
//   - wrapCMKForInboxDevices + unwrapCMKFromPeer round-trip (ECDH-DH)
//   - Wrap mit falscher Empfänger-Identität → Unwrap fails
// ======================================================
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { idbSet, idbGet } from '../frontend/src/lib/idb.js';
import {
  getOrCreateCMK,
  getCMKIfExists,
  importAndStoreCMKFromPeer,
  createAndStoreCMK,
  deleteCMK,
  storePeerDevices,
  loadPeerDevicesIdb,
  findSenderDeviceJwk,
  getSigPubForDevice,
  wrapCMKForInboxDevices,
  unwrapCMKFromPeer,
} from '../frontend/src/lib/cmk.js';

// ── Test-Setup: my_user setzen + ECDH-Keypair in IDB ─
async function setupUserAndKeys(handle = 'alice') {
  // localStorage-Polyfill für Node
  if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    };
  }
  globalThis.localStorage.setItem('my_user', handle);
  globalThis.localStorage.setItem('device_id', 'dev_test_' + handle);

  // ECDH-Keypair generieren + in IDB ablegen (analog zu initE2EKeys)
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false, ['deriveKey']
  );
  await idbSet('e2e-private-key', pair.privateKey);
  await idbSet('e2e-public-key', pair.publicKey);

  // Public-Key als JWK exportieren — das ist was wrapCMKForInboxDevices als Peer-Pubkey braucht
  // Achtung: für JWK-Export muss der Key extractable sein. Wir generieren parallel
  // ein extractable-Pair für JWK-Export (Production: peer.jwk kommt aus Inbox-API).
  const exportPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true, ['deriveKey']
  );
  const myJwk = await crypto.subtle.exportKey('jwk', exportPair.publicKey);

  return { pair, exportPair, myJwk };
}

describe('CMK Storage', () => {
  beforeEach(async () => {
    await setupUserAndKeys('alice');
  });

  it('getOrCreateCMK creates a new 32-byte CMK for fresh peer', async () => {
    const peer = 'fresh_peer_' + Math.random().toString(36).slice(2);
    const cmk = await getOrCreateCMK(peer);
    expect(cmk).toBeInstanceOf(Uint8Array);
    expect(cmk.length).toBe(32);
  });

  it('getOrCreateCMK is idempotent (same peer → same CMK)', async () => {
    const peer = 'idem_peer_' + Math.random().toString(36).slice(2);
    const cmk1 = await getOrCreateCMK(peer);
    const cmk2 = await getOrCreateCMK(peer);
    expect(Array.from(cmk1)).toEqual(Array.from(cmk2));
  });

  it('different peers → different CMKs', async () => {
    const cmkA = await getOrCreateCMK('peer_a_' + Math.random());
    const cmkB = await getOrCreateCMK('peer_b_' + Math.random());
    expect(Array.from(cmkA)).not.toEqual(Array.from(cmkB));
  });

  it('getCMKIfExists returns null for unknown peer', async () => {
    const cmk = await getCMKIfExists('definitely_unknown_peer_xyz');
    expect(cmk).toBe(null);
  });

  it('getCMKIfExists returns existing CMK after createAndStoreCMK', async () => {
    const peer = 'existing_' + Math.random().toString(36).slice(2);
    const created = await createAndStoreCMK(peer);
    const fetched = await getCMKIfExists(peer);
    expect(Array.from(fetched)).toEqual(Array.from(created));
  });

  it('importAndStoreCMKFromPeer rejects invalid CMK length', async () => {
    await expect(importAndStoreCMKFromPeer('peer', new Uint8Array(31)))
      .rejects.toThrow();
    await expect(importAndStoreCMKFromPeer('peer', 'not-bytes'))
      .rejects.toThrow();
  });

  it('deleteCMK removes the entry', async () => {
    const peer = 'delete_me_' + Math.random().toString(36).slice(2);
    await getOrCreateCMK(peer);
    expect(await getCMKIfExists(peer)).not.toBe(null);
    await deleteCMK(peer);
    expect(await getCMKIfExists(peer)).toBe(null);
  });

  it('CMK is stored encrypted (not raw)', async () => {
    // Raw IDB lookup — sollte verschlüsselte Form zeigen, NICHT die rohen 32 Bytes
    const peer = 'encrypted_check_' + Math.random().toString(36).slice(2);
    const cmk = await getOrCreateCMK(peer);

    const raw = await idbGet(`cmk:alice:${peer}`);
    expect(raw).toBeTruthy();
    expect(raw.ivB64).toBeTruthy();
    expect(raw.ctB64).toBeTruthy();
    // Stored ctB64 sollte nicht einfach die rohen Bytes sein
    expect(raw.ctB64).not.toBe(btoa(String.fromCharCode(...cmk)));
  });
});

describe('Peer-Device-Cache', () => {
  beforeEach(async () => {
    await setupUserAndKeys('alice');
  });

  it('storePeerDevices + loadPeerDevicesIdb round-trip', async () => {
    const devices = [
      { deviceId: 'dev1', jwk: { kty: 'EC', x: 'X', y: 'Y' }, sigPub: { kty: 'EC' } },
      { deviceId: 'dev2', jwk: { kty: 'EC', x: 'X2', y: 'Y2' } },
    ];
    await storePeerDevices('bob', devices);
    const loaded = await loadPeerDevicesIdb('bob');
    expect(loaded.length).toBe(2);
    expect(loaded[0].deviceId).toBe('dev1');
  });

  it('loadPeerDevicesIdb returns [] for unknown peer', async () => {
    const loaded = await loadPeerDevicesIdb('unknown_peer_xyz');
    expect(loaded).toEqual([]);
  });

  it('findSenderDeviceJwk picks correct device by deviceId', async () => {
    await storePeerDevices('charlie', [
      { deviceId: 'phone', jwk: { kty: 'EC', x: 'P' } },
      { deviceId: 'mac',   jwk: { kty: 'EC', x: 'M' } },
    ]);
    expect((await findSenderDeviceJwk('charlie', 'mac')).x).toBe('M');
    expect(await findSenderDeviceJwk('charlie', 'unknown')).toBe(null);
  });

  it('getSigPubForDevice returns sigPub when present', async () => {
    await storePeerDevices('dave', [
      { deviceId: 'd1', jwk: {}, sigPub: { kty: 'EC', x: 'sig' } },
    ]);
    expect((await getSigPubForDevice('dave', 'd1')).x).toBe('sig');
    expect(await getSigPubForDevice('dave', 'd1-other')).toBe(null);
  });

  it('peer-handle is lowercased', async () => {
    await storePeerDevices('UpperCase', [{ deviceId: 'd', jwk: {} }]);
    expect((await loadPeerDevicesIdb('uppercase')).length).toBe(1);
  });
});

describe('CMK Wrap/Unwrap (ECDH)', () => {
  it('wrap + unwrap round-trip mit echtem ECDH-Keypair', async () => {
    // Sender = "alice", hat eigenes ECDH-Keypair via setupUserAndKeys
    const aliceSetup = await setupUserAndKeys('alice');

    // Empfänger ("bob") — eigenes ECDH-Keypair, Pubkey wird von alice empfangen
    const bobPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true, ['deriveKey']
    );
    const bobPubJwk = await crypto.subtle.exportKey('jwk', bobPair.publicKey);

    const cmk = crypto.getRandomValues(new Uint8Array(32));

    // alice wrappt CMK für bob
    const payloads = await wrapCMKForInboxDevices(
      [{ deviceId: 'bob_phone', jwk: bobPubJwk }],
      cmk
    );
    expect(payloads.length).toBe(1);
    expect(payloads[0].deviceId).toBe('bob_phone');
    expect(payloads[0].fromDeviceId).toBe('dev_test_alice');
    expect(payloads[0].ivB64).toBeTruthy();
    expect(payloads[0].ctB64).toBeTruthy();

    // bob unwrappt CMK von alice — braucht alice's PUBLIC key
    // (in production: bob.unwrap nutzt seinen eigenen privKey; hier simulieren wir
    // bob's perspektive: wir laden bob's privKey + alice's pubJwk)
    const { idbSet: idbSet2 } = await import('../frontend/src/lib/idb.js');
    await idbSet2('e2e-private-key', bobPair.privateKey);

    // alice's pubKey als JWK extrahieren — wir nutzen das exportable-Pair aus Setup
    const alicePubJwk = aliceSetup.myJwk;

    // ABER: wrapCMKForInboxDevices nutzt `aliceSetup.pair.privateKey` (non-extractable)
    // für ECDH, während aliceSetup.myJwk vom EXTRACTABLE pair kommt — das matcht NICHT.
    // → Ich muss den Test anders aufbauen: alice's keypair muss extractable sein,
    //   damit ich den Pubkey als JWK exportieren kann.

    // Workaround: Setup neu mit extractable Pair überschreiben
    await idbSet2('e2e-private-key', aliceSetup.exportPair.privateKey);
    await idbSet2('e2e-public-key', aliceSetup.exportPair.publicKey);

    // Re-wrap mit dem korrekten privKey
    const payloads2 = await wrapCMKForInboxDevices(
      [{ deviceId: 'bob_phone', jwk: bobPubJwk }],
      cmk
    );

    // Jetzt ist bob's PrivKey gefragt + alice's PubKey
    await idbSet2('e2e-private-key', bobPair.privateKey);
    const aliceExportablePubJwk = await crypto.subtle.exportKey('jwk', aliceSetup.exportPair.publicKey);

    const unwrappedCmk = await unwrapCMKFromPeer(
      payloads2[0].ivB64,
      payloads2[0].ctB64,
      aliceExportablePubJwk
    );
    expect(Array.from(unwrappedCmk)).toEqual(Array.from(cmk));
  });

  it('unwrap with WRONG sender pubkey fails', async () => {
    const aliceSetup = await setupUserAndKeys('alice');
    // Force extractable pair für JWK-Export
    await idbSet('e2e-private-key', aliceSetup.exportPair.privateKey);
    await idbSet('e2e-public-key', aliceSetup.exportPair.publicKey);

    const bobPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true, ['deriveKey']
    );
    const bobPubJwk = await crypto.subtle.exportKey('jwk', bobPair.publicKey);

    const cmk = crypto.getRandomValues(new Uint8Array(32));
    const payloads = await wrapCMKForInboxDevices(
      [{ deviceId: 'bob', jwk: bobPubJwk }],
      cmk
    );

    // Fremder Sender-Pubkey
    const evilPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true, ['deriveKey']
    );
    const evilPubJwk = await crypto.subtle.exportKey('jwk', evilPair.publicKey);

    await idbSet('e2e-private-key', bobPair.privateKey);
    await expect(
      unwrapCMKFromPeer(payloads[0].ivB64, payloads[0].ctB64, evilPubJwk)
    ).rejects.toThrow();
  });

  it('wrap with empty devices list returns empty payloads', async () => {
    await setupUserAndKeys('alice');
    const cmk = crypto.getRandomValues(new Uint8Array(32));
    const payloads = await wrapCMKForInboxDevices([], cmk);
    expect(payloads).toEqual([]);
  });

  it('wrap skips invalid device entries', async () => {
    const aliceSetup = await setupUserAndKeys('alice');
    await idbSet('e2e-private-key', aliceSetup.exportPair.privateKey);

    const cmk = crypto.getRandomValues(new Uint8Array(32));
    const payloads = await wrapCMKForInboxDevices(
      [
        null,
        { deviceId: '', jwk: {} },
        { jwk: {} },                  // missing deviceId
        { deviceId: 'd' },             // missing jwk
      ],
      cmk
    );
    expect(payloads).toEqual([]);
  });
});
