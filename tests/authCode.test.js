// ======================================================
// Aktivierungscode-Krypto (eGov 1.3) — beide Lib-Kopien
//
// KRITISCH: frontend/src/lib/authCode.js (Org-Seite) und
// frontend/public/join/lib/authCode.js (Bürger-Seite) MÜSSEN identisch
// hashen — sonst schlägt der Server-Vergleich fehl und niemand kommt rein.
// Dieser Test ist die Klammer zwischen den zwei Kopien.
// ======================================================
import { describe, it, expect } from 'vitest';
import * as org from '../frontend/src/lib/authCode.js';
import * as guest from '../frontend/public/join/lib/authCode.js';

const SALT = 'c2FsdHNhbHRzYWx0c2FsdA==';

describe('hashAuthCode — Org- und Bürger-Kopie stimmen überein', () => {
  it('gleiche Eingabe → gleicher Hash in beiden Kopien', async () => {
    for (const code of ['ABCD-EFGH', '2345-6789', 'ZZZZ-ZZZZ']) {
      const a = await org.hashAuthCode(SALT, code);
      const b = await guest.hashAuthCode(SALT, code);
      expect(a).toBe(b);
      expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);       // base64
    }
  });

  it('Normalisierung identisch: Kleinschreibung/Leerzeichen/Bindestrich egal', async () => {
    const canonical = await org.hashAuthCode(SALT, 'ABCD-EFGH');
    for (const variant of ['abcd-efgh', 'ABCDEFGH', ' abcd efgh ', 'AbCd-EfGh']) {
      expect(await org.hashAuthCode(SALT, variant)).toBe(canonical);
      expect(await guest.hashAuthCode(SALT, variant)).toBe(canonical);
    }
  });

  it('Crockford-Regel U→V in beiden Kopien', async () => {
    expect(org.normalizeAuthCode('ABUD')).toBe('ABVD');
    expect(guest.normalizeAuthCode('ABUD')).toBe('ABVD');
    expect(await org.hashAuthCode(SALT, 'ABUD')).toBe(await guest.hashAuthCode(SALT, 'ABVD'));
  });

  it('anderes Salt oder anderer Code → anderer Hash', async () => {
    const base = await org.hashAuthCode(SALT, 'ABCD-EFGH');
    expect(await org.hashAuthCode(SALT, 'ABCD-EFGJ')).not.toBe(base);
    expect(await org.hashAuthCode('b3RoZXJzYWx0b3RoZXJz', 'ABCD-EFGH')).not.toBe(base);
  });
});

describe('generateAuthCode', () => {
  it('Format ABCD-EFGH, nur verwechslungsarme Zeichen', async () => {
    for (let i = 0; i < 50; i++) {
      const c = org.generateAuthCode();
      expect(c).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
      expect(c).not.toMatch(/[01OILU]/);            // Papier-Verwechslungskandidaten
    }
  });

  it('zufällig (50 Codes → keine Dublette)', () => {
    const set = new Set();
    for (let i = 0; i < 50; i++) set.add(org.generateAuthCode());
    expect(set.size).toBe(50);
  });
});

describe('createAuthCode (Org-Paket)', () => {
  it('liefert Klartext + salt + passenden hash', async () => {
    const { code, salt, hash } = await org.createAuthCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(salt).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // Der Hash muss exakt der sein, den der Bürger-Browser rechnen wird
    expect(await guest.hashAuthCode(salt, code)).toBe(hash);
  });

  it('jedes Paket hat eigenes Salt (kein Rainbow-Table über Invites)', async () => {
    const a = await org.createAuthCode();
    const b = await org.createAuthCode();
    expect(a.salt).not.toBe(b.salt);
  });
});
