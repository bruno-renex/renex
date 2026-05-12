// ======================================================
// API Client — fetch-Wrapper mit zentraler Error-Behandlung
// ======================================================
// Alle Backend-Calls gehen durch apiFetch().
// Features:
//   - Auto-Credentials (Cookies)
//   - Auto-Content-Type für JSON
//   - 401-Handler (Session abgelaufen → Redirect zu Login)
//   - Sentry-Integration für unerwartete Errors
//   - Graceful: returnt {ok: false, ...} statt throws bei klaren API-Fehlern
// ======================================================

import { captureException } from './sentry.js';

const API = "https://api.renex.id";

/**
 * Liest den Guest-Token aus localStorage (gespeichert von /join/lib/guestStorage.js).
 * Wird als X-Guest-Token Header an Backend geschickt — Safari-ITP-Fallback
 * wenn der `guest_session` Cookie cross-origin (app.renex.id ↔ api.renex.id)
 * geblockt wird oder verloren geht. Das Backend liest beide Quellen
 * (Cookie + Header) — Header gewinnt wenn beide vorhanden.
 */
function _readGuestToken() {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem("guestSession");
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data?.token) return null;
    if (data.expiresAt && Date.now() > data.expiresAt) return null;
    return String(data.token);
  } catch { return null; }
}

/**
 * Hauptfunktion für API-Calls.
 * @param {string} path  - z.B. "/auth/session"
 * @param {object} options - { method, body, headers }
 * @returns {Promise<{ok, status, data, error}>}
 */
export async function apiFetch(path, options = {}) {
  const { method = "GET", body, headers = {}, signal } = options;

  // Binary bodies (Uint8Array, ArrayBuffer, Blob) durchreichen ohne JSON-Stringify
  const isBinaryBody = body instanceof Uint8Array
                    || body instanceof ArrayBuffer
                    || (typeof Blob !== "undefined" && body instanceof Blob);

  // Guest-Token als Header setzen, wenn Gast-Session existiert.
  // Caller-Headers haben Vorrang (falls explizit überschrieben werden soll).
  const guestToken = _readGuestToken();

  const init = {
    method,
    credentials: "include",
    headers: {
      ...(body && method !== "GET" && !isBinaryBody ? { "Content-Type": "application/json" } : {}),
      ...(guestToken ? { "X-Guest-Token": guestToken } : {}),
      ...headers,
    },
    signal,
  };

  if (body !== undefined && method !== "GET") {
    if (isBinaryBody) {
      init.body = body;
    } else {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
  }

  let res;
  try {
    res = await fetch(API + path, init);
  } catch (e) {
    // Network-Error — kein Sentry-Capture (zu viele false positives bei Mobile)
    return { ok: false, status: 0, data: null, error: "network_error", message: e.message };
  }

  let data = null;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON Response (zB HTML-Error-Page)
    data = null;
  }

  if (res.status === 401) {
    // Session expired — Caller entscheidet wie damit umgehen
    return { ok: false, status: 401, data, error: "unauthorized" };
  }

  if (!res.ok) {
    // 4xx/5xx — Backend-Error, KEIN Sentry-Capture (würde Bot-Errors etc. spammen)
    return { ok: false, status: res.status, data, error: data?.error || "api_error" };
  }

  return { ok: true, status: res.status, data, error: null };
}

/**
 * Convenience: Fetch + Throw-on-Error (für simple Use-Cases)
 */
export async function apiGet(path, options = {}) {
  const r = await apiFetch(path, { ...options, method: "GET" });
  if (!r.ok) {
    const e = new Error(r.error || "api_error");
    e.status = r.status;
    e.data = r.data;
    throw e;
  }
  return r.data;
}

export async function apiPost(path, body, options = {}) {
  const r = await apiFetch(path, { ...options, method: "POST", body });
  if (!r.ok) {
    const e = new Error(r.error || "api_error");
    e.status = r.status;
    e.data = r.data;
    throw e;
  }
  return r.data;
}

export { API };
