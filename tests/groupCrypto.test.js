// ======================================================
// Unit-Tests für Group-E2E (Sender-Keys / GSK)
// ======================================================
// Spec: docs/MULTI_DEVICE.md §1 (GSK-Definition), §13 (Phase 1C)
//
// Kritische Garantien:
//   - GSK-Storage ist verschlüsselt (per-Group-Scoped Storage-Key)
//   - Storage-Roundtrip (set → get) ist verlustfrei
//   - Per-Group-Isolation (gsk:my:me:groupA != gsk:my:me:groupB)
//   - ECDH-Wrap-Pfad (sendMyGSKToMember) + Unwrap-Pfad (handleIncomingGSKMessage)
//     round-trippen über AES-GCM(ECDH(myPriv × peerPub))
//   - rotateMyGSK erzeugt einen FRISCHEN GSK (≠ alter)
//   - ensureMyGSK ist idempotent
//   - handleIncomingGSKMessage filtert: eigene + falsch-adressierte
//   - getOrRequestPeerGSK gibt null zurück + triggert request_gsk fire-and-forget
// ======================================================

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// apiFetch mocken — Tests die Distribution prüfen wollen die ausgehenden Body-Felder
// inspizieren statt echte HTTP-Calls.
const _apiCalls = [];
let _apiResponder = (path, opts) => ({ ok: true, data: {} });

vi.mock('../frontend/src/lib/api.js', () => ({
  apiFetch: vi.fn(async (path, opts) => {
    _apiCalls.push({ path, opts });
    return _apiResponder(path, opts);
  }),
}));

// sentry mocken — wir wollen keine echten captureException-Calls
vi.mock('../frontend/src/lib/sentry.js', () => ({
  captureException: vi.fn(),
}));

import { idbGet, idbSet, idbListKeys } from '../frontend/src/lib/idb.js';
import { bytesToB64, b64ToBytes } from '../frontend/src/lib/bytes.js';
import { storePeerDevices } from '../frontend/src/lib/cmk.js';
import {
  // Storage
  getMyGSK, setMyGSK, createMyGSK, deleteMyGSK,
  getPeerGSK, setPeerGSK, deletePeerGSK,
  deleteAllGSKsForGroup,
  // Distribution
  sendMyGSKToMember, distributeMyGSKToMembers,
  storeMyGSKForOwnDevices, fetchMyGSKFromKV,
  // Receive
  handleIncomingGSKMessage, handleIncomingRequestGSK,
  sendRequestGSK,
  // Lifecycle
  rotateMyGSK, ensureMyGSK,
  getOrRequestPeerGSK, importGskAesKey,
  // Rotation-Archive (15min-Edit-Window)
  findMyGSKAtTs, findPeerGSKAtTs, clearGSKArchiveForGroup,
  // Forward-Secrecy: chainIndex + per-Message HKDF MK
  nextGroupChainIndex, peekGroupChainIndex, resetGroupChainIndex,
  deriveGroupMessageKey,
  // Bundle-Sync helpers
  collectMyGSKs, restoreMyGSKsFromBundle,
  // Auto-Rotate-Threshold (NIST SP 800-38D §8.3)
  ENCRYPT_ROTATE_THRESHOLD,
  // Sender-Sig (Defense-in-Depth gegen from-Spoofing)
  signGskPayload, verifyGskPayload,
} from '../frontend/src/lib/groupCrypto.js';

// ======================================================
// Test-Setup: localStorage-Polyfill, ECDH-Keypair, deviceId
// ======================================================

async function setupUser(handle = 'alice') {
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
  globalThis.localStorage.setItem(`device_id:${handle.toLowerCase()}`, 'dev_test_' + handle);

  // Extractable ECDH-Keypair — extractable=true ist nötig damit wir den
  // Pubkey als JWK exportieren können (Production: peer.jwk kommt aus Inbox-API,
  // privKey ist non-extractable).
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true, ['deriveKey']
  );
  await idbSet('e2e-private-key', pair.privateKey);
  await idbSet('e2e-public-key', pair.publicKey);
  const myPubJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { pair, myPubJwk };
}

// Frische IDB-Reset — fake-indexeddb persistiert sonst zwischen Tests
async function resetIdb() {
  const { default: FDBFactory } = await import('fake-indexeddb/lib/FDBFactory');
  globalThis.indexedDB = new FDBFactory();
}

function resetApiMock(responder) {
  _apiCalls.length = 0;
  _apiResponder = responder || ((path, opts) => ({ ok: true, data: {} }));
}

// Helper: erzeugt ein gültiges ec-payload (für handleIncomingGSKMessage-Tests)
// "Sender" = peer mit eigenem Keypair. "Mein Device" empfängt.
async function buildIncomingGSKPayload({
  groupId, fromHandle, fromDeviceId, toHandle, toDeviceId,
  toPubJwk, gskBytes,
}) {
  const senderPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true, ['deriveKey']
  );
  const senderJwk = await crypto.subtle.exportKey('jwk', senderPair.publicKey);

  const recipientPub = await crypto.subtle.importKey(
    'jwk', toPubJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false, []
  );
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: recipientPub },
    senderPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, aesKey, gskBytes
  );

  return {
    senderJwk,
    msg: {
      from: fromHandle,
      to: toHandle,
      groupId,
      deviceId: fromDeviceId,
      payloads: [{
        deviceId: toDeviceId,
        fromDeviceId,
        ivB64: bytesToB64(iv),
        ctB64: bytesToB64(new Uint8Array(ct)),
      }],
    },
  };
}

// ======================================================
// 1. My-GSK Storage
// ======================================================

