// ======================================================
// Unit-Tests: /chat/send Message-Type-Allowlist (M0.5)
// ======================================================
import { describe, it, expect } from 'vitest';
import { isKnownMessageType, CONTROL_TYPES, RESERVED_TYPES } from '../src/messageTypes.js';

describe('isKnownMessageType', () => {
  it('reguläre Nachricht (kein type) → known', () => {
    expect(isKnownMessageType(undefined)).toBe(true);
    expect(isKnownMessageType(null)).toBe(true);
    expect(isKnownMessageType('')).toBe(true);
  });

  it('alle heutigen Control-Types → known', () => {
    for (const t of ['pulse', 'cmk', 'cmk_req', 'cmk_unavailable', 'cmk_rotate',
      'cmk_reset', 'epoch_rotate', 'auto_delete_set', 'gsk', 'request_gsk']) {
      expect(isKnownMessageType(t)).toBe(true);
    }
  });

  it('reservierte Migrations-Types (P3/P4) → known', () => {
    for (const t of ['pq_rekey', 'pq_kem_ct', 'skdm', 'skdm_request']) {
      expect(isKnownMessageType(t)).toBe(true);
    }
  });

  it('unbekannter Type → NICHT known', () => {
    expect(isKnownMessageType('random_unknown')).toBe(false);
    expect(isKnownMessageType('inject')).toBe(false);
    expect(isKnownMessageType('CMK')).toBe(false); // case-sensitive
  });

  it('Nicht-String (defensiv) → NICHT known', () => {
    expect(isKnownMessageType(42)).toBe(false);
    expect(isKnownMessageType({})).toBe(false);
    expect(isKnownMessageType(true)).toBe(false);
  });

  it('Sets sind disjunkt (kein Reserved-Type doppelt in Control)', () => {
    for (const t of RESERVED_TYPES) expect(CONTROL_TYPES.has(t)).toBe(false);
  });
});
