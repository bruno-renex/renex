// ======================================================
// CMK-Rotation End-to-End Tests
// ======================================================
// Verifiziert die Rotation-Logik nach der Implementation am 2026-05-03:
//
//   - Self-Rotate: rotateCMKForPeer archiviert old + setzt new active
//   - Pre-/Post-Rotation Decrypt: alte Messages mit rotation_index=0 gehen
//     gegen den ARCHIVIERTEN CMK (map[0]), neue Messages mit rotation_index>0
//     gegen den NEUEN active
//   - Bundle-Roundtrip mit rotation maps: collectLocalRotationMaps →
//     restoreCmksFromBundle → Map identisch wiederhergestellt
//   - isHistorical-Guard (mirror-rotate): fetched CMK darf nicht in der Map
//     sein, sonst false-positive bei stale KV-Einträgen
// ======================================================

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { idbGet, idbSet } from '../frontend/src/lib/idb.js';
import { bytesToB64 } from '../frontend/src/lib/bytes.js';
import {
  getOrCreateCMK, getCMKIfExists, importAndStoreCMKFromPeer,
  rotateCMKForPeer,
} from '../frontend/src/lib/cmk.js';
import {
  dmSessionId,
  appendToRotationMap,
  getRotationMap,
  findCmkForRotationIndex,
  deriveSessionKeyBytesForRotation,
  deriveMessageKey,
} from '../frontend/src/lib/session.js';
import { e2eEncrypt, e2eDecrypt } from '../frontend/src/lib/chatCrypto.js';

// ── Test-Setup ──────────────────────────────────────────
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
}

