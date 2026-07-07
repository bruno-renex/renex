// ======================================================
// pqRatchet.js — ML-KEM-Epoch-Rekey über dem Double-Ratchet (P3.2-B, §4.4)
// ======================================================
// „PQ-Triple": re-injiziert periodisch ML-KEM-768-Entropie in den Root-Key,
// damit eine langlebige Session hybrid-PQ bleibt — der PQ-Anteil aus dem
// PQXDH-Handshake „altert" sonst mit jedem rein-klassischen X25519-DH-Step
// aus (Harvest-now-decrypt-later auf die DH-Steps).
//
// Protokoll (DEFERRED COMMIT — der Mix ist deterministisch an einen DH-Pub
// gebunden, NIE an Wanduhr/Empfangsreihenfolge; Kern-Lehre: Ratchet-Desync
// heilt NICHT durch Re-Fetch):
//
//   ANNOUNCE   Nur die Initiator-Rolle der Session announct (→ strukturell
//              keine Announce-Kollisionen, kein Tie-Break nötig). Bei
//              Fälligkeit (PQRK.MSG_LIMIT Nachrichten über BEIDE Richtungen
//              ODER PQRK.AGE_MS — NIE per-Nachricht; Pulse läuft strukturell
//              nie durch diese Schicht) encapsuliert er gegen die ML-KEM-
//              Device-Identität (kemEk, M1/kemIdentity.js) des Peer-Devices
//              und hält {ss, ct} als pendingOut. Der CT reitet ab jetzt auf
//              jeder Nachricht mit (Header: pqTgt + pqFp = 8B-SHA-256-CT-
//              Fingerprint, via AAD=header_b64 + msgv4-Sig gedeckt; Wire:
//              pq_kem_ct als eigenes Feld — 1088 B passen nicht in den
//              Header, Server-Cap 512), bis der Peer die neue Epoche echot
//              oder MAX_CT_SENDS erreicht ist (die D1-History trägt den CT
//              danach weiter — Muster MAX_INIT_SENDS).
//
//   AKTIVIERUNG  Der Mix wirkt exakt an dem Root-KDF, der den NÄCHSTEN
//              eigenen Ratchet-Pub des Announcers konsumiert: beim Announcer
//              am preR2-Hook seines nächsten DH-Steps (nach dem keygen, vor
//              der Sendeketten-KDF), beim Empfänger am preR1-Hook des
//              DH-Steps, den genau dieser Pub triggert. Beide berechnen
//              identisch rk' = mixRoot(rk, ss_pq, ct, aktivierender Pub,
//              Ziel-kemEk, Epoche) — CT-bindend (§6). Laufende Ketten und
//              Skipped-Keys bleiben unberührt → kreuzende Nachrichten und
//              Out-of-Order über die Epoch-Grenze können nicht desyncen.
//
//   CONFIRM    Sieht der Announcer einen Peer-Header mit kemEpoch ≥ Ziel,
//              endet das CT-Attachen (pendingOut=null, confirmedEpoch).
//
// Fehlerdisziplin: Aktivierung ohne verfügbaren CT → locked (Aufrufer gibt
// null zurück, Retry via History/Redelivery holt den CT nach), NIEMALS raten
// oder steppen. Alle Mutationen hier sind in-memory; persistiert wird nur im
// Erfolgspfad des Aufrufers (ratchetSession-Muster) → Replay-/Retry-fest,
// ein pq_rekey kann den Root nie doppelt mischen.
//
// Pure & Node-testbar (Stil ratchet.js/pqxdh.js): kemDk/kemEk/now kommen als
// Parameter — kein IDB, kein Netz, kein Date.now() hier.
// ======================================================
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import {
  PQ, mlKemEncapsulate, mlKemDecapsulate, deriveHybridWrapKey,
} from './pqCrypto.js';
import { bytesToB64, b64ToBytes } from './bytes.js';

export const PQRK = Object.freeze({
  MSG_LIMIT: 50,                     // Rekey nach 50 Nachrichten (send+recv) …
  AGE_MS: 7 * 24 * 3600 * 1000,      // … ODER 7 Tagen (was zuerst; §4.4)
  MAX_CT_SENDS: 32,                  // CT höchstens so oft mitschicken (History trägt danach)
});