describe('GSK Storage: own keys', () => {
  beforeEach(async () => {
    await resetIdb();
    await setupUser('alice');
    resetApiMock();
  });

  it('createMyGSK creates a new 32-byte GSK', async () => {
    const gsk = await createMyGSK('group-a');
    expect(gsk).toBeInstanceOf(Uint8Array);
    expect(gsk.length).toBe(32);
  });

  it('getMyGSK returns null when never set', async () => {
    expect(await getMyGSK('never-set-group')).toBe(null);
  });

  it('setMyGSK + getMyGSK round-trip', async () => {
    const original = crypto.getRandomValues(new Uint8Array(32));
    await setMyGSK('group-rt', original);
    const fetched = await getMyGSK('group-rt');
    expect(Array.from(fetched)).toEqual(Array.from(original));
  });

  it('setMyGSK rejects non-32-byte input', async () => {
    await expect(setMyGSK('g', new Uint8Array(31))).rejects.toThrow();
    await expect(setMyGSK('g', new Uint8Array(33))).rejects.toThrow();
    await expect(setMyGSK('g', 'not-bytes')).rejects.toThrow();
  });

  it('createMyGSK + getMyGSK returns the same key (idempotent storage)', async () => {
    const created = await createMyGSK('group-idem');
    const fetched = await getMyGSK('group-idem');
    expect(Array.from(fetched)).toEqual(Array.from(created));
  });

  it('createMyGSK twice generates DIFFERENT keys (overwrites)', async () => {
    const first = await createMyGSK('group-overwrite');
    const second = await createMyGSK('group-overwrite');
    expect(Array.from(first)).not.toEqual(Array.from(second));
    // getMyGSK liefert jetzt den zweiten
    const fetched = await getMyGSK('group-overwrite');
    expect(Array.from(fetched)).toEqual(Array.from(second));
  });

  it('deleteMyGSK removes the entry', async () => {
    await createMyGSK('group-del');
    expect(await getMyGSK('group-del')).not.toBe(null);
    await deleteMyGSK('group-del');
    expect(await getMyGSK('group-del')).toBe(null);
  });

  it('GSK is stored encrypted (raw IDB blob != plaintext)', async () => {
    const gsk = await createMyGSK('group-enc-check');
    const raw = await idbGet('gsk:my:alice:group-enc-check');
    expect(raw).toBeTruthy();
    expect(raw.ivB64).toBeTruthy();
    expect(raw.ctB64).toBeTruthy();
    // raw.ctB64 sollte nicht der b64 des plaintext-GSK sein
    expect(raw.ctB64).not.toBe(bytesToB64(gsk));
  });

  it('group-id is lowercased in storage key', async () => {
    const gsk = await createMyGSK('GROUP-UPPER');
    // Lowercase-Variante muss gleichen GSK liefern
    expect(Array.from(await getMyGSK('group-upper'))).toEqual(Array.from(gsk));
    // Raw-IDB: nur lowercased Key existiert
    expect(await idbGet('gsk:my:alice:group-upper')).toBeTruthy();
    // Caps-variante darf nicht existieren — fake-indexeddb returnt null/undefined
    expect(await idbGet('gsk:my:alice:GROUP-UPPER')).toBeFalsy();
  });

  it('per-group isolation: different groups → different stored entries', async () => {
    const a = await createMyGSK('iso-a');
    const b = await createMyGSK('iso-b');
    expect(Array.from(a)).not.toEqual(Array.from(b));
    expect(await idbGet('gsk:my:alice:iso-a')).toBeTruthy();
    expect(await idbGet('gsk:my:alice:iso-b')).toBeTruthy();
  });

  it('per-group storage-key isolation: GSK von group-a kann nicht mit group-b key entschlüsselt werden', async () => {
    // Wir setzen für group-a ein GSK, dann tauschen wir manuell die ctB64 von a in b's slot.
    // Wenn der Storage-Key per-Group ist, muss b's getMyGSK fehlschlagen (und null returnen).
    await createMyGSK('iso-source');
    const sourceBlob = await idbGet('gsk:my:alice:iso-source');
    // In b's slot kopieren
    await idbSet('gsk:my:alice:iso-target', sourceBlob);
    // b's storage-key ist anders → decrypt failt → getMyGSK returns null (catch-Pfad)
    expect(await getMyGSK('iso-target')).toBe(null);
  });
});

// ======================================================
// 2. Peer-GSK Storage
// ======================================================

describe('GSK Storage: peer keys', () => {
  beforeEach(async () => {
    await resetIdb();
    await setupUser('alice');
    resetApiMock();
  });

  it('getPeerGSK returns null when never set', async () => {
    expect(await getPeerGSK('group', 'bob')).toBe(null);
  });

  it('setPeerGSK + getPeerGSK round-trip', async () => {
    const gsk = crypto.getRandomValues(new Uint8Array(32));
    await setPeerGSK('group-p', 'bob', gsk);
    const fetched = await getPeerGSK('group-p', 'bob');
    expect(Array.from(fetched)).toEqual(Array.from(gsk));
  });

  it('setPeerGSK rejects non-32-byte input', async () => {
    await expect(setPeerGSK('g', 'bob', new Uint8Array(10))).rejects.toThrow();
  });

  it('different peers in same group → different stored entries', async () => {
    const bobGsk = crypto.getRandomValues(new Uint8Array(32));
    const carolGsk = crypto.getRandomValues(new Uint8Array(32));
    await setPeerGSK('multi-peer', 'bob', bobGsk);
    await setPeerGSK('multi-peer', 'carol', carolGsk);
    expect(Array.from(await getPeerGSK('multi-peer', 'bob'))).toEqual(Array.from(bobGsk));
    expect(Array.from(await getPeerGSK('multi-peer', 'carol'))).toEqual(Array.from(carolGsk));
  });

  it('peer handle is lowercased', async () => {
    const gsk = crypto.getRandomValues(new Uint8Array(32));
    await setPeerGSK('g', 'BobMixed', gsk);
    expect(Array.from(await getPeerGSK('g', 'bobmixed'))).toEqual(Array.from(gsk));
  });

  it('deletePeerGSK removes only the targeted peer', async () => {
    await setPeerGSK('g', 'bob', crypto.getRandomValues(new Uint8Array(32)));
    await setPeerGSK('g', 'carol', crypto.getRandomValues(new Uint8Array(32)));
    await deletePeerGSK('g', 'bob');
    expect(await getPeerGSK('g', 'bob')).toBe(null);
    expect(await getPeerGSK('g', 'carol')).not.toBe(null);
  });
});

// ======================================================
// 3. Group-Cleanup
// ======================================================

describe('GSK Cleanup: deleteAllGSKsForGroup', () => {
  beforeEach(async () => {
    await resetIdb();
    await setupUser('alice');
    resetApiMock();
  });

  it('removes own GSK + all peer GSKs in the group', async () => {
    await createMyGSK('cleanup-group');
    await setPeerGSK('cleanup-group', 'bob', crypto.getRandomValues(new Uint8Array(32)));
    await setPeerGSK('cleanup-group', 'carol', crypto.getRandomValues(new Uint8Array(32)));
    // Aus einer ANDEREN Gruppe — darf nicht angefasst werden
    await createMyGSK('keep-group');
    await setPeerGSK('keep-group', 'dave', crypto.getRandomValues(new Uint8Array(32)));

    await deleteAllGSKsForGroup('cleanup-group');

    expect(await getMyGSK('cleanup-group')).toBe(null);
    expect(await getPeerGSK('cleanup-group', 'bob')).toBe(null);
    expect(await getPeerGSK('cleanup-group', 'carol')).toBe(null);
    // Andere Gruppe unangetastet
    expect(await getMyGSK('keep-group')).not.toBe(null);
    expect(await getPeerGSK('keep-group', 'dave')).not.toBe(null);
  });
});

// ======================================================
// 4. ECDH-Wrap/Unwrap-Roundtrip (durch Distribution + handleIncomingGSKMessage)
// ======================================================

