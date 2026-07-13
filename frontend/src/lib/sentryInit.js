// ======================================================
// SENTRY INIT — Frontend Error-Tracking (lazy + optional)
// ======================================================
// Privacy-First-Setup (Port aus renex-legacy/js/sentryInit.js):
//  - DSN kommt aus /sentry-config (Backend-Endpoint), nicht hardcoded
//  - Wenn keine DSN konfiguriert → silent no-op
//  - PII-Schutz: keine User-Eingaben, keine Message-Inhalte gesendet
//  - 100% Errors, 0% Performance (kein Bloat)
//  - Breadcrumbs filtern: keine sensiblen URLs (/chat/keys/, /e2e/, /push/)
//
// Lädt Sentry als UMD-Script (window.Sentry) — KEIN ES-Modul-Import,
// weil Sentry's CDN-Bundles UMD sind, nicht ES Modules.
// Skipt automatisch in Dev-Mode (vite serve) via import.meta.env.DEV.
// ======================================================

const SENTRY_CONFIG_URL = 'https://api.renex.id/sentry-config';
const SENTRY_CDN_URL    = 'https://browser.sentry-cdn.com/8.40.0/bundle.min.js';

// ======================================================
// Privacy-Scrubbing für Stack-Frame-Vars + Breadcrumb-Daten.
// Sentry SDK fügt diese erst in beforeSend/beforeBreadcrumb-Hooks an,
// daher zweite Stufe HIER nötig (sentry.js Wrapper macht erste Stufe).
// HALTE diese Patterns IDENTISCH mit sentry.js — beide sind defense-in-depth.
// ======================================================
const _SENSITIVE_KEY_RE = /^(phrase|mnemonic|seed|cmk|cmkBytes|masterKey|masterKeyBytes|privateKey|priv|password|secret|sigKey|recoveryKey|deviceSecret|p256dh|jwk|d|x|y|[a-z]*handle|from|to|peer|me|user|username|contact|recipient|sender|callee|caller|inviter|invitee)$/i;
const _SENSITIVE_VALUE_RE = /\b(phrase|mnemonic|cmkBytes|masterKey(?:Bytes)?|privateKey|deviceSecret|recoveryKey)\b/gi;
const _MAX_DEPTH = 6;

function _scrubObj(value, depth = 0) {
  if (depth > _MAX_DEPTH) return '[REDACTED:depth]';
  if (value == null) return value;
  if (typeof value === 'string') {
    _SENSITIVE_VALUE_RE.lastIndex = 0;
    return value.replace(_SENSITIVE_VALUE_RE, '[REDACTED]');
  }
  if (typeof value !== 'object') return value;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer
      || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView?.(value))) {
    return '[REDACTED:bytes]';
  }
  if (Array.isArray(value)) {
    return value.map(v => _scrubObj(v, depth + 1));
  }
  const out = {};
  for (const k of Object.keys(value)) {
    if (_SENSITIVE_KEY_RE.test(k)) out[k] = '[REDACTED]';
    else out[k] = _scrubObj(value[k], depth + 1);
  }
  return out;
}

export function _scrubSentryEvent(event) {
  if (!event) return event;
  if (event.exception?.values) {
    for (const ev of event.exception.values) {
      if (typeof ev.value === 'string') {
        _SENSITIVE_VALUE_RE.lastIndex = 0;
        ev.value = ev.value.replace(_SENSITIVE_VALUE_RE, '[REDACTED]');
      }
      if (ev.stacktrace?.frames) {
        for (const f of ev.stacktrace.frames) {
          if (f.vars) f.vars = _scrubObj(f.vars);
          if (typeof f.context_line === 'string') {
            _SENSITIVE_VALUE_RE.lastIndex = 0;
            f.context_line = f.context_line.replace(_SENSITIVE_VALUE_RE, '[REDACTED]');
          }
        }
      }
    }
  }
  if (typeof event.message === 'string') {
    _SENSITIVE_VALUE_RE.lastIndex = 0;
    event.message = event.message.replace(_SENSITIVE_VALUE_RE, '[REDACTED]');
  }
  if (event.extra)    event.extra    = _scrubObj(event.extra);
  if (event.contexts) event.contexts = _scrubObj(event.contexts);
  if (event.tags)     event.tags     = _scrubObj(event.tags);
  return event;
}

