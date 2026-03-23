import {
  initE2EKeys,
  uploadInboxKeyIfNeeded
} from "./e2e.js";
import lang from "./i18n.js";

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
function getToken() {
  return localStorage.getItem("session_token");
}

async function apiFetch(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + getToken(),
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

  if (!getToken()) {
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
    localStorage.removeItem("session_token");
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
  }
});

    console.log("✅ Inbox E2E Init OK");
  } catch (e) {
    console.error("❌ Inbox E2E Init fehlgeschlagen", e);
    alert(lang.cryptoInitFailed);
    return;
  }

  loadContacts();
  // 🔄 Inbox automatisch aktualisieren
window._contactsInterval = setInterval(loadContacts, 8000);
});

// ================================
// LOAD CONTACTS
// ================================
async function loadContacts() {
  
  pendingEl.innerHTML = "";
  acceptedEl.innerHTML = "";

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

    if (contacts.length === 0) {
      acceptedEl.appendChild(emptyLi(lang.noContacts));
      return;
    }

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

    if (!pendingEl.children.length) {
      pendingEl.appendChild(emptyLi(lang.noPendingRequests));
    }

    if (!acceptedEl.children.length) {
      acceptedEl.appendChild(emptyLi(lang.noContacts));
    }

  } catch (err) {
    if (!localStorage.getItem("session_token")) return;
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
  const acceptBtn = document.createElement("button");
  acceptBtn.textContent = lang.acceptBtn;
  acceptBtn.onclick = async () => {
    await apiFetch("/contacts/accept", {
      method: "POST",
      body: JSON.stringify({ contact: contact.handle })
    });
    loadContacts();
  };

  const rejectBtn = document.createElement("button");
  rejectBtn.textContent = lang.rejectBtn;
  rejectBtn.onclick = async () => {
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

  const li = document.createElement("li");

  const name = document.createElement("span");
  name.textContent = contact.display_handle || contact.handle;

  // 🔔 unread badge
const unread = unreadMap[contact.handle] || 0;

if (unread > 0) {

  const badge = document.createElement("span");

  badge.textContent = ` (${unread})`;

  badge.style.color = "var(--accent-voice)";
  badge.style.fontWeight = "600";
  badge.style.marginLeft = "4px";

  name.appendChild(badge);

}

  const chatBtn = document.createElement("a");
  chatBtn.href = `/chat?with=${encodeURIComponent(contact.handle)}`;
  chatBtn.textContent = "Chat";
  chatBtn.className = "chat-link";
  chatBtn.style.marginLeft = "10px";

  const removeBtn = document.createElement("button");
  removeBtn.textContent = "✕";
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

    if (!confirm(lang.confirmRemoveContact(contact.handle))) {
      return;
    }

    try {

      await apiFetch("/contacts/remove", {
        method: "POST",
        body: JSON.stringify({
          contact: contact.handle
        })
      });

      loadContacts();

    } catch (err) {

      console.error("Kontakt entfernen fehlgeschlagen", err);
      alert(lang.removeContactFailed);

    }

  };

  li.appendChild(name);
  li.appendChild(chatBtn);
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