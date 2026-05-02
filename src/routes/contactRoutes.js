import { json, readJson, corsHeaders, checkCsrf, bumpContactsVersion } from '../utils.js';
import { requireSession, rateLimit, pushToUserDO } from '../auth.js';

// ======================================================
// CONTACT ROUTES: /contacts, /contacts/list,
//                 /contacts/request, /contacts/accept,
//                 /contacts/reject, /contacts/remove
// ======================================================
export async function handleContactRoutes(request, env, path, params) {
  const csrfErr = checkCsrf(request);
  if (csrfErr) return csrfErr;

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

        // Rate-Limit: 60 req/min — Polling alle 30s = 2/min, Multi-Tab + ETag-Refresh ok.
        const rl = await rateLimit(env, `contacts_list:${handle}`, 60_000, 60);
        if (!rl) return json(request, { error: "Too many requests" }, 429);

        // ── ETag via KV-Versions-Token ────────────────────────────
        // Jede Kontakt-Mutation (request/accept/reject/remove) bump dieses Token.
        // Wenn Token unverändert → 304 ohne DB-Query.
        const kvKey     = `contacts_v:${handle}`;
        const version   = (await env.RENEX_KV.get(kvKey)) || "0";
        const clientEtag = request.headers.get("If-None-Match");
        if (clientEtag && clientEtag === version) {
          return new Response(null, { status: 304 });
        }

        const now = Date.now();
        const { results } = await env.RENEX_DB.prepare(`
          SELECT c.contact_handle, c.display_handle, c.status, c.direction,
            (SELECT MAX(ts) FROM messages
             WHERE convo_id = IIF(? < c.contact_handle,
               ? || ':' || c.contact_handle,
               c.contact_handle || ':' || ?)
            ) as last_ts
          FROM contacts c
          WHERE c.user_handle = ? AND c.status NOT IN ('removed', 'rejected')
            AND (
              c.contact_handle NOT LIKE 'guest_%'
              OR EXISTS (
                SELECT 1 FROM guest_sessions gs
                WHERE gs.guest_handle = c.contact_handle
                  AND gs.expires_at > ?
                  AND gs.converted_to IS NULL
              )
            )
          ORDER BY COALESCE(last_ts, 0) DESC
        `).bind(handle, handle, handle, handle, now).all();

        const body = JSON.stringify({
          contacts: results.map(r => ({
            handle: r.contact_handle,
            display_handle: r.display_handle || r.contact_handle,
            status: r.status,
            direction: r.direction ?? undefined,
            last_ts: r.last_ts || null,
          }))
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json", "ETag": version, ...corsHeaders(request) }
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

        // Tombstone-Check: Account wurde gelöscht (KV ist eventually consistent,
        // dieser Marker schliesst das Lag-Fenster und bleibt 300 Tage bestehen)
        const deletedFlag = await env.RENEX_KV.get(`deleted:${targetHandle}`);
        if (deletedFlag) {
          return json(request, { error: "account_deleted" }, 410);
        }

        const now = Date.now();

        // 7-Tage-Cooldown: Hat targetHandle meine Anfrage kürzlich abgelehnt?
        const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
        const rejectedEntry = await env.RENEX_DB.prepare(
          "SELECT updated_at FROM contacts WHERE user_handle = ? AND contact_handle = ? AND status = 'rejected' LIMIT 1"
        ).bind(me, targetHandle).first();
        if (rejectedEntry && (now - rejectedEntry.updated_at) < COOLDOWN_MS) {
          return json(request, { status: "cooldown", error: "cooldown" }, 429);
        }

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
          await bumpContactsVersion(env, me, targetHandle);
          return json(request, { status: "accepted" });
        }

        // Gibt es bereits einen Eintrag bei targetHandle für mich?
        const existing = await env.RENEX_DB.prepare(
          "SELECT status FROM contacts WHERE user_handle = ? AND contact_handle = ? LIMIT 1"
        ).bind(targetHandle, me).first();

        if (existing) {
          if (existing.status === "pending")  return json(request, { status: "already_pending" });
          if (existing.status === "accepted") return json(request, { status: "already_exists" });
          if (existing.status === "account_deleted") {
            return json(request, { error: "account_deleted" }, 410);
          }
          if (existing.status === "removed") {
            // Empfänger (bob→alice): eingehende Anfrage
            await env.RENEX_DB.prepare(
              "UPDATE contacts SET status = 'pending', direction = 'in', updated_at = ? WHERE user_handle = ? AND contact_handle = ?"
            ).bind(now, targetHandle, me).run();
            // Sender (alice→bob): ausgehende Anfrage — war 'removed', muss auf 'pending/out'
            await env.RENEX_DB.prepare(
              "UPDATE contacts SET status = 'pending', direction = 'out', updated_at = ? WHERE user_handle = ? AND contact_handle = ?"
            ).bind(now, me, targetHandle).run();
            await bumpContactsVersion(env, me, targetHandle);
            return json(request, { status: "requested", contact });
          }
        }

        // Neue Anfrage: beim Empfänger als "in", beim Sender als "out"
        await env.RENEX_DB.prepare(
          "INSERT INTO contacts (user_handle, contact_handle, status, direction, display_handle, created_at, updated_at) VALUES (?, ?, 'pending', 'in', ?, ?, ?) ON CONFLICT(user_handle, contact_handle) DO UPDATE SET status = 'pending', direction = 'in', updated_at = excluded.updated_at"
        ).bind(targetHandle, me, me, now, now).run();

        const mySide = await env.RENEX_DB.prepare(
          "SELECT status FROM contacts WHERE user_handle = ? AND contact_handle = ? LIMIT 1"
        ).bind(me, targetHandle).first();

        if (!mySide) {
          await env.RENEX_DB.prepare(
            "INSERT INTO contacts (user_handle, contact_handle, status, direction, display_handle, created_at, updated_at) VALUES (?, ?, 'pending', 'out', ?, ?, ?)"
          ).bind(me, targetHandle, targetHandle, now, now).run();
        } else if (mySide.status === "rejected") {
          // Nach Cooldown-Ablauf: rejected → pending/out zurücksetzen
          await env.RENEX_DB.prepare(
            "UPDATE contacts SET status = 'pending', direction = 'out', updated_at = ? WHERE user_handle = ? AND contact_handle = ?"
          ).bind(now, me, targetHandle).run();
        }

        // Empfänger live benachrichtigen → Badge + Liste sofort aktualisieren
        // (ohne diesen Push sieht der Empfänger die Anfrage erst beim nächsten Reload)
        await pushToUserDO(env, targetHandle, {
          id:   crypto.randomUUID(),
          type: "contact_request",
          from: me,
          ts:   now,
        }).catch(() => {});

        await bumpContactsVersion(env, me, targetHandle);
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

        // Rate-limit: 30/min reicht für legitime UX, schützt gegen Spam-Mutations
        const rlOk = await rateLimit(env, `contacts_accept:${session.handle}`, 60_000, 30);
        if (!rlOk) return json(request, { error: "Too many requests" }, 429);

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

        // Antragssteller live benachrichtigen → Badge + Liste sofort aktualisieren
        await pushToUserDO(env, contact, {
          id:   crypto.randomUUID(),
          type: "contact_accepted",
          from: me,
          ts:   now
        }).catch(() => {});

        await bumpContactsVersion(env, me, contact);
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

        const rlOk = await rateLimit(env, `contacts_reject:${session.handle}`, 60_000, 30);
        if (!rlOk) return json(request, { error: "Too many requests" }, 429);

        const me = String(session.handle || "").toLowerCase();

        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);

        const { contact } = body;

        const deleted = await env.RENEX_DB.prepare(
          "DELETE FROM contacts WHERE user_handle = ? AND contact_handle = ?"
        ).bind(me, contact).run();

        if (!deleted.meta?.changes) return json(request, { error: "No contacts" }, 404);

        // Sender-Eintrag auf 'rejected' setzen → 7-Tage-Cooldown + stille Ablehnung
        const now = Date.now();
        await env.RENEX_DB.prepare(
          "UPDATE contacts SET status = 'rejected', direction = NULL, updated_at = ? WHERE user_handle = ? AND contact_handle = ?"
        ).bind(now, contact, me).run();

        // Stiller Push → Requester aktualisiert sofort seine Kontaktliste (kein "rejected"-Hinweis)
        await pushToUserDO(env, contact, {
          id:   crypto.randomUUID(),
          type: "contact_update",
          ts:   now
        }).catch(() => {});

        await bumpContactsVersion(env, me, contact);
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

        const rlOk = await rateLimit(env, `contacts_remove:${session.handle}`, 60_000, 30);
        if (!rlOk) return json(request, { error: "Too many requests" }, 429);

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

        // ── Guest-Kontakt: Session invalidieren + aufräumen ──────────
        if (contact.startsWith("guest_")) {
          // Guest-Session expiren (alle Sessions mit diesem Handle)
          await env.RENEX_DB.prepare(
            "UPDATE guest_sessions SET expires_at = 0 WHERE guest_handle = ?"
          ).bind(contact).run();
          // KV-Cache invalidieren
          const guestSessions = await env.RENEX_DB.prepare(
            "SELECT token FROM guest_sessions WHERE guest_handle = ?"
          ).bind(contact).all();
          for (const gs of (guestSessions.results || [])) {
            env.RENEX_KV.delete(`guest_session:${gs.token}`).catch(() => {});
          }
          // Guest aus conversation_members entfernen
          await env.RENEX_DB.prepare(
            "DELETE FROM conversation_members WHERE member_handle = ? AND role = 'guest'"
          ).bind(contact).run();
          // Unread-Counter löschen (beide Richtungen)
          await env.RENEX_DB.prepare(
            "DELETE FROM unread_counters WHERE (owner = ? AND sender = ?) OR (owner = ? AND sender = ?)"
          ).bind(me, contact, contact, me).run();
        }

        await bumpContactsVersion(env, me, contact);
        return json(request, { status: "removed", contact });
      }
      break;
    }

    // =========================
    // CONTACTS / CANCEL  (ausgehende Anfrage zurückziehen)
    // =========================
    case "/contacts/cancel": {
      if (request.method === "POST") {
        const session = await requireSession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);

        const rlOk = await rateLimit(env, `contacts_cancel:${session.handle}`, 60_000, 30);
        if (!rlOk) return json(request, { error: "Too many requests" }, 429);

        const me = String(session.handle || "").toLowerCase();
        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);

        const { contact } = body;
        if (!contact || contact === me) return json(request, { error: "Invalid contact" }, 400);

        // Nur eigene ausgehende Anfragen dürfen zurückgezogen werden
        const row = await env.RENEX_DB.prepare(
          "SELECT 1 FROM contacts WHERE user_handle = ? AND contact_handle = ? AND status = 'pending' AND direction = 'out'"
        ).bind(me, contact).first();
        if (!row) return json(request, { error: "No pending outgoing request" }, 404);

        const now = Date.now();
        // Eigenen Eintrag löschen
        await env.RENEX_DB.prepare(
          "DELETE FROM contacts WHERE user_handle = ? AND contact_handle = ?"
        ).bind(me, contact).run();
        // Empfänger-Eintrag ebenfalls löschen (war direction='in')
        await env.RENEX_DB.prepare(
          "DELETE FROM contacts WHERE user_handle = ? AND contact_handle = ?"
        ).bind(contact, me).run();

        // Stiller Push → Empfänger aktualisiert sofort seine Kontaktliste
        await pushToUserDO(env, contact, {
          id:   crypto.randomUUID(),
          type: "contact_update",
          ts:   now
        }).catch(() => {});

        await bumpContactsVersion(env, me, contact);
        return json(request, { status: "cancelled", contact });
      }
      break;
    }

    default:
      break;
  }

  return json(request, { error: "Not found" }, 404);
}
