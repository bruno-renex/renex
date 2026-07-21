// ======================================================
// Org-Status des eigenen Kontos (eGov 1.1)
// ======================================================
// Verifizierte Orgs bekommen zwei zusätzliche UI-Einstiege zum Einladen:
//   (A) globales "Bürger einladen"-Icon im IconStrip-Bottom-Cluster
//   (B) Fehler-Brücke im AddContactModal (Handle-Suche ins Leere → Einladen)
// Beide fragen orgStore.isOrg. Probe einmalig pro Handle via eigenem Profil
// (/users/<handle>/profile liefert `org` = verifizierte-Org-Objekt|null).
// Kein neuer Endpoint, kein /invite/list-Payload für einen Boolean.
// ======================================================

import { apiFetch } from '../lib/api.js';
import { userStore } from './user.svelte.js';

let _org = $state(null);          // null = keine/ungeprüft, {handle,name,verificationMethod,verifiedAt}
let _probedHandle = $state(null); // für welchen Handle die Probe lief (Re-Probe bei User-Wechsel)
let _inflight = null;             // single-flight (nicht reaktiv)

export const orgStore = {
  get org()   { return _org; },
  get isOrg() { return !!_org; },

  /** Einmal-Probe pro Handle (single-flight). Gäste + Nicht-Orgs → isOrg bleibt false. */
  async ensureProbed() {
    const handle = (userStore.myUser || '').toLowerCase();
    if (!handle || userStore.isGuest) { _org = null; _probedHandle = handle; return; }
    if (_probedHandle === handle) return _inflight;   // schon geprüft
    if (_inflight) return _inflight;
    _inflight = (async () => {
      try {
        const r = await apiFetch(`/users/${handle}/profile`);
        _org = (r.ok && r.data && r.data.org) ? r.data.org : null;
      } catch {
        _org = null;
      } finally {
        _probedHandle = handle;
        _inflight = null;
      }
    })();
    return _inflight;
  },

  /** Beim Logout aufrufen — nächster ensureProbed() prüft frisch. */
  reset() { _org = null; _probedHandle = null; _inflight = null; },
};

// Zentraler Öffnungs-Trigger fürs Invite-Modal, cross-component.
// InboxList (immer im Nicht-Gast-Layout gemountet) hört darauf und ruft
// openInvite1to1(). So können IconStrip (A) + AddContactModal (B) das Modal
// öffnen, ohne den Modal-State zu teilen.
export function requestOpenInvite() {
  try { window.dispatchEvent(new CustomEvent('renex:open-invite')); } catch { /* SSR/Tests */ }
}
