// ======================================================
// AUTO-DELETE SYSTEM — Sweep, UI, Proposals
// ======================================================
import { apiFetch } from "./api.js";
import lang from "./i18n.js";
import { _isGuestMode } from "./chatState.js";
import { showPromptDialog } from "./shared/dialog.js";

// Module-private state
let _autoDeleteDays = null;
let _sweepInterval = null;

// External dependencies (set via setup)
let _getWithUser, _getMyUser, _isGroupConversation, _getMessagesEl;

export function setup({ getWithUser, getMyUser, isGroupConversation, getMessagesEl }) {
  _getWithUser = getWithUser;
  _getMyUser = getMyUser;
  _isGroupConversation = isGroupConversation;
  _getMessagesEl = getMessagesEl;
}

export function getAutoDeleteDays() { return _autoDeleteDays; }

export function isAutoDeleted(ts) {
  if (!_autoDeleteDays || !ts) return false;
  return (Date.now() - Number(ts)) > (_autoDeleteDays * 86_400_000);
}

export function decryptFailedText(ts) {
  return isAutoDeleted(ts) ? (lang.messageExpired || "⏱ Nachricht automatisch gelöscht") : lang.decryptFailed;
}

export function autoDeleteLabel(days) {
  if (!days) return lang.autoDeleteOff;
  const d = Number(days);
  if (d <= 0.05) return lang.autoDeleteOneHour || "1h";
  const map = {
    1:  lang.autoDeleteOneDay      || "24h",
    7:  lang.autoDeleteOneWeek     || "7 Tage",
    30: lang.autoDeleteThirtyDays  || "30 Tage",
  };
  return map[d] ?? `${d} Tage`;
}

export function sweepExpiredMessages() {
  const messagesEl = _getMessagesEl();
  if (!messagesEl || !_autoDeleteDays) return;
  const bubbles = Array.from(messagesEl.querySelectorAll("[data-ts]"))
    .filter(el => el.classList.contains("me") || el.classList.contains("other"));
  for (const el of bubbles) {
    const ts = Number(el.dataset.ts);
    if (!ts || !isAutoDeleted(ts)) continue;
    el.className = "system";
    el.removeAttribute("data-id");
    el.removeAttribute("data-temp-id");
    el.removeAttribute("data-ts");
    el.innerHTML = "";
    el.textContent = lang.messageExpired || "⏱ Nachricht automatisch gelöscht";
  }
}

export function startExpirySweep() {
  if (_sweepInterval) return;
  _sweepInterval = setInterval(sweepExpiredMessages, 10_000);
}

export function stopExpirySweep() {
  if (_sweepInterval) { clearInterval(_sweepInterval); _sweepInterval = null; }
}

export function showAutoDeleteBanner(text, type = "info") {
  let banner = document.getElementById("auto-delete-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "auto-delete-banner";
    banner.style.cssText = "position:sticky;top:0;z-index:10;padding:8px 16px;font-size:13px;text-align:center;transition:opacity 0.3s;";
    document.getElementById("messages")?.prepend(banner);
  }
  banner.style.background = type === "success" ? "var(--accent)" : "var(--bg-panel)";
  banner.style.color = type === "success" ? "#fff" : "var(--text-secondary)";
  banner.textContent = text;
  banner.style.display = "block";
  setTimeout(() => { banner.style.opacity = "0"; setTimeout(() => banner.remove(), 300); }, 4000);
}

export function updateAutoDeleteHeaderLabel(days, active = true) {
  _autoDeleteDays = days || null;
  if (active) {
    if (_autoDeleteDays) { startExpirySweep(); } else { stopExpirySweep(); }
  }
  const lbl = document.getElementById("chat-autodelete-label");
  if (lbl) lbl.textContent = days ? autoDeleteLabel(days) : lang.autoDeleteOff;

  document.querySelectorAll(".chat-ad-opt").forEach(el => {
    const v = el.dataset.days === "" ? null : Number(el.dataset.days);
    const isActive = v === days;
    el.style.fontWeight = isActive ? "700" : "400";
    el.textContent = el.textContent.replace(" ✓", "") + (isActive ? " ✓" : "");
  });
}