describe('GSK ECDH Wrap/Unwrap (via send + receive)', () => {
  beforeEach(async () => {
    await resetIdb();
    resetApiMock();
  });

  it('full round-trip: alice sends GSK to bob → bob decrypts via handleIncomingGSKMessage', async () => {
    // 1. Alice setup
    const aliceSetup = await setupUser('alice');
    const aliceGsk = await createMyGSK('rt-group');

    // Bob's Keypair (extractable für JWK-Export)
    const bobPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true, ['deriveKey']
    );
    const bobPubJwk = await crypto.subtle.exportKey('jwk', bobPair.publicKey);

    // Capture alice's pubKey (für Bobs decrypt) BEVOR Wechsel zu bob's Setup
    const alicePubJwk = aliceSetup.myPubJwk;

    // Mock /e2e/inbox/get → liefert Bob's Device
    resetApiMock((path) => {
      if (path.startsWith('/e2e/inbox/get?user=bob')) {
        return { ok: true, data: { devices: [{ deviceId: 'dev_bob', jwk: bobPubJwk }] } };
      }
      // /chat/send → ok, payload wurde abgefangen via _apiCalls
      return { ok: true, data: {} };
    });

    const sendResult = await sendMyGSKToMember('rt-group', aliceGsk, 'bob');
    expect(sendResult.ok).toBe(true);
    // 1 chat/send Aufruf mit gewrapptem payload
    const chatSendCall = _apiCalls.find(c => c.path === '/chat/send');
    expect(chatSendCall).toBeTruthy();
    expect(chatSendCall.opts.body.type).toBe('gsk');
    expect(chatSendCall.opts.body.payloads.length).toBe(1);
    const payload = chatSendCall.opts.body.payloads[0];
    expect(payload.deviceId).toBe('dev_bob');
    expect(payload.fromDeviceId).toBe('dev_test_alice');
    expect(payload.ivB64).toBeTruthy();
    expect(payload.ctB64).toBeTruthy();

    // 2. Bob switch — neuer Tab, frische IDB. localStorage neu setzen, fresh setup
    await resetIdb();
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem('my_user', 'bob');
    globalThis.localStorage.setItem('device_id:bob', 'dev_bob');
    await idbSet('e2e-private-key', bobPair.privateKey);
    await idbSet('e2e-public-key', bobPair.publicKey);

    // Alice's Device im Peer-Cache (sonst kann Bob alice's pubJwk nicht finden)
    await storePeerDevices('alice', [{ deviceId: 'dev_test_alice', jwk: alicePubJwk }]);

    // 3. Bob empfängt GSK-Control-Message
    const incoming = {
      from: 'alice',
      to: 'bob',
      groupId: 'rt-group',
      deviceId: 'dev_test_alice',
      payloads: [payload],
    };
    const persisted = await handleIncomingGSKMessage(incoming);
    expect(persisted).toBe(true);

    // 4. Bob hat jetzt alice's GSK gespeichert
    const bobsViewOfAliceGsk = await getPeerGSK('rt-group', 'alice');
    expect(bobsViewOfAliceGsk).not.toBe(null);
    expect(Array.from(bobsViewOfAliceGsk)).toEqual(Array.from(aliceGsk));
  });

  it('handleIncomingGSKMessage: ignores own gsks (from === me)', async () => {
    await setupUser('alice');
    const fakeMsg = {
      from: 'alice',  // == me
      to: 'alice',
      groupId: 'g',
      payloads: [{ deviceId: 'dev_test_alice', ivB64: 'x', ctB64: 'y' }],
    };
    const persisted = await handleIncomingGSKMessage(fakeMsg);
    expect(persisted).toBe(false);
  });

  it('handleIncomingGSKMessage: ignores broadcast-echo (to !== me)', async () => {
    await setupUser('alice');
    const fakeMsg = {
      from: 'bob',
      to: 'carol',  // not me
      groupId: 'g',
      payloads: [{ deviceId: 'dev_test_alice', ivB64: 'x', ctB64: 'y' }],
    };
    expect(await handleIncomingGSKMessage(fakeMsg)).toBe(false);
  });

  it('handleIncomingGSKMessage: ignores when no payload matches my deviceId', async () => {
    await setupUser('alice');
    const fakeMsg = {
      from: 'bob',
      to: 'alice',
      groupId: 'g',
      payloads: [
        { deviceId: 'dev_someone_else', ivB64: 'x', ctB64: 'y' },
      ],
    };
    expect(await handleIncomingGSKMessage(fakeMsg)).toBe(false);
  });

  it('handleIncomingGSKMessage: returns false on missing groupId/from/payloads', async () => {
    await setupUser('alice');
    expect(await handleIncomingGSKMessage({})).toBe(false);
    expect(await handleIncomingGSKMessage({ from: 'bob' })).toBe(false);
    expect(await handleIncomingGSKMessage({ from: 'bob', groupId: 'g', payloads: [] })).toBe(false);
  });

  it('handleIncomingGSKMessage: silent failure on bad ECDH peer-jwk', async () => {
    // Bob empfängt scheinbare gsk von alice, aber alice's Pubkey im Cache ist falsch
    // → unwrap-failure muss false zurückgeben, nicht crashen.
    const bobSetup = await setupUser('bob');
    // Falscher alice-pubkey
    const bogusPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true, ['deriveKey']
    );
    const bogusJwk = await crypto.subtle.exportKey('jwk', bogusPair.publicKey);
    await storePeerDevices('alice', [{ deviceId: 'dev_alice', jwk: bogusJwk }]);

    // Wir erstellen ein KORREKT für bob gewrapptes payload, aber mit ECHTEM separatem alice-key
    const realAlicePair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true, ['deriveKey']
    );
    const fakeGsk = crypto.getRandomValues(new Uint8Array(32));
    const built = await buildIncomingGSKPayload({
      groupId: 'g', fromHandle: 'alice', fromDeviceId: 'dev_alice',
      toHandle: 'bob', toDeviceId: 'dev_test_bob',
      toPubJwk: bobSetup.myPubJwk, gskBytes: fakeGsk,
    });
    // Bob nutzt den FALSCHEN bogusJwk im Cache → ECDH-Decrypt failt
    resetApiMock(() => ({ ok: false }));
    const persisted = await handleIncomingGSKMessage(built.msg);
    expect(persisted).toBe(false);
  });
});

// ======================================================
// 5. Distribution APIs (mit Mock-Inspect)
// ======================================================

