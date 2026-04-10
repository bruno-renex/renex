import lang from "../i18n.js";

// Full timestamp: "14:32 · 10.04.2026" — used in chat messages
export function formatTimestamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const time = d.toLocaleTimeString(lang.locale, {
    hour: "2-digit",
    minute: "2-digit"
  });
  const date = d.toLocaleDateString(lang.locale);
  return `${time} · ${date}`;
}

// Relative time: "14:32" / "Gestern" / "Mo." / "10.04." — used in inbox lists
export function formatTime(ts) {
  if (!ts) return "";
  const date = new Date(ts);
  const now  = new Date();
  const loc  = lang.locale || "de-CH";
  const isToday     = date.toDateString() === now.toDateString();
  const yesterday   = new Date(now); yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  if (isToday)     return date.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
  if (isYesterday) return lang.yesterday || "Gestern";
  const diffDays = Math.floor((now - date) / 86400000);
  if (diffDays < 7) return date.toLocaleDateString(loc, { weekday: "short" });
  return date.toLocaleDateString(loc, { day: "2-digit", month: "2-digit" });
}
