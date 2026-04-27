// ======================================================
// Profile Cache + API
// Hält Display Names von Handles client-seitig gecached.
// Backend: GET/PATCH /users/me, GET /users/:handle/profile
// ======================================================

const API = "https://api.renex.id";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 Minuten
const OWN_STORAGE_KEY = "my_display_name";

// handle → { display_name: string|null, fetched_at: number, inflight?: Promise }
const cache = new Map();

// Subscriber (UI wird neu gerendert, wenn sich ein Name ändert)
const subscribers = new Set();

export function onProfileChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function emitChange(handle) {
  // 1) Automatisches DOM-Update für alle Elemente mit [data-profile-handle]
  //    (funktioniert für inbox.js, chat.js, beliebige Seiten — ein Import reicht)
  if (typeof document !== "undefined") {
    try {
      const selector = `[data-profile-handle="${window.CSS?.escape ? CSS.escape(handle) : handle}"]`;
      document.querySelectorAll(selector).forEach(el => {
        const fallback = el.dataset.profileFallback || handle;
        const newText = getDisplayName(handle, fallback);
        if (el.textContent !== newText) el.textContent = newText;
      });
    } catch {}
  }
  // 2) Expliziter Subscriber-Callback (z.B. für eigenes Dropdown-Label)
  for (const fn of subscribers) {
    try { fn(handle); } catch {}
  }
}

// ── Synchroner Lookup — liefert sofort Cache oder Fallback ──
// UI verwendet das beim Rendern. Wenn Cache leer, startet diese Funktion
// einen async-Fetch im Hintergrund und emittiert emitChange, sobald verfügbar.
// fallback: wird zurückgegeben, wenn kein Display Name gesetzt ist
// (z.B. contact.display_handle für Gäste). Standard: handle selbst.
export function getDisplayName(handle, fallback) {
  const fb = fallback != null ? fallback : handle;
  if (!handle) return fb || "";
  const own = getOwnHandle();
  if (own && handle === own) {
    return getOwnDisplayName() || fb;
  }
  const entry = cache.get(handle);
  if (entry && Date.now() - entry.fetched_at < CACHE_TTL_MS) {
    return entry.display_name || fb;
  }
  // Nicht im Cache → async laden, erstmal Fallback zurückgeben
  fetchProfile(handle).catch(() => {});
  return fb;
}

// ── Async Fetch mit Deduplizierung ──
async function fetchProfile(handle) {
  const existing = cache.get(handle);
  if (existing?.inflight) return existing.inflight;

  const promise = (async () => {
    try {
      const res = await fetch(`${API}/users/${encodeURIComponent(handle)}/profile`, {
        credentials: "include"
      });
      if (!res.ok) throw new Error("profile_fetch_failed");
      const data = await res.json();
      cache.set(handle, {
        display_name: data.display_name || null,
        fetched_at: Date.now()
      });
      emitChange(handle);
      return data;
    } catch (e) {
      cache.set(handle, { display_name: null, fetched_at: Date.now() });
      throw e;
    }
  })();

  cache.set(handle, { ...(existing || { display_name: null, fetched_at: 0 }), inflight: promise });
  return promise;
}

// ── Mehrere Handles parallel vorwärmen ──
export async function prefetchProfiles(handles) {
  const unique = [...new Set(handles.filter(Boolean))];
  const own = getOwnHandle();
  const needed = unique.filter(h => {
    if (h === own) return false;
    const entry = cache.get(h);
    return !entry || Date.now() - entry.fetched_at >= CACHE_TTL_MS;
  });
  await Promise.all(needed.map(h => fetchProfile(h).catch(() => {})));
}

// ── Eigenes Profil ──
function getOwnHandle() {
  try { return localStorage.getItem("my_user"); } catch { return null; }
}

export function getOwnDisplayName() {
  try {
    const v = localStorage.getItem(OWN_STORAGE_KEY);
    return v && v.trim() ? v : null;
  } catch { return null; }
}

function setOwnDisplayName(name) {
  try {
    if (name) localStorage.setItem(OWN_STORAGE_KEY, name);
    else localStorage.removeItem(OWN_STORAGE_KEY);
  } catch {}
}

// Lädt eigenen Anzeigenamen vom Backend und cached ihn lokal.
export async function loadOwnProfile() {
  try {
    const res = await fetch(`${API}/users/me`, { credentials: "include" });
    if (!res.ok) return null;
    const data = await res.json();
    setOwnDisplayName(data.display_name || null);
    const own = getOwnHandle();
    if (own) emitChange(own);
    return data;
  } catch {
    return null;
  }
}

// Speichert eigenen Anzeigenamen (oder setzt zurück mit null/leerem String).
// Return: { ok: true, display_name } | { ok: false, error: "too_long"|"rate_limit"|"network"|"unknown" }
export async function saveOwnDisplayName(displayName) {
  const value = (displayName || "").trim();
  const body = value ? { display_name: value } : { display_name: null };
  try {
    const res = await fetch(`${API}/users/me`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (res.status === 429) return { ok: false, error: "rate_limit" };
    if (res.status === 400) {
      const d = await res.json().catch(() => ({}));
      return { ok: false, error: d.error === "too_long" ? "too_long" : "invalid" };
    }
    if (!res.ok) return { ok: false, error: "unknown" };
    const data = await res.json();
    setOwnDisplayName(data.display_name || null);
    const own = getOwnHandle();
    if (own) emitChange(own);
    return { ok: true, display_name: data.display_name || null };
  } catch {
    return { ok: false, error: "network" };
  }
}
