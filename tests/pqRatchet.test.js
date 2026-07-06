// ======================================================
// Unit-Tests: pqRatchet.js — ML-KEM-Epoch-Rekey (P3.2-B, §4.4)
// ======================================================
// Kern-Garantien: (1) beide Seiten mischen ss_pq an derselben deterministischen
// Position (Announcer preR2 / Empfänger preR1 am selben Aktivierungs-Pub) →
// Roots bleiben identisch, auch bei kreuzenden/out-of-order Nachrichten;
// (2) Aktivierung ohne CT → locked, NIE steppen/raten; (3) Replay mischt nie
// doppelt; (4) CT ist fingerprint-gebunden (pqFp im AAD-gedeckten Header);
// (5) ohne Announce verhält sich alles exakt wie der klassische Ratchet.
// ======================================================
import { describe, it, expect } from 'vitest';
import { mlKemKeygen, x25519Keygen, PQ } from '../frontend/src/lib/pqCrypto.js';
import {
  initInitiator, initResponder, nextSendKey, deriveReceiveKey,
  encodeRatchetHeader, decodeRatchetHeader,
  serializeRatchetState, deserializeRatchetState,
} from '../frontend/src/lib/ratchet.js';
import {
  PQRK, initPqState, pqFingerprintCt, pqConfTag, mixRoot,
  pqRekeyDue, pqAnnounce, pqSendFields, pqMarkCtSent,
  pqNoteSend, pqNoteRecv, pqReceivePrep,
} from '../frontend/src/lib/pqRatchet.js';
import { bytesToB64, b64ToBytes } from '../frontend/src/lib/bytes.js';

const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const T0 = 1_800_000_000_000;   // fester Basis-Timestamp (Determinismus)

// ── Mini-Session-Schicht (wie ratchetSession sie in P3.2-B verkabelt) ──────
function makePair() {
  const rk = crypto.getRandomValues(new Uint8Array(32));
  const spk = x25519Keygen();
  return {
    alice: { state: initInitiator(rk, spk.pub), pq: initPqState(T0), kem: mlKemKeygen() },
    bob: { state: initResponder(new Uint8Array(rk), spk), pq: initPqState(T0), kem: mlKemKeygen() },
  };
}

/** Send: Announce-bei-Fälligkeit (nur Initiator) + CT-Attach + Zähler. */
function send(side, peer, now = T0) {
  if (pqRekeyDue(side.pq, now)) pqAnnounce(side.pq, side.state, peer.kem.ek);
  const fields = pqSendFields(side.pq);
  const { mk, header } = nextSendKey(side.state);
  const headerB64 = encodeRatchetHeader({
    ...header,
    ...(fields ? { pqTgt: fields.pqTgt, pqFp: fields.pqFp, pqConf: fields.pqConf || null } : {}),
  });
  if (fields) pqMarkCtSent(side.pq);
  pqNoteSend(side.pq);
  return { mk, headerB64, pqCtB64: fields ? fields.pqCtB64 : null };
}

/** Empfang: prep (Harvest/Hooks/Confirm) → deriveReceiveKey. */
function recv(side, wire, now = T0) {
  const header = decodeRatchetHeader(wire.headerB64);
  const prep = pqReceivePrep(side.pq, side.state, header, {
    pqCtB64: wire.pqCtB64, kemDk: side.kem.dk, ownKemEk: side.kem.ek, now,
  });
  if (prep.locked) return { locked: prep.reason, anomalies: prep.anomalies };
  const mk = deriveReceiveKey(side.state, header, prep.hooks);
  pqNoteRecv(side.pq);
  return { mk, anomalies: prep.anomalies };
}

/** Zustellung mit MK-Gleichheits-Assertion (der Kern-Beweis). */
function deliver(from, to, wire, now = T0) {
  const r = recv(to, wire, now);
  expect(r.locked).toBeUndefined();
  expect(eq(r.mk, wire.mk)).toBe(true);
  return r;
}

/** Etabliert die Ping-Pong-Basis: A→B, B→A (beide Ketten + Pubs live). */
function establish(p) {
  deliver(p.alice, p.bob, send(p.alice, p.bob));
  deliver(p.bob, p.alice, send(p.bob, p.alice));
}

