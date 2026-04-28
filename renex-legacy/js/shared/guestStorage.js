// ======================================================
// GUEST STORAGE — persistente Gast-Session
// ======================================================
// Früher in sessionStorage (verschwand bei Tab-Close).
// Jetzt localStorage → Gast kann Tab schliessen und wiederkommen
// solange die serverseitige Session-TTL (24h) nicht abgelaufen ist.
// ======================================================

const SESSION_KEY    = "guestSession";
const PRIV_JWK_KEY   = "guest_e2e_priv_jwk";
const DEVICE_ID_KEY  = "guest_device_id";

// ── Einmalige Migration alter Daten aus sessionStorage ────
// Bestehende Gäste mit noch offenen Tabs bekommen ihre Session
// automatisch nach localStorage übertragen.
function migrateOnce() {
  try {
    if (!localStorage.getItem(SESSION_KEY) && sessionStorage.getItem(SESSION_KEY)) {
      localStorage.setItem(SESSION_KEY, sessionStorage.getItem(SESSION_KEY));
    }
    if (!localStorage.getItem(PRIV_JWK_KEY) && sessionStorage.getItem(PRIV_JWK_KEY)) {
      localStorage.setItem(PRIV_JWK_KEY, sessionStorage.getItem(PRIV_JWK_KEY));
    }
    if (!localStorage.getItem(DEVICE_ID_KEY) && sessionStorage.getItem(DEVICE_ID_KEY)) {
      localStorage.setItem(DEVICE_ID_KEY, sessionStorage.getItem(DEVICE_ID_KEY));
    }
  } catch {}
}
migrateOnce();

// ── Get: gibt parsed Guest-Session zurück, oder null ──────
// Prüft automatisch auf Ablauf (expiresAt < now → Cleanup + null).
export function getGuestSession() {
  try {
    // Auch sessionStorage prüfen als Lese-Fallback (für parallel offene Tabs)
    const raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data) return null;
    // Ablauf-Check: serverseitige Session ist max. 24h gültig
    if (data.expiresAt && Date.now() > data.expiresAt) {
      clearGuestSession();
      return null;
    }
    return data;
  } catch { return null; }
}

// ── Raw Accessor (für Code der nur den Token braucht) ─────
export function getGuestSessionRaw() {
  try {
    return localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY) || null;
  } catch { return null; }
}

// ── Has: schneller Boolean-Check ohne Parsing ────────────
export function hasGuestSession() {
  try {
    return !!(localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY));
  } catch { return false; }
}

// ── Set: Session + optional E2E-Key + Device-ID persistieren ──
export function setGuestSession(sessionObj, { privJwk = null, deviceId = null } = {}) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(sessionObj));
    if (privJwk !== null) localStorage.setItem(PRIV_JWK_KEY, typeof privJwk === "string" ? privJwk : JSON.stringify(privJwk));
    if (deviceId !== null) localStorage.setItem(DEVICE_ID_KEY, deviceId);
  } catch {}
}

// ── E2E-Key / Device-ID einzeln ──────────────────────────
export function getGuestPrivJwk() {
  return localStorage.getItem(PRIV_JWK_KEY) || sessionStorage.getItem(PRIV_JWK_KEY) || null;
}
export function getGuestDeviceId() {
  return localStorage.getItem(DEVICE_ID_KEY) || sessionStorage.getItem(DEVICE_ID_KEY) || null;
}

// ── Clear: räumt alle Gast-Keys auf (bei Logout, Ablauf, Konvertierung) ──
export function clearGuestSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(PRIV_JWK_KEY);
    localStorage.removeItem(DEVICE_ID_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(PRIV_JWK_KEY);
    sessionStorage.removeItem(DEVICE_ID_KEY);
  } catch {}
}