export function _scrubBreadcrumb(crumb) {
  if (!crumb) return crumb;
  if (crumb.category === 'fetch' || crumb.category === 'xhr') {
    if (crumb.data?.url && /\/chat\/keys\/|\/e2e\/|\/push\//.test(crumb.data.url)) {
      return null;
    }
  }
  if (crumb.data) crumb.data = _scrubObj(crumb.data);
  if (typeof crumb.message === 'string') {
    _SENSITIVE_VALUE_RE.lastIndex = 0;
    crumb.message = crumb.message.replace(_SENSITIVE_VALUE_RE, '[REDACTED]');
  }
  return crumb;
}

// ======================================================
// Public API
// ======================================================

let _initialized = false;

/**
 * Initialisiert Sentry (idempotent, async).
 *
 * Skipt automatisch:
 *   - in Dev-Mode (import.meta.env.DEV)
 *   - wenn /sentry-config keine DSN liefert (Backend-Toggle)
 *   - wenn schon mal initialisiert
 *   - wenn Sentry-CDN nicht erreichbar
 *
 * Returnt true wenn Sentry erfolgreich aktiviert wurde, sonst false.
 */
export async function initSentry() {
  if (_initialized) return true;
  if (import.meta.env?.DEV) return false;
  if (typeof window === 'undefined') return false;
  _initialized = true;

  // 1) DSN aus Backend
  let dsn = null;
  try {
    const r = await fetch(SENTRY_CONFIG_URL, { credentials: 'omit' });
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      dsn = d.dsn || null;
    }
  } catch {
    return false;  // Backend nicht erreichbar
  }
  if (!dsn) return false;

  // 2) Sentry SDK lazy via Script-Tag laden (UMD)
  const loaded = await new Promise((resolve) => {
    if (window.Sentry) { resolve(true); return; }
    const s = document.createElement('script');
    s.src = SENTRY_CDN_URL;
    s.crossOrigin = 'anonymous';
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
  if (!loaded || !window.Sentry || typeof window.Sentry.init !== 'function') {
    console.warn('📊 Sentry: SDK not loaded');
    return false;
  }

  // 3) Initialize
  try {
    window.Sentry.init({
      dsn,
      environment: 'production',
      release: document.querySelector('meta[name="renex-version"]')?.content || 'unknown',
      tracesSampleRate: 0,
      sampleRate: 1.0,
      ignoreErrors: [
        'ResizeObserver loop limit exceeded',
        'Non-Error promise rejection captured',
        'NetworkError',
        'AbortError',
        // Expected attachment-Edge-Cases — AttachmentView zeigt UI-Hinweis,
        // kein Crash. Single-flight in downloadHelper.js kann trotz
        // .catch()-Observer in seltenen Microtask-Races leaken.
        'attachment_gone',
        'attachment_forbidden',
      ],
      beforeSend(event) {
        if (event.request?.url) {
          if (/\/chat\/keys\/|\/e2e\/|\/push\//.test(event.request.url)) {
            return null;  // ganzen Event droppen — URL signalisiert kritischen Pfad
          }
        }
        if (event.request?.query_string) delete event.request.query_string;
        return _scrubSentryEvent(event);
      },
      beforeBreadcrumb(crumb) {
        return _scrubBreadcrumb(crumb);
      },
    });

    window.Sentry.setTag('pwa', window.matchMedia?.('(display-mode: standalone)').matches ? 'yes' : 'no');

    // KEIN setUser mehr: der Handle (= Identität) ging bisher an JEDES Event
    // (Sentry-EU). Zero-Tracking heißt: Fehler-Telemetrie ohne Nutzer-Identität.
    // Sentry gruppiert Fehler auch ohne user.id (per Fingerprint/Stacktrace).

    const v = document.querySelector('meta[name="renex-version"]')?.content || 'unknown';
    console.log(`📊 Sentry ready (release=${v})`);
    return true;
  } catch (e) {
    console.warn('📊 Sentry init failed:', e?.message);
    return false;
  }
}
