// ======================================================
// Passkey Lib — WebAuthn Login + Register
// ======================================================
// Wrapper um die /auth/* Endpoints + WebAuthn-API.
// Mirror der existierenden /renex/js/auth.js Logik aber clean re-implementiert.
//
// Public API:
//   loginWithPasskey(handle)   → meldet User an, registriert wenn neu
//   addPasskey(handle, name)   → fügt Passkey zu existierendem Account
//   logout()                   → beendet Session
//
// Wirft Error bei harten Fehlern. Caller muss try/catch verwenden.
// ======================================================

import { API, apiFetch } from './api.js';
import { captureException } from './sentry.js';

const ACCEPTED_TERMS_VERSION = "2026-04-15";

// ── Base64URL Helpers ────────────────────────────────
function base64urlToUint8Array(b64) {
  const padding = "=".repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function arrayBufferToBase64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Handle Validation ────────────────────────────────
const HANDLE_REGEX = /^[a-z0-9_]+$/;
export function validateHandle(handle) {
  if (typeof handle !== "string") return { ok: false, error: "type" };
  const h = handle.toLowerCase().trim();
  if (h.length < 3) return { ok: false, error: "too_short" };
  if (h.length > 32) return { ok: false, error: "too_long" };
  if (!HANDLE_REGEX.test(h)) return { ok: false, error: "invalid_chars" };
  return { ok: true, value: h };
}

// ── Login Flow ────────────────────────────────────────
/**
 * Versucht Login. Wenn User nicht existiert, startet Register-Flow
 * (UI muss Consent-Checkbox vorher sicherstellen).
 *
 * @param {string} handle
 * @param {object} options
 *   - termsAccepted: boolean (muss true sein für Neuregistrierung)
 * @returns {Promise<{ status: "logged_in" | "registered", handle }>}
 */
export async function loginWithPasskey(handle, { termsAccepted = false, cfTurnstileToken = null } = {}) {
  const v = validateHandle(handle);
  if (!v.ok) throw new Error("invalid_handle:" + v.error);
  const h = v.value;

  // 1) login/start
  const startRes = await fetch(`${API}/auth/login/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: h }),
  });
  const startData = await startRes.json().catch(() => ({}));

  // 2a) User existiert NICHT → Registrierung
  if (startData.registered === false) {
    if (!termsAccepted) {
      throw new Error("terms_required");
    }
    if (!cfTurnstileToken) {
      throw new Error("captcha_required");
    }
    return await _register(h, cfTurnstileToken);
  }

  // 2b) User existiert → Login
  if (!startData.publicKey) {
    throw new Error("login_start_failed");
  }
  return await _login(h, startData.publicKey);
}

async function _login(handle, pkOptions) {
  const publicKey = {
    ...pkOptions,
    challenge: base64urlToUint8Array(pkOptions.challenge),
    allowCredentials: (pkOptions.allowCredentials || []).map(c => ({
      ...c,
      id: base64urlToUint8Array(c.id),
    })),
  };

  let credential;
  try {
    credential = await navigator.credentials.get({ publicKey });
  } catch (e) {
    if (e.name === "NotAllowedError") throw new Error("user_cancelled");
    throw new Error("webauthn_failed:" + e.message);
  }

  const finishRes = await fetch(`${API}/auth/login/finish`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      handle,
      id: credential.id,
      rawId: arrayBufferToBase64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: arrayBufferToBase64url(credential.response.clientDataJSON),
        authenticatorData: arrayBufferToBase64url(credential.response.authenticatorData),
        signature: arrayBufferToBase64url(credential.response.signature),
        userHandle: credential.response.userHandle
          ? arrayBufferToBase64url(credential.response.userHandle)
          : null,
      },
    }),
  });

  const finishData = await finishRes.json().catch(() => ({}));
  if (!finishRes.ok || finishData.error) {
    throw new Error("login_finish_failed:" + (finishData.error || finishRes.status));
  }
  return { status: "logged_in", handle };
}

async function _register(handle, cfTurnstileToken) {
  // 1) register/start (mit Turnstile-Token für Anti-Bot)
  const startRes = await fetch(`${API}/auth/register/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle, cfTurnstileToken }),
  });
  const startData = await startRes.json().catch(() => ({}));
  if (!startData.publicKey) {
    // Captcha-Errors als typed-error damit UI sauber message zeigen kann
    if (startData.code === 'captcha_required' || startData.code === 'captcha_failed') {
      throw new Error(startData.code);
    }
    throw new Error("register_start_failed");
  }

  const publicKey = {
    ...startData.publicKey,
    challenge: base64urlToUint8Array(startData.publicKey.challenge),
    user: {
      ...startData.publicKey.user,
      id: base64urlToUint8Array(startData.publicKey.user.id),
    },
    excludeCredentials: (startData.publicKey.excludeCredentials || []).map(c => ({
      ...c,
      id: base64urlToUint8Array(c.id),
    })),
  };

  let credential;
  try {
    credential = await navigator.credentials.create({ publicKey });
  } catch (e) {
    if (e.name === "NotAllowedError") throw new Error("user_cancelled");
    throw new Error("webauthn_failed:" + e.message);
  }

  // 2) register/finish (mit Terms-Version)
  const finishRes = await fetch(`${API}/auth/register/finish`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      handle,
      id: credential.id,
      rawId: arrayBufferToBase64url(credential.rawId),
      type: credential.type,
      termsVersion: ACCEPTED_TERMS_VERSION,
      response: {
        attestationObject: arrayBufferToBase64url(credential.response.attestationObject),
        clientDataJSON: arrayBufferToBase64url(credential.response.clientDataJSON),
      },
    }),
  });

  const finishData = await finishRes.json().catch(() => ({}));
  if (!finishRes.ok || finishData.error) {
    throw new Error("register_finish_failed:" + (finishData.error || finishRes.status));
  }
  return { status: "registered", handle };
}

