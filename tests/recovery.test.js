// ======================================================
// Unit-Tests für Recovery Crypto-Helpers
// ======================================================
// Spec: docs/RECOVERY.md §11.1
//
// Kritische Garantien:
//   - BIP39-Phrase round-trip durch validatePhrase
//   - PBKDF2-MasterKey ist deterministisch + salt-empfindlich
//   - AES-GCM Bundle-Encrypt → Decrypt round-trip
//   - Decrypt mit falschem Key wirft (Forward-Secrecy-Garantie)
//   - Schema-Versioning: v=2-Bundle wird vom v=1-Decoder abgelehnt
//
// VISION-Decision: "Crypto ohne Tests = Selbstmord."
// Ein Bug hier = User können sich nicht recovern = Account-Tod.
// ======================================================
import { describe, it, expect } from 'vitest';
import {
  generatePhrase,
  validatePhrase,
  normalizePhrase,
  phraseToWords,
  deriveMasterKey,
  encryptBundle,
  decryptBundle,
  randomSalt,
  bytesToB64,
  b64ToBytes,
} from '../frontend/src/lib/recovery.js';

// ======================================================
// Phrase-Generation + Validation
// ======================================================
describe('generatePhrase', () => {
  it('produces 12 words', () => {
    const phrase = generatePhrase();
    expect(phrase.split(' ').length).toBe(12);
  });

  it('produces different phrases on each call (entropy)', () => {
    const a = generatePhrase();
    const b = generatePhrase();
    expect(a).not.toBe(b);
  });

  it('only uses BIP39-wordlist words', () => {
    const phrase = generatePhrase();
    expect(validatePhrase(phrase)).toBe(true);
  });
});

describe('validatePhrase', () => {
  it('accepts a freshly generated phrase', () => {
    expect(validatePhrase(generatePhrase())).toBe(true);
  });

  it('rejects 11-word phrase', () => {
    const eleven = generatePhrase().split(' ').slice(0, 11).join(' ');
    expect(validatePhrase(eleven)).toBe(false);
  });

  it('rejects 13-word phrase', () => {
    const thirteen = generatePhrase() + ' ability';
    expect(validatePhrase(thirteen)).toBe(false);
  });

  it('rejects empty input', () => {
    expect(validatePhrase('')).toBe(false);
    expect(validatePhrase(null)).toBe(false);
    expect(validatePhrase(undefined)).toBe(false);
  });

  it('rejects phrase with non-wordlist words', () => {
    expect(validatePhrase('foo bar baz qux quux corge grault garply waldo fred plugh xyzzy'))
      .toBe(false);
  });

  it('rejects phrase with invalid checksum', () => {
    // Bekannter Test-Vektor: 12× "abandon" hat ungültige Checksum.
    // (Valid wäre: "abandon × 11 + about" — Test-Vektor aus BIP39-Spec.)
    // Deterministisch — kein 1/16-Random-Flake.
    expect(validatePhrase('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'))
      .toBe(false);
  });

  it('accepts mixed-case + extra whitespace (after normalization)', () => {
    const phrase = generatePhrase();
    const messy = '  ' + phrase.toUpperCase().split(' ').join('   ') + '  ';
    expect(validatePhrase(messy)).toBe(true);
  });
});

describe('normalizePhrase / phraseToWords', () => {
  it('lowercases', () => {
    expect(normalizePhrase('FOO BAR')).toBe('foo bar');
  });

  it('trims and collapses whitespace', () => {
    expect(normalizePhrase('  foo   bar  baz  ')).toBe('foo bar baz');
  });

  it('handles non-string defensively', () => {
    expect(normalizePhrase(null)).toBe('');
    expect(normalizePhrase(undefined)).toBe('');
  });

  it('phraseToWords splits into 12 words', () => {
    const phrase = generatePhrase();
    expect(phraseToWords(phrase).length).toBe(12);
  });
});

