import {
  initE2EKeys,
  uploadInboxKeyIfNeeded
} from "./e2e.js";
import { addPasskey } from "./auth.js?v=2026-04-27-8"; // Cache-Buster: bei Änderungen in auth.js bumpen
import lang, { getLang, setLang } from "./i18n.js";
import { guestDisplayName, replaceGuestHandles } from "./shared/guestUtils.js";
import { formatTime } from "./shared/timeFormat.js";
import { initServiceWorker, subscribeToPush, getPushStatus, updateBadge } from "./pushManager.js";
import { showPromptDialog } from "./shared/dialog.js";
import {
  loadOwnProfile,
  saveOwnDisplayName,
  getOwnDisplayName,
  onProfileChange,
  getDisplayName,
  prefetchProfiles,
} from "./profiles.js";

// ================================
// CONFIG
// ================================
const API = "https://api.renex.id";

// ================================
// PRESENCE HELPERS
// ================================
async function fetchPresence(handles) {
  if (!handles?.length) return {};
  try {
    const unique = [...new Set(handles.map(h => h.toLowerCase()))].filter(Boolean);
    return await apiFetch(`/presence?handles=${encodeURIComponent(unique.join(","))}`);
  } catch { return {}; }
}

function formatLastSeen(ts) {
  if (!ts) return "";
  const diff = Date.now() - Number(ts);
  if (diff < 60_000)      return "gerade eben";
  if (diff < 3_600_000)   return `vor ${Math.floor(diff / 60_000)} Min.`;
  if (diff < 86_400_000)  return `vor ${Math.floor(diff / 3_600_000)} Std.`;
  const days = Math.floor(diff / 86_400_000);
  return `vor ${days} Tag${days === 1 ? "" : "en"}`;
}

// ================================
// TOAST NOTIFICATION
// ================================
function showToast({ icon = "👥", title, sub = "", groupId = null, groupName = null, durationMs = 5000 }) {
  const container = document.getElementById("inbox-toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = "inbox-toast";

  toast.innerHTML = `
    <span class="inbox-toast-icon">${icon}</span>
    <div class="inbox-toast-body">
      <div class="inbox-toast-title">${title}</div>
      ${sub ? `<div class="inbox-toast-sub">${sub}</div>` : ""}
    </div>
    <button class="inbox-toast-close" title="${lang.closeBtn}">✕</button>
  `;

  // Klick auf Toast → Gruppen-Tab aktivieren (+ ggf. zum Chat navigieren)
  toast.addEventListener("click", (e) => {
    if (e.target.closest(".inbox-toast-close")) { dismissToast(toast); return; }
    dismissToast(toast);
    if (groupId) {
      if (typeof window.openChatPanel === "function") {
        window.openChatPanel(groupId, groupName || undefined);
      } else {
        const url = groupName
          ? `/chat?with=${encodeURIComponent(groupId)}&name=${encodeURIComponent(groupName)}`
          : `/chat?with=${encodeURIComponent(groupId)}`;
        window.location.href = url;
      }
    } else {
      // Gruppen-Section aktivieren
      const groupsBtn = document.querySelector('.strip-icon[data-section="groups"]');
      switchSection('groups', groupsBtn);
    }
  });

  container.appendChild(toast);

  // Auto-dismiss
  const timer = setTimeout(() => dismissToast(toast), durationMs);
  toast._dismissTimer = timer;
}

function dismissToast(toast) {
  clearTimeout(toast._dismissTimer);
  toast.classList.add("hiding");
  setTimeout(() => toast.remove(), 320);
}

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

// Guest display name & handle replacement → shared/guestUtils.js

// ================================
// INVITE LINK (Gruppen)
// ================================
let _invitePending = new Set(); // verhindert Doppelklick pro Gruppe

async function createGroupInviteLink(groupId, groupName, btnEl) {
  if (_invitePending.has(groupId)) return;
  _invitePending.add(groupId);

  const orig = btnEl.textContent;
  btnEl.textContent = "…";
  btnEl.disabled = true;

  const fmt = (url) => (lang.linkCopiedClipboard || ((u) => u))(url);
  const doFetch = () => fetch(`${API}/invite/create`, {
    method:      "POST",
    credentials: "include",
    headers:     { "Content-Type": "application/json" },
    body:        JSON.stringify({ convoId: groupId }),
  }).then(r => r.json().catch(() => ({}))).then(data => {
    if (!data.inviteUrl) throw new Error("no_url");
    return data.inviteUrl;
  });

  try {
    let copied = false;

    if (navigator.clipboard && window.ClipboardItem) {
      try {
        const urlPromise = doFetch();
        await navigator.clipboard.write([
          new ClipboardItem({ "text/plain": urlPromise.then(u => new Blob([fmt(u)], { type: "text/plain" })) })
        ]);
        await urlPromise;
        copied = true;
      } catch (e) {
        if (e.message === "no_url") throw e;
      }
    }

    if (!copied && navigator.clipboard?.writeText) {
      try {
        const url = await doFetch();
        await navigator.clipboard.writeText(fmt(url));
        copied = true;
      } catch (e) {
        if (e.message === "no_url") throw e;
      }
    }

    if (!copied) {
      const url = await doFetch();
      const ta = document.createElement("textarea");
      ta.value = fmt(url);
      ta.style.cssText = "position:fixed;top:0;left:0;width:2em;height:2em;opacity:0;";
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      try { copied = document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    }

    btnEl.textContent = "✓";
    showToast({ icon: "🔗", title: lang.linkCopiedInfo || lang.linkCopied, sub: groupName, durationMs: 4000 });
    setTimeout(() => { btnEl.textContent = orig; btnEl.disabled = false; _invitePending.delete(groupId); }, 2500);

  } catch (e) {
    btnEl.textContent = orig;
    btnEl.disabled = false;
    _invitePending.delete(groupId);
    showToast({ icon: "⚠️", title: lang.linkCreateFailed, durationMs: 4000 });
  }
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

// ── Suchfelder ───────────────────────────────────────────
const searchChats  = document.getElementById("search-chats");
const searchGroups = document.getElementById("search-groups");
const SEARCH_MIN   = 8; // ab dieser Anzahl erscheint die Suchleiste

function applySearch(input, listEl) {
  const q = (input?.value || "").trim().toLowerCase();
  Array.from(listEl?.children || []).forEach(li => {
    if (!li.dataset.searchName) return; // leere States überspringen
    // "flex" explizit setzen — "" würde display:flex aus cssText löschen → Layout bricht
    li.style.display = !q || li.dataset.searchName.includes(q) ? "flex" : "none";
  });
}

searchChats?.addEventListener("input",  () => applySearch(searchChats,  acceptedEl));
searchGroups?.addEventListener("input", () => applySearch(searchGroups, groupsEl));

// ── Anfragen-Modal ─────────────────────────────────────
const requestsModal     = document.getElementById("requests-modal");
const requestsModalClose = document.getElementById("requests-modal-close");
const pendingBannerEl   = document.getElementById("pending-banner");

function openRequestsModal()  {
  if (requestsModal) { requestsModal.style.display = "flex"; document.body.style.overflow = "hidden"; }
}
function closeRequestsModal() {
  if (requestsModal) { requestsModal.style.display = "none"; document.body.style.overflow = ""; }
}

pendingBannerEl?.addEventListener("click", openRequestsModal);
document.getElementById("pending-banner-groups")?.addEventListener("click", openRequestsModal);
requestsModalClose?.addEventListener("click", closeRequestsModal);
requestsModal?.addEventListener("click", (e) => { if (e.target === requestsModal) closeRequestsModal(); });

let unreadMap = {};

const groupsEl = document.getElementById("groups");
const groupNameInput = document.getElementById("group-name-input");
const createGroupBtn = document.getElementById("create-group-btn");

let _lastGroupsKey  = null;
let _currentGroups  = []; // für Badge-Neuberechnung nach Klick
let _contactsEtag   = null; // ETag für /contacts/list → spart DB-Query bei 304
let _mutedConvos     = new Set(); // vom Backend geladen
let _mutedLoadedAt   = 0;
const MUTED_TTL_MS   = 10 * 60 * 1000; // 10 Minuten

async function loadMutedConvos(force = false) {
  // Cache-Invalidierung durch chat.js (nach Mute-Toggle)
  const externalReset = Number(localStorage.getItem("renex_muted_cache_ts") || 1);
  if (!force && externalReset !== 0 && Date.now() - _mutedLoadedAt < MUTED_TTL_MS) return;
  try {
    const { muted } = await apiFetch("/notifications/muted");
    _mutedConvos   = new Set(muted || []);
    _mutedLoadedAt = Date.now();
    localStorage.removeItem("renex_muted_cache_ts"); // Reset-Flag löschen
  } catch { _mutedConvos = new Set(); }
}

// Gruppe hat ungelesene Nachrichten wenn last_ts > zuletzt gelesene ts
// UND die letzte Nachricht nicht von mir selbst stammt
// UND die Gruppe nicht stummgeschaltet ist
function isGroupUnread(group) {
  if (!group.last_ts) return false;
  if (_mutedConvos.has(group.id)) return false;
  const myUser = (localStorage.getItem("my_user") || "").toLowerCase();
  if (group.last_from && group.last_from.toLowerCase() === myUser) return false;
  const lastRead = Number(localStorage.getItem(`renex_group_read_${group.id}`) || 0);
  return Number(group.last_ts) > lastRead;
}
function markGroupSeen(groupId, lastTs) {
  if (!lastTs) return;
  localStorage.setItem(`renex_group_read_${groupId}`, String(lastTs));
  // Backend informieren → unread_count in /groups/list wird korrekt berechnet
  apiFetch("/groups/mark-read", {
    method: "POST",
    body: JSON.stringify({ groupId, lastReadTs: lastTs })
  }).catch(() => {}); // Fire-and-forget, kein await nötig
}
function refreshGroupBadge() {
  const count = _currentGroups.filter(g => isGroupUnread(g)).length;
  console.debug("[groupBadge]", count, _currentGroups.map(g => ({
    id: g.id.slice(0,8), last_ts: g.last_ts, last_from: g.last_from,
    lastRead: localStorage.getItem(`renex_group_read_${g.id}`)
  })));
  updateTabBadge("groups", count);

  // App-Icon Badge aktualisieren (DM + Gruppen total)
  const dmUnread = Object.values(unreadMap).filter(v => v > 0).length;
  updateBadge(dmUnread + count);
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
    // Cache ist aktuell → Text zeigen
    const from = cached.from || "";
    if (from === "__system__") return { text: replaceGuestHandles(cached.text || ""), muted: false };
    const fromMe = from === myUser;
    const prefix = fromMe ? (lang.youPrefix || "Du: ") : (isGroup && from ? `${guestDisplayName(from)}: ` : "");
    return { text: `${prefix}${cached.text || ""}`, muted: false };
  }
  // Neue ungelesene Nachricht (kein Cache oder veraltet)
  const prefix = (isGroup && fromUser && fromUser !== myUser) ? `${guestDisplayName(fromUser)}: ` : "";
  return { text: `${prefix}💬 ${lang.newMessage || "Neue Nachricht"}`, muted: false };
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

// formatTime → shared/timeFormat.js

let contactRequestInFlight = false;

// Enter / Escape im Add-Contact Input
addInput?.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.getElementById("add-contact-popup")?.style.setProperty("display", "none");
    return;
  }
  if (e.key !== "Enter") return;
  e.preventDefault();
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

// Display Name Modal refs
const dropdownDisplayName = document.getElementById("dropdown-display-name");
const dnModal = document.getElementById("display-name-modal");
const dnInput = document.getElementById("display-name-input");
const dnCounter = document.getElementById("display-name-counter");
const dnError = document.getElementById("display-name-error");
const dnSaveBtn = document.getElementById("display-name-save");
const dnCancelBtn = document.getElementById("display-name-cancel");
const dnCloseBtn = document.getElementById("display-name-close");
const dnResetBtn = document.getElementById("display-name-reset");

// ================================
// PUSH NOTIFICATION BANNER
// ================================
async function initPushBanner() {
  const banner = document.getElementById("push-banner");
  if (!banner) return;

  // Push Status prüfen
  const status = await getPushStatus();

  // Nicht unterstützt → kein Banner
  if (!status.supported) return;

  // Permission granted → IMMER Subscription mit Backend syncen
  // Wichtig: Nach Handle-Wechsel muss Subscription neu zugeordnet werden
  if (status.permission === "granted") {
    try {
      await subscribeToPush(); // re-POST /push/subscribe für aktuellen User
      console.log("🔔 Push subscription synced for current user");
    } catch (e) {
      console.warn("🔔 Push sync failed:", e.message);
    }
    return; // kein Banner nötig
  }

  // Permission fehlt → Banner IMMER zeigen (ignoriert altes "dismissed"),
  // weil User sonst nie Push bekommen kann (ohne Permission-Dialog via User-Gesture)
  // Reset dismissed-Flag damit der Banner nach dem Permission-Erteilen nicht mehr kommt
  localStorage.removeItem("renex_push_dismissed");

  // Banner-Texte aus i18n setzen
  const titleEl = document.getElementById("push-banner-title");
  const subtitleEl = document.getElementById("push-banner-subtitle");
  if (titleEl) titleEl.textContent = lang.pushBannerTitle || "Enable notifications";
  if (subtitleEl) subtitleEl.textContent = lang.pushBannerSubtitle || "Don't miss any messages";

  // Banner anzeigen (CSS ist flex-Layout)
  banner.style.display = "flex";

  // Click-Handler: Permission fragen + Subscribe.
  // iOS Safari/PWA: requestPermission() MUSS synchron nach User-Gesture
  // aufgerufen werden — vor jeglichem await auf andere Promises.
  // Deshalb: Permission ZUERST, SW-Registration danach.
  const enablePush = async () => {
    if (banner.dataset.busy === "1") return;
    banner.dataset.busy = "1";
    try {
      if (titleEl) titleEl.textContent = lang.pushBannerActivating || "Activating…";

      const perm = await Notification.requestPermission();
      if (perm === "granted") {
        await initServiceWorker();
        await subscribeToPush();
        banner.style.display = "none";
        localStorage.setItem("renex_push_dismissed", "1");
        console.log("🔔 Push via Banner aktiviert");
      } else {
        if (titleEl) titleEl.textContent = lang.pushBannerBlocked || "Notifications blocked";
        setTimeout(() => { banner.style.display = "none"; }, 2000);
      }
    } catch (err) {
      console.warn("Push banner error:", err);
      banner.style.display = "none";
    } finally {
      banner.dataset.busy = "";
    }
  };

  // Click + Tastatur (Enter/Space) für Accessibility — funktioniert auf allen
  // Geräten inkl. VR-Controller (Click-Event), Tastatur, Touch.
  if (!banner.dataset.bound) {
    banner.dataset.bound = "1";
    banner.addEventListener("click", enablePush);
    banner.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        enablePush();
      }
    });
  }

  // Backwards-compat: bestehender Inline-Handler aus alter Version
  window.__enablePush = enablePush;
}

