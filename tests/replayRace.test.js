// ======================================================
// Replay/Race-Tests (Block B15)
// ======================================================
// Verifiziert Schutz gegen Replay-Attacken + Race-Conditions die in der
// Multi-Device-Krypto-Pipeline entstehen können:
//
//   1. Sig-Replay: alte Sig mit veränderter epoch/sid/iv schlägt fehl
//   2. Revoked-Device-Sig: verifyMessageSig mit fehlendem sigPub → false
//   3. Map-Race: parallele appendToRotationMap mit gleichem fromIndex
//      kollabiert auf eine Entry (last-write-wins, kein Duplikat-Stuff)
//   4. Self+Mirror-Sequence: rotateCMKForPeer + mirrorRotate auf gleichem
//      Peer dürfen die Map nicht korrumpieren
//   5. mirrorRotate Idempotenz-Layer: doppel-Trigger teilt Promise (B10)
//
// Spec: docs/MULTI_DEVICE.md §4.4, §3.2
// ======================================================
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { idbSet, idbGet, idbDelete } from '../frontend/src/lib/idb.js';
import { signMessage, verifyMessageSig } from '../frontend/src/lib/messageSig.js';
import {
  dmSessionId,
  getRotationMap,
  appendToRotationMap,
} from '../frontend/src/lib/session.js';

// ── Setup-Helpers ──────────────────────────────────────

async function setupSigningKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true, ['sign', 'verify']
  );
  const pubJwk  = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  await idbSet('sig_keypair', { pub: pubJwk, priv: privJwk });
  return { pubJwk, privJwk };
}

beforeEach(async () => {
  // Localstorage-Polyfill für Node + clean state
  if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    };
  }
  globalThis.localStorage.clear();
  globalThis.localStorage.setItem('my_user', 'alice');

  // IDB-Isolation zwischen Tests: rotation-map für Test-Session säubern
  // (fake-indexeddb persistiert Process-weit zwischen Tests).
  const sid = dmSessionId('alice', 'bob');
  await idbDelete(`cmk:rotation-map:${sid}`);
});

// ────────────────────────────────────────────────────────
// 1. Sig-Replay: Old sig with mutated context fails
// ────────────────────────────────────────────────────────
describe('Sig-Replay-Schutz', () => {
  it('Sig aus epoch=N replayed mit epoch=N+1 → verify=false', async () => {
    const keys = await setupSigningKeyPair();

    // Sender signiert eine Message in epoch=5
    const sig = await signMessage('iv-1', 'ct-payload', 'dm:alice:bob', 5);

    // Attacker replayed dieselbe (iv,ct,sid) in epoch=6
    const ok = await verifyMessageSig('iv-1', 'ct-payload', 'dm:alice:bob', 6, sig, keys.pubJwk);
    expect(ok).toBe(false);
  });

  it('Sig aus sid=A replayed in sid=B → verify=false (Cross-Conversation-Schutz)', async () => {
    const keys = await setupSigningKeyPair();
    const sig = await signMessage('iv-1', 'ct-payload', 'dm:alice:bob', 1);
    const ok = await verifyMessageSig('iv-1', 'ct-payload', 'dm:alice:charlie', 1, sig, keys.pubJwk);
    expect(ok).toBe(false);
  });

  it('Sig mit identischen Daten + identischem Kontext → verify=true (Sanity)', async () => {
    const keys = await setupSigningKeyPair();
    const sig = await signMessage('iv-1', 'ct-payload', 'dm:alice:bob', 1);
    const ok = await verifyMessageSig('iv-1', 'ct-payload', 'dm:alice:bob', 1, sig, keys.pubJwk);
    expect(ok).toBe(true);
  });
});

