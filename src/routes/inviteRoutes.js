import { json, param, corsHeaders, dmConvoId, isUUID, validateConvoId, generateGuestToken, generateGuestHandle } from '../utils.js';
import { requireSession, requireGuestSession, rateLimit, GUEST_TOKEN_RE, GUEST_HANDLE_RE, pushToGroupMembers, pushToUserDO } from '../auth.js';

// ======================================================
// INVITE ROUTES — Gastzugang ohne Passkey
//   POST /invite/create   → Einladungslink erstellen (Auth erforderlich)
//   GET  /invite/info     → Konvo-Info für Landing Page (öffentlich)
//   POST /invite/join     → Gast-Session starten (kein Account nötig)
//   POST /invite/convert  → Gast → echten Account upgraden (nach Passkey-Reg)
//   POST /invite/ping     → msg_count aktualisieren + verbleibende Zeit prüfen
// ======================================================

const GUEST_EXPIRY_MS    = 48 * 60 * 60 * 1000;
const GUEST_SESSION_MS   = 24 * 60 * 60 * 1000;
const GUEST_MSG_LIMIT    = 20;

export async function handleInviteRoutes(request, env, path, params) {

  // ────────────────────────────────────────────────────
  // POST /invite/create
  // Authenticated user erzeugt einen Invite-Token für eine seiner Konversationen
  // ────────────────────────────────────────────────────
  if (path === "/invite/create" && request.method === "POST") {
    const session = await requireSession(request, env);
    if (!session || session.isGuest) return json(request, { error: "Not authenticated" }, 401);
    const me = session.handle;

    // Rate Limit: 10 Einladungen pro 10 Minuten pro User
    const rlOk = await rateLimit(env, `invite_create:${me}`, 600_000, 10);
    if (!rlOk) return json(request, { error: "Rate limit exceeded" }, 429);

    let body;
    try { body = await request.json(); } catch { return json(request, { error: "Invalid JSON" }, 400); }

    const { convoId } = body;

    // convoId optional: wenn nicht angegeben → DM-Einladung (1:1 mit dem Einladenden)
    let finalConvoId = "";
    let convoType    = "dm";

    if (convoId) {
      const detectedType = validateConvoId(convoId);
      if (!detectedType) return json(request, { error: "Invalid convoId" }, 400);
      convoType    = detectedType;
      finalConvoId = convoId;

      // Membership-Check für Gruppen oder existierende DMs
      if (convoType === "group") {
        const member = await env.RENEX_DB.prepare(
          "SELECT 1 FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
        ).bind(finalConvoId, me).first();
        if (!member) return json(request, { error: "Not a member" }, 403);
      } else {
        if (!finalConvoId.split(":").includes(me)) return json(request, { error: "Not a member" }, 403);
      }

      // Konversation muss in DB existieren
      const convo = await env.RENEX_DB.prepare(
        "SELECT name FROM conversations WHERE id = ?"
      ).bind(finalConvoId).first();
      if (!convo) return json(request, { error: "Conversation not found" }, 404);
    }
    // kein convoId: DM-Einladung → convo_id wird erst beim Join erstellt

    const now       = Date.now();
    const token     = generateGuestToken();
    const expiresAt = now + GUEST_EXPIRY_MS;

    await env.RENEX_DB.prepare(
      `INSERT INTO guest_sessions
         (token, convo_id, convo_type, created_by, created_at, expires_at, msg_limit, msg_count, guest_handle, converted_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', NULL)`
    ).bind(token, finalConvoId, convoType, me, now, expiresAt, GUEST_MSG_LIMIT).run();

    return json(request, {
      ok: true,
      token,
      inviteUrl: `https://app.renex.id/join?token=${token}`,
      expiresAt,
      msgLimit: GUEST_MSG_LIMIT,
    });
  }

  // ────────────────────────────────────────────────────
  // GET /invite/info?token=...
  // Öffentlich — gibt Konvo-Info für die Join-Landing-Page zurück
  // ────────────────────────────────────────────────────
  if (path === "/invite/info" && request.method === "GET") {
    const token = param(params, "token");
    if (!token || !GUEST_TOKEN_RE.test(token)) {
      return json(request, { error: "Invalid token" }, 400);
    }

    // Rate Limit: IP-basiert (30/min) + voller Token (10/min)
    // Voller Token verhindert Prefix-Enumeration; IP-Limit verhindert verteilte Enumeration
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const rlIp    = await rateLimit(env, `invite_info_ip:${ip}`,    60_000, 30);
    if (!rlIp)    return json(request, { error: "Rate limit exceeded" }, 429);
    const rlToken = await rateLimit(env, `invite_info_tok:${token}`, 60_000, 10);
    if (!rlToken) return json(request, { error: "Rate limit exceeded" }, 429);

    // Invite-Template-Row laden (unbenutzt ODER als benutzt markiert)
    const row = await env.RENEX_DB.prepare(
      "SELECT convo_id, convo_type, created_by, expires_at, guest_handle FROM guest_sessions WHERE token = ? AND (guest_handle IS NULL OR guest_handle = '' OR guest_handle = '__used__')"
    ).bind(token).first();

    if (!row)                         return json(request, { valid: false, reason: "not_found" }, 404);
    if (row.guest_handle === "__used__") return json(request, { valid: false, reason: "already_used" }, 410);
    if (Date.now() > row.expires_at)  return json(request, { valid: false, reason: "expired" }, 410);

    // Anzeigenamen der Konversation ermitteln
    let displayName = row.created_by + "'s Chat";
    if (row.convo_type === "group" && row.convo_id) {
      const convo = await env.RENEX_DB.prepare(
        "SELECT name FROM conversations WHERE id = ?"
      ).bind(row.convo_id).first();
      if (convo?.name) displayName = convo.name;
    }

    return json(request, {
      valid: true,
      convoType:   row.convo_type,
      displayName,
      createdBy:   row.created_by,
      expiresAt:   row.expires_at,
      msgLimit:    GUEST_MSG_LIMIT,
    });
  }

  // ────────────────────────────────────────────────────
  // POST /invite/join
  // Kein Account nötig — erzeugt eine Gast-Session und setzt das Cookie
  // ────────────────────────────────────────────────────
  if (path === "/invite/join" && request.method === "POST") {
    // Rate Limit: 5 Joins pro Minute pro IP
    const ip   = request.headers.get("CF-Connecting-IP") || "unknown";
    const rlOk = await rateLimit(env, `invite_join:${ip}`, 60_000, 5);
    if (!rlOk) return json(request, { error: "Rate limit exceeded" }, 429);

    let body;
    try { body = await request.json(); } catch { return json(request, { error: "Invalid JSON" }, 400); }

    const { token, publicKeyJwk, guestDeviceId, cfTurnstileToken } = body;
    if (!token || !GUEST_TOKEN_RE.test(token)) {
      return json(request, { error: "Invalid token" }, 400);
    }

    // ── Turnstile Bot-Schutz ──────────────────────────────────────────────
    // TURNSTILE_SECRET als Worker-Secret setzen: npx wrangler secret put TURNSTILE_SECRET
    // Ohne Secret → Test-Modus (akzeptiert Cloudflare-Test-Tokens)
    const tsSecret = env.TURNSTILE_SECRET || "1x0000000000000000000000000000000AA";
    try {
      const formData = new URLSearchParams();
      formData.set("secret",   tsSecret);
      formData.set("response", cfTurnstileToken || "");
      formData.set("remoteip", ip);
      const tsRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    formData.toString(),
      });
      const tsData = await tsRes.json().catch(() => ({}));
      if (!tsData.success) {
        console.warn("⚠️ Turnstile failed:", JSON.stringify(tsData));
        return json(request, { error: "Human verification failed", codes: tsData["error-codes"] }, 403);
      }
    } catch (e) {
      console.warn("⚠️ Turnstile verification error:", e);
      return json(request, { error: "Verification service unavailable. Please try again." }, 503);
    }

    // ── Invite-Template-Row laden (guest_handle leer = unbenutzte Vorlage) ─
    const inviteRow = await env.RENEX_DB.prepare(
      "SELECT * FROM guest_sessions WHERE token = ? AND (guest_handle IS NULL OR guest_handle = '')"
    ).bind(token).first();

    if (!inviteRow)                        return json(request, { error: "Invite not found" }, 404);
    if (Date.now() > inviteRow.expires_at) return json(request, { error: "Invite expired" }, 410);

    // ── Neue unabhängige Session erzeugen (Option B: jeder Join = eigene Session) ─
    const now            = Date.now();
    const sessionToken   = generateGuestToken();                       // neuer einzigartiger Session-Token
    const sessionExpires = now + GUEST_SESSION_MS;                     // 24h ab jetzt

    // Kollisionsfreien Handle sicherstellen
    let guestHandle;
    let attempts = 0;
    do {
      guestHandle = generateGuestHandle();
      const clash = await env.RENEX_DB.prepare(
        "SELECT 1 FROM guest_sessions WHERE guest_handle = ?"
      ).bind(guestHandle).first();
      if (!clash) break;
      attempts++;
    } while (attempts < 5);

    const joinTs  = now;
    let convoId   = inviteRow.convo_id;

    // ── DM ohne vordefinierte Konversation → neue DM-Konvo erstellen ─────
    if (!convoId || convoId === "") {
      convoId = dmConvoId(inviteRow.created_by, guestHandle);
      await env.RENEX_DB.prepare(
        `INSERT OR IGNORE INTO conversations (id, type, name, created_at, created_by)
         VALUES (?, 'dm', NULL, ?, ?)`
      ).bind(convoId, joinTs, inviteRow.created_by).run();
      await env.RENEX_DB.prepare(
        `INSERT OR IGNORE INTO conversation_members (convo_id, member_handle, role, joined_at)
         VALUES (?, ?, 'member', ?)`
      ).bind(convoId, inviteRow.created_by, joinTs).run();
    }

    // Gast als Mitglied eintragen (Rolle: 'guest')
    await env.RENEX_DB.prepare(
      `INSERT OR IGNORE INTO conversation_members (convo_id, member_handle, role, joined_at)
       VALUES (?, ?, 'guest', ?)`
    ).bind(convoId, guestHandle, joinTs).run();

    // ── DM-Gast: Kontakt-Einträge erstellen (bidirektional) ─────────
    // Damit der Gast in der Inbox des Einladers erscheint und umgekehrt.
    if (inviteRow.convo_type === "dm") {
      const createdBy = inviteRow.created_by;
      await env.RENEX_DB.prepare(
        `INSERT OR IGNORE INTO contacts (user_handle, contact_handle, display_handle, status, direction, created_at, updated_at)
         VALUES (?, ?, ?, 'accepted', 'out', ?, ?)`
      ).bind(createdBy, guestHandle, guestHandle, joinTs, joinTs).run();
      await env.RENEX_DB.prepare(
        `INSERT OR IGNORE INTO contacts (user_handle, contact_handle, display_handle, status, direction, created_at, updated_at)
         VALUES (?, ?, ?, 'accepted', 'in', ?, ?)`
      ).bind(guestHandle, createdBy, createdBy, joinTs, joinTs).run();
      // ETag bumpen damit Inbox des Einladers neu lädt
      await env.RENEX_KV.put(`contacts_v:${createdBy}`, String(Date.now()));
    }

    // ── Ephemeren E2E-Key speichern ───────────────────────────────────────
    if (
      publicKeyJwk && typeof publicKeyJwk === "object" &&
      typeof guestDeviceId === "string" && /^gdev_[0-9a-f]{24}$/.test(guestDeviceId)
    ) {
      const keyTtl = Math.max(60, Math.floor((sessionExpires - now) / 1000));
      await env.RENEX_KV.put(`e2e:inbox:${guestHandle}:${guestDeviceId}`, JSON.stringify(publicKeyJwk), { expirationTtl: keyTtl });
      await env.RENEX_KV.put(`e2e:inbox:index:${guestHandle}`,           JSON.stringify([guestDeviceId]), { expirationTtl: keyTtl });
      console.log("🔐 Gast-E2E-Key gespeichert:", guestHandle, guestDeviceId);
    }

    // ── System-Message + WS-Notification ─────────────────────────────────
    const isGroupConvo  = isUUID(convoId);
    const guestJoinEvent = {
      id: crypto.randomUUID(), type: "guest_joined",
      groupId: convoId, handle: guestHandle, ts: joinTs,
    };
    await env.RENEX_DB.prepare(
      `INSERT INTO messages (id, convo_id, from_user, to_user, ts, type, message, e2e)
       VALUES (?, ?, ?, NULL, ?, 'system', ?, 0)`
    ).bind(crypto.randomUUID(), convoId, guestHandle, joinTs, `👤 ${guestHandle} joined the chat`).run();
    if (isGroupConvo) {
      await pushToGroupMembers(env, env.RENEX_DB, convoId, guestHandle, guestJoinEvent);
    } else {
      if (inviteRow.created_by) await pushToUserDO(env, inviteRow.created_by, guestJoinEvent);
    }

    // ── Session-Row in D1 anlegen ─────────────────────────────────────────
    await env.RENEX_DB.prepare(
      `INSERT INTO guest_sessions
         (token, convo_id, convo_type, created_by, created_at, expires_at, msg_limit, msg_count, guest_handle, converted_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)`
    ).bind(sessionToken, convoId, inviteRow.convo_type, inviteRow.created_by, joinTs, sessionExpires, inviteRow.msg_limit, guestHandle).run();

    // ── DM-Invite: Template-Row invalidieren (einmalig verwendbar) ─────
    if (inviteRow.convo_type === "dm") {
      await env.RENEX_DB.prepare(
        "UPDATE guest_sessions SET guest_handle = '__used__' WHERE token = ? AND (guest_handle IS NULL OR guest_handle = '')"
      ).bind(token).run();
    }

    // ── KV-Session-Cache (schneller Auth-Lookup) ──────────────────────────
    const ttlSec = Math.max(60, Math.floor((sessionExpires - now) / 1000));
    await env.RENEX_KV.put(`guest_session:${sessionToken}`, JSON.stringify({
      handle: guestHandle, isGuest: true, token: sessionToken,
      convoId, expiresAt: sessionExpires,
      msgLimit: inviteRow.msg_limit, msgCount: 0,
    }), { expirationTtl: ttlSec });

    // Cookie: Session-Token (nicht der Invite-Token!)
    const cookieVal = `guest_session=${encodeURIComponent(sessionToken)}; HttpOnly; Secure; SameSite=Strict; Domain=renex.id; Max-Age=${ttlSec}; Path=/`;

    return new Response(JSON.stringify({
      ok:            true,
      guestHandle,
      convoId,
      convoType:     inviteRow.convo_type,
      inviterHandle: inviteRow.created_by,
      expiresAt:     sessionExpires,
      msgLimit:      inviteRow.msg_limit,
      msgCount:      0,
      deviceId:      guestDeviceId || null,
      sessionToken,  // für X-Guest-Token Header Fallback (Safari ITP)
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie":   cookieVal,
        ...corsHeaders(request),
      },
    });
  }

  // ────────────────────────────────────────────────────
  // POST /invite/convert
  // Gast hat Passkey registriert → echte Session vorhanden
  // Überträgt alle Gast-Nachrichten auf den neuen Account
  // Body: { guestToken }
  // ────────────────────────────────────────────────────
  if (path === "/invite/convert" && request.method === "POST") {
    // Muss eine ECHTE Session haben (nach erfolgreicher Passkey-Reg)
    const realSession = await requireSession(request, env);
    if (!realSession || realSession.isGuest) {
      return json(request, { error: "Real account required" }, 401);
    }
    const realHandle = realSession.handle;

    let body;
    try { body = await request.json(); } catch { return json(request, { error: "Invalid JSON" }, 400); }

    const { guestToken } = body;
    if (!guestToken || !GUEST_TOKEN_RE.test(guestToken)) {
      return json(request, { error: "Invalid guest token" }, 400);
    }

    const row = await env.RENEX_DB.prepare(
      "SELECT * FROM guest_sessions WHERE token = ?"
    ).bind(guestToken).first();

    if (!row)             return json(request, { error: "Not authenticated" }, 401);
    if (row.converted_to) return json(request, { error: "Not authorized" }, 403);

    const guestHandle = row.guest_handle;
    if (!guestHandle || !GUEST_HANDLE_RE.test(guestHandle)) {
      return json(request, { error: "Invalid session" }, 400);
    }

    const convertTs = Date.now();
    const isDM = row.convo_type === "dm";
    let finalConvoId = row.convo_id;

    if (isDM) {
      // ── DM-KONVERTIERUNG ──────────────────────────────────────────
      // Alte convo_id: "demo27:guest_xxx" → Neue: "demo27:realHandle"
      // Alle Messages, Members, Contacts migrieren
      const oldConvoId = row.convo_id;
      // Finde den DM-Partner (der Einlader)
      const peerHandle = row.created_by;
      const newConvoId = dmConvoId(peerHandle, realHandle);
      finalConvoId = newConvoId;

      // 1. Neue Konversation erstellen
      await env.RENEX_DB.prepare(
        `INSERT OR IGNORE INTO conversations (id, type, name, created_at, created_by)
         VALUES (?, 'dm', NULL, ?, ?)`
      ).bind(newConvoId, convertTs, peerHandle).run();

      // 2. Messages auf neue convo_id + neuen Absender migrieren
      await env.RENEX_DB.prepare(
        "UPDATE messages SET convo_id = ?, from_user = ? WHERE convo_id = ? AND from_user = ?"
      ).bind(newConvoId, realHandle, oldConvoId, guestHandle).run();
      // Messages VOM Partner auch auf neue convo_id umschreiben
      await env.RENEX_DB.prepare(
        "UPDATE messages SET convo_id = ? WHERE convo_id = ?"
      ).bind(newConvoId, oldConvoId).run();

      // 3. Conversation Members: alten Gast entfernen, echten User + Partner eintragen
      await env.RENEX_DB.prepare(
        "DELETE FROM conversation_members WHERE convo_id = ?"
      ).bind(oldConvoId).run();
      await env.RENEX_DB.prepare(
        `INSERT OR IGNORE INTO conversation_members (convo_id, member_handle, role, joined_at)
         VALUES (?, ?, 'member', ?)`
      ).bind(newConvoId, realHandle, convertTs).run();
      await env.RENEX_DB.prepare(
        `INSERT OR IGNORE INTO conversation_members (convo_id, member_handle, role, joined_at)
         VALUES (?, ?, 'member', ?)`
      ).bind(newConvoId, peerHandle, convertTs).run();

      // 4. Kontakt-Einträge migrieren: guest_xxx → realHandle
      await env.RENEX_DB.prepare(
        `UPDATE contacts SET contact_handle = ?, display_handle = ?, updated_at = ?
         WHERE user_handle = ? AND contact_handle = ?`
      ).bind(realHandle, realHandle, convertTs, peerHandle, guestHandle).run();
      // Kontakt-Eintrag des Gastes: user_handle = guest_xxx → realHandle
      await env.RENEX_DB.prepare(
        `UPDATE contacts SET user_handle = ?, updated_at = ?
         WHERE user_handle = ? AND contact_handle = ?`
      ).bind(realHandle, convertTs, guestHandle, peerHandle).run();

      // 5. Unread-Counter migrieren
      await env.RENEX_DB.prepare(
        "UPDATE OR IGNORE unread_counters SET sender = ? WHERE sender = ? AND owner = ?"
      ).bind(realHandle, guestHandle, peerHandle).run();
      await env.RENEX_DB.prepare(
        "DELETE FROM unread_counters WHERE sender = ? AND owner = ?"
      ).bind(guestHandle, peerHandle).run();

      // 6. Alte Konversation löschen
      await env.RENEX_DB.prepare(
        "DELETE FROM conversations WHERE id = ?"
      ).bind(oldConvoId).run();

      // 7. System-Messages in neuer Konversation
      // Hinweis: Alte Nachrichten sind nicht mehr entschlüsselbar
      await env.RENEX_DB.prepare(
        `INSERT INTO messages (id, convo_id, from_user, to_user, ts, type, message, e2e)
         VALUES (?, ?, ?, NULL, ?, 'system', ?, 0)`
      ).bind(crypto.randomUUID(), newConvoId, realHandle, convertTs - 1,
        `__guest_convert_notice__`).run();
      // Namens-Wechsel
      await env.RENEX_DB.prepare(
        `INSERT INTO messages (id, convo_id, from_user, to_user, ts, type, message, e2e)
         VALUES (?, ?, ?, NULL, ?, 'system', ?, 0)`
      ).bind(crypto.randomUUID(), newConvoId, realHandle, convertTs,
        `${guestHandle} is now ${realHandle}`).run();

      // 8. ETag bumpen damit Inbox des Partners refresht
      await env.RENEX_KV.put(`contacts_v:${peerHandle}`, String(convertTs));

      // 9. Live-Event an Partner
      pushToUserDO(env, peerHandle, {
        id:        crypto.randomUUID(),
        type:      "GUEST_CONVERTED",
        oldHandle: guestHandle,
        newHandle: realHandle,
        convoId:   newConvoId,
        ts:        convertTs
      }).catch(() => {});

    } else {
      // ── GRUPPEN-KONVERTIERUNG (bestehender Code) ──────────────────
      // Messages übertragen
      await env.RENEX_DB.prepare(
        "UPDATE messages SET from_user = ? WHERE from_user = ? AND convo_id = ?"
      ).bind(realHandle, guestHandle, row.convo_id).run();

      // Echten User als Mitglied eintragen
      await env.RENEX_DB.prepare(
        `INSERT OR IGNORE INTO conversation_members (convo_id, member_handle, role, joined_at)
         VALUES (?, ?, 'member', ?)`
      ).bind(row.convo_id, realHandle, convertTs).run();

      // Gast-Mitgliedschaft entfernen
      await env.RENEX_DB.prepare(
        "DELETE FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
      ).bind(row.convo_id, guestHandle).run();

      // System-Messages: Hinweis + Namens-Wechsel
      await env.RENEX_DB.prepare(
        `INSERT INTO messages (id, convo_id, from_user, to_user, ts, type, message, e2e)
         VALUES (?, ?, ?, NULL, ?, 'system', ?, 0)`
      ).bind(crypto.randomUUID(), row.convo_id, realHandle, convertTs - 1,
        `__guest_convert_notice__`).run();
      await env.RENEX_DB.prepare(
        `INSERT INTO messages (id, convo_id, from_user, to_user, ts, type, message, e2e)
         VALUES (?, ?, ?, NULL, ?, 'system', ?, 0)`
      ).bind(crypto.randomUUID(), row.convo_id, realHandle, convertTs,
        `${guestHandle} is now ${realHandle}`).run();

      // Live-Event an alle Mitglieder
      pushToGroupMembers(env, env.RENEX_DB, row.convo_id, null, {
        id:         crypto.randomUUID(),
        type:       "GUEST_CONVERTED",
        groupId:    row.convo_id,
        oldHandle:  guestHandle,
        newHandle:  realHandle,
        ts:         convertTs
      }).catch(() => {});
    }

    // Guest-Session als konvertiert markieren (DM + Gruppe)
    await env.RENEX_DB.prepare(
      "UPDATE guest_sessions SET converted_to = ? WHERE token = ?"
    ).bind(realHandle, guestToken).run();

    // KV-Cache löschen
    await env.RENEX_KV.delete(`guest_session:${guestToken}`);
    env.RENEX_KV.delete(`grp_members:${row.convo_id}`).catch(() => {});

    return json(request, {
      ok:        true,
      realHandle,
      convoId:   finalConvoId,
      convoType: row.convo_type,
    });
  }

  // ────────────────────────────────────────────────────
  // POST /invite/ping
  // Gast fragt: Wie viele Nachrichten habe ich noch? Wie viel Zeit bleibt?
  // Wird vom Frontend für den Countdown-Banner verwendet
  // ────────────────────────────────────────────────────
  if (path === "/invite/ping" && request.method === "POST") {
    const guest = await requireGuestSession(request, env);
    if (!guest) return json(request, { error: "Not authenticated" }, 401);

    // Aktuellen msg_count aus D1 lesen (KV kann veraltet sein)
    const row = await env.RENEX_DB.prepare(
      "SELECT msg_count, msg_limit, expires_at, converted_to FROM guest_sessions WHERE token = ?"
    ).bind(guest.token).first();

    if (!row)           return json(request, { error: "Session not found" }, 404);
    if (row.converted_to) return json(request, { converted: true, realHandle: row.converted_to }, 200);

    const now       = Date.now();
    const remaining = Math.max(0, row.expires_at - now);
    const msgsLeft  = Math.max(0, row.msg_limit - row.msg_count);
    const expired   = remaining === 0;

    return json(request, {
      ok:            true,
      msgCount:      row.msg_count,
      msgLimit:      row.msg_limit,
      msgsLeft,
      expiresAt:     row.expires_at,
      remainingMs:   remaining,
      expired,
    });
  }

  // ────────────────────────────────────────────────────
  // POST /invite/join-auth
  // Eingeloggter User tritt über Invite-Link als echtes Member bei
  // (kein Gast — normaler Member-Eintrag in conversation_members)
  // ────────────────────────────────────────────────────
  if (path === "/invite/join-auth" && request.method === "POST") {
    const session = await requireSession(request, env);
    if (!session || session.isGuest) return json(request, { error: "Not authenticated" }, 401);
    const me = session.handle;

    let body;
    try { body = await request.json(); } catch { return json(request, { error: "Invalid JSON" }, 400); }

    const { token } = body;
    if (!token || !GUEST_TOKEN_RE.test(token)) {
      return json(request, { error: "Invalid token" }, 400);
    }

    const row = await env.RENEX_DB.prepare(
      "SELECT * FROM guest_sessions WHERE token = ?"
    ).bind(token).first();

    if (!row)               return json(request, { error: "Invite not found" }, 404);
    if (Date.now() > row.expires_at) return json(request, { error: "Invite expired" }, 410);

    let convoId     = row.convo_id;
    const convoType = row.convo_type;
    const joinTs    = Date.now();
    const createdBy = row.created_by;

    // ── DM-Invite: Konversation + Kontakte erstellen ──────────────────
    if (convoType === "dm" && (!convoId || convoId === "")) {
      convoId = dmConvoId(createdBy, me);

      // Konversation erstellen
      await env.RENEX_DB.prepare(
        `INSERT OR IGNORE INTO conversations (id, type, name, created_at, created_by)
         VALUES (?, 'dm', NULL, ?, ?)`
      ).bind(convoId, joinTs, createdBy).run();

      // Beide als Member eintragen
      await env.RENEX_DB.prepare(
        `INSERT OR IGNORE INTO conversation_members (convo_id, member_handle, role, joined_at)
         VALUES (?, ?, 'member', ?)`
      ).bind(convoId, createdBy, joinTs).run();
      await env.RENEX_DB.prepare(
        `INSERT OR IGNORE INTO conversation_members (convo_id, member_handle, role, joined_at)
         VALUES (?, ?, 'member', ?)`
      ).bind(convoId, me, joinTs).run();

      // Kontakt-Einträge (bidirektional)
      await env.RENEX_DB.prepare(
        `INSERT OR IGNORE INTO contacts (user_handle, contact_handle, display_handle, status, direction, created_at, updated_at)
         VALUES (?, ?, ?, 'accepted', 'out', ?, ?)`
      ).bind(createdBy, me, me, joinTs, joinTs).run();
      await env.RENEX_DB.prepare(
        `INSERT OR IGNORE INTO contacts (user_handle, contact_handle, display_handle, status, direction, created_at, updated_at)
         VALUES (?, ?, ?, 'accepted', 'in', ?, ?)`
      ).bind(me, createdBy, createdBy, joinTs, joinTs).run();

      // ETag bumpen
      await env.RENEX_KV.put(`contacts_v:${createdBy}`, String(joinTs));
      await env.RENEX_KV.put(`contacts_v:${me}`, String(joinTs));

      // Einlader benachrichtigen
      pushToUserDO(env, createdBy, {
        type: "CONTACT_UPDATE", handle: me, ts: joinTs
      }).catch(() => {});

      // DM-Invite-Template invalidieren (einmalig)
      await env.RENEX_DB.prepare(
        "UPDATE guest_sessions SET guest_handle = '__used__' WHERE token = ? AND (guest_handle IS NULL OR guest_handle = '')"
      ).bind(token).run();

    } else if (convoId) {
      // ── Gruppen-Invite: Member eintragen ──────────────────────────────
      const existing = await env.RENEX_DB.prepare(
        "SELECT role FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
      ).bind(convoId, me).first();

      if (!existing) {
        await env.RENEX_DB.prepare(
          `INSERT OR IGNORE INTO conversation_members (convo_id, member_handle, role, joined_at)
           VALUES (?, ?, 'member', ?)`
        ).bind(convoId, me, joinTs).run();

        // Andere Mitglieder benachrichtigen
        const isGroupConvo = isUUID(convoId);
        if (isGroupConvo) {
          const members = await env.RENEX_DB.prepare(
            "SELECT member_handle FROM conversation_members WHERE convo_id = ? AND member_handle != ?"
          ).bind(convoId, me).all();
          for (const m of members.results || []) {
            await pushToUserDO(env, m.member_handle, {
              type: "member_joined", groupId: convoId, handle: me
            }).catch(() => {});
          }
        }
      }
    } else {
      return json(request, { error: "No conversation linked to this invite" }, 400);
    }

    return json(request, {
      ok: true,
      convoId,
      convoType,
      inviterHandle: createdBy,
    });
  }

  return json(request, { error: "Not found" }, 404);
}
