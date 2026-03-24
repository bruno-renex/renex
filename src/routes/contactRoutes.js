import { json, readJson } from '../utils.js';
import { requireSession, rateLimit } from '../auth.js';

// ======================================================
// CONTACT ROUTES: /contacts, /contacts/list,
//                 /contacts/request, /contacts/accept,
//                 /contacts/reject, /contacts/remove
// ======================================================
export async function handleContactRoutes(request, env, path, params) {
  switch (path) {

    // =========================
    // CONTACTS / LIST  (Alias)
    // =========================
    case "/contacts":
    case "/contacts/list": {
      if (request.method === "GET") {

        const session = await requireSession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);

        const handle = session.handle;

        const { results } = await env.RENEX_DB.prepare(
          "SELECT contact_handle, display_handle, status, direction FROM contacts WHERE user_handle = ? AND status != 'removed'"
        ).bind(handle).all();

        return json(request, {
          contacts: results.map(r => ({
            handle: r.contact_handle,
            display_handle: r.display_handle || r.contact_handle,
            status: r.status,
            direction: r.direction ?? undefined,
          }))
        });
      }
      break;
    }

    // =========================
    // CONTACTS / REQUEST
    // =========================
    case "/contacts/request": {
      if (request.method === "POST") {

        const session = await requireSession(request, env);
        if (!session) {
          return json(request, { error: "Not authenticated" }, 401);
        }

        const me = String(session.handle || "").toLowerCase();

        // Kontaktanfrage Rate Limit
        const ok = await rateLimit(
          env,
          `contact_request:${me}`,
          5000,
          1
        );

        if (!ok) {
          return json(request, { error: "Too many contact requests" }, 429);
        }

        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);

        const contact = body.contact;

        const targetHandle = String(contact || "")
          .trim()
          .toLowerCase();

        if (targetHandle === me) {
          return json(request, { error: "Cannot add yourself" }, 400);
        }

        const target = await env.RENEX_KV.get(`webauthn:${targetHandle}`);
        if (!target) return json(request, { error: "Contact not found" }, 404);

        const now = Date.now();

        // Cross-request Guard: hat targetHandle schon einen pending-Request an mich?
        const reverse = await env.RENEX_DB.prepare(
          "SELECT status FROM contacts WHERE user_handle = ? AND contact_handle = ? LIMIT 1"
        ).bind(targetHandle, me).first();

        if (reverse?.status === "pending") {
          // Beide haben gleichzeitig Request geschickt → direkt akzeptieren
          await env.RENEX_DB.prepare(
            "UPDATE contacts SET status = 'accepted', direction = NULL, updated_at = ? WHERE user_handle = ? AND contact_handle = ?"
          ).bind(now, targetHandle, me).run();
          await env.RENEX_DB.prepare(
            "INSERT INTO contacts (user_handle, contact_handle, status, direction, display_handle, created_at, updated_at) VALUES (?, ?, 'accepted', NULL, ?, ?, ?) ON CONFLICT(user_handle, contact_handle) DO UPDATE SET status = 'accepted', direction = NULL, updated_at = excluded.updated_at"
          ).bind(me, targetHandle, targetHandle, now, now).run();
          return json(request, { status: "accepted" });
        }

        // Gibt es bereits einen Eintrag bei targetHandle für mich?
        const existing = await env.RENEX_DB.prepare(
          "SELECT status FROM contacts WHERE user_handle = ? AND contact_handle = ? LIMIT 1"
        ).bind(targetHandle, me).first();

        if (existing) {
          if (existing.status === "pending")  return json(request, { status: "already_pending" });
          if (existing.status === "accepted") return json(request, { status: "already_exists" });
          if (existing.status === "removed") {
            // Wieder aktivieren
            await env.RENEX_DB.prepare(
              "UPDATE contacts SET status = 'pending', direction = 'in', updated_at = ? WHERE user_handle = ? AND contact_handle = ?"
            ).bind(now, targetHandle, me).run();
            return json(request, { status: "requested", contact });
          }
        }

        // Neue Anfrage: beim Empfänger als "in", beim Sender als "out"
        await env.RENEX_DB.prepare(
          "INSERT INTO contacts (user_handle, contact_handle, status, direction, display_handle, created_at, updated_at) VALUES (?, ?, 'pending', 'in', ?, ?, ?) ON CONFLICT(user_handle, contact_handle) DO UPDATE SET status = 'pending', direction = 'in', updated_at = excluded.updated_at"
        ).bind(targetHandle, me, me, now, now).run();

        const mySide = await env.RENEX_DB.prepare(
          "SELECT 1 FROM contacts WHERE user_handle = ? AND contact_handle = ? LIMIT 1"
        ).bind(me, targetHandle).first();

        if (!mySide) {
          await env.RENEX_DB.prepare(
            "INSERT INTO contacts (user_handle, contact_handle, status, direction, display_handle, created_at, updated_at) VALUES (?, ?, 'pending', 'out', ?, ?, ?)"
          ).bind(me, targetHandle, targetHandle, now, now).run();
        }

        return json(request, { status: "requested", contact });
      }
      break;
    }

    // =========================
    // CONTACTS / ACCEPT
    // =========================
    case "/contacts/accept": {
      if (request.method === "POST") {

        const session = await requireSession(request, env);
        if (!session) {
          return json(request, { error: "Not authenticated" }, 401);
        }

        const me = String(session.handle || "").toLowerCase();

        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);

        const { contact } = body;

        const myEntry = await env.RENEX_DB.prepare(
          "SELECT status FROM contacts WHERE user_handle = ? AND contact_handle = ? LIMIT 1"
        ).bind(me, contact).first();

        if (!myEntry) return json(request, { error: "Contact not found" }, 404);
        if (myEntry.status === "accepted") return json(request, { status: "already_accepted" });
        if (myEntry.status !== "pending") return json(request, { error: "Invalid contact state" }, 400);

        const now = Date.now();

        await env.RENEX_DB.prepare(
          "UPDATE contacts SET status = 'accepted', direction = NULL, updated_at = ? WHERE user_handle = ? AND contact_handle = ?"
        ).bind(now, me, contact).run();

        await env.RENEX_DB.prepare(
          "INSERT INTO contacts (user_handle, contact_handle, status, direction, display_handle, created_at, updated_at) VALUES (?, ?, 'accepted', NULL, ?, ?, ?) ON CONFLICT(user_handle, contact_handle) DO UPDATE SET status = 'accepted', direction = NULL, updated_at = excluded.updated_at"
        ).bind(contact, me, me, now, now).run();

        return json(request, { status: "accepted", contact });
      }
      break;
    }

    // =========================
    // CONTACTS / REJECT
    // =========================
    case "/contacts/reject": {
      if (request.method === "POST") {

        const session = await requireSession(request, env);
        if (!session) {
          return json(request, { error: "Not authenticated" }, 401);
        }

        const me = String(session.handle || "").toLowerCase();

        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);

        const { contact } = body;

        const deleted = await env.RENEX_DB.prepare(
          "DELETE FROM contacts WHERE user_handle = ? AND contact_handle = ?"
        ).bind(me, contact).run();

        if (!deleted.meta?.changes) return json(request, { error: "No contacts" }, 404);

        return json(request, { status: "rejected", contact });
      }
      break;
    }

    // =========================
    // CONTACTS / REMOVE
    // =========================
    case "/contacts/remove": {
      if (request.method === "POST") {

        const session = await requireSession(request, env);
        if (!session) {
          return json(request, { error: "Not authenticated" }, 401);
        }

        const me = String(session.handle || "").toLowerCase();

        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);

        const { contact } = body;

        if (!contact || contact === me) {
          return json(request, { error: "Invalid contact" }, 400);
        }

        const now = Date.now();

        await env.RENEX_DB.prepare(
          "UPDATE contacts SET status = 'removed', updated_at = ? WHERE user_handle = ? AND contact_handle = ?"
        ).bind(now, me, contact).run();

        await env.RENEX_DB.prepare(
          "UPDATE contacts SET status = 'removed', updated_at = ? WHERE user_handle = ? AND contact_handle = ?"
        ).bind(now, contact, me).run();

        return json(request, { status: "removed", contact });
      }
      break;
    }

    default:
      break;
  }

  return json(request, { error: "Not found" }, 404);
}