describe('GSK Distribution APIs', () => {
  beforeEach(async () => {
    await resetIdb();
    await setupUser('alice');
    resetApiMock();
  });

  it('sendMyGSKToMember returns ok:false when peer has no devices', async () => {
    resetApiMock((path) => {
      if (path.startsWith('/e2e/inbox/get')) return { ok: true, data: { devices: [] } };
      return { ok: true };
    });
    const r = await sendMyGSKToMember('g', crypto.getRandomValues(new Uint8Array(32)), 'ghost');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_devices');
  });

  it('distributeMyGSKToMembers excludes self from recipients', async () => {
    let inboxCalls = 0;
    resetApiMock((path) => {
      if (path.startsWith('/e2e/inbox/get')) {
        inboxCalls++;
        return { ok: true, data: { devices: [] } };
      }
      return { ok: true };
    });
    await distributeMyGSKToMembers(
      'g',
      crypto.getRandomValues(new Uint8Array(32)),
      ['alice', 'bob', 'carol']  // alice = self
    );
    // Nur bob+carol → 2 inbox-fetches, alice skipped
    expect(inboxCalls).toBe(2);
  });

  it('distributeMyGSKToMembers reports recipients count', async () => {
    resetApiMock((path) => {
      if (path.startsWith('/e2e/inbox/get')) return { ok: true, data: { devices: [] } };
      return { ok: true };
    });
    const r = await distributeMyGSKToMembers('g', crypto.getRandomValues(new Uint8Array(32)), ['bob', 'carol']);
    expect(r.recipients).toBe(2);
    // delivered = 0 weil keine Devices
    expect(r.delivered).toBe(0);
  });

  it('storeMyGSKForOwnDevices: skipped wenn nur eigenes Device existiert', async () => {
    resetApiMock((path) => {
      if (path.startsWith('/e2e/inbox/get')) {
        return { ok: true, data: { devices: [{ deviceId: 'dev_test_alice', jwk: {} }] } };
      }
      return { ok: true };
    });
    const r = await storeMyGSKForOwnDevices('g', crypto.getRandomValues(new Uint8Array(32)));
    expect(r.distributed).toBe(0);
    // /e2e/group-gsk/store wurde NICHT gerufen
    expect(_apiCalls.find(c => c.path === '/e2e/group-gsk/store')).toBeUndefined();
  });

  it('sendRequestGSK posts a request_gsk control', async () => {
    await sendRequestGSK('g', 'bob');
    const sent = _apiCalls.find(c => c.path === '/chat/send');
    expect(sent).toBeTruthy();
    expect(sent.opts.body.type).toBe('request_gsk');
    expect(sent.opts.body.requestedFrom).toBe('bob');
  });

  it('handleIncomingRequestGSK: ignored wenn requestedFrom !== me', async () => {
    const r = await handleIncomingRequestGSK({
      from: 'bob',
      requestedFrom: 'carol',  // not me
      groupId: 'g',
    });
    expect(r).toBe(false);
  });

  it('handleIncomingRequestGSK: triggert sendMyGSKToMember wenn requestedFrom === me', async () => {
    const aliceSetup = await setupUser('alice');
    await createMyGSK('g');

    // Bob's pubkey
    const bobPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true, ['deriveKey']
    );
    const bobPubJwk = await crypto.subtle.exportKey('jwk', bobPair.publicKey);

    resetApiMock((path) => {
      if (path.startsWith('/e2e/inbox/get?user=bob')) {
        return { ok: true, data: { devices: [{ deviceId: 'dev_bob', jwk: bobPubJwk }] } };
      }
      return { ok: true };
    });

    const r = await handleIncomingRequestGSK({
      from: 'bob',
      requestedFrom: 'alice',  // == me
      groupId: 'g',
    });
    expect(r).toBe(true);
    // chat/send mit type='gsk' ging raus
    const sent = _apiCalls.find(c => c.path === '/chat/send' && c.opts.body.type === 'gsk');
    expect(sent).toBeTruthy();
  });
});

// ======================================================
// 6. Lifecycle: ensureMyGSK / rotateMyGSK
// ======================================================

describe('GSK Lifecycle', () => {
  beforeEach(async () => {
    await resetIdb();
    await setupUser('alice');
    // Default Mock: kein Member hat Devices → reine Storage-Tests
    resetApiMock((path) => {
      if (path.startsWith('/e2e/inbox/get')) return { ok: true, data: { devices: [] } };
      if (path === '/e2e/group-gsk/fetch') return { ok: false };
      return { ok: true };
    });
  });

  it('ensureMyGSK: erstellt + persistiert wenn nicht vorhanden', async () => {
    expect(await getMyGSK('eg')).toBe(null);
    const gsk = await ensureMyGSK('eg', ['bob']);
    expect(gsk).toBeInstanceOf(Uint8Array);
    expect(gsk.length).toBe(32);
    // Persistiert
    expect(Array.from(await getMyGSK('eg'))).toEqual(Array.from(gsk));
  });

  it('ensureMyGSK: idempotent — zweiter Call liefert SAME bytes', async () => {
    const first = await ensureMyGSK('eg-idem', ['bob']);
    const second = await ensureMyGSK('eg-idem', ['bob']);
    expect(Array.from(first)).toEqual(Array.from(second));
  });

  it('ensureMyGSK: erzeugt frische GSK wenn KV-fetch ok=false', async () => {
    // Wenn /e2e/group-gsk/fetch nichts liefert → fallback zu createMyGSK
    resetApiMock((path) => {
      if (path === '/e2e/group-gsk/fetch') return { ok: false };
      if (path.startsWith('/e2e/inbox/get')) return { ok: true, data: { devices: [] } };
      return { ok: true };
    });
    const gsk = await ensureMyGSK('eg-no-kv', []);
    expect(gsk).toBeInstanceOf(Uint8Array);
    expect(gsk.length).toBe(32);
    expect(Array.from(await getMyGSK('eg-no-kv'))).toEqual(Array.from(gsk));
  });

  it('fetchMyGSKFromKV: returns null wenn KV antwortet mit ok=false', async () => {
    resetApiMock(() => ({ ok: false }));
    const result = await fetchMyGSKFromKV('any-group');
    expect(result).toBe(null);
  });

  it('fetchMyGSKFromKV: returns null wenn payload incomplete', async () => {
    resetApiMock(() => ({ ok: true, data: { payload: { ivB64: 'x' } } }));  // missing fromDeviceId, ctB64
    const result = await fetchMyGSKFromKV('any-group');
    expect(result).toBe(null);
  });

  it('rotateMyGSK: erzeugt einen FRISCHEN GSK ≠ alter', async () => {
    const oldGsk = await createMyGSK('rot');
    const r = await rotateMyGSK('rot', ['bob']);
    expect(r.ok).toBe(true);
    expect(r.newGsk).toBeInstanceOf(Uint8Array);
    expect(Array.from(r.newGsk)).not.toEqual(Array.from(oldGsk));
    // Persistiert ist der neue
    expect(Array.from(await getMyGSK('rot'))).toEqual(Array.from(r.newGsk));
  });

  it('ensureMyGSK: Multi-Device-User retried KV-fetch bevor createMyGSK (Race-Schutz)', async () => {
    // Regression-Schutz: Wenn ich >1 Device habe und lokal noch keine GSK
    // existiert, MUSS ensureMyGSK den KV-Fetch mehrfach versuchen — sonst
    // entstehen divergierende GSKs zwischen Devices, was beim Empfänger
    // (Peer-GSK ist handle-keyed) zu permanenten Decrypt-Fails führt.
    let fetchCalls = 0;
    resetApiMock((path) => {
      if (path.startsWith('/e2e/group-gsk/fetch')) {
        fetchCalls++;
        return { ok: false };
      }
      if (path.startsWith('/e2e/inbox/get')) {
        return {
          ok: true,
          data: { devices: [
            { deviceId: 'dev_test_alice', jwk: {} },
            { deviceId: 'dev_alice_OTHER', jwk: {} },
          ] },
        };
      }
      return { ok: true };
    });

    const gsk = await ensureMyGSK('eg-multi', []);
    expect(gsk).toBeInstanceOf(Uint8Array);
    // 1 initial + 4 retries (Backoff 400/800/1500/3000ms) = 5 Versuche
    expect(fetchCalls).toBeGreaterThanOrEqual(5);
  }, 10000);

  it('ensureMyGSK: Single-Device-User skipt Retry (sofort createMyGSK)', async () => {
    // Gegen-Test: kein Retry-Overhead wenn der User nur 1 Device hat.
    let fetchCalls = 0;
    resetApiMock((path) => {
      if (path.startsWith('/e2e/group-gsk/fetch')) {
        fetchCalls++;
        return { ok: false };
      }
      if (path.startsWith('/e2e/inbox/get')) {
        return {
          ok: true,
          data: { devices: [{ deviceId: 'dev_test_alice', jwk: {} }] },
        };
      }
      return { ok: true };
    });

    const gsk = await ensureMyGSK('eg-single', []);
    expect(gsk).toBeInstanceOf(Uint8Array);
    expect(fetchCalls).toBe(1); // genau 1 Versuch, kein Backoff
  });
});

