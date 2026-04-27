// ======================================================
// Unit-Tests für chatCrypto.js
// ======================================================
// Diese Tests sind essenziell — sie prüfen Pure-Crypto-Functions die in
// jeder verschlüsselten Nachricht laufen. Wenn eine dieser Functions
// kaputt geht, ist E2E-Verschlüsselung kompromittiert.
// ======================================================
import { describe, it, expect } from 'vitest';

// Direkter Import der Pure-Functions
import {
  abToB64,
  b64ToAb,
  e2eEncrypt,
  e2eDecrypt,
  generateFileKey,
  exportKeyB64,
  importKeyB64,
  e2eEncryptBytes,
} from '../renex/js/chatCrypto.js';

// ── Test 1: Base64 Round-Trip ─────────────────────────────────
// Wenn dieser Test fehlt → keine Encryption funktioniert (alle Payloads kaputt).
describe('abToB64 / b64ToAb', () => {
  it('round-trips arbitrary bytes correctly', () => {
    const original = new Uint8Array([0, 1, 2, 3, 127, 128, 254, 255]);
    const b64 = abToB64(original.buffer);
    const back = new Uint8Array(b64ToAb(b64));
    expect(Array.from(back)).toEqual(Array.from(original));
  });

  it('handles empty input', () => {
    const empty = new Uint8Array(0);
    const b64 = abToB64(empty.buffer);
    expect(b64).toBe('');
    const back = new Uint8Array(b64ToAb(''));
    expect(back.length).toBe(0);
  });

  it('produces standard base64 (no URL-safe chars)', () => {
    // Bytes that produce + and / in standard base64
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
    const b64 = abToB64(bytes.buffer);
    // Should NOT contain - or _ (URL-safe variants); should be standard base64
    expect(b64).not.toContain('-');
    expect(b64).not.toContain('_');
  });
});

// ── Test 2: AES-GCM Encrypt/Decrypt Round-Trip ─────────────────
// Kern-Funktion: Plaintext → Ciphertext → Plaintext muss identisch sein.
describe('e2eEncrypt / e2eDecrypt', () => {
  it('round-trips text messages', async () => {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    const plaintext = 'Hello RENEX! 🔐 äöü';
    const { ivB64, ctB64 } = await e2eEncrypt(key, plaintext);

    expect(ivB64).toBeTruthy();
    expect(ctB64).toBeTruthy();
    expect(ivB64.length).toBeLessThanOrEqual(24); // 12 bytes → 16 chars b64

    const decrypted = await e2eDecrypt(key, ivB64, ctB64);
    expect(decrypted).toBe(plaintext);
  });

  it('different IVs produce different ciphertexts for same plaintext', async () => {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    const plaintext = 'same message';
    const a = await e2eEncrypt(key, plaintext);
    const b = await e2eEncrypt(key, plaintext);

    // IVs müssen unterschiedlich sein (random)
    expect(a.ivB64).not.toBe(b.ivB64);
    // Ciphertexts müssen unterschiedlich sein (folgt aus IV-Unterschied)
    expect(a.ctB64).not.toBe(b.ctB64);
    // Aber beide entschlüsseln zum gleichen Plaintext
    expect(await e2eDecrypt(key, a.ivB64, a.ctB64)).toBe(plaintext);
    expect(await e2eDecrypt(key, b.ivB64, b.ctB64)).toBe(plaintext);
  });

  it('decrypt fails with wrong key', async () => {
    const keyA = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );
    const keyB = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );

    const { ivB64, ctB64 } = await e2eEncrypt(keyA, 'secret');
    await expect(e2eDecrypt(keyB, ivB64, ctB64)).rejects.toThrow();
  });
});

// ── Test 3: Key Export/Import Round-Trip ─────────────────────
// Wichtig für CMK-Sharing zwischen Devices: exportKeyB64 → importKeyB64.
describe('exportKeyB64 / importKeyB64', () => {
  it('round-trips an AES-GCM key (decryption works)', async () => {
    const original = await generateFileKey();
    const b64 = await exportKeyB64(original);
    const imported = await importKeyB64(b64);

    // Imported-Key kann decrypten was Original encrypted hat
    const { ivB64, ctB64 } = await e2eEncrypt(original, 'test payload');
    const decrypted = await e2eDecrypt(imported, ivB64, ctB64);
    expect(decrypted).toBe('test payload');
  });

  it('exported key has correct length (32 bytes = 256 bits)', async () => {
    const key = await generateFileKey();
    const b64 = await exportKeyB64(key);
    const bytes = new Uint8Array(b64ToAb(b64));
    expect(bytes.length).toBe(32);
  });
});

// ── Test 4: Binary Encrypt (für Files/Images) ───────────────
describe('e2eEncryptBytes', () => {
  it('encrypts arbitrary binary data', async () => {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );

    const original = new Uint8Array(1024);
    crypto.getRandomValues(original);

    const { ivB64, ctBytes } = await e2eEncryptBytes(key, original);

    expect(ivB64).toBeTruthy();
    expect(ctBytes).toBeInstanceOf(Uint8Array);
    // AES-GCM: ciphertext = plaintext + 16-byte auth-tag
    expect(ctBytes.length).toBe(original.length + 16);

    // Decrypten und Bytes vergleichen
    const iv = new Uint8Array(b64ToAb(ivB64));
    const decryptedBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, key, ctBytes
    );
    const decrypted = new Uint8Array(decryptedBuf);
    expect(Array.from(decrypted)).toEqual(Array.from(original));
  });
});

// ── Test 5: generateFileKey (extractable) ───────────────────
// Wichtig: generated key MUSS extractable sein (für CMK-Sync zwischen Devices).
describe('generateFileKey', () => {
  it('generates a key that can be exported (extractable=true)', async () => {
    const key = await generateFileKey();
    // Wenn nicht extractable, würde exportKey throwen
    const exported = await crypto.subtle.exportKey('raw', key);
    expect(exported.byteLength).toBe(32); // 256-bit AES
  });

  it('produces unique keys (high entropy)', async () => {
    const k1 = await generateFileKey();
    const k2 = await generateFileKey();
    const b1 = await exportKeyB64(k1);
    const b2 = await exportKeyB64(k2);
    expect(b1).not.toBe(b2);
  });
});
