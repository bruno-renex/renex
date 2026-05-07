// ======================================================
// Inbox Store — Active section + lists (Reactive)
// ======================================================
// Verwaltet:
//   - activeSection: "chats" | "groups" | "voice"
//   - contacts: Liste der DM-Kontakte
//   - groups: Liste der Gruppen
//   - unreadCounts: Map<handle|groupId, count>
//   - searchQuery: aktueller Filter pro Sektion
//
// Datenquellen folgen später (Phase 1A.6 weitere Komponenten).
// ======================================================

import { get, set } from '../lib/storage.js';
import { apiFetch } from '../lib/api.js';
import { profileCache } from './profileCache.svelte.js';

const SECTIONS = ["chats", "groups", "voice"];

// Defensiv: Server-Daten dürfen niemals doppelte Keys liefern. Behalte den ersten Treffer.
function _dedupBy(arr, key) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = x?.[key];
    if (k == null || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

// Persistierter aktiver Tab (Reload-safe)
let _activeSection = $state(get("inbox_tab") || "chats");

let _contacts = $state([]);
let _pendingIn = $state([]);   // Eingehende Anfragen (jemand will mich adden)
let _pendingOut = $state([]);  // Ausgehende Anfragen (ich warte auf Antwort)
let _groups = $state([]);
let _unreadCounts = $state({});
let _isLoading = $state(false);
let _searchChats = $state("");
let _searchGroups = $state("");

export const inboxStore = {
  SECTIONS,

  get activeSection() { return _activeSection; },
  get contacts()    { return _contacts; },
  get pendingIn()   { return _pendingIn; },
  get pendingOut()  { return _pendingOut; },
  get pendingCount() { return _pendingIn.length + _pendingOut.length; },
  get groups() { return _groups; },
  get unreadCounts() { return _unreadCounts; },
  get isLoading() { return _isLoading; },
  get searchChats() { return _searchChats; },
  get searchGroups() { return _searchGroups; },

  setSection(name) {
    if (!SECTIONS.includes(name)) return;
    _activeSection = name;
    set("inbox_tab", name);
  },

  setSearchChats(q) { _searchChats = q || ""; },
  setSearchGroups(q) { _searchGroups = q || ""; },

  // Filter-Logik (Search anwenden)
  get filteredContacts() {
    if (!_searchChats) return _contacts;
    const q = _searchChats.toLowerCase();
    return _contacts.filter(c => {
      const handle = (c.handle || "").toLowerCase();
      // displayName aus profileCache ziehen (falls schon gefetcht) — sonst nur Handle-Match.
      const dn = (profileCache.get(c.handle) || "").toLowerCase();
      return handle.includes(q) || dn.includes(q);
    });
  },

  get filteredGroups() {
    if (!_searchGroups) return _groups;
    const q = _searchGroups.toLowerCase();
    return _groups.filter(g => (g.name || "").toLowerCase().includes(q));
  },

  unreadFor(key) {
    return _unreadCounts[key] || 0;
  },

  // Total Unread pro Section (für Badge auf IconStrip)
  get totalUnreadDms() {
    return _contacts.reduce((sum, c) => sum + (this.unreadFor(c.handle) || 0), 0);
  },

  get totalUnreadGroups() {
    return _groups.reduce((sum, g) => sum + (this.unreadFor(g.id) || 0), 0);
  },

  // ── DATA-LOADERS ────────────────────────────────
  async loadContacts() {
    _isLoading = true;
    try {
      const r = await apiFetch("/contacts/list");
      if (r.ok && Array.isArray(r.data?.contacts)) {
        const accepted = [];
        const pendingIn = [];
        const pendingOut = [];
        // Backend liefert display_name jetzt direkt mit (ab 2026-05) → Cache primen
        // statt N parallele /users/<h>/profile-Requests beim App-Boot.
        // Fallback: wenn display_name fehlt (alter Backend-Stand) → prefetch über Profile-Endpoint.
        const handlesNeedingFetch = [];
        for (const c of r.data.contacts) {
          const item = {
            handle: c.handle,
            displayName: c.display_name ?? null,
            status: c.status,
            lastSeen: c.last_ts || null,
            direction: c.direction,
          };
          // Cache primen — wenn Backend display_name liefert, sparen wir den Round-Trip.
          if (c.display_name !== undefined) {
            profileCache.set(c.handle, c.display_name);
          } else {
            handlesNeedingFetch.push(c.handle);
          }
          if (c.status === "accepted") accepted.push(item);
          else if (c.status === "pending" && c.direction === "in") pendingIn.push(item);
          else if (c.status === "pending" && c.direction === "out") pendingOut.push(item);
        }
        _contacts = _dedupBy(accepted, "handle");
        _pendingIn = _dedupBy(pendingIn, "handle");
        _pendingOut = _dedupBy(pendingOut, "handle");

        // Fallback-Prefetch nur für Handles wo Backend kein display_name geliefert hat.
        if (handlesNeedingFetch.length > 0) {
          profileCache.prefetch(handlesNeedingFetch);
        }
      }
    } finally {
      _isLoading = false;
    }
  },

  /** Accept/Reject/Cancel pending requests */
  async acceptRequest(handle) {
    const r = await apiFetch("/contacts/accept", { method: "POST", body: { contact: handle } });
    if (r.ok) await this.loadContacts();
    return r.ok;
  },
  async rejectRequest(handle) {
    const r = await apiFetch("/contacts/reject", { method: "POST", body: { contact: handle } });
    if (r.ok) await this.loadContacts();
    return r.ok;
  },
  async cancelRequest(handle) {
    const r = await apiFetch("/contacts/cancel", { method: "POST", body: { contact: handle } });
    if (r.ok) await this.loadContacts();
    return r.ok;
  },

  /**
   * Entfernt einen akzeptierten Kontakt (beidseitig, Backend setzt status='removed').
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async removeContact(handle) {
    if (!handle) return { ok: false, error: 'no_handle' };
    const r = await apiFetch("/contacts/remove", { method: "POST", body: { contact: handle } });
    if (r.ok) {
      // Optimistisch lokal entfernen — refresh holt sich alles re-konsistent
      _contacts = _contacts.filter(c => c.handle !== handle);
      await this.loadContacts();
      return { ok: true };
    }
    return { ok: false, error: r.error || 'remove_failed' };
  },

  async loadGroups() {
    _isLoading = true;
    try {
      const r = await apiFetch("/groups/list");
      if (r.ok && Array.isArray(r.data?.groups)) {
        _groups = _dedupBy(
          r.data.groups.map(g => ({
            id: g.id,
            name: g.name || "Unnamed",
            memberCount: g.member_count || 0,
          })),
          "id"
        );
      }
    } finally {
      _isLoading = false;
    }
  },

  async loadUnread() {
    const r = await apiFetch("/chat/unread");
    if (r.ok && r.data?.unread) {
      _unreadCounts = r.data.unread;
    }
  },

  // ── DEV/TEST HELPERS ────────────────────────────
  // Setzt Mock-Daten für Visual-Tests (NICHT in Production verwenden)
  _setMockData({ contacts, groups, unread } = {}) {
    if (contacts) _contacts = contacts;
    if (groups) _groups = groups;
    if (unread) _unreadCounts = unread;
  },
};
