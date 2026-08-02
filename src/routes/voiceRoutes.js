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
import { json, readJson, checkCsrf, dmConvoId, UUID_RE, isUUID } from '../utils.js';
import { requireSession, isAcceptedContact, pushToUserDO, rateLimit } from '../auth.js';
import { pushToUser } from '../helpers/pushSend.js';

// Voice-Rooms (Phase 5) — mesh P2P, max 4 members for stability
const ROOM_MEMBER_TTL = 180;       // seconds — heartbeat jede 45s client-side,
                                   // bis zu 3 Fehler in Folge toleriert (135s)
const ROOM_MAX_MEMBERS = 4;        // mesh-limit; >4 → SFU nötig (future)

async function getRoom(env, roomId) {
  try {
    const raw = await env.RENEX_KV.get(`voice_room:${roomId}`);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    // Inaktive Members rausfiltern (TTL-Schutz falls letzter heartbeat > TTL)
    const cutoff = Date.now() - ROOM_MEMBER_TTL * 1000;
    return Array.isArray(arr) ? arr.filter(m => m.lastSeen > cutoff) : [];
  } catch { return []; }
}

async function putRoom(env, roomId, members) {
  if (!members.length) {
    await env.RENEX_KV.delete(`voice_room:${roomId}`).catch(() => {});
    return;
  }
  await env.RENEX_KV.put(
    `voice_room:${roomId}`,
    JSON.stringify(members),
    { expirationTtl: ROOM_MEMBER_TTL * 2 }  // KV-TTL doppelt so lang, clients räumen
  );
}

async function isGroupMember(env, groupId, handle) {
  try {
    const row = await env.RENEX_DB.prepare(
      `SELECT 1 FROM conversation_members WHERE convo_id = ? AND member_handle = ? LIMIT 1`
    ).bind(groupId, handle).first();
    return !!row;
  } catch { return false; }
}

// Call-State wird 90s gehalten — jeder Signaling-Call refreshed die TTL.
// Verhindert Zombie-State wenn Client abschmiert. War vorher 60s, hochgesetzt
// damit der KV-Slot länger lebt als der Caller-No-Answer-Timer (60s) — sonst
// Race wo /voice/active nach Banner-Tap ins Leere greift kurz vor Cancel.
const CALL_STATE_TTL = 90;

// Handle-Format (gleich wie im restlichen RENEX-Code)
const HANDLE_RE = /^[a-z0-9_]{1,30}$/;

// Sanity-Limits (verhindern Missbrauch des Relay-Kanals)
const MAX_SDP_BYTES = 32 * 1024;   // SDP typischerweise 3–8 KB (für room-Pfad, Klartext)
const MAX_ICE_BYTES = 2 * 1024;    // ICE-Candidate <500 B (für room-Pfad, Klartext)
// CMK-encrypted SDP/ICE (1:1 calls): base64-Inflation + AES-GCM-Tag
// → großzügigere Limits. Backend sieht den Klartext nicht.
const MAX_SDP_EC_BYTES = 64 * 1024;
const MAX_ICE_EC_BYTES = 4 * 1024;