// ================================
// INIT
// ================================
// In die komplette Init-Logik refaktoriert — wird aufgerufen sobald
// `my_user` verfügbar ist (sei es von Anfang an oder erst nach dem
// async Session-Check in index.html/inbox.html bei iOS-PWA).
async function runInboxInit() {
  initProfileCircle();

  if (!localStorage.getItem("my_user")) return;

  try {
    // 🔐 E2E lokal sicherstellen
    await initE2EKeys();

    // 📮 Inbox-Key GLOBAL sicherstellen
    await uploadInboxKeyIfNeeded();

    // 🔔 Push Banner: anzeigen wenn Permission noch nicht granted
    initPushBanner();

    // 👤 Handle im Dropdown anzeigen (mit Display Name Fallback)
const myUser = localStorage.getItem("my_user");
function refreshOwnLabel() {
  if (!myUser || !dropdownHandleLabel) return;
  const dn = getOwnDisplayName();
  dropdownHandleLabel.textContent = dn ? `${dn}  ·  @${myUser}` : myUser;
}
refreshOwnLabel();

// Eigenes Profil vom Backend laden (async) → Label aktualisieren, sobald da
// DOM-Updates für data-profile-handle laufen zentral in profiles.js (auch auf /chat-Seite).
loadOwnProfile().then(refreshOwnLabel).catch(() => {});
onProfileChange((changedHandle) => {
  if (changedHandle === myUser) refreshOwnLabel();
});

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
    const { logout } = await import("./auth.js?v=2026-04-27-8"); // Cache-Buster: bei Änderungen in auth.js bumpen
    await logout();
  });
}

// ✏️ Display Name Modal
function updateDnCounter() {
  if (!dnInput || !dnCounter) return;
  const len = Array.from(dnInput.value.trim()).length;
  dnCounter.textContent = typeof lang.displayNameCharCount === "function"
    ? lang.displayNameCharCount(len)
    : `${len}/32`;
  dnCounter.style.color = len > 32 ? "#ef4444" : "";
  if (dnSaveBtn) dnSaveBtn.disabled = len > 32;
}
function closeDnModal() {
  if (!dnModal) return;
  dnModal.classList.remove("show");
  if (dnError) dnError.textContent = "";
}
async function handleDnSave(resetMode = false) {
  if (!dnError || !dnSaveBtn) return;
  dnError.textContent = "";
  dnSaveBtn.disabled = true;
  if (dnResetBtn) dnResetBtn.disabled = true;
  const value = resetMode ? null : dnInput.value.trim();
  const result = await saveOwnDisplayName(value);
  dnSaveBtn.disabled = false;
  if (dnResetBtn) dnResetBtn.disabled = false;
  if (result.ok) {
    showToast({
      icon: "✓",
      title: result.display_name ? lang.displayNameSaved : lang.displayNameReset,
      durationMs: 2500
    });
    closeDnModal();
  } else if (result.error === "too_long") {
    dnError.textContent = lang.displayNameTooLong;
  } else if (result.error === "rate_limit") {
    dnError.textContent = lang.displayNameRateLimit;
  } else if (result.error === "invalid") {
    dnError.textContent = lang.displayNameInvalid;
  } else {
    dnError.textContent = lang.displayNameSaveFailed;
  }
}

if (dropdownDisplayName && dnModal && dnInput) {
  dropdownDisplayName.addEventListener("click", (e) => {
    e.stopPropagation();
    profileDropdown?.classList.remove("show");
    accountSubmenu?.classList.remove("show");
    dnInput.value = getOwnDisplayName() || "";
    updateDnCounter();
    if (dnError) dnError.textContent = "";
    dnModal.classList.add("show");
    setTimeout(() => { dnInput.focus(); dnInput.select(); }, 0);
  });
}
if (dnInput) {
  dnInput.addEventListener("input", updateDnCounter);
  dnInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); handleDnSave(false); }
    if (e.key === "Escape") { e.preventDefault(); closeDnModal(); }
  });
}
if (dnCancelBtn) dnCancelBtn.addEventListener("click", (e) => { e.stopPropagation(); closeDnModal(); });
if (dnCloseBtn)  dnCloseBtn.addEventListener("click",  (e) => { e.stopPropagation(); closeDnModal(); });
if (dnResetBtn)  dnResetBtn.addEventListener("click",  (e) => { e.stopPropagation(); handleDnSave(true); });
if (dnSaveBtn)   dnSaveBtn.addEventListener("click",   (e) => { e.stopPropagation(); handleDnSave(false); });
if (dnModal) {
  dnModal.addEventListener("click", (e) => { if (e.target === dnModal) closeDnModal(); });
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
    location.href = "/";
  });
}

