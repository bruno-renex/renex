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
import { bytesToB64 } from './bytes.js';
import { getKemPublicKey } from './kemIdentity.js';

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

/**
 * deviceId per User scopen. Verhindert dass mehrere User auf demselben Browser
 * den gleichen device_id beanspruchen (was im Backend zu user_handle-Mismatch
 * + 404 Heartbeat führt — siehe Multi-Device-Hardening 2026-05-02).
 *
 * Storage-Key: `device_id:<handle>`. Legacy-Key `device_id` wird ignoriert.
 * Pro User-Login auf einem Browser: eigener stabiler deviceId.
 */
export function getDeviceId() {
  const handle = (typeof localStorage !== 'undefined'
    ? localStorage.getItem('my_user') : null) || '';
  const lower = String(handle).toLowerCase();
  // Vor Login (handle leer): legacy Key als Fallback (für e2e Init-Pfade vor User-Login)
  const key = lower ? `device_id:${lower}` : 'device_id';

  let id = localStorage.getItem(key);
  if (!id) {
    id = 'dev_' + crypto.randomUUID();
    localStorage.setItem(key, id);
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
// Security-Hardening (2026-05-02 H1): privateKey wird als non-extractable
// CryptoKey direkt in IDB gespeichert (statt vorher als JWK exportiert).
// Bei XSS / IDB-Compromise kann der Key nicht mehr offline exfiltriert werden.
// Public-Key bleibt JWK (ist eh public, wird beim Inbox-Upload mitgeschickt).
//
// Legacy-Format: { pub: pubJwk, priv: privJwk } → wird beim ersten Load migriert
// New-Format:    { pub: pubJwk, priv: CryptoKey (non-extractable) }
// ======================================================

function _isLegacySigJwk(priv) {
  // Legacy: priv war ein exportiertes JWK-Objekt mit kty='EC'.
  // New: priv ist ein CryptoKey (hat kein kty-Feld, dafür type/algorithm/usages).
  return priv && typeof priv === 'object' && priv.kty === 'EC';
}

async function _migrateLegacySigKey(legacyPriv, pubJwk) {
  // Importiert legacy JWK als NON-EXTRACTABLE — ab diesem Moment ist der Key
  // nicht mehr exportierbar, selbst aus dem CryptoKey-Objekt.
  const privKey = await crypto.subtle.importKey(
    'jwk', legacyPriv,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,        // <- key change: extractable=false
    ['sign']
  );
  // Persistieren im neuen Format. Legacy-JWK wird überschrieben + ist weg.
  await idbSet(IDB_SIG_KEYPAIR, { pub: pubJwk, priv: privKey });
  console.log('🔐 Sig-Keypair migrated to non-extractable storage');
  return privKey;
}

async function getOrCreateSigningKeyPair() {
  const saved = await idbGet(IDB_SIG_KEYPAIR);
  if (saved?.pub && saved?.priv) {
    // Legacy → migrate
    if (_isLegacySigJwk(saved.priv)) {
      try {
        const privKey = await _migrateLegacySigKey(saved.priv, saved.pub);
        return { privKey, pubJwk: saved.pub };
      } catch {
        // Korrupte Keys → fallthrough zu neu generieren
      }
    } else {
      // New format: priv ist CryptoKey (oder structured-clone davon)
      return { privKey: saved.priv, pubJwk: saved.pub };
    }
  }

  // Neu generieren — extractable=false. Nur publicKey kann via exportKey
  // ausgegeben werden (Public-Keys sind per WebCrypto-Spec immer extractable).
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,        // <- privateKey ist non-extractable
    ['sign', 'verify']
  );
  const pubJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  // privateKey wird als CryptoKey gespeichert (nicht exportiert!)
  await idbSet(IDB_SIG_KEYPAIR, { pub: pubJwk, priv: pair.privateKey });
  return { privKey: pair.privateKey, pubJwk };
}

/**
 * Lädt den Signing-Private-Key aus IDB. Wird von messageSig.signMessage genutzt.
 * Migriert Legacy-JWK-Format on-the-fly zum non-extractable CryptoKey.
 *
 * @returns {Promise<CryptoKey|null>} non-extractable ECDSA-P256 PrivateKey
 *   oder null wenn Keypair noch nicht initialisiert ist.
 */
export async function loadSigningPrivKey() {
  const saved = await idbGet(IDB_SIG_KEYPAIR);
  if (!saved?.priv || !saved?.pub) return null;
  if (_isLegacySigJwk(saved.priv)) {
    try {
      return await _migrateLegacySigKey(saved.priv, saved.pub);
    } catch {
      return null;
    }
  }
  return saved.priv;  // CryptoKey (already non-extractable in new format)
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
      if (res.ok) return { ok: true };
      // 4xx (außer 429) = harter Fehler, kein Retry sinnvoll
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        console.warn('📮 Upload: harter Fehler', res.status, '— kein Retry');
        // 409 device_limit_reached: Body durchreichen damit UI Modal anzeigen kann
        if (res.status === 409) {
          try {
            const data = await res.json();
            if (data?.error === 'device_limit_reached') {
              return {
                ok: false,
                deviceLimit: {
                  currentDevices: data.currentDevices,
                  maxDevices: data.maxDevices,
                  upgradeAvailable: data.upgradeAvailable === true,
                },
              };
            }
          } catch {}
        }
        return { ok: false };
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
  return { ok: false };
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
 * @returns {Promise<{ok: boolean, deviceLimit?: {currentDevices: number, maxDevices: number, upgradeAvailable: boolean}}>}
 */
export async function uploadInboxKeyIfNeeded() {
  try {
    // 1. Stelle sicher dass Keypair existiert
    await initE2EKeys();

    const deviceId = getDeviceId();
    if (!deviceId) {
      console.warn('📮 Inbox-Key: kein deviceId');
      return { ok: false };
    }

    const pubKey = await loadPublicKey();
    if (!pubKey) {
      console.warn('📮 Inbox-Key: kein PublicKey');
      return { ok: false };
    }

    const jwk    = await crypto.subtle.exportKey('jwk', pubKey);
    const sigPub = await getSigningPublicKeyJwk();
    const name   = detectDeviceName();

    // M1 (Sesame-Core, Dark-Launch): ML-KEM-768-Prekey additiv mitpublizieren.
    // Best-effort — schlägt es fehl, geht der klassische Upload trotzdem durch
    // (Server akzeptiert kemEk optional). ratchet-caps erst ab P3.
    let kemFields = {};
    try {
      const ek = await getKemPublicKey();
      // caps = Empfangs-CAPABILITY (nicht Send-Flag): pqrekey=true sobald der
      // Code deployed ist → andere Clients dürfen mir eine P3.2-B-Rekey-Epoche
      // announcen (Empfangs-/Aktivierungspfad ist immer an). Ohne diese cap
      // würde ein Announcer mich (dann alter v4-Empfänger) nach der Aktivierung
      // locken → capability-Gate ist zwingend.
      kemFields = { kemEk: bytesToB64(ek), caps: { hybrid: true, ratchet: false, pqrekey: true } };
    } catch (e) {
      console.warn('📮 kemEk-Publishing übersprungen (non-fatal):', e?.message);
    }

    return await _uploadWithRetry(`${API}/e2e/inbox/upload`, {
      jwk, deviceId, sigPub, name, ...kemFields,
    });
  } catch (e) {
    captureException(e, { context: 'uploadInboxKeyIfNeeded' });
    return { ok: false };
  }
}