describe('mixRoot (CT-bindender Combiner, §6)', () => {
  const rk = new Uint8Array(32).fill(3);
  const ss = new Uint8Array(32).fill(5);
  const kem = mlKemKeygen();
  const ct = new Uint8Array(PQ.ML_KEM_CT).fill(9);
  const pub = x25519Keygen().pub;

  it('deterministisch, 32B, ≠ rk', () => {
    const a = mixRoot(rk, ss, ct, pub, kem.ek, 1);
    const b = mixRoot(rk, ss, ct, pub, kem.ek, 1);
    expect(eq(a, b)).toBe(true);
    expect(a.length).toBe(32);
    expect(eq(a, rk)).toBe(false);
  });
  it('bindet JEDEN Parameter (ct, dhPub, kemEk, epoch, ss, rk)', () => {
    const base = mixRoot(rk, ss, ct, pub, kem.ek, 1);
    const ct2 = new Uint8Array(ct); ct2[0] ^= 1;
    const ek2 = mlKemKeygen().ek;
    expect(eq(base, mixRoot(rk, ss, ct2, pub, kem.ek, 1))).toBe(false);
    expect(eq(base, mixRoot(rk, ss, ct, x25519Keygen().pub, kem.ek, 1))).toBe(false);
    expect(eq(base, mixRoot(rk, ss, ct, pub, ek2, 1))).toBe(false);
    expect(eq(base, mixRoot(rk, ss, ct, pub, kem.ek, 2))).toBe(false);
    expect(eq(base, mixRoot(rk, new Uint8Array(32).fill(6), ct, pub, kem.ek, 1))).toBe(false);
    expect(eq(base, mixRoot(new Uint8Array(32).fill(4), ss, ct, pub, kem.ek, 1))).toBe(false);
  });
});

describe('Header-Codec: pqTgt/pqFp (additiv, AAD-gedeckt)', () => {
  const dh = x25519Keygen().pub;
  it('Round-Trip mit und ohne pq-Felder; Größe unter Server-Cap 512', () => {
    const plain = decodeRatchetHeader(encodeRatchetHeader({ dh, pn: 1, n: 2, kemEpoch: 3 }));
    expect(plain.kemEpoch).toBe(3);
    expect(plain.pqTgt).toBeUndefined();
    const b64 = encodeRatchetHeader({ dh, pn: 1, n: 2, kemEpoch: 3, pqTgt: 4, pqFp: 'AAAAAAAAAAA=' });
    expect(b64.length).toBeLessThan(512);
    const h = decodeRatchetHeader(b64);
    expect(h.pqTgt).toBe(4);
    expect(h.pqFp).toBe('AAAAAAAAAAA=');
  });
  it('malformte pq-Felder / kemEpoch werfen', () => {
    const mk = (o) => bytesToB64(new TextEncoder().encode(JSON.stringify(o)));
    const base = { v: 4, dh: bytesToB64(dh), pn: 0, n: 0, kemEpoch: 0 };
    expect(() => decodeRatchetHeader(mk({ ...base, kemEpoch: -1 }))).toThrow();
    expect(() => decodeRatchetHeader(mk({ ...base, kemEpoch: 'x' }))).toThrow();
    expect(() => decodeRatchetHeader(mk({ ...base, pqTgt: 0, pqFp: 'a' }))).toThrow();
    expect(() => decodeRatchetHeader(mk({ ...base, pqTgt: 1 }))).toThrow();               // pqFp fehlt
    expect(() => decodeRatchetHeader(mk({ ...base, pqTgt: 1, pqFp: 'x'.repeat(25) }))).toThrow();
  });
});

