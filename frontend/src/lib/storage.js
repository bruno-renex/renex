// ======================================================
// localStorage Wrapper — typsicher, defensiv
// ======================================================
// Alle direkten localStorage-Zugriffe gehen über diese Datei.
// Vorteile:
//   - Single point of failure für try/catch (Safari Private Mode!)
//   - Konsistente Schlüssel-Namen (alle mit "renex_" prefix außer Legacy)
//   - Typed Wrapper für Strings, JSON, Booleans
//   - Easy mockable in Tests
// ======================================================

// Legacy-Keys ohne prefix (existieren schon in Production, beibehalten)
const LEGACY_KEYS = new Set([
  "my_user",
  "device_id",
  "renex_device_id",
  "inbox_tab",
]);

function k(key) {
  return LEGACY_KEYS.has(key) ? key : `renex_${key}`;
}

export function get(key) {
  try { return localStorage.getItem(k(key)); }
  catch { return null; }
}

export function set(key, value) {
  try {
    if (value === null || value === undefined) {
      localStorage.removeItem(k(key));
    } else {
      localStorage.setItem(k(key), String(value));
    }
  } catch { /* Quota / Private-Mode */ }
}

export function remove(key) {
  try { localStorage.removeItem(k(key)); }
  catch {}
}

export function getJson(key, fallback = null) {
  try {
    const raw = localStorage.getItem(k(key));
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}

export function setJson(key, value) {
  try { localStorage.setItem(k(key), JSON.stringify(value)); }
  catch {}
}

export function getBool(key, fallback = false) {
  const v = get(key);
  if (v === null) return fallback;
  return v === "1" || v === "true";
}

export function setBool(key, value) {
  set(key, value ? "1" : "0");
}
