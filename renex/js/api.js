// ======================================================
// 🔇 PRODUCTION LOG SUPPRESSION
// console.log wird in Production deaktiviert.
// console.warn + console.error bleiben sichtbar.
// ======================================================
if (globalThis.location?.hostname === "app.renex.id") {
  console.log = () => {};
}

// Gast-Token aus sessionStorage (gesetzt von /join/)
// Wird als X-Guest-Token Header mitgeschickt wenn kein regulärer Cookie vorhanden
// (Safari/ITP blockiert Cross-Origin Set-Cookie von api.renex.id)
function getGuestTokenFromStorage() {
  try {
    const raw = sessionStorage.getItem("guestSession");
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data?.token || null;
  } catch { return null; }
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

  // Content-Type nur bei Requests mit Body setzen (POST, PUT, PATCH).
  // Bei GET-Requests ist Content-Type semantisch falsch (kein Body) und
  // erzwingt einen CORS-Preflight mit zwei Custom-Headern, was zu
  // Preflight-Cache-Problemen in Safari/Chrome führen kann.
  const needsContentType = method !== "GET" && method !== "HEAD" && method !== "DELETE";

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
    const isGuest = !!sessionStorage.getItem("guestSession");
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
    // Global Backoff 10s — stoppt ALLE parallelen Requests
    _globalBackoffUntil = Date.now() + (data.retryAfterMs || 10_000);
    return {
      rateLimited: true,
      status: data.status || null,
      error: data.error || "Too many requests",
      retryAfterMs: data.retryAfterMs || 10000
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
