// ======================================================
// hybridSession.js — die EINE Naht Sesame ⊕ PQXDH ⊕ Ratchet (Contract §4.0)
// ======================================================
// M2-Umfang: die HANDSHAKE-Runner um den pqxdh-Krypto-Kern.
//   ensureHybridSession(peer, dev)          → Initiator: Bundle holen +
//                                             initiatorRoot + InitHdr bauen.
//   acceptHybridSession(peer, dev, initHdr) → Responder: consumeForResponder +
//                                             responderRoot.
// Beide liefern einen (M2-minimalen) SessionRecord — RK0 + Metadaten. Der
// VOLLE SessionRecord (encrypt/decrypt/Double-Ratchet, D2) kommt in P3; die
// Naht bleibt aber JETZT fix, damit keine Phase sie retrofit (= Desync).
//
// Contract-Punkte, die schon hier gelten (§4.0):
//   D1 per-peer-device: Identität = (peerHandle, peerDeviceId), device-scoped
//       persistiert unter `hybridsession:<peer>:<dev>` (P3 migriert nach
//       `session:<peer>:<dev>`, sobald der Ratchet dranhängt).
//   D3 zwei benannte Konstruktoren (PQXDH ist asymmetrisch) → beide SessionRecord.
//       ensureHybridSession = single-flight + idempotent pro (peer,dev)
//       (verhindert doppelten OPK-Verbrauch).
//   D4 Simultan-Init-Tie-Break: lexikografischer IK-Vergleich, niedrigere
//       gewinnt; Verlierer wird archiviert.
//   D5 sid-in-AAD: greift erst beim encrypt (P3) — hier nur vermerkt.
//
// RK0 ist ein Secret → SessionRecord wird at-rest versiegelt (deviceStore).
// ======================================================
import { apiFetch } from './api.js';
import { bytesToB64, b64ToBytes } from './bytes.js';
import { idbGet, idbSet } from './idb.js';
import { deriveStorageKey, sealJson, openJson } from './deviceStore.js';
import { x25519Keygen } from './pqCrypto.js';
import { initiatorRoot, responderRoot, signInitHdr, verifyInitHdr } from './pqxdh.js';
import { getOrCreateIdentity, decodeInitiatorBundle, consumeForResponder } from './pqxdhKeys.js';

const ALG = 'pqxdh-x25519-mlkem768';
const ALGO_VERSION = 3;
const STORE_INFO = 'renex:hybridsession:store:v1';
const _key = () => deriveStorageKey(STORE_INFO);
const _idbKey = (peer, dev) => `hybridsession:${peer}:${dev}`;
const _archiveKey = (peer, dev) => `hybridsession:archive:${peer}:${dev}`;

// Single-flight: dedupliziert nebenläufige ensure-Aufrufe pro (peer,dev), sonst
// würden zwei Aufrufe zwei OPKs des Peers verbrauchen.
const _inflight = new Map();

// ── Tie-Break-Helfer (D4) — pure, testbar ──────────────
/** Lexikografischer Byte-Vergleich (NICHT b64-String-Vergleich). */
export function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1);
}
/**
 * D4: bei Simultan-Init gewinnt die Session mit dem lexikografisch NIEDRIGEREN
 * Initiator-IK. Gibt zurück, ob MEIN Init gewinnt (ich der kanonische Initiator
 * bleibe). Gleichstand (===) ist ausgeschlossen (verschiedene Identitäten).
 */
export function myInitWins(myIkPub, peerIkPub) {
  return compareBytes(myIkPub, peerIkPub) < 0;
}

// ── Persistenz (versiegelt) ────────────────────────────
async function _loadRecord(peer, dev) {
  const sealed = await idbGet(_idbKey(peer, dev));
  if (!sealed) return null;
  const rec = await openJson(await _key(), sealed);
  return rec || null;
}
async function _saveRecord(peer, dev, rec) {
  await idbSet(_idbKey(peer, dev), await sealJson(await _key(), rec));
}

/**
 * Simultan-Init-Auflösung (D4): existiert bereits ein Record der GEGENrolle für
 * (peer,dev), behalte den Gewinner (niedrigerer Initiator-IK), archiviere den
 * Verlierer. `myIkPubB64`/`peerIkPubB64` = die beiden Initiator-IKs der Kollision.
 * @returns {boolean} true = der NEUE Record gewinnt (wurde gespeichert).
 */