// ── PQ-Session-State (plain JSON, reist im rec-Spread der Session-Schicht) ──
/** Frischer PQ-State. `now` = ms-Timestamp (Session-Schicht: Date.now()). */
export function initPqState(now = 0) {
  return {
    count: 0,            // Nachrichten (send+recv) seit letzter Aktivierung
    lastAt: now,         // ms-Timestamp der letzten Aktivierung (bzw. Erstkontakt)
    pendingOut: null,    // Announcer: {tgt, ctB64, ssB64, fpB64, confB64?, peerKemEkB64, sends, phase:'announced'|'activated'}
    pendingIn: null,     // Empfänger: {tgt, ctB64} (geharvesteter CT, Decaps erst bei Aktivierung)
    confirmedEpoch: 0,   // höchste vom Peer bestätigte eigene Epoche
  };
}

// ── CT-Fingerprint (Header-Feld pqFp: bindet den CT via AAD+Sig) ───────────
export function pqFingerprintCt(ct) {
  return bytesToB64(sha256(ct).slice(0, 8));
}

// ── Key-Confirmation-Tag (Header-Feld pqConf auf Aktivierungs-Nachrichten) ─
// 8B-HMAC über den GEMISCHTEN Root (one-way, domain-separiert). Der Empfänger
// verifiziert VOR dem Commit des Mixes: rotierte/verlorene KEM-Identität
// (ML-KEM Implicit Rejection liefert sonst STILL ein falsches ss) wird so zum
// diagnostizierbaren `mix_mismatch`-locked statt zur stillen Root-Divergenz —
// und liefert das Dark-Launch-Gate (mismatch≈0, Muster P3.0).
const CONF_DOMAIN = new TextEncoder().encode('renex:pqratchet:conf:v1');
export function pqConfTag(rkMixed) {
  return bytesToB64(hmac(sha256, rkMixed, CONF_DOMAIN).slice(0, 8));
}

// ── Der CT-bindende Root-Mix (§6: Combiner, überall identisch) ─────────────
/**
 * rk' = deriveHybridWrapKey(ikm = rk ‖ ss_pq,
 *          info = domain ‖ algoVersion=4 ‖ 'renex:pqratchet:epoch:<N>' ‖
 *                 len‖kemCt ‖ len‖aktivierender-DH-Pub ‖ len‖Ziel-kemEk)
 * Bindet CT (IND-CCA-Erhalt), die Aktivierungs-POSITION (dhPub) und das
 * Directory-Encaps-Ziel (kemEk) — kein naives ss_ecdh‖ss_pq (§6).
 */
export function mixRoot(rk, ssPq, kemCt, dhPub, kemEk, epoch) {
  return deriveHybridWrapKey({
    ssEcdh: rk, ssPq, kemCt, pubA: dhPub, pubB: kemEk,
    algoVersion: 4, sid: `renex:pqratchet:epoch:${epoch}`,
  });
}

// ── Fälligkeit + Announce (nur Sender-Seite, nur Initiator-Rolle) ──────────
export function pqRekeyDue(pq, now = 0) {
  return pq.count >= PQRK.MSG_LIMIT || (now - pq.lastAt) >= PQRK.AGE_MS;
}

/**
 * Encapsuliert gegen das Peer-Device-kemEk und legt pendingOut an.
 * KEIN Root-Kontakt hier — der Mix passiert erst bei der Aktivierung.
 * @returns {boolean} true = announced
 */
export function pqAnnounce(pq, state, peerKemEk) {
  if (state.role !== 'initiator') return false;              // Responder announct NIE
  if (pq.pendingOut) return false;                           // max. 1 offene Epoche
  if (!(peerKemEk instanceof Uint8Array) || peerKemEk.length !== PQ.ML_KEM_EK) return false;
  const { ct, ss } = mlKemEncapsulate(peerKemEk);
  pq.pendingOut = {
    tgt: (state.kemEpoch || 0) + 1,
    ctB64: bytesToB64(ct),
    ssB64: bytesToB64(ss),                                   // gelöscht bei Aktivierung
    fpB64: pqFingerprintCt(ct),
    peerKemEkB64: bytesToB64(peerKemEk),                     // eingefroren gegen Cache-Rotation
    sends: 0,
    phase: 'announced',
  };
  return true;
}