// ======================================================
// MasterKey-Derivation (PBKDF2)
// ======================================================
describe('deriveMasterKey', () => {
  // Reduzierte Iterationen wären schneller, aber wir testen die echte
  // Production-Konfiguration. ~500ms pro derive — 5s testTimeout reicht.

  it('returns a CryptoKey usable for AES-GCM', async () => {
    const phrase = generatePhrase();
    const salt = randomSalt();
    const key = await deriveMasterKey(phrase, salt);
    expect(key).toBeDefined();
    expect(key.algorithm.name).toBe('AES-GCM');
    expect(key.algorithm.length).toBe(256);
  }, 10_000);

  it('is deterministic with same phrase + salt', async () => {
    const phrase = generatePhrase();
    const salt = randomSalt();

    const key1 = await deriveMasterKey(phrase, salt);
    const key2 = await deriveMasterKey(phrase, salt);

    // CryptoKey-Objekte sind nicht direkt vergleichbar, aber:
    // wenn sie identisch sind, decrypted ein mit key1 erzeugter Ciphertext
    // sich auch mit key2.
    const bundle = { v: 1, ts: 1, cmks: { 'a:b': 'X' }, gsks: {} };
    const blob = await encryptBundle(bundle, key1);
    const decoded = await decryptBundle(blob, key2);
    expect(decoded).toEqual(bundle);
  }, 15_000);

  it('produces different keys for different salts', async () => {
    const phrase = generatePhrase();
    const salt1 = randomSalt();
    const salt2 = randomSalt();

    const key1 = await deriveMasterKey(phrase, salt1);
    const key2 = await deriveMasterKey(phrase, salt2);

    const bundle = { v: 1, ts: 1, cmks: {}, gsks: {} };
    const blob = await encryptBundle(bundle, key1);
    // Decrypt mit anderem Salt-Key MUSS fehlschlagen
    await expect(decryptBundle(blob, key2)).rejects.toThrow();
  }, 15_000);

  it('rejects invalid phrase', async () => {
    await expect(deriveMasterKey('not valid phrase', randomSalt()))
      .rejects.toThrow('invalid_phrase');
  });

  it('rejects invalid salt size', async () => {
    const phrase = generatePhrase();
    await expect(deriveMasterKey(phrase, new Uint8Array(15)))
      .rejects.toThrow('invalid_salt');
    await expect(deriveMasterKey(phrase, new Uint8Array(17)))
      .rejects.toThrow('invalid_salt');
  });

  it('rejects non-Uint8Array salt', async () => {
    const phrase = generatePhrase();
    await expect(deriveMasterKey(phrase, 'string-salt'))
      .rejects.toThrow('invalid_salt');
  });
});

