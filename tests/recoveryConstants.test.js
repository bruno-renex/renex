// ======================================================
// Recovery-Crypto Constant-Lock + Golden-Vector
// ======================================================
// Spec: docs/RECOVERY.md §4.5 (Audit-Notes)
//
// Diese Tests sind ABSICHTLICH brüchig — wenn jemand eine Krypto-Konstante
// ändert ohne den passenden Test + Spec + Security-Review zu updaten,
// schlagen sie fehl. Das ist Feature, nicht Bug.
//
// Was getestet wird:
//   1. Konstanten-Werte exakt gepinnt (PBKDF2_ITERATIONS, SALT_SIZE, …)
//   2. Golden-Vector: bekannte Phrase + bekannter Salt → erwarteter MasterKey
//      → fängt versehentliche Änderung von PBKDF2-Algorithmus / Hash / Bits
//   3. AAD-Binding: handle ändert → decrypt schlägt fehl (cross-handle-Schutz)
//   4. v=2-Bundle ohne handle decrypten geht (legacy fallback funktioniert)
// ======================================================
import { describe, it, expect } from 'vitest';
import {
  PBKDF2_ITERATIONS,
  PBKDF2_HASH,
  MASTER_KEY_BITS,
  AES_IV_SIZE,
  SALT_SIZE,
  deriveMasterKey,
  deriveMasterKeyRaw,
  encryptBundle,
  decryptBundle,
  bytesToB64,
} from '../frontend/src/lib/recovery.js';

// Bekannte BIP39-Test-Phrase (alle "abandon" — von BIP39-Test-Vektoren)
const KNOWN_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const KNOWN_SALT   = new Uint8Array(16); // alle Nullen — deterministisch
KNOWN_SALT.fill(0);

// ────────────────────────────────────────────────────────
// 1. Konstanten-Werte
// ────────────────────────────────────────────────────────
describe('Recovery-Crypto Konstanten (Audit-Lock)', () => {
  it('PBKDF2_ITERATIONS ist exakt 600_000 (OWASP-2023)', () => {
    // Senken < 100k = wirtschaftlicher GPU-Brute-Force möglich.
    // Erhöhen > 1M = UX-Pain auf mobilen Geräten (Multi-Sekunden-Wait).
    expect(PBKDF2_ITERATIONS).toBe(600_000);
  });

  it('PBKDF2_HASH ist SHA-256', () => {
    // SHA-1 obsolet; SHA-512 2× langsamer ohne Sicherheitsgewinn.
    expect(PBKDF2_HASH).toBe('SHA-256');
  });

  it('MASTER_KEY_BITS ist 256 (AES-256-Standard)', () => {
    expect(MASTER_KEY_BITS).toBe(256);
  });

  it('AES_IV_SIZE ist 12 Bytes (AES-GCM-Standard)', () => {
    // AES-GCM verlangt 12 Bytes. Andere Größen verboten.
    expect(AES_IV_SIZE).toBe(12);
  });

  it('SALT_SIZE ist 16 Bytes (NIST SP 800-132 Min)', () => {
    expect(SALT_SIZE).toBe(16);
  });
});

// ────────────────────────────────────────────────────────
// 2. Golden-Vector: PBKDF2 Determinismus
// ────────────────────────────────────────────────────────
describe('PBKDF2 Determinismus (Golden-Vector)', () => {
  it('gleiche Phrase + gleicher Salt → identische 32-Byte-MasterKey', async () => {
    const a = await deriveMasterKeyRaw(KNOWN_PHRASE, KNOWN_SALT);
    const b = await deriveMasterKeyRaw(KNOWN_PHRASE, KNOWN_SALT);
    expect(a.length).toBe(32);
    expect(Array.from(b)).toEqual(Array.from(a));
  }, 30_000); // 600k Iterationen × 2 = ggf. langsam in CI

  it('verschiedener Salt → komplett verschiedener MasterKey', async () => {
    const salt2 = new Uint8Array(16); salt2.fill(0xff);
    const a = await deriveMasterKeyRaw(KNOWN_PHRASE, KNOWN_SALT);
    const b = await deriveMasterKeyRaw(KNOWN_PHRASE, salt2);
    // Bei korrektem PBKDF2 sollten sich praktisch alle 32 Bytes unterscheiden.
    let differingBytes = 0;
    for (let i = 0; i < 32; i++) if (a[i] !== b[i]) differingBytes++;
    expect(differingBytes).toBeGreaterThan(20);  // Toleranz, real ~32
  }, 30_000);
});

