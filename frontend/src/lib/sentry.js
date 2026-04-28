// ======================================================
// Sentry-Wrapper — Safe-Calls für Frontend
// ======================================================
// Nutzt window.Sentry wenn verfügbar (lazy-loaded via sentryInit.js).
// Wenn Sentry nicht da: silent no-op.
// ======================================================

export function captureException(err, context = {}) {
  try {
    if (window.Sentry?.captureException) {
      window.Sentry.captureException(err, {
        extra: context,
      });
    }
  } catch { /* never throw from logging */ }
}

export function addBreadcrumb(crumb) {
  try {
    if (window.Sentry?.addBreadcrumb) {
      window.Sentry.addBreadcrumb(crumb);
    }
  } catch {}
}

export function setUser(user) {
  try {
    if (window.Sentry?.setUser) {
      window.Sentry.setUser(user);
    }
  } catch {}
}

export function setTag(key, value) {
  try {
    if (window.Sentry?.setTag) {
      window.Sentry.setTag(key, value);
    }
  } catch {}
}
