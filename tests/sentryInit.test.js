// ======================================================
// Unit-Tests: sentryInit Scrub-Helpers
// ======================================================
// Testet die in sentryInit.js exportierten _scrubSentryEvent + _scrubBreadcrumb.
// Diese laufen als beforeSend / beforeBreadcrumb Hooks im Sentry SDK
// → letzte Verteidigungslinie gegen sensitiven Daten-Leak in Production.
//
// Spec: defense-in-depth (sentry.js Wrapper macht erste Stufe; SDK fügt
// Stack-Frame-Vars + Breadcrumb-Daten erst HIER an).
// ======================================================
import { describe, it, expect } from 'vitest';
import {
  _scrubSentryEvent,
  _scrubBreadcrumb,
} from '../frontend/src/lib/sentryInit.js';

// ────────────────────────────────────────────────────────
// _scrubSentryEvent — Event-Payload-Scrubbing
// ────────────────────────────────────────────────────────
describe('_scrubSentryEvent', () => {
  it('null/undefined → unchanged (kein Crash)', () => {
    expect(_scrubSentryEvent(null)).toBe(null);
    expect(_scrubSentryEvent(undefined)).toBe(undefined);
  });

  it('exception.values: scrubt Strings nach sensiblen Substrings', () => {
    const event = {
      exception: {
        values: [{
          value: 'Failed to decrypt: phrase abandon ability'
        }],
      },
    };
    const out = _scrubSentryEvent(event);
    expect(out.exception.values[0].value).toBe('Failed to decrypt: [REDACTED] abandon ability');
  });

  it('exception.stacktrace.frames.vars: scrubt sensitive Keys', () => {
    const event = {
      exception: {
        values: [{
          stacktrace: {
            frames: [
              {
                vars: { phrase: 'a b c d', cmkBytes: new Uint8Array([1, 2, 3]) },
              },
            ],
          },
        }],
      },
    };
    const out = _scrubSentryEvent(event);
    expect(out.exception.values[0].stacktrace.frames[0].vars.phrase).toBe('[REDACTED]');
    expect(out.exception.values[0].stacktrace.frames[0].vars.cmkBytes).toBe('[REDACTED]');
  });

  it('exception.stacktrace.frames.context_line: scrubt Source-Code-Zeile', () => {
    const event = {
      exception: {
        values: [{
          stacktrace: {
            frames: [
              { context_line: 'const masterKey = derivePbkdf2(phrase)' },
            ],
          },
        }],
      },
    };
    const out = _scrubSentryEvent(event);
    expect(out.exception.values[0].stacktrace.frames[0].context_line)
      .toBe('const [REDACTED] = derivePbkdf2([REDACTED])');
  });

  it('top-level message wird gescrubt', () => {
    const event = { message: 'leaked: cmkBytes=base64stuff' };
    const out = _scrubSentryEvent(event);
    expect(out.message).toBe('leaked: [REDACTED]=base64stuff');
  });

  it('extra-Context wird rekursiv gescrubt (inkl. Identitäts-/Beziehungs-Keys)', () => {
    const event = {
      extra: {
        peer: 'anna',            // Handle = Beziehungsdatum → jetzt redacted
        note: 'harmless',        // nicht-sensibler Key → bleibt
        privateKey: 'xxx',
        nested: { masterKey: 'yyy', innocent: 42 },
      },
    };
    const out = _scrubSentryEvent(event);
    expect(out.extra.peer).toBe('[REDACTED]');   // Peer-Handle nicht mehr geleakt
    expect(out.extra.note).toBe('harmless');
    expect(out.extra.privateKey).toBe('[REDACTED]');
    expect(out.extra.nested.masterKey).toBe('[REDACTED]');
    expect(out.extra.nested.innocent).toBe(42);
  });

  it('Uint8Array in vars wird zu [REDACTED:bytes]', () => {
    const event = {
      exception: {
        values: [{
          stacktrace: {
            frames: [{ vars: { someKey: new Uint8Array([0, 1, 2]) } }],
          },
        }],
      },
    };
    const out = _scrubSentryEvent(event);
    expect(out.exception.values[0].stacktrace.frames[0].vars.someKey).toBe('[REDACTED:bytes]');
  });

  it('Tags werden gescrubt (inkl. user-Identität)', () => {
    const event = { tags: { phrase: 'leak', user: 'anna', pwa: 'yes' } };
    const out = _scrubSentryEvent(event);
    expect(out.tags.phrase).toBe('[REDACTED]');
    expect(out.tags.user).toBe('[REDACTED]');   // Identität nicht mehr geleakt
    expect(out.tags.pwa).toBe('yes');
  });
});

