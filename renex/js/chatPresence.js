// ======================================================
// PRESENCE & CONTACTS — Online-Status, Kontakt-Cache
// ======================================================
import { apiFetch } from "./api.js";

// Module-private state
const _presenceCache = {};
const PRESENCE_CACHE_TTL = 90_000;
let _cachedAcceptedContacts = null;

// External deps (set via setup)
let _getWithUser, _isGroupConversation;

export function setup({ getWithUser, isGroupConversation }) {
  _getWithUser = getWithUser;
  _isGroupConversation = isGroupConversation;
}

export function formatLastSeen(ts) {
  if (!ts) return "";
  const diff = Date.now() - Number(ts);
  if (diff < 60_000)      return "gerade eben";
  if (diff < 3_600_000)   return `vor ${Math.floor(diff / 60_000)} Min.`;
  if (diff < 86_400_000)  return `vor ${Math.floor(diff / 3_600_000)} Std.`;
  const days = Math.floor(diff / 86_400_000);
  return `vor ${days} Tag${days === 1 ? "" : "en"}`;
}

export function presenceLabel(status) {
  if (!status) return "";
  if (status.online) return "🟢 Online";
  if (status.lastSeen) return `⚫ ${formatLastSeen(status.lastSeen)}`;
  return "";
}

export async function fetchPresence(handles) {
  if (!handles?.length) return {};
  try {
    const unique = [...new Set(handles.map(h => h.toLowerCase()))].filter(Boolean);
    const now = Date.now();
    const stale = unique.filter(h => !_presenceCache[h] || now - _presenceCache[h].ts > PRESENCE_CACHE_TTL);
    if (stale.length === 0) {
      return Object.fromEntries(unique.map(h => [h, _presenceCache[h].status]));
    }
    const fetched = await apiFetch(`/presence?handles=${encodeURIComponent(stale.join(","))}`);
    for (const h of stale) {
      _presenceCache[h] = { status: fetched?.[h] ?? null, ts: now };
    }
    return Object.fromEntries(unique.map(h => [h, _presenceCache[h]?.status ?? null]));
  } catch { return {}; }
}

export async function initDMPresence() {
  const withUser = _getWithUser();
  const subEl = document.getElementById("dm-presence-status");
  if (!subEl || !withUser || _isGroupConversation(withUser)) return;
  async function update() {
    delete _presenceCache[withUser.toLowerCase()];
    const p = await fetchPresence([withUser]);
    const status = p?.[withUser];
    if (!status) { subEl.textContent = ""; return; }
    subEl.textContent = presenceLabel(status);
    subEl.style.color = status.online ? "#4ade80" : "var(--text-secondary)";
  }
  await update();
  setInterval(update, 90_000);
}

export async function fetchAcceptedContacts() {
  if (_cachedAcceptedContacts) return _cachedAcceptedContacts;
  try {
    const data = await apiFetch("/contacts/list");
    _cachedAcceptedContacts = (data.contacts || [])
      .filter(c => c.status === "accepted")
      .map(c => c.contact_handle || c.handle || "")
      .filter(Boolean);
  } catch { _cachedAcceptedContacts = []; }
  return _cachedAcceptedContacts;
}

export function invalidateContactsCache() {
  _cachedAcceptedContacts = null;
}
