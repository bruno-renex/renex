import {
  initE2EKeys,
  uploadInboxKeyIfNeeded
} from "./e2e.js";
import lang, { getLang, setLang } from "./i18n.js";

// ================================
// CONFIG
// ================================
const API = "https://api.renex.id";

// ================================
// PROFILE CIRCLE
// ================================
function initProfileCircle() {
  const circle = document.getElementById("profile-circle");
  if (!circle) return;

  const user = (localStorage.getItem("my_user") || "").trim();

  if (!user) {
    circle.textContent = "?";
    return;
  }

  const initials = user
    .split(/[\s._-]+/)
    .map(p => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  circle.textContent = initials;
}

// ================================
// HELPERS
// ================================
async function apiFetch(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }

  return res.json();
}

// ================================
// DOM
// ================================
const pendingEl  = document.getElementById("pending");
const acceptedEl = document.getElementById("accepted");

const addInput  = document.getElementById("add-handle");
const addBtn    = document.getElementById("add-btn");

let unreadMap = {};

const groupsEl = document.getElementById("groups");
const groupNameInput = document.getElementById("group-name-input");
const createGroupBtn = document.getElementById("create-group-btn");

let _lastGroupsKey = null;
let _currentGroups  = []; // für Badge-Neuberechnung nach Klick

// Gruppe hat ungelesene Nachrichten wenn last_ts > zuletzt gelesene ts
function isGroupUnread(group) {
  if (!group.last_ts) return false;
  const lastRead = Number(localStorage.getItem(`renex_group_read_${group.id}`) || 0);
  return Number(group.last_ts) > lastRead;
}
function markGroupSeen(groupId, lastTs) {
  // Wird aus chat.js gesetzt; hier nur als Fallback wenn lastTs fehlt
  if (lastTs) localStorage.setItem(`renex_group_read_${groupId}`, String(lastTs));
}
function refreshGroupBadge() {
  const count = _currentGroups.filter(g => isGroupUnread(g)).length;
  updateTabBadge("groups", count);
}

// ================================
// PREVIEW CACHE HELPERS
// ================================
function dmConvoId(a, b) {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x < y ? `${x}:${y}` : `${y}:${x}`;
}
function getPreviewCache(convoId) {
  try { return JSON.parse(localStorage.getItem(`renex_preview_${convoId}`) || "null"); }
  catch { return null; }
}
function buildPreviewText(cached, serverTs, myUser, fromUser, isGroup) {
  const sTs = Number(serverTs) || 0;
  if (!sTs) return { text: lang.noMessages, muted: true };

  console.debug("[preview]", { fromUser, sTs, cached });

  if (cached && Number(cached.ts) >= sTs) {
    const from = cached.from || "";
    if (from === "__system__") return { text: cached.text || "", muted: false };
    const fromMe = from === myUser;
    const prefix = fromMe ? (lang.youPrefix || "Du: ") : (isGroup && from ? `${from}: ` : "");
    return { text: `${prefix}${cached.text || ""}`, muted: false };
  }
  // Neuere Nachricht auf Server → noch nicht entschlüsselt
  return { text: `🔒 ${lang.newMessage || "Neue Nachricht"}`, muted: false };
}

// ================================
// AVATAR + TIME HELPERS
// ================================
const _AVATAR_COLORS = ["#5865F2","#3ba55c","#eb459e","#faa61a","#57F287","#5865F2","#ED4245","#9B59B6"];
function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return _AVATAR_COLORS[Math.abs(hash) % _AVATAR_COLORS.length];
}

function formatTime(ts) {
  if (!ts) return "";
  const date = new Date(ts);
  const now  = new Date();
  const isToday     = date.toDateString() === now.toDateString();
  const yesterday   = new Date(now); yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  if (isToday)     return date.toLocaleTimeString(lang.locale || "de-CH", { hour: "2-digit", minute: "2-digit" });
  if (isYesterday) return lang.yesterday || "Gestern";
  const diffDays = Math.floor((now - date) / 86400000);
  if (diffDays < 7) return date.toLocaleDateString(lang.locale || "de-CH", { weekday: "short" });
  return date.toLocaleDateString(lang.locale || "de-CH", { day: "2-digit", month: "2-digit" });
}

let contactRequestInFlight = false;

