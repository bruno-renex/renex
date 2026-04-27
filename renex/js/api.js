// ======================================================
// 🔇 PRODUCTION LOG SUPPRESSION
// console.log wird in Production deaktiviert.
// console.warn + console.error bleiben sichtbar.
// ======================================================
if (globalThis.location?.hostname === "app.renex.id") {
  console.log = () => {};
}

import { getGuestSession, hasGuestSession } from "./shared/guestStorage.js";

// Gast-Token aus Storage (gesetzt von /join/) — jetzt persistent via localStorage.
// Wird als X-Guest-Token Header mitgeschickt wenn kein regulärer Cookie vorhanden
// (Safari/ITP blockiert Cross-Origin Set-Cookie von api.renex.id).
function getGuestTokenFromStorage() {
  return getGuestSession()?.token || null;
}

// Global backoff state: verhindert Request-Flood bei 429/Network-Error
let _globalBackoffUntil = 0;

export async function apiFetch(path, options = {}) {
  // Global Backoff: wenn kürzlich 429/Network-Error → sofort rateLimited zurückgeben
  const now = Date.now();
  if (now < _globalBackoffUntil) {
    return { rateLimited: true, error: "Backoff active", retryAfterMs: _globalBackoffUntil - now };
  }

  const guestToken = getGuestTokenFromStorage();
  const method = (options.method || "GET").toUpperCase();

  // Content-Type setzen wenn ein Body vorhanden ist (unabhängig von Methode).
  // DELETE kann ebenfalls einen JSON-Body haben (z.B. /chat/message/delete),
  // ohne Content-Type würde das Backend "Invalid JSON" zurückgeben.
  // Bei GET/HEAD gibt es per Definition keinen Body → kein Content-Type → kein Preflight.
  const needsContentType = !!options.body && method !== "GET" && method !== "HEAD";

  let res;
  try {
    res = await fetch("https://api.renex.id" + path, {
      ...options,
      credentials: "include",
      headers: {
        ...(needsContentType ? { "Content-Type": "application/json" } : {}),
        ...(guestToken ? { "X-Guest-Token": guestToken } : {}),
        ...(options.headers || {}),
      }
    });
  } catch (networkError) {
    // Network Error / CORS-Block bei Preflight 429 → Global Backoff 10s
    console.warn("⚠️ Network error (evtl. Rate-Limit):", path, networkError.message);
    _globalBackoffUntil = Date.now() + 10_000;
    return { rateLimited: true, error: "Network error", retryAfterMs: 10000 };
  }

  if (res.status === 401) {
    // Gäste haben keine echte Session — kein Redirect, nur Error werfen
    const isGuest = hasGuestSession();
    if (!isGuest) {
      localStorage.removeItem("my_user");
      const onLoginPage = window.location.pathname === "/" || window.location.pathname.endsWith("index.html");
      if (!onLoginPage) {
        console.warn("🔒 Session expired — redirecting to login");
        window.location.replace("/index.html");
      }
    }
    throw new Error("Session expired");
  }

  if (res.status === 429) {
    const data = await res.json().catch(() => ({}));
    // Gast-Nachrichtenlimit ist PERMANENT — kein Backoff, kein Retry.
    // Muss als eigener Flag zurückkommen, damit der Caller die UI sperren kann.
    if (data?.error === "Message limit reached") {
      return {
        guestLimitReached: true,
        msgCount: data.msgCount,
        msgLimit: data.msgLimit,
        convertUrl: data.convertUrl || null,
      };
    }
    // Global Backoff 10s — stoppt ALLE parallelen Requests
    _globalBackoffUntil = Date.now() + (data.retryAfterMs || 10_000);
    return {
      rateLimited: true,
      status: data.status || null,
      error: data.error || "Too many requests",
      retryAfterMs: data.retryAfterMs || 10000
    };
  }

  // 410 Gone = Gast-Session abgelaufen (oder bereits konvertiert)
  if (res.status === 410) {
    const data = await res.json().catch(() => ({}));
    return {
      guestExpired: true,
      error: data.error || "Session expired",
    };
  }

  if (!res.ok) {
    let msg = res.statusText;
    try {
      const data = await res.json();
      msg = data.error || msg;
    } catch {}
    throw new Error(`API ${res.status}: ${msg}`);
  }

  const text = await res.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    console.warn("⚠️ Invalid JSON from server");
    return {};
  }
}
