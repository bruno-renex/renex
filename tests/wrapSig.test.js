// ======================================================
// Unit-Tests: Wrap-Signatur (Phase 0.3)
// ======================================================
// Garantien:
//   - canonicalWrap ist deterministisch, bindet algoVersion + Empfänger +
//     Ciphertext, und schließt wrapSig selbst AUS.
//   - sign↔verify Round-Trip (echter signWrapPayload via IDB-Sig-Key).
//   - DOWNGRADE-SCHUTZ: Tampern an algoVersion bricht die Signatur (invalid).
//   - Tampern an ctB64 bricht die Signatur (Tamper-Evidenz).
//   - fehlende Sig → 'missing' (Dark-Launch: alter Client), falscher Pubkey →
//     'invalid', kein Pubkey → 'no_pubkey'.
//   - signWrapPayload degradiert graceful zu null ohne Sig-Key (Dark-Launch-safe).
// ======================================================
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { idbSet, idbDelete } from '../frontend/src/lib/idb.js';
import { bytesToB64 } from '../frontend/src/lib/bytes.js';
import { canonicalWrap, signWrapPayload, verifyWrapPayload, logWrapVerify } from '../frontend/src/lib/wrapSig.js';

const enc = new TextEncoder();

async function genSigKeypair() {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
}
// Signiert canonicalWrap(payload) manuell mit einem Test-Keypair (wie der echte Pfad).
async function manualSign(payload, privKey) {
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privKey, enc.encode(canonicalWrap(payload)));
  return bytesToB64(new Uint8Array(sig));
}

const BASE = { algoVersion: 1, fromDeviceId: 'devA', deviceId: 'devB', ivB64: 'IVxx', ctB64: 'CTxx' };

describe('canonicalWrap', () => {
  it('deterministisch + domain-separiert + bindet algoVersion', () => {
    const s = canonicalWrap(BASE);
    expect(s).toBe('renex:cmkwrap:v1\n1\ndevA\ndevB\nIVxx\nCTxx');
  });
  it('schließt wrapSig AUS (Sig ist nicht Teil ihrer selbst)', () => {
    expect(canonicalWrap({ ...BASE, wrapSig: 'whatever' })).toBe(canonicalWrap(BASE));
  });
  it('andere algoVersion → anderer canonical-String (Downgrade-Bindung)', () => {
    expect(canonicalWrap({ ...BASE, algoVersion: 3 })).not.toBe(canonicalWrap(BASE));
  });
});

describe('verifyWrapPayload (manuelle Sig)', () => {
  it('gültige Sig → ok', async () => {
    const kp = await genSigKeypair();
    const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const wrap = { ...BASE, wrapSig: await manualSign(BASE, kp.privateKey) };
    expect(await verifyWrapPayload(wrap, pub)).toEqual({ ok: true, reason: 'ok' });
  });

  it('DOWNGRADE: algoVersion nachträglich verändert → invalid', async () => {
    const kp = await genSigKeypair();
    const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
    // Absender signiert algoVersion=3 (hybrid); Angreifer strippt auf 1 (klassisch).
    const signed = { ...BASE, algoVersion: 3 };
    const wrap = { ...signed, wrapSig: await manualSign(signed, kp.privateKey), algoVersion: 1 };
    const v = await verifyWrapPayload(wrap, pub);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('invalid');
  });

  it('TAMPER: ctB64 verändert → invalid', async () => {
    const kp = await genSigKeypair();
    const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const wrap = { ...BASE, wrapSig: await manualSign(BASE, kp.privateKey), ctB64: 'CTzz' };
    expect((await verifyWrapPayload(wrap, pub)).ok).toBe(false);
  });

  it('fehlende Sig → missing (Dark-Launch: alter Client)', async () => {
    const kp = await genSigKeypair();
    const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
    expect((await verifyWrapPayload(BASE, pub)).reason).toBe('missing');
  });

  it('kein Pubkey → no_pubkey', async () => {
    const kp = await genSigKeypair();
    const wrap = { ...BASE, wrapSig: await manualSign(BASE, kp.privateKey) };
    expect((await verifyWrapPayload(wrap, null)).reason).toBe('no_pubkey');
  });

  it('falscher Pubkey → invalid', async () => {
    const kp = await genSigKeypair();
    const other = await genSigKeypair();
    const otherPub = await crypto.subtle.exportKey('jwk', other.publicKey);
    const wrap = { ...BASE, wrapSig: await manualSign(BASE, kp.privateKey) };
    expect((await verifyWrapPayload(wrap, otherPub)).ok).toBe(false);
  });
});

describe('signWrapPayload (echter Pfad via IDB-Sig-Key)', () => {
  it('signiert + verifiziert round-trip', async () => {
    const kp = await genSigKeypair();
    await idbSet('sig_keypair', { priv: kp.privateKey, pub: kp.publicKey });
    const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);

    const sig = await signWrapPayload(BASE);
    expect(typeof sig).toBe('string');
    const wrap = { ...BASE, wrapSig: sig };
    expect((await verifyWrapPayload(wrap, pub)).ok).toBe(true);
  });

  it('ohne Sig-Key → null (Dark-Launch-safe, blockt Wrap nicht)', async () => {
    await idbDelete('sig_keypair');
    expect(await signWrapPayload(BASE)).toBeNull();
  });
});

describe('logWrapVerify', () => {
  it('wirft nie + gibt Verify-Resultat zurück', async () => {
    const kp = await genSigKeypair();
    const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const wrap = { ...BASE, wrapSig: await manualSign(BASE, kp.privateKey) };
    const v = await logWrapVerify(wrap, pub, 'test');
    expect(v.ok).toBe(true);
    // missing/error dürfen nicht werfen
    await expect(logWrapVerify(BASE, null, 'test')).resolves.toBeTruthy();
  });
});