// ── Add Passkey (eingeloggter User fügt zweiten Passkey hinzu) ──
export async function addPasskey(handle, name = null) {
  const v = validateHandle(handle);
  if (!v.ok) throw new Error("invalid_handle:" + v.error);
  const h = v.value;

  const startRes = await fetch(`${API}/auth/register/start`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: h }),
  });
  const startData = await startRes.json().catch(() => ({}));
  if (!startData.publicKey) throw new Error("register_start_failed");

  const publicKey = {
    ...startData.publicKey,
    challenge: base64urlToUint8Array(startData.publicKey.challenge),
    user: {
      ...startData.publicKey.user,
      id: base64urlToUint8Array(startData.publicKey.user.id),
    },
    authenticatorSelection: {
      userVerification: "required",
      residentKey: "preferred",
    },
    excludeCredentials: (startData.publicKey.excludeCredentials || []).map(c => ({
      ...c,
      id: base64urlToUint8Array(c.id),
    })),
    timeout: 60000,
    attestation: "none",
  };

  let credential;
  try {
    credential = await navigator.credentials.create({ publicKey });
  } catch (e) {
    if (e.name === "NotAllowedError") throw new Error("user_cancelled");
    throw new Error("webauthn_failed:" + e.message);
  }

  const finishRes = await fetch(`${API}/auth/register/finish`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      handle: h,
      id: credential.id,
      rawId: arrayBufferToBase64url(credential.rawId),
      type: credential.type,
      name: name || null,
      response: {
        attestationObject: arrayBufferToBase64url(credential.response.attestationObject),
        clientDataJSON: arrayBufferToBase64url(credential.response.clientDataJSON),
      },
    }),
  });

  const finishData = await finishRes.json().catch(() => ({}));
  if (!finishRes.ok || finishData.error) {
    throw new Error("addPasskey_failed:" + (finishData.error || finishRes.status));
  }
  return { ok: true };
}

// ── Logout ────────────────────────────────────────────
export async function logout() {
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } catch (e) {
    captureException(e, { context: "logout" });
  }
}
