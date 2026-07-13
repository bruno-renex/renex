// ======================================================
// Sentry-Wrapper — Safe-Calls für Frontend
// ======================================================
// Nutzt window.Sentry wenn verfügbar (lazy-loaded via sentryInit.js).
// Wenn Sentry nicht da: silent no-op.
//
// Privacy-Hardening (M2, 2026-05-02):
// Alle Daten die Sentry gesendet werden, werden VOR dem Send gescrubt.
// Schützt gegen versehentliches Leaken von Phrase, CMK-Bytes, MasterKey etc.
// via captureException-Context oder Error-Message-Text.
// Defense-in-depth: zusätzlich filtert sentryInit.js's beforeSend Hook
// Stack-Frame-Vars + Breadcrumb-Daten.
// ======================================================

// Key-Namen die NIE an Sentry gehen sollen (case-insensitive, exact match).
// Enthält jetzt auch Identitäts-/Beziehungs-Keys (Handle-Paare = Sozialgraph):
// jede *handle-Variante + Beziehungs-Felder from/to/peer/me/contact/…
// HALTE identisch mit sentryInit.js (defense-in-depth, zwei Scrub-Stufen).
const _SENSITIVE_KEY_RE = /^(phrase|mnemonic|seed|cmk|cmkBytes|masterKey|masterKeyBytes|privateKey|priv|password|secret|sigKey|recoveryKey|deviceSecret|p256dh|jwk|d|x|y|[a-z]*handle|from|to|peer|me|user|username|contact|recipient|sender|callee|caller|inviter|invitee)$/i;

// String-Substrings die in Texten redacted werden (Defense gegen Error-Messages
// die Werte interpolieren — z.B. `throw new Error("decrypt failed for cmk=" + base64)`)
const _SENSITIVE_VALUE_RE = /\b(phrase|mnemonic|cmkBytes|masterKey(?:Bytes)?|privateKey|deviceSecret|recoveryKey)\b/gi;

const _MAX_DEPTH = 6;
const _MAX_STRING_LEN = 2000;

/**
 * Rekursiv sensible Felder/Werte redigieren.
 * Returnt eine NEUE Datenstruktur (mutiert das Original nicht).
 */
function _scrub(value, depth = 0) {
  if (depth > _MAX_DEPTH) return '[REDACTED:depth]';
  if (value == null) return value;

  // Binary key material → REDACTED
  if (value instanceof Uint8Array || value instanceof ArrayBuffer
      || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView?.(value))) {
    return '[REDACTED:bytes]';
  }

  // CryptoKey Instanzen — exposed type/algo aber kein Key-Material
  if (typeof CryptoKey !== 'undefined' && value instanceof CryptoKey) {
    return `[CryptoKey ${value.type}/${value.algorithm?.name || '?'}]`;
  }

  if (typeof value === 'string') {
    let s = value.replace(_SENSITIVE_VALUE_RE, '[REDACTED]');
    if (s.length > _MAX_STRING_LEN) s = s.slice(0, _MAX_STRING_LEN) + '…[truncated]';
    return s;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (value instanceof Error) {
    // Error: nur Name + scrubbed Message, kein full object
    return {
      name: value.name,
      message: typeof value.message === 'string'
        ? value.message.replace(_SENSITIVE_VALUE_RE, '[REDACTED]').slice(0, _MAX_STRING_LEN)
        : '[non-string]',
    };
  }

  if (Array.isArray(value)) {
    return value.map(v => _scrub(v, depth + 1));
  }

  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (_SENSITIVE_KEY_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = _scrub(v, depth + 1);
      }
    }
    return out;
  }

  // function, symbol, bigint → drop
  return undefined;
}

/**
 * Scrubbe eine Error-Instance: Name + Message OK, aber Message-Text wird
 * nach sensiblen Substrings gefiltert. Return das ORIGINAL-Error-Objekt
 * (damit Sentry SDK sein Stack-Trace + native Properties extrahieren kann),
 * aber mit modifizierter Message.
 */
function _scrubError(err) {
  if (!(err instanceof Error)) return err;
  if (typeof err.message === 'string' && _SENSITIVE_VALUE_RE.test(err.message)) {
    // Reset RegExp lastIndex (global flag)
    _SENSITIVE_VALUE_RE.lastIndex = 0;
    try {
      err.message = err.message.replace(_SENSITIVE_VALUE_RE, '[REDACTED]');
    } catch { /* nicht-mutierbar (frozen Error) — silent skip */ }
  }
  return err;
}

export function captureException(err, context = {}) {
  try {
    if (window.Sentry?.captureException) {
      window.Sentry.captureException(_scrubError(err), {
        extra: _scrub(context),
      });
    }
  } catch { /* never throw from logging */ }
}

export function addBreadcrumb(crumb) {
  try {
    if (window.Sentry?.addBreadcrumb) {
      window.Sentry.addBreadcrumb(_scrub(crumb));
    }
  } catch {}
}

export function setUser(user) {
  try {
    if (window.Sentry?.setUser) {
      // User darf nur den Handle enthalten (vorhandene Konvention).
      // Kein PII, kein E-Mail. Wenn caller mehr passt, scrubben.
      window.Sentry.setUser(_scrub(user));
    }
  } catch {}
}

export function setTag(key, value) {
  try {
    if (window.Sentry?.setTag) {
      // Tags sind nur strings/numbers — kein Komplex-Scrubbing nötig.
      // Aber: Wert nach sensitiven Substrings filtern.
      const safeValue = typeof value === 'string'
        ? value.replace(_SENSITIVE_VALUE_RE, '[REDACTED]')
        : value;
      window.Sentry.setTag(key, safeValue);
    }
  } catch {}
}

// Export-only für Tests / Debug. Production code nutzt die obigen Helpers.
export const __testInternals = { _scrub, _scrubError };
