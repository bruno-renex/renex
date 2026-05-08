// ======================================================
// Unit-Tests für chatCrypto.js
// ======================================================
// Diese Tests sind essenziell — sie prüfen Pure-Crypto-Functions die in
// jeder verschlüsselten Nachricht laufen. Wenn eine dieser Functions
// kaputt geht, ist E2E-Verschlüsselung kompromittiert.
// ======================================================
import { describe, it, expect, beforeEach } from 'vitest';

// Pure-Crypto-Functions aus dem Svelte-Frontend. Migration aus
// renex-legacy abgeschlossen — die Original-Vanilla-Quelle wurde im
// Block-F-Cutover entfernt; die hier getesteten Functions sind 1:1-
// Ports + Hardenings.
//
// Tests für File-Crypto-Helpers (generateFileKey, exportKeyB64,
// importKeyB64) wurden entfernt — File-Upload ist noch nicht ins
// Svelte-Frontend portiert. Wenn das später passiert: Tests
// re-enablen + neuen Port nach lib/fileCrypto.js o.ä. importieren.
import { abToB64, b64ToAb } from '../frontend/src/lib/bytes.js';
import {
  e2eEncrypt,
  e2eDecrypt,
  e2eEncryptBytes,
} from '../frontend/src/lib/chatCrypto.js';

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

// Tests für exportKeyB64 / importKeyB64 / generateFileKey wurden im
// Block-F-Cutover entfernt — diese File-Crypto-Helpers wurden nicht ins
// Svelte-Frontend portiert (kein File-Upload aktuell). Wenn File-Upload
// kommt: hier die Tests wieder einsetzen mit Import aus dem dann neu
// erstellten Modul (vermutlich lib/fileCrypto.js).

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

// generateFileKey tests entfernt — siehe Kommentar oben.

// ── Test 5: AAD (Additional Authenticated Data) ─────────────
// Defense-in-Depth: AAD bindet das Ciphertext an einen Domain-Kontext
// (z.B. 'renex:dm:v1'). Wenn Sender und Empfänger nicht dieselbe AAD
// verwenden, schlägt AES-GCM-Auth-Tag-Verify fehl.
describe('AAD (Additional Authenticated Data)', () => {
  let key;

  beforeEach(async () => {
    key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );
  });

  it('round-trips with matching AAD', async () => {
    const aad = 'renex:dm:v1';
    const { ivB64, ctB64 } = await e2eEncrypt(key, 'hello with aad', aad);
    const back = await e2eDecrypt(key, ivB64, ctB64, aad);
    expect(back).toBe('hello with aad');
  });

  it('decrypt FAILS with mismatched AAD (wrong domain string)', async () => {
    const { ivB64, ctB64 } = await e2eEncrypt(key, 'secret', 'renex:dm:v1');
    await expect(
      e2eDecrypt(key, ivB64, ctB64, 'renex:group:v1')
    ).rejects.toThrow();
  });

  it('decrypt FAILS when AAD provided on decrypt but not on encrypt', async () => {
    const { ivB64, ctB64 } = await e2eEncrypt(key, 'no-aad-msg');
    await expect(
      e2eDecrypt(key, ivB64, ctB64, 'renex:dm:v1')
    ).rejects.toThrow();
  });

  it('decrypt FAILS when AAD provided on encrypt but not on decrypt', async () => {
    const { ivB64, ctB64 } = await e2eEncrypt(key, 'has-aad', 'renex:dm:v1');
    await expect(
      e2eDecrypt(key, ivB64, ctB64)
    ).rejects.toThrow();
  });

  it('round-trips when AAD is null on both sides (backward-compat)', async () => {
    const { ivB64, ctB64 } = await e2eEncrypt(key, 'plain', null);
    const back = await e2eDecrypt(key, ivB64, ctB64, null);
    expect(back).toBe('plain');
  });

  it('accepts AAD as Uint8Array (binary domain marker)', async () => {
    const aad = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    const { ivB64, ctB64 } = await e2eEncrypt(key, 'binary-aad', aad);
    const back = await e2eDecrypt(key, ivB64, ctB64, aad);
    expect(back).toBe('binary-aad');
  });

  it('e2eEncryptBytes / e2eDecryptBytes round-trip with AAD', async () => {
    const aad = 'renex:file:v1';
    const original = new Uint8Array(64);
    crypto.getRandomValues(original);
    const { ivB64, ctBytes } = await e2eEncryptBytes(key, original, aad);
    // Direct decrypt with crypto.subtle to verify AAD was set
    const iv = new Uint8Array(b64ToAb(ivB64));
    const back = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: new TextEncoder().encode(aad),
      },
      key,
      ctBytes
    );
    expect(Array.from(new Uint8Array(back))).toEqual(Array.from(original));
  });
});
