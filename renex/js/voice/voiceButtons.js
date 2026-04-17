// ======================================================
// voiceButtons.js — Call-Button + History-Entry Injection
//
// Platziert:
//  - einen 📞 Call-Button rechts im #chat-header (nur 1:1 DMs)
//  - einen "📞 Anrufliste" Eintrag im Inbox profile-dropdown
//
// Keine Änderung an bestehendem HTML — alles per DOM-Injection,
// damit bestehende Seiten/Views unverändert bleiben.
// ======================================================
import { startOutgoingCall } from "./voiceUI.js";
import { openVoiceHistory } from "./voiceHistory.js";

// UUID = Gruppe → Call für V2 (Phase 5 Group-Voice)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLE_RE = /^[a-z0-9_]{1,30}$/;

function currentChatPeer() {
  try {
    const u = new URL(window.location.href);
    const w = (u.searchParams.get("with") || "").toLowerCase();
    if (!w) return null;
    if (UUID_RE.test(w)) return null;         // Gruppe → kein 1:1 Call
    if (!HANDLE_RE.test(w)) return null;
    return w;
  } catch { return null; }
}

// ── Call-Button im Chat-Header ─────────────────────────
function injectChatCallButton() {
  const peer = currentChatPeer();
  if (!peer) return;

  const header = document.getElementById("chat-header");
  if (!header) return;
  if (header.querySelector(".voice-call-btn")) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "voice-call-btn";
  btn.title = `Anrufen: ${peer}`;
  btn.setAttribute("aria-label", `Sprach-Anruf starten an ${peer}`);
  btn.textContent = "📞";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    startOutgoingCall(peer).catch(() => {});
  });
  // Ans Ende des Headers (rechts)
  header.appendChild(btn);
}

// ── "Anrufliste" im Profile-Dropdown (Inbox) ───────────
function injectHistoryMenuItem() {
  const dropdown = document.getElementById("profile-dropdown");
  if (!dropdown) return;
  if (dropdown.querySelector(".voice-history-item")) return;

  const item = document.createElement("div");
  item.className = "dropdown-item voice-history-item";
  item.textContent = "📞 Anrufliste";
  item.style.cursor = "pointer";
  item.addEventListener("click", (ev) => {
    ev.stopPropagation();
    // Dropdown schliessen (visible class wird vom Inbox-JS verwaltet)
    dropdown.classList.remove("open", "visible");
    dropdown.style.display = "none";
    openVoiceHistory().catch(() => {});
  });

  // Vor dem Logout-Item einfügen, sonst ans Ende
  const logoutItem = dropdown.querySelector("#dropdown-logout");
  if (logoutItem?.parentNode === dropdown) {
    dropdown.insertBefore(item, logoutItem);
  } else {
    dropdown.appendChild(item);
  }
}

// ── Init: Injection + späte DOM-Mutations abfangen ─────
let _observer = null;
export function initVoiceButtons() {
  // Direkt versuchen (falls DOM bereits da)
  injectChatCallButton();
  injectHistoryMenuItem();

  if (_observer) return;
  _observer = new MutationObserver(() => {
    // Re-Injection wenn Elemente neu hinzugekommen sind
    injectChatCallButton();
    injectHistoryMenuItem();
  });
  _observer.observe(document.body, { childList: true, subtree: true });

  // Bei URL-Change (z.B. SPA-Navigation in App-Shell)
  window.addEventListener("popstate", () => {
    injectChatCallButton();
  });
}
