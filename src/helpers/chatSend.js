import { json, readJson, dmConvoId } from '../utils.js';
import { requireAnySession, rateLimit, isAcceptedContact, pushToUserDO, pushToGroupMembers, getConvoMemberHandles, isConvoMember, GUEST_HANDLE_RE } from '../auth.js';
import { pushToUser, detectMentions } from './pushSend.js';
import { resolveChannelPerms } from '../lib/channelAccess.js';
import { Permissions } from '../lib/permissions.js';
import { verifyPow, requiredPowBits, POW_FLOOR_BITS } from '../powCheck.js';
import { isKnownMessageType } from '../messageTypes.js';

// ======================================================
// CHAT / SEND handler (extracted for line-count budget)
// Called from chatRoutes.js
// ======================================================
export async function handleChatSend(request, env, ctx) {
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
          convertUrl: "https://renex.id/join?convert=1",
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
  // ── M0.5: Message-Type-Allowlist (Dark-Launch) ─────────────────────
  // Unbekannte Types nur LOGGEN, Verhalten unverändert (heute = wie Chat-Msg).
  // Enforcement erst via env.TYPE_ALLOWLIST_ENFORCE, wenn Logs zeigen dass kein
  // legitimer Traffic unbekannte Types nutzt. Voraussetzung für sichere
  // Einführung der pq_rekey/skdm-Control-Types (P3/P4).
  if (!isKnownMessageType(type)) {
    console.warn(`🧾 unknown_type "${String(type).slice(0, 32)}" me=${me} dev=${senderDeviceId || "?"} enforce=${env.TYPE_ALLOWLIST_ENFORCE === "1"}`);
    if (env.TYPE_ALLOWLIST_ENFORCE === "1") {
      return json(request, { error: "unknown_type" }, 400);
    }
  }
  // sig: ECDSA P-256 Signatur (base64, max ~120 Zeichen)
  if (sig !== undefined && (typeof sig !== "string" || sig.length > 256)) {
    return json(request, { error: "sig invalid" }, 400);
  }
  // senderDeviceId: device_id des Senders für sig-Verifikation
  if (senderDeviceId !== undefined && (typeof senderDeviceId !== "string" || senderDeviceId.length > 64)) {
    return json(request, { error: "deviceId invalid" }, 400);
  }

  // ── PULSE (Phase 6.5) — ambient Presence-Frame ──────────────────────────
  // type:"pulse" ist ein transienter, E2E-verschlüsselter Skalar (PULSE.md §10).
  // KEIN D1-Write, KEIN Unread-Counter, KEIN Self-Mirror — nur Forward an den
  // Empfänger. Eigenes RL-Bucket (15 Frames/s, §7.4). Vertraulichkeit über die
  // Session-CMK-Pipeline: nur ein etablierter Kontakt (gemeinsamer CMK) kann ein
  // entschlüsselbares Frame senden → kein Contact-Check pro Frame nötig. Früher
  // Short-Circuit, damit die normale Chat-/Control-Logik unangetastet bleibt.
  if (type === "pulse") {
    if (e2e !== true || v !== 2 || typeof ivB64 !== "string" || typeof ctB64 !== "string" || typeof sid !== "string") {
      return json(request, { error: "pulse requires e2e v2 payload" }, 400);
    }
    const prlKey = senderDeviceId ? `pulse_send:${me}:${senderDeviceId}` : `pulse_send:${me}`;
    const ok = await rateLimit(env, prlKey, 1000, 15, { failOpen: true });
    if (!ok) {
      // Silent throttle — Pulse-Drop ist akzeptabel, kein Error an den Client
      return json(request, { ok: true, throttled: true, delivered: 0 }, 200);
    }
    const pmsg = {
      id: crypto.randomUUID(),
      from: me,
      to: other,
      ts: Date.now(),
      type: "pulse",
      v: 2,
      e2e: true,
      sid,
      epoch: (typeof epoch === "number" ? epoch : 0),
      ivB64,
      ctB64,
      deviceId: senderDeviceId || null,
    };
    // pushToUserDO MUSS awaited werden (memory: CF-Workers sub-fetch sonst gekillt)
    const delivered = await pushToUserDO(env, other, pmsg);
    return json(request, { ok: true, delivered }, 200);
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

    // ── L1: Adaptives Proof-of-Work (Dark-Launch) ──────────────────────
    // Verteuert automatisiertes Massen-Senden: jede echte Nachricht muss eine
    // Nonce mit N führenden Null-Bits über SHA-256(sid|epoch|sig|nonce) tragen.
    // EHRLICHER CLAIM: Kostenanstieg, KEIN Mensch-Beweis (Fork/Abtippen umgeht
    // es by design). Scope = exakt dieser Block (Pulse returnt früh, Control ist
    // ausgenommen). Dark-Launch: nur verifizieren+loggen; Enforcement erst wenn
    // env.POW_ENFORCE==="1" gesetzt ist (tunebar ohne Redeploy). Floor via
    // env.POW_MIN_BITS. verifyPow kostet genau EINEN Hash.
    const powBits = requiredPowBits({ floorBits: Number(env.POW_MIN_BITS) || POW_FLOOR_BITS });
    const pow = await verifyPow({ sid, epoch, sig, ctB64, nonce: body.powNonce, requiredBits: powBits });
    if (!pow.ok) {
      console.warn(`🔩 PoW ${pow.reason} me=${me} dev=${senderDeviceId || "?"} bits=${pow.bits}/${powBits} enforce=${env.POW_ENFORCE === "1"}`);
      if (env.POW_ENFORCE === "1") {
        return json(request, { error: "pow_weak", requiredBits: powBits, retryAfterMs: 0 }, 429);
      }
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

  // ── C2: Channel-Zugriff server-seitig durchsetzen (VIEW_CHANNEL/SEND_MESSAGES) ──
  // VIEW_CHANNEL ist Pflicht für JEDE Channel-Aktion (Chat + GSK/Control);
  // SEND_MESSAGES zusätzlich für echte Chat-Nachrichten. resolveChannelPerms gibt
  // null zurück wenn bodyConvoId KEIN Server-Channel ist (DM/Group) → kein Gate.
  // Schützt private Channels auf der Message-Ebene (nicht nur im List-Filter).
  if (bodyConvoId && typeof bodyConvoId === "string") {
    const chPerms = await resolveChannelPerms(env.RENEX_DB, bodyConvoId, me);
    if (chPerms !== null) {
      if ((chPerms & Permissions.VIEW_CHANNEL) !== Permissions.VIEW_CHANNEL) {
        return json(request, { error: "No access to this channel" }, 403);
      }
      const isControlType = type === "gsk" || type === "request_gsk" || type === "cmk" ||
        type === "cmk_req" || type === "cmk_unavailable" || type === "epoch_rotate" ||
        type === "cmk_rotate" || type === "cmk_reset" || type === "auto_delete_set";
      if (!isControlType && (chPerms & Permissions.SEND_MESSAGES) !== Permissions.SEND_MESSAGES) {
        return json(request, { error: "No permission to send in this channel" }, 403);
      }
    }
  }

  // SECURITY: GSK-Control-Messages nur in Gruppen-Kontext erlaubt
  // Expliziter Fail-Fast bevor der allgemeine isAllowed-Check greift
  if (type === "gsk" || type === "request_gsk") {
    if (!bodyConvoId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bodyConvoId)) {
      return json(request, { error: "GSK messages require a valid group context" }, 400);
    }
    // Type-aware: groups → conversation_members, channels → server_members
    const gskSenderIsMember = await isConvoMember(env.RENEX_DB, bodyConvoId, me);
    if (!gskSenderIsMember) return json(request, { error: "Not a group member" }, 403);
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
    // Gruppen-/Channel-Nachricht: Mitgliedschaft prüfen (type-aware)
    const [senderIsMember, recipientIsMember] = await Promise.all([
      isConvoMember(env.RENEX_DB, bodyConvoId, me),
      isConvoMember(env.RENEX_DB, bodyConvoId, other),
    ]);
    isAllowed = senderIsMember && recipientIsMember;
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
    // Ausnahme: gsk/request_gsk in Gruppen — der Sender wrappt pro Member separat;
    // `to` muss durchgereicht werden damit andere Members das Broadcast-Echo
    // erkennen (handleIncomingGSKMessage filtert via `to !== me`). Ohne das
    // kommen "no_payload_for_device" Warnings für alle nicht-ihm-bestimmten gsks.
    to: isGroupMessage
      ? ((type === "gsk" || type === "request_gsk") ? other : null)
      : other,
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

  // P3.0 Shadow-Ratchet (Dark-Launch §4.4): additives Transit-Feld — reist NUR
  // im Live-Push mit (das D1-INSERT bindet explizite Spalten → landet nie in
  // der History; Re-Reads können den Shadow nicht advancen). Nur echte E2E-DMs
  // (Whitelist: type fehlend/null/'message', keine Gruppe). Malformed/zu groß →
  // still droppen (Dark-Launch: nie rejecten).
  const _shadowTypeOk = type === undefined || type === null || type === "message";
  if (e2e && _shadowTypeOk && !bodyConvoId && body.shadowV4 && typeof body.shadowV4 === "object") {
    const s = body.shadowV4;
    const okShape = s.v === 4
      && typeof s.tgt === "string" && s.tgt.length >= 4 && s.tgt.length <= 64
      && typeof s.header === "string" && s.header.length <= 512
      && typeof s.fp === "string" && s.fp.length <= 16
      && (s.init === undefined || (s.init && typeof s.init === "object"));
    let sized = false;
    try { sized = okShape && JSON.stringify(s).length <= 4096; } catch {}
    if (sized) {
      msg.shadowV4 = { v: 4, tgt: s.tgt, header: s.header, fp: s.fp, ...(s.init ? { init: s.init } : {}) };
    }
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
  // P1: Schwere Fan-out-Arbeit (Gruppen-WS-Broadcast + Web-Push) NICHT inline
  // awaiten — sonst skaliert die Send-Latenz mit der Member-Zahl (CF 6-Connection-
  // Limit drosselt parallele Fetches). Stattdessen nach dem Response-ACK via
  // ctx.waitUntil im Hintergrund. Fallback ohne ctx (Tests/alte Aufrufer): inline
  // awaiten → Verhalten exakt wie bisher (CF tötet sonst unawaited Promises).
  const _bgTasks = [];
  const _flushBg = () => {
    const run = async () => {
      for (const t of _bgTasks) {
        try { await t(); } catch (e) { console.error("bg fan-out failed:", e?.message); }
      }
    };
    if (ctx && typeof ctx.waitUntil === "function") { ctx.waitUntil(run()); return Promise.resolve(); }
    return run();
  };

  let wsDeliveredCount = 0;
  if (bodyConvoId) {
    // Gruppen-/Channel-Nachricht: an alle (VIEW-berechtigten) Mitglieder ausser Sender.
    // Bei GSK/request_gsk: bypassCache=true (Defense-in-Depth gegen stale Member-Cache,
    // damit ein kurz zuvor entfernter Member kein gsk-Event/Metadata mehr empfängt).
    const isKeyControl = msg.type === "gsk" || msg.type === "request_gsk";
    if (isKeyControl) {
      // Key-Handshake (GSK) ist latenzsensitiv + niedrig-Volumen → SYNCHRON zustellen.
      // P1-Defer (waitUntil) gilt nur für hochfächernde Chat-Messages; ein deferter
      // GSK-Handshake kann den Decrypt verzögern oder verfehlen.
      await pushToGroupMembers(env, env.RENEX_DB, bodyConvoId, me, msg, { bypassCache: true });
    } else {
      _bgTasks.push(() => pushToGroupMembers(env, env.RENEX_DB, bodyConvoId, me, msg));
    }
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
      // AWAIT statt fire-and-forget: CF Workers kann den Promise terminieren
      // bevor das DO-fetch durchkommt — andere Geräte sehen Message sonst
      // erst nach Reload. ~10-50ms extra Latenz pro Send akzeptabel für Reliability.
      await pushToUserDO(env, me, msg).catch(() => {});
    }
  }

  // ======================================================
  // UNREAD COUNTER
  //  - DM:     1 Counter (owner=Empfänger, sender=me)
  //  - Gruppe: pro Member (ausser Sender) 1 Counter (owner=member, sender=group_id).
  //            Sonst verschwindet der Badge nach Reload/Offline-Push, weil der
  //            Frontend-Live-Increment (chat.svelte.js receiveMessage) nur bei
  //            offenem WS feuert.
  // ======================================================
  if (msg.type !== "cmk" && msg.type !== "cmk_req" && msg.type !== "cmk_unavailable" && msg.type !== "epoch_rotate" && msg.type !== "cmk_rotate" && msg.type !== "cmk_reset" && msg.type !== "auto_delete_set" && msg.type !== "gsk" && msg.type !== "request_gsk") {
    if (isGroupMessage) {
      // Type-aware: Channels haben Members in server_members, Groups in conversation_members.
      // Zwei separate Statements statt UNION-INSERT-FROM-SELECT (SQLite-Parser
      // hat Probleme mit ON CONFLICT nach Subquery-Source).
      const convoType = await env.RENEX_DB.prepare(
        "SELECT type, server_id FROM conversations WHERE id = ?"
      ).bind(cid).first();

      if (convoType?.type === 'channel' && convoType.server_id) {
        await env.RENEX_DB.prepare(
          `INSERT INTO unread_counters (owner, sender, count)
             SELECT user_handle, ?, 1 FROM server_members
             WHERE server_id = ? AND user_handle != ?
           ON CONFLICT(owner, sender) DO UPDATE SET count = count + 1`
        ).bind(cid, convoType.server_id, me).run();
      } else {
        // Group (legacy)
        await env.RENEX_DB.prepare(
          `INSERT INTO unread_counters (owner, sender, count)
             SELECT member_handle, ?, 1 FROM conversation_members
             WHERE convo_id = ? AND member_handle != ?
           ON CONFLICT(owner, sender) DO UPDATE SET count = count + 1`
        ).bind(cid, cid, me).run();
      }
    } else {
      // Atomares Increment via D1 — kein Read-Modify-Write Race Condition
      await env.RENEX_DB.prepare(
        `INSERT INTO unread_counters (owner, sender, count) VALUES (?, ?, 1)
         ON CONFLICT(owner, sender) DO UPDATE SET count = count + 1`
      ).bind(other, me).run();
    }
  }

  // ======================================================
  // WEB PUSH NOTIFICATIONS (wenn User offline / kein WS)
  // Nur für echte Chat-Messages (keine Control-Messages)
  // ======================================================
  const isControlMsg = msg.type === "cmk" || msg.type === "cmk_req" || msg.type === "cmk_unavailable" || msg.type === "epoch_rotate" || msg.type === "cmk_rotate" || msg.type === "cmk_reset" || msg.type === "auto_delete_set" || msg.type === "gsk" || msg.type === "request_gsk";
  if (!isControlMsg) {
    _bgTasks.push(async () => {
    try {
      if (isGroupMessage) {
        // Gruppe/Channel: Push an alle offline Members (type-aware)
        const members = await getConvoMemberHandles(env.RENEX_DB, cid);
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
        // P1: Mute-Status für ALLE Empfänger in EINER Query (statt N+1 pro Empfänger).
        const _muteRows = await env.RENEX_DB.prepare(
          "SELECT user_handle, level, expires_at FROM notification_mutes WHERE convo_id = ?"
        ).bind(cid).all();
        const _muteByHandle = new Map();
        for (const _m of (_muteRows.results || [])) _muteByHandle.set(_m.user_handle, _m);
        await Promise.allSettled(recipients.map(async (handle) => {
          // Mute-Check (aus vorab geladener Map statt per-Empfänger-Query)
          const mute = _muteByHandle.get(handle);

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
          // DMs: Immer Push senden — analog zu Gruppen. Der frühere wsDeliveredCount-
          // Gate war auf iOS unzuverlässig: Safari hält die WS-Verbindung nach PWA-
          // Hintergrund noch ~25-35s als „connected" (Heartbeat 25s + Pong-Timeout 10s),
          // bevor der DO sie close-t. In dem Fenster wäre wsDeliveredCount > 0 obwohl
          // der User die Message gar nicht sieht → kein Push, Message verloren bis Resume.
          // Notification-Tag dedupliziert auf dem Gerät; bei aktivem Chat zeigt
          // chatStore.receiveMessage die Message zusätzlich live.
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
    } catch (pushErr) {
      // Push-Fehler dürfen Chat-Send nicht blockieren
      console.error("Push notification error (non-blocking):", pushErr.message);
    }
    });
  }

  // P1: Hintergrund-Fan-out anstoßen (ctx.waitUntil) bzw. inline awaiten (kein ctx).
  await _flushBg();

  // Antwort an Client
  return json(request, { ok: true, message: msg });
}
