import { json, readJson, dmConvoId } from '../utils.js';
import { requireAnySession, rateLimit, isAcceptedContact, pushToUserDO, pushToGroupMembers, GUEST_HANDLE_RE } from '../auth.js';

// ======================================================
// CHAT / SEND handler (extracted for line-count budget)
// Called from chatRoutes.js
// ======================================================
export async function handleChatSend(request, env) {
  const session = await requireAnySession(request, env);
  if (!session) {
    return json(request, { error: "Not authenticated" }, 401);
  }

  const me       = String(session.handle || "").toLowerCase();
  const isGuest  = session.isGuest === true;
  const guestToken = isGuest ? session.token : null;

  // Body (SAFE)
  const body = await readJson(request);
  if (!body) return json(request, { error: "Invalid JSON body" }, 400);

  const {
    to,
    convoId: bodyConvoId,   // optional: explizite Konversations-ID (Gruppen-Ready)
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
    deviceId: senderDeviceId,
    replyToId,           // ID der zitierten Nachricht
    replyFrom,           // Absender der zitierten Nachricht
    replyIv,             // IV für verschlüsselte Vorschau
    replyCt,             // Ciphertext der verschlüsselten Vorschau
    replyRotationIndex,  // chainIndex der Reply-Preview (Gruppen)
    attachmentKey,       // R2-Key des verschlüsselten Files (null für GIFs)
    attachmentType,      // 'photo' | 'file' | 'gif'
  } = body;

  // Recipient Validation (early guard)
  const other = String(to || "").toLowerCase();

  if (!/^[a-z0-9_]+$/.test(other)) {
    return json(request, { error: "Invalid recipient" }, 400);
  }

  // ── GUEST RESTRICTIONS ──────────────────────────────
  // Gäste dürfen nur in ihrer zugewiesenen Konversation schreiben.
  // GSK/request_gsk Control-Messages sind erlaubt (E2E Key Exchange).
  // Alle anderen Control-Messages + normaler Send: Limit-Check.
  if (isGuest) {
    const guestConvoId  = session.convoId;
    const resolvedConvo = bodyConvoId || (other ? [me, other].sort().join(":") : null);

    // Nur die zugewiesene Konvo erlaubt
    if (resolvedConvo !== guestConvoId) {
      return json(request, { error: "Guests can only send to their assigned conversation" }, 403);
    }

    const isGskControl = type === "gsk" || type === "request_gsk";

    // Alle anderen Control-Messages verboten
    if (type && !isGskControl) {
      return json(request, { error: "Control messages not allowed for guests" }, 403);
    }

    // Chat-Nachrichten: Limit-Check (GSK-Control-Messages überspringen)
    if (!isGskControl) {
      const guestRow = await env.RENEX_DB.prepare(
        "SELECT msg_count, msg_limit, expires_at, converted_to FROM guest_sessions WHERE token = ?"
      ).bind(guestToken).first();

      if (!guestRow)             return json(request, { error: "Guest session not found" }, 404);
      if (guestRow.converted_to) return json(request, { error: "Session already converted" }, 409);
      if (Date.now() > guestRow.expires_at) return json(request, { error: "Guest session expired" }, 410);
      if (guestRow.msg_count >= guestRow.msg_limit) {
        return json(request, {
          error:    "Message limit reached",
          msgCount: guestRow.msg_count,
          msgLimit: guestRow.msg_limit,
          convertUrl: "https://app.renex.id/join?convert=1",
        }, 429);
      }
    }
  }
  // ────────────────────────────────────────────────────

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
  // Reply-Felder validieren (alle optional, aber wenn vorhanden: Grösse prüfen)
  if (replyToId !== undefined && (typeof replyToId !== "string" || replyToId.length > 64)) {
    return json(request, { error: "replyToId invalid" }, 400);
  }
  // Attachment-Felder validieren
  if (attachmentKey !== undefined && attachmentKey !== null) {
    if (
      typeof attachmentKey !== "string" ||
      attachmentKey.length > 256 ||
      !attachmentKey.startsWith("files/") ||
      attachmentKey.includes("..") ||
      attachmentKey.includes("//")
    ) {
      return json(request, { error: "attachmentKey invalid" }, 400);
    }
  }
  if (attachmentType !== undefined && attachmentType !== null) {
    if (!["photo", "file", "gif"].includes(attachmentType)) {
      return json(request, { error: "attachmentType invalid" }, 400);
    }
  }
  if (replyFrom !== undefined && (typeof replyFrom !== "string" || replyFrom.length > 64)) {
    return json(request, { error: "replyFrom invalid" }, 400);
  }
  if (replyIv !== undefined && (typeof replyIv !== "string" || replyIv.length > MAX_IV_B64)) {
    return json(request, { error: "replyIv too large" }, 400);
  }
  if (replyCt !== undefined && (typeof replyCt !== "string" || replyCt.length > 1000)) {
    return json(request, { error: "replyCt too large" }, 400);
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

  // Rotation-Index aus Body
  const rotationIndex = (typeof body.rotationIndex === "number" && Number.isInteger(body.rotationIndex) && body.rotationIndex >= 0)
    ? body.rotationIndex
    : 0;

  // HARD SEND RATE LIMIT (global pro User)
  // GILT NICHT für Control-Messages
  if (type !== "cmk_req" && type !== "cmk" && type !== "epoch_rotate" && type !== "cmk_rotate" && type !== "auto_delete_set" && type !== "gsk") {
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
  if (type === "cmk_req" || type === "cmk" || type === "epoch_rotate" || type === "cmk_rotate" || type === "auto_delete_set" || type === "gsk") {
    const ok = await rateLimit(env, `control_send:${me}`, 60_000, 10);
    if (!ok) {
      return json(request, { error: "Control message rate limit exceeded", retryAfterMs: 60000 }, 429);
    }
  }

  // SECURITY: GSK-Control-Messages nur in Gruppen-Kontext erlaubt
  // Expliziter Fail-Fast bevor der allgemeine isAllowed-Check greift
  if (type === "gsk" || type === "request_gsk") {
    if (!bodyConvoId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bodyConvoId)) {
      return json(request, { error: "GSK messages require a valid group context" }, 400);
    }
    const gskSenderMember = await env.RENEX_DB.prepare(
      "SELECT 1 FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
    ).bind(bodyConvoId, me).first();
    if (!gskSenderMember) return json(request, { error: "Not a group member" }, 403);
  }

  // E2E Versions-Guard — gilt NUR für echte E2E-Nachrichten
  if (type !== "cmk_req" && type !== "cmk" && type !== "epoch_rotate" && type !== "cmk_rotate" && type !== "auto_delete_set" && type !== "gsk") {
    if (v !== undefined && v !== 2) {
      return json(request, { error: "Unsupported E2E version" }, 400);
    }
  }
  // v2 Pflichtfelder – NUR für echte verschlüsselte Nachrichten
  // gsk / request_gsk = Group Sender Key Protokoll — kein sid/epoch nötig
  if (v === 2 && e2e === true && type !== "cmk" && type !== "gsk" && type !== "request_gsk") {
    if (typeof sid !== "string" || sid.length < 5) {
      return json(request, { error: "Missing or invalid sid" }, 400);
    }
    if (typeof epoch !== "number" || !Number.isInteger(epoch) || epoch < 0) {
      return json(request, { error: "Missing or invalid epoch" }, 400);
    }
  }

  // Zugriffsprüfung: DM vs. Gruppe
  // DM:     beide müssen gegenseitige Kontakte sein (verhindert Spam + CMK-Flooding)
  // Gruppe: Sender UND Empfänger müssen Mitglieder der Konversation sein
  let isAllowed = false;
  if (bodyConvoId) {
    // Gruppen-Nachricht: Mitgliedschaft prüfen
    const senderMember = await env.RENEX_DB.prepare(
      "SELECT 1 FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
    ).bind(bodyConvoId, me).first();

    const recipientMember = await env.RENEX_DB.prepare(
      "SELECT 1 FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
    ).bind(bodyConvoId, other).first();

    isAllowed = !!(senderMember && recipientMember);
  } else if (isGuest) {
    // Gast-DM: darf nur in der zugewiesenen Konversation schreiben
    const guestCid = dmConvoId(me, other);
    isAllowed = (guestCid === session.convoId);
  } else {
    // DM: gegenseitiger Kontakt-Check (bestehende Logik)
    isAllowed = await isAcceptedContact(env, me, to);
  }

  if (!isAllowed) {
    return json(request, { error: "Not authorized for this conversation" }, 403);
  }

  if (!other) {
    return json(request, { error: "Missing 'to'" }, 400);
  }

  const hasLegacyE2E = (e2e && typeof ivB64 === "string" && typeof ctB64 === "string");
  const hasMultiE2E = (e2e === true && Array.isArray(payloads) && payloads.length > 0);

  // v2 VALIDATION — NUR für echte verschlüsselte Chat-Messages
  if (v === 2 && e2e === true && type !== "cmk" && type !== "cmk_req" && type !== "gsk" && type !== "request_gsk") {
    if (typeof ivB64 !== "string" || typeof ctB64 !== "string") {
      return json(request, { error: "v2 message requires ivB64/ctB64" }, 400);
    }
  }

  // Nur echte Chat-Messages brauchen Payload
  if (!type || (type !== "cmk_req" && type !== "cmk" && type !== "epoch_rotate" && type !== "cmk_rotate" && type !== "auto_delete_set" && type !== "gsk" && type !== "request_gsk")) {
    if (!message && !(hasLegacyE2E || hasMultiE2E)) {
      return json(request, { error: "Missing message payload" }, 400);
    }
  }

  // Conversation ID:
  // - DM:    wird aus me + other berechnet → "alice:bob"
  // - Gruppe: kommt als explizites Feld im Body (UUID, vom Client gesetzt)
  const cid = (typeof bodyConvoId === "string" && bodyConvoId.length > 0)
    ? bodyConvoId
    : dmConvoId(me, other);

  const isGroupMessage = !!bodyConvoId;

  const msg = {
    id: crypto.randomUUID(),
    from: me,
    // DM:    to = peer handle (für Delivered-Status + DO-Routing)
    // Gruppe: to = null  (Empfänger kommen aus conversation_members)
    to: isGroupMessage ? null : other,
    ts: Date.now(),
    status: "sent"
  };

  if (type === "cmk" || type === "cmk_req" || type === "epoch_rotate" || type === "cmk_rotate" || type === "auto_delete_set") {
    msg.message = undefined;
    delete msg.status;
  }

  // Rotation-Index: immer ins msg-Objekt (WS-Push braucht es für Group chainIndex + DM Rotation)
  msg.rotationIndex = rotationIndex;
  if (typeof sid === "string")    msg.sid = sid;
  if (typeof epoch === "number")  msg.epoch = epoch;
  if (typeof type === "string")   msg.type = type;

  // Gruppen-UUID in WS-Event einbetten (nötig für gsk-Handler + Chat-Routing)
  if (isGroupMessage) msg.groupId = cid;

  // Attachment-Typ in WS-Event einbetten (für Render-Entscheidung beim Empfänger)
  if (typeof attachmentType === "string" && attachmentType.length > 0) {
    msg.attachmentType = attachmentType;
  }

  // Reply-Felder (E2E-verschlüsselte Vorschau — Server sieht nur Ciphertext)
  if (typeof replyToId === "string" && replyToId.length > 0) {
    msg.replyToId           = replyToId;
    msg.replyFrom           = typeof replyFrom === "string" ? replyFrom : null;
    msg.replyIv             = typeof replyIv === "string" ? replyIv : null;
    msg.replyCt             = typeof replyCt === "string" ? replyCt : null;
    msg.replyRotationIndex  = typeof replyRotationIndex === "number" ? replyRotationIndex : null;
  }

  // request_gsk: requestedFrom validieren + preservieren damit nur der Betroffene antwortet
  // SECURITY: requestedFrom muss gültiger Handle-String sein (1-64 Zeichen, kein leerstring)
  if (type === "request_gsk") {
    const rf = body.requestedFrom;
    if (typeof rf !== "string" || rf.trim().length < 1 || rf.trim().length > 64) {
      return json(request, { error: "Invalid requestedFrom" }, 400);
    }
    // requestedFrom darf NICHT der Sender selbst sein (man kann nicht den eigenen GSK anfordern)
    if (rf.trim().toLowerCase() === me) {
      return json(request, { error: "Cannot request own GSK" }, 400);
    }
    msg.requestedFrom = rf.trim().toLowerCase();
  }

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
  if (msg.type !== "cmk" && msg.type !== "cmk_req" && msg.type !== "epoch_rotate" && msg.type !== "cmk_rotate" && msg.type !== "auto_delete_set" && msg.type !== "gsk" && msg.type !== "request_gsk") {
    await env.RENEX_DB.prepare(
      `INSERT OR IGNORE INTO messages
         (id, convo_id, from_user, to_user, ts, status, type, v, e2e, sid, epoch, message, iv_b64, ct_b64, payloads, rotation_index, sig, device_id, reply_to_id, reply_from, reply_iv, reply_ct, reply_rotation_index, attachment_key, attachment_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      (typeof senderDeviceId === "string" && senderDeviceId.length > 0) ? senderDeviceId : null,
      (typeof replyToId === "string" && replyToId.length > 0) ? replyToId : null,
      (typeof replyFrom === "string" && replyFrom.length > 0) ? replyFrom : null,
      (typeof replyIv === "string" && replyIv.length > 0) ? replyIv : null,
      (typeof replyCt === "string" && replyCt.length > 0) ? replyCt : null,
      (typeof replyRotationIndex === "number") ? replyRotationIndex : null,
      (typeof attachmentKey === "string" && attachmentKey.length > 0) ? attachmentKey : null,
      (typeof attachmentType === "string" && attachmentType.length > 0) ? attachmentType : null
    ).run();
  }

  // Gast-Nachrichtenzähler inkrementieren (nach erfolgreichem INSERT)
  if (isGuest && guestToken) {
    await env.RENEX_DB.prepare(
      "UPDATE guest_sessions SET msg_count = msg_count + 1 WHERE token = ?"
    ).bind(guestToken).run();
    // KV-Cache invalidieren (damit /invite/ping frischen Wert liefert)
    await env.RENEX_KV.delete(`guest_session:${guestToken}`);
  }

  // ======================================================
  // LIVE PUSH via Durable Object
  // DM:    → pushToUserDO(to)         — einzelner Empfänger
  // Gruppe:→ pushToGroupMembers(cid)  — alle Mitglieder ausser Sender
  // ======================================================
  if (bodyConvoId) {
    // Gruppen-Nachricht: an alle Mitglieder der Konversation senden
    await pushToGroupMembers(env, env.RENEX_DB, bodyConvoId, me, msg);
  } else {
    // DM: an einzelnen Empfänger senden
    if (!to || typeof to !== "string") {
      console.error("❌ PUSH: invalid 'to'", to);
      return json(request, { error: "Invalid recipient" }, 400);
    }
    await pushToUserDO(env, String(to).toLowerCase(), msg);
  }

  // ======================================================
  // UNREAD COUNTER (nur DMs — Gruppen haben kein per-Member Tracking)
  // ======================================================
  if (!isGroupMessage && msg.type !== "cmk" && msg.type !== "cmk_req" && msg.type !== "epoch_rotate" && msg.type !== "cmk_rotate" && msg.type !== "auto_delete_set" && msg.type !== "gsk" && msg.type !== "request_gsk") {
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
