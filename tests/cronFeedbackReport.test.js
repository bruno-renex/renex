// ======================================================
// Unit-Tests: Daily Feedback Report Cron-Sweep
// ======================================================
// Garantien:
//   - Bei ≥1 Feedback der letzten 24h → genau 1 Web-Push an REPORT_HANDLE
//     mit Kategorie-Aufschlüsselung + Snippet der neuesten Nachricht.
//   - Bei 0 Einträgen → KEIN Push (kein Leer-Spam), { sent:false, count:0 }.
//   - Kategorie-Breakdown deterministisch (Anzahl desc, dann alphabetisch).
//   - Neueste Nachricht gekürzt auf 80 Zeichen (+ „…"), Whitespace normalisiert.
//   - D1-Fehler → KEIN throw (scheduled-Handler darf nicht crashen),
//     { sent:false }, kein Push.
//   - opts.handle überschreibt den Default-Handle.
// ======================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';

// pushToUser mocken BEVOR cron.js importiert wird.
vi.mock('../src/helpers/pushSend.js', () => ({
  pushToUser: vi.fn(() => Promise.resolve()),
}));
// auth.js (pushToUserDO) wird von cron.js importiert, aber vom Report nicht
// genutzt — minimal mocken, damit der Import isoliert/leicht bleibt.
vi.mock('../src/auth.js', () => ({
  pushToUserDO: vi.fn(() => Promise.resolve(0)),
}));

import { runDailyFeedbackReport } from '../src/cron.js';
import { pushToUser } from '../src/helpers/pushSend.js';

// ── Mock-Layer ─────────────────────────────────────────

/**
 * Baut einen Mock-`env`, dessen einzige D1-Query (das feedback-SELECT)
 * die geseedeten Rows zurückgibt. `failDb:true` lässt die Query rejecten.
 */
function buildEnv(seed = {}) {
  const rows = [...(seed.rows || [])];
  const failDb = !!seed.failDb;

  const db = {
    prepare(sql) {
      return {
        bind: () => ({ all: () => allImpl() }),
        all: () => allImpl(),
        first: () => Promise.resolve(null),
        run: () => Promise.resolve({ meta: { changes: 0 } }),
      };

      function allImpl() {
        if (failDb) return Promise.reject(new Error('simulated D1 failure'));
        if (/FROM\s+feedback/i.test(sql)) {
          return Promise.resolve({ results: rows });
        }
        return Promise.resolve({ results: [] });
      }
    },
  };

  return { RENEX_DB: db };
}

const T = (daysAgo = 0) => Date.now() - daysAgo * 86400_000;

beforeEach(() => {
  vi.clearAllMocks();
});

// ────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────

describe('Feedback-Report: 0 Einträge', () => {
  it('Keine neuen Feedbacks → kein Push, sent:false', async () => {
    const env = buildEnv({ rows: [] });
    const result = await runDailyFeedbackReport(env);

    expect(result).toEqual({ sent: false, count: 0 });
    expect(pushToUser).not.toHaveBeenCalled();
  });
});

describe('Feedback-Report: ≥1 Eintrag → Push', () => {
  it('Sendet genau 1 Push an Default-Handle mit korrekter Payload', async () => {
    const env = buildEnv({
      rows: [
        { name: 'Lena',  category: 'bug',     message: 'Login hängt auf iOS', created_at: T(0) },
        { name: 'Tom',   category: 'feature', message: 'Dark Mode bitte',     created_at: T(0.5) },
      ],
    });

    const result = await runDailyFeedbackReport(env);

    expect(result).toEqual({ sent: true, count: 2 });
    expect(pushToUser).toHaveBeenCalledTimes(1);

    const [, handle, payload] = pushToUser.mock.calls[0];
    expect(handle).toBe('renex');
    expect(payload.title).toBe('RENEX Feedback (24h)');
    expect(payload.tag).toBe('renex-feedback-daily');
    expect(payload.data).toMatchObject({ type: 'feedback_report', count: 2, url: '/feedback/' });

    // Body: Count, beide Kategorien, Snippet der NEUESTEN Nachricht + Name.
    expect(payload.body).toContain('2 neu:');
    expect(payload.body).toContain('1 bug');
    expect(payload.body).toContain('1 feature');
    expect(payload.body).toContain('Login hängt auf iOS'); // newest = rows[0]
    expect(payload.body).toContain('Lena');
  });

  it('Kategorie-Breakdown ist deterministisch (Anzahl desc, dann alphabetisch)', async () => {
    const env = buildEnv({
      rows: [
        { name: 'A', category: 'feature', message: 'msg eins reicht hier', created_at: T(0) },
        { name: 'B', category: 'feature', message: 'msg zwei', created_at: T(0.1) },
        { name: 'C', category: 'bug',     message: 'msg drei', created_at: T(0.2) },
        { name: 'D', category: 'allgemein', message: 'msg vier', created_at: T(0.3) },
      ],
    });

    await runDailyFeedbackReport(env);
    const payload = pushToUser.mock.calls[0][2];

    // 2 feature (höchste Anzahl) zuerst; dann allgemein vs bug alphabetisch.
    const breakdownLine = payload.body.split('\n')[0];
    expect(breakdownLine).toBe('4 neu: 2 feature · 1 allgemein · 1 bug');
  });
});

