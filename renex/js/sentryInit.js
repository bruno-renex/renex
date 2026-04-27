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
        return event;
      },
      beforeBreadcrumb(crumb) {
        if (crumb.category === "fetch" || crumb.category === "xhr") {
          if (crumb.data?.url && /\/chat\/keys\/|\/e2e\/|\/push\//.test(crumb.data.url)) {
            return null;
          }
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