export function showAutoDeleteProposal(days) {
  const withUser = _getWithUser();
  let bar = document.getElementById("auto-delete-proposal");
  if (bar) bar.remove();
  bar = document.createElement("div");
  bar.id = "auto-delete-proposal";
  bar.style.cssText = "position:sticky;top:0;z-index:10;padding:10px 16px;background:var(--bg-panel);border-bottom:1px solid var(--border-panel);display:flex;align-items:center;gap:10px;font-size:13px;";
  const adTextSpan = document.createElement("span");
  adTextSpan.style.flex = "1";
  const adStrong1 = document.createElement("strong");
  adStrong1.textContent = withUser;
  const adStrong2 = document.createElement("strong");
  adStrong2.textContent = autoDeleteLabel(days);
  if (days) {
    adTextSpan.append("🗑️ ", adStrong1, " schlägt Auto-Delete vor: ", adStrong2);
  } else {
    adTextSpan.append("🗑️ ", adStrong1, " möchte Auto-Delete deaktivieren");
  }
  const adAcceptBtn = document.createElement("button");
  adAcceptBtn.id = "ad-accept";
  adAcceptBtn.style.cssText = "padding:4px 12px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;";
  adAcceptBtn.textContent = "Akzeptieren";
  const adDeclineBtn = document.createElement("button");
  adDeclineBtn.id = "ad-decline";
  adDeclineBtn.style.cssText = "padding:4px 12px;background:transparent;color:var(--text-secondary);border:1px solid var(--border-panel);border-radius:6px;cursor:pointer;";
  adDeclineBtn.textContent = "Ablehnen";
  bar.append(adTextSpan, adAcceptBtn, adDeclineBtn);
  document.getElementById("messages")?.prepend(bar);

  bar.querySelector("#ad-accept").addEventListener("click", async () => {
    try {
      await apiFetch("/chat/auto-delete", { method: "POST", body: JSON.stringify({ peer: withUser, action: "accept", days }) });
      bar.remove();
      const activeDays = days || null;
      updateAutoDeleteHeaderLabel(activeDays, true);
      showAutoDeleteBanner(activeDays ? lang.autoDeleteActive(autoDeleteLabel(activeDays)) : lang.autoDeleteDisabled, "success");
    } catch (e) { console.warn("Auto-Delete accept fehlgeschlagen", e); }
  });

  bar.querySelector("#ad-decline").addEventListener("click", async () => {
    try {
      await apiFetch("/chat/auto-delete", { method: "POST", body: JSON.stringify({ peer: withUser, action: "decline" }) });
      bar.remove();
      showAutoDeleteBanner("❌ Auto-Delete abgelehnt", "info");
    } catch (e) { console.warn("Auto-Delete decline fehlgeschlagen", e); }
  });
}