// ======================================================
// 🔑 PASSKEY-VERWALTUNG
// ======================================================
const dropdownPasskeys = document.getElementById("dropdown-passkeys");
const passkeysOverlay = document.getElementById("passkeys-overlay");
const passkeysList = document.getElementById("passkeys-list");
const btnAddPasskey = document.getElementById("btn-add-passkey");
const btnClosePasskeys = document.getElementById("btn-close-passkeys");

function formatDate(ts) {
  if (!ts) return lang.passkeyNeverUsed;
  const d = new Date(ts);
  return d.toLocaleDateString(lang.locale, { day: "numeric", month: "short", year: "numeric" });
}

async function loadPasskeys() {
  passkeysList.innerHTML = "";
  try {
    const res = await apiFetch("/auth/passkeys");
    const { passkeys } = res;
    if (!passkeys?.length) {
      passkeysList.innerHTML = `<div class="passkeys-empty">${lang.passkeyLoadFailed}</div>`;
      return;
    }
    passkeys.forEach((pk, _i) => {
      const item = document.createElement("div");
      item.className = "passkey-item";
      item.innerHTML = `
        <div class="passkey-icon">🔑</div>
        <div class="passkey-info">
          <span class="passkey-name" title="${lang.passkeyRename}">${pk.name || lang.passkeyUnnamed}</span>
          <div class="passkey-meta">${lang.passkeyCreated}: ${formatDate(pk.created_at)}${pk.last_used ? ` · ${lang.passkeyLastUsed}: ${formatDate(pk.last_used)}` : ` · ${lang.passkeyNeverUsed}`}</div>
        </div>
        <div class="passkey-actions">
          <button class="passkey-delete-btn" title="${lang.passkeyDelete}">${lang.passkeyDelete}</button>
        </div>
      `;

      // Umbenennen (Inline-Edit)
      const nameEl = item.querySelector(".passkey-name");
      nameEl.addEventListener("click", () => {
        const input = document.createElement("input");
        input.className = "passkey-name-input";
        input.value = pk.name || "";
        input.placeholder = lang.passkeyRenamePlaceholder;
        input.maxLength = 64;
        nameEl.replaceWith(input);
        input.focus();
        input.select();

        const save = async () => {
          const newName = input.value.trim();
          if (!newName || newName === (pk.name || "")) {
            input.replaceWith(nameEl);
            return;
          }
          try {
            await apiFetch("/auth/passkeys", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ credential_id: pk.credential_id, name: newName })
            });
            pk.name = newName;
            nameEl.textContent = newName;
          } catch {
            nameEl.textContent = pk.name || lang.passkeyUnnamed;
          }
          input.replaceWith(nameEl);
        };

        input.addEventListener("blur", save);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); input.blur(); }
          if (e.key === "Escape") { input.value = pk.name || ""; input.blur(); }
        });
      });

      // Löschen
      const deleteBtn = item.querySelector(".passkey-delete-btn");
      deleteBtn.addEventListener("click", async () => {
        if (passkeys.length <= 1) {
          alert(lang.passkeyDeleteLast);
          return;
        }
        if (!confirm(lang.passkeyDeleteConfirm)) return;
        try {
          await apiFetch("/auth/passkeys", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ credential_id: pk.credential_id })
          });
          loadPasskeys(); // Liste neu laden
        } catch {
          alert(lang.passkeyDeleteFailed);
        }
      });

      passkeysList.appendChild(item);
    });
  } catch {
    passkeysList.innerHTML = `<div class="passkeys-empty">${lang.passkeyLoadFailed}</div>`;
  }
}

// Dialog öffnen
if (dropdownPasskeys && passkeysOverlay) {
  dropdownPasskeys.addEventListener("click", (e) => {
    e.stopPropagation();
    profileDropdown.classList.remove("show");
    passkeysOverlay.classList.add("show");
    loadPasskeys();
  });
}

// Dialog schliessen
if (btnClosePasskeys) {
  btnClosePasskeys.addEventListener("click", () => {
    passkeysOverlay.classList.remove("show");
  });
}
if (passkeysOverlay) {
  passkeysOverlay.addEventListener("click", (e) => {
    if (e.target === passkeysOverlay) passkeysOverlay.classList.remove("show");
  });
}

// Passkey hinzufügen
if (btnAddPasskey) {
  btnAddPasskey.addEventListener("click", async () => {
    const handle = localStorage.getItem("my_user");
    if (!handle) return;

    const name = await showPromptDialog({
      title: lang.passkeyNamePrompt,
      placeholder: "",
      defaultValue: "",
      confirmLabel: "OK",
      cancelLabel: lang.cancelBtn || "Abbrechen",
    });
    if (name === null) return; // User hat abgebrochen

    btnAddPasskey.disabled = true;
    btnAddPasskey.textContent = lang.passkeyAdding;
    try {
      await addPasskey(handle, name || null);
      loadPasskeys(); // Liste aktualisieren
    } catch (err) {
      if (err.name !== "NotAllowedError") {
        alert(lang.passkeyAddFailed + (err.message ? "\n" + err.message : ""));
      }
    } finally {
      btnAddPasskey.disabled = false;
      btnAddPasskey.textContent = lang.passkeyAdd;
    }
  });
}

// ❌ Alle Dropdowns schließen bei Klick außerhalb
document.addEventListener("click", (e) => {
  if (!e.target.closest(".profile-wrapper")) {
    profileDropdown?.classList.remove("show");
    accountSubmenu?.classList.remove("show");
    document.getElementById("lang-submenu")?.style.setProperty("display", "none");
    document.getElementById("legal-submenu")?.style.setProperty("display", "none");
  }
});