/**
 * Wire-/Header-Felder für den nächsten Send (oder null): solange pendingOut
 * existiert und der Send-Cap nicht erreicht ist, reitet der CT mit.
 * Der Aufrufer merged pqTgt/pqFp (+pqConf nach Aktivierung) in den Header
 * (vor encodeRatchetHeader) und legt pqCtB64 als eigenes Wire-Feld
 * (pq_kem_ct) ab.
 * ⚠️ pqMarkCtSent() erst NACH erfolgreichem Transmit rufen (r.ok) — ein
 * fehlgeschlagener Send darf das CT-Budget nicht verbrennen, sonst kann ein
 * Netz-Ausfall alle MAX_CT_SENDS Träger kosten, ohne dass je ein CT den
 * Server (= die D1-History als Recovery-Pfad) erreicht hat.
 */
export function pqSendFields(pq) {
  const po = pq.pendingOut;
  if (!po) return null;
  const withinBudget = po.sends < PQRK.MAX_CT_SENDS;
  // Der CT (groß, 1088 B) reitet NUR im Budget mit. pqConf (winzig, ab
  // Aktivierung) MUSS dagegen bis zum Confirm IMMER mitreiten — auch nach
  // Budget-Erschöpfung. Sonst überspringt der Empfänger den mix_mismatch-Guard
  // (pqReceivePrep) und eine zwischen Harvest und Aktivierung rotierte
  // KEM-Identität diffundiert den Root STILL, statt diagnostizierbar zu locken
  // (Review-Finding: talk-heavy Burst ≥32 Sends vor der Peer-Antwort).
  if (!withinBudget && !po.confB64) return null;     // nichts mehr zu senden
  return {
    ...(withinBudget ? { pqTgt: po.tgt, pqFp: po.fpB64, pqCtB64: po.ctB64 } : {}),
    ...(po.confB64 ? { pqConf: po.confB64 } : {}),   // erst ab Aktivierung bekannt
  };
}
export function pqMarkCtSent(pq) {
  if (pq.pendingOut) pq.pendingOut.sends += 1;
}

// ── Nachrichten-Zähler (Session-Schicht ruft NUR für echte v4-DMs —
//    Pulse/Control erreichen diese Schicht strukturell nie) ────────────────
export function pqNoteSend(pq) { pq.count += 1; }
export function pqNoteRecv(pq) { pq.count += 1; }

// ── Empfangs-Vorbereitung: Harvest + Hooks + Confirm ───────────────────────
/**
 * VOR deriveReceiveKey aufrufen. Mutiert pq/state nur in-memory (der Aufrufer
 * persistiert ausschließlich im Erfolgspfad). Liefert die Hooks für
 * deriveReceiveKey (laufen nur, wenn tatsächlich ein DH-Step passiert).
 *
 * @param {object} pq      PQ-State (initPqState)
 * @param {object} state   Ratchet-State (ratchet.js; liest role/kemEpoch/dhr)
 * @param {object} header  decodierter Header (decodeRatchetHeader)
 * @param {{pqCtB64?:string|null, kemDk?:Uint8Array|null, ownKemEk?:Uint8Array|null, now?:number}} aids
 * @returns {{locked:boolean, reason?:string, hooks?:object, anomalies:string[]}}
 */