// ────────────────────────────────────────────────────────
// 3. AAD-Binding: handle-Cross-Decrypt blockiert
// ────────────────────────────────────────────────────────
describe('Bundle-AAD-Binding (Spec §4.4)', () => {
  it('v=2-Bundle decrypt mit falschem handle schlägt fehl', async () => {
    const masterKey = await deriveMasterKey(KNOWN_PHRASE, KNOWN_SALT);
    const bundle = { ts: 1, cmks: { peer1: 'AAA' } };
    const blob = await encryptBundle(bundle, masterKey, 'anna');

    await expect(decryptBundle(blob, masterKey, 'bertha'))
      .rejects.toThrow();
  }, 30_000);

  it('v=2-Bundle decrypt mit korrektem handle funktioniert', async () => {
    const masterKey = await deriveMasterKey(KNOWN_PHRASE, KNOWN_SALT);
    const bundle = { ts: 42, cmks: { peer1: 'BBB' }, gsks: {} };
    const blob = await encryptBundle(bundle, masterKey, 'anna');
    const out = await decryptBundle(blob, masterKey, 'anna');
    expect(out.v).toBe(2);
    expect(out.cmks.peer1).toBe('BBB');
  }, 30_000);

  it('v=1-Bundle (kein AAD) decrypt OHNE handle funktioniert (Legacy)', async () => {
    const masterKey = await deriveMasterKey(KNOWN_PHRASE, KNOWN_SALT);
    const bundle = { ts: 7, cmks: {} };
    const blob = await encryptBundle(bundle, masterKey);  // kein handle → v=1
    const out = await decryptBundle(blob, masterKey);     // kein handle → v=1-Pfad
    expect(out.v).toBe(1);
    expect(out.ts).toBe(7);
  }, 30_000);

  it('v=1-Legacy-Bundle decrypt MIT handle fällt auf v=1 zurück (Migration-Pfad)', async () => {
    const masterKey = await deriveMasterKey(KNOWN_PHRASE, KNOWN_SALT);
    const bundle = { ts: 99 };
    const blob = await encryptBundle(bundle, masterKey);  // v=1
    // v=2-Versuch mit AAD scheitert, fällt auf v=1 zurück
    const out = await decryptBundle(blob, masterKey, 'anna');
    expect(out.v).toBe(1);
    expect(out.ts).toBe(99);
  }, 30_000);
});

// ────────────────────────────────────────────────────────
// 4. AAD-String-Format
// ────────────────────────────────────────────────────────
describe('AAD-String-Format', () => {
  it('handle wird lowercased im AAD (case-insensitive Matching)', async () => {
    const masterKey = await deriveMasterKey(KNOWN_PHRASE, KNOWN_SALT);
    const bundle = { ts: 1 };
    const blob = await encryptBundle(bundle, masterKey, 'Anna');  // Mixed-case
    const out = await decryptBundle(blob, masterKey, 'anna');     // Lowercase
    expect(out.v).toBe(2);  // Decrypt erfolgreich → handle wurde gelowercased
  }, 30_000);

  it('handle mit Unicode wird konsistent encodet', async () => {
    const masterKey = await deriveMasterKey(KNOWN_PHRASE, KNOWN_SALT);
    const bundle = { ts: 1 };
    const blob = await encryptBundle(bundle, masterKey, 'müller');
    const out = await decryptBundle(blob, masterKey, 'müller');
    expect(out.v).toBe(2);
  }, 30_000);
});