// ⚖️ Rechtliches-Submenü
const legalBtn = document.getElementById("dropdown-legal");
const legalSubmenu = document.getElementById("legal-submenu");
if (legalBtn && legalSubmenu) {
  legalBtn.addEventListener("click", (e) => {
    // Klick auf einen Link innerhalb des Submenüs soll normal navigieren
    if (e.target.closest("#legal-submenu a")) return;
    e.stopPropagation();
    legalSubmenu.style.display = legalSubmenu.style.display === "block" ? "none" : "block";
  });
}

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

  await loadMutedConvos();
  loadContacts();
  loadGroups();
  // 🔄 Inbox automatisch aktualisieren — 30s statt 8s (Rate-Limit-Schutz).
  // Realtime-Updates kommen ohnehin via WebSocket/BroadcastChannel, das Polling
  // ist nur Fallback bei verpassten Events. 30s reicht; spart bei Multi-Device
  // ~73% der Requests pro Endpoint.
  window._contactsInterval = setInterval(loadContacts, 30000);
  setInterval(loadGroups, 30000);
  setInterval(loadMutedConvos, MUTED_TTL_MS); // Mute-Status alle 10min sync

  // 🔔 Echtzeit: Kontaktanfrage akzeptiert → sofort neu laden (kein Warten auf Poll)
  if ("BroadcastChannel" in window) {
    const bc = new BroadcastChannel("renex-control");
    bc.onmessage = (e) => {
      // Signatur-Prüfung: nur Events vom eigenen Tab akzeptieren
      const bcToken = sessionStorage.getItem("renex_bc_token");
      if (!bcToken || e.data?._bcToken !== bcToken) return;
      const type = e.data?.type;
      if (type === "CONTACT_ACCEPTED" || type === "CONTACT_UPDATE") loadContacts();

      // 🔔 Reaction-Toast: nur wenn meine Nachricht reagiert wurde (kein Badge)
      if (type === "REACTION_UPDATED" && e.data?.action === "added") {
        const myUser = (localStorage.getItem("my_user") || "").toLowerCase();
        const msgAuthor = (e.data?.msgAuthor || "").toLowerCase();
        const reactor   = (e.data?.from || "").toLowerCase();
        if (msgAuthor === myUser && reactor !== myUser) {
          const convoId = e.data?.convoId || null;
          // Für DMs (convoId = "handle1:handle2") direkt den Reactor-Handle verwenden,
          // damit kein "alice:bob"-Flash im Chat-Header entsteht
          const _isDmConvo = convoId && /^[a-z0-9_]{1,32}:[a-z0-9_]{1,32}$/i.test(convoId);
          // Für Groups: Namen aus _currentGroups holen, damit kein UUID-Flash entsteht
          const _groupName = !_isDmConvo ? (_currentGroups.find(g => g.id === convoId)?.name || null) : null;
          const reactorLabel = reactor && reactor !== "undefined" ? reactor : "Jemand";
          showToast({
            icon: e.data?.emoji || "💬",
            title: `${reactorLabel} hat auf deine Nachricht reagiert`,
            sub: "",
            groupId: _isDmConvo ? reactor : convoId,
            groupName: _groupName,
            durationMs: 4000
          });
        }
      }

      if (type === "NEW_MESSAGE" || type === "GSK_READY" || type === "GROUP_MEMBER_JOINED" || type === "GROUP_MEMBER_LEFT") {
        _lastContactsKey = null;
        _lastGroupsKey   = null;
        loadContacts();
        loadGroups().then(() => {
          // Toast: Gruppe beigetreten (nur wenn ich selbst der neue Member bin)
          if (type === "GROUP_MEMBER_JOINED") {
            const myUser = (localStorage.getItem("my_user") || "").toLowerCase();
            const evHandle    = (e.data?.handle    || "").toLowerCase();
            const invitedBy   = e.data?.invitedBy  || "";
            const groupId     = e.data?.groupId    || null;
            if (evHandle === myUser) {
              // Gruppenname aus _currentGroups holen (nach loadGroups)
              const grp = _currentGroups.find(g => g.id === groupId);
              const groupName = grp?.name || lang.newGroup;
              showToast({
                icon: "👥",
                title: lang.groupInviteToast(groupName),
                sub: invitedBy ? lang.invitedByPrefix(invitedBy) : "",
                groupId,
                durationMs: 6000
              });
            }
          }
        }).catch(() => {});
      }
    };
  } else {
    window.addEventListener("storage", (e) => {
      if (e.key === "renex-control-event") {
        try {
          const ev = JSON.parse(e.newValue || "{}");
          if (ev.type === "CONTACT_ACCEPTED" || ev.type === "CONTACT_UPDATE") loadContacts();
          if (ev.type === "NEW_MESSAGE") {
            _lastContactsKey = null;
            _lastGroupsKey   = null;
            loadContacts();
            loadGroups();
          }
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

  // Tab-Wechsel / App-Vordergrund: Seite wieder sichtbar → sofort aktualisieren
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
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

  const addContactBtn   = document.getElementById("add-contact-btn");
  const addContactPopup = document.getElementById("add-contact-popup");

  function switchTab(tab) {
    tabBtns.forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
    tabPanels.forEach(p => p.classList.toggle("active", p.id === `panel-${tab}`));
    localStorage.setItem("inbox_tab", tab);
    // Popups beim Tab-Wechsel schliessen
    if (addContactPopup && tab !== "chats")  addContactPopup.style.display  = "none";
    if (createGroupPopup && tab !== "groups") closeGroupPopup();
  }

  // Add-Contact-FAB toggle
  addContactBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!addContactPopup) return;
    const isOpen = addContactPopup.style.display === "block";
    addContactPopup.style.display = isOpen ? "none" : "block";
    if (!isOpen && !navigator.maxTouchPoints) setTimeout(() => addInput?.focus(), 50);
  });

  // ✕-Button schliesst das Popup
  document.getElementById("add-contact-close")?.addEventListener("click", () => {
    if (addContactPopup) addContactPopup.style.display = "none";
  });

  // Klick ausserhalb schliesst das Popup
  document.addEventListener("click", (e) => {
    if (addContactPopup?.style.display === "block"
        && !addContactPopup.contains(e.target)
        && e.target !== addContactBtn) {
      addContactPopup.style.display = "none";
    }
  });

  tabBtns.forEach(btn => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

  // Letzten Tab wiederherstellen (contacts-Tab existiert nicht mehr → chats)
  const savedTab = localStorage.getItem("inbox_tab");
  switchTab(savedTab === "groups" ? "groups" : "chats");
}

// ================================================================
// DEBUG / DIAGNOSE OVERLAY (MODULE-LEVEL — läuft IMMER, auch ohne Login)
// Wichtig: dieser Block MUSS außerhalb von runInboxInit() bleiben,
// damit der Debug-Button auch verfügbar ist wenn der User auf der
// Login-Seite ist oder seine Session abgelaufen ist.
// ================================================================
{
  const dropdownDebug = document.getElementById("dropdown-debug");
  const debugOverlay = document.getElementById("debug-overlay");
  const btnCloseDebug = document.getElementById("btn-close-debug");
  const btnDebugRefresh = document.getElementById("btn-debug-refresh");
  const btnDebugTestPush = document.getElementById("btn-debug-test-push");
  const btnDebugCopy = document.getElementById("btn-debug-copy");
  const btnDebugResub = document.getElementById("btn-debug-resub");
  const _debugSnapshot = {};

  function _setVal(id, value, cls) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = String(value ?? "—");
    if (cls) {
      el.classList.remove("ok", "warn", "error");
      el.classList.add(cls);
    }
    _debugSnapshot[id] = value;
  }

  function _setOutput(id, obj) {
    const el = document.getElementById(id);
    if (!el) return;
    const text = (typeof obj === "string") ? obj : JSON.stringify(obj, null, 2);
    el.textContent = text;
    _debugSnapshot[id] = obj;
  }

  async function refreshDebugInfo() {
    const perm = (typeof Notification !== "undefined") ? Notification.permission : "unavailable";
    const permClass = perm === "granted" ? "ok" : (perm === "denied" ? "error" : "warn");
    _setVal("dbg-notif-perm", perm, permClass);

    let swState = "not-supported";
    let swCls = "error";
    try {
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.getRegistration("/");
        if (reg) {
          const active = reg.active ? "active" : (reg.installing ? "installing" : "waiting");
          swState = `${active} (scope=${reg.scope})`;
          swCls = reg.active ? "ok" : "warn";
        } else {
          swState = "no-registration";
          swCls = "error";
        }
      }
    } catch (e) {
      swState = "error: " + e.message;
      swCls = "error";
    }
    _setVal("dbg-sw-state", swState, swCls);

    let pushSub = "(none)";
    let pushCls = "warn";
    try {
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.getRegistration("/");
        if (reg) {
          const s = await reg.pushManager.getSubscription();
          if (s) {
            const j = s.toJSON();
            pushSub = `endpoint=${(j.endpoint || "").slice(0, 50)}…`;
            pushCls = "ok";
          }
        }
      }
    } catch (e) {
      pushSub = "error: " + e.message;
      pushCls = "error";
    }
    _setVal("dbg-push-sub", pushSub, pushCls);

    const hasBadge = typeof navigator.setAppBadge === "function";
    _setVal("dbg-badge-api", hasBadge ? "supported" : "not-supported", hasBadge ? "ok" : "warn");

    _setVal("dbg-user-handle", localStorage.getItem("my_user") || "(not logged in)");
    _setVal("dbg-device-id", localStorage.getItem("renex_device_id") || "(none)");

    const appVersion = document.querySelector('meta[name="renex-version"]')?.content || "(unknown)";
    _setVal("dbg-app-version", appVersion);

    const isPwa = window.matchMedia("(display-mode: standalone)").matches
                || window.navigator.standalone === true;
    _setVal("dbg-pwa-mode", isPwa ? "PWA (standalone)" : "Browser-Tab", isPwa ? "ok" : "warn");

    _setVal("dbg-user-agent", navigator.userAgent);
    _setVal("dbg-local-time", new Date().toISOString() + " (" + Intl.DateTimeFormat().resolvedOptions().timeZone + ")");

    try {
      const r = await fetch(`${API}/push/status`, { credentials: "include" });
      if (!r.ok) {
        _setOutput("dbg-push-status", `HTTP ${r.status} ${r.statusText}`);
      } else {
        const d = await r.json();
        _setOutput("dbg-push-status", d);
      }
    } catch (e) {
      _setOutput("dbg-push-status", "Fetch error: " + e.message);
    }
  }

  // Force-Re-Subscribe: bewusst OHNE silent-catch, jeder Fehler wird im UI angezeigt.
  // Dies ist das Diagnose-Tool für "Permission granted aber keine Subscription"-Bug auf iOS PWA.
  async function forceResubscribe() {
    if (!btnDebugResub) return;
    btnDebugResub.disabled = true;
    const origLabel = btnDebugResub.textContent;
    btnDebugResub.textContent = "⏳ …";
    const log = [];
    const step = (msg, val) => {
      log.push(`[${new Date().toISOString().slice(11, 19)}] ${msg}` + (val !== undefined ? ": " + JSON.stringify(val) : ""));
      _setOutput("dbg-resub-result", log.join("\n"));
    };

    try {
      // Schritt 1: Service Worker bereit?
      step("1. SW: navigator.serviceWorker.ready");
      if (!("serviceWorker" in navigator)) throw new Error("Service Worker not supported");
      const reg = await navigator.serviceWorker.ready;
      step("   → SW scope", reg.scope);

      // Schritt 2: Permission state
      step("2. Notification.permission", Notification.permission);
      if (Notification.permission !== "granted") {
        throw new Error("Notification permission not granted (current: " + Notification.permission + "). Erlaube zuerst Notifications.");
      }

      // Schritt 3: Bestehende Subscription prüfen
      step("3. existing subscription check");
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        step("   → existing subscription found, unsubscribing first");
        await existing.unsubscribe();
        step("   → unsubscribed OK");
      } else {
        step("   → no existing subscription");
      }

      // Schritt 4: VAPID-Key vom Backend holen
      step("4. fetch /push/vapid-key");
      const vRes = await fetch(`${API}/push/vapid-key`);
      step("   → status", vRes.status);
      if (!vRes.ok) throw new Error("VAPID-Key fetch failed: HTTP " + vRes.status);
      const vData = await vRes.json();
      if (!vData.publicKey) throw new Error("VAPID response missing publicKey");
      step("   → publicKey length", vData.publicKey.length);

      // Schritt 5: Key dekodieren
      step("5. decode VAPID base64url → Uint8Array");
      const k = vData.publicKey;
      const padding = "=".repeat((4 - (k.length % 4)) % 4);
      const base64 = (k + padding).replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      step("   → bytes length", bytes.length);

      // Schritt 6: pushManager.subscribe — DIESER CALL kann auf iOS scheitern
      step("6. pushManager.subscribe({userVisibleOnly:true, applicationServerKey})");
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: bytes,
      });
      step("   → SUBSCRIBE OK");
      const subJson = sub.toJSON();
      step("   → endpoint", (subJson.endpoint || "").slice(0, 60) + "…");
      step("   → keys.p256dh present", !!subJson.keys?.p256dh);
      step("   → keys.auth present", !!subJson.keys?.auth);

      // Schritt 7: An Backend senden
      step("7. POST /push/subscribe");
      const sRes = await fetch(`${API}/push/subscribe`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: subJson.endpoint,
          keys: subJson.keys,
          transport_type: "web_push",
        }),
      });
      step("   → status", sRes.status);
      if (!sRes.ok) {
        const err = await sRes.text();
        throw new Error("Backend subscribe failed: " + sRes.status + " " + err);
      }

      step("✅ ERFOLG — Subscription registriert");
      btnDebugResub.textContent = "✅ Erfolgreich!";
    } catch (e) {
      step("❌ FEHLER", { name: e.name, message: e.message });
      btnDebugResub.textContent = "❌ Fehler — siehe Output";
    } finally {
      setTimeout(() => {
        btnDebugResub.textContent = origLabel;
        btnDebugResub.disabled = false;
      }, 4000);
    }
  }

  async function sendTestPush() {
    if (!btnDebugTestPush) return;
    btnDebugTestPush.disabled = true;
    const orig = btnDebugTestPush.textContent;
    btnDebugTestPush.textContent = "⏳ Sende…";
    _setOutput("dbg-test-result", "Wird gesendet…");
    try {
      const r = await fetch(`${API}/push/test`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const d = await r.json();
      _setOutput("dbg-test-result", d);
      btnDebugTestPush.textContent = d.ok ? "✅ Gesendet!" : "⚠️ Fehler — siehe Resultat";
      setTimeout(() => {
        btnDebugTestPush.textContent = orig;
        btnDebugTestPush.disabled = false;
      }, 3000);
    } catch (e) {
      _setOutput("dbg-test-result", "Fetch error: " + e.message);
      btnDebugTestPush.textContent = orig;
      btnDebugTestPush.disabled = false;
    }
  }

  async function copyDebugSnapshot() {
    const lines = [
      "RENEX Debug Snapshot",
      "Generated: " + new Date().toISOString(),
      "─────────────────────────────",
      "",
      "Notifications & Service Worker:",
      `  Notification.permission: ${_debugSnapshot["dbg-notif-perm"]}`,
      `  Service Worker:          ${_debugSnapshot["dbg-sw-state"]}`,
      `  Push Subscription:       ${_debugSnapshot["dbg-push-sub"]}`,
      `  setAppBadge API:         ${_debugSnapshot["dbg-badge-api"]}`,
      "",
      "User & Device:",
      `  my_user:        ${_debugSnapshot["dbg-user-handle"]}`,
      `  deviceId:       ${_debugSnapshot["dbg-device-id"]}`,
      `  App-Version:    ${_debugSnapshot["dbg-app-version"]}`,
      `  PWA-Mode:       ${_debugSnapshot["dbg-pwa-mode"]}`,
      `  Lokalzeit:      ${_debugSnapshot["dbg-local-time"]}`,
      `  User-Agent:     ${_debugSnapshot["dbg-user-agent"]}`,
      "",
      "Backend /push/status:",
      "  " + JSON.stringify(_debugSnapshot["dbg-push-status"], null, 2).split("\n").join("\n  "),
      "",
      "Re-Subscribe-Resultat:",
      "  " + (typeof _debugSnapshot["dbg-resub-result"] === "string"
              ? _debugSnapshot["dbg-resub-result"].split("\n").join("\n  ")
              : "(nicht ausgeführt)"),
      "",
      "Test-Push-Resultat:",
      "  " + JSON.stringify(_debugSnapshot["dbg-test-result"] || "(nicht ausgeführt)", null, 2).split("\n").join("\n  "),
    ];
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;opacity:0;";
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    }
    if (btnDebugCopy) {
      const orig = btnDebugCopy.textContent;
      btnDebugCopy.textContent = "✅ Kopiert!";
      setTimeout(() => { btnDebugCopy.textContent = orig; }, 2000);
    }
  }

  if (dropdownDebug && debugOverlay) {
    dropdownDebug.addEventListener("click", (e) => {
      e.stopPropagation();
      document.getElementById("profile-dropdown")?.classList.remove("show");
      debugOverlay.classList.add("show");
      refreshDebugInfo();
    });
  }
  if (btnCloseDebug) btnCloseDebug.addEventListener("click", () => debugOverlay?.classList.remove("show"));
  if (debugOverlay) {
    debugOverlay.addEventListener("click", (e) => {
      if (e.target === debugOverlay) debugOverlay.classList.remove("show");
    });
  }
  if (btnDebugRefresh) btnDebugRefresh.addEventListener("click", refreshDebugInfo);
  if (btnDebugResub) btnDebugResub.addEventListener("click", forceResubscribe);
  if (btnDebugTestPush) btnDebugTestPush.addEventListener("click", sendTestPush);
  if (btnDebugCopy) btnDebugCopy.addEventListener("click", copyDebugSnapshot);

  window.__renexDebug = { refresh: refreshDebugInfo, resub: forceResubscribe, test: sendTestPush, copy: copyDebugSnapshot };
}

