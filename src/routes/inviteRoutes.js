import { json, param, corsHeaders, dmConvoId, isUUID, validateConvoId, generateGuestToken, generateGuestHandle } from '../utils.js';
import { requireSession, requireGuestSession, getGuestToken, rateLimit, GUEST_TOKEN_RE, GUEST_HANDLE_RE, pushToGroupMembers, pushToUserDO } from '../auth.js';
import { getVerifiedOrg } from '../lib/orgs.js';

// ======================================================
// INVITE ROUTES — Gastzugang ohne Passkey
//   POST /invite/create   → Einladungslink erstellen (Auth erforderlich)
//   GET  /invite/info     → Konvo-Info für Landing Page (öffentlich)
//   POST /invite/join     → Gast-Session starten (kein Account nötig)
//   POST /invite/convert  → Gast → echten Account upgraden (nach Passkey-Reg)
//   POST /invite/ping     → msg_count aktualisieren + verbleibende Zeit prüfen
// ======================================================

const GUEST_EXPIRY_MS         = 24 * 60 * 60 * 1000;       // DM-Invite: 24h
const GROUP_INVITE_EXPIRY_MS  = 24 * 60 * 60 * 1000;       // Gruppen-Invite: 24h (vorher 7d, vereinheitlicht)
const GUEST_SESSION_MS        = 24 * 60 * 60 * 1000;
const GUEST_MSG_LIMIT         = 20;
// eGov 1.2: Verifizierte Orgs dürfen langlebige Invites ausstellen (P0 fürs
// Brief-Szenario — B-Post läuft 3 Tage, ein 24h-Token ist bei Ankunft tot).
// Consumer-Invites bleiben unverändert 24h (Scope-Freeze). Cap = Retention-Default.
const MAX_ORG_INVITE_DAYS     = 365;

// Helper: prüft ob ein User noch Mitglied der Konversation ist (DM oder Gruppe).
// Bei Gruppen: conversation_members-Tabelle. Bei DMs: handle muss in convo_id stehen.
async function _isStillMember(env, convoId, convoType, handle) {
  if (!convoId) return true;  // template-only DM-Invite (noch kein convoId) → trivial OK
  if (convoType === "dm") {
    return convoId.split(":").includes(handle);
  }
  const m = await env.RENEX_DB.prepare(
    "SELECT 1 FROM conversation_members WHERE convo_id = ? AND member_handle = ? LIMIT 1"
  ).bind(convoId, handle).first();
  return !!m;
}

