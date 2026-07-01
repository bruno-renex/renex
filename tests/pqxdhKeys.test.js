// ======================================================
// Unit-Tests: PQXDH Prekey-Management (Client) — M2
// ======================================================
// Kern: der VOLLE Handshake end-to-end über pqxdhKeys (Bob) + pqxdh (Krypto):
// Bob publiziert Bundle → „Server" gibt EINEN OPK aus → Alice + Bob leiten
// dasselbe RK0 ab → OPK ist danach verbraucht (one-time).
// ======================================================
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { x25519Keygen, PQ } from '../frontend/src/lib/pqCrypto.js';
import { initiatorRoot, responderRoot } from '../frontend/src/lib/pqxdh.js';
import {
  getOrCreateIdentity, getOrCreateSignedPrekey, getOrCreatePqSignedPrekey,
  ensureOpkPool, buildPublishBundle, decodeInitiatorBundle, consumeForResponder,
} from '../frontend/src/lib/pqxdhKeys.js';

const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const b64len = (s) => Buffer.from(s, 'base64').length;

describe('pqxdhKeys: Persistenz', () => {
  it('getOrCreateIdentity idempotent (X25519 + Ed25519, 32B)', async () => {
    const a = await getOrCreateIdentity();
    const b = await getOrCreateIdentity();
    expect(a.ikX.pub.length).toBe(32);
    expect(a.ikEd.pub.length).toBe(32);
    expect(eq(a.ikX.priv, b.ikX.priv)).toBe(true);
    expect(eq(a.ikEd.priv, b.ikEd.priv)).toBe(true);
  });

  it('SPK + PQSPK sind persistent + signiert', async () => {
    const spk = await getOrCreateSignedPrekey();
    expect(spk.spkId).toBeTruthy();
    expect(spk.sig.length).toBe(64);            // Ed25519-Sig
    expect((await getOrCreateSignedPrekey()).spkId).toBe(spk.spkId);
    const pq = await getOrCreatePqSignedPrekey();
    expect(pq.ek.length).toBe(PQ.ML_KEM_EK);
    expect(pq.dk.length).toBe(PQ.ML_KEM_DK);
  });

  it('OPK-Pool füllt bis target', async () => {
    const r = await ensureOpkPool(5);
    expect(r.count).toBeGreaterThanOrEqual(5);
  });
});

describe('pqxdhKeys: publizierbares Bundle', () => {
  it('buildPublishBundle hat die richtige Form + Größen', async () => {
    const p = await buildPublishBundle({ opkCount: 5 });
    expect(b64len(p.ik.ikX)).toBe(32);
    expect(b64len(p.ik.ikEd)).toBe(32);
    expect(b64len(p.spk.spk)).toBe(32);
    expect(b64len(p.spk.sig)).toBe(64);
    expect(b64len(p.pqspk.ek)).toBe(PQ.ML_KEM_EK);
    expect(b64len(p.pqspk.sig)).toBe(64);
    expect(p.opks.length).toBeGreaterThanOrEqual(5);
    expect(b64len(p.opks[0].opk)).toBe(32);
  });
});

describe('pqxdhKeys × pqxdh: VOLLER Handshake end-to-end', () => {
  it('Bob-Bundle → Alice initiatorRoot ↔ Bob responderRoot → gleiches RK0; OPK one-time', async () => {
    // Bob publiziert (pqxdhKeys, IDB-backed)
    const pub = await buildPublishBundle({ opkCount: 5 });
    // „Server" gibt EINEN OPK aus (atomarer Consume simuliert)
    const handed = pub.opks[0];
    const singleWire = { ik: pub.ik, spk: pub.spk, pqspk: pub.pqspk, opk: handed };

    // Alice (Initiator): eigenes IK + frisches Ephemeral
    const ikA = x25519Keygen(), ekA = x25519Keygen();
    const a = initiatorRoot({ ikAPriv: ikA.priv, ekAPriv: ekA.priv, bundle: decodeInitiatorBundle(singleWire) });
    expect(a.rk0.length).toBe(32);
    expect(a.usedOpk).toBe(true);

    // Bob (Responder): Privs für die referenzierten IDs holen (KONSUMIERT OPK)
    const privs = await consumeForResponder({ spkId: pub.spk.spkId, opkId: handed.opkId, pqspkId: pub.pqspk.pqspkId });
    const b = responderRoot({ ...privs, ikAX: ikA.pub, ekAX: ekA.pub, kemCt: a.kemCt, usedOpk: a.usedOpk });

    expect(eq(a.rk0, b)).toBe(true);   // ✅ beide Seiten dasselbe RK0

    // OPK ist verbraucht → zweiter Consume desselben opkId wirft
    await expect(consumeForResponder({ spkId: pub.spk.spkId, opkId: handed.opkId, pqspkId: pub.pqspk.pqspkId }))
      .rejects.toThrow('opk_consumed_or_unknown');
  });

  it('unbekannte spkId → wirft', async () => {
    const pub = await buildPublishBundle({ opkCount: 2 });
    await expect(consumeForResponder({ spkId: 'nope', opkId: pub.opks[0].opkId, pqspkId: pub.pqspk.pqspkId }))
      .rejects.toThrow('spk_unknown');
  });
});
