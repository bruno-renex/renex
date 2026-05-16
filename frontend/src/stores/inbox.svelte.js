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

const SECTIONS = ["chats", "groups", "voice", "servers"];

// Sortiert eine Liste {lastSeen?:number, ...} stabil nach lastSeen DESC.
// Items ohne lastSeen (Kontakte ohne Chat-Historie) landen unten.
// Tie-Breaker: Insert-Reihenfolge (stabil seit ES2019).
function _byLastSeenDesc(arr) {
  return [...arr].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

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

  // Filter-Logik (Search anwenden) + Sort nach letzter Aktivität (DESC).
  // Backend liefert beim initialen Load schon sortiert (ORDER BY last_ts DESC),
  // aber bumpActivity() macht im laufenden Betrieb nur In-Place-Updates ohne
  // Re-Sort. Daher hier im Getter sortieren — reaktiv via $derived. O(n log n)
  // bei <500 Kontakten irrelevant.
  get filteredContacts() {
    const sorted = _byLastSeenDesc(_contacts);
    if (!_searchChats) return sorted;
    const q = _searchChats.toLowerCase();
    return sorted.filter(c => {
      const handle = (c.handle || "").toLowerCase();
      // displayName aus profileCache ziehen (falls schon gefetcht) — sonst nur Handle-Match.
      const dn = (profileCache.get(c.handle) || "").toLowerCase();
      return handle.includes(q) || dn.includes(q);
    });
  },

  get filteredGroups() {
    const sorted = _byLastSeenDesc(_groups);
    if (!_searchGroups) return sorted;
    const q = _searchGroups.toLowerCase();
    return sorted.filter(g => (g.name || "").toLowerCase().includes(q));
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
            // Sort-Key für filteredGroups. Fallback auf created_at, damit
            // brand-neue Gruppen ohne Messages nicht ans Ende rutschen.
            lastSeen: g.last_ts || g.created_at || null,
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

  // ── LIVE UPDATES (kein Reload nötig) ────────────────
  /**
   * Markiert einen DM-Kontakt oder eine Gruppe als „aktiv mit letzter Aktivität".
   * @param {string} key - DM: peer-Handle, Group: groupId
   * @param {string} [preview] - Plaintext oder '🔐 …' für E2E-pending
   * @param {number} [ts] - Timestamp der Message (Default: Date.now())
   */
  bumpActivity(key, preview = '', ts = Date.now()) {
    if (!key) return;
    // DM-Kontakt updaten
    const cIdx = _contacts.findIndex(c => c.handle === key);
    if (cIdx >= 0) {
      const next = _contacts.slice();
      next[cIdx] = { ...next[cIdx], lastSeen: ts, lastMessage: preview };
      _contacts = next;
      return;
    }
    // Group updaten
    const gIdx = _groups.findIndex(g => g.id === key);
    if (gIdx >= 0) {
      const next = _groups.slice();
      next[gIdx] = { ...next[gIdx], lastSeen: ts, lastMessage: preview };
      _groups = next;
      return;
    }
    // Weder Contact noch Group bekannt — typisch wenn ein frischer Gast joint
    // ODER ein anderer Member uns gerade in eine Group hinzugefügt hat: das
    // initial `loadContacts/loadGroups` beim App-Boot kannte den Eintrag noch
    // nicht. Race-Condition zwischen `guest_joined`/`group_added` WS-Event und
    // dem ersten `message`. Fallback: Inbox vom Backend frisch holen damit
    // der neue Eintrag erscheint. Fire-and-forget — UI updated sich beim
    // nächsten Tick. Best-effort beide Listen weil wir aus dem Key nicht
    // sicher ableiten können ob es ein DM-Handle oder Group-UUID ist.
    void this.loadContacts().catch(() => {});
    void this.loadGroups().catch(() => {});
  },

  /**
   * Entfernt eine Gruppe lokal aus der Inbox-Liste (z.B. nach `/groups/leave`
   * oder nach Empfang von `group_member_removed` wenn ich selbst der Target
   * war). Idempotent — silent no-op wenn die Gruppe nicht (mehr) gelistet ist.
   */
  removeGroup(groupId) {
    if (!groupId) return;
    if (!_groups.some(g => g.id === groupId)) return;
    _groups = _groups.filter(g => g.id !== groupId);
    // Unread-Counter für diese Gruppe ebenfalls droppen
    if (_unreadCounts[groupId]) {
      const next = { ..._unreadCounts };
      delete next[groupId];
      _unreadCounts = next;
    }
  },

  /** Setzt den Namen einer Gruppe lokal um (idempotent). */
  renameGroup(groupId, newName) {
    if (!groupId || !newName) return;
    const idx = _groups.findIndex(g => g.id === groupId);
    if (idx < 0) return;
    if (_groups[idx].name === newName) return;
    const next = _groups.slice();
    next[idx] = { ...next[idx], name: newName };
    _groups = next;
  },

  /** Setzt den Unread-Counter für einen Chat auf 0 (lokal). */
  markRead(key) {
    if (!key) return;
    if (!_unreadCounts[key]) return;
    const next = { ..._unreadCounts };
    delete next[key];
    _unreadCounts = next;
  },

  /** Inkrementiert den Unread-Counter für einen Chat um 1 (lokal). */
  incrementUnread(key) {
    if (!key) return;
    _unreadCounts = { ..._unreadCounts, [key]: (_unreadCounts[key] || 0) + 1 };
  },

  // ── DEV/TEST HELPERS ────────────────────────────
  // Setzt Mock-Daten für Visual-Tests (NICHT in Production verwenden)
  _setMockData({ contacts, groups, unread } = {}) {
    if (contacts) _contacts = contacts;
    if (groups) _groups = groups;
    if (unread) _unreadCounts = unread;
  },
};
