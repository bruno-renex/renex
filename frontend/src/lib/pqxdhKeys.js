// ======================================================
// PQXDH Prekey-Bundle-Management (Client) — Migration M2
// ======================================================
// Erzeugt/persistiert die PQXDH-Schlüssel dieses Geräts und liefert das
// publizierbare Bundle (nur Pubs) + die Responder-Privs für eingehende Handshakes.
//   IK    = Identity: X25519 (DH) + Ed25519 (signiert Prekeys)
//   SPK   = Signed Prekey (X25519, IK-Ed-signiert)
//   PQSPK = ML-KEM-768 Signed Prekey (IK-Ed-signiert)
//   OPK   = One-Time-Prekey-Pool (X25519)
// Alle Privs at-rest AES-GCM-versiegelt (deviceStore, device_secret-abgeleitet).
// ⚠️ dk/Privs extractable (nötig fürs Recovery-Bundle P5) — ehrlich dokumentiert.
// ======================================================
import { idbGet, idbSet } from './idb.js';
import { bytesToB64, b64ToBytes } from './bytes.js';
import { deriveStorageKey, sealJson, openJson } from './deviceStore.js';
import { x25519Keygen, x25519PublicKey, ed25519Keygen, mlKemKeygen } from './pqCrypto.js';
import { signPrekey } from './pqxdh.js';

const INFO = 'renex:pqxdh:store:v1';
const IDB_ID = 'pqxdh:identity', IDB_SPK = 'pqxdh:spk', IDB_PQSPK = 'pqxdh:pqspk', IDB_OPKS = 'pqxdh:opks';
const OPK_POOL = 100;

const _key = () => deriveStorageKey(INFO);
function _rid() {
  return bytesToB64(crypto.getRandomValues(new Uint8Array(6))).replace(/[+/=]/g, '').slice(0, 8) || 'x';
}

/** Identität (IK): X25519 + Ed25519. Langlebig, einmalig erzeugt. */
export async function getOrCreateIdentity() {
  const key = await _key();
  const s = await openJson(key, await idbGet(IDB_ID));
  if (s?.ikXPriv) return {
    ikX: { priv: b64ToBytes(s.ikXPriv), pub: b64ToBytes(s.ikXPub) },
    ikEd: { priv: b64ToBytes(s.ikEdPriv), pub: b64ToBytes(s.ikEdPub) },
  };
  const ikX = x25519Keygen(), ikEd = ed25519Keygen();
  await idbSet(IDB_ID, await sealJson(key, {
    ikXPriv: bytesToB64(ikX.priv), ikXPub: bytesToB64(ikX.pub),
    ikEdPriv: bytesToB64(ikEd.priv), ikEdPub: bytesToB64(ikEd.pub),
  }));
  return { ikX, ikEd };
}

/** Signed Prekey (X25519, IK-Ed-signiert). `rotate` erzeugt einen frischen. */
export async function getOrCreateSignedPrekey({ rotate = false } = {}) {
  const key = await _key();
  if (!rotate) {
    const s = await openJson(key, await idbGet(IDB_SPK));
    if (s?.spkId) return { spkId: s.spkId, priv: b64ToBytes(s.priv), pub: b64ToBytes(s.pub), sig: b64ToBytes(s.sig) };
  }
  const { ikEd } = await getOrCreateIdentity();
  const spk = x25519Keygen(), spkId = _rid();
  const sig = signPrekey('spk', spk.pub, ikEd.priv);
  await idbSet(IDB_SPK, await sealJson(key, { spkId, priv: bytesToB64(spk.priv), pub: bytesToB64(spk.pub), sig: bytesToB64(sig) }));
  return { spkId, priv: spk.priv, pub: spk.pub, sig };
}

/** ML-KEM-768 Signed Prekey (IK-Ed-signiert). */
export async function getOrCreatePqSignedPrekey({ rotate = false } = {}) {
  const key = await _key();
  if (!rotate) {
    const s = await openJson(key, await idbGet(IDB_PQSPK));
    if (s?.pqspkId) return { pqspkId: s.pqspkId, ek: b64ToBytes(s.ek), dk: b64ToBytes(s.dk), sig: b64ToBytes(s.sig) };
  }
  const { ikEd } = await getOrCreateIdentity();
  const { ek, dk } = mlKemKeygen(), pqspkId = _rid();
  const sig = signPrekey('pqspk', ek, ikEd.priv);
  await idbSet(IDB_PQSPK, await sealJson(key, { pqspkId, ek: bytesToB64(ek), dk: bytesToB64(dk), sig: bytesToB64(sig) }));
  return { pqspkId, ek, dk, sig };
}