describe('Announce-Disziplin', () => {
  it('nur Initiator; kein Doppel-Announce; ek-Größe validiert', () => {
    const p = makePair();
    establish(p);
    expect(pqAnnounce(p.bob.pq, p.bob.state, p.alice.kem.ek)).toBe(false);       // Responder nie
    expect(pqAnnounce(p.alice.pq, p.alice.state, new Uint8Array(10))).toBe(false);
    expect(pqAnnounce(p.alice.pq, p.alice.state, p.bob.kem.ek)).toBe(true);
    expect(pqAnnounce(p.alice.pq, p.alice.state, p.bob.kem.ek)).toBe(false);     // pendingOut offen
    expect(p.alice.pq.pendingOut.tgt).toBe(1);
    expect(p.alice.pq.pendingOut.phase).toBe('announced');
  });
  it('Fälligkeit: 50 Nachrichten ODER 7 Tage', () => {
    const pq = initPqState(T0);
    expect(pqRekeyDue(pq, T0 + 1000)).toBe(false);
    pq.count = PQRK.MSG_LIMIT;
    expect(pqRekeyDue(pq, T0 + 1000)).toBe(true);
    const pq2 = initPqState(T0);
    expect(pqRekeyDue(pq2, T0 + PQRK.AGE_MS)).toBe(true);
  });
  it('CT-Attach-Cap: nach MAX_CT_SENDS keine Felder mehr', () => {
    const p = makePair();
    establish(p);
    pqAnnounce(p.alice.pq, p.alice.state, p.bob.kem.ek);
    for (let i = 0; i < PQRK.MAX_CT_SENDS; i++) {
      expect(pqSendFields(p.alice.pq)).not.toBeNull();
      pqMarkCtSent(p.alice.pq);
    }
    expect(pqSendFields(p.alice.pq)).toBeNull();
  });
});

describe('Voller Epoch-Rekey (Happy Path)', () => {
  it('Announce → beidseitige Aktivierung → Confirm; Roots identisch', () => {
    const p = makePair();
    establish(p);

    // Fällig machen → Announce reitet auf dem nächsten Send (alte Kette).
    p.alice.pq.count = PQRK.MSG_LIMIT;
    const m1 = send(p.alice, p.bob);
    expect(m1.pqCtB64).not.toBeNull();
    expect(decodeRatchetHeader(m1.headerB64).kemEpoch).toBe(0);   // noch NICHT aktiviert
    deliver(p.alice, p.bob, m1);
    expect(p.bob.pq.pendingIn?.tgt).toBe(1);                       // Harvest

    // Bobs Antwort (neuer Bob-Pub) triggert Alices DH-Step → preR2 aktiviert.
    deliver(p.bob, p.alice, send(p.bob, p.alice));
    expect(p.alice.state.kemEpoch).toBe(1);
    expect(p.alice.pq.pendingOut.phase).toBe('activated');
    expect(p.alice.pq.pendingOut.ssB64).toBeNull();                // ss gelöscht
    expect(p.alice.pq.count).toBe(1);                              // Reset + die Aktivierungs-Nachricht selbst

    // Alices erste Nachricht der neuen Kette aktiviert Bob (preR1).
    const m2 = send(p.alice, p.bob);
    expect(decodeRatchetHeader(m2.headerB64).kemEpoch).toBe(1);
    expect(decodeRatchetHeader(m2.headerB64).pqConf).toBe(p.alice.pq.pendingOut.confB64);  // Key-Confirmation reist mit
    expect(m2.pqCtB64).not.toBeNull();                             // CT bis Confirm
    deliver(p.alice, p.bob, m2);
    expect(p.bob.state.kemEpoch).toBe(1);
    expect(p.bob.pq.pendingIn).toBeNull();
    expect(eq(p.alice.state.rk, p.bob.state.rk)).toBe(false);      // rk läuft nach r2 weiter …

    // Bobs Echo (kemEpoch=1) → Confirm bei Alice, CT-Attachen endet.
    deliver(p.bob, p.alice, send(p.bob, p.alice));
    expect(p.alice.pq.pendingOut).toBeNull();
    expect(p.alice.pq.confirmedEpoch).toBe(1);
    const m3 = send(p.alice, p.bob);
    expect(m3.pqCtB64).toBeNull();

    // Session bleibt beidseitig gesund.
    deliver(p.alice, p.bob, m3);
    deliver(p.bob, p.alice, send(p.bob, p.alice));
  });

  it('zweiter Rekey (Epoche 2) nach Confirm funktioniert identisch', () => {
    const p = makePair();
    establish(p);
    for (let e = 1; e <= 2; e++) {
      p.alice.pq.count = PQRK.MSG_LIMIT;
      deliver(p.alice, p.bob, send(p.alice, p.bob));               // Announce+CT
      deliver(p.bob, p.alice, send(p.bob, p.alice));               // Alice aktiviert
      deliver(p.alice, p.bob, send(p.alice, p.bob));               // Bob aktiviert
      deliver(p.bob, p.alice, send(p.bob, p.alice));               // Confirm
      expect(p.alice.state.kemEpoch).toBe(e);
      expect(p.bob.state.kemEpoch).toBe(e);
      expect(p.alice.pq.confirmedEpoch).toBe(e);
    }
  });
});

