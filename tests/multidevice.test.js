// ======================================================
// Unit-Tests für Multi-Device Pure-Helpers
// ======================================================
// Spec: docs/MULTI_DEVICE.md §8.1
//
// Testbereich:
//   - recoveryCutoffFilter: 7-Tage-Filter beim Add-Device-Flow
//   - isValidStateTransition: Device-State-Machine
//   - formatRelativeTime: i18n-aware Zeitformat
//   - deviceIcon: Icon-Mapping aus Name/UserAgent
//   - detectDeviceName: User-Agent-Parsing (mit navigator-Stub)
//
// VISION-Decision-Log: "Crypto ohne Tests = Selbstmord."
// Multi-Device-State-Logik ist crypto-relevant — wenn z.B. eine ungültige
// Transition durchrutscht (z.B. revoked → active), bricht Forward-Secrecy.
// ======================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── navigator-Stub für detectDeviceName-Tests ────────────────
// detectDeviceName liest navigator.userAgent. Node 21+ exposed navigator als
// getter-only — direkte Assignment schlägt fehl. vi.stubGlobal umgeht das.
function setNavigator(ua) {
  vi.stubGlobal('navigator', { userAgent: ua });
}

// Lazy import nach Stub-Setup (für detectDeviceName) — die anderen Pure-Helpers
// sind navigator-unabhängig, aber wir importieren alles aus einer Quelle.
import {
  recoveryCutoffFilter,
  isValidStateTransition,
  formatRelativeTime,
  deviceIcon,
  detectDeviceName,
  DEVICE_STATES,
} from '../frontend/src/lib/multidevice.js';

// ======================================================
// recoveryCutoffFilter — 7-Tage-Cutoff
// ======================================================
describe('recoveryCutoffFilter', () => {
  const NOW = 1714305600000; // fix Unix-ms für Reproduzierbarkeit
  const DAY = 86400_000;

  it('returns convos within the last 7 days (default cutoff)', () => {
    const convos = [
      { convoId: 'a:b', lastMessageTs: NOW - 1 * DAY },     // recent
      { convoId: 'a:c', lastMessageTs: NOW - 6 * DAY },     // recent
      { convoId: 'a:d', lastMessageTs: NOW - 8 * DAY },     // too old
      { convoId: 'a:e', lastMessageTs: NOW - 30 * DAY },    // way too old
    ];
    const result = recoveryCutoffFilter(convos, NOW);
    expect(result.map(c => c.convoId)).toEqual(['a:b', 'a:c']);
  });

  it('boundary case: exactly 7 days old → excluded (strict cutoff)', () => {
    // cutoff ist `lastMessageTs > now - 7d`, also exakt 7d alt fällt raus
    const convos = [
      { convoId: 'a:edge', lastMessageTs: NOW - 7 * DAY },
    ];
    expect(recoveryCutoffFilter(convos, NOW)).toEqual([]);
  });

  it('boundary case: 7 days minus 1ms → included', () => {
    const convos = [
      { convoId: 'a:edge', lastMessageTs: NOW - 7 * DAY + 1 },
    ];
    expect(recoveryCutoffFilter(convos, NOW).length).toBe(1);
  });

  it('respects custom cutoff (e.g. 30 days for full recovery)', () => {
    const convos = [
      { convoId: 'a:b', lastMessageTs: NOW - 20 * DAY },
      { convoId: 'a:c', lastMessageTs: NOW - 40 * DAY },
    ];
    expect(recoveryCutoffFilter(convos, NOW, 30).map(c => c.convoId)).toEqual(['a:b']);
  });

  it('returns empty array for empty input', () => {
    expect(recoveryCutoffFilter([], NOW)).toEqual([]);
  });

  it('returns empty array for non-array input (defensive)', () => {
    expect(recoveryCutoffFilter(null, NOW)).toEqual([]);
    expect(recoveryCutoffFilter(undefined, NOW)).toEqual([]);
    expect(recoveryCutoffFilter('not an array', NOW)).toEqual([]);
  });

  it('skips entries without numeric lastMessageTs (defensive)', () => {
    const convos = [
      { convoId: 'a:valid', lastMessageTs: NOW - 1 * DAY },
      { convoId: 'a:no-ts' },                                // missing
      { convoId: 'a:null', lastMessageTs: null },            // null
      { convoId: 'a:string', lastMessageTs: 'recent' },      // wrong type
    ];
    const result = recoveryCutoffFilter(convos, NOW);
    expect(result.map(c => c.convoId)).toEqual(['a:valid']);
  });
});

