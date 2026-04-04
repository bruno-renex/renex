import { json, param } from '../utils.js';
import { requireSession, rateLimit } from '../auth.js';

// ======================================================
// GIF ROUTES: /gif/search
// Giphy API Privacy-Proxy — Suchbegriffe werden NICHT geloggt
// ======================================================

export async function handleGifRoutes(request, env, path, params) {

  if (path === "/gif/search" && request.method === "GET") {
    const session = await requireSession(request, env);
    if (!session) return json(request, { error: "Not authenticated" }, 401);
    const me = session.handle;

    // Rate limit: 15 Suchen pro 30 Sekunden
    const ok = await rateLimit(env, `gif_search:${me}`, 30_000, 15);
    if (!ok) return json(request, { error: "Rate limit exceeded", retryAfterMs: 30000 }, 429);

    if (!env.GIPHY_API_KEY) {
      return json(request, { error: "GIF search not configured" }, 503);
    }

    // Suchbegriff lesen — NICHT loggen
    const rawQ = param(params, "q");

    // Sanitize: max 100 Zeichen, nur druckbare Zeichen
    const q = (rawQ || "").replace(/[^\x20-\x7E\u00C0-\u024F]/g, "").slice(0, 100).trim();

    let giphyData;
    try {
      // Trending wenn kein Suchbegriff, sonst Search
      const endpoint = q
        ? `https://api.giphy.com/v1/gifs/search?api_key=${env.GIPHY_API_KEY}&q=${encodeURIComponent(q)}&limit=24&rating=pg&lang=en`
        : `https://api.giphy.com/v1/gifs/trending?api_key=${env.GIPHY_API_KEY}&limit=24&rating=pg`;
      const res = await fetch(endpoint);
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.error("Giphy error", res.status, errText.slice(0, 200));
        return json(request, { error: `GIF search failed (${res.status})` }, 502);
      }
      giphyData = await res.json();
    } catch (e) {
      console.error("Giphy fetch error", e?.message);
      return json(request, { error: "GIF search failed" }, 502);
    }

    // Nur das Nötigste zurückgeben — alle Giphy-Metadaten entfernen
    const results = (giphyData.data || []).map(item => {
      const orig    = item.images?.original;
      const preview = item.images?.fixed_height_small || item.images?.downsized_medium;
      return {
        id:      item.id,
        url:     orig?.url     || null,
        preview: preview?.url  || orig?.url || null,
      };
    }).filter(r => r.url);

    return json(request, { results });
  }

  return json(request, { error: "Not found" }, 404);
}