// Gate: Init nur laufen lassen, wenn `my_user` bereits da ist.
// Sonst warten bis das "renex-user-ready"-Event gefeuert wird — das feuert
// der async Auth-Check in index.html/inbox.html sobald handle gesetzt ist.
// Fix für iOS-PWA: Session-Cookie kommt aus Safari, localStorage NICHT →
// `my_user` wird asynchron aus /auth/session gespiegelt. Ohne dieses Gate
// would inbox.js bei DOMContentLoaded return'en → Chats+Gruppen leer.
let _inboxInitDone = false;
function triggerInboxInit() {
  if (_inboxInitDone) return;
  _inboxInitDone = true;
  runInboxInit().catch(err => console.warn("inbox init failed:", err));
}
document.addEventListener("DOMContentLoaded", () => {
  // Gast-Handles (guest_*) sind keine echten Logins → inbox.js darf keine
  // authentifizierten Requests feuern (sonst 401 für /chat/unread, /contacts/list, …).
  const _u = localStorage.getItem("my_user") || "";
  if (_u && !_u.startsWith("guest_")) {
    triggerInboxInit();
  }
  // Sonst: auf renex-user-ready warten (dispatched aus index.html/inbox.html
  // nach erfolgreichem /auth/session Check).
});
window.addEventListener("renex-user-ready", triggerInboxInit);

