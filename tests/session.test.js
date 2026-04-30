// ======================================================
// Unit-Tests für Session-Key-Pipeline
// ======================================================
// Spec: docs/MULTI_DEVICE.md §4.2 (Send-Flow)
//
// Kritische Garantien:
//   - dmSessionId ist deterministisch + alphabetisch sortiert
//   - peerFromDmSid round-trip
//   - deriveSessionKeyBytes ist deterministisch + CMK-empfindlich
//   - deriveMessageKey produziert nutzbaren AES-GCM-Key
//   - Rotation: gleiche CMK + sessionId aber unterschiedlicher Index → unterschiedliche SK
//   - findCmkForRotationIndex: korrekte CMK-Auswahl aus der Rotation-Map
// ======================================================
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import {
  dmSessionId,
  peerFromDmSid,
  deriveSessionKeyBytes,
  deriveSessionKeyBytesForRotation,
  deriveMessageKey,
  findCmkForRotationIndex,
  getRotationIndex,
  setRotationIndex,
  getRotationMap,
  appendToRotationMap,
} from '../frontend/src/lib/session.js';
import { e2eEncrypt, e2eDecrypt } from '../frontend/src/lib/chatCrypto.js';

// ======================================================
// dmSessionId — deterministisch + sortiert
// ======================================================
describe('dmSessionId', () => {
  it('returns deterministic id (alphabetic order)', () => {
    expect(dmSessionId('alice', 'bob')).toBe('dm:alice:bob');
    expect(dmSessionId('bob', 'alice')).toBe('dm:alice:bob');
  });

  it('lowercases inputs', () => {
    expect(dmSessionId('Alice', 'BOB')).toBe('dm:alice:bob');
  });

  it('handles digits and underscores', () => {
    expect(dmSessionId('user_42', 'admin1')).toBe('dm:admin1:user_42');
  });
});

describe('peerFromDmSid', () => {
  it('extracts peer from session id', () => {
    expect(peerFromDmSid('dm:alice:bob', 'alice')).toBe('bob');
    expect(peerFromDmSid('dm:alice:bob', 'bob')).toBe('alice');
  });

  it('returns null when me is not in session', () => {
    expect(peerFromDmSid('dm:alice:bob', 'charlie')).toBe(null);
  });

  it('returns null for invalid sid format', () => {
    expect(peerFromDmSid('not-a-sid', 'alice')).toBe(null);
    expect(peerFromDmSid('dm:only-one', 'alice')).toBe(null);
    expect(peerFromDmSid('group:abc', 'alice')).toBe(null);
    expect(peerFromDmSid(null, 'alice')).toBe(null);
  });
});

// ======================================================
// deriveSessionKeyBytes — HKDF aus CMK
// ======================================================
describe('deriveSessionKeyBytes', () => {
  it('produces 32 bytes', async () => {
    const cmk = crypto.getRandomValues(new Uint8Array(32));
    const sk = await deriveSessionKeyBytes(cmk, 'dm:alice:bob');
    expect(sk).toBeInstanceOf(Uint8Array);
    expect(sk.length).toBe(32);
  });

  it('is deterministic (same CMK + sid → same SK)', async () => {
    const cmk = crypto.getRandomValues(new Uint8Array(32));
    const sk1 = await deriveSessionKeyBytes(cmk, 'dm:alice:bob');
    const sk2 = await deriveSessionKeyBytes(cmk, 'dm:alice:bob');
    expect(Array.from(sk1)).toEqual(Array.from(sk2));
  });

  it('different sessionIds → different SKs', async () => {
    const cmk = crypto.getRandomValues(new Uint8Array(32));
    const sk1 = await deriveSessionKeyBytes(cmk, 'dm:alice:bob');
    const sk2 = await deriveSessionKeyBytes(cmk, 'dm:alice:charlie');
    expect(Array.from(sk1)).not.toEqual(Array.from(sk2));
  });

  it('different CMKs → different SKs', async () => {
    const cmk1 = crypto.getRandomValues(new Uint8Array(32));
    const cmk2 = crypto.getRandomValues(new Uint8Array(32));
    const sk1 = await deriveSessionKeyBytes(cmk1, 'dm:alice:bob');
    const sk2 = await deriveSessionKeyBytes(cmk2, 'dm:alice:bob');
    expect(Array.from(sk1)).not.toEqual(Array.from(sk2));
  });

  it('rejects invalid CMK', async () => {
    await expect(deriveSessionKeyBytes(new Uint8Array(31), 'dm:a:b')).rejects.toThrow();
    await expect(deriveSessionKeyBytes('not-bytes', 'dm:a:b')).rejects.toThrow();
  });
});

