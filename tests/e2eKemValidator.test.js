// ======================================================
// Unit-Tests: M1 ML-KEM-ek-Validator (Server, e2eRoutes)
// ======================================================
// Der Import validiert zugleich, dass e2eRoutes.js parst (Backend wird von
// `npm run build` — reines Frontend/Vite — NICHT geprüft).
// ======================================================
import { describe, it, expect } from 'vitest';
import { isValidKemEkB64 } from '../src/routes/e2eRoutes.js';

const validEk = Buffer.alloc(1184, 7).toString('base64'); // 1184 Bytes → 1580 b64-Zeichen

describe('isValidKemEkB64 (M1)', () => {
  it('gültiger 1184-Byte-ek (base64) → true', () => {
    expect(validEk.length).toBeGreaterThanOrEqual(1560);
    expect(isValidKemEkB64(validEk)).toBe(true);
  });
  it('falsche Länge → false', () => {
    expect(isValidKemEkB64(Buffer.alloc(1183).toString('base64'))).toBe(false); // 1 Byte zu kurz
    expect(isValidKemEkB64(Buffer.alloc(1185).toString('base64'))).toBe(false); // 1 Byte zu lang
    expect(isValidKemEkB64(Buffer.alloc(32).toString('base64'))).toBe(false);
  });
  it('Nicht-String / leer / kein base64 → false', () => {
    expect(isValidKemEkB64(undefined)).toBe(false);
    expect(isValidKemEkB64(null)).toBe(false);
    expect(isValidKemEkB64('')).toBe(false);
    expect(isValidKemEkB64(1234)).toBe(false);
    expect(isValidKemEkB64('!'.repeat(1580))).toBe(false); // richtige Länge, kein base64
  });
});