// ======================================================
// 7. Read helpers
// ======================================================

describe('GSK Read Helpers', () => {
  beforeEach(async () => {
    await resetIdb();
    await setupUser('alice');
    resetApiMock();
  });

  it('getOrRequestPeerGSK: returns GSK when present', async () => {
    const gsk = crypto.getRandomValues(new Uint8Array(32));
    await setPeerGSK('g', 'bob', gsk);
    const fetched = await getOrRequestPeerGSK('g', 'bob');
    expect(Array.from(fetched)).toEqual(Array.from(gsk));
    // Kein request_gsk gesendet
    expect(_apiCalls.find(c => c.opts?.body?.type === 'request_gsk')).toBeUndefined();
  });

  it('getOrRequestPeerGSK: returns null + sends request_gsk wenn missing', async () => {
    const fetched = await getOrRequestPeerGSK('g', 'unknown_peer');
    expect(fetched).toBe(null);
    // request_gsk fire-and-forget — warten bis microtask propagiert
    await new Promise(r => setTimeout(r, 10));
    const sent = _apiCalls.find(c => c.opts?.body?.type === 'request_gsk');
    expect(sent).toBeTruthy();
    expect(sent.opts.body.requestedFrom).toBe('unknown_peer');
  });

  it('importGskAesKey produces a usable AES-GCM CryptoKey', async () => {
    const gskBytes = crypto.getRandomValues(new Uint8Array(32));
    const key = await importGskAesKey(gskBytes);
    // Roundtrip-Test
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, new TextEncoder().encode('hello')
    );
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, key, ct
    );
    expect(new TextDecoder().decode(pt)).toBe('hello');
  });
});

// ======================================================
// GSK Rotation Archive (15-Min-Edit-Window)
// ======================================================
// setMyGSK / setPeerGSK behalten den vorherigen Wert kurz im In-Memory-
// Archive, damit Edits älterer Messages noch decryptbar sind wenn die
// GSK seit Original-Send rotiert wurde.

describe('GSK Rotation Archive', () => {
  beforeEach(async () => {
    await resetIdb();
    await setupUser('alice');
    resetApiMock();
    clearGSKArchiveForGroup('group-archive-test');
    clearGSKArchiveForGroup('group-archive-peer');
  });

  it('findMyGSKAtTs returns null when no rotation has happened', async () => {
    const gid = 'group-archive-test';
    const gsk = crypto.getRandomValues(new Uint8Array(32));
    await setMyGSK(gid, gsk);
    // Kein archivierter Eintrag → null. Aktuell-Lookup ist nicht Sache des Archives.
    expect(findMyGSKAtTs(gid, Date.now() - 1000)).toBe(null);
  });

  it('setMyGSK twice archives the previous value, findMyGSKAtTs(originalTs) finds it', async () => {
    const gid = 'group-archive-test';
    const gskV1 = crypto.getRandomValues(new Uint8Array(32));
    const gskV2 = crypto.getRandomValues(new Uint8Array(32));

    await setMyGSK(gid, gskV1);
    const originalTs = Date.now();
    // Genug Pause damit replacedAt > originalTs (Date.now()-Granularität)
    await new Promise(r => setTimeout(r, 5));
    await setMyGSK(gid, gskV2);

    // Lookup mit originalTs → findet die archivierte v1, NICHT die aktuelle v2
    const found = findMyGSKAtTs(gid, originalTs);
    expect(found).not.toBe(null);
    expect(Array.from(found)).toEqual(Array.from(gskV1));
    // Aktuelle GSK ist v2 in IDB
    const current = await getMyGSK(gid);
    expect(Array.from(current)).toEqual(Array.from(gskV2));
  });

  it('findPeerGSKAtTs works analog to findMyGSKAtTs', async () => {
    const gid = 'group-archive-peer';
    const peer = 'bob';
    const v1 = crypto.getRandomValues(new Uint8Array(32));
    const v2 = crypto.getRandomValues(new Uint8Array(32));

    await setPeerGSK(gid, peer, v1);
    const originalTs = Date.now();
    await new Promise(r => setTimeout(r, 5));
    await setPeerGSK(gid, peer, v2);

    const found = findPeerGSKAtTs(gid, peer, originalTs);
    expect(found).not.toBe(null);
    expect(Array.from(found)).toEqual(Array.from(v1));
  });

  it('clearGSKArchiveForGroup removes own + peer entries for that group only', async () => {
    const gidA = 'group-archive-test';
    const gidB = 'group-other';
    const v1 = crypto.getRandomValues(new Uint8Array(32));
    const v2 = crypto.getRandomValues(new Uint8Array(32));

    // Beide Gruppen rotieren — beide haben Archiv-Einträge
    await setMyGSK(gidA, v1);
    await new Promise(r => setTimeout(r, 5));
    const tsA = Date.now() - 1;
    await setMyGSK(gidA, v2);
    await setMyGSK(gidB, v1);
    await new Promise(r => setTimeout(r, 5));
    const tsB = Date.now() - 1;
    await setMyGSK(gidB, v2);

    clearGSKArchiveForGroup(gidA);
    expect(findMyGSKAtTs(gidA, tsA)).toBe(null);
    expect(findMyGSKAtTs(gidB, tsB)).not.toBe(null);
  });

  it('findMyGSKAtTs returns null for ts after the latest rotation', async () => {
    const gid = 'group-archive-test';
    const v1 = crypto.getRandomValues(new Uint8Array(32));
    const v2 = crypto.getRandomValues(new Uint8Array(32));
    await setMyGSK(gid, v1);
    await new Promise(r => setTimeout(r, 5));
    await setMyGSK(gid, v2);
    // Lookup mit ts NACH der letzten Rotation → kein Archiveintrag deckt das ab
    expect(findMyGSKAtTs(gid, Date.now() + 60_000)).toBe(null);
  });
});

// ======================================================
// GSK Chain-Index (Forward-Secrecy in Group-Send)
// ======================================================
// Pro (groupId, myHandle) Counter, der bei jedem Send inkrementiert wird.
// Per-Message-MK = HKDF(GSK, info=`...:chainIndex`). Symmetrisch zu DM
// (deriveMessageKey aus session.js) und cross-frontend-kompatibel mit
// Vanilla-Encrypt-Pfad (groupSessionManager.js encryptGroupMessage).

