// ======================================================
// WebAuthn Assertion-Verifier (extrahiert für Re-Use)
// ======================================================
// Genutzt für:
//   - Re-Auth bei Device-Revoke (M5)
//   - Zukünftige sensitive Ops die User-Presence-Beweis brauchen
//
// HINWEIS: Login-Path (helpers/loginFinish.js) hat seine eigene Implementation
// dieser Validierung. Vorerst absichtlich dupliziert — Refactor zu einem
// gemeinsamen Helper erst wenn beide Pfade lange stabil sind, weil Login
// kritischer Pfad ist und wir keine Regression riskieren wollen.
// ======================================================

import { base64url, base64urlToString, base64urlToArrayBuffer, derToRawECDSA } from '../utils.js';
import { readCredentials } from './credentials.js';

const RP_ID = 'app.renex.id';
const EXPECTED_ORIGIN = 'https://app.renex.id';
const CHALLENGE_MAX_AGE_MS = 5 * 60 * 1000;  // 5 min

/**
 * Validiert eine WebAuthn-Assertion gegen eine zuvor gespeicherte Challenge.
 *
 * @param {object} env - Cloudflare env (KV access)
 * @param {object} opts
 *   @param {string} opts.challengeKey - KV-Key wo die Challenge liegt
 *     (z.B. `challenge:revoke:${handle}:${targetDeviceId}`)
 *   @param {string} opts.handle - Account-Handle für Credentials-Lookup
 *   @param {object} opts.assertion - WebAuthn assertion vom Client
 *     { id, response: { clientDataJSON, authenticatorData, signature } }
 * @returns {Promise<{ok: true, credentialId: string, signCount: number}
 *                 | {ok: false, error: string}>}
 */
