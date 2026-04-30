// ======================================================
// Unit-Tests für Message-Signaturen (ECDSA-P256)
// ======================================================
// Spec: docs/MULTI_DEVICE.md §4.2 (Send-Flow Sig-Verify)
//
// Kritische Garantien:
//   - Sig-Verify mit korrektem Pubkey + Daten → true
//   - Sig-Verify mit falschem Pubkey → false (kein throw!)
//   - Sig-Verify mit manipulierten Daten → false
//   - Sig-Verify mit korruptem sigB64 → false
//
// Test-Strategie: signMessage() braucht IDB-Setup, daher hier die Verify-Pfade
// gegen externally-generated Sigs getestet. Die Sig-Logik selbst ist Standard
// WebCrypto ECDSA.
// ======================================================
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { idbSet } from '../frontend/src/lib/idb.js';
import { signMessage, verifyMessageSig } from '../frontend/src/lib/messageSig.js';

// ── Helper: Test-Keypair generieren + in IDB ablegen ─
async function setupSigningKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true, ['sign', 'verify']
  );
  const pubJwk  = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  await idbSet('sig_keypair', { pub: pubJwk, priv: privJwk });
  return { pubJwk, privJwk, pubKey: pair.publicKey, privKey: pair.privateKey };
}

let keys;

beforeAll(async () => {
  keys = await setupSigningKeyPair();
});

// ======================================================
// Sign + Verify End-to-End
// ======================================================
describe('signMessage + verifyMessageSig', () => {
  it('round-trip: sign then verify returns true', async () => {
    const ivB64 = 'aXY=';
    const ctB64 = 'Y3Q=';
    const sid = 'dm:alice:bob';
    const epoch = 1;

    const sigB64 = await signMessage(ivB64, ctB64, sid, epoch);
    expect(typeof sigB64).toBe('string');
    expect(sigB64.length).toBeGreaterThan(0);

    const ok = await verifyMessageSig(ivB64, ctB64, sid, epoch, sigB64, keys.pubJwk);
    expect(ok).toBe(true);
  });

  it('verify fails with wrong pubkey (different keypair)', async () => {
    const otherPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true, ['sign', 'verify']
    );
    const otherPubJwk = await crypto.subtle.exportKey('jwk', otherPair.publicKey);

    const sigB64 = await signMessage('iv', 'ct', 'sid', 1);
    const ok = await verifyMessageSig('iv', 'ct', 'sid', 1, sigB64, otherPubJwk);
    expect(ok).toBe(false);
  });

  it('verify fails with manipulated ctB64 (Backend-Tampering)', async () => {
    const sigB64 = await signMessage('iv', 'original-ct', 'sid', 1);
    const ok = await verifyMessageSig('iv', 'tampered-ct', 'sid', 1, sigB64, keys.pubJwk);
    expect(ok).toBe(false);
  });

  it('verify fails with manipulated ivB64', async () => {
    const sigB64 = await signMessage('original-iv', 'ct', 'sid', 1);
    const ok = await verifyMessageSig('tampered-iv', 'ct', 'sid', 1, sigB64, keys.pubJwk);
    expect(ok).toBe(false);
  });

  it('verify fails with wrong epoch', async () => {
    const sigB64 = await signMessage('iv', 'ct', 'sid', 1);
    const ok = await verifyMessageSig('iv', 'ct', 'sid', 2, sigB64, keys.pubJwk);
    expect(ok).toBe(false);
  });

  it('verify fails with wrong sid', async () => {
    const sigB64 = await signMessage('iv', 'ct', 'dm:a:b', 1);
    const ok = await verifyMessageSig('iv', 'ct', 'dm:a:c', 1, sigB64, keys.pubJwk);
    expect(ok).toBe(false);
  });

  it('verify returns false (not throw) for corrupt sigB64', async () => {
    const ok = await verifyMessageSig('iv', 'ct', 'sid', 1, 'not-base64!!!', keys.pubJwk);
    expect(ok).toBe(false);
  });

  it('verify returns false for invalid pubkey JWK', async () => {
    const sigB64 = await signMessage('iv', 'ct', 'sid', 1);
    const ok = await verifyMessageSig('iv', 'ct', 'sid', 1, sigB64, { invalid: 'jwk' });
    expect(ok).toBe(false);
  });
});

describe('signMessage error paths', () => {
  it('throws when no signing key in IDB', async () => {
    // Temporär den Key entfernen
    const { idbDelete } = await import('../frontend/src/lib/idb.js');
    await idbDelete('sig_keypair');

    await expect(signMessage('iv', 'ct', 'sid', 1)).rejects.toThrow('No signing key');

    // Wiederherstellen für andere Tests
    await idbSet('sig_keypair', { pub: keys.pubJwk, priv: keys.privJwk });
  });
});
