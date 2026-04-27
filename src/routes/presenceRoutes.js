import { json } from '../utils.js';
import { requireSession, rateLimit } from '../auth.js';

// ======================================================
// PRESENCE ROUTES
// GET  /presence?handles=alice,bob,charlie
//      → { alice: { online: true, ts: 123 }, bob: { online: false, lastSeen: 456 } }
// GET  /presence/me  → eigenen Status setzen + zurückgeben (keepalive)
// ======================================================

const MAX_HANDLES = 50;

export async function handlePresenceRoutes(request, env, path) {

  const session = await requireSession(request, env);
  if (!session) return json(request, { error: "Unauthorized" }, 401);

  // ── GET /presence ─────────────────────────────────────────
  if (path === "/presence" && request.method === "GET") {
    const me = String(session.handle || "").toLowerCase();
    // Rate-Limit: 120 req/min — Presence-Refresh ist häufig (jede Member-Liste-Anzeige).
    const rl = await rateLimit(env, `presence:${me}`, 60_000, 120);
    if (!rl) return json(request, { error: "Too many requests" }, 429);

    const url = new URL(request.url);
    const raw = url.searchParams.get("handles") || "";

    const handles = raw
      .split(",")
      .map(h => h.trim().toLowerCase())
      .filter(h => h.length > 0 && h.length <= 32 && /^[a-z0-9_.-]+$/.test(h))
      .slice(0, MAX_HANDLES);

    if (handles.length === 0) {
      return json(request, {});
    }

    // Parallel aus KV lesen
    const entries = await Promise.all(
      handles.map(async (handle) => {
        try {
          const raw = await env.RENEX_KV.get(`presence:${handle}`);
          if (!raw) return [handle, null];
          const data = JSON.parse(raw);
          return [handle, data];
        } catch {
          return [handle, null];
        }
      })
    );

    const result = Object.fromEntries(entries);
    return json(request, result);
  }

  return json(request, { error: "Not found" }, 404);
}