// Org-Gate für langlebige Invites: eine Template-Dauer > 24h kann nur eine
// verifizierte Org ausgestellt haben (Gate in /invite/create). Wird die Org
// später suspendiert/entfernt, sterben ihre langlebigen Invites mit ihr —
// Konsumenten-Invites (≤24h) bleiben davon unberührt.
async function _orgInviteStillAuthorized(env, row) {
  const durationMs = Math.max(0, (row.expires_at ?? 0) - (row.created_at ?? 0));
  if (durationMs <= GUEST_EXPIRY_MS) return true;
  return !!(await getVerifiedOrg(env, row.created_by));
}

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

    const { convoId, expiresInDays, msgLimit } = body;

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

    // eGov 1.2: Langlebige Invites + Quota-Steuerung NUR für verifizierte Orgs —
    // die Landing-Page zeigt dann deren Registernamen + Badge (kein
    // unverifizierter Org-Kanal). Consumer-Invites bleiben 24h/20 (Scope-Freeze).
    const wantsOrgParams = (expiresInDays !== undefined && expiresInDays !== null)
                        || (msgLimit !== undefined && msgLimit !== null);
    let customExpiryMs = null;
    let customMsgLimit = null;
    if (wantsOrgParams) {
      const org = await getVerifiedOrg(env, me);
      if (!org) {
        return json(request, { error: "Verified organization required for custom expiry or quota", code: "org_required" }, 403);
      }
      if (expiresInDays !== undefined && expiresInDays !== null) {
        if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > MAX_ORG_INVITE_DAYS) {
          return json(request, { error: `expiresInDays must be an integer between 1 and ${MAX_ORG_INVITE_DAYS}` }, 400);
        }
        customExpiryMs = expiresInDays * 86400_000;
      }
      if (msgLimit !== undefined && msgLimit !== null) {
        // 0 = unbegrenzt (Org-Kanal-Default); endliches Limit optional.
        if (!Number.isInteger(msgLimit) || msgLimit < 0 || msgLimit > 100_000) {
          return json(request, { error: "msgLimit must be an integer between 0 (unlimited) and 100000" }, 400);
        }
        customMsgLimit = msgLimit;
      }
    }

    const now       = Date.now();
    const token     = generateGuestToken();
    const expiresAt = now + (customExpiryMs ?? (convoType === "group" ? GROUP_INVITE_EXPIRY_MS : GUEST_EXPIRY_MS));
    // Quota: explizit gesetzt > Org-Langzeit-Invite (unbegrenzt, Org steuert via
    // kill-session; Gast kann eh nur in seinen einen Kanal schreiben) > Consumer 20.
    const msgLimitFinal = customMsgLimit ?? (customExpiryMs !== null ? 0 : GUEST_MSG_LIMIT);

    await env.RENEX_DB.prepare(
      `INSERT INTO guest_sessions
         (token, convo_id, convo_type, created_by, created_at, expires_at, msg_limit, msg_count, guest_handle, converted_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', NULL)`
    ).bind(token, finalConvoId, convoType, me, now, expiresAt, msgLimitFinal).run();

    return json(request, {
      ok: true,
      token,
      inviteUrl: `https://renex.id/join?token=${token}`,
      expiresAt,
      msgLimit: msgLimitFinal,
    });
  }

  // ────────────────────────────────────────────────────
  // POST /invite/revoke
  // Inviter (= created_by) widerruft seinen eigenen Invite-Link.
  // Body: { token }
  // Effekt: Token wird sofort ungültig — selbst wenn expires_at noch in der Zukunft.
  // ────────────────────────────────────────────────────
  if (path === "/invite/revoke" && request.method === "POST") {
    const session = await requireSession(request, env);
    if (!session || session.isGuest) return json(request, { error: "Not authenticated" }, 401);
    const me = session.handle;

    let body;
    try { body = await request.json(); } catch { return json(request, { error: "Invalid JSON" }, 400); }

    const { token } = body;
    if (!token || !GUEST_TOKEN_RE.test(token)) {
      return json(request, { error: "Invalid token" }, 400);
    }

    // Nur die Template-Row (guest_handle leer/__used__) löschen, nicht aktive
    // Gast-Sessions, die diesem Token-Pattern folgen könnten.
    const row = await env.RENEX_DB.prepare(
      "SELECT created_by, guest_handle FROM guest_sessions WHERE token = ? AND (guest_handle IS NULL OR guest_handle = '' OR guest_handle = '__used__')"
    ).bind(token).first();

    if (!row) return json(request, { error: "Invite not found" }, 404);
    // Ownership: nur der Ersteller darf widerrufen
    if (row.created_by !== me) return json(request, { error: "Not authorized" }, 403);

    // Sofort als verbraucht markieren — /invite/info + /invite/join + /invite/accept
    // werden ab jetzt 410 zurückgeben.
    await env.RENEX_DB.prepare(
      "UPDATE guest_sessions SET guest_handle = '__used__' WHERE token = ? AND (guest_handle IS NULL OR guest_handle = '' OR guest_handle = '__used__')"
    ).bind(token).run();

    return json(request, { ok: true });
  }

  // ────────────────────────────────────────────────────
  // POST /invite/kill-session  (eGov 1.2, Häppchen 3)
  // Einlader/Org beendet eine AKTIVE Gast-Session SOFORT — der Alarm-/
  // Widerrufspfad („Brief nie erhalten", Fehlzustellung, Missbrauchsverdacht,
  // Offboarding). /invite/revoke deckt nur UNBENUTZTE Template-Rows;
  // dieser Endpoint ist das Gegenstück für bereits gejointe Gäste.
  // Body: { guestHandle }
  // Effekt: expires_at = jetzt (D1) + KV-Session-Purge → nächster Request des
  // Gasts läuft ins Leere; Membership/Kontakte werden inline entfernt (der
  // Guest-Cleanup-Cron würde sie sonst erst beim nächsten Lauf räumen).
  // ────────────────────────────────────────────────────
  if (path === "/invite/kill-session" && request.method === "POST") {
    const session = await requireSession(request, env);
    if (!session || session.isGuest) return json(request, { error: "Not authenticated" }, 401);
    const me = session.handle;

    const rlOk = await rateLimit(env, `invite_kill:${me}`, 60_000, 20);
    if (!rlOk) return json(request, { error: "Rate limit exceeded" }, 429);

    let body;
    try { body = await request.json(); } catch { return json(request, { error: "Invalid JSON" }, 400); }

    const { guestHandle } = body;
    if (!guestHandle || !GUEST_HANDLE_RE.test(guestHandle)) {
      return json(request, { error: "Invalid guestHandle" }, 400);
    }

    // Aktive (nicht konvertierte) Session-Row zum Handle — Handles sind beim
    // Join kollisionsgeprüft, LIMIT 1 reicht.
    const row = await env.RENEX_DB.prepare(
      "SELECT token, convo_id, created_by, converted_to FROM guest_sessions WHERE guest_handle = ? LIMIT 1"
    ).bind(guestHandle).first();
    if (!row || row.converted_to) return json(request, { error: "Guest session not found" }, 404);
    // Ownership: nur der Einlader darf killen
    if (row.created_by !== me) return json(request, { error: "Not authorized" }, 403);

    const killTs = Date.now();

    // 1) D1: Session sofort abgelaufen (requireGuestSession-D1-Fallback greift)
    await env.RENEX_DB.prepare(
      "UPDATE guest_sessions SET expires_at = ? WHERE token = ?"
    ).bind(killTs, row.token).run();

    // 2) KV: Auth-Cache purgen (requireGuestSession-Fast-Path greift)
    await env.RENEX_KV.delete(`guest_session:${row.token}`);

    // 3) Ephemere E2E-Inbox-Keys des Gasts räumen (best-effort)
    try {
      const idxRaw = await env.RENEX_KV.get(`e2e:inbox:index:${guestHandle}`);
      if (idxRaw) {
        let ids = [];
        try { ids = JSON.parse(idxRaw); } catch {}
        for (const d of (Array.isArray(ids) ? ids : [])) {
          await env.RENEX_KV.delete(`e2e:inbox:${guestHandle}:${d}`);
        }
      }
      await env.RENEX_KV.delete(`e2e:inbox:index:${guestHandle}`);
    } catch {}

    // 4) Membership + Kontakte sofort entfernen (Cron-Logik inline, idempotent)
    if (row.convo_id) {
      await env.RENEX_DB.prepare(
        "DELETE FROM conversation_members WHERE convo_id = ? AND member_handle = ? AND role = 'guest'"
      ).bind(row.convo_id, guestHandle).run();
    }
    await env.RENEX_DB.prepare(
      "UPDATE contacts SET status = 'removed', updated_at = ? WHERE contact_handle = ? AND status = 'accepted'"
    ).bind(killTs, guestHandle).run();
    await env.RENEX_DB.prepare(
      "UPDATE contacts SET status = 'removed', updated_at = ? WHERE user_handle = ? AND status = 'accepted'"
    ).bind(killTs, guestHandle).run();
    await env.RENEX_KV.put(`contacts_v:${me}`, String(killTs));

    // 5) Gast live informieren, falls WS offen (best-effort; AWAIT wg. CF-Runtime)
    await pushToUserDO(env, guestHandle, {
      id: crypto.randomUUID(), type: "GUEST_SESSION_KILLED", ts: killTs,
    }).catch(() => {});

    return json(request, { ok: true, guestHandle });
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
      "SELECT convo_id, convo_type, created_by, created_at, expires_at, guest_handle, msg_limit FROM guest_sessions WHERE token = ? AND (guest_handle IS NULL OR guest_handle = '' OR guest_handle = '__used__')"
    ).bind(token).first();

    if (!row)                         return json(request, { valid: false, reason: "not_found" }, 404);

    // ── Fallback für bereits benutzte DM-Invites ─────────────────────────
    // Wenn die Template-Row als '__used__' markiert ist, der Gast aber noch
    // eine gültige Session hat (Cookie oder X-Guest-Token), geben wir die
    // Redirect-Daten zurück statt "already_used". So landet der Gast beim
    // Wieder-Öffnen des Links direkt im Chat — auch wenn localStorage weg ist
    // (Safari ITP, PWA-vs-Tab-Wechsel, Storage-Race).
    if (row.guest_handle === "__used__") {
      // Resume nur bei bewiesenem Ownership: Client schickt einen gültigen
      // Guest-Token (Cookie oder X-Guest-Token). Ohne diesen Beweis → 410.
      // E2E-Modell wird eingehalten: ein geleakter Invite-Link alleine reicht
      // NICHT, um die Session und damit die Nachrichten zu übernehmen.
      const guestToken = getGuestToken(request);
      if (guestToken) {
        const sess = await env.RENEX_DB.prepare(
          "SELECT guest_handle, convo_id, convo_type, created_by, expires_at, converted_to, msg_limit FROM guest_sessions WHERE token = ?"
        ).bind(guestToken).first();
        if (
          sess &&
          !sess.converted_to &&
          Date.now() < sess.expires_at &&
          sess.created_by === row.created_by &&
          sess.convo_type === row.convo_type &&
          sess.guest_handle && GUEST_HANDLE_RE.test(sess.guest_handle)
        ) {
          const resumedOrg = await getVerifiedOrg(env, sess.created_by);
          return json(request, {
            valid:         true,
            resumed:       true,
            convoType:     sess.convo_type,
            convoId:       sess.convo_id,
            guestHandle:   sess.guest_handle,
            inviterHandle: sess.created_by,
            createdBy:     sess.created_by,
            displayName:   resumedOrg ? resumedOrg.name : sess.created_by + "'s Chat",
            expiresAt:     sess.expires_at,
            msgLimit:      sess.msg_limit ?? GUEST_MSG_LIMIT,
            sessionToken:  guestToken,
            msgCount:      0,
            verifiedSender: resumedOrg,
          });
        }
      }
      return json(request, { valid: false, reason: "already_used" }, 410);
    }
    if (Date.now() > row.expires_at)  return json(request, { valid: false, reason: "expired" }, 410);

    // Langlebige Org-Invites sterben mit der Org (suspendiert/entfernt → 410).
    if (!(await _orgInviteStillAuthorized(env, row))) {
      return json(request, { valid: false, reason: "inviter_suspended" }, 410);
    }

    // Inviter-Membership-Check: wenn created_by die Gruppe/DM verlassen hat,
    // soll der Link nicht mehr funktionieren — auch wenn das Token-Template noch frisch ist.
    if (!(await _isStillMember(env, row.convo_id, row.convo_type, row.created_by))) {
      return json(request, { valid: false, reason: "inviter_left" }, 410);
    }

    // Anzeigenamen der Konversation ermitteln
    let displayName = row.created_by + "'s Chat";
    if (row.convo_type === "group" && row.convo_id) {
      const convo = await env.RENEX_DB.prepare(
        "SELECT name FROM conversations WHERE id = ?"
      ).bind(row.convo_id).first();
      if (convo?.name) displayName = convo.name;
    }

    // Verified-Sender (eGov 1.1): Landing-Page zeigt den REGISTERNAMEN der Org
    // statt "<handle>'s Chat" + Badge-Daten ("Identität geprüft am … via …").
    // Quishing-Anker: Das Badge existiert nur hier (nach dem Scan), nie im Brief.
    const org = await getVerifiedOrg(env, row.created_by);
    if (org && row.convo_type === "dm") displayName = org.name;

    return json(request, {
      valid: true,
      convoType:   row.convo_type,
      displayName,
      createdBy:   row.created_by,
      expiresAt:   row.expires_at,
      msgLimit:    row.msg_limit ?? GUEST_MSG_LIMIT,   // 0 = unbegrenzt (Org-Kanal)
      verifiedSender: org,
    });
  }

  // ────────────────────────────────────────────────────
  // POST /invite/join
  // Kein Account nötig — erzeugt eine Gast-Session und setzt das Cookie
  // ────────────────────────────────────────────────────
  if (path === "/invite/join" && request.method === "POST") {
    // Rate Limit: 20 Joins pro Minute pro IP — höher gewählt als bei DM (5),
    // weil Gruppen-Onboarding aus dem gleichen Office-/WG-WLAN entsteht.
    const ip   = request.headers.get("CF-Connecting-IP") || "unknown";
    const rlOk = await rateLimit(env, `invite_join:${ip}`, 60_000, 20);
    if (!rlOk) return json(request, { error: "Rate limit exceeded" }, 429);

    let body;
    try { body = await request.json(); } catch { return json(request, { error: "Invalid JSON" }, 400); }

    const { token, publicKeyJwk, guestDeviceId, cfTurnstileToken, termsVersion } = body;
    if (!token || !GUEST_TOKEN_RE.test(token)) {
      return json(request, { error: "Invalid token" }, 400);
    }

    // ── Terms Acceptance Pflicht ──────────────────────────────────────────
    const ACCEPTED_TERMS_VERSIONS = ["2026-04-15"];
    if (typeof termsVersion !== "string" || !ACCEPTED_TERMS_VERSIONS.includes(termsVersion)) {
      return json(request, { error: "Terms acceptance required" }, 400);
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

    // Inviter-Membership-Check: hat created_by die Gruppe verlassen oder den DM-Kontakt
    // entfernt → Link soll nicht mehr nutzbar sein. Verhindert Hintertür für Ex-Member.
    if (!(await _isStillMember(env, inviteRow.convo_id, inviteRow.convo_type, inviteRow.created_by))) {
      return json(request, { error: "Inviter is no longer a member", code: "inviter_left" }, 410);
    }

    // Langlebige Org-Invites sterben mit der Org (suspendiert/entfernt → 410).
    if (!(await _orgInviteStillAuthorized(env, inviteRow))) {
      return json(request, { error: "Inviter organization is suspended", code: "inviter_suspended" }, 410);
    }

    // ── Neue unabhängige Session erzeugen (Option B: jeder Join = eigene Session) ─
    // eGov 1.2 TTL-Konsistenz: Die Gast-Session lebt so lange, wie der Invite
    // KONFIGURIERT war (Template-Dauer = expires_at − created_at), min. 24h.
    // Sonst zerfiele der „persistente Kanal" nach einem Tag, obwohl der Token
    // 90 Tage galt. e2e-Key-TTL, KV-Session-TTL und Cookie-Max-Age leiten sich
    // unten aus sessionExpires ab und wachsen damit automatisch mit.
    const now               = Date.now();
    const sessionToken      = generateGuestToken();                    // neuer einzigartiger Session-Token
    const inviteDurationMs  = Math.max(0, (inviteRow.expires_at ?? 0) - (inviteRow.created_at ?? 0));
    const sessionDurationMs = Math.min(Math.max(inviteDurationMs, GUEST_SESSION_MS), MAX_ORG_INVITE_DAYS * 86400_000);
    const sessionExpires    = now + sessionDurationMs;

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

    // ── Session-Row in D1 anlegen (inkl. Terms-Nachweis) ──────────────────
    await env.RENEX_DB.prepare(
      `INSERT INTO guest_sessions
         (token, convo_id, convo_type, created_by, created_at, expires_at, msg_limit, msg_count, guest_handle, converted_to, terms_accepted_at, terms_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`
    ).bind(sessionToken, convoId, inviteRow.convo_type, inviteRow.created_by, joinTs, sessionExpires, inviteRow.msg_limit, guestHandle, joinTs, termsVersion).run();

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
  // POST /invite/accept
  // Eingeloggter Real-User akzeptiert einen Invite-Link.
  // Pendant zu /invite/join (das Gast-Sessions erzeugt).
  // Body: { token }
  // Erstellt bidirektionale Kontakt-Einträge + DM-Convo (oder Group-Mitgliedschaft)
  // und benachrichtigt den Inviter live via WebSocket.
  // ────────────────────────────────────────────────────
  if (path === "/invite/accept" && request.method === "POST") {
    const session = await requireSession(request, env);
    if (!session || session.isGuest) {
      return json(request, { error: "Real account required" }, 401);
    }
    const me = session.handle;

    // Rate Limit: 10 Accepts pro Minute pro User (verhindert Bot-Sprays)
    const rlOk = await rateLimit(env, `invite_accept:${me}`, 60_000, 10);
    if (!rlOk) return json(request, { error: "Rate limit exceeded" }, 429);

    let body;
    try { body = await request.json(); } catch { return json(request, { error: "Invalid JSON" }, 400); }

    const { token } = body;
    if (!token || !GUEST_TOKEN_RE.test(token)) {
      return json(request, { error: "Invalid token" }, 400);
    }

    // Invite-Template-Row laden — DM: muss frei sein, Gruppe: __used__ ist OK
    const inviteRow = await env.RENEX_DB.prepare(
      "SELECT * FROM guest_sessions WHERE token = ?"
    ).bind(token).first();

    if (!inviteRow) return json(request, { error: "Invite not found", code: "not_found" }, 404);
    if (Date.now() > inviteRow.expires_at) {
      return json(request, { error: "Invite expired", code: "expired" }, 410);
    }
    // Eigene Invites kann man nicht akzeptieren
    if (inviteRow.created_by === me) {
      return json(request, { error: "Cannot accept own invite", code: "own_invite" }, 400);
    }
    // DM: nur unbenutzte Templates → bereits konsumiert (durch Gast oder anderen User) → 410
    if (inviteRow.convo_type === "dm" && inviteRow.guest_handle === "__used__") {
      return json(request, { error: "Invite already used", code: "already_used" }, 410);
    }
    // Inviter-Membership-Check: created_by darf die Convo nicht verlassen haben.
    if (!(await _isStillMember(env, inviteRow.convo_id, inviteRow.convo_type, inviteRow.created_by))) {
      return json(request, { error: "Inviter is no longer a member", code: "inviter_left" }, 410);
    }
    // Langlebige Org-Invites sterben mit der Org (suspendiert/entfernt → 410).
    if (!(await _orgInviteStillAuthorized(env, inviteRow))) {
      return json(request, { error: "Inviter organization is suspended", code: "inviter_suspended" }, 410);
    }

    const acceptTs = Date.now();
    const inviter  = inviteRow.created_by;
    let finalConvoId = inviteRow.convo_id;
    let isGroup = inviteRow.convo_type === "group";

    if (!isGroup) {
      // ── DM-Pfad ────────────────────────────────────────────────────────
      finalConvoId = dmConvoId(inviter, me);

      // Convo + Members (idempotent — falls schon Kontakt, nichts kaputt machen)
      await env.RENEX_DB.prepare(
        `INSERT OR IGNORE INTO conversations (id, type, name, created_at, created_by)
         VALUES (?, 'dm', NULL, ?, ?)`
      ).bind(finalConvoId, acceptTs, inviter).run();
      await env.RENEX_DB.prepare(
        `INSERT OR IGNORE INTO conversation_members (convo_id, member_handle, role, joined_at)
         VALUES (?, ?, 'member', ?)`
      ).bind(finalConvoId, inviter, acceptTs).run();
      await env.RENEX_DB.prepare(
        `INSERT OR IGNORE INTO conversation_members (convo_id, member_handle, role, joined_at)
         VALUES (?, ?, 'member', ?)`
      ).bind(finalConvoId, me, acceptTs).run();

      // DM-Token als verbraucht markieren (analog zu /invite/join)
      await env.RENEX_DB.prepare(
        "UPDATE guest_sessions SET guest_handle = '__used__' WHERE token = ? AND (guest_handle IS NULL OR guest_handle = '')"
      ).bind(token).run();
    } else {
      // ── Gruppen-Pfad ───────────────────────────────────────────────────
      // me als Member eintragen (idempotent)
      await env.RENEX_DB.prepare(
        `INSERT OR IGNORE INTO conversation_members (convo_id, member_handle, role, joined_at)
         VALUES (?, ?, 'member', ?)`
      ).bind(finalConvoId, me, acceptTs).run();
      // Gruppen-Token bleibt frei (Multi-Use), kein __used__-Marker
      await env.RENEX_KV.delete(`grp_members:${finalConvoId}`).catch(() => {});
    }

    // Bidirektionale Kontakte zwischen me und inviter
    await env.RENEX_DB.prepare(
      `INSERT OR IGNORE INTO contacts (user_handle, contact_handle, display_handle, status, direction, created_at, updated_at)
       VALUES (?, ?, ?, 'accepted', 'out', ?, ?)`
    ).bind(inviter, me, me, acceptTs, acceptTs).run();
    await env.RENEX_DB.prepare(
      `INSERT OR IGNORE INTO contacts (user_handle, contact_handle, display_handle, status, direction, created_at, updated_at)
       VALUES (?, ?, ?, 'accepted', 'in', ?, ?)`
    ).bind(me, inviter, inviter, acceptTs, acceptTs).run();

    // ETag-Bumps für beide Seiten — Inboxes laden neu
    await env.RENEX_KV.put(`contacts_v:${inviter}`, String(acceptTs));
    await env.RENEX_KV.put(`contacts_v:${me}`,      String(acceptTs));

    // System-Message in Convo
    await env.RENEX_DB.prepare(
      `INSERT INTO messages (id, convo_id, from_user, to_user, ts, type, message, e2e)
       VALUES (?, ?, ?, NULL, ?, 'system', ?, 0)`
    ).bind(crypto.randomUUID(), finalConvoId, me, acceptTs, `👤 ${me} joined the chat`).run();

    // Live-Event an Inviter (analog zum guest_joined-Event)
    const acceptEvent = {
      id: crypto.randomUUID(),
      type: "invite_accepted",
      groupId: finalConvoId,
      handle: me,
      ts: acceptTs,
    };
    if (isGroup) {
      await pushToGroupMembers(env, env.RENEX_DB, finalConvoId, me, acceptEvent);
    } else {
      await pushToUserDO(env, inviter, acceptEvent);
    }

    return json(request, {
      ok: true,
      convoId:       finalConvoId,
      convoType:     inviteRow.convo_type,
      inviterHandle: inviter,
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

      // 2b. E2E-CMK-KV-Wraps migrieren: `e2e:cmk:${oldCid}:*` → `e2e:cmk:${newCid}:*`
      // Sonst sucht der Empfänger nach Convert unter `[realHandle,peer].sort()` und
      // findet nichts → cmk_req → konvertierter User evtl. offline → unrecoverable.
      // Der Wrap selbst ist ECDH-encrypted für ein Empfänger-Device und damit
      // handle-agnostisch — 1:1-Kopie reicht.
      const oldCmkCid = [guestHandle, peerHandle].sort().join(":");
      const newCmkCid = [realHandle, peerHandle].sort().join(":");
      if (oldCmkCid !== newCmkCid) {
        try {
          const oldIdxKey = `e2e:cmk:index:${oldCmkCid}`;
          const newIdxKey = `e2e:cmk:index:${newCmkCid}`;
          let deviceIds = [];
          const rawOldIdx = await env.RENEX_KV.get(oldIdxKey);
          if (rawOldIdx) { try { deviceIds = JSON.parse(rawOldIdx); } catch {} }

          let copied = 0;
          for (const deviceId of deviceIds) {
            if (typeof deviceId !== "string" || deviceId.length < 8 || deviceId.length > 64) continue;
            const oldKvKey = `e2e:cmk:${oldCmkCid}:${deviceId}`;
            const newKvKey = `e2e:cmk:${newCmkCid}:${deviceId}`;
            const wrap = await env.RENEX_KV.get(oldKvKey);
            if (!wrap) continue;
            // Defensiv: existiert newKvKey schon (z.B. real-user → real-user Send vor Convert),
            // NICHT überschreiben — der frischere Wrap ist autoritativ.
            const existingNew = await env.RENEX_KV.get(newKvKey);
            if (!existingNew) {
              await env.RENEX_KV.put(newKvKey, wrap);
            }
            await env.RENEX_KV.delete(oldKvKey);
            copied++;
          }

          if (copied > 0) {
            // Index mergen: vorhandene deviceIds aus oldIdx in newIdx einbauen
            let newIdx = [];
            const rawNewIdx = await env.RENEX_KV.get(newIdxKey);
            if (rawNewIdx) { try { newIdx = JSON.parse(rawNewIdx); } catch {} }
            for (const did of deviceIds) {
              if (typeof did === "string" && !newIdx.includes(did)) newIdx.push(did);
            }
            await env.RENEX_KV.put(newIdxKey, JSON.stringify(newIdx));
            await env.RENEX_KV.delete(oldIdxKey);

            // user-idx: peerHandle's und realHandle's user-Index müssen newCid kennen,
            // oldCid raus. (peerHandle = Einlader; realHandle = ehem. Gast)
            for (const u of [peerHandle, realHandle]) {
              const userIdxKey = `e2e:cmk:user-idx:${u}`;
              let userIdx = [];
              const raw = await env.RENEX_KV.get(userIdxKey);
              if (raw) { try { userIdx = JSON.parse(raw); } catch {} }
              userIdx = userIdx.filter(c => c !== oldCmkCid);
              if (!userIdx.includes(newCmkCid)) userIdx.push(newCmkCid);
              await env.RENEX_KV.put(userIdxKey, JSON.stringify(userIdx));
            }
            // guest_xxx-User-Index ist obsolet — guest_sessions wird gleich auf
            // converted markiert, der Account selbst ist tot.
            await env.RENEX_KV.delete(`e2e:cmk:user-idx:${guestHandle}`);
          }
        } catch (e) {
          // KV-Migration ist best-effort — der Convert selbst gilt auch ohne als gelungen.
          // Frontend-Republish (App.svelte nach migrateMyHandle) ist der Fallback.
          console.error("guest-convert: CMK-KV-migration failed", e);
        }
      }

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
      // Hinweis: Alte Nachrichten bleiben entschlüsselbar, da `sid` pro Message
      // persistiert ist (messages.sid) und CMK bei A via `migratePeerHandle`
      // re-encrypted wird (Live-WS-Event GUEST_CONVERTED oder Catchup via
      // /contacts.previous_handle bei nächstem loadContacts-Call).
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
      // AWAIT wichtig: CF Workers kann fire-and-forget Promise terminieren
      // bevor das DO-fetch durchkommt — Partner-Frontend sieht sonst nichts.
      await pushToUserDO(env, peerHandle, {
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
      ok:            true,
      realHandle,
      convoId:       finalConvoId,
      convoType:     row.convo_type,
      inviterHandle: row.created_by,
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
    // msg_limit 0 = unbegrenzt (Org-Kanal) → msgsLeft null, Banner blendet Zähler aus
    const unlimited = !(row.msg_limit > 0);
    const msgsLeft  = unlimited ? null : Math.max(0, row.msg_limit - row.msg_count);
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
    // Langlebige Org-Invites sterben mit der Org (suspendiert/entfernt → 410).
    if (!(await _orgInviteStillAuthorized(env, row))) {
      return json(request, { error: "Inviter organization is suspended", code: "inviter_suspended" }, 410);
    }

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
      // AWAIT wichtig: CF Workers kann fire-and-forget Promise terminieren
      // bevor das DO-fetch durchkommt — Einlader sieht sonst nichts.
      await pushToUserDO(env, createdBy, {
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