export function pqReceivePrep(pq, state, header, { pqCtB64 = null, kemDk = null, ownKemEk = null, now = 0 } = {}) {
  const anomalies = [];
  const cur = state.kemEpoch || 0;
  const hdrEpoch = header.kemEpoch || 0;

  // 0) Stale pendingIn räumen (Ziel-Epoche inzwischen aktiviert).
  if (pq.pendingIn && pq.pendingIn.tgt <= cur) pq.pendingIn = null;

  // 1) CT-Harvest (best-effort): Header verspricht via pqFp einen CT für die
  //    nächste Epoche → validieren + cachen. Authentizität kommt vom AAD-
  //    Erfolg des Aufrufers (bei Decrypt-Fehler wird der State verworfen).
  if (header.pqTgt === cur + 1) {
    if (pqCtB64) {
      let ct = null;
      try { ct = b64ToBytes(pqCtB64); } catch { /* malformt → anomaly unten */ }
      if (ct && ct.length === PQ.ML_KEM_CT && pqFingerprintCt(ct) === header.pqFp) {
        pq.pendingIn = { tgt: header.pqTgt, ctB64: pqCtB64 };
      } else {
        anomalies.push('fp_mismatch');                       // CT passt nicht zum signierten Header
      }
    } else if (!pq.pendingIn) {
      anomalies.push('ct_stripped');                         // Header verspricht CT, Wire hat keinen (alter Server?)
    }
  }

  const hooks = {};

  // 2) Eingehende Aktivierung: Header springt auf die nächste Epoche.
  if (hdrEpoch === cur + 1) {
    if (state.role !== 'responder') {
      return { locked: true, reason: 'unexpected_epoch', anomalies };   // nur der Initiator announct
    }
    const isNewDh = !state.dhr || bytesToB64(header.dh) !== bytesToB64(state.dhr);
    if (!isNewDh) {
      return { locked: true, reason: 'epoch_no_newdh', anomalies };     // Bump ohne neuen Pub = malformt
    }
    const pin = pq.pendingIn;
    if (!pin || pin.tgt !== hdrEpoch) {
      return { locked: true, reason: 'missing_ct', anomalies };         // CT noch nicht da → Retry/History
    }
    if (!kemDk || !ownKemEk) {
      return { locked: true, reason: 'no_kem_identity', anomalies };
    }
    const ct = b64ToBytes(pin.ctB64);
    const ss = mlKemDecapsulate(ct, kemDk);                  // Implicit Rejection: falsches dk/ct → stilles falsches ss …
    // … deshalb Key-Confirmation VOR dem Commit: state.rk ist zwischen hier
    // und dem preR1-Hook garantiert unverändert (dazwischen liegen nur
    // Skipped-Chain-Ops ohne Root-Kontakt), der Check ist also verbindlich.
    if (header.pqConf && pqConfTag(mixRoot(state.rk, ss, ct, header.dh, ownKemEk, hdrEpoch)) !== header.pqConf) {
      return { locked: true, reason: 'mix_mismatch', anomalies };       // KEM-Identität rotiert/CT fremd → diagnostizierbar locked
    }
    hooks.preR1 = (rk, dhrNew) => {
      const mixed = mixRoot(rk, ss, ct, dhrNew, ownKemEk, hdrEpoch);
      state.kemEpoch = hdrEpoch;
      pq.pendingIn = null;
      pq.count = 0;
      pq.lastAt = now;
      return mixed;
    };
  } else if (hdrEpoch > cur + 1) {
    return { locked: true, reason: 'epoch_gap', anomalies };            // >1 offen = unmöglich (Confirm-Gate)
  }

  // 3) Announcer: eigene Aktivierung am nächsten eigenen Pub (preR2 —
  //    feuert nur, wenn dieser Empfang tatsächlich einen DH-Step triggert).
  if (pq.pendingOut && pq.pendingOut.phase === 'announced') {
    const po = pq.pendingOut;
    hooks.preR2 = (rk, newOwnPub) => {
      const ct = b64ToBytes(po.ctB64);
      const ss = b64ToBytes(po.ssB64);
      const mixed = mixRoot(rk, ss, ct, newOwnPub, b64ToBytes(po.peerKemEkB64), po.tgt);
      state.kemEpoch = po.tgt;
      po.phase = 'activated';
      po.ssB64 = null;                                       // ss nicht länger als nötig at-rest
      po.confB64 = pqConfTag(mixed);                         // Key-Confirmation für die Aktivierungs-Header
      pq.count = 0;
      pq.lastAt = now;
      return mixed;
    };
  }

  // 4) Confirm (Announcer): Peer echot die aktivierte Epoche → CT-Attachen beenden.
  if (pq.pendingOut && pq.pendingOut.phase === 'activated' && hdrEpoch >= pq.pendingOut.tgt) {
    pq.confirmedEpoch = pq.pendingOut.tgt;
    pq.pendingOut = null;
  }

  return { locked: false, hooks, anomalies };
}