describe('Kreuzverkehr (die rk-Divergenz-Falle)', () => {
  it('Bob ratcht BEVOR er vom Announce weiß → keine Divergenz', () => {
    const p = makePair();
    establish(p);
    // Bob muss Alices aktuelle Kette gesehen haben, damit sein nächster Send
    // einen FRISCHEN Pub trägt (Pub-Generierung ist empfangsgetriggert).
    deliver(p.alice, p.bob, send(p.alice, p.bob));

    // Bobs Send (frischer Pub b2) kreuzt Alices Announce-Nachricht.
    const mBob = send(p.bob, p.alice);
    p.alice.pq.count = PQRK.MSG_LIMIT;
    const mAnnounce = send(p.alice, p.bob);                        // noch alte Kette + CT

    // Alice empfängt Bobs Kreuzer → DH-Step → Aktivierung am NEUEN Alice-Pub;
    // Bob hat zu diesem Zeitpunkt vom Rekey noch NICHTS gesehen.
    deliver(p.bob, p.alice, mBob);
    expect(p.alice.state.kemEpoch).toBe(1);
    // Bob bekommt den Announce erst DANACH (alte Kette, normal lesbar).
    deliver(p.alice, p.bob, mAnnounce);
    expect(p.bob.pq.pendingIn?.tgt).toBe(1);
    expect(p.bob.state.kemEpoch).toBe(0);

    // Erste Nachricht der neuen Alice-Kette aktiviert Bob → synchron.
    deliver(p.alice, p.bob, send(p.alice, p.bob));
    expect(p.bob.state.kemEpoch).toBe(1);
    deliver(p.bob, p.alice, send(p.bob, p.alice));
    deliver(p.alice, p.bob, send(p.alice, p.bob));
  });
});

describe('Out-of-Order über die Epoch-Grenze', () => {
  it('spätere Nachricht der neuen Kette zuerst; alte + n=0 kommen nach', () => {
    const p = makePair();
    establish(p);
    p.alice.pq.count = PQRK.MSG_LIMIT;
    const mCt = send(p.alice, p.bob);                              // alte Kette, CT
    const mOldLate = send(p.alice, p.bob);                         // alte Kette, n+1 — kommt SPÄT
    deliver(p.alice, p.bob, mCt);
    deliver(p.bob, p.alice, send(p.bob, p.alice));                 // Alice aktiviert
    const mNew0 = send(p.alice, p.bob);                            // neue Kette n=0 — kommt SPÄT
    const mNew1 = send(p.alice, p.bob);                            // neue Kette n=1 — kommt ZUERST

    deliver(p.alice, p.bob, mNew1);                                // aktiviert Bob + skippt n=0
    expect(p.bob.state.kemEpoch).toBe(1);
    const rkAfter = new Uint8Array(p.bob.state.rk);
    deliver(p.alice, p.bob, mNew0);                                // Skipped-Key, kein Root-Kontakt
    deliver(p.alice, p.bob, mOldLate);                             // alte Kette via Skipped-Key
    expect(eq(p.bob.state.rk, rkAfter)).toBe(true);                // Root unberührt
    expect(p.bob.state.kemEpoch).toBe(1);                          // nie doppelt gemischt
  });
});

