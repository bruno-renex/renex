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
        for (const c of r.data.contacts) {
          const item = {
            handle: c.handle,
            displayName: null,
            status: c.status,
            lastSeen: c.last_ts || null,
            direction: c.direction,
          };
          if (c.status === "accepted") accepted.push(item);
          else if (c.status === "pending" && c.direction === "in") pendingIn.push(item);
          else if (c.status === "pending" && c.direction === "out") pendingOut.push(item);
        }
        _contacts = accepted;
        _pendingIn = pendingIn;
        _pendingOut = pendingOut;

        // Display-Names für alle Kontakte (accepted + pending) im Hintergrund laden.
        // Reaktiv: sobald ein DN ankommt, re-rendert die Liste automatisch via profileCache.
        const allHandles = [
          ...accepted.map(x => x.handle),
          ...pendingIn.map(x => x.handle),
          ...pendingOut.map(x => x.handle),
        ];
        profileCache.prefetch(allHandles);
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

  async loadGroups() {
    _isLoading = true;
    try {
      const r = await apiFetch("/groups/list");
      if (r.ok && Array.isArray(r.data?.groups)) {
        _groups = r.data.groups.map(g => ({
          id: g.id,
          name: g.name || "Unnamed",
          memberCount: g.member_count || 0,
        }));
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
