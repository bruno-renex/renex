import { json } from '../utils.js';
import { requireSession } from '../auth.js';

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
