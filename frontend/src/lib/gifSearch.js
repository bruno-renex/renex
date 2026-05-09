// ======================================================
// GIF-Search — Wrapper um /gif/search (GIPHY-Privacy-Proxy)
// ======================================================
// Backend (gifRoutes.js) loggt Suchbegriffe NICHT, leitet anonymisiert an
// GIPHY weiter, returnt nur das Nötigste (id, url, preview).
//
// Empfänger lädt das GIF beim Anzeigen direkt vom GIPHY-CDN — dabei sieht
// GIPHY IP + UA des Empfängers. Trade-off ist in der Datenschutzerklärung
// dokumentiert (Sektion 9, "GIF-Suche (GIPHY)").
//
// Prinzip 4 (Privacy by Default): wir senden weder Handle noch IP des
// Suchenden an GIPHY — der Server-Proxy entkoppelt das.
// ======================================================

import { apiFetch } from './api.js';

/**
 * Sucht GIFs (oder lädt Trending wenn Query leer).
 *
 * @param {string} query
 * @returns {Promise<{ok: boolean, results?: Array<{id:string,url:string,preview:string}>, error?: string}>}
 */
export async function searchGifs(query) {
  const q = (query || '').trim();
  const path = q ? `/gif/search?q=${encodeURIComponent(q)}` : '/gif/search';
  try {
    const r = await apiFetch(path);
    if (!r.ok) {
      if (r.status === 429) return { ok: false, error: 'rate_limit' };
      if (r.status === 503) return { ok: false, error: 'not_configured' };
      return { ok: false, error: r.error || 'search_failed' };
    }
    const results = Array.isArray(r.data?.results) ? r.data.results : [];
    return { ok: true, results };
  } catch (e) {
    return { ok: false, error: e?.message || 'search_failed' };
  }
}