// Enter im Input löst Anfrage aus (spam-safe)
addInput?.addEventListener("keydown", (e) => {

  if (e.key !== "Enter") return;

  // verhindert Form Submit / mehrfaches Triggern
  e.preventDefault();

  // verhindert Spam während Request läuft
  if (contactRequestInFlight) return;

  addBtn?.click();

});

const profileCircle = document.getElementById("profile-circle");
const profileDropdown = document.getElementById("profile-dropdown");
const dropdownHandle = document.getElementById("dropdown-handle");
const dropdownHandleLabel = document.getElementById("dropdown-handle-label");
const dropdownLogout = document.getElementById("dropdown-logout");
const accountSubmenu = document.getElementById("account-submenu");
const dropdownDelete = document.getElementById("dropdown-delete");
const deleteOverlay = document.getElementById("delete-overlay");
const deleteConfirmInput = document.getElementById("delete-confirm-input");
const deleteHandleError = document.getElementById("delete-handle-error");
const btnCancelDelete = document.getElementById("btn-cancel-delete");
const btnConfirmDelete = document.getElementById("btn-confirm-delete");

// ================================
// INIT
// ================================
document.addEventListener("DOMContentLoaded", async () => {
  initProfileCircle();   // 👈 HIER EINBAUEN

  if (!localStorage.getItem("my_user")) {
    location.href = "/login.html";
    return;
  }

  try {
    // 🔐 E2E lokal sicherstellen
    await initE2EKeys();

    // 📮 Inbox-Key GLOBAL sicherstellen
    await uploadInboxKeyIfNeeded();

    // 👤 Handle im Dropdown anzeigen
const myUser = localStorage.getItem("my_user");
if (myUser && dropdownHandleLabel) {
  dropdownHandleLabel.textContent = myUser;
}

// 🔽 Dropdown Toggle (Ebene 1)
if (profileCircle && profileDropdown) {
  profileCircle.addEventListener("click", (e) => {
    e.stopPropagation();
    profileDropdown.classList.toggle("show");
    accountSubmenu?.classList.remove("show");
  });
}

// 🔽 Sub-Menü Toggle (Ebene 2) — Klick auf Handle-Zeile
if (dropdownHandle && accountSubmenu) {
  dropdownHandle.addEventListener("click", (e) => {
    e.stopPropagation();
    accountSubmenu.classList.toggle("show");
  });
}

// 🚪 Logout
if (dropdownLogout) {
  dropdownLogout.addEventListener("click", async (e) => {
    e.stopPropagation();
    const { logout } = await import("./auth.js");
    await logout();
  });
}

// 🗑️ Account löschen — Dialog öffnen
if (dropdownDelete && deleteOverlay) {
  dropdownDelete.addEventListener("click", (e) => {
    e.stopPropagation();
    profileDropdown.classList.remove("show");
    accountSubmenu.classList.remove("show");
    deleteConfirmInput.value = "";
    deleteHandleError.textContent = "";
    btnConfirmDelete.classList.remove("enabled");
    deleteOverlay.classList.add("show");
    deleteConfirmInput.focus();
  });
}

// Handle-Eingabe validieren → Button freischalten
if (deleteConfirmInput) {
  deleteConfirmInput.addEventListener("input", () => {
    const entered = deleteConfirmInput.value.trim();
    const correct = (localStorage.getItem("my_user") || "").trim();
    if (entered === correct) {
      deleteHandleError.textContent = "";
      btnConfirmDelete.classList.add("enabled");
    } else {
      btnConfirmDelete.classList.remove("enabled");
      deleteHandleError.textContent = entered.length > 0 ? lang.handleMismatch : "";
    }
  });
}

// Abbrechen
if (btnCancelDelete) {
  btnCancelDelete.addEventListener("click", () => {
    deleteOverlay.classList.remove("show");
  });
}

// Bestätigen → Account löschen
if (btnConfirmDelete) {
  btnConfirmDelete.addEventListener("click", async () => {
    if (!btnConfirmDelete.classList.contains("enabled")) return;
    btnConfirmDelete.textContent = "…";
    btnConfirmDelete.classList.remove("enabled");
    // Interval stoppen bevor Session gelöscht wird
    clearInterval(window._contactsInterval);
    try {
      await apiFetch("/account", { method: "DELETE" });
    } catch {}
    // Lokale Daten löschen
    localStorage.removeItem("my_user");
    localStorage.removeItem("device_id");
    try {
      const idb = indexedDB.deleteDatabase("renex-keys");
      await new Promise((res) => { idb.onsuccess = idb.onerror = idb.onblocked = res; });
    } catch {}
    location.href = "/login.html";
  });
}

// ❌ Alle Dropdowns schließen bei Klick außerhalb
document.addEventListener("click", (e) => {
  if (!e.target.closest(".profile-wrapper")) {
    profileDropdown?.classList.remove("show");
    accountSubmenu?.classList.remove("show");
    document.getElementById("lang-submenu")?.style.setProperty("display", "none");
  }
});

// ======================================================
// 🌍 SPRACHE
// ======================================================
const langBtn = document.getElementById("dropdown-lang");
const langSubmenu = document.getElementById("lang-submenu");
const langOptDe = document.getElementById("lang-opt-de");
const langOptEn = document.getElementById("lang-opt-en");
const langOptEs = document.getElementById("lang-opt-es");

if (langBtn && langSubmenu) {
  const active = getLang();
  if (active === "de") langOptDe.style.fontWeight = "700";
  if (active === "en") langOptEn.style.fontWeight = "700";
  if (active === "es") langOptEs.style.fontWeight = "700";

  langBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    langSubmenu.style.display = langSubmenu.style.display === "block" ? "none" : "block";
  });

  langOptDe.addEventListener("click", () => { setLang("de"); location.reload(); });
  langOptEn.addEventListener("click", () => { setLang("en"); location.reload(); });
  langOptEs.addEventListener("click", () => { setLang("es"); location.reload(); });
}

    console.log("✅ Inbox E2E Init OK");
  } catch (e) {
    console.error("❌ Inbox E2E Init fehlgeschlagen", e);
    alert(lang.cryptoInitFailed);
    return;
  }

  loadContacts();
  loadGroups();
  // 🔄 Inbox automatisch aktualisieren
  window._contactsInterval = setInterval(loadContacts, 8000);
  setInterval(loadGroups, 8000);

  // 🔔 Echtzeit: Kontaktanfrage akzeptiert → sofort neu laden (kein Warten auf Poll)
  if ("BroadcastChannel" in window) {
    const bc = new BroadcastChannel("renex-control");
    bc.onmessage = (e) => {
      if (e.data?.type === "CONTACT_ACCEPTED" || e.data?.type === "CONTACT_UPDATE") loadContacts();
    };
  } else {
    window.addEventListener("storage", (e) => {
      if (e.key === "renex-control-event") {
        try {
          const ev = JSON.parse(e.newValue || "{}");
          if (ev.type === "CONTACT_ACCEPTED" || ev.type === "CONTACT_UPDATE") loadContacts();
        } catch {}
      }
    });
  }

  // BFCache-Restore: Browser-Back stellt alten JS-Zustand wieder her →
  // _lastContactsKey/_lastGroupsKey sind veraltet → Neu-Render erzwingen
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
      _lastContactsKey = null;
      _lastGroupsKey   = null;
      loadContacts();
      loadGroups();
    }
  });

  // Preview-Cache Update: chat.js schreibt renex_preview_* →
  // Inbox muss Kontakt-/Gruppen-Liste neu rendern (gleiche oder andere Tab)
  window.addEventListener("storage", (e) => {
    if (e.key && e.key.startsWith("renex_preview_")) {
      _lastContactsKey = null;
      _lastGroupsKey   = null;
      loadContacts();
      loadGroups();
    }
  });

  // ── Tab-Navigation ───────────────────────────────────────
  const tabBtns   = document.querySelectorAll(".tab-btn");
  const tabPanels = document.querySelectorAll(".tab-panel");

  function switchTab(tab) {
    tabBtns.forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
    tabPanels.forEach(p => p.classList.toggle("active", p.id === `panel-${tab}`));
    localStorage.setItem("inbox_tab", tab);
    // FAB nur im Gruppen-Tab anzeigen
    if (createGroupBtn) {
      createGroupBtn.style.display = tab === "groups" ? "flex" : "none";
    }
  }

  tabBtns.forEach(btn => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

  // Letzten Tab wiederherstellen
  const savedTab = localStorage.getItem("inbox_tab");
  if (savedTab) switchTab(savedTab);
});