describe('CT-Verlust/-Strip: locked statt Desync, Recovery via Redelivery', () => {
  it('gestrippter CT → Anomalie; Aktivierung ohne CT → locked; späte Zustellung heilt', () => {
    const p = makePair();
    establish(p);
    p.alice.pq.count = PQRK.MSG_LIMIT;
    const mCt1 = send(p.alice, p.bob);
    const mCt2 = send(p.alice, p.bob);

    // Alter Server strippt das Wire-Feld: Header verspricht CT (pqFp), Wire leer.
    const r1 = recv(p.bob, { ...mCt1, pqCtB64: null });
    expect(r1.locked).toBeUndefined();                             // alte Kette bleibt lesbar
    expect(eq(r1.mk, mCt1.mk)).toBe(true);
    expect(r1.anomalies).toContain('ct_stripped');
    expect(p.bob.pq.pendingIn).toBeNull();

    // Alice aktiviert; Bob bekommt die Aktivierung OHNE je einen CT gesehen zu haben.
    deliver(p.bob, p.alice, send(p.bob, p.alice));
    const mAct = send(p.alice, p.bob);
    const rkBefore = new Uint8Array(p.bob.state.rk);
    const rLocked = recv(p.bob, { ...mAct, pqCtB64: null });
    expect(rLocked.locked).toBe('missing_ct');
    expect(eq(p.bob.state.rk, rkBefore)).toBe(true);               // State unangetastet
    expect(p.bob.state.kemEpoch).toBe(0);

    // Redelivery/History liefert mCt2 MIT CT → Harvest → Retry der Aktivierung klappt.
    deliver(p.alice, p.bob, mCt2);
    expect(p.bob.pq.pendingIn?.tgt).toBe(1);
    deliver(p.alice, p.bob, mAct);
    expect(p.bob.state.kemEpoch).toBe(1);
  });

  it('manipulierter CT (Fingerprint-Mismatch) wird nie geharvestet', () => {
    const p = makePair();
    establish(p);
    p.alice.pq.count = PQRK.MSG_LIMIT;
    const m = send(p.alice, p.bob);
    const bad = new Uint8Array(b64ToBytes(m.pqCtB64)); bad[0] ^= 1;
    const r = recv(p.bob, { ...m, pqCtB64: bytesToB64(bad) });
    expect(r.locked).toBeUndefined();
    expect(r.anomalies).toContain('fp_mismatch');
    expect(p.bob.pq.pendingIn).toBeNull();
  });

  it('rotierte KEM-Identität während offener Epoche → mix_mismatch (diagnostizierbar), State unangetastet', () => {
    const p = makePair();
    establish(p);
    p.alice.pq.count = PQRK.MSG_LIMIT;
    deliver(p.alice, p.bob, send(p.alice, p.bob));                 // Announce+CT (gegen Bobs ALTES ek)
    deliver(p.bob, p.alice, send(p.bob, p.alice));                 // Alice aktiviert (pqConf entsteht)

    // Bob verliert/regeneriert seine KEM-Identität (kemIdentity „korrupt → neu").
    p.bob.kem = mlKemKeygen();

    const mAct = send(p.alice, p.bob);
    const rkBefore = new Uint8Array(p.bob.state.rk);
    const r = recv(p.bob, mAct);
    expect(r.locked).toBe('mix_mismatch');                         // statt stiller Root-Divergenz
    expect(eq(p.bob.state.rk, rkBefore)).toBe(true);
    expect(p.bob.state.kemEpoch).toBe(0);
  });
});

describe('pqConfTag (Key-Confirmation)', () => {
  it('deterministisch, 12 Zeichen b64 (8B), key-abhängig', () => {
    const rk = new Uint8Array(32).fill(1);
    expect(pqConfTag(rk)).toBe(pqConfTag(new Uint8Array(32).fill(1)));
    expect(pqConfTag(rk).length).toBe(12);
    expect(pqConfTag(rk)).not.toBe(pqConfTag(new Uint8Array(32).fill(2)));
  });
  it('Header-Codec: pqConf round-trippt; malformt wirft', () => {
    const dh = x25519Keygen().pub;
    const h = decodeRatchetHeader(encodeRatchetHeader({ dh, pn: 0, n: 0, kemEpoch: 1, pqConf: 'AAAAAAAAAAA=' }));
    expect(h.pqConf).toBe('AAAAAAAAAAA=');
    const mk = (o) => bytesToB64(new TextEncoder().encode(JSON.stringify(o)));
    const base = { v: 4, dh: bytesToB64(dh), pn: 0, n: 0, kemEpoch: 0 };
    expect(() => decodeRatchetHeader(mk({ ...base, pqConf: 42 }))).toThrow();
    expect(() => decodeRatchetHeader(mk({ ...base, pqConf: 'x'.repeat(25) }))).toThrow();
  });
});

