// ======================================================
// voiceButtons.js — Call-Button Injection
//
// Platziert einen 📞 Call-Button rechts im #chat-header (nur 1:1 DMs).
// Die Anrufliste lebt seit Phase 2.5 im Voice-Sidebar-Tab (siehe
// voiceList.js) — nicht mehr im Profil-Dropdown.
// ======================================================
import { startOutgoingCall } from "./voiceUI.js";

// UUID = Gruppe → Call für V2 (Phase 5 Group-Voice)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLE_RE = /^[a-z0-9_]{1,30}$/;

// Ruft im Top-Fenster direkt, aus iframe via postMessage an Parent.
// startOutgoingCall aus voiceUI.js macht das intern bereits; wir lassen
// die Entscheidung dort.
function triggerCall(peer) {
  startOutgoingCall(peer).catch(() => {});
}

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
    triggerCall(peer);
  });
  // Ans Ende des Headers (rechts)
  header.appendChild(btn);
}

// Legacy-Cleanup: falls ein alter Profil-Dropdown-Eintrag aus einem
// früheren Cache noch hängt, entfernen.
function removeLegacyHistoryMenuItem() {
  const el = document.querySelector(".voice-history-item");
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

// ── Init: Injection + späte DOM-Mutations abfangen ─────
let _observer = null;
export function initVoiceButtons() {
  // Direkt versuchen (falls DOM bereits da)
  injectChatCallButton();
  removeLegacyHistoryMenuItem();

  if (_observer) return;
  _observer = new MutationObserver(() => {
    injectChatCallButton();
    removeLegacyHistoryMenuItem();
  });
  _observer.observe(document.body, { childList: true, subtree: true });

  window.addEventListener("popstate", () => {
    injectChatCallButton();
  });
}
