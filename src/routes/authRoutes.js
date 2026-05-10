import { json, readJson, base64url, base64urlToString, base64urlToArrayBuffer, decodeCBOR, corsHeaders } from '../utils.js';
import { requireSession, requireAnySession, rateLimit, getToken, registerSessionToken, unregisterSessionToken, revokeAllSessions, verifyTurnstile, pushToGroupMembers } from '../auth.js';
import { handleLoginFinish } from '../helpers/loginFinish.js';
import { readCredentials, writeCredentials, MAX_PASSKEYS } from '../helpers/credentials.js';

// ======================================================
// AUTH ROUTES: /auth/register/*, /auth/login/*,
//              /auth/session, /auth/ws-ticket,
//              /auth/logout, /users/me, /account,
//              /auth/passkeys
// ======================================================

// ── Profile helpers ────────────────────────────────
// KV: profile:${handle} → { display_name: string|null, updated_at: number }
// display_name ist optional und darf null/fehlend sein; Fallback ist der Handle.
async function readProfile(env, handle) {
  const raw = await env.RENEX_KV.get(`profile:${handle}`);
  if (!raw) return { handle, display_name: null };
  try {
    const p = JSON.parse(raw);
    return { handle, display_name: p.display_name || null };
  } catch {
    return { handle, display_name: null };
  }
}

function validateDisplayName(name) {
  if (name === null || name === undefined) return { ok: true, value: null };
  if (typeof name !== "string") return { ok: false, error: "invalid_type" };
  // Kontrollzeichen, Zeilenumbrüche, Tabs entfernen
  const cleaned = name.replace(/[\r\n\t\x00-\x1f\x7f]/g, "").trim();
  if (cleaned.length === 0) return { ok: true, value: null };
  // Länge als Codepoints zählen (damit Emojis nicht doppelt zählen)
  const codepoints = Array.from(cleaned);
  if (codepoints.length > 32) return { ok: false, error: "too_long" };
  return { ok: true, value: cleaned };
}