describe('GSK Chain-Index', () => {
  beforeEach(async () => {
    await resetIdb();
    await setupUser('alice');
    resetApiMock();
  });

  it('peekGroupChainIndex returns 0 when never used', async () => {
    expect(await peekGroupChainIndex('group-fresh')).toBe(0);
  });

  it('nextGroupChainIndex returns current + persists current+1', async () => {
    const gid = 'group-counter';
    expect(await nextGroupChainIndex(gid)).toBe(0);
    expect(await peekGroupChainIndex(gid)).toBe(1);
    expect(await nextGroupChainIndex(gid)).toBe(1);
    expect(await peekGroupChainIndex(gid)).toBe(2);
    expect(await nextGroupChainIndex(gid)).toBe(2);
  });

  it('resetGroupChainIndex sets counter back to 0', async () => {
    const gid = 'group-reset';
    await nextGroupChainIndex(gid);
    await nextGroupChainIndex(gid);
    expect(await peekGroupChainIndex(gid)).toBe(2);
    await resetGroupChainIndex(gid);
    expect(await peekGroupChainIndex(gid)).toBe(0);
  });

  it('setMyGSK resets chainIndex automatically (rotation-on-rekey)', async () => {
    const gid = 'group-rekey';
    await nextGroupChainIndex(gid);
    await nextGroupChainIndex(gid);
    expect(await peekGroupChainIndex(gid)).toBe(2);
    // Neue GSK setzen → chainIndex muss 0 sein
    await setMyGSK(gid, crypto.getRandomValues(new Uint8Array(32)));
    expect(await peekGroupChainIndex(gid)).toBe(0);
  });

  it('chain-indices isolated per group', async () => {
    await nextGroupChainIndex('group-a');
    await nextGroupChainIndex('group-a');
    await nextGroupChainIndex('group-b');
    expect(await peekGroupChainIndex('group-a')).toBe(2);
    expect(await peekGroupChainIndex('group-b')).toBe(1);
  });
});

// ======================================================
// deriveGroupMessageKey: HKDF-Determinismus + Cross-Param-Isolation
// ======================================================
describe('deriveGroupMessageKey', () => {
  it('produces identical MK for same (gsk, groupId, sender, chainIndex)', async () => {
    const gsk = crypto.getRandomValues(new Uint8Array(32));
    const k1 = await deriveGroupMessageKey(gsk, 'g', 'alice', 5);
    const k2 = await deriveGroupMessageKey(gsk, 'g', 'alice', 5);
    // CryptoKey-Objects können nicht direkt verglichen werden — encrypt+decrypt
    // mit beiden bestätigt die Äquivalenz.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const pt = new TextEncoder().encode('roundtrip');
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k1, pt);
    const back = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k2, ct);
    expect(new TextDecoder().decode(back)).toBe('roundtrip');
  });

  it('different chainIndex → different MK (per-Message Forward-Secrecy)', async () => {
    const gsk = crypto.getRandomValues(new Uint8Array(32));
    const k0 = await deriveGroupMessageKey(gsk, 'g', 'alice', 0);
    const k1 = await deriveGroupMessageKey(gsk, 'g', 'alice', 1);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, k0, new TextEncoder().encode('msg0')
    );
    // k1 darf k0's ciphertext NICHT decrypten können
    await expect(
      crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k1, ct)
    ).rejects.toThrow();
  });

  it('different sender → different MK (cross-sender isolation)', async () => {
    const gsk = crypto.getRandomValues(new Uint8Array(32));
    const kA = await deriveGroupMessageKey(gsk, 'g', 'alice', 0);
    const kB = await deriveGroupMessageKey(gsk, 'g', 'bob', 0);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, kA, new TextEncoder().encode('from-alice')
    );
    await expect(
      crypto.subtle.decrypt({ name: 'AES-GCM', iv }, kB, ct)
    ).rejects.toThrow();
  });

  it('different groupId → different MK (cross-group isolation)', async () => {
    const gsk = crypto.getRandomValues(new Uint8Array(32));
    const k1 = await deriveGroupMessageKey(gsk, 'group-a', 'alice', 0);
    const k2 = await deriveGroupMessageKey(gsk, 'group-b', 'alice', 0);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, k1, new TextEncoder().encode('a')
    );
    await expect(
      crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k2, ct)
    ).rejects.toThrow();
  });

  it('different GSK → different MK (sanity)', async () => {
    const g1 = crypto.getRandomValues(new Uint8Array(32));
    const g2 = crypto.getRandomValues(new Uint8Array(32));
    const k1 = await deriveGroupMessageKey(g1, 'g', 'alice', 0);
    const k2 = await deriveGroupMessageKey(g2, 'g', 'alice', 0);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, k1, new TextEncoder().encode('x')
    );
    await expect(
      crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k2, ct)
    ).rejects.toThrow();
  });
});

// ======================================================
// Auto-Rotate Threshold Constant (NIST SP 800-38D §8.3)
// ======================================================
describe('ENCRYPT_ROTATE_THRESHOLD', () => {
  it('is exactly 2^32 (NIST-empfohlen für AES-GCM)', () => {
    expect(ENCRYPT_ROTATE_THRESHOLD).toBe(2 ** 32);
    expect(ENCRYPT_ROTATE_THRESHOLD).toBe(4_294_967_296);
  });

  it('is exported as a number (not bigint, JS-Number-safe)', () => {
    expect(typeof ENCRYPT_ROTATE_THRESHOLD).toBe('number');
    expect(Number.isInteger(ENCRYPT_ROTATE_THRESHOLD)).toBe(true);
    expect(Number.isSafeInteger(ENCRYPT_ROTATE_THRESHOLD)).toBe(true);
  });
});

// ======================================================
// GSK Sender-Signature (Defense-in-Depth gegen from-Spoofing)
// ======================================================
// signGskPayload signiert (groupId, ts, sha256(gsk)) mit ECDSA-Sig-Privkey
// des Senders. verifyGskPayload prüft mit Sender-SigPubkey aus Peer-Cache.
// Schützt gegen Backend-Manipulation des `from`-Felds zusätzlich zur
// ECDH-Symmetrie.