// ────────────────────────────────────────────────────────
// _scrubBreadcrumb — Breadcrumb-Filtering
// ────────────────────────────────────────────────────────
describe('_scrubBreadcrumb', () => {
  it('null → unchanged', () => {
    expect(_scrubBreadcrumb(null)).toBe(null);
  });

  it('Fetch-Breadcrumb mit /e2e/-URL → null (kompletter Drop)', () => {
    const crumb = {
      category: 'fetch',
      data: { url: 'https://api.renex.id/e2e/cmk/store' },
    };
    expect(_scrubBreadcrumb(crumb)).toBe(null);
  });

  it('Fetch-Breadcrumb mit /chat/keys/-URL → null', () => {
    const crumb = {
      category: 'fetch',
      data: { url: 'https://api.renex.id/chat/keys/upload' },
    };
    expect(_scrubBreadcrumb(crumb)).toBe(null);
  });

  it('Fetch-Breadcrumb mit /push/-URL → null', () => {
    const crumb = {
      category: 'xhr',
      data: { url: 'https://api.renex.id/push/subscribe' },
    };
    expect(_scrubBreadcrumb(crumb)).toBe(null);
  });

  it('Fetch-Breadcrumb mit harmloser URL → durchgereicht', () => {
    const crumb = {
      category: 'fetch',
      data: { url: 'https://api.renex.id/contacts/list', method: 'GET' },
    };
    const out = _scrubBreadcrumb(crumb);
    expect(out).toBeTruthy();
    expect(out.data.url).toContain('/contacts/list');
  });

  it('Breadcrumb mit sensible Daten in data wird gescrubt', () => {
    const crumb = {
      category: 'console',
      data: { phrase: 'leak', innocent: 'ok' },
    };
    const out = _scrubBreadcrumb(crumb);
    expect(out.data.phrase).toBe('[REDACTED]');
    expect(out.data.innocent).toBe('ok');
  });

  it('Breadcrumb-Message wird nach sensiblen Substrings gefiltert', () => {
    const crumb = { message: 'derived masterKey from phrase' };
    const out = _scrubBreadcrumb(crumb);
    expect(out.message).toBe('derived [REDACTED] from [REDACTED]');
  });

  it('Non-fetch-Breadcrumb mit /e2e/ in message wird NICHT gedroppt (nur Daten gescrubt)', () => {
    // /e2e/-URL-Drop greift nur bei category=fetch/xhr
    const crumb = {
      category: 'console',
      message: 'request to /e2e/keys',
    };
    const out = _scrubBreadcrumb(crumb);
    expect(out).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────
// Defense-in-Depth: sensitive Constants stay synced with sentry.js
// ────────────────────────────────────────────────────────
describe('Pattern-Konsistenz mit sentry.js', () => {
  it('Bekannte sensitive Keys werden in beiden Modulen erkannt', async () => {
    // Smoke-Test: import sentry.js' _scrub und vergleiche mit sentryInit's _scrubSentryEvent
    // → wenn jemand die Liste in nur EINEM Modul updatet, fehlt die andere Stufe
    const sentryMod = await import('../frontend/src/lib/sentry.js');
    const samples = ['phrase', 'mnemonic', 'cmkBytes', 'masterKey', 'privateKey', 'recoveryKey'];

    for (const key of samples) {
      // sentry.js wrapper-side scrub
      const wrapped = sentryMod.__testInternals._scrub({ [key]: 'leak' });
      expect(wrapped[key], `${key} muss von sentry.js _scrub redacted werden`).toBe('[REDACTED]');

      // sentryInit beforeSend-side scrub
      const event = { extra: { [key]: 'leak' } };
      const scrubbed = _scrubSentryEvent(event);
      expect(scrubbed.extra[key], `${key} muss von sentryInit _scrubSentryEvent redacted werden`).toBe('[REDACTED]');
    }
  });
});
