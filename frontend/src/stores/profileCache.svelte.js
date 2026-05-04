// ======================================================
// Profile-Cache — Display-Name Resolution für fremde User
// ======================================================
// Reaktiver LRU-Cache für `/users/<handle>/profile`.
// Komponenten rufen `profileCache.get(handle)` synchron auf und bekommen:
//   - cached value (display_name oder null) wenn bekannt
//   - null + im Hintergrund Fetch wenn unbekannt (Reaktiv: Komponente re-rendert wenn Fetch fertig)
//
// Single-Flight: parallele Aufrufe für denselben Handle teilen sich eine Promise.
// TTL: 5 Min — Display-Names ändern sich selten, manuell invalidieren via invalidate().
// LRU-Eviction: max MAX Einträge, ältester (Insertion-Order) fliegt zuerst raus.
// ======================================================

import { SvelteMap } from 'svelte/reactivity';
import { apiFetch } from '../lib/api.js';

const TTL_MS = 5 * 60 * 1000;   // 5 Min
const MAX = 200;                 // ~6KB bei 30B/Eintrag — vernachlässigbar

// Reaktive Map: Map.set/.delete triggern Subscriber-Updates.
const _cache = new SvelteMap();              // handle (lowercase) -> { displayName, ts }
const _inflight = new Map();                  // handle -> Promise (NICHT reaktiv — interner State)

function _setCache(handle, displayName) {
  // LRU: bei Voll + Neueintrag ältesten entfernen (Insertion-Order = LRU-Approximation)
  if (_cache.size >= MAX && !_cache.has(handle)) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
  // Bei Update: erst löschen, dann setzen → rückt an Insertion-Order-Ende
  if (_cache.has(handle)) _cache.delete(handle);
  _cache.set(handle, { displayName, ts: Date.now() });
}

async function _fetch(handle) {
  if (_inflight.has(handle)) return _inflight.get(handle);
  const p = (async () => {
    try {
      const r = await apiFetch(`/users/${handle}/profile`);
      const dn = (r.ok && r.data && typeof r.data.display_name === 'string')
        ? r.data.display_name
        : null;
      _setCache(handle, dn);
      return dn;
    } catch {
      // Fail soft: kein DN → Handle als Fallback. Cache mit null markieren damit
      // wir nicht ständig retryen (TTL läuft trotzdem ab).
      _setCache(handle, null);
      return null;
    } finally {
      _inflight.delete(handle);
    }
  })();
  _inflight.set(handle, p);
  return p;
}

function _isFresh(entry) {
  return entry && (Date.now() - entry.ts < TTL_MS);
}

export const profileCache = {
  /**
   * Synchroner Reactive-Getter. Liefert displayName aus Cache oder null.
   * Triggert Background-Fetch wenn der Eintrag fehlt oder veraltet ist —
   * Komponenten re-rendern automatisch sobald Fetch fertig (SvelteMap ist reaktiv).
   *
   * @param {string} handle
   * @returns {string|null} Display-Name oder null wenn unbekannt
   */
  get(handle) {
    if (!handle || typeof handle !== 'string') return null;
    const h = handle.toLowerCase();
    const entry = _cache.get(h);
    if (_isFresh(entry)) return entry.displayName;
    // Stale oder fehlend → Background-Fetch (single-flight)
    if (!_inflight.has(h)) void _fetch(h);
    // Bei stale: alten Wert zeigen während Fetch läuft (vermeidet Flackern)
    return entry?.displayName || null;
  },

  /**
   * Convenience: liefert "Display Name" oder "@handle" als Fallback.
   * Reaktiv — ändert sich automatisch wenn der Fetch ankommt.
   */
  resolveName(handle) {
    if (!handle) return '';
    const dn = this.get(handle);
    return dn || `@${handle}`;
  },

  /**
   * Batch-Prefetch — bevorzugt vor UI-Render, z.B. nach loadContacts().
   * Skipt frische Einträge, dedupliziert In-Flight-Requests.
   */
  prefetch(handles) {
    if (!Array.isArray(handles)) return;
    for (const raw of handles) {
      if (!raw || typeof raw !== 'string') continue;
      const h = raw.toLowerCase();
      if (_isFresh(_cache.get(h))) continue;
      if (_inflight.has(h)) continue;
      void _fetch(h);
    }
  },

  /**
   * Eintrag aktiv löschen (z.B. nach DN-Selbst-Update — eigener Handle).
   * Nächster .get(handle) holt frisch.
   */
  invalidate(handle) {
    if (!handle) return;
    _cache.delete(handle.toLowerCase());
  },

  /**
   * Direktes Cache-Update — wenn wir den DN aus anderem Pfad kennen
   * (z.B. eigener User aus userStore, oder /contacts/list mit DN-Feld).
   * Spart einen Round-Trip.
   */
  set(handle, displayName) {
    if (!handle) return;
    _setCache(handle.toLowerCase(), displayName || null);
  },

  /** Nur für Tests + Logout. */
  clear() {
    _cache.clear();
    _inflight.clear();
  },
};
