// ======================================================
// ML-KEM-768 Device-Identität (Migration M1 — Sesame-Core)
// ======================================================
// Erzeugt/lädt das langlebige ML-KEM-768-Keypair dieses Geräts (der PQ-Teil der
// hybriden Identität). Der Public `ek` (1184 B) wird publiziert (Inbox/devset);
// der geheime `dk` (2400 B) liegt — mangels WebCrypto-ML-KEM — als ROHE, extractable
// Bytes vor, aber AT-REST AES-GCM-verschlüsselt unter einem aus `device_secret`
// abgeleiteten Storage-Key (dasselbe device_secret wie cmk.js, distinkter info-String).
//
// ⚠️ EHRLICH (Security-Doc): der klassische Inbox-ECDH-Priv ist non-extractable;
// die ML-KEM-`dk` ist es NICHT (WebCrypto kennt kein ML-KEM) → neue Schlüsselklasse,
// muss ins Recovery-Bundle (P5), vergrößert die lokale Exfil-Oberfläche. Bewusst.
//
// NICHT von Live-Code importiert (M1-Fundament) → tree-shaking hält es aus dem
// App-Bundle bis Sesame/PQXDH es nutzt.
// ======================================================
import { idbGet, idbSet } from './idb.js';
import { bytesToB64, b64ToBytes } from './bytes.js';
import { mlKemKeygen, PQ } from './pqCrypto.js';

const IDB_KEM_IDENTITY = 'pqxdh:kem-identity';  // { ek:b64, ivB64, ctB64 } (dk verschlüsselt)
const IDB_DEVICE_SECRET = 'device_secret';      // GETEILT mit cmk.js — dieselbe Quelle

// device_secret lesen (oder konsistent zu cmk.js anlegen: 32 rand → b64).
async function _deviceSecretBytes() {
  let s = await idbGet(IDB_DEVICE_SECRET);
  if (!s) {
    s = bytesToB64(crypto.getRandomValues(new Uint8Array(32)));
    await idbSet(IDB_DEVICE_SECRET, s);
  }
  return b64ToBytes(s);
}

// KEM-spezifischer Storage-Key (distinkter info-String → isoliert vom CMK-Storage).
async function _kemStorageKey() {
  const base = await crypto.subtle.importKey('raw', await _deviceSecretBytes(), { name: 'HKDF' }, false, ['deriveKey']);
  const info = new TextEncoder().encode('renex:kemstore:v1');
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function _persist(ek, dk, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, dk);
  await idbSet(IDB_KEM_IDENTITY, {
    ek: bytesToB64(ek), ivB64: bytesToB64(iv), ctB64: bytesToB64(new Uint8Array(ct)),
  });
}

/**
 * Erzeugt (einmalig) oder lädt die ML-KEM-768-Device-Identität.
 * @returns {Promise<{ek: Uint8Array, dk: Uint8Array}>}
 */
export async function getOrCreateKemIdentity() {
  const key = await _kemStorageKey();
  const saved = await idbGet(IDB_KEM_IDENTITY);
  if (saved?.ek && saved?.ivB64 && saved?.ctB64) {
    try {
      const iv = b64ToBytes(saved.ivB64);
      const dk = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64ToBytes(saved.ctB64)));
      const ek = b64ToBytes(saved.ek);
      if (ek.length === PQ.ML_KEM_EK && dk.length === PQ.ML_KEM_DK) return { ek, dk };
    } catch { /* korrupt → neu erzeugen */ }
  }
  const { ek, dk } = mlKemKeygen();
  await _persist(ek, dk, key);
  return { ek, dk };
}

/** Nur der öffentliche `ek` (fürs Publishing in Inbox/devset). */
export async function getKemPublicKey() {
  return (await getOrCreateKemIdentity()).ek;
}

/** Rohe `dk`-Bytes fürs Recovery-Bundle (P5). ⚠️ NUR fürs Bundle verwenden. */
export async function exportKemSecretForBundle() {
  return (await getOrCreateKemIdentity()).dk;
}

/** Import beim Recovery-Restore (P5): überschreibt die lokale KEM-Identität. */
export async function importKemIdentity(ek, dk) {
  if (!(ek instanceof Uint8Array) || !(dk instanceof Uint8Array) ||
      ek.length !== PQ.ML_KEM_EK || dk.length !== PQ.ML_KEM_DK) {
    throw new Error('kem identity size mismatch');
  }
  await _persist(ek, dk, await _kemStorageKey());
}