export async function initAutoDeleteUI() {
  const withUser = _getWithUser();
  const getMyUser = _getMyUser;
  const isGroupConversation = _isGroupConversation;

  updateAutoDeleteHeaderLabel(null);

  const isGroup = isGroupConversation(withUser);
  let amGroupAdmin = false;

  try {
    if (isGroup) {
      const s = await apiFetch(`/groups/auto-delete?groupId=${encodeURIComponent(withUser)}`);
      if (s?.status === "active") { updateAutoDeleteHeaderLabel(s.days); startExpirySweep(); }
      amGroupAdmin = s?.myRole === "admin";
    } else {
      const s = await apiFetch(`/chat/auto-delete?peer=${encodeURIComponent(withUser)}`);
      if (s?.status === "active") {
        updateAutoDeleteHeaderLabel(s.days, true);
      } else if (s?.status === "pending" && s?.proposed_by === getMyUser()) {
        if (!s.days) {
          if (s.original_days) updateAutoDeleteHeaderLabel(s.original_days, true);
          showAutoDeleteBanner("📤 Vorschlag gesendet: Auto-Delete deaktivieren", "info");
        } else {
          updateAutoDeleteHeaderLabel(s.days, false);
        }
      } else if (s?.status === "pending") {
        showAutoDeleteProposal(s.days);
      }
    }
  } catch {}

  const menuBtn = document.getElementById("chat-menu-btn");
  const menuDropdown = document.getElementById("chat-menu-dropdown");
  if (_isGuestMode && menuBtn) {
    menuBtn.style.cursor = "default";
    menuBtn.style.pointerEvents = "none";
    if (menuDropdown) menuDropdown.style.display = "none";
  }
  const adSubmenu = document.getElementById("chat-autodelete-submenu");
  const adMenuItem = document.getElementById("chat-menu-autodelete");

  const renameMenuItem = document.getElementById("chat-menu-rename");
  if (isGroup && renameMenuItem) renameMenuItem.style.display = amGroupAdmin ? "" : "none";

  if (isGroup && adMenuItem && !amGroupAdmin) {
    adMenuItem.style.cursor = "default";
    adMenuItem.style.opacity = "0.75";
    if (adSubmenu) adSubmenu.style.display = "none";
    adMenuItem.addEventListener("click", (e) => e.stopPropagation(), { capture: true });
    const hint = document.getElementById("chat-autodelete-readonly-hint");
    if (hint) hint.style.display = "inline";
  }

  if (isGroup && amGroupAdmin && renameMenuItem && !renameMenuItem._listenerSet) {
    renameMenuItem._listenerSet = true;
    renameMenuItem.addEventListener("click", async () => {
      if (menuDropdown) menuDropdown.style.display = "none";
      const titleEl = document.getElementById("chat-with");
      const currentName = titleEl?.textContent.trim() || "";
      const newName = await showPromptDialog({
        title: lang.groupNameLabel,
        defaultValue: currentName,
        confirmLabel: "OK",
        cancelLabel: lang.cancelBtn || "Abbrechen",
      });
      if (!newName || newName.trim() === currentName) return;
      try {
        await apiFetch("/groups/rename", { method: "POST", body: JSON.stringify({ groupId: withUser, name: newName.trim() }) });
        if (titleEl) titleEl.textContent = newName.trim();
      } catch (e) { alert(lang.renameFailed + (e.message || e)); }
    });
  }

  const inviteItem = document.getElementById("chat-invite-item");
  if (inviteItem && !_isGuestMode && isGroup) inviteItem.style.display = "flex";

  // Key-Reset-Menüpunkt nur für DMs mit eingeloggtem User (kein Guest, keine Gruppe).
  // Erlaubt manuelle Wiederherstellung wenn E2E-Schlüssel zwischen zwei Geräten
  // auseinandergedriftet sind (Re-Register / Passkey-Neu-Einrichtung).
  const keyResetItem = document.getElementById("chat-key-reset-item");
  if (keyResetItem && !_isGuestMode && !isGroup) keyResetItem.style.display = "flex";

  if (menuBtn && menuDropdown) {
    const openMenu  = () => { menuDropdown.style.display = "block"; };
    const closeMenu = () => { menuDropdown.style.display = "none"; if (adSubmenu) adSubmenu.style.display = "none"; };
    menuBtn.addEventListener("click", (e) => { e.stopPropagation(); menuDropdown.style.display === "block" ? closeMenu() : openMenu(); });
    menuDropdown.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", closeMenu);
  }

  adMenuItem?.addEventListener("click", (e) => { e.stopPropagation(); if (adSubmenu) adSubmenu.style.display = adSubmenu.style.display === "block" ? "none" : "block"; });

  // ── Granulare Mute-Settings (Discord-Style Submenu) ──────
  const muteItem = document.getElementById("chat-menu-mute");
  const muteStatus = document.getElementById("chat-mute-status");
  const muteLabel = document.getElementById("chat-mute-label");
  const muteSubmenu = document.getElementById("chat-mute-submenu");
  const convoId = isGroup ? withUser : (() => { const [a, b] = [getMyUser(), withUser].sort(); return `${a}:${b}`; })();
  let _muteLevel = "nothing"; // nothing = alles an
  let _muteExpiresAt = null;

  function updateMuteUI(level, expiresAt) {
    _muteLevel = level || "nothing";
    _muteExpiresAt = expiresAt || null;
    const isMuted = _muteLevel !== "nothing";
    if (muteLabel) muteLabel.textContent = (isMuted ? "🔕 " : "🔔 ") + lang.notificationsLabel;
    if (muteStatus) {
      if (_muteLevel === "nothing") {
        muteStatus.textContent = lang.notificationsOn;
        muteStatus.style.color = "var(--accent)";
      } else if (_muteLevel === "mentions_only") {
        muteStatus.textContent = lang.notifLevelMentions || "@ Mentions";
        muteStatus.style.color = "var(--text-secondary)";
      } else if (_muteLevel === "mentions_and_everyone") {
        muteStatus.textContent = lang.notifLevelMentionsAll || "@ + everyone";
        muteStatus.style.color = "var(--text-secondary)";
      } else if (_muteLevel === "all" && _muteExpiresAt) {
        const remaining = Math.max(0, Math.ceil((_muteExpiresAt - Date.now()) / 60000));
        const timeStr = remaining >= 60 ? `${Math.floor(remaining/60)}h` : `${remaining}m`;
        muteStatus.textContent = lang.notifTimedSuffix ? lang.notifTimedSuffix(timeStr) : `Muted (${timeStr})`;
        muteStatus.style.color = "var(--text-secondary)";
      } else {
        muteStatus.textContent = lang.notificationsOff;
        muteStatus.style.color = "var(--text-secondary)";
      }
    }
    // Checkmarks in Submenu aktualisieren
    document.querySelectorAll(".chat-mute-opt").forEach(opt => {
      const check = opt.querySelector(".mute-check");
      if (!check) return;
      const optLevel = opt.dataset.level;
      const optDuration = opt.dataset.duration;
      // Permanente Levels: Match auf Level ohne Duration
      // Timed Mute: kein Checkmark (einmalige Aktion)
      if (!optDuration && optLevel === _muteLevel) {
        check.textContent = "✓";
        check.style.color = "var(--accent)";
      } else {
        check.textContent = "";
      }
    });
  }

  // DM: @mention-Optionen ausblenden (nur für Gruppen relevant)
  if (!isGroup) {
    document.querySelectorAll(".mute-group-only").forEach(el => el.style.display = "none");
  }

  // Initial: Mute-Status laden
  try {
    const { muted: mutedList } = await apiFetch("/notifications/muted");
    const entry = (mutedList || []).find(m => m.convoId === convoId);
    if (entry) {
      updateMuteUI(entry.level, entry.expiresAt);
    } else {
      updateMuteUI("nothing", null);
    }
  } catch { updateMuteUI("nothing", null); }

  // Accordion Toggle
  const muteToggle = document.getElementById("chat-mute-toggle");
  const muteArrow = document.getElementById("chat-mute-arrow");
  muteToggle?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!muteSubmenu) return;
    const isOpen = muteSubmenu.style.display === "block";
    muteSubmenu.style.display = isOpen ? "none" : "block";
    if (muteArrow) muteArrow.style.transform = isOpen ? "" : "rotate(180deg)";
  });

  // Mute-Option Clicks
  document.querySelectorAll(".chat-mute-opt").forEach(opt => {
    opt.addEventListener("click", async (e) => {
      e.stopPropagation();
      const level = opt.dataset.level;
      const duration = opt.dataset.duration ? Number(opt.dataset.duration) : undefined;
      if (muteSubmenu) muteSubmenu.style.display = "none";
      if (muteArrow) muteArrow.style.transform = "";
      if (menuDropdown) menuDropdown.style.display = "none";
      try {
        const body = { convoId, level };
        if (duration) body.duration = duration;
        const res = await apiFetch("/notifications/mute", { method: "POST", body: JSON.stringify(body) });
        updateMuteUI(res.level || level, res.expiresAt || null);
        localStorage.setItem("renex_muted_cache_ts", "0");
      } catch (err) { console.warn("Mute failed:", err); }
    });
    // Hover-Effekt
    opt.addEventListener("mouseover", () => opt.style.background = "var(--bg-panel-alt)");
    opt.addEventListener("mouseout", () => opt.style.background = "");
  });

  // Auto-Delete option clicks
  document.querySelectorAll(".chat-ad-opt").forEach(el => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const days = el.dataset.days === "" ? null : Number(el.dataset.days);
      menuDropdown.style.display = "none";
      if (adSubmenu) adSubmenu.style.display = "none";
      try {
        if (isGroup) {
          await apiFetch("/groups/auto-delete", { method: "POST", body: JSON.stringify({ groupId: withUser, days }) });
          updateAutoDeleteHeaderLabel(days);
          showAutoDeleteBanner(days ? lang.autoDeleteSet(autoDeleteLabel(days)) : lang.autoDeleteDisabled, "success");
        } else {
          const daysPayload = days === null ? 0 : days;
          await apiFetch("/chat/auto-delete", { method: "POST", body: JSON.stringify({ peer: withUser, action: "propose", days: daysPayload }) });
          if (days === null) { showAutoDeleteBanner("📤 Vorschlag gesendet: Auto-Delete deaktivieren", "info"); }
          else { updateAutoDeleteHeaderLabel(days, false); showAutoDeleteBanner(lang.autoDeleteProposal(autoDeleteLabel(days)), "info"); }
        }
      } catch (err) { console.warn("Auto-Delete fehlgeschlagen", err); }
    });
  });
}