describe('GSK Sender-Sig', () => {
  /** Erzeugt ein ECDSA-P256-Keypair und installiert es in IDB unter dem
   *  Format das loadSigningPrivKey() erwartet: { pub: jwk, priv: CryptoKey }.
   *  Returnt das public-key-JWK für Verify-Tests. */
  async function setupSigningKey() {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true, ['sign', 'verify']
    );
    const pubJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    // IDB_SIG_KEYPAIR = 'sig_keypair', Format { pub, priv } (siehe e2eKeys.js)
    await idbSet('sig_keypair', { pub: pubJwk, priv: pair.privateKey });
    return pubJwk;
  }

  beforeEach(async () => {
    await resetIdb();
    await setupUser('alice');
  });

  it('round-trip: sign + verify with correct sigPub returns true', async () => {
    const sigPub = await setupSigningKey();
    const gsk = crypto.getRandomValues(new Uint8Array(32));
    const ts = Date.now();
    const sig = await signGskPayload('group-x', gsk, ts);
    expect(typeof sig).toBe('string');
    expect(sig.length).toBeGreaterThan(0);
    const ok = await verifyGskPayload(sig, sigPub, 'group-x', gsk, ts);
    expect(ok).toBe(true);
  });

  it('verify FAILS with wrong sigPub (different keypair = spoofed sender)', async () => {
    await setupSigningKey();
    const gsk = crypto.getRandomValues(new Uint8Array(32));
    const ts = Date.now();
    const sig = await signGskPayload('group-x', gsk, ts);
    // Anderer Pubkey als der zum Privkey passende
    const otherPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true, ['sign', 'verify']
    );
    const wrongPub = await crypto.subtle.exportKey('jwk', otherPair.publicKey);
    expect(await verifyGskPayload(sig, wrongPub, 'group-x', gsk, ts)).toBe(false);
  });

  it('verify FAILS with manipulated GSK bytes (Backend-Tampering)', async () => {
    const sigPub = await setupSigningKey();
    const gsk = crypto.getRandomValues(new Uint8Array(32));
    const ts = Date.now();
    const sig = await signGskPayload('group-x', gsk, ts);
    // Andere GSK in Verify
    const otherGsk = crypto.getRandomValues(new Uint8Array(32));
    expect(await verifyGskPayload(sig, sigPub, 'group-x', otherGsk, ts)).toBe(false);
  });

  it('verify FAILS with wrong groupId (cross-group replay-Schutz)', async () => {
    const sigPub = await setupSigningKey();
    const gsk = crypto.getRandomValues(new Uint8Array(32));
    const ts = Date.now();
    const sig = await signGskPayload('group-a', gsk, ts);
    expect(await verifyGskPayload(sig, sigPub, 'group-b', gsk, ts)).toBe(false);
  });

  it('verify FAILS with wrong ts (timestamp-Replay-Schutz)', async () => {
    const sigPub = await setupSigningKey();
    const gsk = crypto.getRandomValues(new Uint8Array(32));
    const ts = Date.now();
    const sig = await signGskPayload('group-x', gsk, ts);
    expect(await verifyGskPayload(sig, sigPub, 'group-x', gsk, ts + 1)).toBe(false);
  });

  it('verify defensively rejects malformed inputs', async () => {
    const sigPub = await setupSigningKey();
    const gsk = crypto.getRandomValues(new Uint8Array(32));
    const ts = Date.now();
    // null/undefined sig
    expect(await verifyGskPayload(null, sigPub, 'g', gsk, ts)).toBe(false);
    expect(await verifyGskPayload(undefined, sigPub, 'g', gsk, ts)).toBe(false);
    // null sigPub
    expect(await verifyGskPayload('zzzz', null, 'g', gsk, ts)).toBe(false);
    // sigPub mit `d` (privkey-Leak)
    const sigPubWithD = { ...sigPub, d: 'priv-leak' };
    expect(await verifyGskPayload('zzzz', sigPubWithD, 'g', gsk, ts)).toBe(false);
    // wrong gsk-length
    expect(await verifyGskPayload('zzzz', sigPub, 'g', new Uint8Array(31), ts)).toBe(false);
    // non-numeric ts
    expect(await verifyGskPayload('zzzz', sigPub, 'g', gsk, 'invalid')).toBe(false);
  });

  it('signGskPayload throws on invalid GSK length', async () => {
    await setupSigningKey();
    await expect(signGskPayload('g', new Uint8Array(31), Date.now())).rejects.toThrow();
    await expect(signGskPayload('g', new Uint8Array(33), Date.now())).rejects.toThrow();
  });
});

// ======================================================
// 9. Multi-Device (Phase 1C)
// ======================================================
// Tests für GSK-Re-Distribution bei device_added-Events.
// Spec: docs/GROUPS_MULTIDEVICE.md §4 (Sequence-Diagrams) + §6 (Test-Matrix).

import { redistributeGSKsForPeerDeviceAdded } from '../frontend/src/lib/groupCrypto.js';

// Helper: erzeugt n ECDH-Pubkeys für simulierte Peer-Devices
async function generatePeerDevices(handle, count) {
  const devices = [];
  for (let i = 0; i < count; i++) {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true, ['deriveKey']
    );
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    devices.push({ deviceId: `dev_${handle}_${i}`, jwk });
  }
  return devices;
}

describe('GSK Multi-Device — Self-Device-Add Race-Schutz', () => {
  beforeEach(async () => {
    await resetIdb();
    await setupUser('alice');
    resetApiMock();
  });

  it('storeMyGSKForOwnDevices ohne newDeviceInfo: nutzt direkten fetch (kein retry)', async () => {
    const aliceDevs = await generatePeerDevices('alice', 2);
    aliceDevs[0].deviceId = 'dev_test_alice'; // = current device, wird gefiltert
    let inboxCalls = 0;
    resetApiMock((path) => {
      if (path.startsWith('/e2e/inbox/get?user=alice')) {
        inboxCalls++;
        return { ok: true, data: { devices: aliceDevs } };
      }
      return { ok: true };
    });

    const gsk = crypto.getRandomValues(new Uint8Array(32));
    const r = await storeMyGSKForOwnDevices('g', gsk);
    expect(r.ok).toBe(true);
    expect(r.distributed).toBe(1); // nur das andere Device
    expect(inboxCalls).toBe(1); // kein retry
    const stored = _apiCalls.find(c => c.path === '/e2e/group-gsk/store');
    expect(stored).toBeTruthy();
    expect(stored.opts.body.payloads.length).toBe(1);
  });

  it('storeMyGSKForOwnDevices mit newDeviceInfo: retried bis neues Device im KV-Index', async () => {
    const aliceDevs = await generatePeerDevices('alice', 2);
    aliceDevs[0].deviceId = 'dev_test_alice'; // current
    const newDevice = aliceDevs[1];
    newDevice.deviceId = 'dev_alice_NEW';

    let inboxCalls = 0;
    resetApiMock((path) => {
      if (path.startsWith('/e2e/inbox/get?user=alice')) {
        inboxCalls++;
        // Erste 2 Calls: NEW-Device fehlt noch (KV-Eventual-Consistency).
        // Ab Call 3: NEW-Device da.
        const devs = inboxCalls < 3 ? [aliceDevs[0]] : aliceDevs;
        return { ok: true, data: { devices: devs } };
      }
      return { ok: true };
    });

    const gsk = crypto.getRandomValues(new Uint8Array(32));
    const r = await storeMyGSKForOwnDevices('g', gsk, {
      fromHandle: 'alice',
      deviceId: 'dev_alice_NEW',
      jwk: newDevice.jwk,
    });
    expect(r.ok).toBe(true);
    expect(r.distributed).toBe(1); // NEW-Device gewrapped
    expect(inboxCalls).toBeGreaterThanOrEqual(3); // mindestens 1 retry
    const stored = _apiCalls.find(c => c.path === '/e2e/group-gsk/store');
    expect(stored.opts.body.payloads[0].deviceId).toBe('dev_alice_NEW');
  }, 10000);

  it('storeMyGSKForOwnDevices: Push-Fallback wenn KV nie propagiert', async () => {
    const aliceDevs = await generatePeerDevices('alice', 2);
    aliceDevs[0].deviceId = 'dev_test_alice';
    const newJwk = aliceDevs[1].jwk;

    resetApiMock((path) => {
      if (path.startsWith('/e2e/inbox/get?user=alice')) {
        // KV propagiert NIE — alle Calls liefern nur current device
        return { ok: true, data: { devices: [aliceDevs[0]] } };
      }
      return { ok: true };
    });

    const gsk = crypto.getRandomValues(new Uint8Array(32));
    const r = await storeMyGSKForOwnDevices('g', gsk, {
      fromHandle: 'alice',
      deviceId: 'dev_alice_NEW',
      jwk: newJwk,
    });
    // Auch im Fallback-Pfad muss NEW-Device gewrapped werden (via Push-Info)
    expect(r.distributed).toBeGreaterThanOrEqual(1);
    const stored = _apiCalls.find(c => c.path === '/e2e/group-gsk/store');
    expect(stored.opts.body.payloads.some(p => p.deviceId === 'dev_alice_NEW')).toBe(true);
  }, 15000);
});