// ================================
// LOAD CONTACTS
// ================================
// Tab-Badge Helper
function updateTabBadge(tab, count) {
  const el = document.getElementById(`tab-badge-${tab}`);
  if (!el) return;
  if (count > 0) {
    el.textContent = count > 99 ? "99+" : count;
    el.classList.add("visible");
  } else {
    el.classList.remove("visible");
  }
}

// Cache für letzten Render-Stand (verhindert unnötiges DOM-Blinken)
let _lastContactsKey = null;
// Cache akzeptierter Kontakte für Invite-Autocomplete + Gruppen-Detail-Popup
let _acceptedContactHandles = [];
let _cachedAcceptedContacts = null;
async function fetchAcceptedContacts() {
  if (_cachedAcceptedContacts) return _cachedAcceptedContacts;
  // _acceptedContactHandles wird von loadContacts() befüllt — direkt verwenden
  if (_acceptedContactHandles.length) {
    _cachedAcceptedContacts = _acceptedContactHandles;
    return _cachedAcceptedContacts;
  }
  try {
    const data = await apiFetch("/contacts/list");
    _cachedAcceptedContacts = (data.contacts || [])
      .filter(c => c.status === "accepted")
      .map(c => c.handle || "")
      .filter(Boolean);
  } catch { _cachedAcceptedContacts = []; }
  return _cachedAcceptedContacts;
}