async function _persistWithTieBreak(peer, dev, rec, myIkPubB64, peerIkPubB64) {
  const existing = await _loadRecord(peer, dev);
  if (existing && existing.role !== rec.role) {
    const newWins = myInitWins(b64ToBytes(myIkPubB64), b64ToBytes(peerIkPubB64));
    if (newWins) {
      await idbSet(_archiveKey(peer, dev), await sealJson(await _key(), existing));
      await _saveRecord(peer, dev, rec);
      return true;
    }
    // Bestehender gewinnt → neuen archivieren, bestehenden behalten.
    await idbSet(_archiveKey(peer, dev), await sealJson(await _key(), rec));
    return false;
  }
  await _saveRecord(peer, dev, rec);
  return true;
}

// ======================================================
// INITIATOR (D3): ensureHybridSession
// ======================================================
export function ensureHybridSession(peerHandle, peerDeviceId) {
  const peer = String(peerHandle || '').toLowerCase();
  const dev = String(peerDeviceId || '');
  const flightKey = `${peer}:${dev}`;
  if (_inflight.has(flightKey)) return _inflight.get(flightKey);
  const p = _ensureInitiator(peer, dev).finally(() => _inflight.delete(flightKey));
  _inflight.set(flightKey, p);
  return p;
}

async function _ensureInitiator(peer, dev) {
  if (!peer || !dev) throw new Error('hybridSession: peer/device required');

  // Idempotent: bestehende Session zurückgeben, KEIN weiterer OPK-Verbrauch.
  // rootKey einheitlich als rohe Bytes an den Aufrufer (persistiert ist b64).
  const existing = await _loadRecord(peer, dev);
  if (existing && existing.role === 'initiator') return { ...existing, rootKey: b64ToBytes(existing.rootKey) };

  // Bundle EINES Ziel-Geräts holen (per-peer-device, D1). Der Server konsumiert
  // dabei atomar EINE OPK (PrekeyDO) → single-opk-Wire.
  const res = await apiFetch(`/e2e/pqxdh/bundle?user=${encodeURIComponent(peer)}&device=${encodeURIComponent(dev)}`);
  if (!res.ok || !res.data || !res.data.ik) {
    throw new Error(`hybridSession: bundle fetch failed (${res.status || res.error || 'no_bundle'})`);
  }
  const wire = res.data;
  const bundle = decodeInitiatorBundle(wire);   // wirft NICHT; initiatorRoot prüft die Sigs

  // Eigene Identität + frische Ephemeral.
  const { ikX, ikEd } = await getOrCreateIdentity();
  const ekA = x25519Keygen();

  // Root ableiten (verifiziert Bobs SPK/PQSPK-Sigs, wirft bei Manipulation).
  const { rk0, kemCt, usedOpk } = initiatorRoot({ ikAPriv: ikX.priv, ekAPriv: ekA.priv, bundle });

  // InitHdr bauen (geht in den ersten Ciphertext, P3). hdrSig über die
  // kanonischen Felder mit dem eigenen IK-Ed.
  const usedSpkId = wire.spk?.spkId;
  const usedPqspkId = wire.pqspk?.pqspkId;
  const usedOpkId = (usedOpk && wire.opk) ? wire.opk.opkId : null;
  const sigFields = {
    v: ALGO_VERSION, alg: ALG,
    ikA25519: ikX.pub, ekA25519: ekA.pub,
    usedSpkId, usedOpkId, usedPqspkId, mlkemCt: kemCt,
  };
  const hdrSig = signInitHdr(sigFields, ikEd.priv);
  const initHdr = {
    v: ALGO_VERSION, alg: ALG,
    ikA25519: bytesToB64(ikX.pub),
    ikAEd: bytesToB64(ikEd.pub),
    ekA25519: bytesToB64(ekA.pub),
    usedSpkId, usedOpkId, usedPqspkId,
    mlkemCt: bytesToB64(kemCt),
    hdrSig: bytesToB64(hdrSig),
  };

  const rec = {
    algoVersion: ALGO_VERSION,
    role: 'initiator',
    peerHandle: peer, peerDeviceId: dev,
    rootKey: bytesToB64(rk0),
    initHdr,
    // P3: Bobs SPK-Pub = initialer Ratchet-DHr (Signal-Konvention, ratchet.js).
    peerSpkPub: bytesToB64(bundle.spkX),
    createdAt: Date.now(),
  };
  // Peer-IK aus dem Bundle für den Tie-Break (D4).
  await _persistWithTieBreak(peer, dev, rec, initHdr.ikA25519, bytesToB64(bundle.ikX));
  // rootKey als rohe Bytes an den Aufrufer (in-memory), Rest wie persistiert.
  return { ...rec, rootKey: rk0 };
}

