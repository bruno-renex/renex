import { json, readJson, dmConvoId } from '../utils.js';
import { requireAnySession, rateLimit, isAcceptedContact, pushToUserDO, pushToGroupMembers, GUEST_HANDLE_RE } from '../auth.js';
import { pushToUser, detectMentions } from './pushSend.js';

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
    mentions,            // Array von @mentioned Handles (Client-extracted, unverschlüsselt)
    mentionsEveryone,    // Boolean: @everyone wurde erwähnt
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
      return json(request, { error: "Not authorized for this conversation" }, 403);
    }

    const isGskControl = type === "gsk" || type === "request_gsk";
    const isCmkControl = type === "cmk_req" || type === "cmk_unavailable" || type === "cmk";

    // Alle anderen Control-Messages verboten (GSK + CMK für E2E erlaubt)
    if (type && !isGskControl && !isCmkControl) {
      return json(request, { error: "Control messages not allowed for guests" }, 403);
    }

    // Chat-Nachrichten: Limit-Check (GSK/CMK-Control-Messages überspringen)
    if (!isGskControl && !isCmkControl) {
      const guestRow = await env.RENEX_DB.prepare(
        "SELECT msg_count, msg_limit, expires_at, converted_to FROM guest_sessions WHERE token = ?"
      ).bind(guestToken).first();

      if (!guestRow)             return json(request, { error: "Not authenticated" }, 401);
      if (guestRow.converted_to) return json(request, { error: "Not authorized" }, 403);
      if (Date.now() > guestRow.expires_at) return json(request, { error: "Session expired" }, 410);
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

  // Rotation-Index aus Body. Upper-Bound 1_000_000 = ca. 1000 Rotationen pro
  // Tag über 3 Jahre — astronomisch über jedem realen Use-Case.
  const ROT_MAX = 1_000_000;
  const rotationIndex = (
    typeof body.rotationIndex === "number"
    && Number.isInteger(body.rotationIndex)
    && body.rotationIndex >= 0
    && body.rotationIndex <= ROT_MAX
  )
    ? body.rotationIndex
    : 0;

  // HARD SEND RATE LIMIT (per Device — Multi-Tab/Multi-Device-freundlich)
  // GILT NICHT für Control-Messages (inkl. request_gsk / gsk)
  // Per-Device statt per-User damit parallele Tabs/Devices sich nicht gegenseitig blockieren.
  // Burst-Friendly: 3 messages / 2s pro Device (vorher: 1/2s pro User → unspielbar bei Multi-Tab).
  if (type !== "cmk_req" && type !== "cmk_unavailable" && type !== "cmk" && type !== "epoch_rotate" && type !== "cmk_rotate" && type !== "cmk_reset" && type !== "auto_delete_set" && type !== "gsk" && type !== "request_gsk") {
    const rlKey = senderDeviceId
      ? `chat_send:${me}:${senderDeviceId}`
      : `chat_send:${me}`;  // Fallback wenn deviceId nicht gesetzt
    const ok = await rateLimit(
      env,
      rlKey,
      2000,
      3,
      { failOpen: false } // Security: bei KV-Fehler blockieren statt Spam zulassen
    );
    if (!ok) {
      return json(request, { error: "Send cooldown", retryAfterMs: 2000 }, 429);
    }
  }

  // CONTROL MESSAGE RATE LIMIT (cmk / cmk_req / cmk_unavailable / epoch_rotate / gsk)
  // Max. 20 Key-Exchange-Messages pro Minute pro User
  if (type === "cmk_req" || type === "cmk_unavailable" || type === "cmk" || type === "epoch_rotate" || type === "cmk_rotate" || type === "cmk_reset" || type === "auto_delete_set" || type === "gsk") {
    const ok = await rateLimit(env, `control_send:${me}`, 60_000, 20);
    if (!ok) {
      return json(request, { error: "Control message rate limit exceeded", retryAfterMs: 60000 }, 429);
    }
  }

  // request_gsk: eigenes grosszügiges Limit (60/min) — Gäste müssen alle Members anfragen
  if (type === "request_gsk") {
    const ok = await rateLimit(env, `gsk_req:${me}`, 60_000, 60);
    if (!ok) {
      return json(request, { error: "GSK request rate limit exceeded", retryAfterMs: 60000 }, 429);
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
  if (type !== "cmk_req" && type !== "cmk_unavailable" && type !== "cmk" && type !== "epoch_rotate" && type !== "cmk_rotate" && type !== "cmk_reset" && type !== "auto_delete_set" && type !== "gsk" && type !== "request_gsk") {
    if (v !== undefined && v !== 2) {
      return json(request, { error: "Unsupported E2E version" }, 400);
    }
  }
  // v2 Pflichtfelder – NUR für echte verschlüsselte Nachrichten
  // gsk / request_gsk = Group Sender Key Protokoll — kein sid/epoch nötig
  if (v === 2 && e2e === true && type !== "cmk" && type !== "cmk_unavailable" && type !== "gsk" && type !== "request_gsk") {
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
  if (v === 2 && e2e === true && type !== "cmk" && type !== "cmk_req" && type !== "cmk_unavailable" && type !== "gsk" && type !== "request_gsk") {
    if (typeof ivB64 !== "string" || typeof ctB64 !== "string") {
      return json(request, { error: "v2 message requires ivB64/ctB64" }, 400);
    }
  }

  // Nur echte Chat-Messages brauchen Payload
  if (!type || (type !== "cmk_req" && type !== "cmk_unavailable" && type !== "cmk" && type !== "epoch_rotate" && type !== "cmk_rotate" && type !== "cmk_reset" && type !== "auto_delete_set" && type !== "gsk" && type !== "request_gsk")) {
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

  if (type === "cmk" || type === "cmk_req" || type === "cmk_unavailable" || type === "epoch_rotate" || type === "cmk_rotate" || type === "cmk_reset" || type === "auto_delete_set") {
    msg.message = undefined;
    delete msg.status;
  }

  // Rotation-Index: immer ins msg-Objekt (WS-Push braucht es für Group chainIndex + DM Rotation)
  msg.rotationIndex = rotationIndex;
  if (typeof sid === "string")    msg.sid = sid;
  if (typeof epoch === "number")  msg.epoch = epoch;
  if (typeof type === "string")   msg.type = type;

  // deviceId aufs msg-Objekt — wird bei WS-Push für Sig-Verify durchgereicht
  // UND für Multi-Device-Self-Sync-Filter im Frontend (Sender-Tab erkennt sich selbst).
  if (typeof senderDeviceId === "string" && senderDeviceId.length > 0) {
    msg.deviceId = senderDeviceId;
  }
  if (typeof sig === "string" && sig.length > 0) {
    msg.sig = sig;
  }

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
    // requestedFrom auch in message-Feld speichern (D1 Polling-Fallback:
    // kein eigenes DB-Feld → Empfänger erkennt request_gsk aus D1 via m.message)
    msg.message = msg.requestedFrom;
  }

  // CMK ist Control + E2E-Hülle, aber KEINE Chat-v2-Message
  if (type === "cmk")     { msg.v = 2; msg.e2e = true; }
  if (type === "cmk_req") { msg.v = 1; msg.e2e = false; }
  if (type === "cmk_unavailable") { msg.v = 1; msg.e2e = false; }

  // E2E Version nur übernehmen, wenn KEIN Control-Message
  if (typeof v === "number" && type !== "cmk_req" && type !== "cmk_unavailable" && type !== "cmk") {
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

  // gsk Control-Messages: payloads sind Wraps der GSK pro Recipient-Device
  // (NICHT verschlüsselte Chat-Bodies → kein e2e=true). Müssen trotzdem
  // durchgereicht werden, sonst kommt das WS-Event ohne payloads beim
  // Empfänger an → handleIncomingGSKMessage kann's nicht decrypten.
  if (type === "gsk" && Array.isArray(payloads) && payloads.length > 0) {
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
  }

  // D1 INSERT — Chat-Messages + GSK/request_gsk (für Gast-Polling nötig)
  // CMK/epoch/auto_delete sind reine Signalling-Messages ohne Polling-Bedarf.
  // gsk + request_gsk werden gespeichert damit Gäste (kein WebSocket) sie via /chat/list empfangen.
  if (msg.type !== "cmk" && msg.type !== "cmk_req" && msg.type !== "cmk_unavailable" && msg.type !== "epoch_rotate" && msg.type !== "cmk_rotate" && msg.type !== "cmk_reset" && msg.type !== "auto_delete_set") {
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
  // GSK-Control-Messages (gsk / request_gsk) zählen NICHT zum Limit
  const isGskControlForCounter = type === "gsk" || type === "request_gsk";
  if (isGuest && guestToken && !isGskControlForCounter) {
    await env.RENEX_DB.prepare(
      "UPDATE guest_sessions SET msg_count = msg_count + 1 WHERE token = ?"
    ).bind(guestToken).run();
    // KV-Cache invalidieren (damit /invite/ping frischen Wert liefert)
    await env.RENEX_KV.delete(`guest_session:${guestToken}`);
  }

  // ======================================================
  // LIVE PUSH via Durable Object
  // DM:    → pushToUserDO(to) + pushToUserDO(me)  — Empfänger + eigene andere Devices
  // Gruppe:→ pushToGroupMembers(cid)              — alle Mitglieder ausser Sender
  //
  // Self-Push für DMs: ohne diesen würden andere Tabs/Devices des Senders die
  // Message erst beim nächsten Reload sehen. Sender's CURRENT-Tab wird im
  // Frontend via msg.deviceId gefiltert (Tab erkennt eigene deviceId und skipt).
  // ======================================================
  let wsDeliveredCount = 0;
  if (bodyConvoId) {
    // Gruppen-Nachricht: an alle Mitglieder ausser Sender (excludes self).
    // Bei GSK/request_gsk: bypassCache=true (Defense-in-Depth). Wenn ein
    // ex-Member kurz zuvor entfernt wurde und KV-Cache noch stale ist, würde
    // er sonst das gsk-Event empfangen (kann's zwar nicht decrypten, aber
    // sieht Group-Activity-Metadata). Mit bypass: aktuelle DB-Member-Liste.
    const isKeyControl = msg.type === "gsk" || msg.type === "request_gsk";
    await pushToGroupMembers(env, env.RENEX_DB, bodyConvoId, me, msg, isKeyControl ? { bypassCache: true } : undefined);
  } else {
    // DM: an Empfänger
    if (!to || typeof to !== "string") {
      console.error("❌ PUSH: invalid 'to'", to);
      return json(request, { error: "Invalid recipient" }, 400);
    }
    wsDeliveredCount = await pushToUserDO(env, String(to).toLowerCase(), msg);

    // Multi-Device Self-Sync: auch an eigene anderen Devices pushen
    // (skip-Logik im Frontend via deviceId-Vergleich).
    // Nur für CHAT-Messages, nicht für Control-Messages (cmk/cmk_req etc.)
    const isChatMsg = !type || (
      type !== "cmk" && type !== "cmk_req" && type !== "cmk_unavailable" &&
      type !== "epoch_rotate" && type !== "cmk_rotate" && type !== "cmk_reset" &&
      type !== "auto_delete_set"
    );
    if (isChatMsg) {
      pushToUserDO(env, me, msg).catch(() => {});  // fire-and-forget, non-blocking
    }
  }

  // ======================================================
  // UNREAD COUNTER (nur DMs — Gruppen haben kein per-Member Tracking)
  // ======================================================
  if (!isGroupMessage && msg.type !== "cmk" && msg.type !== "cmk_req" && msg.type !== "cmk_unavailable" && msg.type !== "epoch_rotate" && msg.type !== "cmk_rotate" && msg.type !== "cmk_reset" && msg.type !== "auto_delete_set" && msg.type !== "gsk" && msg.type !== "request_gsk") {
    // Atomares Increment via D1 — kein Read-Modify-Write Race Condition
    await env.RENEX_DB.prepare(
      `INSERT INTO unread_counters (owner, sender, count) VALUES (?, ?, 1)
       ON CONFLICT(owner, sender) DO UPDATE SET count = count + 1`
    ).bind(other, me).run();
  }

  // ======================================================
  // WEB PUSH NOTIFICATIONS (wenn User offline / kein WS)
  // Nur für echte Chat-Messages (keine Control-Messages)
  // ======================================================
  const isControlMsg = msg.type === "cmk" || msg.type === "cmk_req" || msg.type === "cmk_unavailable" || msg.type === "epoch_rotate" || msg.type === "cmk_rotate" || msg.type === "cmk_reset" || msg.type === "auto_delete_set" || msg.type === "gsk" || msg.type === "request_gsk";
  if (!isControlMsg) {
    try {
      if (isGroupMessage) {
        // Gruppe: Push an alle offline Members
        const memberRows = await env.RENEX_DB.prepare(
          "SELECT member_handle FROM conversation_members WHERE convo_id = ?"
        ).bind(cid).all();
        const members = (memberRows.results || []).map(r => r.member_handle);
        const groupName = (await env.RENEX_DB.prepare(
          "SELECT name FROM conversations WHERE id = ?"
        ).bind(cid).first())?.name || "Gruppe";

        // @mention Detection — Client sendet mentions[] Metadata (E2E-kompatibel)
        // Fallback auf Server-Side Detection für Plaintext-Nachrichten
        const clientMentions = Array.isArray(mentions) ? mentions.map(h => String(h).toLowerCase()) : [];
        const clientMentionsAll = mentionsEveryone === true;
        const { mentionsAll: serverMentionsAll, mentionedHandles: serverMentions } = detectMentions(msg.message, members);
        const mentionedHandles = clientMentions.length > 0 ? clientMentions : serverMentions;
        const mentionsAll = clientMentionsAll || serverMentionsAll;

        const recipients = members.filter(h => h !== me);
        await Promise.allSettled(recipients.map(async (handle) => {
          // Mute-Check
          const mute = await env.RENEX_DB.prepare(
            "SELECT level, expires_at FROM notification_mutes WHERE user_handle = ? AND convo_id = ?"
          ).bind(handle, cid).first();

          if (mute) {
            // Temporäres Mute abgelaufen?
            if (mute.expires_at && Date.now() > mute.expires_at) {
              await env.RENEX_DB.prepare(
                "DELETE FROM notification_mutes WHERE user_handle = ? AND convo_id = ?"
              ).bind(handle, cid).run();
            } else {
              const level = mute.level || "all";
              if (level === "all") return; // komplett stumm
              if (level === "mentions_only") {
                // Nur bei direktem @handle — @everyone wird UNTERDRÜCKT
                if (!mentionedHandles.includes(handle)) return;
              }
              if (level === "mentions_and_everyone") {
                // @handle ODER @everyone
                if (!mentionsAll && !mentionedHandles.includes(handle)) return;
              }
            }
          }

          // Gruppen: Immer Push senden (kein zuverlässiger Online-Check möglich
          // da pushToGroupMembers parallel läuft und kein WS-Delivery-Count hat).
          // Notification-Tag dedupliziert auf dem Gerät.
          await pushToUser(env, handle, {
            title: `${groupName}`,
            body: `${me}: ${msg.e2e ? "Verschlüsselte Nachricht" : (msg.message || "").slice(0, 100)}`,
            tag: `renex-${cid}`,
            data: {
              type: "message",
              convoId: cid,
              from: me,
              // Svelte-PWA-Root: /?group=<id>. Vorher: /chat?... (Vanilla-Seite,
              // löst false-positive Gast-Recovery aus bei konvertierten Usern).
              url: `/?group=${encodeURIComponent(cid)}&name=${encodeURIComponent(groupName)}`,
              e2e: !!msg.e2e,
            },
          });
        }));
      } else {
        // DM: Push an einzelnen Empfänger
        const mute = await env.RENEX_DB.prepare(
          "SELECT level, expires_at FROM notification_mutes WHERE user_handle = ? AND convo_id = ?"
        ).bind(other, cid).first();

        let shouldPush = true;
        if (mute) {
          if (mute.expires_at && Date.now() > mute.expires_at) {
            await env.RENEX_DB.prepare(
              "DELETE FROM notification_mutes WHERE user_handle = ? AND convo_id = ?"
            ).bind(other, cid).run();
          } else if ((mute.level || "all") === "all") {
            shouldPush = false;
          }
        }

        if (shouldPush) {
          // Online-Check: WebSocket-Zustellung hat Vorrang über KV-Presence
          // wsDeliveredCount > 0 = User hat aktive WS-Verbindung → kein Push nötig
          // wsDeliveredCount === 0 = kein offener Tab → Push senden
          const isOnline = wsDeliveredCount > 0;

          if (!isOnline) {
            await pushToUser(env, other, {
              title: me,
              body: msg.e2e ? "Verschlüsselte Nachricht" : (msg.message || "").slice(0, 100),
              tag: `renex-${cid}`,
              data: {
                type: "message",
                convoId: cid,
                from: me,
                // Svelte-PWA-Root: /?with=<peer>. Vorher: /chat?... (Vanilla-Seite,
                // löst false-positive Gast-Recovery aus bei konvertierten Usern).
                url: `/?with=${encodeURIComponent(me)}`,
                e2e: !!msg.e2e,
              },
            });
          }
        }
      }
    } catch (pushErr) {
      // Push-Fehler dürfen Chat-Send nicht blockieren
      console.error("Push notification error (non-blocking):", pushErr.message);
    }
  }

  // Antwort an Client
  return json(request, { ok: true, message: msg });
}