async function loadContacts() {

  try {
    // 🔔 unread counts laden
    const unreadData = await apiFetch("/chat/unread");
    unreadMap = unreadData.unread || {};
  } catch (e) {
    console.warn("Unread fetch failed", e);
    unreadMap = {};
  }

  try {
    const data = await apiFetch("/contacts/list");
    const contacts = Array.isArray(data.contacts) ? data.contacts : [];

    // 🚫 Kein Re-Render wenn sich nichts geändert hat → kein Blinken
    const cacheKey = JSON.stringify(contacts) + JSON.stringify(unreadMap);
    if (cacheKey === _lastContactsKey) return;
    _lastContactsKey = cacheKey;

    pendingEl.innerHTML = "";
    acceptedEl.innerHTML = "";

    if (contacts.length === 0) {
      acceptedEl.appendChild(emptyLi(lang.noContacts));
      return;
    }

    // Akzeptierte Kontakte für Invite-Autocomplete cachen
    _cachedAcceptedContacts = null; // invalidieren damit Popup immer frisch lädt
    _acceptedContactHandles = contacts
      .filter(c => c.status === "accepted")
      .map(c => c.contact_handle || c.handle || "")
      .filter(Boolean);

    contacts.forEach(contact => {
      if (contact.status === "pending") {
        pendingEl.appendChild(renderPending(contact));
      }
      if (contact.status === "accepted") {
        acceptedEl.appendChild(renderAccepted(contact));
      }
      if (contact.status === "account_deleted") {
        acceptedEl.appendChild(renderDeleted(contact));
      }
    });

    // Tab-Badges aktualisieren
    const totalUnread = Object.values(unreadMap).reduce((s, n) => s + (n || 0), 0);
    const pendingCount = contacts.filter(c => c.status === "pending" && c.direction === "in").length;
    updateTabBadge("chats", totalUnread);
    updateTabBadge("contacts", pendingCount);

    if (!pendingEl.children.length) {
      pendingEl.appendChild(emptyLi(lang.noPendingRequests));
    }

    if (!acceptedEl.children.length) {
      acceptedEl.appendChild(emptyLi(lang.noContacts));
    }

  } catch (err) {
    if (!localStorage.getItem("my_user")) return;
    console.error("Load contacts failed:", err);
    alert(lang.loadContactsFailed);
  }
}

// ================================
// RENDER
// ================================
function renderPending(contact) {

  const li = document.createElement("li");

  const name = document.createElement("span");
  name.textContent = contact.display_handle || contact.handle;
  li.appendChild(name);

  // 👉 AUSGEHENDE Anfrage
  if (contact.direction === "out") {

    const sent = document.createElement("span");
    sent.textContent = lang.requestSent;
    sent.style.opacity = "0.6";
    sent.style.marginLeft = "6px";

    li.appendChild(sent);

    return li;
  }

  // 👉 EINGEHENDE Anfrage
  li.dataset.pendingIn = "1";
  const acceptBtn = document.createElement("button");
  acceptBtn.textContent = lang.acceptBtn;
  acceptBtn.onclick = async () => {
    li.remove(); // sofort aus DOM entfernen
    updateTabBadge("contacts", document.querySelectorAll("#pending li[data-pending-in]").length);
    await apiFetch("/contacts/accept", {
      method: "POST",
      body: JSON.stringify({ contact: contact.handle })
    });
    loadContacts();
  };

  const rejectBtn = document.createElement("button");
  rejectBtn.textContent = lang.rejectBtn;
  rejectBtn.onclick = async () => {
    li.remove(); // sofort aus DOM entfernen
    updateTabBadge("contacts", document.querySelectorAll("#pending li[data-pending-in]").length);
    await apiFetch("/contacts/reject", {
      method: "POST",
      body: JSON.stringify({ contact: contact.handle })
    });
    loadContacts();
  };

  li.appendChild(acceptBtn);
  li.appendChild(rejectBtn);

  return li;
}