describe('GSK Multi-Device — Peer-Device-Add Re-Distribution', () => {
  beforeEach(async () => {
    await resetIdb();
    await setupUser('alice');
    resetApiMock();
  });

  it('redistributeGSKsForPeerDeviceAdded: noop bei leerer Gruppen-Liste', async () => {
    const r = await redistributeGSKsForPeerDeviceAdded('alice', 'bob', null, []);
    expect(r.ok).toBe(true);
    expect(r.distributed).toBe(0);
  });

  it('redistributeGSKsForPeerDeviceAdded: rejected wenn me === peer', async () => {
    const r = await redistributeGSKsForPeerDeviceAdded('alice', 'alice', null, [{ id: 'g1' }]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_handles');
  });

  it('redistributeGSKsForPeerDeviceAdded: skipt Gruppen ohne lokale My-GSK', async () => {
    // alice hat KEINE GSK in g1 oder g2
    let chatSendCalls = 0;
    resetApiMock((path) => {
      if (path.startsWith('/chat/send')) chatSendCalls++;
      return { ok: true, data: {} };
    });

    const r = await redistributeGSKsForPeerDeviceAdded(
      'alice', 'bob',
      { fromHandle: 'bob', deviceId: 'dev_bob_NEW', jwk: {} },
      [{ id: 'g1' }, { id: 'g2' }]
    );
    expect(r.distributed).toBe(0);
    expect(r.skipped).toBe(2);
    expect(chatSendCalls).toBe(0);
  });

  it('redistributeGSKsForPeerDeviceAdded: skipt Gruppen ohne Peer-Membership', async () => {
    await createMyGSK('g1');
    await createMyGSK('g2');

    resetApiMock((path) => {
      if (path.startsWith('/groups/members?groupId=g1')) {
        return { ok: true, data: { members: [{ member_handle: 'alice' }, { member_handle: 'carol' }] } };
      }
      if (path.startsWith('/groups/members?groupId=g2')) {
        return { ok: true, data: { members: [{ member_handle: 'alice' }] } };
      }
      if (path.startsWith('/e2e/inbox/get')) return { ok: true, data: { devices: [] } };
      return { ok: true, data: {} };
    });

    const r = await redistributeGSKsForPeerDeviceAdded(
      'alice', 'bob',
      { fromHandle: 'bob', deviceId: 'dev_bob_NEW', jwk: {} },
      [{ id: 'g1' }, { id: 'g2' }]
    );
    expect(r.distributed).toBe(0);
    expect(r.skipped).toBe(2);
    // chat/send NICHT gerufen — Peer ist in keiner Gruppe Member
    expect(_apiCalls.find(c => c.path === '/chat/send')).toBeUndefined();
  });

  it('redistributeGSKsForPeerDeviceAdded: sendet GSK an Peer-Device in jeder gemeinsamen Gruppe', async () => {
    await createMyGSK('g1');
    await createMyGSK('g2');
    const bobDevs = await generatePeerDevices('bob', 2);

    resetApiMock((path) => {
      if (path.startsWith('/groups/members?groupId=g1') ||
          path.startsWith('/groups/members?groupId=g2')) {
        return { ok: true, data: { members: [{ member_handle: 'alice' }, { member_handle: 'bob' }] } };
      }
      if (path.startsWith('/e2e/inbox/get?user=bob')) {
        return { ok: true, data: { devices: bobDevs } };
      }
      return { ok: true, data: {} };
    });

    const r = await redistributeGSKsForPeerDeviceAdded(
      'alice', 'bob',
      { fromHandle: 'bob', deviceId: bobDevs[1].deviceId, jwk: bobDevs[1].jwk },
      [{ id: 'g1' }, { id: 'g2' }]
    );
    expect(r.distributed).toBe(2);
    // Genau 2 chat/send Calls mit type:'gsk', je einer pro Gruppe
    const gskSends = _apiCalls.filter(c => c.path === '/chat/send' && c.opts.body.type === 'gsk');
    expect(gskSends.length).toBe(2);
    const groupIds = gskSends.map(c => c.opts.body.convoId).sort();
    expect(groupIds).toEqual(['g1', 'g2']);
    // Jeder Send wrapped beide Bob-Devices (alt + neu)
    for (const send of gskSends) {
      expect(send.opts.body.payloads.length).toBe(2);
    }
  });

  it('5×5 Stress: 5 Members × 5 Devices, neuer 6. Peer-Device → 1 Gruppe re-wrap', async () => {
    await createMyGSK('g-team');
    // Alice + 4 weitere Members
    const memberHandles = ['alice', 'bob', 'carol', 'dan', 'eve'];
    const bobDevs = await generatePeerDevices('bob', 6); // bob hat jetzt 6 Devices (5 alt + 1 neu)

    resetApiMock((path) => {
      if (path.startsWith('/groups/members?groupId=g-team')) {
        return { ok: true, data: { members: memberHandles.map(h => ({ member_handle: h })) } };
      }
      if (path.startsWith('/e2e/inbox/get?user=bob')) {
        return { ok: true, data: { devices: bobDevs } };
      }
      return { ok: true, data: {} };
    });

    const r = await redistributeGSKsForPeerDeviceAdded(
      'alice', 'bob',
      { fromHandle: 'bob', deviceId: bobDevs[5].deviceId, jwk: bobDevs[5].jwk },
      [{ id: 'g-team' }]
    );
    expect(r.distributed).toBe(1);
    // 6 Bob-Devices gewrapped (CHUNK=10 in sendMyGSKToMember → 1 chat/send call mit 6 payloads)
    const gskSend = _apiCalls.find(c => c.path === '/chat/send' && c.opts.body.type === 'gsk');
    expect(gskSend).toBeTruthy();
    expect(gskSend.opts.body.payloads.length).toBe(6);
    expect(gskSend.opts.body.payloads.some(p => p.deviceId === bobDevs[5].deviceId)).toBe(true);
  });
});
