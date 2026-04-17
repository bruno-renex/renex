// ======================================================
// voiceList.js — Anrufliste im Voice-Sidebar-Tab
//
// - Lädt /voice/history und rendert eine Liste in #voice-call-list
// - Refresh bei jedem voice:* Event (ring/answer/hangup/decline/cancel)
// - Missed-Call-Badge auf #strip-badge-voice:
//     count = eingehende verpasste/abgelehnte Calls nach dem
//             Zeitpunkt an dem der User zuletzt auf den Voice-Tab
//             geklickt hat (localStorage 'voice_tab_seen_ts')
// - Klick auf "Voice"-Icon im Icon-Strip → Badge löschen
// ======================================================
import { voiceBus, fetchHistory } from "./voiceSignaling.js";
import { startOutgoingCall } from "./voiceUI.js";

const LAST_SEEN_KEY = "voice_tab_seen_ts";
const RE_LIST_ID    = "voice-call-list";
const RE_EMPTY_ID   = "voice-empty";
const BADGE_ID      = "strip-badge-voice";
const TAB_BTN_SELECTOR = '.strip-icon[data-section="voice"]';

const _isTopWindow = (() => {
  try { return window.top === window.self; } catch { return false; }
})();

let _inited = false;
let _refreshQueued = false;
let _lastCalls = [];

// ── Utils ───────────────────────────────────────────────
function me() {
  try { return (localStorage.getItem("my_user") || "").toLowerCase(); }
  catch { return ""; }
}

function getLastSeenTs() {
  const v = Number(localStorage.getItem(LAST_SEEN_KEY) || 0);
  return Number.isFinite(v) ? v : 0;
}
function setLastSeenTs(ts) {
  try { localStorage.setItem(LAST_SEEN_KEY, String(ts)); } catch {}
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

// ── Badge ───────────────────────────────────────────────
function computeMissedCount(calls) {
  const my = me();
  const seenTs = getLastSeenTs();
  let count = 0;
  for (const c of calls) {
    if (c.callee !== my) continue;                    // nur eingehende
    if (!(c.started_at > seenTs)) continue;            // nur seit letztem Besuch
    if (c.status === "missed" || c.status === "declined") count++;
  }
  return count;
}

function updateMissedBadge(count) {
  const el = document.getElementById(BADGE_ID);
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

// ── Rendering ───────────────────────────────────────────
function renderList(calls) {
  const ul = document.getElementById(RE_LIST_ID);
  const empty = document.getElementById(RE_EMPTY_ID);
  if (!ul) return;

  if (!calls || !calls.length) {
    ul.innerHTML = "";
    if (empty) empty.style.display = "";
    return;
  }
  if (empty) empty.style.display = "none";

  const myHandle = me();
  const frag = document.createDocumentFragment();

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

    const dur  = formatDuration(c.duration_s);
    const when = formatAgo(c.started_at);
    const metaText = [label, dur, when].filter(Boolean).join(" · ");

    const li = document.createElement("li");
    li.className = "voice-call-item";
    li.dataset.peer = peer;
    li.dataset.status = c.status;
    li.innerHTML = `
      <div class="vci-icon ${iconCls}">${icon}</div>
      <div class="vci-main">
        <div class="vci-peer"></div>
        <div class="vci-meta"></div>
      </div>
      <button class="vci-call" type="button" title="Anrufen" aria-label="Anrufen">📞</button>
    `;
    li.querySelector(".vci-peer").textContent = peer || "—";
    li.querySelector(".vci-meta").textContent = metaText;

    const callBtn = li.querySelector(".vci-call");
    callBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (peer) startOutgoingCall(peer).catch(() => {});
    });

    frag.appendChild(li);
  }

  ul.innerHTML = "";
  ul.appendChild(frag);
}

// ── Refresh (debounced) ─────────────────────────────────
async function doRefresh() {
  _refreshQueued = false;
  try {
    const calls = await fetchHistory(100);
    _lastCalls = calls || [];
    renderList(_lastCalls);
    updateMissedBadge(computeMissedCount(_lastCalls));
  } catch (e) {
    console.warn("voiceList refresh failed", e);
  }
}

function scheduleRefresh() {
  if (_refreshQueued) return;
  _refreshQueued = true;
  // kurz debouncen, damit bei schnellen Event-Folgen nur ein Request läuft
  setTimeout(doRefresh, 250);
}

// ── Tab-Click: als "gelesen" markieren ──────────────────
function onVoiceTabClick() {
  setLastSeenTs(Date.now());
  updateMissedBadge(0);
  // Liste neu laden (eingehende Zeiten aktualisieren)
  scheduleRefresh();
}

function ensureStyles() {
  if (document.getElementById("voice-overlay-css")) return;
  const link = document.createElement("link");
  link.id = "voice-overlay-css";
  link.rel = "stylesheet";
  link.href = "/js/voice/voiceUI.css";
  document.head.appendChild(link);
}

// ── Init ───────────────────────────────────────────────
export function initVoiceList() {
  if (_inited) return;
  _inited = true;

  // Nur im Top-Window aktiv — die Inbox ist immer das Top-Fenster.
  // Im Chat-iframe gibt es weder die Sidebar noch die Liste.
  if (!_isTopWindow) return;

  ensureStyles();

  // Voice-Icon im Icon-Strip: Click → Badge reset
  const tabBtn = document.querySelector(TAB_BTN_SELECTOR);
  if (tabBtn && !tabBtn.__voiceHandlerAttached) {
    tabBtn.__voiceHandlerAttached = true;
    tabBtn.addEventListener("click", onVoiceTabClick);
  }

  // Erstes Fetch
  scheduleRefresh();

  // Auto-Refresh bei jedem voice:* Event
  const refresh = () => scheduleRefresh();
  voiceBus.addEventListener("voice:ring",    refresh);
  voiceBus.addEventListener("voice:answer",  refresh);
  voiceBus.addEventListener("voice:hangup",  refresh);
  voiceBus.addEventListener("voice:decline", refresh);
  voiceBus.addEventListener("voice:cancel",  refresh);

  // Wenn Tab wieder sichtbar wird (z.B. nach PWA-Wake) → refresh
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleRefresh();
  });

  // Fallback-Refresh alle 60s (falls WS-Event verloren ging)
  setInterval(scheduleRefresh, 60_000);
}
