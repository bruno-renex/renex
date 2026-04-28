// ======================================================
// User Store — Reactive User-State (Svelte 5 Runes)
// ======================================================
// Source of truth für:
//   - myUser (Handle, z.B. "bertha004")
//   - displayName (optional, vom Backend)
//   - deviceId (UUID, lokal generiert)
//   - isGuest (Gast-Session-Flag)
//
// Persistiert in localStorage. Jede Änderung wird sofort gespeichert.
// ======================================================

import { get, set, remove } from '../lib/storage.js';
import { setUser as sentrySetUser } from '../lib/sentry.js';

// Reactive State
let _myUser = $state(get("my_user") || null);
let _displayName = $state(get("display_name") || null);
let _deviceId = $state(get("device_id") || _generateDeviceId());
let _isGuest = $state((get("my_user") || "").startsWith("guest_"));

function _generateDeviceId() {
  // Generiert einmal pro Browser-Install eine UUID, persistiert
  const existing = get("device_id");
  if (existing) return existing;
  const id = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : "dev-" + Math.random().toString(36).slice(2, 18);
  set("device_id", id);
  return id;
}

// Public API — Getters via Effects, kein Spread
export const userStore = {
  get myUser()      { return _myUser; },
  get displayName() { return _displayName; },
  get deviceId()    { return _deviceId; },
  get isGuest()     { return _isGuest; },

  setUser(handle) {
    const h = handle ? String(handle).toLowerCase() : null;
    _myUser = h;
    _isGuest = !!h && h.startsWith("guest_");
    set("my_user", h);
    sentrySetUser(h ? { id: h } : null);
  },

  setDisplayName(name) {
    _displayName = name || null;
    set("display_name", name || null);
  },

  clear() {
    _myUser = null;
    _displayName = null;
    _isGuest = false;
    remove("my_user");
    remove("display_name");
    sentrySetUser(null);
    // Note: deviceId bleibt — pro Browser-Install eindeutig, kein Reset bei Logout
  },

  isLoggedIn() {
    return !!_myUser;
  },

  isRegisteredUser() {
    return !!_myUser && !_isGuest;
  },
};