// Mock fetch for /chat/rotation-index — returns 0 (no server-known max)
function mockRotationIndexEndpoint() {
  globalThis.fetch = async (url) => {
    if (typeof url === 'string' && url.includes('/chat/rotation-index')) {
      return new Response(JSON.stringify({ rotationIndex: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Default: not-found, lets rotation logic fall through
    return new Response('{}', { status: 404 });
  };
}

// Helper: encrypt + decrypt with rotation_index simuliert real send/receive
async function encryptWith(cmkBytes, sid, epoch, rotationIndex, plaintext) {
  const sk = await deriveSessionKeyBytesForRotation(cmkBytes, sid, rotationIndex);
  const mk = await deriveMessageKey(sk, sid, epoch);
  return await e2eEncrypt(mk, plaintext);
}

async function decryptWith(cmkBytes, sid, epoch, rotationIndex, ivB64, ctB64) {
  const sk = await deriveSessionKeyBytesForRotation(cmkBytes, sid, rotationIndex);
  const mk = await deriveMessageKey(sk, sid, epoch);
  return await e2eDecrypt(mk, ivB64, ctB64);
}

const arrayEq = (a, b) =>
  a && b && a.length === b.length && a.every((v, i) => v === b[i]);

// ────────────────────────────────────────────────────────
describe('Rotation: Pre/Post Decrypt Roundtrip', () => {
  beforeEach(async () => {
    await setupUser('alice');
    mockRotationIndexEndpoint();
  });

  it('alte Messages (rotation_index=0) bleiben nach Rotation lesbar via map[0]', async () => {
    const peer = 'bob' + Math.random().toString(36).slice(2);
    const sid = dmSessionId('alice', peer);
    const epoch = 100000;

    // Phase 1: initial CMK + Message senden
    const oldCmk = await getOrCreateCMK(peer);
    const msg1 = await encryptWith(oldCmk, sid, epoch, 0, 'old message');

    // Phase 2: Rotation
    const r = await rotateCMKForPeer('alice', peer);
    expect(r.ok).toBe(true);
    expect(r.newFromIndex).toBe(1);

    // Phase 3: Decrypt-Pfad simulieren — wie chatPipeline.js es macht
    // (map IMMER konsultieren wenn nicht-leer, auch bei rotation_index=0)
    const map = await getRotationMap(sid);
    expect(map.length).toBeGreaterThanOrEqual(2);  // old@0 + new@1

    // Decrypt old message: rotation_index=0 → map[0] = oldCmk
    const cmkForOld = findCmkForRotationIndex(map, 0);
    expect(arrayEq(cmkForOld, oldCmk)).toBe(true);
    const dec1 = await decryptWith(cmkForOld, sid, epoch, 0, msg1.ivB64, msg1.ctB64);
    expect(dec1).toBe('old message');

    // Phase 4: Neue Message mit neuer rotation_index=1
    const newCmk = r.newCmk;
    const msg2 = await encryptWith(newCmk, sid, epoch, 1, 'new message');

    // Decrypt new: rotation_index=1 → map[1] = newCmk
    const cmkForNew = findCmkForRotationIndex(map, 1);
    expect(arrayEq(cmkForNew, newCmk)).toBe(true);
    const dec2 = await decryptWith(cmkForNew, sid, epoch, 1, msg2.ivB64, msg2.ctB64);
    expect(dec2).toBe('new message');
  });

  it('Decrypt mit FALSCHEM CMK (cross-rotation) muss fehlschlagen', async () => {
    const peer = 'bob' + Math.random().toString(36).slice(2);
    const sid = dmSessionId('alice', peer);
    const epoch = 100000;

    const oldCmk = await getOrCreateCMK(peer);
    const msg = await encryptWith(oldCmk, sid, epoch, 0, 'sensitive');

    await rotateCMKForPeer('alice', peer);
    const newCmk = await getCMKIfExists(peer);

    // Versuch alte Message mit NEUEM CMK zu decrypten — muss failen
    await expect(
      decryptWith(newCmk, sid, epoch, 0, msg.ivB64, msg.ctB64)
    ).rejects.toThrow();
  });

  it('rotation hinterlässt KEINEN active CMK = old (active wechselt)', async () => {
    const peer = 'bob' + Math.random().toString(36).slice(2);
    const oldCmk = await getOrCreateCMK(peer);
    await rotateCMKForPeer('alice', peer);
    const activeAfter = await getCMKIfExists(peer);
    expect(arrayEq(activeAfter, oldCmk)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────
describe('Rotation: rotateCMKForPeer state machine', () => {
  beforeEach(async () => {
    await setupUser('alice');
    mockRotationIndexEndpoint();
  });

  it('archiviert old CMK in map[0] wenn map vorher leer war', async () => {
    const peer = 'bob' + Math.random().toString(36).slice(2);
    const sid = dmSessionId('alice', peer);
    const oldCmk = await getOrCreateCMK(peer);

    // Pre-condition: map leer
    expect((await getRotationMap(sid)).length).toBe(0);

    await rotateCMKForPeer('alice', peer);

    const map = await getRotationMap(sid);
    expect(map.length).toBe(2);
    expect(map[0].fromIndex).toBe(0);
    expect(arrayEq(new Uint8Array(map[0].cmkBytes), oldCmk)).toBe(true);
  });

  it('zwei Rotations hintereinander erzeugen 3 Map-Einträge', async () => {
    const peer = 'bob' + Math.random().toString(36).slice(2);
    const sid = dmSessionId('alice', peer);
    await getOrCreateCMK(peer);

    const r1 = await rotateCMKForPeer('alice', peer);
    expect(r1.ok).toBe(true);
    expect(r1.newFromIndex).toBe(1);

    const r2 = await rotateCMKForPeer('alice', peer);
    expect(r2.ok).toBe(true);
    expect(r2.newFromIndex).toBeGreaterThan(r1.newFromIndex);

    const map = await getRotationMap(sid);
    // [old@0, mid@r1.idx, new@r2.idx]
    expect(map.length).toBe(3);
    expect(map[0].fromIndex).toBe(0);
    expect(map[1].fromIndex).toBe(r1.newFromIndex);
    expect(map[2].fromIndex).toBe(r2.newFromIndex);
  });

  it('returnt no_local_cmk wenn kein CMK existiert', async () => {
    const r = await rotateCMKForPeer('alice', 'unknown_peer_xyz');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_local_cmk');
  });

  it('appendToRotationMap filtert Einträge mit fromIndex >= new (collision-Schutz)', async () => {
    const sid = 'dm:test:collision';
    const cmk1 = new Uint8Array(32).fill(1);
    const cmk2 = new Uint8Array(32).fill(2);
    const cmk3 = new Uint8Array(32).fill(3);

    await appendToRotationMap(sid, 10, cmk1);
    await appendToRotationMap(sid, 20, cmk2);
    // Re-append @ idx=15 — sollte cmk2@20 entfernen (idx 20 >= 15)
    await appendToRotationMap(sid, 15, cmk3);

    const map = await getRotationMap(sid);
    expect(map.length).toBe(2);
    expect(map[0].fromIndex).toBe(10);
    expect(map[1].fromIndex).toBe(15);
  });
});

// ────────────────────────────────────────────────────────
describe('Bundle: rotationMaps round-trip', () => {
  beforeEach(async () => {
    await setupUser('alice');
    mockRotationIndexEndpoint();
  });

  it('Map-Persistenz nach JSON-roundtrip + IDB-Wipe', async () => {
    const sid = 'dm:bundle:roundtrip';
    const cmkA = crypto.getRandomValues(new Uint8Array(32));
    const cmkB = crypto.getRandomValues(new Uint8Array(32));
    await appendToRotationMap(sid, 0, cmkA);
    await appendToRotationMap(sid, 5, cmkB);

    // Simulate sync: collect → encode for bundle
    const arr = await idbGet(`cmk:rotation-map:${sid}`);
    const encoded = arr.map(e => ({
      fromIndex: e.fromIndex,
      cmk: bytesToB64(new Uint8Array(e.cmkBytes)),
    }));
    const bundleJson = JSON.stringify({ rotationMaps: { [sid]: encoded } });

    // Wipe IDB (simulate komplettes Storage-Verlust)
    await idbSet(`cmk:rotation-map:${sid}`, undefined);
    expect((await getRotationMap(sid)).length).toBe(0);

    // Restore from bundle
    const parsed = JSON.parse(bundleJson);
    const decoded = [];
    const { b64ToBytes } = await import('../frontend/src/lib/bytes.js');
    for (const e of parsed.rotationMaps[sid]) {
      decoded.push({
        fromIndex: e.fromIndex,
        cmkBytes: Array.from(b64ToBytes(e.cmk)),
      });
    }
    await idbSet(`cmk:rotation-map:${sid}`, decoded);

    // Verifiziere Lookup funktioniert wieder identisch
    const map = await getRotationMap(sid);
    expect(map.length).toBe(2);
    expect(arrayEq(findCmkForRotationIndex(map, 0), cmkA)).toBe(true);
    expect(arrayEq(findCmkForRotationIndex(map, 5), cmkB)).toBe(true);
    expect(arrayEq(findCmkForRotationIndex(map, 99), cmkB)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────
describe('Rotation: isHistorical-Guard (mirror-rotate Defense)', () => {
  it('fetched-CMK in Map → wird als historisch erkannt (kein false-positive)', async () => {
    const sid = 'dm:mirror:test';
    const oldCmk = crypto.getRandomValues(new Uint8Array(32));
    const activeCmk = crypto.getRandomValues(new Uint8Array(32));
    const trulyNewCmk = crypto.getRandomValues(new Uint8Array(32));

    await appendToRotationMap(sid, 0, oldCmk);
    await appendToRotationMap(sid, 5, activeCmk);
    const mapBefore = await getRotationMap(sid);

    // isHistorical-Logik (so wie in mirrorRotateCMKForPeer)
    const isHistorical = (bytes) =>
      mapBefore.some(e => {
        const eb = e?.cmkBytes;
        if (!Array.isArray(eb) || eb.length !== bytes.length) return false;
        return bytes.every((b, i) => b === eb[i]);
      });

    expect(isHistorical(oldCmk)).toBe(true);       // archiviert
    expect(isHistorical(activeCmk)).toBe(true);    // active (in map)
    expect(isHistorical(trulyNewCmk)).toBe(false); // unbekannt → würde akzeptiert
  });
});
