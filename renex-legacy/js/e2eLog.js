// ======================================================
// E2E Log — Ring Buffer für E2E-Events
//
// Zweck: strukturierte, nachvollziehbare Logs für alle Kryptografie-Schritte.
// Ersetzt verstreutes `console.log("🔑 …")` durch eine konsistente API.
//
// Nutzung:
//   import { e2eLog, dumpE2E } from "./e2eLog.js";
//   e2eLog("DECRYPT", "failed", { peer, sid, rot, hasCmk, reason: "mk_failed" });
//
// In der Browser-Console:
//   window.dumpE2E()          → die letzten 50 Events als Tabelle
//   window.dumpE2E(200)       → die letzten 200 Events
//   window.dumpE2E("DECRYPT") → nur Decrypt-Events
//   window.exportE2E()        → kompletter Buffer als JSON-String (für Copy-Paste in Bug-Reports)
// ======================================================

const MAX_BUFFER = 500;
const buffer = [];

const LEVELS = {
  debug: { emoji: "🔵", cssColor: "color:#6ea8ff" },
  info:  { emoji: "🟢", cssColor: "color:#4ade80" },
  warn:  { emoji: "🟡", cssColor: "color:#facc15" },
  error: { emoji: "🔴", cssColor: "color:#ef4444" },
};

// Kategorien:
//   BOOT        — session bootstrap (ensureBootstrapped)
//   DECRYPT     — decryptMessageIfNeeded
//   ENCRYPT     — outgoing message encryption
//   CMK_REQ     — non-authority peer requests CMK
//   CMK_READY   — CMK received / bootstrapped
//   GSK         — group session key events
//   GUEST_CONV  — guest account conversion
//   SEND        — message send path
//   RECV        — message receive via WS/poll
//   ROTATE      — key rotation events

export function e2eLog(category, event, data = null, level = "info") {
  const entry = {
    t:   Date.now(),
    cat: String(category || "").toUpperCase(),
    ev:  String(event || ""),
    lvl: level,
    d:   data && typeof data === "object" ? sanitize(data) : (data ?? null),
  };

  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();

  // Console-Output nur wenn debug aktiv oder level warn/error
  // (verhindert Log-Flut in Production, aber Fehler bleiben sichtbar)
  const isDebug = (() => {
    try { return localStorage.getItem("renex_e2e_debug") === "1"; } catch { return false; }
  })();

  if (level === "warn" || level === "error" || isDebug) {
    const L = LEVELS[level] || LEVELS.info;
    const prefix = `${L.emoji} [E2E:${entry.cat}]`;
    const compact = formatCompact(entry.d);
    // eslint-disable-next-line no-console
    (console[level] || console.log)(`%c${prefix}%c ${entry.ev}${compact ? " — " + compact : ""}`,
      L.cssColor + ";font-weight:600", "color:inherit", entry.d || "");
  }
}

// Sensitive Felder niemals loggen (rohe Keys, privjwk, Klartext)
const NEVER_LOG = new Set([
  "privJwk", "privateKey", "priv_key", "privkey",
  "plaintext", "decrypted", "content", "message",
  "cmk_raw", "gsk_raw", "sk_raw", "authKey", "p256dh",
]);

function sanitize(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.slice(0, 10).map(sanitize);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (NEVER_LOG.has(k)) { out[k] = "[REDACTED]"; continue; }
    if (typeof v === "string" && v.length > 120) {
      out[k] = v.slice(0, 60) + "…(" + v.length + ")";
    } else if (v && typeof v === "object") {
      out[k] = sanitize(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function formatCompact(d) {
  if (!d || typeof d !== "object") return "";
  const keys = ["peer", "from", "to", "sid", "rot", "msgRot", "hasCmk", "reason", "id", "handle"];
  const parts = [];
  for (const k of keys) {
    if (d[k] !== undefined && d[k] !== null) {
      parts.push(`${k}=${typeof d[k] === "string" ? d[k].slice(0, 32) : d[k]}`);
    }
  }
  return parts.join(" ");
}

// ── Console-Helpers (via window.* registriert unten) ──
function dump(filter = null, limit = 50) {
  let entries = buffer;
  if (typeof filter === "string") {
    const f = filter.toUpperCase();
    entries = buffer.filter(e => e.cat === f || e.ev.toUpperCase().includes(f));
  } else if (typeof filter === "number") {
    limit = filter;
  }
  const rows = entries.slice(-limit).map(e => ({
    time: new Date(e.t).toLocaleTimeString() + "." + String(e.t % 1000).padStart(3, "0"),
    cat:  e.cat,
    level: e.lvl,
    event: e.ev,
    ...compactRow(e.d),
  }));
  // eslint-disable-next-line no-console
  console.table(rows);
  return entries.slice(-limit);
}

function compactRow(d) {
  if (!d || typeof d !== "object") return {};
  return {
    peer:   d.peer ?? d.from ?? d.to ?? "",
    sid:    d.sid ?? "",
    rot:    d.rot ?? d.msgRot ?? "",
    reason: d.reason ?? "",
    id:     d.id ?? "",
  };
}

function exportAll() {
  return JSON.stringify(buffer, null, 2);
}

function clear() {
  buffer.length = 0;
  // eslint-disable-next-line no-console
  console.log("🧹 E2E log cleared");
}

function setDebug(on) {
  try {
    if (on) localStorage.setItem("renex_e2e_debug", "1");
    else   localStorage.removeItem("renex_e2e_debug");
    // eslint-disable-next-line no-console
    console.log(`E2E debug ${on ? "EIN" : "AUS"} — Reload für vollen Effekt`);
  } catch {}
}

// Global verfügbar in Console für Support-Debugging
if (typeof window !== "undefined") {
  window.dumpE2E     = dump;
  window.exportE2E   = exportAll;
  window.clearE2E    = clear;
  window.setE2EDebug = setDebug;
}

export { dump as dumpE2E, exportAll as exportE2E, clear as clearE2E, setDebug as setE2EDebug };