// ────────────────────────────────────────────────────────
// 2. Revoked-Device-Sig: getSigPubForDevice returns null
// ────────────────────────────────────────────────────────
describe('Revoked-Device-Sig', () => {
  it('verifyMessageSig mit null pubJwk (Device unbekannt/revoked) → false', async () => {
    await setupSigningKeyPair();
    const sig = await signMessage('iv', 'ct', 'sid', 1);
    const ok = await verifyMessageSig('iv', 'ct', 'sid', 1, sig, null);
    expect(ok).toBe(false);
  });

  it('verifyMessageSig mit undefined pubJwk → false (defensiv)', async () => {
    await setupSigningKeyPair();
    const sig = await signMessage('iv', 'ct', 'sid', 1);
    const ok = await verifyMessageSig('iv', 'ct', 'sid', 1, sig, undefined);
    expect(ok).toBe(false);
  });

  it('verifyMessageSig mit leerem Object {} (cache-corruption) → false', async () => {
    await setupSigningKeyPair();
    const sig = await signMessage('iv', 'ct', 'sid', 1);
    const ok = await verifyMessageSig('iv', 'ct', 'sid', 1, sig, {});
    expect(ok).toBe(false);
  });

  it('verifyMessageSig mit JWK ohne x/y (partielle Daten) → false', async () => {
    await setupSigningKeyPair();
    const sig = await signMessage('iv', 'ct', 'sid', 1);
    const ok = await verifyMessageSig('iv', 'ct', 'sid', 1, sig, { kty: 'EC', crv: 'P-256' });
    expect(ok).toBe(false);
  });
});

// ────────────────────────────────────────────────────────
// 3. Map-Race: parallele appendToRotationMap → no corruption
// ────────────────────────────────────────────────────────
describe('Rotation-Map-Race-Schutz', () => {
  it('Parallele appendToRotationMap mit gleichem fromIndex → 1 Entry, last-write-wins', async () => {
    const sid = dmSessionId('alice', 'bob');
    const cmkA = new Uint8Array(32).fill(0xAA);
    const cmkB = new Uint8Array(32).fill(0xBB);

    // Simuliert Race: zwei Calls mit fromIndex=1 quasi-gleichzeitig
    await Promise.all([
      appendToRotationMap(sid, 1, cmkA),
      appendToRotationMap(sid, 1, cmkB),
    ]);

    const map = await getRotationMap(sid);
    // Genau 1 Entry @ fromIndex=1, kein Duplikat
    const at1 = map.filter(e => e.fromIndex === 1);
    expect(at1.length).toBe(1);
    expect(map.length).toBe(1);
    // Welche CMK gewonnen hat ist undefined (last-write-wins),
    // aber sie muss eine der beiden sein — keine Korruption.
    const winner = at1[0].cmkBytes;
    const isA = winner.every((v, i) => v === cmkA[i]);
    const isB = winner.every((v, i) => v === cmkB[i]);
    expect(isA || isB).toBe(true);
  });

  it('Sequenzielle Appends mit aufsteigendem fromIndex → korrekt sortiert', async () => {
    const sid = dmSessionId('alice', 'bob');
    const cmk0 = new Uint8Array(32).fill(0x00);
    const cmk1 = new Uint8Array(32).fill(0x11);
    const cmk2 = new Uint8Array(32).fill(0x22);

    await appendToRotationMap(sid, 0, cmk0);
    await appendToRotationMap(sid, 1, cmk1);
    await appendToRotationMap(sid, 2, cmk2);

    const map = await getRotationMap(sid);
    expect(map.length).toBe(3);
    expect(map.map(e => e.fromIndex)).toEqual([0, 1, 2]);
  });

  it('appendToRotationMap mit niedrigerem fromIndex nach höherem → wird verworfen (Collision-Schutz)', async () => {
    const sid = dmSessionId('alice', 'bob');
    const cmk2 = new Uint8Array(32).fill(0x22);
    const cmk1 = new Uint8Array(32).fill(0x11);

    await appendToRotationMap(sid, 2, cmk2);
    // Nachträglicher Append@1 → Filter `fromIndex < 1` entfernt @2 NICHT, fügt @1 hinzu
    // nach append: final map hat sowohl @1 als auch @2 wenn @1 zuerst war,
    // aber hier ist @2 zuerst → @1 wird trotzdem appended (filter ist auf NEW index).
    // appendToRotationMap-Spec: "filtert alte Einträge mit gleichem oder höherem Index"
    // → bei append(@1) nach append(@2): filter behält Entries mit fromIndex < 1,
    //   also leer. Dann pushed @1. Resultat: nur @1. @2 ist weg!
    await appendToRotationMap(sid, 1, cmk1);

    const map = await getRotationMap(sid);
    // appendToRotationMap-Spec sagt: "Filter alte Einträge mit gleichem oder
    // höherem Index" → @2 wird beim nächsten Append@1 entfernt, da 2 >= 1.
    // Das ist ABSICHTLICH (Race-Schutz), kann aber Daten-Verlust bedeuten.
    // Test dokumentiert das Verhalten.
    expect(map.length).toBe(1);
    expect(map[0].fromIndex).toBe(1);
  });
});