// ======================================================
// isValidStateTransition — Device-State-Machine
// ======================================================
describe('isValidStateTransition', () => {
  it('allows new → syncing (after pubkey upload)', () => {
    expect(isValidStateTransition('new', 'syncing')).toBe(true);
  });

  it('allows new → revoked (stuck-cleanup before sync)', () => {
    expect(isValidStateTransition('new', 'revoked')).toBe(true);
  });

  it('allows syncing → active (first CMK fetched)', () => {
    expect(isValidStateTransition('syncing', 'active')).toBe(true);
  });

  it('allows syncing → revoked (stuck-cleanup after 24h)', () => {
    expect(isValidStateTransition('syncing', 'revoked')).toBe(true);
  });

  it('allows active → active (heartbeat refresh)', () => {
    expect(isValidStateTransition('active', 'active')).toBe(true);
  });

  it('allows active → revoked (user/auto/self revoke)', () => {
    expect(isValidStateTransition('active', 'revoked')).toBe(true);
  });

  it('forbids revoked → anything (terminal state)', () => {
    expect(isValidStateTransition('revoked', 'active')).toBe(false);
    expect(isValidStateTransition('revoked', 'syncing')).toBe(false);
    expect(isValidStateTransition('revoked', 'new')).toBe(false);
    expect(isValidStateTransition('revoked', 'revoked')).toBe(false);
  });

  it('forbids skipping syncing (new → active)', () => {
    // Forward-Secrecy: ein Device darf erst senden/empfangen wenn es eine CMK
    // bekommen hat. Direkt new→active würde diese Garantie umgehen.
    expect(isValidStateTransition('new', 'active')).toBe(false);
  });

  it('forbids backwards transitions (active → syncing)', () => {
    expect(isValidStateTransition('active', 'syncing')).toBe(false);
    expect(isValidStateTransition('active', 'new')).toBe(false);
    expect(isValidStateTransition('syncing', 'new')).toBe(false);
  });

  it('rejects unknown states', () => {
    expect(isValidStateTransition('foo', 'active')).toBe(false);
    expect(isValidStateTransition('active', 'bar')).toBe(false);
    expect(isValidStateTransition('', '')).toBe(false);
  });

  it('rejects non-string inputs (defensive)', () => {
    expect(isValidStateTransition(null, 'active')).toBe(false);
    expect(isValidStateTransition('active', undefined)).toBe(false);
    expect(isValidStateTransition(1, 2)).toBe(false);
  });

  it('exports DEVICE_STATES enum matching state-machine §3', () => {
    expect(DEVICE_STATES).toEqual(['new', 'syncing', 'active', 'revoked']);
  });
});

// ======================================================
// formatRelativeTime — i18n-Zeitformat
// ======================================================
describe('formatRelativeTime', () => {
  // Wir mocken Date.now() implizit, indem wir ts gegen einen Pseudo-Now stellen.
  // Da formatRelativeTime intern Date.now() ruft, müssen wir mit echten
  // Offsets arbeiten.
  const realNow = Date.now();

  it('returns "—" for null/undefined/0', () => {
    expect(formatRelativeTime(null)).toBe('—');
    expect(formatRelativeTime(undefined)).toBe('—');
    expect(formatRelativeTime(0)).toBe('—');
  });

  it('returns "jetzt" for ts within last minute (de-DE default)', () => {
    expect(formatRelativeTime(realNow - 30_000)).toBe('jetzt');
  });

  it('returns "now" for ts within last minute (en locale)', () => {
    expect(formatRelativeTime(realNow - 30_000, 'en-US')).toBe('now');
  });

  it('returns "vor Xmin" for ts within last hour (de-DE)', () => {
    expect(formatRelativeTime(realNow - 5 * 60_000)).toBe('vor 5min');
  });

  it('returns "Xmin ago" for ts within last hour (en-US)', () => {
    expect(formatRelativeTime(realNow - 5 * 60_000, 'en-US')).toBe('5min ago');
  });

  it('returns "vor Xh" for ts within last day (de-DE)', () => {
    expect(formatRelativeTime(realNow - 3 * 3600_000)).toBe('vor 3h');
  });

  it('returns "vor Xd" for ts within last week (de-DE)', () => {
    expect(formatRelativeTime(realNow - 4 * 86400_000)).toBe('vor 4d');
  });

  it('falls back to localeDateString for >7 days', () => {
    const oldTs = realNow - 30 * 86400_000;
    const result = formatRelativeTime(oldTs, 'de-DE');
    // Format ist locale-abhängig, aber sollte irgendetwas mit Datum sein,
    // nicht mit "vor" oder "ago"
    expect(result).not.toContain('vor');
    expect(result).not.toContain('ago');
    expect(result.length).toBeGreaterThan(3);
  });
});

