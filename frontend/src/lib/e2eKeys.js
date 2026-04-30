// ======================================================
// E2E Keys — Phase 1A.6 Inbox-Upload-Migration
// ======================================================
// Migration aus renex-legacy/js/e2e.js (Lines 365-577).
//
// Scope dieser Datei:
//   - ECDH-P256-Keypair (Inbox-Pubkey für CMK-Wrap)
//   - ECDSA-P256-Keypair (Sig-Pubkey für Message-Signaturen)
//   - Inbox-Upload mit Retry-Backoff
//
// NICHT in dieser Datei (separate Phase 1A.6.x):
//   - CMK-Storage / -Encryption / -Rotation
//   - Peer-Device-Cache
//   - Message-Signing/Verify
//   - Session-Key-Derivation
//
// Spec: docs/MULTI_DEVICE.md §4.1 (Add-Device-Flow)
// ======================================================

import { idbGet, idbSet } from './idb.js';
import { detectDeviceName } from './multidevice.js';
import { captureException } from './sentry.js';

const API = 'https://api.renex.id';

const IDB_PRIVATE_KEY = 'e2e-private-key';
const IDB_PUBLIC_KEY  = 'e2e-public-key';
const IDB_SIG_KEYPAIR = 'sig_keypair';

// Retry-Backoff für Inbox-Upload (Spec: kein Sackgassen-Failure bei Network-Hick)
const UPLOAD_RETRY_DELAYS_MS = [1000, 3000, 8000, 20000];
const UPLOAD_BG_RETRY_MS = 60_000;
const _bgRetryActive = new Set();

// ======================================================
// Helpers
// ======================================================

export function getDeviceId() {
  let id = localStorage.getItem('device_id');
  if (!id) {
    id = 'dev_' + crypto.randomUUID();
    localStorage.setItem('device_id', id);
  }
  return id;
}

// ======================================================
// ECDH-P256 Keypair (Inbox-Pubkey, für CMK-Wrap)
// ======================================================

export async function loadPrivateKey() {
  return await idbGet(IDB_PRIVATE_KEY);
}

export async function loadPublicKey() {
  return await idbGet(IDB_PUBLIC_KEY);
}

/**
 * Erzeugt ein ECDH-P256-Keypair, falls noch keines existiert.
 * Privater Schlüssel ist non-extractable (bleibt im Browser).
 * @returns {Promise<boolean>} true wenn (jetzt) initialisiert
 */
export async function initE2EKeys() {
  const existingPriv = await loadPrivateKey();
  const existingPub  = await loadPublicKey();
  if (existingPriv && existingPub) return true;

  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,        // non-extractable (Browser-only)
    ['deriveKey']
  );

  await idbSet(IDB_PRIVATE_KEY, keyPair.privateKey);
  await idbSet(IDB_PUBLIC_KEY, keyPair.publicKey);
  return true;
}

// ======================================================
// ECDSA-P256 Signing-Keypair (Sig-Pubkey, für Message-Sigs)
// ======================================================

async function getOrCreateSigningKeyPair() {
  const saved = await idbGet(IDB_SIG_KEYPAIR);
  if (saved?.pub && saved?.priv) {
    try {
      const privKey = await crypto.subtle.importKey(
        'jwk', saved.priv,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false, ['sign']
      );
      return { privKey, pubJwk: saved.pub };
    } catch {
      // Korrupte Keys → neu generieren
    }
  }

  // Neu generieren — extractable=true damit JWK exportierbar (Storage)
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true, ['sign', 'verify']
  );
  const pubJwk  = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  await idbSet(IDB_SIG_KEYPAIR, { pub: pubJwk, priv: privJwk });
  return { privKey: pair.privateKey, pubJwk };
}

/**
 * Liefert den Signing-Public-Key als JWK.
 * Wird beim Inbox-Upload mitgeschickt (für Server-Side Sig-Verify-Cache).
 */
export async function getSigningPublicKeyJwk() {
  const { pubJwk } = await getOrCreateSigningKeyPair();
  return pubJwk;
}

// ======================================================
// Upload mit Retry (für kritische Add-Device-Path)
// ======================================================

async function _uploadWithRetry(url, body) {
  for (let attempt = 0; attempt < UPLOAD_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) return true;
      // 4xx (außer 429) = harter Fehler, kein Retry sinnvoll
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        console.warn('📮 Upload: harter Fehler', res.status, '— kein Retry');
        return false;
      }
      console.warn(`📮 Upload Versuch ${attempt + 1} fehlgeschlagen (${res.status}) — retry in ${UPLOAD_RETRY_DELAYS_MS[attempt]}ms`);
    } catch (e) {
      console.warn(`📮 Upload Versuch ${attempt + 1} — Network: ${e?.message || e}`);
    }
    await new Promise(r => setTimeout(r, UPLOAD_RETRY_DELAYS_MS[attempt]));
  }

  // Alle Foreground-Versuche fehlgeschlagen → Hintergrund-Loop (1× pro URL)
  if (!_bgRetryActive.has(url)) {
    _bgRetryActive.add(url);
    const bgStart = Date.now();
    console.warn(`📮 Upload: Foreground-Retries erschöpft — starte Hintergrund-Retry alle ${UPLOAD_BG_RETRY_MS / 1000}s`);
    (async function bgLoop() {
      while (_bgRetryActive.has(url)) {
        await new Promise(r => setTimeout(r, UPLOAD_BG_RETRY_MS));
        try {
          const res = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (res.ok) {
            console.log('📮 Upload: Hintergrund-Retry erfolgreich nach', Math.round((Date.now() - bgStart) / 1000), 's');
            _bgRetryActive.delete(url);
            return;
          }
        } catch {}
      }
    })();
  }
  return false;
}

// ======================================================
// Public: Inbox-Key hochladen (idempotent)
// ======================================================

/**
 * Lädt den Inbox-Pubkey + Sig-Pubkey hoch, falls nötig.
 * Idempotent: Backend macht UPSERT — mehrfache Calls sind safe.
 * Wird beim Bootstrap nach Login aufgerufen.
 *
 * Spec: docs/MULTI_DEVICE.md §4.1
 *
 * @returns {Promise<boolean>} true bei Erfolg
 */
export async function uploadInboxKeyIfNeeded() {
  try {
    // 1. Stelle sicher dass Keypair existiert
    await initE2EKeys();

    const deviceId = getDeviceId();
    if (!deviceId) {
      console.warn('📮 Inbox-Key: kein deviceId');
      return false;
    }

    const pubKey = await loadPublicKey();
    if (!pubKey) {
      console.warn('📮 Inbox-Key: kein PublicKey');
      return false;
    }

    const jwk    = await crypto.subtle.exportKey('jwk', pubKey);
    const sigPub = await getSigningPublicKeyJwk();
    const name   = detectDeviceName();

    return await _uploadWithRetry(`${API}/e2e/inbox/upload`, {
      jwk, deviceId, sigPub, name,
    });
  } catch (e) {
    captureException(e, { context: 'uploadInboxKeyIfNeeded' });
    return false;
  }
}
