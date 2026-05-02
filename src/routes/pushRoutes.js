import { json, readJson } from '../utils.js';
import { requireSession, rateLimit } from '../auth.js';
import { pushToUser } from '../helpers/pushSend.js';

// ======================================================
// PUSH ROUTES
// GET  /push/vapid-key    — VAPID Public Key für PushManager.subscribe()
// POST /push/subscribe    — Push-Subscription registrieren
// POST /push/unsubscribe  — Push-Subscription entfernen
// GET  /push/status       — Aktive Subscriptions des Users
// POST /push/test         — Test-Push senden (dev only)
// ======================================================

export async function handlePushRoutes(request, env, path) {

  // VAPID Public Key — kein Auth nötig (wird VOR Login für Permission gebraucht)
  if (path === "/push/vapid-key" && request.method === "GET") {
    const publicKey = env.VAPID_PUBLIC_KEY;
    if (!publicKey) return json(request, { error: "VAPID not configured" }, 500);
    return json(request, { publicKey });
  }

  // Alle anderen Routes brauchen Auth
  const session = await requireSession(request, env);
  if (!session) return json(request, { error: "Not authenticated" }, 401);
  const me = String(session.handle || "").toLowerCase();

  switch (path) {

    // ── SUBSCRIBE ───────────────────────────────────────
    case "/push/subscribe": {
      if (request.method !== "POST") break;
      // Rate-limit: 10 subscribe-attempts/Stunde reicht — User registriert
      // typisch 1× pro Device. Schutz gegen Endpoint-Spam.
      const okRl = await rateLimit(env, `push_subscribe:${me}`, 3600_000, 10);
      if (!okRl) return json(request, { error: "Too many requests" }, 429);

      const body = await readJson(request);
      if (!body) return json(request, { error: "Invalid JSON" }, 400);

      const { endpoint, keys, transport_type } = body;
      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        return json(request, { error: "endpoint + keys (p256dh, auth) required" }, 400);
      }

      const transportType = transport_type || "web_push";
      if (!["web_push", "unified_push"].includes(transportType)) {
        return json(request, { error: "Invalid transport_type" }, 400);
      }

      // Upsert: gleicher Endpoint → Update Keys
      await env.RENEX_DB.prepare(`
        INSERT INTO push_subscriptions (user_handle, endpoint, p256dh, auth_key, transport_type, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
          user_handle = excluded.user_handle,
          p256dh = excluded.p256dh,
          auth_key = excluded.auth_key,
          transport_type = excluded.transport_type,
          updated_at = excluded.updated_at
      `).bind(me, endpoint, keys.p256dh, keys.auth, transportType, Date.now(), Date.now()).run();

      // Max 10 Subscriptions pro User (älteste löschen)
      await env.RENEX_DB.prepare(`
        DELETE FROM push_subscriptions
        WHERE user_handle = ? AND endpoint NOT IN (
          SELECT endpoint FROM push_subscriptions
          WHERE user_handle = ?
          ORDER BY updated_at DESC
          LIMIT 10
        )
      `).bind(me, me).run();

      return json(request, { ok: true });
    }

    // ── UNSUBSCRIBE ─────────────────────────────────────
    case "/push/unsubscribe": {
      if (request.method !== "POST") break;
      const body = await readJson(request);
      if (!body?.endpoint) return json(request, { error: "endpoint required" }, 400);

      await env.RENEX_DB.prepare(
        "DELETE FROM push_subscriptions WHERE user_handle = ? AND endpoint = ?"
      ).bind(me, body.endpoint).run();

      return json(request, { ok: true });
    }

    // ── STATUS ──────────────────────────────────────────
    case "/push/status": {
      if (request.method !== "GET") break;
      const rows = await env.RENEX_DB.prepare(
        "SELECT endpoint, transport_type, created_at FROM push_subscriptions WHERE user_handle = ? ORDER BY updated_at DESC"
      ).bind(me).all();

      return json(request, {
        subscriptions: (rows.results || []).map(r => ({
          endpoint: r.endpoint.slice(0, 60) + "...",
          transport_type: r.transport_type,
          created_at: r.created_at,
        })),
      });
    }

    // ── TEST-PUSH (Diagnose: sendet Test-Push an alle eigenen Subscriptions) ──
    // Rate-Limit: max 5 Tests pro Minute pro User.
    // Returnt detailliertes Per-Subscription-Result für Debug-Anzeige.
    case "/push/test": {
      if (request.method !== "POST") break;

      const ok = await rateLimit(env, `push_test:${me}`, 60_000, 5);
      if (!ok) return json(request, { error: "Too many test pushes", retryAfterMs: 60000 }, 429);

      // Eigene Subscriptions laden
      const rows = await env.RENEX_DB.prepare(
        "SELECT endpoint, p256dh, auth_key, transport_type FROM push_subscriptions WHERE user_handle = ?"
      ).bind(me).all();

      const subs = rows.results || [];
      if (subs.length === 0) {
        return json(request, {
          ok: false,
          error: "no_subscriptions",
          message: "Keine Push-Subscriptions vorhanden. Erlaube zuerst Notifications.",
          subscriptionCount: 0,
        });
      }

      // Test-Payload bauen
      const testPayload = {
        title: "🔔 RENEX Test-Push",
        body: `Diese Test-Notification wurde um ${new Date().toLocaleTimeString("de-CH")} gesendet. Wenn du sie siehst, funktionieren Notifications!`,
        tag: "renex-test",
        data: {
          type: "test",
          ts: Date.now(),
          url: "/",
        },
      };

      // Pro Subscription Push senden + Status sammeln
      const { sendWebPush } = await import('../helpers/pushSend.js');
      const results = [];
      for (const sub of subs) {
        const subRecord = { ...sub, user_handle: me };
        try {
          const r = await sendWebPush(env, subRecord, testPayload);
          results.push({
            endpointPreview: String(sub.endpoint).slice(0, 60) + "…",
            success: r.success === true,
            status: r.status || null,
            fallback: r.fallback || false,
            expired: r.expired || false,
            error: r.error || null,
          });
        } catch (e) {
          results.push({
            endpointPreview: String(sub.endpoint).slice(0, 60) + "…",
            success: false,
            error: e.message,
          });
        }
      }

      return json(request, {
        ok: results.some(r => r.success),
        subscriptionCount: subs.length,
        results,
        sentAt: Date.now(),
      });
    }

    // ── PAYLOAD (für SW Fallback — holt Push-Daten ohne Encryption) ──
    case "/push/payload": {
      if (request.method !== "GET") break;
      const pushId = new URL(request.url).searchParams.get("id");
      if (!pushId) return json(request, { error: "Missing id" }, 400);

      const raw = await env.RENEX_KV.get(`push_payload:${me}:${pushId}`);
      if (!raw) return json(request, { error: "Not found or expired" }, 404);

      // Einmal lesen, dann löschen
      await env.RENEX_KV.delete(`push_payload:${me}:${pushId}`);
      return json(request, JSON.parse(raw));
    }

    default:
      break;
  }

  return json(request, { error: "Not found" }, 404);
}