/** One-Time-Prekey-Pool bis `target` auffüllen (persistiert privs). */
export async function ensureOpkPool(target = OPK_POOL) {
  const key = await _key();
  const map = (await openJson(key, await idbGet(IDB_OPKS))) || {};
  const need = target - Object.keys(map).length;
  const added = [];
  for (let i = 0; i < need; i++) {
    const opk = x25519Keygen(), opkId = _rid();
    map[opkId] = bytesToB64(opk.priv);
    added.push({ opkId, pub: opk.pub });
  }
  if (added.length) await idbSet(IDB_OPKS, await sealJson(key, map));
  const all = Object.entries(map).map(([opkId, priv]) => ({ opkId, pub: x25519PublicKey(b64ToBytes(priv)) }));
  return { added, all, count: all.length };
}

/** Publizierbares Bundle (nur Pubs) für POST /e2e/pqxdh/upload. */
export async function buildPublishBundle({ opkCount = OPK_POOL } = {}) {
  const { ikX, ikEd } = await getOrCreateIdentity();
  const spk = await getOrCreateSignedPrekey();
  const pqspk = await getOrCreatePqSignedPrekey();
  const { all } = await ensureOpkPool(opkCount);
  return {
    ik: { ikX: bytesToB64(ikX.pub), ikEd: bytesToB64(ikEd.pub) },
    spk: { spkId: spk.spkId, spk: bytesToB64(spk.pub), sig: bytesToB64(spk.sig) },
    pqspk: { pqspkId: pqspk.pqspkId, ek: bytesToB64(pqspk.ek), sig: bytesToB64(pqspk.sig) },
    opks: all.map(o => ({ opkId: o.opkId, opk: bytesToB64(o.pub) })),
  };
}

/** Server-Bundle (EIN OPK) → Input für pqxdh.initiatorRoot (decodiert). */
export function decodeInitiatorBundle(wire) {
  return {
    ikEdPub: b64ToBytes(wire.ik.ikEd),
    ikX: b64ToBytes(wire.ik.ikX),
    spkX: b64ToBytes(wire.spk.spk),
    spkSig: b64ToBytes(wire.spk.sig),
    ...(wire.opk ? { opkX: b64ToBytes(wire.opk.opk) } : {}),
    pqspkEk: b64ToBytes(wire.pqspk.ek),
    pqspkSig: b64ToBytes(wire.pqspk.sig),
  };
}

/**
 * Responder-Privs für einen eingehenden InitHdr (referenziert spkId/opkId/pqspkId).
 * KONSUMIERT die OPK (löscht sie lokal — one-time). Wirft bei unbekannter/
 * bereits-konsumierter ID.
 */
export async function consumeForResponder({ spkId, opkId, pqspkId }) {
  const key = await _key();
  const id = await getOrCreateIdentity();
  const spk = await openJson(key, await idbGet(IDB_SPK));
  const pqspk = await openJson(key, await idbGet(IDB_PQSPK));
  if (!spk || spk.spkId !== spkId) throw new Error('spk_unknown');       // Rotation: alte SPKs behalten = TODO
  if (!pqspk || pqspk.pqspkId !== pqspkId) throw new Error('pqspk_unknown');
  let opkBPriv = null;
  if (opkId) {
    const map = (await openJson(key, await idbGet(IDB_OPKS))) || {};
    if (!map[opkId]) throw new Error('opk_consumed_or_unknown');
    opkBPriv = b64ToBytes(map[opkId]);
    delete map[opkId];                        // one-time consume
    await idbSet(IDB_OPKS, await sealJson(key, map));
  }
  return {
    ikBPriv: id.ikX.priv,
    spkBPriv: b64ToBytes(spk.priv),
    opkBPriv,
    pqspkDk: b64ToBytes(pqspk.dk),
  };
}
