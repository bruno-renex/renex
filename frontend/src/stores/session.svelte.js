// ======================================================
// Session Store — Reactive Auth-State (Svelte 5 Runes)
// ======================================================
// Lifecycle:
//   IDLE        → noch nicht geprüft
//   CHECKING    → /auth/session call läuft
//   AUTHED      → eingeloggt
//   GUEST       → Gast-Session (begrenzt)
//   ANONYMOUS   → nicht eingeloggt
//
// Sync mit userStore: bei AUTHED/GUEST wird myUser gesetzt.
// ======================================================

import { apiFetch } from '../lib/api.js';
import { userStore } from './user.svelte.js';
import { pulseStore } from './pulseStore.svelte.js';
import { captureException } from '../lib/sentry.js';

const STATES = {
  IDLE: "idle",
  CHECKING: "checking",
  AUTHED: "authed",
  GUEST: "guest",
  ANONYMOUS: "anonymous",
};

let _state = $state(STATES.IDLE);
let _lastCheckAt = $state(0);
let _lastError = $state(null);

export const sessionStore = {
  STATES,

  get state() { return _state; },
  get isAuthed() { return _state === STATES.AUTHED; },
  get isGuest() { return _state === STATES.GUEST; },
  get isAnonymous() { return _state === STATES.ANONYMOUS; },
  get isLoading() { return _state === STATES.CHECKING || _state === STATES.IDLE; },
  get lastCheckAt() { return _lastCheckAt; },
  get lastError() { return _lastError; },

  /**
   * Prüft die Session beim Backend.
   * - 200 + valid:true  → AUTHED, setzt myUser
   * - 200 + valid:false → ANONYMOUS, clearUser
   * - 401              → ANONYMOUS, clearUser
   * - Network-Error    → behält bestehenden State, setzt lastError
   */
  async check() {
    // Race-Schutz: laufenden Check nicht doppelt anstoßen.
    // 5s Toleranz für hängende Network-Requests.
    if (_state === STATES.CHECKING && Date.now() - _lastCheckAt < 5000) {
      return;
    }
    _state = STATES.CHECKING;
    _lastError = null;
    _lastCheckAt = Date.now();

    const r = await apiFetch("/auth/session");

    if (r.error === "network_error") {
      _lastError = r.message;
      // Bei Network-Error: nicht automatisch ausloggen
      _state = userStore.isLoggedIn() ? STATES.AUTHED : STATES.ANONYMOUS;
      return;
    }

    if (r.status === 401 || (r.ok && r.data?.valid === false)) {
      _state = STATES.ANONYMOUS;
      userStore.clear();
      return;
    }

    if (r.ok && r.data?.valid === true && r.data.handle) {
      userStore.setUser(r.data.handle);
      _state = userStore.isGuest ? STATES.GUEST : STATES.AUTHED;
      return;
    }

    // Unerwartet → Error capture aber nicht ausloggen
    captureException(new Error("session_check_unexpected"), { response: r });
    _state = userStore.isLoggedIn() ? STATES.AUTHED : STATES.ANONYMOUS;
  },

  async logout() {
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch { /* logout darf nicht fehlschlagen */ }
    userStore.clear();
    pulseStore.wipe();  // Pulse-Opt-in-Flags + RAM löschen (Privacy, PULSE.md §8.1)
    _state = STATES.ANONYMOUS;
    // Harter, vollständiger State-Wipe: alle Per-Account-Stores leben im
    // Modul-Scope und überleben sonst Logout→Login (Cross-Account-Leak, z.B.
    // is_owner/Server-Liste/Kontakte des Vor-Accounts kurz sichtbar). Reload
    // wischt strukturell ALLEN RAM-State — IndexedDB (CMKs/Passkey) bleibt
    // absichtlich, damit Re-Login ohne Recovery-Phrase funktioniert.
    window.location.reload();
  },
};
