// ======================================================
// Voice-Signaling-Crypto — SDP + ICE-Candidates E2E-encrypten mit CMK
// ======================================================
// Ziel: Cloudflare-Worker sieht keine SDP-Bodies (DTLS-FP, Codec-Capabilities)
// und keine ICE-Candidates (LAN-IPs via host-Candidates, Public-IPs via srflx).
//
// Design:
//   - VoiceKey = HKDF(CMK, salt='renex/voice-v1', info=callId) — pro Call eigener
//     AES-GCM-256 CryptoKey. Bindet Cipher an die konkrete callId; Replay einer
//     SDP aus Call A in Call B failt (wrong key).
//   - Pro Encryption: random 12-Byte IV (AES-GCM-Standard).
//   - AAD bindet `kind:from:to:callId` — verhindert dass ein Cipher-Body in
//     einer falschen Rolle (z.B. ICE als Offer interpretieren) decrypted wird.
//
// Schema:
//   ec = { v: 1, iv: <base64>, ct: <base64> }
// ======================================================

import { abToB64, b64ToAb } from './bytes.js';

const VOICE_KEY_SALT = new TextEncoder().encode('renex/voice-v1');
const VERSION = 1;

/**
 * Leitet einen AES-GCM-Key aus dem CMK + callId ab.
 *
 * @param {Uint8Array} cmkBytes - 32-Byte CMK
 * @param {string} callId - UUID des Calls
 * @returns {Promise<CryptoKey>}
 */
async function deriveVoiceKey(cmkBytes, callId) {
  if (!(cmkBytes instanceof Uint8Array) || cmkBytes.length !== 32) {
    throw new Error('voiceCrypto: invalid CMK');
  }
  if (typeof callId !== 'string' || !callId) {
    throw new Error('voiceCrypto: invalid callId');
  }
  const cmkKey = await crypto.subtle.importKey(
    'raw', cmkBytes,
    'HKDF',
    false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: VOICE_KEY_SALT,
      info: new TextEncoder().encode(`call:${callId}`),
    },
    cmkKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Baut die AAD-Bytes für einen bestimmten Cipher-Kontext.
 * AAD ist nicht im Ciphertext, aber der Decrypt failt wenn AAD nicht matched.
 * Format: `v1:<kind>:<from>:<to>:<callId>` als UTF-8.
 */
function buildAad(kind, from, to, callId) {
  return new TextEncoder().encode(`v1:${kind}:${from}:${to}:${callId}`);
}

async function encryptString(voiceKey, plaintext, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    voiceKey,
    new TextEncoder().encode(plaintext)
  );
  return {
    v: VERSION,
    iv: abToB64(iv.buffer),
    ct: abToB64(ct),
  };
}

async function decryptString(voiceKey, ec, aad) {
  if (!ec || ec.v !== VERSION || typeof ec.iv !== 'string' || typeof ec.ct !== 'string') {
    throw new Error('voiceCrypto: bad envelope');
  }
  const iv = new Uint8Array(b64ToAb(ec.iv));
  const ct = b64ToAb(ec.ct);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    voiceKey,
    ct
  );
  return new TextDecoder().decode(pt);
}

/**
 * Encryptet eine SDP-Body (Klartext-String aus offer.sdp / answer.sdp).
 *
 * @param {Uint8Array} cmkBytes
 * @param {string} sdpString - der SDP-Text (RFC 4566)
 * @param {'offer'|'answer'} kind
 * @param {string} from - my handle
 * @param {string} to - peer handle
 * @param {string} callId
 * @returns {Promise<{v: number, iv: string, ct: string}>}
 */
export async function encryptSdp(cmkBytes, sdpString, kind, from, to, callId) {
  const key = await deriveVoiceKey(cmkBytes, callId);
  const aad = buildAad(kind, from, to, callId);
  return encryptString(key, sdpString, aad);
}

/**
 * Decryptet ein SDP-Envelope zurück zum Klartext.
 *
 * @param {Uint8Array} cmkBytes
 * @param {object} ec - { v, iv, ct }
 * @param {'offer'|'answer'} kind
 * @param {string} from - peer handle (Sender der Nachricht)
 * @param {string} to - my handle
 * @param {string} callId
 * @returns {Promise<string>} der entschlüsselte SDP-Text
 */
export async function decryptSdp(cmkBytes, ec, kind, from, to, callId) {
  const key = await deriveVoiceKey(cmkBytes, callId);
  const aad = buildAad(kind, from, to, callId);
  return decryptString(key, ec, aad);
}

/**
 * Encryptet ein ICE-Candidate-Object (RTCIceCandidateInit-shape).
 * Das gesamte Object wird als JSON serialisiert und encrypted, damit auch
 * Felder wie `sdpMid`, `sdpMLineIndex`, `usernameFragment` mitgeschützt sind.
 *
 * @param {Uint8Array} cmkBytes
 * @param {object} candidateObj - { candidate, sdpMid, sdpMLineIndex, usernameFragment? }
 * @param {string} from - my handle
 * @param {string} to - peer handle
 * @param {string} callId
 * @returns {Promise<{v: number, iv: string, ct: string}>}
 */
export async function encryptIce(cmkBytes, candidateObj, from, to, callId) {
  const key = await deriveVoiceKey(cmkBytes, callId);
  const aad = buildAad('ice', from, to, callId);
  const json = JSON.stringify(candidateObj);
  return encryptString(key, json, aad);
}

/**
 * Decryptet ein ICE-Envelope zurück zum Candidate-Object.
 *
 * @param {Uint8Array} cmkBytes
 * @param {object} ec - { v, iv, ct }
 * @param {string} from - peer handle (Sender)
 * @param {string} to - my handle
 * @param {string} callId
 * @returns {Promise<object>} candidateObj
 */
export async function decryptIce(cmkBytes, ec, from, to, callId) {
  const key = await deriveVoiceKey(cmkBytes, callId);
  const aad = buildAad('ice', from, to, callId);
  const json = await decryptString(key, ec, aad);
  return JSON.parse(json);
}

/**
 * Schnell-Check: ist das ein gültiges ec-Envelope?
 * @param {*} ec
 */
export function isVoiceEnvelope(ec) {
  return !!ec && typeof ec === 'object' &&
    ec.v === VERSION &&
    typeof ec.iv === 'string' &&
    typeof ec.ct === 'string';
}