describe('Feedback-Report: Snippet-Truncation', () => {
  it('Lange Nachricht (>80) wird auf 80 Zeichen + „…" gekürzt, Whitespace normalisiert', async () => {
    const long = 'Wort '.repeat(40).trim(); // weit über 80 Zeichen, mit Spaces
    const env = buildEnv({
      rows: [{ name: 'Max', category: 'allgemein', message: long, created_at: T(0) }],
    });

    await runDailyFeedbackReport(env);
    const payload = pushToUser.mock.calls[0][2];

    const expectedSnippet = long.replace(/\s+/g, ' ').trim().slice(0, 80);
    expect(payload.body).toContain(expectedSnippet);
    expect(payload.body).toContain('…');
    // Snippet darf den 80-Zeichen-Ausschnitt nicht überschreiten.
    expect(expectedSnippet.length).toBe(80);
  });

  it('Kurze Nachricht erhält KEIN „…"', async () => {
    const env = buildEnv({
      rows: [{ name: 'Max', category: 'lob', message: 'Tolle App!', created_at: T(0) }],
    });

    await runDailyFeedbackReport(env);
    const payload = pushToUser.mock.calls[0][2];

    expect(payload.body).toContain('Tolle App!');
    expect(payload.body).not.toContain('…');
  });

  it('Mehrzeilige Nachricht wird zu einer Zeile normalisiert', async () => {
    const env = buildEnv({
      rows: [{ name: 'Max', category: 'bug', message: 'Zeile1\n\n   Zeile2\tTab', created_at: T(0) }],
    });

    await runDailyFeedbackReport(env);
    const payload = pushToUser.mock.calls[0][2];

    expect(payload.body).toContain('Zeile1 Zeile2 Tab');
  });
});

describe('Feedback-Report: Fallbacks & Resilience', () => {
  it('Leerer Name → "Anonym"', async () => {
    const env = buildEnv({
      rows: [{ name: '', category: 'bug', message: 'Crash beim Start', created_at: T(0) }],
    });

    await runDailyFeedbackReport(env);
    const payload = pushToUser.mock.calls[0][2];
    expect(payload.body).toContain('Anonym');
  });

  it('Fehlende category → "allgemein"', async () => {
    const env = buildEnv({
      rows: [{ name: 'X', category: null, message: 'kategorielos hier rein', created_at: T(0) }],
    });

    await runDailyFeedbackReport(env);
    const payload = pushToUser.mock.calls[0][2];
    expect(payload.body).toContain('1 allgemein');
  });

  it('D1-Fehler → KEIN throw, sent:false, kein Push', async () => {
    const env = buildEnv({ failDb: true });

    // runDailyFeedbackReport fängt intern → rejected NIE (sonst crasht der
    // scheduled-Handler). Ein await ohne try/catch hier IST die Assertion.
    const result = await runDailyFeedbackReport(env);

    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/simulated D1 failure/);
    expect(pushToUser).not.toHaveBeenCalled();
  });
});

describe('Feedback-Report: Handle-Override', () => {
  it('opts.handle überschreibt den Default-Report-Handle', async () => {
    const env = buildEnv({
      rows: [{ name: 'Y', category: 'lob', message: 'super sache hier', created_at: T(0) }],
    });

    await runDailyFeedbackReport(env, { handle: 'admin' });
    const [, handle] = pushToUser.mock.calls[0];
    expect(handle).toBe('admin');
  });
});
