// ======================================================
// voiceHistory.js — Call-History Modal
//
// Holt /voice/history und rendert eine Liste (eingehend/ausgehend,
// verpasst, Dauer). Ein Rückruf-Button pro Eintrag.
// ======================================================
import { fetchHistory } from "./voiceSignaling.js";
import { startOutgoingCall } from "./voiceUI.js";

let _modal = null;

function me() {
  try { return (localStorage.getItem("my_user") || "").toLowerCase(); }
  catch { return ""; }
}

function formatAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const s = Math.round(diff / 1000);
  if (s < 60)   return `vor ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60)   return `vor ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24)   return `vor ${h} h`;
  const d = Math.round(h / 24);
  if (d < 7)    return `vor ${d} T`;
  try { return new Date(ts).toLocaleDateString(); } catch { return ""; }
}

function formatDuration(sec) {
  if (!sec || sec < 1) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function buildModal() {
  if (_modal) return _modal;
  _modal = document.createElement("div");
  _modal.id = "voice-history-modal";
  _modal.setAttribute("role", "dialog");
  _modal.setAttribute("aria-modal", "true");
  _modal.innerHTML = `
    <div class="vh-backdrop"></div>
    <div class="vh-panel">
      <div class="vh-header">
        <span>📞 Anrufliste</span>
        <button class="vh-close" aria-label="Schliessen">✕</button>
      </div>
      <ul class="vh-list"></ul>
    </div>
  `;
  _modal.querySelector(".vh-backdrop").addEventListener("click", closeVoiceHistory);
  _modal.querySelector(".vh-close").addEventListener("click", closeVoiceHistory);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _modal?.classList.contains("visible")) closeVoiceHistory();
  });
  document.body.appendChild(_modal);
  return _modal;
}

export async function openVoiceHistory() {
  const modal = buildModal();
  const list = modal.querySelector(".vh-list");
  list.innerHTML = `<li class="vh-empty">Lade …</li>`;
  modal.classList.add("visible");

  const myHandle = me();
  let calls = [];
  try { calls = await fetchHistory(100); } catch {}

  if (!calls.length) {
    list.innerHTML = `<li class="vh-empty">Keine Anrufe.</li>`;
    return;
  }

  list.innerHTML = "";
  for (const c of calls) {
    const isOutgoing = c.caller === myHandle;
    const peer = isOutgoing ? c.callee : c.caller;

    let iconCls, icon, label;
    if (c.status === "missed" || (c.status === "declined" && !isOutgoing)) {
      iconCls = "missed"; icon = "✖"; label = "Verpasst";
    } else if (isOutgoing) {
      iconCls = "out"; icon = "↗"; label = c.status === "declined" ? "Abgelehnt" : "Ausgehend";
    } else {
      iconCls = "in"; icon = "↘"; label = "Eingehend";
    }

    const dur = formatDuration(c.duration_s);
    const when = formatAgo(c.started_at);
    const metaText = [label, dur, when].filter(Boolean).join(" · ");

    const li = document.createElement("li");
    li.className = "vh-item";
    li.innerHTML = `
      <div class="vh-icon ${iconCls}">${icon}</div>
      <div class="vh-main">
        <div class="vh-peer"></div>
        <div class="vh-meta"></div>
      </div>
      <button class="vh-callback" type="button">Anrufen</button>
    `;
    li.querySelector(".vh-peer").textContent = peer || "—";
    li.querySelector(".vh-meta").textContent = metaText;
    const cb = li.querySelector(".vh-callback");
    cb.addEventListener("click", () => {
      closeVoiceHistory();
      startOutgoingCall(peer).catch(() => {});
    });
    list.appendChild(li);
  }
}

export function closeVoiceHistory() {
  if (_modal) _modal.classList.remove("visible");
}