// ================================
// LOAD CONTACTS
// ================================
// Tab-Badge Helper
function updateTabBadge(tab, count) {
  const el = document.getElementById(`strip-badge-${tab}`) || document.getElementById(`tab-badge-${tab}`);
  if (!el) return;
  if (count > 0) {
    const text = count > 99 ? "99+" : String(count);
    el.textContent = text;
    el.classList.add("visible");
    el.classList.toggle("wide", text.length > 1);
  } else {
    el.textContent = "";
    el.classList.remove("visible", "wide");
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
    if (!unreadData.rateLimited) unreadMap = unreadData.unread || {};
  } catch (e) {
    console.warn("Unread fetch failed", e);
    unreadMap = {};
  }

  try {
    // ETag: 304 → kein Re-Render nötig
    const API = window._API || "https://api.renex.id";
    let contactsRes;
    try {
      contactsRes = await fetch(API + "/contacts/list", {
        credentials: "include",
        headers: {
          ...(_contactsEtag ? { "If-None-Match": _contactsEtag } : {})
        }
      });
    } catch (networkErr) {
      // Network Error / CORS-Block bei Preflight 429 → still skippen
      console.warn("Contacts fetch failed (network):", networkErr.message);
      return;
    }
    if (contactsRes.status === 304) return; // nichts geändert
    if (contactsRes.status === 429) return; // Rate limited → still skippen
    if (!contactsRes.ok) throw new Error(contactsRes.statusText);
    _contactsEtag = contactsRes.headers.get("ETag") || _contactsEtag;
    const data = await contactsRes.json();
    const contacts = Array.isArray(data.contacts) ? data.contacts : [];

    // 🚫 Kein Re-Render wenn sich nichts geändert hat → kein Blinken
    // Preview-Cache-State einbeziehen: wenn chat.js preview aktualisiert → Re-Render
    const myUser = (localStorage.getItem("my_user") || "").toLowerCase();
    const previewState = contacts
      .filter(c => c.status === "accepted")
      .map(c => localStorage.getItem(`renex_preview_${dmConvoId(myUser, c.handle)}`) || "")
      .join("|");
    const cacheKey = JSON.stringify(contacts) + JSON.stringify(unreadMap) + "|" + previewState;
    if (cacheKey === _lastContactsKey) return;
    _lastContactsKey = cacheKey;

    const pendingBanner = document.getElementById("pending-banner");
    const pendingCountEl = document.getElementById("pending-count");
    pendingEl.innerHTML = "";
    acceptedEl.innerHTML = "";

    if (contacts.length === 0) {
      if (pendingBanner) pendingBanner.style.display = "none";
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

    // Display Names aller (echten) Kontakte vorwärmen — aktualisiert die UI
    // asynchron sobald Profile aus KV geladen sind.
    const realHandles = contacts
      .map(c => c.handle)
      .filter(h => h && !h.startsWith("guest_"));
    prefetchProfiles(realHandles).catch(() => {});

    // Banner: bei jeglichen pending Anfragen (in + out) anzeigen
    const incomingCount = contacts.filter(c => c.status === "pending" && c.direction === "in").length;
    const outgoingCount = contacts.filter(c => c.status === "pending" && c.direction === "out").length;
    const pendingCount  = incomingCount + outgoingCount;

    // Hilfsfunktion: einen Banner (Chats oder Gruppen) aktualisieren
    function syncPendingBanner(bannerEl, countEl) {
      if (!bannerEl) return;
      if (pendingCount > 0) {
        bannerEl.style.display = "flex";
        if (countEl) countEl.textContent = pendingCount;
      } else {
        bannerEl.style.display = "none";
      }
    }

    syncPendingBanner(pendingBanner, pendingCountEl);
    syncPendingBanner(
      document.getElementById("pending-banner-groups"),
      document.getElementById("pending-count-groups")
    );

    if (!acceptedEl.children.length) {
      acceptedEl.appendChild(emptyLi(lang.noContacts));
    }

    // Suchfeld: ab SEARCH_MIN akzeptierten Kontakten einblenden
    const acceptedCount = contacts.filter(c => c.status === "accepted").length;
    if (searchChats) {
      searchChats.style.display = acceptedCount >= SEARCH_MIN ? "block" : "none";
      if (acceptedCount < SEARCH_MIN) searchChats.value = "";
      else applySearch(searchChats, acceptedEl);
    }

    // Tab-Badge: Anzahl nicht-stummgeschalteter Kontakte mit ungelesenen Nachrichten
    const myUserBadge = (localStorage.getItem("my_user") || "").toLowerCase();
    const unreadContacts = contacts
      .filter(c => c.status === "accepted")
      .filter(c => (unreadMap[c.handle] || 0) > 0)
      .filter(c => !_mutedConvos.has(dmConvoId(myUserBadge, c.handle)))
      .length;
    updateTabBadge("dms", unreadContacts); // strip-badge-dms im Icon-Strip

    // App-Icon Badge (PWA Home-Bildschirm Zähler)
    const groupUnread = _currentGroups ? _currentGroups.filter(g => isGroupUnread(g)).length : 0;
    const totalUnread = unreadContacts + groupUnread;
    updateBadge(totalUnread);

    // Presence-Dots für akzeptierte Kontakte (fire-and-forget)
    const acceptedHandles = contacts.filter(c => c.status === "accepted").map(c => c.handle);
    if (acceptedHandles.length > 0) {
      fetchPresence(acceptedHandles).then(presence => {
        // Status-Dots
        document.querySelectorAll("[data-presence-handle]").forEach(wrap => {
          const handle = wrap.dataset.presenceHandle;
          const dot = wrap.querySelector(".contact-dot");
          if (!dot) return;
          const p = presence?.[handle];
          dot.className = "contact-dot";
          if (p?.online) {
            dot.classList.add("online");
          } else if (p?.lastSeen && (Date.now() - Number(p.lastSeen)) < 300_000) {
            dot.classList.add("idle");
          }
        });

        // Presence Labels ("online" / "vor X Min.")
        document.querySelectorAll("[data-presence-label]").forEach(label => {
          const handle = label.dataset.presenceLabel;
          const p = presence?.[handle];
          if (p?.online) {
            label.textContent = "online";
            label.className = "contact-presence-label online";
          } else if (p?.lastSeen) {
            const diff = Date.now() - Number(p.lastSeen);
            if (diff < 300_000) {
              label.textContent = `vor ${Math.floor(diff / 60_000) || 1} Min.`;
            } else {
              label.textContent = formatLastSeen(p.lastSeen);
            }
            label.className = "contact-presence-label";
          } else {
            label.textContent = "";
          }
        });
      }).catch(() => {});
    }

  } catch (err) {
    if (!localStorage.getItem("my_user")) return;
    console.warn("Load contacts failed:", err);
  }
}

// ================================
// RENDER
// ================================
function renderPending(contact) {
  const rawHandle = contact.display_handle || contact.handle;
  const shownName = getDisplayName(contact.handle, rawHandle);
  const initial   = shownName.charAt(0).toUpperCase();
  const isOut     = contact.direction === "out";

  // ── Helper: Banner nach Aktion aktualisieren ──────────
  function updateBannersAfterAction() {
    const remaining  = pendingEl.querySelectorAll("li").length;
    const pCount     = document.getElementById("pending-count");
    const pCountG    = document.getElementById("pending-count-groups");
    if (pCount)  pCount.textContent  = remaining;
    if (pCountG) pCountG.textContent = remaining;
    if (remaining === 0) {
      if (pendingBannerEl) pendingBannerEl.style.display = "none";
      const groupsBanner = document.getElementById("pending-banner-groups");
      if (groupsBanner) groupsBanner.style.display = "none";
      closeRequestsModal();
    }
  }

  // ── Card (wie contact-card) ───────────────────────────
  const li = document.createElement("li");
  li.className = "contact-card";
  if (!isOut) li.dataset.pendingIn = "1";

  // Avatar
  const avatarWrap = document.createElement("div");
  avatarWrap.className = "contact-avatar-wrap";
  const avatar = document.createElement("div");
  avatar.className = "contact-avatar";
  avatar.textContent = initial;
  avatarWrap.appendChild(avatar);

  // Info
  const info = document.createElement("div");
  info.className = "contact-info";

  const topRow = document.createElement("div");
  topRow.className = "contact-top-row";
  const nameEl = document.createElement("span");
  nameEl.className = "contact-name";
  nameEl.textContent = shownName;
  topRow.appendChild(nameEl);
  info.appendChild(topRow);

  // Subtext
  const sub = document.createElement("span");
  sub.className = "contact-preview";
  sub.style.fontStyle = "italic";
  sub.textContent = isOut
    ? (lang.requestSent?.trim() || "request sent")
    : (lang.requestWantsToConnect || "wants to connect");
  info.appendChild(sub);

  li.appendChild(avatarWrap);
  li.appendChild(info);

  // ── AUSGEHENDE Anfrage: Zurückziehen-Button ───────────
  if (isOut) {
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "contact-remove-btn";
    cancelBtn.title = lang.requestWithdraw || "Withdraw";
    cancelBtn.textContent = "✕";
    cancelBtn.style.opacity = "1";
    cancelBtn.style.color = "var(--text-muted)";
    cancelBtn.onclick = async (e) => {
      e.stopPropagation();
      cancelBtn.disabled = true;
      try {
        await apiFetch("/contacts/cancel", { method: "POST", body: JSON.stringify({ contact: contact.handle }) });
        li.remove();
        updateBannersAfterAction();
        _lastContactsKey = null;
        loadContacts();
      } catch (err) {
        console.warn("Cancel failed:", err);
        cancelBtn.disabled = false;
      }
    };
    li.appendChild(cancelBtn);
    return li;
  }

  // ── EINGEHENDE Anfrage: Accept + Reject Buttons ───────
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:16px;flex-shrink:0;align-items:center;";

  const rejectBtn = document.createElement("button");
  rejectBtn.className = "contact-remove-btn";
  rejectBtn.title = lang.rejectBtn || "Reject";
  rejectBtn.textContent = "✕";
  rejectBtn.style.cssText = "opacity:1;color:var(--status-error);font-size:17px;padding:10px;min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;";
  rejectBtn.onclick = async (e) => {
    e.stopPropagation();
    rejectBtn.disabled = true;
    li.remove();
    updateBannersAfterAction();
    try {
      await apiFetch("/contacts/reject", { method: "POST", body: JSON.stringify({ contact: contact.handle }) });
    } catch (err) { console.warn("Reject failed:", err); }
    _lastContactsKey = null;
    loadContacts();
  };

  const acceptBtn = document.createElement("button");
  acceptBtn.title = lang.acceptBtn || "Accept";
  acceptBtn.textContent = "✓";
  acceptBtn.style.cssText = "background:none;border:none;color:var(--status-speaking);font-size:20px;font-weight:700;cursor:pointer;padding:10px;min-width:44px;min-height:44px;border-radius:6px;flex-shrink:0;line-height:1;transition:opacity 0.15s;display:flex;align-items:center;justify-content:center;";
  acceptBtn.onmouseenter = () => { acceptBtn.style.opacity = "0.75"; };
  acceptBtn.onmouseleave = () => { acceptBtn.style.opacity = "1"; };
  acceptBtn.onclick = async (e) => {
    e.stopPropagation();
    acceptBtn.disabled = true;
    li.remove();
    updateBannersAfterAction();
    try {
      await apiFetch("/contacts/accept", { method: "POST", body: JSON.stringify({ contact: contact.handle }) });
    } catch (err) { console.warn("Accept failed:", err); }
    _lastContactsKey = null;
    loadContacts();
  };

  actions.appendChild(rejectBtn);
  actions.appendChild(acceptBtn);
  li.appendChild(actions);

  return li;
}

function renderAccepted(contact) {
  const rawHandle = contact.display_handle || contact.handle;
  const baseName  = rawHandle.startsWith("guest_") ? guestDisplayName(rawHandle) : rawHandle;
  // Für echte User bevorzugen wir den vom User gesetzten Display Name (Profil),
  // Gäste behalten ihren guestDisplayName-Transform unverändert.
  const handle    = rawHandle.startsWith("guest_") ? baseName : getDisplayName(contact.handle, baseName);
  const myUser    = (localStorage.getItem("my_user") || "").toLowerCase();
  const convoId = dmConvoId(myUser, contact.handle);
  const isMuted = _mutedConvos.has(convoId);
  const unread  = isMuted ? 0 : (unreadMap[contact.handle] || 0);
  const cached  = getPreviewCache(convoId);
  const { text: previewText, muted: previewMuted } = buildPreviewText(cached, contact.last_ts, myUser, contact.handle, false);

  const li = document.createElement("li");
  li.className = "contact-card";
  li.dataset.searchName = (handle + " " + contact.handle).toLowerCase();
  li.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    document.querySelectorAll(".contact-card").forEach(c => c.classList.remove("active"));
    li.classList.add("active");
    if (typeof window.openChatPanel === "function") {
      window.openChatPanel(contact.handle);
    } else {
      window.location.href = `/chat?with=${encodeURIComponent(contact.handle)}`;
    }
  });

  // ── Avatar + Status-Dot ──
  const avatarWrap = document.createElement("div");
  avatarWrap.className = "contact-avatar-wrap";
  avatarWrap.dataset.presenceHandle = contact.handle.toLowerCase();

  const avatar = document.createElement("div");
  avatar.className = "contact-avatar";
  avatar.textContent = handle[0].toUpperCase();

  const presenceDot = document.createElement("span");
  presenceDot.className = "contact-dot";

  avatarWrap.appendChild(avatar);
  avatarWrap.appendChild(presenceDot);

  // ── Info ──
  const info = document.createElement("div");
  info.className = "contact-info";

  // Top row: name + time
  const topRow = document.createElement("div");
  topRow.className = "contact-top-row";

  const nameEl = document.createElement("span");
  nameEl.className = "contact-name" + (unread > 0 ? " unread" : "");
  nameEl.textContent = handle;
  if (!rawHandle.startsWith("guest_")) {
    nameEl.dataset.profileHandle = contact.handle;
    nameEl.dataset.profileFallback = baseName;
  }

  const timeMeta = document.createElement("span");
  timeMeta.className = "contact-time" + (unread > 0 ? " unread" : "");
  timeMeta.textContent = formatTime(contact.last_ts);

  topRow.appendChild(nameEl);
  topRow.appendChild(timeMeta);

  // Presence label: "online" / "vor X Min." / leer
  const presenceLabel = document.createElement("span");
  presenceLabel.className = "contact-presence-label";
  presenceLabel.dataset.presenceLabel = contact.handle.toLowerCase();
  info.appendChild(topRow);
  info.appendChild(presenceLabel);

  // Bottom row: preview + badge/presence
  const bottomRow = document.createElement("div");
  bottomRow.className = "contact-bottom-row";

  const preview = document.createElement("span");
  preview.className = "contact-preview" + (previewMuted ? " muted" : "");
  preview.textContent = previewText;

  bottomRow.appendChild(preview);

  if (isMuted) {
    const muteIcon = document.createElement("span");
    muteIcon.textContent = "🔕";
    muteIcon.style.cssText = "font-size:11px;opacity:0.4;flex-shrink:0;";
    bottomRow.appendChild(muteIcon);
  } else if (unread > 0) {
    const badge = document.createElement("span");
    badge.className = "contact-badge";
    badge.textContent = unread > 99 ? "99+" : String(unread);
    bottomRow.appendChild(badge);
  }

  info.appendChild(bottomRow);

  // ── Remove button (hidden until hover) ──
  const removeBtn = document.createElement("button");
  removeBtn.className = "contact-remove-btn";
  removeBtn.textContent = "✕";
  removeBtn.title = lang.removeFromList;
  removeBtn.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm(lang.confirmRemoveContact(contact.handle))) return;
    try {
      await apiFetch("/contacts/remove", { method: "POST", body: JSON.stringify({ contact: contact.handle }) });
      loadContacts();
    } catch { alert(lang.removeContactFailed); }
  };

  li.appendChild(avatarWrap);
  li.appendChild(info);
  li.appendChild(removeBtn);
  return li;
}