export async function verifyWebAuthnAssertion(env, { challengeKey, handle, assertion }) {
  if (!assertion?.id || !assertion?.response) {
    return { ok: false, error: 'Missing assertion' };
  }
  const { clientDataJSON, authenticatorData, signature } = assertion.response;
  if (!clientDataJSON || !authenticatorData || !signature) {
    return { ok: false, error: 'Incomplete assertion fields' };
  }

  // 1. Challenge aus KV laden
  const chRaw = await env.RENEX_KV.get(challengeKey);
  if (!chRaw) return { ok: false, error: 'Challenge not found or expired' };

  let challengeObj;
  try { challengeObj = JSON.parse(chRaw); }
  catch { return { ok: false, error: 'Invalid challenge data' }; }

  if (!challengeObj.ts || Date.now() - challengeObj.ts > CHALLENGE_MAX_AGE_MS) {
    await env.RENEX_KV.delete(challengeKey);
    return { ok: false, error: 'Challenge expired' };
  }

  // 2. clientDataJSON parsen
  let clientData;
  try {
    clientData = JSON.parse(base64urlToString(clientDataJSON));
  } catch {
    return { ok: false, error: 'Invalid clientDataJSON' };
  }

  if (clientData.type !== 'webauthn.get') {
    return { ok: false, error: 'Invalid WebAuthn type' };
  }
  if (clientData.origin !== EXPECTED_ORIGIN) {
    return { ok: false, error: 'Invalid origin' };
  }
  if (clientData.challenge !== challengeObj.challenge) {
    return { ok: false, error: 'Challenge mismatch' };
  }

  // 3. Credential im Array finden
  const credentials = await readCredentials(env, handle);
  if (!credentials || credentials.length === 0) {
    return { ok: false, error: 'No credentials registered' };
  }
  const matchedCred = credentials.find(c => c.credential_id === assertion.id);
  if (!matchedCred) {
    return { ok: false, error: 'Credential mismatch' };
  }

  // 4. authenticatorData parsen + RP-ID-Hash + Flags
  let authData;
  try {
    const bin = base64urlToString(authenticatorData);
    authData = Uint8Array.from(bin, c => c.charCodeAt(0));
  } catch {
    return { ok: false, error: 'Invalid authenticatorData' };
  }
  if (authData.length < 37) {
    return { ok: false, error: 'Invalid authenticatorData length' };
  }

  const rpIdHash = authData.slice(0, 32);
  const expectedHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RP_ID))
  );
  for (let i = 0; i < 32; i++) {
    if (rpIdHash[i] !== expectedHash[i]) {
      return { ok: false, error: 'Invalid rpIdHash' };
    }
  }

  const flags = authData[32];
  if (!(flags & 0x01)) return { ok: false, error: 'User presence required' };
  if (!(flags & 0x04)) return { ok: false, error: 'User verification required' };

  // 5. signCount Replay-Schutz
  const newSignCount =
    (authData[33] << 24) | (authData[34] << 16) | (authData[35] << 8) | authData[36];
  const storedSignCount = Number(matchedCred.signCount || 0);
  if (storedSignCount > 0 && newSignCount <= storedSignCount) {
    return { ok: false, error: 'Replay detected' };
  }

  // 6. Signatur prüfen
  const storedPublicKeyJwk = matchedCred.publicKeyJwk;
  if (!storedPublicKeyJwk) {
    return { ok: false, error: 'Passkey re-registration required' };
  }

  let publicKey;
  try {
    if (storedPublicKeyJwk.kty === 'EC') {
      publicKey = await crypto.subtle.importKey(
        'jwk',
        { ...storedPublicKeyJwk, key_ops: ['verify'] },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      );
    } else if (storedPublicKeyJwk.kty === 'RSA') {
      publicKey = await crypto.subtle.importKey(
        'jwk',
        { ...storedPublicKeyJwk, key_ops: ['verify'] },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify']
      );
    } else {
      return { ok: false, error: 'Unsupported key type' };
    }
  } catch {
    return { ok: false, error: 'Public key import failed' };
  }

  const clientDataJSONBytes = new Uint8Array(base64urlToArrayBuffer(clientDataJSON));
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSONBytes));
  const verifyData = new Uint8Array(authData.length + clientDataHash.length);
  verifyData.set(authData, 0);
  verifyData.set(clientDataHash, authData.length);

  const sigBytes = new Uint8Array(base64urlToArrayBuffer(signature));

  let signatureValid = false;
  try {
    if (storedPublicKeyJwk.kty === 'EC') {
      const rawSig = derToRawECDSA(sigBytes);
      signatureValid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey, rawSig, verifyData
      );
    } else {
      signatureValid = await crypto.subtle.verify(
        { name: 'RSASSA-PKCS1-v1_5' },
        publicKey, sigBytes, verifyData
      );
    }
  } catch {
    signatureValid = false;
  }

  if (!signatureValid) {
    return { ok: false, error: 'Signature verification failed' };
  }

  // 7. Challenge ist verbraucht (one-shot) — sofort löschen
  await env.RENEX_KV.delete(challengeKey).catch(() => {});

  return { ok: true, credentialId: matchedCred.credential_id, signCount: newSignCount };
}

/**
 * Erzeugt eine WebAuthn-Challenge + speichert sie in KV.
 * Returnt das Format das navigator.credentials.get() erwartet (challenge + allowCredentials).
 */
export async function createWebAuthnChallenge(env, { challengeKey, handle }) {
  const credentials = await readCredentials(env, handle);
  if (!credentials || credentials.length === 0) {
    return { ok: false, error: 'No credentials registered' };
  }

  const challengeBytes = crypto.getRandomValues(new Uint8Array(32));
  const challenge = base64url(challengeBytes);

  await env.RENEX_KV.put(
    challengeKey,
    JSON.stringify({ challenge, ts: Date.now() }),
    { expirationTtl: 300 }  // 5 min — KV-Minimum-friendly
  );

  return {
    ok: true,
    challenge,
    allowCredentials: credentials.map(c => ({
      type: 'public-key',
      id: c.credential_id,
    })),
  };
}
