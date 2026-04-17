// ======================================================
// VOICE ROUTES — Phase 1: Signaling-Relay + Call-Log
//
// Kein Audio fliesst über den Worker. Der Worker relayed nur
// WebRTC-Signaling (SDP/ICE) zwischen zwei Peers, führt Call-
// State in KV und schreibt eine Zeile pro Call ins D1 call_log.
//
// Peer-Messaging geht via pushToUserDO → bestehender WebSocket.
// Front-Channel (voiceSignaling.js) hört voice:* Events ab und
// routet sie an voiceUI.js.
// ======================================================
import { json, readJson, checkCsrf, dmConvoId, UUID_RE } from '../utils.js';
import { requireSession, isAcceptedContact, pushToUserDO, rateLimit } from '../auth.js';
import { pushToUser } from '../helpers/pushSend.js';

// Call-State wird 60s gehalten — jeder Signaling-Call refreshed die TTL.
// Verhindert Zombie-State wenn Client abschmiert.
const CALL_STATE_TTL = 60;

// Handle-Format (gleich wie im restlichen RENEX-Code)
const HANDLE_RE = /^[a-z0-9_]{1,30}$/;

// Sanity-Limits (verhindern Missbrauch des Relay-Kanals)
const MAX_SDP_BYTES = 32 * 1024;   // SDP typischerweise 3–8 KB
const MAX_ICE_BYTES = 2 * 1024;    // ICE-Candidate <500 B

function isHandle(h) {
  return typeof h === "string" && HANDLE_RE.test(h);
}

function isCallId(id) {
  return typeof id === "string" && UUID_RE.test(id);
}