function renderAccepted(contact) {
  const handle  = contact.display_handle || contact.handle;
  const unread  = unreadMap[contact.handle] || 0;
  const myUser  = (localStorage.getItem("my_user") || "").toLowerCase();
  const convoId = dmConvoId(myUser, contact.handle);
  const cached  = getPreviewCache(convoId);
  const { text: previewText, muted: previewMuted } = buildPreviewText(cached, contact.last_ts, myUser, contact.handle, false);

  const li = document.createElement("li");
  li.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 6px;border-bottom:1px solid var(--border-subtle);cursor:pointer;transition:background 0.1s;border-radius:8px;";
  li.addEventListener("mouseenter", () => li.style.background = "var(--bg-panel-alt)");
  li.addEventListener("mouseleave", () => li.style.background = "");
  li.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    window.location.href = `/chat?with=${encodeURIComponent(contact.handle)}`;
  });

  // Avatar
  const avatar = document.createElement("div");
  avatar.style.cssText = "width:40px;height:40px;min-width:40px;border-radius:50%;background:#404249;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:17px;color:#fff;";
  avatar.textContent = handle[0].toUpperCase();

  // Content
  const content = document.createElement("div");
  content.style.cssText = "flex:1;min-width:0;";

  const topRow = document.createElement("div");
  topRow.style.cssText = "display:flex;align-items:baseline;justify-content:space-between;gap:4px;";

  const nameEl = document.createElement("span");
  nameEl.style.cssText = "font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  nameEl.textContent = handle;

  const timeMeta = document.createElement("span");
  timeMeta.style.cssText = `font-size:11px;white-space:nowrap;flex-shrink:0;color:${unread > 0 ? "var(--accent-voice)" : "var(--text-secondary)"};${unread > 0 ? "font-weight:600;" : ""}`;
  timeMeta.textContent = formatTime(contact.last_ts);

  topRow.appendChild(nameEl);
  topRow.appendChild(timeMeta);

  const previewRow = document.createElement("div");
  previewRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-top:2px;gap:4px;";

  const preview = document.createElement("span");
  preview.style.cssText = "font-size:12px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  preview.textContent = previewText;
  if (previewMuted) preview.style.opacity = "0.45";

  previewRow.appendChild(preview);

  if (unread > 0) {
    const badge = document.createElement("span");
    badge.textContent = unread > 99 ? "99+" : unread;
    badge.style.cssText = "background:var(--accent-voice);color:#fff;border-radius:10px;font-size:11px;font-weight:700;padding:1px 6px;flex-shrink:0;";
    previewRow.appendChild(badge);
  }

  content.appendChild(topRow);
  content.appendChild(previewRow);

  // Remove button
  const removeBtn = document.createElement("button");
  removeBtn.textContent = "✕";
  removeBtn.title = lang.removeFromList;
  removeBtn.style.cssText = "background:transparent;border:none;color:var(--text-muted);font-size:14px;cursor:pointer;padding:4px 6px;border-radius:4px;flex-shrink:0;transition:color 0.15s;";
  removeBtn.onmouseenter = () => removeBtn.style.color = "var(--status-error)";
  removeBtn.onmouseleave = () => removeBtn.style.color = "var(--text-muted)";
  removeBtn.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm(lang.confirmRemoveContact(contact.handle))) return;
    try {
      await apiFetch("/contacts/remove", { method: "POST", body: JSON.stringify({ contact: contact.handle }) });
      loadContacts();
    } catch { alert(lang.removeContactFailed); }
  };

  li.appendChild(avatar);
  li.appendChild(content);
  li.appendChild(removeBtn);
  return li;
}

