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
import { profileCache } from './profileCache.svelte.js';

// Reactive State
let _myUser = $state(get("my_user") || null);
let _displayName = $state(get("display_name") || null);
let _isGuest = $state((get("my_user") || "").startsWith("guest_"));

/**
 * deviceId ist per-User-skoped (Storage-Key `device_id:<handle>`).
 * Generiert lazy beim ersten Zugriff für den aktuellen User.
 * Mehrere User auf dem gleichen Browser bekommen je ihre eigene stabile ID.
 */
function _currentDeviceId() {
  const h = (_myUser || "").toLowerCase();
  const key = h ? `device_id:${h}` : "device_id";  // Pre-Login: Legacy-Key
  let id = get(key);
  if (!id) {
    id = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : "dev-" + Math.random().toString(36).slice(2, 18);
    set(key, id);
  }
  return id;
}

// Public API — Getters via Effects, kein Spread
export const userStore = {
  get myUser()      { return _myUser; },
  get displayName() { return _displayName; },
  // Reaktiv: wenn _myUser sich ändert, gibt der Getter den neuen User-spezifischen
  // deviceId zurück (oder generiert ihn lazy)
  get deviceId()    { return _currentDeviceId(); },
  get isGuest()     { return _isGuest; },

  setUser(handle) {
    const h = handle ? String(handle).toLowerCase() : null;
    _myUser = h;
    _isGuest = !!h && h.startsWith("guest_");
    set("my_user", h);
    sentrySetUser(h ? { id: h } : null);
    // Eigenen DN im profileCache vor-priming, damit eigene Bubbles + Group-Sender-Labels
    // sofort den Namen zeigen statt @handle bis Lazy-Fetch zurückkommt.
    if (h) profileCache.set(h, _displayName);
  },

  setDisplayName(name) {
    _displayName = name || null;
    set("display_name", name || null);
    if (_myUser) profileCache.set(_myUser, _displayName);
  },

  clear() {
    _myUser = null;
    _displayName = null;
    _isGuest = false;
    remove("my_user");
    remove("display_name");
    sentrySetUser(null);
    // Logout: anderer User auf demselben Browser bekäme sonst stale Profile.
    profileCache.clear();
    // Note: device_id:<handle>-Einträge bleiben — pro User stabil, damit
    // re-login desselben Users denselben deviceId behält. Nur user-handle wird
    // gecleart, nicht die per-user deviceIds.
  },

  isLoggedIn() {
    return !!_myUser;
  },

  isRegisteredUser() {
    return !!_myUser && !_isGuest;
  },
};