function renderDeleted(contact) {
  const li = document.createElement("li");
  li.style.opacity = "0.5";

  const name = document.createElement("span");
  name.textContent = getDisplayName(contact.handle, contact.display_handle || contact.handle);
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
    if (data.rateLimited) return; // Rate limited → bestehende UI behalten
    const groups = Array.isArray(data.groups) ? data.groups : [];
    // Preview- UND Lesestatus-State einbeziehen → Re-Render bei jeder Änderung
    const previewState = groups.map(g =>
      (localStorage.getItem(`renex_preview_${g.id}`) || "") + ";" +
      (localStorage.getItem(`renex_group_read_${g.id}`) || "")
    ).join("|");
    const cacheKey = JSON.stringify(groups) + "|" + previewState;
    if (cacheKey === _lastGroupsKey) return;
    _lastGroupsKey = cacheKey;

    _currentGroups = groups;
    refreshGroupBadge();
    groupsEl.innerHTML = "";
    if (groups.length === 0) {
      groupsEl.appendChild(emptyLi(lang.noGroups));
      if (searchGroups) { searchGroups.style.display = "none"; searchGroups.value = ""; }
      return;
    }
    groups.forEach(g => groupsEl.appendChild(renderGroup(g)));

    // Presence: alle Member-Handles aller Gruppen batch-abfragen
    const allHandles = [...new Set(
      groups.flatMap(g => (g.member_handles || "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean))
    )];
    if (allHandles.length > 0) {
      fetchPresence(allHandles).then(presence => {
        groups.forEach(g => {
          const handles = (g.member_handles || "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
          const onlineCount = handles.filter(h => presence?.[h]?.online).length;
          if (onlineCount === 0) return;
          // Online-Count-Element suchen (data-group-online auf dem li)
          const li = groupsEl.querySelector(`[data-group-id="${g.id}"]`);
          const onlineEl = li?.querySelector("[data-online-count]");
          if (onlineEl) {
            const total = (g.member_count || 0);
            if (onlineCount > 0) {
              onlineEl.innerHTML = `${onlineCount} <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#4ade80;margin:0 4px;vertical-align:middle;"></span>· ${lang.membersLabel(total)}`;
              onlineEl.style.color = "var(--text-secondary)";
            } else {
              onlineEl.textContent = lang.membersLabel(total);
              onlineEl.style.color = "var(--text-secondary)";
            }
          }
        });
      }).catch(() => {});
    }

    // Suchfeld: ab SEARCH_MIN Gruppen einblenden
    if (searchGroups) {
      searchGroups.style.display = groups.length >= SEARCH_MIN ? "block" : "none";
      if (groups.length < SEARCH_MIN) searchGroups.value = "";
      else applySearch(searchGroups, groupsEl);
    }
  } catch (e) {
    console.warn("loadGroups fehlgeschlagen", e);
  }
}

function renderGroup(group) {
  const isUnread = isGroupUnread(group);

  const li = document.createElement("li");
  li.className = "contact-card";
  li.dataset.searchName = group.name.toLowerCase();
  li.dataset.groupId = group.id;
  li.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    markGroupSeen(group.id, group.last_ts);
    refreshGroupBadge();
    document.querySelectorAll(".contact-card").forEach(c => c.classList.remove("active"));
    li.classList.add("active");
    if (typeof window.openChatPanel === "function") {
      window.openChatPanel(group.id, group.name);
    } else {
      const url = group.name
        ? `/chat?with=${encodeURIComponent(group.id)}&name=${encodeURIComponent(group.name)}`
        : `/chat?with=${encodeURIComponent(group.id)}`;
      window.location.href = url;
    }
  });

  // ── Avatar + Type-Badge ──
  const isVoiceGroup = group.type === "voice";
  const avatarWrap = document.createElement("div");
  avatarWrap.className = "contact-avatar-wrap";

  const avatar = document.createElement("div");
  avatar.className = "contact-avatar";
  avatar.style.borderRadius = "30%";
  avatar.textContent = group.name[0].toUpperCase();

  const typeBadge = document.createElement("span");
  typeBadge.textContent = isVoiceGroup ? "🎤" : "💬";
  typeBadge.style.cssText = "position:absolute;bottom:-3px;right:-3px;font-size:10px;line-height:1;background:var(--bg-panel);border-radius:50%;padding:1px;";

  avatarWrap.appendChild(avatar);
  avatarWrap.appendChild(typeBadge);

  // ── Info ──
  const info = document.createElement("div");
  info.className = "contact-info";

  const topRow = document.createElement("div");
  topRow.className = "contact-top-row";

  const nameEl = document.createElement("span");
  nameEl.className = "contact-name" + (isUnread ? " unread" : "");
  nameEl.textContent = group.name;

  const timeMeta = document.createElement("span");
  timeMeta.className = "contact-time" + (isUnread ? " unread" : "");
  timeMeta.textContent = formatTime(group.last_ts);

  topRow.appendChild(nameEl);
  topRow.appendChild(timeMeta);

  const bottomRow = document.createElement("div");
  bottomRow.className = "contact-bottom-row";

  const preview = document.createElement("span");
  preview.className = "contact-preview";
  {
    const myUser  = (localStorage.getItem("my_user") || "").toLowerCase();
    const cached  = getPreviewCache(group.id);
    const fallbackTs   = group.last_type === "system" ? group.last_ts : null;
    const fallbackText = group.last_type === "system" ? replaceGuestHandles(group.last_text || "") : null;
    const effectiveCached = cached || (fallbackText !== null ? { text: fallbackText, ts: fallbackTs, from: "__system__" } : null);
    const { text: previewText, muted: previewMuted } = buildPreviewText(effectiveCached, group.last_ts, myUser, group.last_from, true);
    preview.textContent = previewText;
    if (previewMuted) preview.classList.add("muted");
  }

  bottomRow.appendChild(preview);

  const isMutedGroup = _mutedConvos.has(group.id);
  if (isMutedGroup) {
    const muteIcon = document.createElement("span");
    muteIcon.textContent = "🔕";
    muteIcon.style.cssText = "font-size:11px;opacity:0.4;flex-shrink:0;";
    bottomRow.appendChild(muteIcon);
  } else if (isUnread) {
    const badge = document.createElement("span");
    badge.className = "contact-badge";
    const unreadCount = Number(group.unread_count) || 0;
    badge.textContent = unreadCount > 99 ? "99+" : (unreadCount > 0 ? String(unreadCount) : "●");
    bottomRow.appendChild(badge);
  } else {
    const memberCount = document.createElement("span");
    memberCount.dataset.onlineCount = "1";
    memberCount.className = "contact-presence-label";
    memberCount.textContent = lang.membersLabel(group.member_count);
    bottomRow.appendChild(memberCount);
  }

  info.appendChild(topRow);
  info.appendChild(bottomRow);

  // 🔗 Invite button
  const inviteBtn = document.createElement("button");
  inviteBtn.textContent = "🔗";
  inviteBtn.title = lang.inviteLinkCreate;
  inviteBtn.className = "contact-remove-btn";
  inviteBtn.style.fontSize = "14px";
  inviteBtn.onmouseenter = () => inviteBtn.style.color = "var(--accent-voice)";
  inviteBtn.onmouseleave = () => inviteBtn.style.color = "";
  inviteBtn.onclick = (e) => {
    e.stopPropagation();
    createGroupInviteLink(group.id, group.name, inviteBtn);
  };

  // ✕ Leave button
  const leaveBtn = document.createElement("button");
  leaveBtn.textContent = "✕";
  leaveBtn.title = lang.leaveGroupBtn;
  leaveBtn.className = "contact-remove-btn";
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

  li.appendChild(avatarWrap);
  li.appendChild(info);
  li.appendChild(inviteBtn);
  li.appendChild(leaveBtn);
  return li;
}

// FAB + Popup: Gruppe erstellen (2-Schritt-Flow)
const createGroupPopup   = document.getElementById("create-group-popup");
const groupStep1         = document.getElementById("group-step-1");
const groupStep2         = document.getElementById("group-step-2");
const groupCreateConfirm = document.getElementById("group-create-confirm-btn");
const groupInviteFilter  = document.getElementById("group-invite-filter");
const groupContactChips  = document.getElementById("group-contact-chips");
const groupNoContacts    = document.getElementById("group-no-contacts");
const groupInviteDoneBtn = document.getElementById("group-invite-done-btn");
const groupGuestLinkBtn  = document.getElementById("group-guest-link-btn");

