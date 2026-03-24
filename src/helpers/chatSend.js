import { json, readJson, convoId } from '../utils.js';
import { requireSession, rateLimit, isAcceptedContact, pushToUserDO } from '../auth.js';

// ======================================================
// CHAT / SEND handler (extracted for line-count budget)
// Called from chatRoutes.js
// ======================================================
export async function handleChatSend(request, env) {
  const session = await requireSession(request, env);
  if (!session) {
    return json(request, { error: "Not authenticated" }, 401);
  }

  const me = String(session.handle || "").toLowerCase();

  // Body (SAFE)
  const body = await readJson(request);
  if (!body) return json(request, { error: "Invalid JSON body" }, 400);

  const {
    to,
    message,
    e2e,
    payloads,
    ivB64,
    ctB64,
    v,
    type,
    sid,
    epoch,
    sig,
    deviceId: senderDeviceId
  } = body;

  // Recipient Validation (early guard)
  const other = String(to || "").toLowerCase();

  if (!/^[a-z0-9_]+$/.test(other)) {
    return json(request, { error: "Invalid recipient" }, 400);
  }

  // Payload size limits (D1 storage protection)
  const MAX_IV_B64   = 24;    // AES-GCM 12-byte IV → 16 chars base64; 24 = safe headroom
  const MAX_CT_B64   = 6000;  // ≤1000 UTF-8 chars × 4 bytes × base64 overhead + AES-GCM tag
  const MAX_MSG_LEN  = 1000;  // plaintext fallback
  const MAX_SID_LEN  = 128;   // session ID
  const MAX_TYPE_LEN = 32;    // control message type

  if (typeof ivB64 === "string" && ivB64.length > MAX_IV_B64) {
    return json(request, { error: "ivB64 too large" }, 400);
  }
  if (typeof ctB64 === "string" && ctB64.length > MAX_CT_B64) {
    return json(request, { error: "ctB64 too large" }, 400);
  }
  if (typeof message === "string" && message.length > MAX_MSG_LEN) {
    return json(request, { error: "message too large" }, 400);
  }
  if (typeof sid === "string" && sid.length > MAX_SID_LEN) {
    return json(request, { error: "sid too large" }, 400);
  }
  if (typeof type === "string" && type.length > MAX_TYPE_LEN) {
    return json(request, { error: "type too large" }, 400);
  }
  // sig: ECDSA P-256 Signatur (base64, max ~120 Zeichen)
  if (sig !== undefined && (typeof sig !== "string" || sig.length > 256)) {
    return json(request, { error: "sig invalid" }, 400);
  }
  // senderDeviceId: device_id des Senders für sig-Verifikation
  if (senderDeviceId !== undefined && (typeof senderDeviceId !== "string" || senderDeviceId.length > 64)) {
    return json(request, { error: "deviceId invalid" }, 400);
  }

  console.log("📨 SEND BODY TYPE:", type);

  // Rotation-Index aus Body
  const rotationIndex = (typeof body.rotationIndex === "number" && Number.isInteger(body.rotationIndex) && body.rotationIndex >= 0)
    ? body.rotationIndex
    : 0;

  // HARD SEND RATE LIMIT (global pro User)
  // GILT NICHT für Control-Messages
  if (type !== "cmk_req" && type !== "cmk" && type !== "epoch_rotate" && type !== "cmk_rotate" && type !== "auto_delete_set") {
    const ok = await rateLimit(
      env,
      `chat_send:${me}`,
      2000,
      1,
      { failOpen: true } // UX: lieber senden als blockieren bei KV-Fehler
    );
    if (!ok) {
      return json(request, { error: "Send cooldown", retryAfterMs: 2000 }, 429);
    }
  }

  // CONTROL MESSAGE RATE LIMIT (cmk / cmk_req / epoch_rotate)
  // Max. 10 Key-Exchange-Messages pro Minute pro User
  if (type === "cmk_req" || type === "cmk" || type === "epoch_rotate" || type === "cmk_rotate" || type === "auto_delete_set") {
    const ok = await rateLimit(env, `control_send:${me}`, 60_000, 10);
    if (!ok) {
      return json(request, { error: "Control message rate limit exceeded", retryAfterMs: 60000 }, 429);
    }
  }

  // E2E Versions-Guard — gilt NUR für echte E2E-Nachrichten
  if (type !== "cmk_req" && type !== "cmk" && type !== "epoch_rotate" && type !== "cmk_rotate" && type !== "auto_delete_set") {
    if (v !== undefined && v !== 2) {
      return json(request, { error: "Unsupported E2E version" }, 400);
    }
  }
  // v2 Pflichtfelder – NUR für echte verschlüsselte Nachrichten
  if (v === 2 && e2e === true && type !== "cmk") {
    if (typeof sid !== "string" || sid.length < 5) {
      return json(request, { error: "Missing or invalid sid" }, 400);
    }
    if (typeof epoch !== "number" || !Number.isInteger(epoch) || epoch < 0) {
      return json(request, { error: "Missing or invalid epoch" }, 400);
    }
  }

  // Darf nur an ACCEPTED Kontakte senden — gilt für ALLE Message-Typen inkl. Control-Messages
  // (verhindert CMK-Flooding / E2E-Manipulation gegen Nicht-Kontakte)
  const isAllowed = await isAcceptedContact(env, me, to);
  if (!isAllowed) {
    return json(request, { error: "Recipient not accepted" }, 403);
  }

  if (!other) {
    return json(request, { error: "Missing 'to'" }, 400);
  }

  const hasLegacyE2E = (e2e && typeof ivB64 === "string" && typeof ctB64 === "string");
  const hasMultiE2E = (e2e === true && Array.isArray(payloads) && payloads.length > 0);

  // v2 VALIDATION — NUR für echte verschlüsselte Chat-Messages
  if (v === 2 && e2e === true && type !== "cmk" && type !== "cmk_req") {
    if (typeof ivB64 !== "string" || typeof ctB64 !== "string") {
      return json(request, { error: "v2 message requires ivB64/ctB64" }, 400);
    }
  }

  // Nur echte Chat-Messages brauchen Payload
  if (!type || (type !== "cmk_req" && type !== "cmk" && type !== "epoch_rotate" && type !== "cmk_rotate" && type !== "auto_delete_set")) {
    if (!message && !(hasLegacyE2E || hasMultiE2E)) {
      return json(request, { error: "Missing message payload" }, 400);
    }
  }

  // Conversation ID
  const cid = convoId(me, other);

  const msg = {
    id: crypto.randomUUID(),
    from: me,
    to: other,
    ts: Date.now(),
    status: "sent"
  };

  if (type === "cmk" || type === "cmk_req" || type === "epoch_rotate" || type === "cmk_rotate" || type === "auto_delete_set") {
    msg.message = undefined;
    delete msg.status;
  }

  // Rotation-Index für epoch_rotate
  if (type === "epoch_rotate") msg.rotationIndex = rotationIndex;
  if (typeof sid === "string")    msg.sid = sid;
  if (typeof epoch === "number")  msg.epoch = epoch;
  if (typeof type === "string")   msg.type = type;

  // CMK ist Control + E2E-Hülle, aber KEINE Chat-v2-Message
  if (type === "cmk")     { msg.v = 2; msg.e2e = true; }
  if (type === "cmk_req") { msg.v = 1; msg.e2e = false; }

  // E2E Version nur übernehmen, wenn KEIN Control-Message
  if (typeof v === "number" && type !== "cmk_req" && type !== "cmk") {
    msg.v = v;
  }

  if (e2e) {
    msg.e2e = true;

    // NEW: multi-device payloads
    if (hasMultiE2E) {
      const cleaned = [];
      for (const p of payloads) {
        if (!p) continue;
        const { deviceId, ivB64, ctB64, fromDeviceId } = p;
        if (
          typeof deviceId !== "string" || deviceId.length < 4 || deviceId.length > 64 ||
          typeof ivB64 !== "string" || ivB64.length < 16 || ivB64.length > MAX_IV_B64 ||
          typeof ctB64 !== "string" || ctB64.length < 16 || ctB64.length > MAX_CT_B64
        ) continue;
        cleaned.push({ deviceId, ivB64, ctB64, fromDeviceId });
      }
      if (cleaned.length > 10) {
        return json(request, { error: "Too many device payloads" }, 400);
      }
      msg.payloads = cleaned;
    } else {
      // single payload (AES-GCM)
      msg.ivB64 = ivB64;
      msg.ctB64 = ctB64;
      // v NUR setzen, wenn Client es nicht explizit gesetzt hat
      if (msg.v === undefined) msg.v = 2;
    }

  } else {
    msg.message = message;
  }

  // D1 INSERT — only real chat messages (not control)
  if (msg.type !== "cmk" && msg.type !== "cmk_req" && msg.type !== "epoch_rotate" && msg.type !== "cmk_rotate" && msg.type !== "auto_delete_set") {
    await env.RENEX_DB.prepare(
      `INSERT OR IGNORE INTO messages
         (id, convo_id, from_user, to_user, ts, status, type, v, e2e, sid, epoch, message, iv_b64, ct_b64, payloads, rotation_index, sig, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      msg.id, cid, msg.from, msg.to, msg.ts,
      msg.status ?? "sent",
      msg.type ?? null,
      msg.v ?? null,
      msg.e2e ? 1 : 0,
      msg.sid ?? null,
      msg.epoch ?? null,
      msg.message ?? null,
      msg.ivB64 ?? null,
      msg.ctB64 ?? null,
      msg.payloads ? JSON.stringify(msg.payloads) : null,
      rotationIndex,
      (typeof sig === "string" && sig.length > 0) ? sig : null,
      (typeof senderDeviceId === "string" && senderDeviceId.length > 0) ? senderDeviceId : null
    ).run();
  }

  // ======================================================
  // CONTROL INDEX (für /chat/control)
  // ======================================================
  if (msg.type === "cmk" || msg.type === "cmk_req" || msg.type === "epoch_rotate" || msg.type === "cmk_rotate" || msg.type === "auto_delete_set" || msg.type === undefined) {
    if (!to || typeof to !== "string") {
      console.error("❌ CONTROL: invalid 'to'", to);
      return json(request, { error: "Invalid control target" }, 400);
    }
    // Live Push via DO
    await pushToUserDO(env, String(to).toLowerCase(), msg);
  }

  // ======================================================
  // UNREAD COUNTER
  // ======================================================
  if (msg.type !== "cmk" && msg.type !== "cmk_req" && msg.type !== "epoch_rotate" && msg.type !== "cmk_rotate" && msg.type !== "auto_delete_set") {
    const unreadKey = `unread:${other}:${me}`;
    let count = 0;
    const rawUnread = await env.RENEX_KV.get(unreadKey);
    if (rawUnread) {
      try { count = Number(rawUnread) || 0; } catch {}
    }
    count++;
    await env.RENEX_KV.put(unreadKey, String(count));

    // UNREAD INDEX UPDATE
    const unreadIndexKey = `unread_index:${other}`;
    let unreadIndex = {};
    const rawIndex = await env.RENEX_KV.get(unreadIndexKey);
    if (rawIndex) {
      try { unreadIndex = JSON.parse(rawIndex); } catch {}
    }
    unreadIndex[me] = count;
    await env.RENEX_KV.put(unreadIndexKey, JSON.stringify(unreadIndex));
  }

  // Antwort an Client
  return json(request, { ok: true, message: msg });
}
