import { json, readJson, base64url, base64urlToString, base64urlToArrayBuffer, decodeCBOR, corsHeaders } from '../utils.js';
import { requireSession, rateLimit, getToken, registerSessionToken, unregisterSessionToken, revokeAllSessions } from '../auth.js';
import { handleLoginFinish } from '../helpers/loginFinish.js';

// ======================================================
// AUTH ROUTES: /auth/register/*, /auth/login/*,
//              /auth/session, /auth/ws-ticket,
//              /auth/logout, /users/me, /account
// ======================================================
export async function handleAuthRoutes(request, env, path, params) {
  switch (path) {

    // =========================
    // AUTH / REGISTER / START
    // =========================
    case "/auth/register/start": {
      if (request.method === "POST") {

        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);

        const { handle } = body;

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

        // Challenge erzeugen
        const challengeB64 = base64url(
          crypto.getRandomValues(new Uint8Array(32))
        );

        // Challenge speichern (5 Minuten)
        await env.RENEX_KV.put(
          `challenge:register:${h}`,
          JSON.stringify({
            challenge: challengeB64,
            ts: Date.now()
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

        const { challenge } = JSON.parse(chRaw);

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

        // Credential + Public Key speichern
        await env.RENEX_KV.put(
          `webauthn:${handle}`,
          JSON.stringify({
            credential_id: body.id,
            publicKeyJwk,
            created_at: Date.now()
          })
        );

        return json(request, { status: "ok" });
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

        const stored = await env.RENEX_KV.get(`webauthn:${handle}`);

        // Login-Challenge erzeugen (immer, unabhängig ob User existiert)
        const challengeB64 = base64url(
          crypto.getRandomValues(new Uint8Array(32))
        );

        if (!stored) {
          // User existiert nicht → Registrierung starten
          return json(request, { registered: false });
        }

        let parsed;
        try {
          parsed = JSON.parse(stored);
        } catch {
          return json(request, { error: "Corrupted passkey data" }, 500);
        }
        const credential_id = parsed.credential_id;
        if (!credential_id || typeof credential_id !== "string") {
          return json(request, { error: "Invalid credential" }, 500);
        }

        // Login-Challenge speichern (5 Minuten)
        await env.RENEX_KV.put(
          `challenge:login:${handle}`,
          JSON.stringify({
            challenge: challengeB64,
            credential_id,
            ts: Date.now()
          }),
          { expirationTtl: 300 }
        );

        return json(request, {
          publicKey: {
            challenge: challengeB64,
            rpId: "app.renex.id",

            allowCredentials: [{
              type: "public-key",
              id: credential_id,   // STRING!
              transports: ["internal"]
            }],

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
    // =========================
    case "/auth/session": {
      if (request.method === "GET") {
        const session = await requireSession(request, env);
        if (!session) return json(request, { valid: false });
        return json(request, { valid: true, handle: session.handle });
      }
      break;
    }

    // =========================
    // USERS / ME
    // =========================
    case "/users/me": {
      if (request.method === "GET") {
        const session = await requireSession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);
        return json(request, { handle: session.handle });
      }
      break;
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

        // 7. Handle für 300 Tage sperren
        await env.RENEX_KV.put(
          `deleted:${handle}`,
          "1",
          { expirationTtl: 300 * 24 * 60 * 60 }
        );

        // 7. Nachrichten in D1 löschen
        await env.RENEX_DB.prepare(
          "DELETE FROM messages WHERE from_user = ? OR to_user = ?"
        ).bind(handle, handle).run();

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

    default:
      break;
  }

  return json(request, { error: "Not found" }, 404);
}