// Validiert dass `ec` ein voiceCrypto-Envelope ist: { v: 1, iv: string, ct: string }
// und unter dem Größenlimit bleibt. iv und ct sind base64-encoded.
function isVoiceEnvelope(ec, maxTotalBytes) {
  if (!ec || typeof ec !== "object") return false;
  if (ec.v !== 1) return false;
  if (typeof ec.iv !== "string" || ec.iv.length < 12 || ec.iv.length > 32) return false;
  if (typeof ec.ct !== "string" || ec.ct.length === 0) return false;
  if (ec.ct.length + ec.iv.length > maxTotalBytes) return false;
  return true;
}

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
  await Promise.allSettled([
    env.RENEX_KV.delete(`voice_state:${handle}`),
    env.RENEX_KV.delete(`voice_ring:${handle}`),
  ]);
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
export async function handleVoiceRoutes(request, env, path, params, ctx) {
  // CSRF-Schutz für state-mutierende Requests
  const csrfFail = checkCsrf(request);
  if (csrfFail) return csrfFail;

  const session = await requireSession(request, env);
  if (!session) return json(request, { error: "Not authenticated" }, 401);
  const me = String(session.handle).toLowerCase();

  // ────────────────────────────────────────────────────
  // VOICE ROOMS (Phase 5 / Mesh) — DEAKTIVIERT
  // ────────────────────────────────────────────────────
  // Kein Frontend-Consumer (kein voice:room:* Handler). Der signal-Pfad
  // würde Klartext-SDP relayn und damit E2E-Encryption bypassen. Bei
  // Re-Aktivierung MUSS auf CMK-encrypted Envelopes umgestellt werden
  // (analog zum 1:1-Pfad mit voiceCrypto.encryptSdp/encryptIce).
  if (path.startsWith("/voice/room/")) {
    return json(request, { error: "Voice rooms not enabled" }, 410);
  }

  // ────────────────────────────────────────────────────
  // GLOBALER VOICE-KILL-SWITCH (2026-07-27)
  // ────────────────────────────────────────────────────
  // 1:1-Voice hängt am self-hosted coturn-Relay (turn.renex.id). Ohne Relay
  // scheitern Calls nach dem Klingeln im ICE-Timeout — schlechter als gar kein
  // Angebot. KV `rollout:flags` {"voice":true} schaltet Voice global ein/aus,
  // OHNE Redeploy und OHNE Code zu löschen (Voice bleibt eingefroren-lauffähig).
  // Fail-safe AUS: Key fehlt/kaputt → aus.
  //
  // Gegated werden nur die INITIIERENDEN Pfade. Teardown (hangup/decline/cancel)
  // bleibt IMMER offen, damit in-flight-Zustand eines gecachten alten Clients
  // sauber abgeräumt werden kann; /voice/history ist reines Lesen der Anrufliste.
  const VOICE_INITIATING = ["/voice/ring", "/voice/answer", "/voice/ice", "/voice/turn-credentials"];
  if (VOICE_INITIATING.includes(path)) {
    let voiceOn = false;
    try {
      const raw = await env.RENEX_KV.get("rollout:flags");
      if (raw) voiceOn = JSON.parse(raw).voice === true;
    } catch { /* fail-safe: aus */ }
    if (!voiceOn) {
      return json(request, {
        error: "Voice calls are currently unavailable",
        code: "voice_disabled",
      }, 503);
    }
  }

  // Voice-Rooms Phase-5 Code-Pfad (deaktiviert oben). Originaler Code-Block
  // belassen wir nicht — bei Re-Aktivierung neu schreiben mit CMK-Pfad.
  if (false && path.startsWith("/voice/room/")) {
    const ROOM_RE = /^\/voice\/room\/([0-9a-f-]{36})\/(join|leave|heartbeat|members|signal)$/i;
    const m = path.match(ROOM_RE);
    if (!m) return json(request, { error: "Not found" }, 404);

    const roomId = m[1].toLowerCase();
    const action = m[2];
    if (!isUUID(roomId)) return json(request, { error: "Invalid roomId" }, 400);

    // Group-Membership-Check
    if (!(await isGroupMember(env, roomId, me))) {
      return json(request, { error: "Not a group member" }, 403);
    }

    // GET members
    if (action === "members") {
      if (request.method !== "GET") return json(request, { error: "Method not allowed" }, 405);
      const members = await getRoom(env, roomId);
      return json(request, { roomId, members });
    }

    // POST join
    if (action === "join") {
      if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);
      if (!(await rateLimit(env, `voice_join:${me}`, 60_000, 30, { failOpen: false }))) {
        return json(request, { error: "Rate limit exceeded" }, 429);
      }
      const members = await getRoom(env, roomId);
      const already = members.find(x => x.handle === me);
      const now = Date.now();
      let nextMembers;
      if (already) {
        nextMembers = members.map(x => x.handle === me ? { ...x, lastSeen: now } : x);
      } else {
        if (members.length >= ROOM_MAX_MEMBERS) {
          return json(request, { error: "Room full", max: ROOM_MAX_MEMBERS }, 409);
        }
        nextMembers = [...members, { handle: me, joinedAt: now, lastSeen: now }];
      }
      await putRoom(env, roomId, nextMembers);

      if (!already) {
        await Promise.allSettled(
          nextMembers
            .filter(x => x.handle !== me)
            .map(x => pushToUserDO(env, x.handle, makeEvent({
              type: "voice:room:join",
              roomId,
              handle: me,
              joinedAt: now,
            })))
        );
      }

      return json(request, {
        roomId, me,
        members: nextMembers,
        isFirstJoin: !already,
        max: ROOM_MAX_MEMBERS,
      });
    }

    // POST heartbeat
    if (action === "heartbeat") {
      if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);
      const members = await getRoom(env, roomId);
      const idx = members.findIndex(x => x.handle === me);
      if (idx < 0) return json(request, { error: "Not in room" }, 404);
      const now = Date.now();
      members[idx] = { ...members[idx], lastSeen: now };
      await putRoom(env, roomId, members);
      return json(request, { ok: true, ts: now });
    }

    // POST leave
    if (action === "leave") {
      if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);
      const members = await getRoom(env, roomId);
      const nextMembers = members.filter(x => x.handle !== me);
      await putRoom(env, roomId, nextMembers);

      await Promise.allSettled(
        nextMembers.map(x => pushToUserDO(env, x.handle, makeEvent({
          type: "voice:room:leave",
          roomId,
          handle: me,
        })))
      );

      return json(request, { ok: true, members: nextMembers });
    }

    // POST signal — Body: { to, kind: "offer"|"answer"|"ice", sdp?, candidate? }
    if (action === "signal") {
      if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);
      const body = await readJson(request);
      if (!body) return json(request, { error: "Invalid JSON" }, 400);

      const to   = String(body.to || "").toLowerCase();
      const kind = String(body.kind || "");
      if (!isHandle(to) || to === me) return json(request, { error: "Invalid 'to'" }, 400);
      if (!["offer", "answer", "ice"].includes(kind)) {
        return json(request, { error: "Invalid 'kind'" }, 400);
      }

      const members = await getRoom(env, roomId);
      if (!members.find(x => x.handle === me)) return json(request, { error: "You are not in room" }, 409);
      if (!members.find(x => x.handle === to)) return json(request, { error: "Peer not in room" }, 409);

      if (kind === "offer" || kind === "answer") {
        const sdp = body.sdp;
        if (!sdp || typeof sdp !== "object" || typeof sdp.sdp !== "string") {
          return json(request, { error: "Invalid 'sdp'" }, 400);
        }
        if (sdp.sdp.length > MAX_SDP_BYTES) return json(request, { error: "SDP too large" }, 413);
        if ((kind === "offer"  && sdp.type !== "offer") ||
            (kind === "answer" && sdp.type !== "answer")) {
          return json(request, { error: "Mismatched sdp.type" }, 400);
        }
        await pushToUserDO(env, to, makeEvent({
          type: `voice:room:${kind}`,
          roomId, from: me, sdp,
        }));
      } else {
        const candidate = body.candidate;
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
        await pushToUserDO(env, to, makeEvent({
          type: "voice:room:ice",
          roomId, from: me, candidate,
        }));
      }

      return json(request, { ok: true });
    }

    return json(request, { error: "Not found" }, 404);
  }

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
      const auth   = body.auth;  // {fp, sig, fromDeviceId} — DTLS-Fingerprint signiert mit Sender-Sigkey (gegen Backend-MITM)

      if (!isHandle(to))    return json(request, { error: "Invalid 'to'" }, 400);
      if (!isCallId(callId)) return json(request, { error: "Invalid 'callId'" }, 400);
      if (to === me)        return json(request, { error: "Cannot call yourself" }, 400);
      // 1:1-Calls: sdp.ec ist CMK-encrypted Envelope. Backend sieht Klartext-SDP nicht.
      if (!sdp || typeof sdp !== "object" || sdp.type !== "offer") {
        return json(request, { error: "Invalid 'sdp' (expected offer)" }, 400);
      }
      if (!isVoiceEnvelope(sdp.ec, MAX_SDP_EC_BYTES)) {
        return json(request, { error: "Invalid or oversized 'sdp.ec'" }, 400);
      }
      // auth-Field REQUIRED (Defense-in-Depth gegen Backend-MITM auf SDP).
      // Backend prüft NICHT die Signatur (kein Sigkey), nur Schema + Pflicht-Felder
      // — Verify passiert peer-side in _verifyAuth.
      if (!auth || typeof auth !== "object" ||
          typeof auth.fp !== "string" || auth.fp.length === 0 || auth.fp.length > 256 ||
          typeof auth.sig !== "string" || auth.sig.length === 0 || auth.sig.length > 200 ||
          typeof auth.fromDeviceId !== "string" || auth.fromDeviceId.length === 0 || auth.fromDeviceId.length > 64) {
        return json(request, { error: "Missing or invalid 'auth'" }, 400);
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

      // Ring-Event bauen (einmal, dann für DO-Push + KV-Replay verwenden)
      const ringEvent = makeEvent({
        type: "voice:ring",
        from: me,
        callId,
        sdp,
        ...(auth ? { auth } : {}),
        startedAt,
      });

      // KV-Replay-Slot: wenn Callee's PWA zu war, kam das DO-Push-Event nie an.
      // Nach Banner-Tap (?call=1) holt das Frontend das Event hier ab und
      // triggert receiveCall manuell. TTL = CALL_STATE_TTL (60s) reicht für
      // das Ring-Fenster.
      await env.RENEX_KV.put(
        `voice_ring:${to}`,
        JSON.stringify(ringEvent),
        { expirationTtl: CALL_STATE_TTL }
      ).catch(() => {});

      // Peer benachrichtigen (WS via Durable Object)
      const delivered = await pushToUserDO(env, to, ringEvent);

      // WebPush: immer senden — analog zu DMs/Kontaktanfragen. Der `delivered === 0`
      // Gate war auf iOS unzuverlässig, weil Safari die WS noch ~25-35s als „connected"
      // hält nach PWA-Hintergrund. Bei Calls besonders kritisch: das Ring-Fenster ist
      // nur ~30s. Service Worker zeigt persistente Notification mit Accept/Decline-
      // Buttons; bei Klick öffnet /chat/?with=<caller>&call=1 und re-verhandelt SDP.
      // Trade-off: bei offener PWA zeigen sich In-App-Ringer + OS-Banner parallel.
      // KRITISCH: ctx.waitUntil verwenden — sonst killt der Worker den Push
      // sobald die Response gesendet wurde, BEVOR pushToUser über das erste
      // await (D1-Query) hinausgekommen ist. Symptom: WebPush kam für Voice
      // nie an, obwohl /voice/ring 200 returnt hat. Bei Messages funktioniert
      // es, weil chatSend.js `await pushToUser` macht (blockiert die Response).
      const pushPromise = pushToUser(env, to, {
        title: `📞 ${me}`,
        body:  "ruft dich an",
        tag:   `voice-call-${callId}`,
        data: {
          type:    "voice_call",
          from:    me,
          callId,
          // Svelte-PWA-Root: /?with=...&call=1 (analog zu Message-Push,
          // das alte /chat/?... war Vanilla-Legacy und triggerte u.U.
          // false-positive Gast-Recovery bei konvertierten Usern).
          url:     `/?with=${encodeURIComponent(me)}&call=1`,
        },
      }).catch(e => console.warn(`🔔 voice push error: ${e?.message}`));
      if (ctx?.waitUntil) ctx.waitUntil(pushPromise);

      return json(request, { ok: true, callId, delivered });
    }

    // ──────────────────────────────────────────────────
    // POST /voice/answer — Anruf annehmen
    // Body: { callId, sdp: { type: "answer", sdp } }
    // ──────────────────────────────────────────────────
    case "/voice/answer": {
      if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);

      if (!(await rateLimit(env, `voice_answer:${me}`, 60_000, 30, { failOpen: false }))) {
        return json(request, { error: "Too many requests" }, 429);
      }

      const body = await readJson(request);
      if (!body) return json(request, { error: "Invalid JSON" }, 400);

      const callId = String(body.callId || "");
      const sdp    = body.sdp;
      const auth   = body.auth;  // {fp, sig, fromDeviceId} — gegen Backend-MITM

      if (!isCallId(callId)) return json(request, { error: "Invalid 'callId'" }, 400);
      // 1:1-Calls: sdp.ec ist CMK-encrypted Envelope.
      if (!sdp || typeof sdp !== "object" || sdp.type !== "answer") {
        return json(request, { error: "Invalid 'sdp' (expected answer)" }, 400);
      }
      if (!isVoiceEnvelope(sdp.ec, MAX_SDP_EC_BYTES)) {
        return json(request, { error: "Invalid or oversized 'sdp.ec'" }, 400);
      }
      // auth REQUIRED (analog /voice/ring): Defense-in-Depth gegen Backend-MITM.
      if (!auth || typeof auth !== "object" ||
          typeof auth.fp !== "string" || auth.fp.length === 0 || auth.fp.length > 256 ||
          typeof auth.sig !== "string" || auth.sig.length === 0 || auth.sig.length > 200 ||
          typeof auth.fromDeviceId !== "string" || auth.fromDeviceId.length === 0 || auth.fromDeviceId.length > 64) {
        return json(request, { error: "Missing or invalid 'auth'" }, 400);
      }

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
        ...(auth ? { auth } : {}),
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

      // ICE-Candidates können viele sein pro Call (typisch 5-20). 120/min reicht.
      if (!(await rateLimit(env, `voice_ice:${me}`, 60_000, 120, { failOpen: false }))) {
        return json(request, { error: "Too many requests" }, 429);
      }

      const body = await readJson(request);
      if (!body) return json(request, { error: "Invalid JSON" }, 400);

      const to     = String(body.to || "").toLowerCase();
      const callId = String(body.callId || "");
      const candidate = body.candidate;

      if (!isHandle(to))     return json(request, { error: "Invalid 'to'" }, 400);
      if (!isCallId(callId)) return json(request, { error: "Invalid 'callId'" }, 400);
      // 1:1-Calls: candidate.ec ist CMK-encrypted Envelope (verbirgt host-IPs etc.)
      if (!candidate || typeof candidate !== "object") {
        return json(request, { error: "Invalid 'candidate'" }, 400);
      }
      if (!isVoiceEnvelope(candidate.ec, MAX_ICE_EC_BYTES)) {
        return json(request, { error: "Invalid or oversized 'candidate.ec'" }, 400);
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

      if (!(await rateLimit(env, `voice_decline:${me}`, 60_000, 30, { failOpen: false }))) {
        return json(request, { error: "Too many requests" }, 429);
      }

      const body = await readJson(request);
      if (!body) return json(request, { error: "Invalid JSON" }, 400);
      const callId = String(body.callId || "");
      if (!isCallId(callId)) return json(request, { error: "Invalid 'callId'" }, 400);

      const call = await getCallForUser(env, callId, me);
      // Idempotenz: Decline auf bereits beendetem Call rejecten — kein zweiter
      // push an den Caller. Use-Case: stale SW-Notification (requireInteraction)
      // bleibt auf dem Sperrbildschirm nach Hangup, Callee tippt versehentlich
      // „Ablehnen" → ohne Guard würde Caller eine verspätete decline-Notification
      // für einen längst beendeten Call sehen.
      if (call && ['ended', 'declined', 'missed', 'cancelled'].includes(String(call.status))) {
        return json(request, { ok: true, alreadyEnded: true, status: call.status });
      }

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

      if (!(await rateLimit(env, `voice_cancel:${me}`, 60_000, 30, { failOpen: false }))) {
        return json(request, { error: "Too many requests" }, 429);
      }

      const body = await readJson(request);
      if (!body) return json(request, { error: "Invalid JSON" }, 400);
      const callId = String(body.callId || "");
      const to     = String(body.to || "").toLowerCase();
      if (!isCallId(callId)) return json(request, { error: "Invalid 'callId'" }, 400);
      if (!isHandle(to))     return json(request, { error: "Invalid 'to'" }, 400);

      // Participant-Check: nur der Caller darf seinen eigenen ringing-Call cancellen.
      // Ohne diesen Check könnte jeder mit Kenntnis der callId (Leak via Logs)
      // fremde voice_state-KV-Slots löschen und Fake-cancel-Events triggern.
      const call = await getCallForUser(env, callId, me);
      if (!call || call.role !== "caller" || call.peer !== to) {
        return json(request, { error: "No matching outgoing call" }, 404);
      }
      // Idempotenz: bereits beendete Calls einfach 200 zurückgeben — verhindert
      // double-side-effects bei Retry/stale-Notifications.
      if (['ended', 'declined', 'missed', 'cancelled'].includes(String(call.status))) {
        return json(request, { ok: true, alreadyEnded: true, status: call.status });
      }

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

      if (!(await rateLimit(env, `voice_hangup:${me}`, 60_000, 30, { failOpen: false }))) {
        return json(request, { error: "Too many requests" }, 429);
      }

      const body = await readJson(request);
      if (!body) return json(request, { error: "Invalid JSON" }, 400);
      const callId = String(body.callId || "");
      const to     = String(body.to || "").toLowerCase();
      if (!isCallId(callId)) return json(request, { error: "Invalid 'callId'" }, 400);
      if (!isHandle(to))     return json(request, { error: "Invalid 'to'" }, 400);

      // Participant-Check: nur caller/callee dieses Calls darf hangup machen,
      // und der `to` muss tatsächlich der peer sein. getCallForUser filtert
      // strict auf caller==me OR callee==me — ohne diesen Check könnte jeder
      // mit Kenntnis der callId (Log-Leak) fremde Calls killen.
      const call = await getCallForUser(env, callId, me);
      if (!call || call.peer !== to) {
        return json(request, { error: "No matching call" }, 404);
      }
      // Idempotenz: Hangup auf bereits beendetem Call rejecten — kein zweiter
      // hangup-push an den Peer. Verhindert stale-Notification-Klick-Replays
      // und Doppel-Hangups bei flackernden Netzverbindungen.
      if (['ended', 'declined', 'missed', 'cancelled'].includes(String(call.status))) {
        return json(request, { ok: true, alreadyEnded: true, status: call.status });
      }

      const endedAt = Date.now();

      // Dauer aus answered_at berechnen (falls vorhanden)
      try {
        const base = call.answered_at || call.started_at || endedAt;
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
    // GET /voice/active — laufenden Incoming-Call für mich abrufen
    // Frontend-Use-Case: nach Banner-Tap (PWA war zu) ist das voice:ring
    // WS-Event verloren. Frontend pollt diesen Endpoint mit ?call=1, kriegt
    // das gespeicherte Ring-Event zurück und triggert receiveCall manuell.
    // ──────────────────────────────────────────────────
    case "/voice/active": {
      if (request.method !== "GET") return json(request, { error: "Method not allowed" }, 405);
      const myState = await getVoiceState(env, me);
      if (!myState || myState.state !== "ringing") {
        return json(request, { active: false });
      }
      const raw = await env.RENEX_KV.get(`voice_ring:${me}`);
      if (!raw) return json(request, { active: false });
      try {
        const ringEvent = JSON.parse(raw);
        return json(request, { active: true, ringEvent });
      } catch {
        return json(request, { active: false });
      }
    }

    // ──────────────────────────────────────────────────
    // GET /voice/turn-credentials
    // Self-hosted coturn auf turn.renex.id (Hetzner). Ephemere REST-API-
    // Credentials nach coturn use-auth-secret-Pattern:
    //   username   = "<unix-expiry>:<pseudonym>"   // V1: handle-frei (HMAC-Pseudonym, quota-bindbar)
    //   credential = base64(HMAC-SHA1(COTURN_SECRET, username))
    // coturn akzeptiert die Credentials nur bis zum expiry-Timestamp.
    // ──────────────────────────────────────────────────
    case "/voice/turn-credentials": {
      if (request.method !== "GET") return json(request, { error: "Method not allowed" }, 405);

      const TTL_SEC = 3600;
      const secret = env.COTURN_SECRET;

      const stunOnly = {
        iceServers: [{ urls: "stun:turn.renex.id:3478" }],
        ttl: TTL_SEC,
      };

      if (!secret) {
        console.warn("COTURN_SECRET not configured — STUN-only fallback");
        return json(request, stunOnly);
      }

      try {
        const expiry = Math.floor(Date.now() / 1000) + TTL_SEC;

        // V1: handle-FREIER, aber pro-User STABILER Pseudonym im TURN-username.
        // coturn loggt Allocations per username → so steht KEIN Klartext-Handle in
        // den TURN-Logs (A2 / coturn-Compromise / Hetzner-Staff). Deterministisch
        // pro Handle, damit coturn `user-quota` weiter bindet; nur mit COTURN_SECRET
        // auf den Handle rückführbar.
        const uidKey = await crypto.subtle.importKey(
          "raw", new TextEncoder().encode(secret),
          { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
        );
        const uidBuf = await crypto.subtle.sign("HMAC", uidKey, new TextEncoder().encode(`turn-uid:${me}`));
        const uid = btoa(String.fromCharCode(...new Uint8Array(uidBuf)))
          .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 20);
        const username = `${expiry}:${uid}`;

        // credential = base64(HMAC-SHA1(COTURN_SECRET, username)) — coturn REST-Pattern (SHA-1 vorgeschrieben)
        const key = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(secret),
          { name: "HMAC", hash: "SHA-1" },
          false,
          ["sign"]
        );
        const sigBuf = await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(username)
        );
        const credential = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));

        return json(request, {
          iceServers: [
            { urls: "stun:turn.renex.id:3478" },
            { urls: "turn:turn.renex.id:3478?transport=udp", username, credential },
            { urls: "turn:turn.renex.id:3478?transport=tcp", username, credential },
            { urls: "turns:turn.renex.id:443?transport=tcp", username, credential },
          ],
          ttl: TTL_SEC,
        });
      } catch (e) {
        console.warn("coturn credential generation failed:", e?.message);
        return json(request, stunOnly);
      }
    }

    default:
      return json(request, { error: "Not found" }, 404);
  }
}
