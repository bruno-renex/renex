import { json, readJson, dmConvoId } from '../utils.js';
import { requireSession, requireAnySession, pushToUserDO } from '../auth.js';

// ======================================================
// AUTO-DELETE ROUTES: /chat/auto-delete
// ======================================================
export async function handleAutoDeleteRoutes(request, env, path, params) {
  switch (path) {

    // =========================
    // AUTO-DELETE PRO CONVERSATION
    // =========================
    case "/chat/auto-delete": {
      const session = await requireAnySession(request, env);
      if (!session) return json(request, { error: "Not authenticated" }, 401);
      const me = session.handle;

      // GET: aktuelles Setting für Conversation laden
      if (request.method === "GET") {
        const url = new URL(request.url);
        const peer = url.searchParams.get("peer");
        if (!peer) return json(request, { error: "peer required" }, 400);
        const convoId = dmConvoId(me, peer);
        const row = await env.RENEX_DB.prepare(
          "SELECT * FROM auto_delete_settings WHERE convo_id = ?"
        ).bind(convoId).first();
        return json(request, row ?? { convo_id: convoId, status: "off" });
      }

      if (request.method === "POST") {
        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);
        const { peer, action, days } = body;
        if (!peer || !action) return json(request, { error: "peer + action required" }, 400);

        // Contact-Check: nur akzeptierte Kontakte
        const contact = await env.RENEX_DB.prepare(
          "SELECT status FROM contacts WHERE user_handle = ? AND contact_handle = ?"
        ).bind(me, peer).first();
        if (contact?.status !== "accepted") return json(request, { error: "Not a contact" }, 403);

        const ALLOWED_DAYS = new Set([0, 1, 7, 30]);
        const convoId = dmConvoId(me, peer);
        const now = Date.now();

        if (action === "propose") {
          if (!ALLOWED_DAYS.has(Number(days))) return json(request, { error: "Invalid days" }, 400);
          // original_days: aktuell aktiven Wert sichern (für Restore bei Ablehnung)
          const existing = await env.RENEX_DB.prepare(
            "SELECT days, status FROM auto_delete_settings WHERE convo_id = ?"
          ).bind(convoId).first();
          const originalDays = (existing?.status === "active" && existing?.days) ? existing.days : null;
          await env.RENEX_DB.prepare(
            `INSERT INTO auto_delete_settings (convo_id, days, original_days, proposed_by, status, updated_at)
             VALUES (?, ?, ?, ?, 'pending', ?)
             ON CONFLICT(convo_id) DO UPDATE SET
               days = excluded.days,
               original_days = excluded.original_days,
               proposed_by = excluded.proposed_by,
               status = 'pending',
               updated_at = excluded.updated_at`
          ).bind(convoId, Number(days), originalDays, me, now).run();

          // Control-Message an Peer
          const ctrl = { id: crypto.randomUUID(), from: me, to: peer, type: "auto_delete_set", action: "propose", days: Number(days), ts: now };
          await pushToUserDO(env, peer, ctrl);
          return json(request, { ok: true, status: "pending", days: Number(days) });
        }

        // Deutsch-Label für persistente D1-System-Messages.
        // (Live-Bubble macht das Frontend i18n-übersetzt — hier nur Reload-Fallback.)
        const autoDeleteLabelDe = (d) => {
          if (d === 1)  return "24h";
          if (d === 7)  return "7 Tage";
          if (d === 30) return "30 Tage";
          return `${d} Tage`;
        };

        if (action === "accept") {
          const row = await env.RENEX_DB.prepare(
            "SELECT * FROM auto_delete_settings WHERE convo_id = ?"
          ).bind(convoId).first();
          if (!row || row.status !== "pending") return json(request, { error: "No pending proposal" }, 400);
          if (row.proposed_by === me) return json(request, { error: "Cannot accept own proposal" }, 400);

          if (row.days === 0 || row.days === null) {
            // Vorschlag war "Deaktivieren" → Zeile löschen
            await env.RENEX_DB.prepare(
              "DELETE FROM auto_delete_settings WHERE convo_id = ?"
            ).bind(convoId).run();
          } else {
            await env.RENEX_DB.prepare(
              "UPDATE auto_delete_settings SET status = 'active', updated_at = ? WHERE convo_id = ?"
            ).bind(now, convoId).run();
          }

          // Persistente System-Message in D1 (analog zu Group). proposed_by ist
          // der "Aktor" der diese Änderung effektiv ausgelöst hat — er hat
          // vorgeschlagen, ich habe akzeptiert. Daher Sicht aus Empfänger-Perspektive:
          // "<proposer> hat Auto-Delete gesetzt: …" — beide Seiten sehen denselben Text.
          const proposer = row.proposed_by || peer;
          const sysText = (row.days && row.days > 0)
            ? `${proposer} hat Auto-Delete gesetzt: ${autoDeleteLabelDe(Number(row.days))}`
            : `${proposer} hat Auto-Delete deaktiviert`;
          await env.RENEX_DB.prepare(
            `INSERT INTO messages (id, convo_id, from_user, to_user, ts, type, message, e2e)
             VALUES (?, ?, ?, NULL, ?, 'system', ?, 0)`
          ).bind(crypto.randomUUID(), convoId, proposer, now, sysText).run();

          // Control-Message an Peer. proposed_by mitgeben, damit der Empfänger
          // die System-Bubble mit konsistentem Namen rendert (gleich wie D1-Message).
          const ctrl = { id: crypto.randomUUID(), from: me, to: peer, type: "auto_delete_set", action: "accept", days: row.days, proposed_by: proposer, ts: now };
          await pushToUserDO(env, peer, ctrl);
          return json(request, { ok: true, status: row.days ? "active" : "off", days: row.days });
        }

        if (action === "decline" || action === "cancel") {
          const row = await env.RENEX_DB.prepare(
            "SELECT * FROM auto_delete_settings WHERE convo_id = ?"
          ).bind(convoId).first();
          const originalDays = row?.original_days ?? null;
          const wasActive = row?.status === "active";

          if (originalDays) {
            // Ursprüngliches aktives Setting wiederherstellen
            await env.RENEX_DB.prepare(
              "UPDATE auto_delete_settings SET days = ?, original_days = NULL, status = 'active', updated_at = ? WHERE convo_id = ?"
            ).bind(originalDays, now, convoId).run();
          } else {
            await env.RENEX_DB.prepare(
              "DELETE FROM auto_delete_settings WHERE convo_id = ?"
            ).bind(convoId).run();
          }

          // Persistente D1-System-Message NUR wenn `cancel` ein aktives Setting
          // deaktiviert (status === 'active'). Bei `decline` (Vorschlag abgelehnt)
          // oder `cancel` eines `pending`-Vorschlags: KEIN INSERT — das bleibt
          // ephemerer Konsens-State, kein "wirksamer" Zustandswechsel.
          if (action === "cancel" && wasActive && !originalDays) {
            await env.RENEX_DB.prepare(
              `INSERT INTO messages (id, convo_id, from_user, to_user, ts, type, message, e2e)
               VALUES (?, ?, ?, NULL, ?, 'system', ?, 0)`
            ).bind(crypto.randomUUID(), convoId, me, now,
              `${me} hat Auto-Delete deaktiviert`).run();
          }

          // Control-Message an Peer (mit original_days für Client-Restore)
          const ctrl = { id: crypto.randomUUID(), from: me, to: peer, type: "auto_delete_set", action, original_days: originalDays, ts: now };
          await pushToUserDO(env, peer, ctrl);
          return json(request, { ok: true, status: originalDays ? "active" : "off", original_days: originalDays });
        }

        return json(request, { error: "Invalid action" }, 400);
      }
      break;
    }

    default:
      break;
  }

  return json(request, { error: "Not found" }, 404);
}