export async function handleAuthRoutes(request, env, path, params) {
  // /users/:handle/profile  (GET, öffentlich für eingeloggte User)
  const profileMatch = path.match(/^\/users\/([a-z0-9_]+)\/profile$/);
  if (profileMatch) {
    if (request.method !== "GET") {
      return json(request, { error: "Method not allowed" }, 405);
    }
    const session = await requireSession(request, env);
    if (!session) return json(request, { error: "Not authenticated" }, 401);
    const targetHandle = profileMatch[1];
    const profile = await readProfile(env, targetHandle);
    return json(request, profile);
  }

  switch (path) {

    // =========================
    // AUTH / REGISTER / START
    // =========================
    case "/auth/register/start": {
      if (request.method === "POST") {

        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);

        const { handle, cfTurnstileToken } = body;

        const h = (handle || "").toLowerCase();

        if (!/^[a-z0-9_]+$/.test(h) || h.length < 3 || h.length > 32) {
          return json(request, { error: "Invalid handle" }, 400);
        }

        // Rate Limit: max. 5 Registrierungsversuche pro IP pro Minute (fail-closed)
        const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
        const rlOk = await rateLimit(env, `register_start:${ip}`, 60_000, 5);
        if (!rlOk) return json(request, { error: "Too many requests" }, 429);

        // Handle-Sperre prüfen (gelöschte Accounts)
        const deletedFlag = await env.RENEX_KV.get(`deleted:${h}`);
        if (deletedFlag) {
          return json(request, { error: "Handle not available" }, 409);
        }

        // Prüfen ob User bereits existiert (Passkey hinzufügen vs. Neu-Registrierung)
        const existingCreds = await readCredentials(env, h);
        let excludeCredentials = [];

        if (existingCreds) {
          // User existiert → Session prüfen (nur eingeloggte User dürfen Passkey hinzufügen)
          const session = await requireSession(request, env);
          if (!session || session.handle !== h) {
            return json(request, { error: "Not authenticated" }, 401);
          }
          if (existingCreds.length >= MAX_PASSKEYS) {
            return json(request, { error: "Maximum number of passkeys reached" }, 400);
          }
          // excludeCredentials: verhindert Re-Registrierung desselben Authenticators
          excludeCredentials = existingCreds.map(c => ({
            type: "public-key",
            id: c.credential_id,
            transports: ["internal", "hybrid", "usb", "ble", "nfc"]
          }));
        } else {
          // Neu-Registrierung: Turnstile-Verifikation Pflicht.
          // Anti-Bot vor Beta-Wellen — Add-Passkey-Pfad (existingCreds + Session)
          // braucht es nicht, da User schon authentifiziert ist.
          // env.TURNSTILE_SECRET fehlt im Dev → Skip mit Warnung.
          if (env.TURNSTILE_SECRET) {
            if (!cfTurnstileToken || typeof cfTurnstileToken !== 'string') {
              return json(request, { error: "Captcha required", code: "captcha_required" }, 400);
            }
            const turnstileOk = await verifyTurnstile(cfTurnstileToken, ip, env);
            if (!turnstileOk) {
              return json(request, { error: "Captcha verification failed", code: "captcha_failed" }, 403);
            }
          } else {
            console.warn("⚠️  TURNSTILE_SECRET not configured — skipping captcha for register");
          }
        }

        // Challenge erzeugen
        const challengeB64 = base64url(
          crypto.getRandomValues(new Uint8Array(32))
        );

        // Challenge speichern (5 Minuten)
        await env.RENEX_KV.put(
          `challenge:register:${h}`,
          JSON.stringify({
            challenge: challengeB64,
            ts: Date.now(),
            isAddPasskey: !!existingCreds  // Flag: Passkey hinzufügen vs. Neu-Registrierung
          }),
          { expirationTtl: 300 }
        );

        return json(request, {
          publicKey: {
            challenge: challengeB64,

            rp: {
              name: "RENEX",
              id: "app.renex.id"
            },

            user: {
              id: base64url(new TextEncoder().encode(h)),
              name: h,
              displayName: h
            },

            pubKeyCredParams: [
              { type: "public-key", alg: -7 },    // ES256
              { type: "public-key", alg: -257 }   // RS256 fallback
            ],

            authenticatorSelection: {
              userVerification: "required",
              residentKey: "preferred",
              requireResidentKey: false
            },

            excludeCredentials,

            timeout: 60000,
            attestation: "none"
          }
        });
      }
      break;
    }

    // =========================
    // AUTH / REGISTER / FINISH
    // =========================
    case "/auth/register/finish": {
      if (request.method === "POST") {

        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);

        const handle = (body.handle || "").toLowerCase();

        if (!handle || !body.response?.clientDataJSON) {
          return json(request, { error: "Invalid register payload" }, 400);
        }

        // Challenge aus KV laden
        const chRaw = await env.RENEX_KV.get(`challenge:register:${handle}`);
        if (!chRaw) {
          return json(request, { error: "Register challenge expired" }, 400);
        }

        const challengeData = JSON.parse(chRaw);
        const { challenge } = challengeData;

        // clientDataJSON prüfen
        let clientData;
        try {
          clientData = JSON.parse(
            base64urlToString(body.response.clientDataJSON)
          );
        } catch {
          return json(request, { error: "Invalid clientDataJSON" }, 400);
        }

        if (clientData.type !== "webauthn.create") {
          return json(request, { error: "Invalid WebAuthn type" }, 400);
        }

        if (clientData.origin !== "https://app.renex.id") {
          await env.RENEX_KV.delete(`challenge:register:${handle}`);
          return json(request, { error: "Invalid origin" }, 400);
        }

        if (clientData.challenge !== challenge) {
          return json(request, { error: "Challenge mismatch" }, 400);
        }

        // Challenge löschen
        await env.RENEX_KV.delete(`challenge:register:${handle}`);

        // Public Key aus attestationObject extrahieren
        if (!body.response?.attestationObject) {
          return json(request, { error: "Missing attestationObject" }, 400);
        }

        let authDataReg;
        try {
          const attObjBytes = new Uint8Array(base64urlToArrayBuffer(body.response.attestationObject));
          const attObj = decodeCBOR(attObjBytes);
          authDataReg = attObj["authData"];
        } catch {
          return json(request, { error: "Invalid attestationObject" }, 400);
        }

        if (!authDataReg || authDataReg.length < 55) {
          return json(request, { error: "Invalid authData in attestationObject" }, 400);
        }

        const regCredIdLen = (authDataReg[53] << 8) | authDataReg[54];
        const coseKeyOffset = 55 + regCredIdLen;

        if (authDataReg.length <= coseKeyOffset) {
          return json(request, { error: "Missing COSE key in authData" }, 400);
        }

        let publicKeyJwk;
        try {
          const coseKey = decodeCBOR(authDataReg.slice(coseKeyOffset));
          const kty = coseKey[1];
          const alg = coseKey[3];
          if (kty === 2 && alg === -7) {
            // ES256 / P-256
            publicKeyJwk = { kty: "EC", crv: "P-256", x: base64url(coseKey[-2]), y: base64url(coseKey[-3]) };
          } else if (kty === 3 && alg === -257) {
            // RS256 / RSA
            publicKeyJwk = { kty: "RSA", alg: "RS256", n: base64url(coseKey[-1]), e: base64url(coseKey[-2]) };
          } else {
            return json(request, { error: "Unsupported key type" }, 400);
          }
        } catch {
          return json(request, { error: "Invalid COSE key" }, 400);
        }

        // Credential erstellen
        const newCred = {
          credential_id: body.id,
          publicKeyJwk,
          created_at: Date.now(),
          signCount: 0,
          name: body.name || null,   // Optional: z.B. "iPhone", "MacBook"
          last_used: null,
        };

        if (challengeData.isAddPasskey) {
          // Passkey hinzufügen: an bestehendes Array anhängen
          const existing = await readCredentials(env, handle);
          if (!existing) {
            return json(request, { error: "Account not found" }, 404);
          }
          existing.push(newCred);
          await writeCredentials(env, handle, existing);
          return json(request, { status: "ok" });
        }

        // Neue Registrierung: Terms-Version validieren
        const ACCEPTED_TERMS_VERSIONS = ["2026-04-15"];
        const termsVersion = typeof body.termsVersion === "string" ? body.termsVersion : null;
        if (!termsVersion || !ACCEPTED_TERMS_VERSIONS.includes(termsVersion)) {
          return json(request, { error: "Terms acceptance required" }, 400);
        }

        // Array mit erstem Credential erstellen
        await writeCredentials(env, handle, [newCred]);

        // Terms-Zustimmung in KV speichern (Nachweis für DSG/DSGVO)
        await env.RENEX_KV.put(
          `user:terms:${handle}`,
          JSON.stringify({ acceptedAt: Date.now(), version: termsVersion })
        );

        // Auto-Login: nach erfolgreicher Registrierung sofort Session erzeugen
        // (sonst muss User explizit nochmal einloggen — Svelte kann das nicht
        // wie Vanilla via window.location.replace umgehen).
        // Same Cookie-Format wie login/finish.
        const sessionToken = "sess_" + crypto.randomUUID();
        const ua = request.headers.get("user-agent") || "";
        const uaHash = ua ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ua)).then(h => base64url(new Uint8Array(h))) : null;
        const sessionNow = Date.now();
        await env.RENEX_KV.put(
          `session:${sessionToken}`,
          JSON.stringify({
            handle,
            createdAt: sessionNow,
            lastRefreshed: sessionNow,    // Sliding-TTL Anker (M4)
            ua: uaHash,
          }),
          { expirationTtl: 86_400 }
        );
        await registerSessionToken(env, handle, sessionToken);

        // Cookie Max-Age = 30d (sliding session: aktive User bleiben unbegrenzt
        // eingeloggt, idle 24h → KV-Expiry → forced re-login).
        const sessionCookie = `session=${sessionToken}; HttpOnly; Secure; SameSite=Strict; Domain=renex.id; Path=/; Max-Age=2592000`;
        return new Response(
          JSON.stringify({ status: "ok", authenticated: true }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": sessionCookie,
              ...corsHeaders(request),
            },
          }
        );
      }
      break;
    }

    // =========================
    // AUTH / LOGIN / START
    // =========================
    case "/auth/login/start": {
      if (request.method === "POST") {

        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);

        const handle = (body.handle || "").toLowerCase();

        if (!/^[a-z0-9_]+$/.test(handle)) {
          return json(request, { error: "Invalid handle" }, 400);
        }

        // Rate limit: login/start pro IP
        const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
        const ok = await rateLimit(
          env,
          `login_start:${ip}:${handle}`,
          60_000,
          10
        );
        if (!ok) return json(request, { error: "Too many requests" }, 429);

        const credentials = await readCredentials(env, handle);

        // Login-Challenge erzeugen (immer, unabhängig ob User existiert)
        const challengeB64 = base64url(
          crypto.getRandomValues(new Uint8Array(32))
        );

        if (!credentials || credentials.length === 0) {
          // User existiert nicht → Registrierung starten
          return json(request, { registered: false });
        }

        // Login-Challenge speichern (5 Minuten) — ohne feste credential_id
        await env.RENEX_KV.put(
          `challenge:login:${handle}`,
          JSON.stringify({
            challenge: challengeB64,
            ts: Date.now()
          }),
          { expirationTtl: 300 }
        );

        return json(request, {
          publicKey: {
            challenge: challengeB64,
            rpId: "app.renex.id",

            allowCredentials: credentials.map(c => ({
              type: "public-key",
              id: c.credential_id,
              transports: ["internal", "hybrid", "usb", "ble", "nfc"]
            })),

            userVerification: "required",
            timeout: 60000,
          },
        });
      }
      break;
    }

    // =========================
    // AUTH / LOGIN / FINISH
    // =========================
    case "/auth/login/finish": {
      if (request.method === "POST") {
        return handleLoginFinish(request, env);
      }
      break;
    }

    // =========================
    // AUTH / SESSION CHECK (immer 200 — kein Console-Error im Browser)
    // requireAnySession akzeptiert echte (sess_*) UND Gast-Sessions
    // (guest_*) — sonst landet ein frisch via /invite/join geländerter
    // Gast direkt im Login-Modal weil requireSession seinen Token-Prefix
    // ablehnt (Block-G-Bug-Fix).
    // =========================
    case "/auth/session": {
      if (request.method === "GET") {
        const session = await requireAnySession(request, env);
        if (!session) return json(request, { valid: false });
        return json(request, {
          valid: true,
          handle: session.handle,
          isGuest: !!session.isGuest,
        });
      }
      break;
    }

    // =========================
    // USERS / ME
    // =========================
    case "/users/me": {
      const session = await requireSession(request, env);
      if (!session) return json(request, { error: "Not authenticated" }, 401);

      if (request.method === "GET") {
        const profile = await readProfile(env, session.handle);
        return json(request, profile);
      }

      if (request.method === "PATCH") {
        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);

        // Rate-Limit: max. 10 Profil-Updates pro Stunde pro User
        const rlOk = await rateLimit(env, `profile_update:${session.handle}`, 3600_000, 10);
        if (!rlOk) return json(request, { error: "Too many requests" }, 429);

        const check = validateDisplayName(body.display_name);
        if (!check.ok) {
          return json(request, { error: check.error }, 400);
        }

        if (check.value === null) {
          // Reset: Eintrag komplett löschen → Fallback auf Handle
          await env.RENEX_KV.delete(`profile:${session.handle}`);
        } else {
          await env.RENEX_KV.put(
            `profile:${session.handle}`,
            JSON.stringify({ display_name: check.value, updated_at: Date.now() })
          );
        }
        return json(request, { handle: session.handle, display_name: check.value });
      }

      return json(request, { error: "Method not allowed" }, 405);
    }

    // =========================
    // AUTH / WS-TICKET
    // Kurzlebiges Einmal-Ticket (60s TTL) für WebSocket-Auth.
    // Kein Session-Token in der WS-URL — Ticket wird nach erstem
    // Verbindungsaufbau sofort aus KV gelöscht.
    // Cloudflare KV: minimales expirationTtl = 60s
    // =========================
    case "/auth/ws-ticket": {
      if (request.method === "POST") {
        const session = await requireSession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);

        const ticket = `wst_${crypto.randomUUID()}`;
        await env.RENEX_KV.put(
          `ws-ticket:${ticket}`,
          JSON.stringify({ handle: session.handle }),
          { expirationTtl: 60 }  // KV-Minimum: 60s
        );

        return json(request, { ticket });
      }
      break;
    }

    // =========================
    // AUTH / LOGOUT
    // =========================
    case "/auth/logout": {
      if (request.method === "POST") {

        const token = getToken(request);

        if (token) {
          // Handle vor dem Löschen auslesen (für Index-Bereinigung)
          const raw = await env.RENEX_KV.get(`session:${token}`);
          await env.RENEX_KV.delete(`session:${token}`);
          if (raw) {
            try {
              const s = JSON.parse(raw);
              if (s?.handle) await unregisterSessionToken(env, s.handle, token);
            } catch {}
          }
        }

        const clearCookie = `session=; HttpOnly; Secure; SameSite=Strict; Domain=renex.id; Path=/; Max-Age=0`;
        return new Response(JSON.stringify({ status: "logged_out" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": clearCookie,
            ...corsHeaders(request),
          },
        });
      }
      break;
    }

    // =========================
    // ACCOUNT / DELETE
    // =========================
    case "/account": {
      if (request.method === "DELETE") {

        const session = await requireSession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);

        const handle = session.handle;
        const token = getToken(request);

        // 1. ALLE Sessions des Users widerrufen (alle Geräte sofort ausgeloggt)
        await revokeAllSessions(env, handle);
        // Aktuelle Session zusätzlich explizit löschen (falls noch nicht im Index)
        if (token) {
          await env.RENEX_KV.delete(`session:${token}`);
        }

        // 2. WebAuthn-Passkey löschen
        await env.RENEX_KV.delete(`webauthn:${handle}`);

        // 3. Chat-Pubkeys löschen (alle Devices via Index)
        const chatIdxRaw = await env.RENEX_KV.get(`chat:pubkeys:${handle}`);
        if (chatIdxRaw) {
          try {
            const deviceIds = JSON.parse(chatIdxRaw);
            for (const did of deviceIds) {
              await env.RENEX_KV.delete(`chat:pubkey:${handle}:${did}`);
            }
          } catch {}
          await env.RENEX_KV.delete(`chat:pubkeys:${handle}`);
        }
        // Legacy single-key
        await env.RENEX_KV.delete(`chat:pubkey:${handle}`);

        // 4. E2E Inbox-Keys löschen (alle Devices via Index)
        const inboxIdxRaw = await env.RENEX_KV.get(`e2e:inbox:index:${handle}`);
        if (inboxIdxRaw) {
          try {
            const deviceIds = JSON.parse(inboxIdxRaw);
            for (const did of deviceIds) {
              await env.RENEX_KV.delete(`e2e:inbox:${handle}:${did}`);
            }
          } catch {}
          await env.RENEX_KV.delete(`e2e:inbox:index:${handle}`);
        }

        // 5. Unread-Counter und Index löschen
        const unreadIndex = await env.RENEX_KV.get(`unread_index:${handle}`);
        if (unreadIndex) {
          try {
            const map = JSON.parse(unreadIndex);
            for (const peer of Object.keys(map)) {
              await env.RENEX_KV.delete(`unread:${handle}:${peer}`);
            }
          } catch {}
          await env.RENEX_KV.delete(`unread_index:${handle}`);
        }

        // 6. CMK KV-Einträge löschen
        const cmkUserIdxRaw = await env.RENEX_KV.get(`e2e:cmk:user-idx:${handle}`);
        if (cmkUserIdxRaw) {
          try {
            const convoIds = JSON.parse(cmkUserIdxRaw);
            for (const cid of convoIds) {
              const convoIdxRaw = await env.RENEX_KV.get(`e2e:cmk:index:${cid}`);
              if (convoIdxRaw) {
                try {
                  const deviceIds = JSON.parse(convoIdxRaw);
                  for (const did of deviceIds) {
                    await env.RENEX_KV.delete(`e2e:cmk:${cid}:${did}`);
                  }
                } catch {}
                await env.RENEX_KV.delete(`e2e:cmk:index:${cid}`);
              }
            }
          } catch {}
          await env.RENEX_KV.delete(`e2e:cmk:user-idx:${handle}`);
        }

        // 6b. Terms-Zustimmung löschen (DSG/DSGVO Löschungsrecht)
        await env.RENEX_KV.delete(`user:terms:${handle}`);

        // 6c. Profil (Display Name) löschen
        await env.RENEX_KV.delete(`profile:${handle}`);

        // 6d. Recovery-Bundle + Salt + Meta löschen (Spec: docs/RECOVERY.md §10.3)
        await env.RENEX_KV.delete(`user:recovery:${handle}`);
        if (env.RENEX_FILES) {
          await env.RENEX_FILES.delete(`recovery/${handle}.salt`).catch(() => {});
          await env.RENEX_FILES.delete(`recovery/${handle}.bin`).catch(() => {});
        }

        // 7. Handle für 300 Tage sperren
        await env.RENEX_KV.put(
          `deleted:${handle}`,
          "1",
          { expirationTtl: 300 * 24 * 60 * 60 }
        );

        // 7a. R2-Attachments aller eigenen Messages löschen — DSGVO Art. 17.
        // Aus dem messages-Insert-Pfad: r2Key-Format ist `files/{convoId}/{uuid}`,
        // bei GIFs ist attachment_key NULL bzw. attachment_type='gif' → skip
        // (GIPHY-URLs sind kein eigener Speicher).
        if (env.RENEX_FILES) {
          const attachRows = await env.RENEX_DB.prepare(
            `SELECT attachment_key FROM messages
             WHERE (from_user = ? OR to_user = ?)
               AND attachment_key IS NOT NULL
               AND (attachment_type IS NULL OR attachment_type != 'gif')`
          ).bind(handle, handle).all();
          const keys = (attachRows.results || [])
            .map(r => r.attachment_key)
            .filter(Boolean);
          // Parallele R2-Deletes mit Concurrency-Cap (Worker hat ein Subrequest-Limit)
          const CONC = 10;
          for (let i = 0; i < keys.length; i += CONC) {
            await Promise.allSettled(
              keys.slice(i, i + CONC).map(k => env.RENEX_FILES.delete(k).catch(() => {}))
            );
          }
        }

        // 7b. Group-Memberships aufräumen mit Admin-Nachfolge.
        // Pattern recycled aus /groups/leave (groupRoutes.js:300).
        const memberOfRows = await env.RENEX_DB.prepare(
          `SELECT cm.convo_id, cm.role, c.type
             FROM conversation_members cm
             JOIN conversations c ON c.id = cm.convo_id
            WHERE cm.member_handle = ? AND c.type = 'group'`
        ).bind(handle).all();
        for (const row of (memberOfRows.results || [])) {
          const groupId = row.convo_id;
          // Member entfernen
          await env.RENEX_DB.prepare(
            "DELETE FROM conversation_members WHERE convo_id = ? AND member_handle = ?"
          ).bind(groupId, handle).run();
          env.RENEX_KV.delete(`grp_members:${groupId}`).catch(() => {});

          // War User Admin? → ältesten verbleibenden Member promoten
          if (row.role === "admin") {
            const otherAdmin = await env.RENEX_DB.prepare(
              "SELECT 1 FROM conversation_members WHERE convo_id = ? AND role = 'admin' LIMIT 1"
            ).bind(groupId).first();
            if (!otherAdmin) {
              const successor = await env.RENEX_DB.prepare(
                "SELECT member_handle FROM conversation_members WHERE convo_id = ? ORDER BY joined_at ASC LIMIT 1"
              ).bind(groupId).first();
              if (successor) {
                await env.RENEX_DB.prepare(
                  "UPDATE conversation_members SET role = 'admin' WHERE convo_id = ? AND member_handle = ?"
                ).bind(groupId, successor.member_handle).run();
              }
            }
          }

          // Verbleibenden Members signalisieren — group_member_left mit reason
          await pushToGroupMembers(env, env.RENEX_DB, groupId, null, {
            id: crypto.randomUUID(),
            type: "group_member_left",
            groupId,
            handle,
            reason: "account_deleted",
            ts: Date.now(),
          }, { bypassCache: true }).catch(() => {});

          // Wenn letzter Member weg → ganze Gruppe löschen (inkl. Settings)
          const remaining = await env.RENEX_DB.prepare(
            "SELECT COUNT(*) as c FROM conversation_members WHERE convo_id = ?"
          ).bind(groupId).first();
          if ((remaining?.c ?? 0) === 0) {
            await env.RENEX_DB.prepare("DELETE FROM conversations WHERE id = ?").bind(groupId).run();
            await env.RENEX_DB.prepare("DELETE FROM auto_delete_settings WHERE convo_id = ?").bind(groupId).run();
          }
        }

        // 7c. Nachrichten in D1 löschen (jetzt sind R2-Files schon weg)
        await env.RENEX_DB.prepare(
          "DELETE FROM messages WHERE from_user = ? OR to_user = ?"
        ).bind(handle, handle).run();

        // 7d. Devices
        await env.RENEX_DB.prepare(
          "DELETE FROM devices WHERE user_handle = ?"
        ).bind(handle).run();

        // 7e. Push-Subscriptions (alle Browser/Geräte)
        await env.RENEX_DB.prepare(
          "DELETE FROM push_subscriptions WHERE user_handle = ?"
        ).bind(handle).run();

        // 7f. Notification-Mutes
        await env.RENEX_DB.prepare(
          "DELETE FROM notification_mutes WHERE user_handle = ?"
        ).bind(handle).run();

        // 7g. Call-Log
        await env.RENEX_DB.prepare(
          "DELETE FROM call_log WHERE caller = ? OR callee = ?"
        ).bind(handle, handle).run();

        // 7h. Auto-Delete-Settings für DM-Konvos mit diesem User entfernen
        // (DM-convo_id Format = "alice:bob" alphabetisch sortiert).
        await env.RENEX_DB.prepare(
          `DELETE FROM auto_delete_settings
           WHERE convo_id LIKE ? OR convo_id LIKE ? OR proposed_by = ?`
        ).bind(`${handle}:%`, `%:${handle}`, handle).run();

        // 8. Eigene Kontaktzeilen löschen, Gegenseite auf account_deleted setzen
        await env.RENEX_DB.prepare(
          "DELETE FROM contacts WHERE user_handle = ?"
        ).bind(handle).run();

        await env.RENEX_DB.prepare(
          "UPDATE contacts SET status = 'account_deleted', updated_at = ? WHERE contact_handle = ?"
        ).bind(Date.now(), handle).run();

        return json(request, { status: "deleted" });
      }
      break;
    }

    // =========================
    // AUTH / PASSKEYS (Liste + Löschen)
    // =========================
    case "/auth/passkeys": {

      // GET: Alle Passkeys des Users auflisten
      if (request.method === "GET") {
        const session = await requireSession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);

        const creds = await readCredentials(env, session.handle);
        if (!creds) return json(request, { passkeys: [] });

        return json(request, {
          passkeys: creds.map(c => ({
            credential_id: c.credential_id,
            name:          c.name || null,
            created_at:    c.created_at,
            last_used:     c.last_used || null,
          }))
        });
      }

      // DELETE: Bestimmten Passkey entfernen
      if (request.method === "DELETE") {
        const session = await requireSession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);

        const body = await readJson(request);
        if (!body?.credential_id) {
          return json(request, { error: "Missing credential_id" }, 400);
        }

        const creds = await readCredentials(env, session.handle);
        if (!creds) return json(request, { error: "No passkeys found" }, 404);

        if (creds.length <= 1) {
          return json(request, { error: "Cannot remove last passkey" }, 400);
        }

        const idx = creds.findIndex(c => c.credential_id === body.credential_id);
        if (idx === -1) {
          return json(request, { error: "Passkey not found" }, 404);
        }

        creds.splice(idx, 1);
        await writeCredentials(env, session.handle, creds);

        return json(request, { status: "ok", remaining: creds.length });
      }

      // PATCH: Passkey umbenennen
      if (request.method === "PATCH") {
        const session = await requireSession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);

        const body = await readJson(request);
        if (!body?.credential_id || typeof body.name !== "string") {
          return json(request, { error: "Missing credential_id or name" }, 400);
        }

        const name = body.name.trim().slice(0, 64);
        if (!name) return json(request, { error: "Name cannot be empty" }, 400);

        const creds = await readCredentials(env, session.handle);
        if (!creds) return json(request, { error: "No passkeys found" }, 404);

        const cred = creds.find(c => c.credential_id === body.credential_id);
        if (!cred) return json(request, { error: "Passkey not found" }, 404);

        cred.name = name;
        await writeCredentials(env, session.handle, creds);

        return json(request, { status: "ok" });
      }

      break;
    }

    default:
      break;
  }

  return json(request, { error: "Not found" }, 404);
}