function renderDeleted(contact) {
  const li = document.createElement("li");
  li.style.opacity = "0.5";

  const name = document.createElement("span");
  name.textContent = contact.display_handle || contact.handle;
  name.style.textDecoration = "line-through";

  const label = document.createElement("span");
  label.textContent = lang.accountDeleted;
  label.style.fontSize = "12px";
  label.style.marginLeft = "6px";

  const removeBtn = document.createElement("button");
  removeBtn.textContent = "✕";
  removeBtn.title = lang.removeFromList;
  removeBtn.style.marginLeft = "10px";
  removeBtn.style.color = "var(--text-muted)";
  removeBtn.style.background = "transparent";
  removeBtn.style.border = "none";
  removeBtn.style.cursor = "pointer";
  removeBtn.style.fontSize = "14px";
  removeBtn.style.padding = "2px 6px";
  removeBtn.style.borderRadius = "4px";
  removeBtn.style.transition = "color 0.15s ease";
  removeBtn.onmouseenter = () => removeBtn.style.color = "var(--status-error)";
  removeBtn.onmouseleave = () => removeBtn.style.color = "var(--text-muted)";
  removeBtn.onclick = async () => {
    try {
      await apiFetch("/contacts/remove", {
        method: "POST",
        body: JSON.stringify({ contact: contact.handle })
      });
      loadContacts();
    } catch (err) {
      console.error("Entfernen fehlgeschlagen", err);
    }
  };

  li.appendChild(name);
  li.appendChild(label);
  li.appendChild(removeBtn);
  return li;
}

function emptyLi(text) {
  const li = document.createElement("li");
  li.textContent = text;
  li.style.opacity = "0.6";
  return li;
}

// ================================
// GROUPS
// ================================
async function loadGroups() {
  if (!groupsEl) return;
  try {
    const data = await apiFetch("/groups/list");
    const groups = Array.isArray(data.groups) ? data.groups : [];
    const cacheKey = JSON.stringify(groups);
    if (cacheKey === _lastGroupsKey) return;
    _lastGroupsKey = cacheKey;

    _currentGroups = groups;
    refreshGroupBadge();
    groupsEl.innerHTML = "";
    if (groups.length === 0) {
      groupsEl.appendChild(emptyLi(lang.noGroups));
      return;
    }
    groups.forEach(g => groupsEl.appendChild(renderGroup(g)));
  } catch (e) {
    console.warn("loadGroups fehlgeschlagen", e);
  }
}