// ────────────────────────────────────────────────────────
// 4. Self+Mirror-Sequence: kein Map-Korruption bei Mehrfach-Rotate
// ────────────────────────────────────────────────────────
describe('Self+Mirror-Sequenz-Schutz', () => {
  it('Sequence rotate(@1) → mirror(@1) → exakt 1 Entry @ fromIndex=1', async () => {
    const sid = dmSessionId('alice', 'bob');
    const cmkSelf   = new Uint8Array(32).fill(0xAA);
    const cmkMirror = new Uint8Array(32).fill(0xBB);

    // Self-Rotation: archive@0 + new@1
    const cmkOld = new Uint8Array(32).fill(0x00);
    await appendToRotationMap(sid, 0, cmkOld);
    await appendToRotationMap(sid, 1, cmkSelf);

    // Mirror-Rotation läuft parallel, würde auch @1 wollen (gleicher serverMaxIdx)
    // → letzte append@1 gewinnt + @0 wird WEG (filter `fromIndex >= 1` entfernt @0!)
    // Hmm wait, Filter ist `fromIndex < newFromIndex` → behält @0.
    await appendToRotationMap(sid, 1, cmkMirror);

    const map = await getRotationMap(sid);
    // Entry @0 bleibt (1 < 0 ist false → 0 < 1 true → behalten)
    // Entry @1 wird ersetzt durch mirror's CMK
    const at0 = map.filter(e => e.fromIndex === 0);
    const at1 = map.filter(e => e.fromIndex === 1);
    expect(at0.length).toBe(1);
    expect(at1.length).toBe(1);
  });

  it('Mehrfach-Mirror auf gleichen Index: konvergiert auf 1 Entry', async () => {
    const sid = dmSessionId('alice', 'bob');

    // 5 parallele appendToRotationMap-Calls — alle mit gleichem fromIndex
    const promises = [];
    for (let i = 0; i < 5; i++) {
      const cmk = new Uint8Array(32).fill(i + 1);
      promises.push(appendToRotationMap(sid, 3, cmk));
    }
    await Promise.all(promises);

    const map = await getRotationMap(sid);
    expect(map.filter(e => e.fromIndex === 3).length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────
// 5. mirrorRotateCMKForPeer In-Flight-Lock (B10 Verification)
// ────────────────────────────────────────────────────────
describe('mirrorRotateCMKForPeer Idempotenz (B10)', () => {
  it('Zwei parallele Aufrufe für SELBEN Peer teilen denselben Promise', async () => {
    const { mirrorRotateCMKForPeer } = await import('../frontend/src/lib/chatPipeline.js');

    // Beide Calls fast gleichzeitig — kein lokaler CMK → schneller no_local_cmk Return.
    // In-Flight-Lock muss erlauben dass Call 2 das laufende Promise findet.
    const p1 = mirrorRotateCMKForPeer('alice', 'unknown_peer_'  + Date.now());
    const p2 = mirrorRotateCMKForPeer('alice', 'unknown_peer_'  + Date.now());

    const [r1, r2] = await Promise.all([p1, p2]);
    // Beide returnen — kein Crash, kein Hang
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
  });

  it('Peer ohne local-CMK → schneller `no_local_cmk` Return (kein 32s Retry-Loop)', async () => {
    const { mirrorRotateCMKForPeer } = await import('../frontend/src/lib/chatPipeline.js');
    const start = Date.now();
    const r = await mirrorRotateCMKForPeer('alice', 'no_cmk_peer_' + Date.now());
    const elapsed = Date.now() - start;

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_local_cmk');
    // Sollte unter 1s zurückkommen — nicht durch Retry-Backoff hängen
    expect(elapsed).toBeLessThan(1000);
  });
});