let _pendingGroupId   = null;
let _invitedHandles   = new Set(); // bereits eingeladene im aktuellen Flow

function closeGroupPopup() {
  createGroupPopup.style.display = "none";
  groupStep1.style.display = "block";
  groupStep2.style.display = "none";
  groupNameInput.value = "";
  if (groupInviteFilter) groupInviteFilter.value = "";
  if (groupContactChips) groupContactChips.innerHTML = "";
  if (groupNoContacts)   groupNoContacts.style.display = "none";
  _pendingGroupId = null;
  _invitedHandles = new Set();
  updateInviteDoneBtn();
}

function updateInviteDoneBtn() {
  if (!groupInviteDoneBtn) return;
  const n = _invitedHandles.size;
  const base = lang.createGroupFinish || "Gruppe erstellen";
  groupInviteDoneBtn.textContent = n > 0 ? `${base} (${n} ✓)` : base;
}

async function renderContactChips(filter) {
  if (!groupContactChips) return;
  const contacts = await fetchAcceptedContacts();
  const q = (filter || "").trim().toLowerCase();
  const filtered = q ? contacts.filter(h => h.includes(q)) : contacts;

  groupContactChips.innerHTML = "";

  if (filtered.length === 0) {
    if (groupNoContacts) {
      groupNoContacts.style.display = "block";
      groupNoContacts.textContent = q
        ? (lang.noContactsFound || "Keine Treffer")
        : (lang.noContactsYet  || "Noch keine Kontakte");
    }
    return;
  }
  if (groupNoContacts) groupNoContacts.style.display = "none";

  filtered.forEach(handle => {
    const selected = _invitedHandles.has(handle);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.style.cssText = [
      "display:inline-flex;align-items:center;gap:6px;",
      "padding:7px 12px;border-radius:20px;font-size:13px;",
      "font-family:inherit;cursor:pointer;transition:all 0.15s;",
      "min-height:36px;",
      selected
        ? "border:1.5px solid var(--accent-voice);background:rgba(56,189,248,0.15);color:var(--accent-voice);font-weight:600;"
        : "border:1.5px solid var(--border-subtle);background:var(--bg-panel-alt);color:var(--text-primary);font-weight:400;"
    ].join("");

    const avatar = document.createElement("span");
    avatar.style.cssText = [
      "width:18px;height:18px;border-radius:50%;font-size:10px;font-weight:700;",
      "display:flex;align-items:center;justify-content:center;flex-shrink:0;",
      selected
        ? "background:var(--accent-voice);color:#07070A;"
        : "background:var(--bg-panel);color:var(--text-secondary);"
    ].join("");
    avatar.textContent = selected ? "✓" : handle.charAt(0).toUpperCase();

    const label = document.createElement("span");
    label.textContent = handle;

    chip.append(avatar, label);

    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      if (_invitedHandles.has(handle)) {
        _invitedHandles.delete(handle);
      } else {
        _invitedHandles.add(handle);
      }
      updateInviteDoneBtn();
      renderContactChips(groupInviteFilter?.value || "");
    });

    groupContactChips.appendChild(chip);
  });
}

async function doCreateGroup() {
  const name = groupNameInput?.value.trim();
  if (!name) return;
  groupCreateConfirm.disabled = true;
  try {
    const res = await apiFetch("/groups/create", { method: "POST", body: JSON.stringify({ name }) });
    if (res.groupId) {
      markGroupSeen(res.groupId, Date.now());
      _pendingGroupId = res.groupId;
    }
    _lastGroupsKey = null;
    await loadGroups();
    showInviteStep();
  } catch (e) {
    alert(lang.createGroupFailed + e.message);
  } finally {
    groupCreateConfirm.disabled = false;
  }
}

function showInviteStep() {
  groupStep1.style.display = "none";
  groupStep2.style.display = "block";
  _cachedAcceptedContacts = null;
  fetchAcceptedContacts().then(() => {
    renderContactChips("");
  });
  updateInviteDoneBtn();
}

async function doInviteAll() {
  if (!_pendingGroupId) { closeGroupPopup(); return; }
  if (_invitedHandles.size === 0) { closeGroupPopup(); return; }
  groupInviteDoneBtn.disabled = true;
  groupInviteDoneBtn.textContent = "…";
  const errors = [];
  try {
    await Promise.all([..._invitedHandles].map(async handle => {
      try {
        await apiFetch("/groups/invite", { method: "POST", body: JSON.stringify({ groupId: _pendingGroupId, handle }) });
      } catch (err) {
        errors.push(`${handle}: ${err.message || err}`);
      }
    }));
  } finally {
    groupInviteDoneBtn.disabled = false;
    updateInviteDoneBtn();
    if (errors.length) {
      alert(lang.someInvitesFailed + "\n" + errors.join("\n"));
    }
    closeGroupPopup();
  }
}

groupNameInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter")  { e.preventDefault(); doCreateGroup(); }
  if (e.key === "Escape") { closeGroupPopup(); }
});

groupCreateConfirm?.addEventListener("click", (e) => { e.stopPropagation(); doCreateGroup(); });
groupInviteDoneBtn?.addEventListener("click", (e) => { e.stopPropagation(); doInviteAll(); });
groupGuestLinkBtn?.addEventListener("click",  (e) => {
  e.stopPropagation();
  if (!_pendingGroupId) return;
  const groupName = groupNameInput?.value.trim() || "";
  createGroupInviteLink(_pendingGroupId, groupName, groupGuestLinkBtn);
});

// Filter-Input für Kontakt-Chips
groupInviteFilter?.addEventListener("input", () => renderContactChips(groupInviteFilter.value));
groupInviteFilter?.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeGroupPopup();
});

createGroupBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = createGroupPopup?.style.display === "block";
  if (isOpen) {
    closeGroupPopup();
  } else {
    createGroupPopup.style.display = "block";
    setTimeout(() => groupNameInput?.focus(), 50);
  }
});

// ✕ buttons for both steps
document.getElementById("create-group-close")?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeGroupPopup();
});
document.getElementById("group-invite-close")?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeGroupPopup();
});

// Outside click closes group popup
document.addEventListener("click", (e) => {
  if (createGroupPopup?.style.display === "block"
      && !createGroupPopup.contains(e.target)
      && e.target !== createGroupBtn) {
    closeGroupPopup();
  }
});

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
    // Popup schliessen nach erfolgreicher Anfrage
    const addContactPopup = document.getElementById("add-contact-popup");
    if (addContactPopup) addContactPopup.style.display = "none";
    await loadContacts();

  } catch (err) {
    console.warn("Kontaktanfrage fehlgeschlagen:", err);
    let msg = lang.contactRequestFailed;
    try {
      const parsed = JSON.parse(err.message);
      if (parsed?.error === "account_deleted") msg = lang.contactRequestAccountDeleted;
    } catch {}
    alert(msg);

  } finally {

    contactRequestInFlight = false;
    addBtn.disabled = false;

  }
});

// ================================
// DM INVITE LINK (Einmalig verwendbar)
// ================================
const dmInviteBtn    = document.getElementById("dm-invite-btn");
const dmInviteStatus = document.getElementById("dm-invite-status");
let _dmInvitePending = false;

dmInviteBtn?.addEventListener("click", async () => {
  if (_dmInvitePending) return;
  _dmInvitePending = true;

  const orig = dmInviteBtn.innerHTML;
  dmInviteBtn.textContent = "…";
  dmInviteBtn.disabled = true;
  dmInviteStatus.style.display = "none";

  const fmtDm = (url) => (lang.linkCopiedClipboardDm || lang.linkCopiedClipboard || ((u) => u))(url);
  const doFetch = () => fetch(`${API}/invite/create`, {
    method:      "POST",
    credentials: "include",
    headers:     { "Content-Type": "application/json" },
    body:        JSON.stringify({}),                       // kein convoId → DM
  }).then(r => r.json().catch(() => ({}))).then(data => {
    if (!data.inviteUrl) throw new Error("no_url");
    return data.inviteUrl;
  });

  try {
    let copied = false;

    // Clipboard API mit ClipboardItem (Safari-kompatibel, async)
    if (navigator.clipboard && window.ClipboardItem) {
      try {
        const urlPromise = doFetch();
        await navigator.clipboard.write([
          new ClipboardItem({ "text/plain": urlPromise.then(u => new Blob([fmtDm(u)], { type: "text/plain" })) })
        ]);
        await urlPromise;
        copied = true;
      } catch (e) {
        if (e.message === "no_url") throw e;
      }
    }

    // Fallback: writeText
    if (!copied && navigator.clipboard?.writeText) {
      try {
        const url = await doFetch();
        await navigator.clipboard.writeText(fmtDm(url));
        copied = true;
      } catch (e) {
        if (e.message === "no_url") throw e;
      }
    }

    // Fallback: execCommand
    if (!copied) {
      const url = await doFetch();
      const ta = document.createElement("textarea");
      ta.value = fmtDm(url);
      ta.style.cssText = "position:fixed;top:0;left:0;width:2em;height:2em;opacity:0;";
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      try { copied = document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    }

    dmInviteBtn.textContent = "✓";
    showToast({ icon: "🔗", title: lang.linkCopiedInfo || lang.linkCopied, sub: lang.dmInviteSubLabel, durationMs: 4000 });
    setTimeout(() => { dmInviteBtn.innerHTML = orig; dmInviteBtn.disabled = false; _dmInvitePending = false; }, 2500);

  } catch (e) {
    dmInviteBtn.innerHTML = orig;
    dmInviteBtn.disabled = false;
    _dmInvitePending = false;
    showToast({ icon: "⚠️", title: lang.linkCreateFailed, durationMs: 4000 });
  }
});