function renderGroup(group) {
  const isUnread = isGroupUnread(group);

  const li = document.createElement("li");
  li.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 6px;border-bottom:1px solid var(--border-subtle);cursor:pointer;transition:background 0.1s;border-radius:8px;";
  li.addEventListener("mouseenter", () => li.style.background = "var(--bg-panel-alt)");
  li.addEventListener("mouseleave", () => li.style.background = "");
  li.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    markGroupSeen(group.id, group.last_ts);
    refreshGroupBadge();
    window.location.href = `/chat?with=${encodeURIComponent(group.id)}&name=${encodeURIComponent(group.name)}`;
  });

  // Avatar
  const avatar = document.createElement("div");
  avatar.style.cssText = "width:40px;height:40px;min-width:40px;border-radius:30%;background:#404249;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:17px;color:#fff;";
  avatar.textContent = group.name[0].toUpperCase();

  // Content
  const content = document.createElement("div");
  content.style.cssText = "flex:1;min-width:0;";

  const topRow = document.createElement("div");
  topRow.style.cssText = "display:flex;align-items:baseline;justify-content:space-between;gap:4px;";

  const nameEl = document.createElement("span");
  nameEl.style.cssText = "font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  nameEl.textContent = group.name;
  if (isUnread) nameEl.style.color = "var(--accent-voice)";

  const timeMeta = document.createElement("span");
  timeMeta.style.cssText = `font-size:11px;white-space:nowrap;flex-shrink:0;color:${isUnread ? "var(--accent-voice)" : "var(--text-secondary)"};${isUnread ? "font-weight:600;" : ""}`;
  timeMeta.textContent = formatTime(group.last_ts);

  topRow.appendChild(nameEl);
  topRow.appendChild(timeMeta);

  const previewRow = document.createElement("div");
  previewRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-top:2px;gap:4px;";

  const preview = document.createElement("span");
  preview.style.cssText = "font-size:12px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  {
    const myUser  = (localStorage.getItem("my_user") || "").toLowerCase();
    const cached  = getPreviewCache(group.id);
    // Für System-Nachrichten: Server-Text als Fallback wenn kein Cache
    const fallbackTs   = group.last_type === "system" ? group.last_ts : null;
    const fallbackText = group.last_type === "system" ? (group.last_text || "") : null;
    const effectiveCached = cached || (fallbackText !== null ? { text: fallbackText, ts: fallbackTs, from: "__system__" } : null);
    const { text: previewText, muted: previewMuted } = buildPreviewText(effectiveCached, group.last_ts, myUser, group.last_from, true);
    preview.textContent = previewText;
    if (previewMuted) preview.style.opacity = "0.45";
  }

  const memberCount = document.createElement("span");
  memberCount.style.cssText = "font-size:11px;color:var(--text-secondary);flex-shrink:0;white-space:nowrap;";
  memberCount.textContent = `👥 ${group.member_count}`;

  previewRow.appendChild(preview);
  previewRow.appendChild(memberCount);

  content.appendChild(topRow);
  content.appendChild(previewRow);

  // ✕ Verlassen-Button (identisch zum Kontakt-Remove-Button)
  const leaveBtn = document.createElement("button");
  leaveBtn.textContent = "✕";
  leaveBtn.title = lang.leaveGroupBtn;
  leaveBtn.style.cssText = "background:transparent;border:none;color:var(--text-muted);font-size:14px;cursor:pointer;padding:4px 6px;border-radius:4px;flex-shrink:0;transition:color 0.15s;";
  leaveBtn.onmouseenter = () => leaveBtn.style.color = "var(--status-error)";
  leaveBtn.onmouseleave = () => leaveBtn.style.color = "var(--text-muted)";
  leaveBtn.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm(lang.confirmLeaveGroup(group.name))) return;
    leaveBtn.disabled = true;
    try {
      await apiFetch("/groups/leave", { method: "POST", body: JSON.stringify({ groupId: group.id }) });
      _lastGroupsKey = null;
      await loadGroups();
    } catch (e) {
      alert(lang.leaveFailed + e.message);
      leaveBtn.disabled = false;
    }
  };

  li.appendChild(avatar);
  li.appendChild(content);
  li.appendChild(leaveBtn);
  return li;
}

// FAB + Popup: Gruppe erstellen
const createGroupPopup = document.getElementById("create-group-popup");

async function doCreateGroup() {
  const name = groupNameInput?.value.trim();
  if (!name) return;
  createGroupBtn.disabled = true;
  try {
    const res = await apiFetch("/groups/create", { method: "POST", body: JSON.stringify({ name }) });
    if (res.groupId) markGroupSeen(res.groupId, Date.now());
    groupNameInput.value = "";
    createGroupPopup.style.display = "none";
    _lastGroupsKey = null;
    await loadGroups();
  } catch (e) {
    alert(lang.createGroupFailed + e.message);
  } finally {
    createGroupBtn.disabled = false;
  }
}

createGroupBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = createGroupPopup?.style.display === "block";
  if (isOpen) {
    createGroupPopup.style.display = "none";
  } else {
    createGroupPopup.style.display = "block";
    setTimeout(() => groupNameInput?.focus(), 50);
  }
});

groupNameInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); doCreateGroup(); }
  if (e.key === "Escape") { createGroupPopup.style.display = "none"; }
});

document.addEventListener("click", (e) => {
  if (createGroupPopup?.style.display === "block"
      && !createGroupPopup.contains(e.target)
      && e.target !== createGroupBtn) {
    createGroupPopup.style.display = "none";
  }
});

groupNameInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") createGroupBtn?.click(); });

// ================================
// ADD CONTACT
// ================================
addBtn?.addEventListener("click", async () => {

  if (contactRequestInFlight) return;

  const handle = addInput.value.trim().toLowerCase();
  if (!handle) return;

  contactRequestInFlight = true;
  addBtn.disabled = true;

  try {
    await apiFetch("/contacts/request", {
      method: "POST",
      body: JSON.stringify({ contact: handle })
    });

    addInput.value = "";
    await loadContacts();

  } catch (err) {
    console.warn("Kontaktanfrage fehlgeschlagen:", err);
    alert(lang.contactRequestFailed);

  } finally {

    contactRequestInFlight = false;
    addBtn.disabled = false;

  }
});