async function getVoiceState(env, handle) {
  try {
    const raw = await env.RENEX_KV.get(`voice_state:${handle}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function setVoiceState(env, handle, state) {
  await env.RENEX_KV.put(
    `voice_state:${handle}`,
    JSON.stringify({ ...state, ts: Date.now() }),
    { expirationTtl: CALL_STATE_TTL }
  );
}

async function clearVoiceState(env, handle) {
  await env.RENEX_KV.delete(`voice_state:${handle}`).catch(() => {});
}

// Hilfsfunktion: WS-Event mit eindeutiger ID und Timestamp versehen
// (controlSocket.js verwirft Events ohne id / zu alte Events)
function makeEvent(payload) {
  return {
    id: crypto.randomUUID(),
    ts: Date.now(),
    ...payload,
  };
}

// ==========================================================
// Call-Lookup via D1 (call_log) — Source of Truth für
// Signaling-State-Validation. KV ist eventually-consistent
// zwischen Edges und kann bei /voice/answer /ice 404s erzeugen,
// wenn Ring und Answer von unterschiedlichen Edges kommen.
//
// D1-Reads haben sub-sekundäre Replikations-Latenz — falls ein
// Read nichts findet, einmal kurz retry'en.
// ==========================================================
async function getCallForUser(env, callId, me, { retry = true } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const row = await env.RENEX_DB.prepare(
        `SELECT id, caller, callee, status, started_at, answered_at
           FROM call_log WHERE id = ?`
      ).bind(callId).first();
      if (row && (row.caller === me || row.callee === me)) {
        return {
          ...row,
          peer: row.caller === me ? row.callee : row.caller,
          role: row.caller === me ? "caller" : "callee",
        };
      }
    } catch { /* ignore, retry */ }
    if (!retry || attempt >= 1) break;
    // Kurzer Retry für D1-Replica-Lag
    await new Promise(r => setTimeout(r, 150));
  }
  return null;
}

// ======================================================
export async function handleVoiceRoutes(request, env, path, params) {
  // CSRF-Schutz für state-mutierende Requests
  const csrfFail = checkCsrf(request);
  if (csrfFail) return csrfFail;

  const session = await requireSession(request, env);
  if (!session) return json(request, { error: "Not authenticated" }, 401);
  const me = String(session.handle).toLowerCase();

  switch (path) {

    // ──────────────────────────────────────────────────
    // POST /voice/ring — Anruf starten
    // Body: { to: <handle>, callId: <uuid>, sdp: { type, sdp } }
    // ──────────────────────────────────────────────────
    case "/voice/ring": {
      if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);

      // Rate-Limit: max 20 Ring-Versuche pro Minute (gegen Spam)
      if (!(await rateLimit(env, `voice_ring:${me}`, 60_000, 20, { failOpen: false }))) {
        return json(request, { error: "Rate limit exceeded" }, 429);
      }

      const body = await readJson(request);
      if (!body) return json(request, { error: "Invalid JSON" }, 400);

      const to     = String(body.to || "").toLowerCase();
      const callId = String(body.callId || "");
      const sdp    = body.sdp;

      if (!isHandle(to))    return json(request, { error: "Invalid 'to'" }, 400);
      if (!isCallId(callId)) return json(request, { error: "Invalid 'callId'" }, 400);
      if (to === me)        return json(request, { error: "Cannot call yourself" }, 400);
      if (!sdp || typeof sdp !== "object" || sdp.type !== "offer" || typeof sdp.sdp !== "string") {
        return json(request, { error: "Invalid 'sdp' (expected offer)" }, 400);
      }
      if (sdp.sdp.length > MAX_SDP_BYTES) {
        return json(request, { error: "SDP too large" }, 413);
      }

      // Kontakt-Check (nur gegenseitige Kontakte dürfen sich anrufen)
      if (!(await isAcceptedContact(env, me, to))) {
        return json(request, { error: "Not a contact" }, 403);
      }
      if (!(await isAcceptedContact(env, to, me))) {
        return json(request, { error: "Not a contact" }, 403);
      }

      // Busy-Check beim Callee
      const peerState = await getVoiceState(env, to);
      if (peerState && peerState.state && peerState.state !== "idle") {
        return json(request, { error: "busy", peerState: peerState.state }, 409);
      }
      // Busy-Check bei mir (bereits in einem Call?)
      const myState = await getVoiceState(env, me);
      if (myState && myState.state && myState.state !== "idle") {
        return json(request, { error: "already in call" }, 409);
      }

      const startedAt = Date.now();

      // Call-State für beide Seiten setzen
      await Promise.all([
        setVoiceState(env, me, { state: "calling", callId, peer: to, startedAt }),
        setVoiceState(env, to, { state: "ringing", callId, peer: me, startedAt }),
      ]);

      // Call-Log schreiben
      try {
        await env.RENEX_DB.prepare(
          `INSERT INTO call_log (id, caller, callee, convo_id, kind, started_at, status)
           VALUES (?, ?, ?, ?, 'voice', ?, 'ringing')`
        ).bind(callId, me, to, dmConvoId(me, to), startedAt).run();
      } catch (e) {
        // Duplikat (retry) → ignorieren, weiterleiten trotzdem
        console.warn("call_log insert skipped:", e?.message);
      }

      // Peer benachrichtigen (WS via Durable Object)
      const delivered = await pushToUserDO(env, to, makeEvent({
        type: "voice:ring",
        from: me,
        callId,
        sdp,
        startedAt,
      }));

      // Fallback: wenn Peer offline (keine WS-Verbindung) → WebPush
      // Der Service Worker öffnet /chat/?with=<caller>&call=1
      // und triggert dort einen (erneuten) Call. SDP wird dabei neu
      // verhandelt, weil der erste Offer dann wahrscheinlich abgelaufen ist.
      if (delivered === 0) {
        // fire-and-forget (nie blockierend)
        pushToUser(env, to, {
          title: "📞 Eingehender Anruf",
          body:  `${me} ruft dich an`,
          tag:   `voice-call-${callId}`,
          icon:  "/icons/icon-192.png",
          data: {
            type:    "voice_call",
            from:    me,
            callId,
            url:     `/chat/?with=${encodeURIComponent(me)}&call=1`,
          },
        }).catch(() => {});
      }

      return json(request, { ok: true, callId, delivered });
    }

    // ──────────────────────────────────────────────────
    // POST /voice/answer — Anruf annehmen
    // Body: { callId, sdp: { type: "answer", sdp } }
    // ──────────────────────────────────────────────────
    case "/voice/answer": {
      if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);

      const body = await readJson(request);
      if (!body) return json(request, { error: "Invalid JSON" }, 400);

      const callId = String(body.callId || "");
      const sdp    = body.sdp;

      if (!isCallId(callId)) return json(request, { error: "Invalid 'callId'" }, 400);
      if (!sdp || typeof sdp !== "object" || sdp.type !== "answer" || typeof sdp.sdp !== "string") {
        return json(request, { error: "Invalid 'sdp' (expected answer)" }, 400);
      }
      if (sdp.sdp.length > MAX_SDP_BYTES) return json(request, { error: "SDP too large" }, 413);

      // Source of truth: call_log (D1, stark konsistent)
      const call = await getCallForUser(env, callId, me);
      if (!call || call.role !== "callee" || call.status !== "ringing") {
        return json(request, { error: "No matching incoming call" }, 404);
      }
      const peer = call.peer;
      if (!isHandle(peer)) return json(request, { error: "Invalid call state" }, 500);

      const answeredAt = Date.now();

      // KV-State "best effort" auffrischen (Busy-Check-Cache)
      await Promise.all([
        setVoiceState(env, me,   { state: "connected", callId, peer, startedAt: call.started_at, answeredAt }),
        setVoiceState(env, peer, { state: "connected", callId, peer: me, startedAt: call.started_at, answeredAt }),
      ]);

      // Call-Log aktualisieren
      try {
        await env.RENEX_DB.prepare(
          `UPDATE call_log SET answered_at = ?, status = 'connected' WHERE id = ?`
        ).bind(answeredAt, callId).run();
      } catch (e) {
        console.warn("call_log answer update failed:", e?.message);
      }

      // Caller benachrichtigen
      const delivered = await pushToUserDO(env, peer, makeEvent({
        type: "voice:answer",
        from: me,
        callId,
        sdp,
        answeredAt,
      }));

      return json(request, { ok: true, delivered });
    }

    // ──────────────────────────────────────────────────
    // POST /voice/ice — ICE-Candidate relayen (trickle)
    // Body: { to, callId, candidate: { candidate, sdpMid, sdpMLineIndex, usernameFragment } }
    // ──────────────────────────────────────────────────
    case "/voice/ice": {
      if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);

      const body = await readJson(request);
      if (!body) return json(request, { error: "Invalid JSON" }, 400);

      const to     = String(body.to || "").toLowerCase();
      const callId = String(body.callId || "");
      const candidate = body.candidate;

      if (!isHandle(to))     return json(request, { error: "Invalid 'to'" }, 400);
      if (!isCallId(callId)) return json(request, { error: "Invalid 'callId'" }, 400);
      if (!candidate || typeof candidate !== "object") {
        return json(request, { error: "Invalid 'candidate'" }, 400);
      }
      try {
        if (JSON.stringify(candidate).length > MAX_ICE_BYTES) {
          return json(request, { error: "Candidate too large" }, 413);
        }
      } catch {
        return json(request, { error: "Invalid 'candidate'" }, 400);
      }

      // Source of truth: call_log (D1, stark konsistent)
      const call = await getCallForUser(env, callId, me);
      if (!call || !["ringing", "connected"].includes(call.status)) {
        return json(request, { error: "No matching call" }, 404);
      }
      if (call.peer !== to) {
        return json(request, { error: "Wrong peer" }, 400);
      }

      const delivered = await pushToUserDO(env, to, makeEvent({
        type: "voice:ice",
        from: me,
        callId,
        candidate,
      }));

      return json(request, { ok: true, delivered });
    }

    // ──────────────────────────────────────────────────
    // POST /voice/decline — eingehenden Anruf ablehnen
    // Body: { callId }
    // ──────────────────────────────────────────────────
    case "/voice/decline": {
      if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);

      const body = await readJson(request);
      if (!body) return json(request, { error: "Invalid JSON" }, 400);
      const callId = String(body.callId || "");
      if (!isCallId(callId)) return json(request, { error: "Invalid 'callId'" }, 400);

      const call = await getCallForUser(env, callId, me);
      const peer = call?.peer;
      const endedAt = Date.now();

      // Call-Log: declined
      try {
        await env.RENEX_DB.prepare(
          `UPDATE call_log SET ended_at = ?, status = 'declined', end_reason = 'decline' WHERE id = ?`
        ).bind(endedAt, callId).run();
      } catch (e) {
        console.warn("call_log decline update failed:", e?.message);
      }

      await Promise.all([
        clearVoiceState(env, me),
        peer ? clearVoiceState(env, peer) : Promise.resolve(),
      ]);

      if (peer && isHandle(peer)) {
        await pushToUserDO(env, peer, makeEvent({
          type: "voice:decline",
          from: me,
          callId,
          endedAt,
        }));
      }

      return json(request, { ok: true });
    }

    // ──────────────────────────────────────────────────
    // POST /voice/cancel — ausgehenden Anruf abbrechen (vor Answer)
    // Body: { callId, to }
    // ──────────────────────────────────────────────────
    case "/voice/cancel": {
      if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);

      const body = await readJson(request);
      if (!body) return json(request, { error: "Invalid JSON" }, 400);
      const callId = String(body.callId || "");
      const to     = String(body.to || "").toLowerCase();
      if (!isCallId(callId)) return json(request, { error: "Invalid 'callId'" }, 400);
      if (!isHandle(to))     return json(request, { error: "Invalid 'to'" }, 400);

      const endedAt = Date.now();

      try {
        await env.RENEX_DB.prepare(
          `UPDATE call_log
              SET ended_at = ?, status = 'missed', end_reason = 'cancel',
                  duration_s = 0
            WHERE id = ? AND caller = ?`
        ).bind(endedAt, callId, me).run();
      } catch (e) {
        console.warn("call_log cancel update failed:", e?.message);
      }

      await Promise.all([
        clearVoiceState(env, me),
        clearVoiceState(env, to),
      ]);

      await pushToUserDO(env, to, makeEvent({
        type: "voice:cancel",
        from: me,
        callId,
        endedAt,
      }));

      return json(request, { ok: true });
    }

    // ──────────────────────────────────────────────────
    // POST /voice/hangup — laufenden Anruf beenden
    // Body: { callId, to }
    // ──────────────────────────────────────────────────
    case "/voice/hangup": {
      if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);

      const body = await readJson(request);
      if (!body) return json(request, { error: "Invalid JSON" }, 400);
      const callId = String(body.callId || "");
      const to     = String(body.to || "").toLowerCase();
      if (!isCallId(callId)) return json(request, { error: "Invalid 'callId'" }, 400);
      if (!isHandle(to))     return json(request, { error: "Invalid 'to'" }, 400);

      const endedAt = Date.now();

      // Dauer aus answered_at berechnen (falls vorhanden)
      try {
        const row = await env.RENEX_DB.prepare(
          `SELECT answered_at, started_at FROM call_log WHERE id = ?`
        ).bind(callId).first();
        const base = row?.answered_at || row?.started_at || endedAt;
        const duration_s = Math.max(0, Math.round((endedAt - base) / 1000));
        await env.RENEX_DB.prepare(
          `UPDATE call_log
              SET ended_at = ?, duration_s = ?, status = 'ended', end_reason = 'hangup'
            WHERE id = ?`
        ).bind(endedAt, duration_s, callId).run();
      } catch (e) {
        console.warn("call_log hangup update failed:", e?.message);
      }

      await Promise.all([
        clearVoiceState(env, me),
        clearVoiceState(env, to),
      ]);

      await pushToUserDO(env, to, makeEvent({
        type: "voice:hangup",
        from: me,
        callId,
        endedAt,
      }));

      return json(request, { ok: true });
    }

    // ──────────────────────────────────────────────────
    // GET /voice/history?limit=50
    // ──────────────────────────────────────────────────
    case "/voice/history": {
      if (request.method !== "GET") return json(request, { error: "Method not allowed" }, 405);

      let limit = parseInt(params.get("limit") || "50", 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 50;
      if (limit > 200) limit = 200;

      const rows = await env.RENEX_DB.prepare(
        `SELECT id, caller, callee, convo_id, kind, started_at, answered_at,
                ended_at, duration_s, status, end_reason
           FROM call_log
          WHERE caller = ? OR callee = ?
          ORDER BY started_at DESC
          LIMIT ?`
      ).bind(me, me, limit).all();

      return json(request, { calls: rows.results || [] });
    }

    // ──────────────────────────────────────────────────
    // GET /voice/turn-credentials
    // Versucht zuerst Cloudflare Realtime TURN (wenn CF_TURN_KEY_ID +
    // CF_TURN_API_TOKEN als Secrets gesetzt sind). Bei Fehler oder
    // ohne Konfiguration → STUN-Only Fallback.
    //
    // Cloudflare Realtime TURN API:
    //   POST https://rtc.live.cloudflare.com/v1/turn/keys/<KEY_ID>/credentials/generate
    //   Authorization: Bearer <API_TOKEN>
    //   Body: { ttl: 3600 }
    //   Response: { iceServers: { urls: [...], username, credential } }
    // ──────────────────────────────────────────────────
    case "/voice/turn-credentials": {
      if (request.method !== "GET") return json(request, { error: "Method not allowed" }, 405);

      const TTL_SEC = 3600; // 1h — WebRTC hält danach keepalive selbst
      const keyId = env.CF_TURN_KEY_ID;
      const token = env.CF_TURN_API_TOKEN;

      const stunOnly = {
        iceServers: [
          { urls: "stun:stun.cloudflare.com:3478" },
          { urls: "stun:stun.l.google.com:19302" },
        ],
        ttl: TTL_SEC,
      };

      if (!keyId || !token) {
        return json(request, stunOnly);
      }

      try {
        const res = await fetch(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${token}`,
              "Content-Type":  "application/json",
            },
            body: JSON.stringify({ ttl: TTL_SEC }),
          }
        );
        if (!res.ok) {
          console.warn("CF TURN: HTTP", res.status);
          return json(request, stunOnly);
        }
        const data = await res.json();
        // CF gibt { iceServers: { urls, username, credential } } zurück — eine Zeile.
        // Wir prepend-en STUN, damit auch ohne TURN eine Verbindung probiert wird.
        const cfIce = data?.iceServers || data;
        const cfList = Array.isArray(cfIce) ? cfIce : [cfIce];
        const iceServers = [
          { urls: "stun:stun.cloudflare.com:3478" },
          ...cfList,
        ];
        return json(request, { iceServers, ttl: TTL_SEC });
      } catch (e) {
        console.warn("CF TURN generate failed:", e?.message);
        return json(request, stunOnly);
      }
    }

    default:
      return json(request, { error: "Not found" }, 404);
  }
}