// ======================================================
// RESPONDER (D3): acceptHybridSession
// ======================================================
/**
 * @param {string} peerHandle    Absender (aus dem Wire: `from`)
 * @param {string} peerDeviceId  Absender-Gerät (aus dem Wire: `senderDeviceId`)
 * @param {object} initHdr       der empfangene InitHdr
 * @param {{enforce?:boolean}} [opts] enforce=true → bei ungültiger hdrSig werfen
 *        (Default false = Dark-Launch verify+log, kein Reject, §4.3)
 * @returns {Promise<object>} SessionRecord (M2-minimal)
 */
export async function acceptHybridSession(peerHandle, peerDeviceId, initHdr, { enforce = false } = {}) {
  const peer = String(peerHandle || '').toLowerCase();
  const dev = String(peerDeviceId || '');
  if (!peer || !dev) throw new Error('hybridSession: peer/device required');
  if (!initHdr || initHdr.v !== ALGO_VERSION || initHdr.alg !== ALG) {
    throw new Error('hybridSession: bad initHdr version/alg');
  }

  const ikA25519 = b64ToBytes(initHdr.ikA25519);
  const ekA25519 = b64ToBytes(initHdr.ekA25519);
  const mlkemCt = b64ToBytes(initHdr.mlkemCt);
  const usedOpk = !!initHdr.usedOpkId;

  // hdrSig verifizieren (gegen mitgeliefertes ikAEd; Registry-Pinning = P3).
  // Dark-Launch: verify+log, KEIN Reject — außer enforce.
  const sigFields = {
    v: ALGO_VERSION, alg: ALG,
    ikA25519, ekA25519,
    usedSpkId: initHdr.usedSpkId, usedOpkId: initHdr.usedOpkId, usedPqspkId: initHdr.usedPqspkId,
    mlkemCt,
  };
  const hdrSigOk = verifyInitHdr(sigFields, b64ToBytes(initHdr.hdrSig), b64ToBytes(initHdr.ikAEd));
  if (!hdrSigOk) {
    if (enforce) throw new Error('hybridSession: initHdr sig invalid');
    console.warn(`⚠️ pqxdh acceptHybridSession: hdrSig ungültig (verify+log, Dark-Launch) — ${peer}:${dev}`);
  }

  // Eigene Responder-Privs holen + die referenzierte OPK KONSUMIEREN (one-time).
  const privs = await consumeForResponder({
    spkId: initHdr.usedSpkId,
    opkId: initHdr.usedOpkId || null,
    pqspkId: initHdr.usedPqspkId,
  });

  const rk0 = responderRoot({
    ikBPriv: privs.ikBPriv,
    spkBPriv: privs.spkBPriv,
    opkBPriv: privs.opkBPriv,
    pqspkDk: privs.pqspkDk,
    ikAX: ikA25519, ekAX: ekA25519, kemCt: mlkemCt, usedOpk,
  });

  const rec = {
    algoVersion: ALGO_VERSION,
    role: 'responder',
    peerHandle: peer, peerDeviceId: dev,
    rootKey: bytesToB64(rk0),
    hdrSigOk,
    // P3: eigenes SPK-Priv = initiales Ratchet-DHs des Responders (ratchet.js).
    ownSpkPriv: bytesToB64(privs.spkBPriv),
    createdAt: Date.now(),
  };
  // Tie-Break (D4): meine Identität vs. der Initiator-IK aus dem Header.
  const { ikX } = await getOrCreateIdentity();
  await _persistWithTieBreak(peer, dev, rec, bytesToB64(ikX.pub), initHdr.ikA25519);
  return { ...rec, rootKey: rk0 };
}