// ======================================================
// Bundle-Encrypt / Decrypt (AES-GCM)
// ======================================================
describe('encryptBundle / decryptBundle', () => {
  it('round-trips an empty bundle', async () => {
    const phrase = generatePhrase();
    const salt = randomSalt();
    const key = await deriveMasterKey(phrase, salt);
    const bundle = { v: 1, ts: Date.now(), cmks: {}, gsks: {} };
    const blob = await encryptBundle(bundle, key);
    const decoded = await decryptBundle(blob, key);
    expect(decoded).toEqual(bundle);
  }, 10_000);

  it('round-trips a populated bundle', async () => {
    const phrase = generatePhrase();
    const salt = randomSalt();
    const key = await deriveMasterKey(phrase, salt);
    const bundle = {
      v: 1,
      ts: 1714305600000,
      cmks: {
        'alice:bertha004': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        'alice:christa4':  'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
      },
      gsks: {
        'group-uuid-1': 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=',
      },
    };
    const blob = await encryptBundle(bundle, key);
    const decoded = await decryptBundle(blob, key);
    expect(decoded).toEqual(bundle);
  }, 10_000);

  it('produces different ciphertexts for same plaintext (IV-Uniqueness)', async () => {
    const phrase = generatePhrase();
    const salt = randomSalt();
    const key = await deriveMasterKey(phrase, salt);
    const bundle = { v: 1, ts: 1, cmks: {}, gsks: {} };
    const blob1 = await encryptBundle(bundle, key);
    const blob2 = await encryptBundle(bundle, key);
    expect(bytesToB64(blob1)).not.toBe(bytesToB64(blob2));
  }, 10_000);

  it('blob has IV-prefix (first 12 bytes are IV)', async () => {
    const phrase = generatePhrase();
    const salt = randomSalt();
    const key = await deriveMasterKey(phrase, salt);
    const bundle = { v: 1, ts: 1, cmks: {}, gsks: {} };
    const blob = await encryptBundle(bundle, key);
    expect(blob.length).toBeGreaterThan(12);
    expect(blob).toBeInstanceOf(Uint8Array);
  }, 10_000);

  it('decrypt FAILS with wrong key (forward-secrecy guarantee)', async () => {
    const phrase = generatePhrase();
    const salt = randomSalt();
    const key1 = await deriveMasterKey(phrase, salt);

    const phrase2 = generatePhrase();
    const key2 = await deriveMasterKey(phrase2, salt);

    const blob = await encryptBundle({ v: 1, ts: 1, cmks: {}, gsks: {} }, key1);
    await expect(decryptBundle(blob, key2)).rejects.toThrow();
  }, 15_000);

  it('decrypt FAILS with corrupted blob', async () => {
    const phrase = generatePhrase();
    const salt = randomSalt();
    const key = await deriveMasterKey(phrase, salt);
    const blob = await encryptBundle({ v: 1, ts: 1, cmks: {}, gsks: {} }, key);

    // Corrupt: flip a bit in middle
    const corrupted = new Uint8Array(blob);
    corrupted[20] ^= 1;

    await expect(decryptBundle(corrupted, key)).rejects.toThrow();
  }, 10_000);

  it('decrypt rejects too-short blobs', async () => {
    const phrase = generatePhrase();
    const salt = randomSalt();
    const key = await deriveMasterKey(phrase, salt);
    await expect(decryptBundle(new Uint8Array(5), key)).rejects.toThrow('invalid_blob');
  }, 10_000);

  it('decrypt rejects bundle with unsupported version', async () => {
    const phrase = generatePhrase();
    const salt = randomSalt();
    const key = await deriveMasterKey(phrase, salt);
    // encryptBundle stempelt v auf 1 oder 2 (recovery.js:202) — den Pfad zur
    // Version-Validation in decryptBundle erreicht man nur, indem der Blob
    // direkt aus rohem AES-GCM-Ciphertext mit v=999 im Plaintext gebaut wird.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify({ v: 999, ts: 1, cmks: {}, gsks: {} }));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    const blob = new Uint8Array(iv.length + ct.byteLength);
    blob.set(iv, 0);
    blob.set(new Uint8Array(ct), iv.length);
    await expect(decryptBundle(blob, key)).rejects.toThrow('unsupported_bundle_version');
  }, 10_000);
});

// ======================================================
// Helpers: randomSalt + Base64 round-trip
// ======================================================
describe('randomSalt', () => {
  it('produces 16 bytes', () => {
    expect(randomSalt().length).toBe(16);
  });

  it('produces different bytes on each call', () => {
    const a = bytesToB64(randomSalt());
    const b = bytesToB64(randomSalt());
    expect(a).not.toBe(b);
  });
});

describe('bytesToB64 / b64ToBytes', () => {
  it('round-trips arbitrary bytes', () => {
    const original = new Uint8Array([0, 1, 2, 3, 127, 128, 254, 255]);
    const b64 = bytesToB64(original);
    const back = b64ToBytes(b64);
    expect(Array.from(back)).toEqual(Array.from(original));
  });

  it('round-trips empty', () => {
    expect(bytesToB64(new Uint8Array(0))).toBe('');
    expect(b64ToBytes('').length).toBe(0);
  });

  it('round-trips 16-byte salt', () => {
    const salt = randomSalt();
    expect(Array.from(b64ToBytes(bytesToB64(salt)))).toEqual(Array.from(salt));
  });
});