// ======================================================
// deviceIcon — Icon-Mapping
// ======================================================
describe('deviceIcon', () => {
  it('maps iPhone/iPad/Android to phone-icon', () => {
    expect(deviceIcon('iPhone (Safari)')).toBe('📱');
    expect(deviceIcon('iPad (Safari)')).toBe('📱');
    expect(deviceIcon('Android (Chrome)')).toBe('📱');
  });

  it('maps Mac/MacBook to laptop-icon', () => {
    expect(deviceIcon('Mac (Safari)')).toBe('💻');
    expect(deviceIcon('MacBook Pro')).toBe('💻');
  });

  it('maps Windows to desktop-icon', () => {
    expect(deviceIcon('Windows (Chrome)')).toBe('🖥️');
  });

  it('maps Linux to penguin-icon', () => {
    expect(deviceIcon('Linux (Firefox)')).toBe('🐧');
  });

  it('falls back to lock-icon for unknown', () => {
    expect(deviceIcon('Unknown')).toBe('🔐');
    expect(deviceIcon('')).toBe('🔐');
    expect(deviceIcon(null)).toBe('🔐');
    expect(deviceIcon(undefined)).toBe('🔐');
  });

  it('is case-insensitive', () => {
    expect(deviceIcon('IPHONE')).toBe('📱');
    expect(deviceIcon('mAcBoOk')).toBe('💻');
  });

  it('matches against full User-Agent strings', () => {
    const iosUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
    expect(deviceIcon(iosUA)).toBe('📱');
  });
});

// ======================================================
// detectDeviceName — User-Agent-Parsing
// ======================================================
describe('detectDeviceName', () => {
  beforeEach(() => {
    // Default-Stub vor jedem Test
    setNavigator('');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detects iPhone + Safari', () => {
    setNavigator('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
    expect(detectDeviceName()).toBe('iPhone (Safari)');
  });

  it('detects Mac + Chrome', () => {
    setNavigator('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    expect(detectDeviceName()).toBe('Mac (Chrome)');
  });

  it('detects Windows + Edge', () => {
    setNavigator('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Edg/120.0.0.0');
    expect(detectDeviceName()).toBe('Windows (Edge)');
  });

  it('detects Android + Chrome', () => {
    setNavigator('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0');
    // Android wins over Linux check (order in implementation)
    expect(detectDeviceName()).toBe('Android (Chrome)');
  });

  it('detects Linux + Firefox', () => {
    setNavigator('Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0');
    expect(detectDeviceName()).toBe('Linux (Firefox)');
  });

  it('falls back to Unknown (Browser) for empty UA', () => {
    setNavigator('');
    expect(detectDeviceName()).toBe('Unknown (Browser)');
  });

  it('does not crash when navigator.userAgent is missing', () => {
    vi.stubGlobal('navigator', {});
    // Sollte nicht throwen, irgendwas Sinnvolles zurückgeben
    expect(() => detectDeviceName()).not.toThrow();
  });

  it('result fits 64-char Backend-Limit', () => {
    // Längster realistischer Output: "Macintosh (Browser)" o.ä. — sollte
    // immer weit unter 64 Zeichen sein
    setNavigator('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    expect(detectDeviceName().length).toBeLessThanOrEqual(64);
  });
});