describe('Epoch-Validierung am Empfänger', () => {
  it('Sprung >1 → epoch_gap; Bump ohne neuen DH-Pub → epoch_no_newdh; Initiator-Seite → unexpected_epoch', () => {
    const p = makePair();
    establish(p);
    const gap = encodeRatchetHeader({ dh: x25519Keygen().pub, pn: 0, n: 0, kemEpoch: 2 });
    expect(recv(p.bob, { headerB64: gap, pqCtB64: null }).locked).toBe('epoch_gap');

    const sameDh = encodeRatchetHeader({ dh: p.bob.state.dhr, pn: 0, n: 5, kemEpoch: 1 });
    expect(recv(p.bob, { headerB64: sameDh, pqCtB64: null }).locked).toBe('epoch_no_newdh');

    const toInitiator = encodeRatchetHeader({ dh: x25519Keygen().pub, pn: 0, n: 0, kemEpoch: 1 });
    expect(recv(p.alice, { headerB64: toInitiator, pqCtB64: null }).locked).toBe('unexpected_epoch');
  });
});

describe('Serialisierung / Alt-Records', () => {
  it('kemEpoch überlebt den State-Round-Trip; Alt-Records defaulten auf 0', () => {
    const p = makePair();
    establish(p);
    p.alice.pq.count = PQRK.MSG_LIMIT;
    deliver(p.alice, p.bob, send(p.alice, p.bob));
    deliver(p.bob, p.alice, send(p.bob, p.alice));                 // Alice aktiviert (kemEpoch=1)

    const roundtrip = deserializeRatchetState(JSON.parse(JSON.stringify(serializeRatchetState(p.alice.state))));
    expect(roundtrip.kemEpoch).toBe(1);

    const legacy = serializeRatchetState(p.bob.state);
    delete legacy.kemEpoch;                                        // P3.1/P3.2-A-Altbestand
    expect(deserializeRatchetState(legacy).kemEpoch).toBe(0);
  });
  it('pq-State (inkl. pendingOut) ist JSON-round-trip-fähig (rec-Spread-Muster)', () => {
    const p = makePair();
    establish(p);
    pqAnnounce(p.alice.pq, p.alice.state, p.bob.kem.ek);
    const rt = JSON.parse(JSON.stringify(p.alice.pq));
    expect(rt.pendingOut.tgt).toBe(1);
    expect(rt.pendingOut.ctB64).toBe(p.alice.pq.pendingOut.ctB64);
    expect(rt.pendingOut.peerKemEkB64).toBe(bytesToB64(p.bob.kem.ek));
  });
});

describe('Marathon: 200 Nachrichten Ping-Pong mit natürlichen Rekeys', () => {
  it('alle MKs matchen, Epochen schreiten voran, kein Desync', () => {
    const p = makePair();
    establish(p);
    let now = T0;
    for (let i = 0; i < 100; i++) {
      now += 60_000;
      deliver(p.alice, p.bob, send(p.alice, p.bob, now), now);
      deliver(p.bob, p.alice, send(p.bob, p.alice, now), now);
    }
    expect(p.alice.state.kemEpoch).toBeGreaterThanOrEqual(2);      // 50er-Trigger griff mehrfach
    expect(p.bob.state.kemEpoch).toBe(p.alice.state.kemEpoch);
    // Ohne offene Ankündigung sind beide Roots am selben Stand angekommen —
    // Beweis über weiteres fehlerfreies Ping-Pong (deliver asserted MK-Match).
    deliver(p.alice, p.bob, send(p.alice, p.bob, now), now);
    deliver(p.bob, p.alice, send(p.bob, p.alice, now), now);
  });
});
