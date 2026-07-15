// ======================================================
// GuestBanner-Zeitlogik (eGov 1.2, Häppchen 3b) — pure Functions
// ======================================================
import { describe, it, expect } from 'vitest';
import { formatGuestRemaining, guestWarnLevel } from '../frontend/src/lib/guestTime.js';

const H = 3600_000;
const DAY = 24 * H;

describe('formatGuestRemaining', () => {
  it('ab 48h: Tages-Format via Template (statt "2160h 0min")', () => {
    expect(formatGuestRemaining(90 * DAY)).toBe('90 Tage');
    expect(formatGuestRemaining(48 * H)).toBe('2 Tage');
    expect(formatGuestRemaining(89 * DAY + 12 * H)).toBe('89 Tage'); // floor
    expect(formatGuestRemaining(30 * DAY, '{n} days')).toBe('30 days');
  });

  it('unter 48h: bestehendes h/min/s-Format unverändert', () => {
    expect(formatGuestRemaining(47 * H + 59 * 60_000)).toBe('47h 59min');
    expect(formatGuestRemaining(1 * H + 23 * 60_000)).toBe('1h 23min');
    expect(formatGuestRemaining(45 * 60_000)).toBe('45min');
    expect(formatGuestRemaining(30_000)).toBe('30s');
  });

  it('Randfälle: null/undefined → leer, 0/negativ → "0s"', () => {
    expect(formatGuestRemaining(null)).toBe('');
    expect(formatGuestRemaining(undefined)).toBe('');
    expect(formatGuestRemaining(0)).toBe('0s');
    expect(formatGuestRemaining(-5000)).toBe('0s');
  });
});

describe('guestWarnLevel', () => {
  it("'warn' nur im Fenster (24h, 7d]", () => {
    expect(guestWarnLevel(7 * DAY)).toBe('warn');
    expect(guestWarnLevel(3 * DAY)).toBe('warn');
    expect(guestWarnLevel(25 * H)).toBe('warn');
  });

  it("'none' außerhalb: >7d (viel Zeit), ≤24h (Consumer-Status-quo), 0/null", () => {
    expect(guestWarnLevel(7 * DAY + 60_000)).toBe('none');
    expect(guestWarnLevel(30 * DAY)).toBe('none');
    expect(guestWarnLevel(24 * H)).toBe('none');
    expect(guestWarnLevel(10 * H)).toBe('none');
    expect(guestWarnLevel(0)).toBe('none');
    expect(guestWarnLevel(null)).toBe('none');
  });
});
