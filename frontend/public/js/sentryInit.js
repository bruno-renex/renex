// ======================================================
// SENTRY INIT — Frontend Error-Tracking (lazy + optional)
// ======================================================
// Privacy-First-Setup:
//  - DSN kommt aus /sentry-config (Backend-Endpoint), nicht hardcoded
//  - Wenn keine DSN konfiguriert → silent no-op
//  - PII-Schutz: keine User-Eingaben, keine Message-Inhalte gesendet
//  - 100% Errors, 0% Performance (kein Bloat)
//  - Breadcrumbs filtern: keine sensiblen URLs (/chat/keys/, /e2e/, /push/)
//
// Lädt Sentry als UMD-Script (window.Sentry) — KEIN ES-Modul-Import,
// weil Sentry's CDN-Bundles UMD sind, nicht ES Modules.
// ======================================================

// ======================================================
// M2 Privacy-Scrubbing: vor jedem send durchsuchen Event-Payload
// nach sensitiven Identifier-Namen (Phrase, CMK, MasterKey, …) und
// Byte-Material. Defense-in-depth — sentry.js Wrapper macht erste
// Stufe schon, aber Sentry SDK fügt Stack-Frames + lokale Variablen
// erst HIER an, deshalb muss zweite Stufe in beforeSend sitzen.
// ======================================================
const _SENSITIVE_KEY_RE = /^(phrase|mnemonic|seed|cmk|cmkBytes|masterKey|masterKeyBytes|privateKey|priv|password|secret|sigKey|recoveryKey|deviceSecret|p256dh|jwk|d|x|y)$/i;
const _SENSITIVE_VALUE_RE = /\b(phrase|mnemonic|cmkBytes|masterKey(?:Bytes)?|privateKey|deviceSecret|recoveryKey)\b/gi;
const _MAX_DEPTH = 6;

function _scrubObj(value, depth) {
  depth = depth || 0;
  if (depth > _MAX_DEPTH) return "[REDACTED:depth]";
  if (value == null) return value;
  if (typeof value === "string") {
    _SENSITIVE_VALUE_RE.lastIndex = 0;
    return value.replace(_SENSITIVE_VALUE_RE, "[REDACTED]");
  }
  if (typeof value !== "object") return value;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer
      || (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(value))) {
    return "[REDACTED:bytes]";
  }
  if (Array.isArray(value)) {
    return value.map(v => _scrubObj(v, depth + 1));
  }
  const out = {};
  for (const k of Object.keys(value)) {
    if (_SENSITIVE_KEY_RE.test(k)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = _scrubObj(value[k], depth + 1);
    }
  }
  return out;
}

function _scrubSentryEvent(event) {
  if (!event) return event;
  // Exception-Werte (Message-Text)
  if (event.exception?.values) {
    for (const ev of event.exception.values) {
      if (typeof ev.value === "string") {
        _SENSITIVE_VALUE_RE.lastIndex = 0;
        ev.value = ev.value.replace(_SENSITIVE_VALUE_RE, "[REDACTED]");
      }
      // Stack-Frame Variablen (frame.vars) und Pre/Post-Context (Source-Code)
      if (ev.stacktrace?.frames) {
        for (const f of ev.stacktrace.frames) {
          if (f.vars) f.vars = _scrubObj(f.vars);
          if (typeof f.context_line === "string") {
            _SENSITIVE_VALUE_RE.lastIndex = 0;
            f.context_line = f.context_line.replace(_SENSITIVE_VALUE_RE, "[REDACTED]");
          }
        }
      }
    }
  }
  // Top-level message
  if (typeof event.message === "string") {
    _SENSITIVE_VALUE_RE.lastIndex = 0;
    event.message = event.message.replace(_SENSITIVE_VALUE_RE, "[REDACTED]");
  }
  // Extra context (passed via captureException second arg)
  if (event.extra) event.extra = _scrubObj(event.extra);
  if (event.contexts) event.contexts = _scrubObj(event.contexts);
  if (event.tags) event.tags = _scrubObj(event.tags);
  return event;
}

(async () => {
  // 1) DSN-Config holen
  let dsn = null;
  try {
    const r = await fetch("https://api.renex.id/sentry-config", { credentials: "omit" });
    if (r.ok) {
      const d = await r.json();
      dsn = d.dsn || null;
    }
  } catch {
    return; // Backend nicht erreichbar → silent skip
  }

  if (!dsn) return; // Kein Tracking aktiviert

  // 2) Sentry SDK lazy via Script-Tag laden (UMD)
  await new Promise((resolve, reject) => {
    if (window.Sentry) { resolve(); return; }
    const s = document.createElement("script");
    s.src = "https://browser.sentry-cdn.com/8.40.0/bundle.min.js";
    s.crossOrigin = "anonymous";
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Sentry CDN load failed"));
    document.head.appendChild(s);
  }).catch(() => null);

  if (!window.Sentry || typeof window.Sentry.init !== "function") {
    console.warn("📊 Sentry: SDK not loaded");
    return;
  }

  // 3) Sentry initialisieren
  try {
    window.Sentry.init({
      dsn,
      environment: "production",
      release: document.querySelector('meta[name="renex-version"]')?.content || "unknown",
      tracesSampleRate: 0,
      sampleRate: 1.0,
      ignoreErrors: [
        "ResizeObserver loop limit exceeded",
        "Non-Error promise rejection captured",
        "NetworkError",
        "AbortError",
      ],
      beforeSend(event) {
        // Strip URLs mit sensiblen Pfaden
        if (event.request?.url) {
          if (/\/chat\/keys\/|\/e2e\/|\/push\//.test(event.request.url)) {
            return null;
          }
        }
        if (event.request?.query_string) {
          delete event.request.query_string;
        }
        // M2 Privacy-Hardening: scrubbe Event-Payload nach Key-Material
        return _scrubSentryEvent(event);
      },
      beforeBreadcrumb(crumb) {
        if (crumb.category === "fetch" || crumb.category === "xhr") {
          if (crumb.data?.url && /\/chat\/keys\/|\/e2e\/|\/push\//.test(crumb.data.url)) {
            return null;
          }
        }
        // M2: Breadcrumb-Daten + Message scrubben
        if (crumb.data) crumb.data = _scrubObj(crumb.data);
        if (typeof crumb.message === "string") {
          crumb.message = crumb.message.replace(_SENSITIVE_VALUE_RE, "[REDACTED]");
        }
        return crumb;
      },
    });

    // Tags
    window.Sentry.setTag("pwa", window.matchMedia("(display-mode: standalone)").matches ? "yes" : "no");

    // User-ID (NUR Handle, keine PII)
    const handle = localStorage.getItem("my_user");
    if (handle) {
      window.Sentry.setUser({ id: handle });
    }

    // Globale Helper exposen
    window.__sentryHelpers = {
      captureException: window.Sentry.captureException.bind(window.Sentry),
      addBreadcrumb: window.Sentry.addBreadcrumb.bind(window.Sentry),
    };

    const v = document.querySelector('meta[name="renex-version"]')?.content || "unknown";
    console.log("📊 Sentry ready (release=" + v + ")");
  } catch (e) {
    console.warn("📊 Sentry init failed:", e.message);
  }
})();
