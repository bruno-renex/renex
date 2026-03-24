import { json } from '../utils.js';
import { requireSession, getToken } from '../auth.js';

// ======================================================
// WS ROUTES: /chat/ws, /chat/control, /chat/test
// ======================================================
export async function handleWsRoutes(request, env, path, params) {
  switch (path) {

    // =========================
    // CHAT / TEST
    // =========================
    case "/chat/test": {
      if (request.method === "GET") {
        const session = await requireSession(request, env);
        if (!session) {
          return json(request, { error: "Not authenticated" }, 401);
        }
        return json(request, {
          ok: true,
          me: session.handle
        });
      }
      break;
    }

    // ======================================================
    // CHAT / WS — WebSocket Upgrade (ersetzt /chat/control)
    // Token kommt als Query-Param weil Browser keine
    // Authorization-Header bei WebSocket senden können.
    // ======================================================
    case "/chat/ws": {
      if (request.headers.get("Upgrade") === "websocket") {

        let wsHandle;

        // 1) WS-Ticket (bevorzugt): Einmal-Token aus ?ticket= — nie persistent in Logs
        const ticketParam = params.get("ticket");
        if (ticketParam && /^wst_[0-9a-f-]{36}$/.test(ticketParam)) {
          const rawTicket = await env.RENEX_KV.get(`ws-ticket:${ticketParam}`);
          if (!rawTicket) return new Response("Invalid or expired ticket", { status: 401 });
          // Sofort löschen — Einmal-Ticket (One-Time-Use)
          await env.RENEX_KV.delete(`ws-ticket:${ticketParam}`);
          let ticketData;
          try { ticketData = JSON.parse(rawTicket); } catch { return new Response("Unauthorized", { status: 401 }); }
          wsHandle = String(ticketData.handle).toLowerCase();

        } else {
          // 2) Cookie-Fallback (Browser sendet HttpOnly-Cookie automatisch beim WS-Upgrade)
          const wsToken = getToken(request);
          if (!wsToken) return new Response("Missing auth", { status: 401 });

          const rawSess = await env.RENEX_KV.get(`session:${wsToken}`);
          if (!rawSess) return new Response("Unauthorized", { status: 401 });

          let wsSess;
          try { wsSess = JSON.parse(rawSess); } catch { return new Response("Unauthorized", { status: 401 }); }

          if (!wsSess?.handle || (wsSess?.exp && Date.now() > Number(wsSess.exp))) {
            return new Response("Session expired", { status: 401 });
          }
          wsHandle = String(wsSess.handle).toLowerCase();
        }

        // An UserSessionDO weiterleiten
        const doId = env.USER_SESSION_DO.idFromName(wsHandle);
        const stub = env.USER_SESSION_DO.get(doId);
        return stub.fetch(request);
      }
      break;
    }

    // /chat/control war der alte Long-Polling Fallback (entfernt — WebSocket via /chat/ws)
    case "/chat/control":
      return json(request, { error: "Use WebSocket /chat/ws instead" }, 410);

    default:
      break;
  }

  return json(request, { error: "Not found" }, 404);
}