describe('deriveSessionKeyBytesForRotation', () => {
  it('rotationIndex 0 = same as deriveSessionKeyBytes (backward-compat)', async () => {
    const cmk = crypto.getRandomValues(new Uint8Array(32));
    const a = await deriveSessionKeyBytes(cmk, 'dm:alice:bob');
    const b = await deriveSessionKeyBytesForRotation(cmk, 'dm:alice:bob', 0);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('different rotationIndex → different SK', async () => {
    const cmk = crypto.getRandomValues(new Uint8Array(32));
    const sk0 = await deriveSessionKeyBytesForRotation(cmk, 'dm:alice:bob', 0);
    const sk1 = await deriveSessionKeyBytesForRotation(cmk, 'dm:alice:bob', 1);
    const sk2 = await deriveSessionKeyBytesForRotation(cmk, 'dm:alice:bob', 2);
    expect(Array.from(sk0)).not.toEqual(Array.from(sk1));
    expect(Array.from(sk1)).not.toEqual(Array.from(sk2));
  });
});

// ======================================================
// deriveMessageKey + Encrypt/Decrypt End-to-End
// ======================================================
describe('deriveMessageKey + e2eEncrypt round-trip', () => {
  it('end-to-end: same CMK + sid + epoch → encrypt/decrypt works', async () => {
    const cmk = crypto.getRandomValues(new Uint8Array(32));
    const sid = 'dm:alice:bob';
    const epoch = 42;

    const sk = await deriveSessionKeyBytes(cmk, sid);
    const mkAlice = await deriveMessageKey(sk, sid, epoch);
    const mkBob = await deriveMessageKey(sk, sid, epoch);

    const { ivB64, ctB64 } = await e2eEncrypt(mkAlice, 'Hallo Bob!');
    const decrypted = await e2eDecrypt(mkBob, ivB64, ctB64);
    expect(decrypted).toBe('Hallo Bob!');
  });

  it('different epoch → different MK → decrypt fails', async () => {
    const cmk = crypto.getRandomValues(new Uint8Array(32));
    const sid = 'dm:alice:bob';
    const sk = await deriveSessionKeyBytes(cmk, sid);

    const mk1 = await deriveMessageKey(sk, sid, 1);
    const mk2 = await deriveMessageKey(sk, sid, 2);

    const { ivB64, ctB64 } = await e2eEncrypt(mk1, 'secret');
    await expect(e2eDecrypt(mk2, ivB64, ctB64)).rejects.toThrow();
  });

  it('different rotation → different SK → different MK → decrypt fails', async () => {
    const cmk = crypto.getRandomValues(new Uint8Array(32));
    const sid = 'dm:alice:bob';
    const epoch = 1;

    const sk0 = await deriveSessionKeyBytesForRotation(cmk, sid, 0);
    const sk1 = await deriveSessionKeyBytesForRotation(cmk, sid, 1);
    const mk0 = await deriveMessageKey(sk0, sid, epoch);
    const mk1 = await deriveMessageKey(sk1, sid, epoch);

    const { ivB64, ctB64 } = await e2eEncrypt(mk0, 'secret');
    await expect(e2eDecrypt(mk1, ivB64, ctB64)).rejects.toThrow();
  });
});

// ======================================================
// findCmkForRotationIndex — Map-Lookup
// ======================================================
describe('findCmkForRotationIndex', () => {
  const cmkA = new Uint8Array(32).fill(1);
  const cmkB = new Uint8Array(32).fill(2);
  const cmkC = new Uint8Array(32).fill(3);

  const map = [
    { fromIndex: 0,   cmkBytes: Array.from(cmkA) },
    { fromIndex: 50,  cmkBytes: Array.from(cmkB) },
    { fromIndex: 100, cmkBytes: Array.from(cmkC) },
  ];

  it('returns cmkA for indices 0..49', () => {
    expect(Array.from(findCmkForRotationIndex(map, 0))).toEqual(Array.from(cmkA));
    expect(Array.from(findCmkForRotationIndex(map, 49))).toEqual(Array.from(cmkA));
  });

  it('returns cmkB for indices 50..99', () => {
    expect(Array.from(findCmkForRotationIndex(map, 50))).toEqual(Array.from(cmkB));
    expect(Array.from(findCmkForRotationIndex(map, 99))).toEqual(Array.from(cmkB));
  });

  it('returns cmkC for indices 100+', () => {
    expect(Array.from(findCmkForRotationIndex(map, 100))).toEqual(Array.from(cmkC));
    expect(Array.from(findCmkForRotationIndex(map, 999))).toEqual(Array.from(cmkC));
  });

  it('returns null on empty map', () => {
    expect(findCmkForRotationIndex([], 0)).toBe(null);
    expect(findCmkForRotationIndex(null, 0)).toBe(null);
    expect(findCmkForRotationIndex(undefined, 0)).toBe(null);
  });

  it('returns first entry if requested index is below first fromIndex', () => {
    // Map starts at 50 — requesting index 10 should fall back to first entry
    const oddMap = [{ fromIndex: 50, cmkBytes: Array.from(cmkB) }];
    expect(Array.from(findCmkForRotationIndex(oddMap, 10))).toEqual(Array.from(cmkB));
  });
});

// ======================================================
// IDB-State (Rotation-Index + Map) — fake-indexeddb
// ======================================================
describe('rotation IDB state', () => {
  it('getRotationIndex returns 0 by default', async () => {
    expect(await getRotationIndex('dm:fresh:1')).toBe(0);
  });

  it('setRotationIndex persists through getRotationIndex', async () => {
    await setRotationIndex('dm:state:1', 7);
    expect(await getRotationIndex('dm:state:1')).toBe(7);
  });

  it('getRotationMap returns [] by default', async () => {
    expect(await getRotationMap('dm:empty:1')).toEqual([]);
  });

  it('appendToRotationMap appends + filters duplicates', async () => {
    const sid = 'dm:append:1';
    const cmk1 = new Uint8Array(32).fill(1);
    const cmk2 = new Uint8Array(32).fill(2);

    await appendToRotationMap(sid, 0, cmk1);
    await appendToRotationMap(sid, 50, cmk2);

    const map = await getRotationMap(sid);
    expect(map.length).toBe(2);
    expect(map[0].fromIndex).toBe(0);
    expect(map[1].fromIndex).toBe(50);
  });

  it('appendToRotationMap with same fromIndex replaces', async () => {
    const sid = 'dm:replace:1';
    const cmk1 = new Uint8Array(32).fill(1);
    const cmk2 = new Uint8Array(32).fill(2);

    await appendToRotationMap(sid, 0, cmk1);
    await appendToRotationMap(sid, 0, cmk2);  // gleicher Index → ersetzt

    const map = await getRotationMap(sid);
    expect(map.length).toBe(1);
    expect(Array.from(map[0].cmkBytes)).toEqual(Array.from(cmk2));
  });

  it('appendToRotationMap caps at MAX_ROTATION_MAP_ENTRIES (50)', async () => {
    const sid = 'dm:cap:1';
    const cmk = new Uint8Array(32);
    for (let i = 0; i < 60; i++) {
      await appendToRotationMap(sid, i, cmk);
    }
    const map = await getRotationMap(sid);
    expect(map.length).toBeLessThanOrEqual(50);
    // Älteste werden entfernt → der erste sollte mindestens index >= 10 haben
    expect(map[0].fromIndex).toBeGreaterThanOrEqual(10);
  });
});
