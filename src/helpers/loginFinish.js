import { json, readJson, base64url, base64urlToString, base64urlToArrayBuffer, derToRawECDSA, corsHeaders } from '../utils.js';
import { rateLimit, registerSessionToken } from '../auth.js';
import { readCredentials } from './credentials.js';

// ======================================================
// AUTH / LOGIN / FINISH handler (extracted for line-count budget)
// Called from authRoutes.js
// ======================================================
const LOGIN_FAIL_LIMIT  = 5;               // Versuche bis Sperre
const LOGIN_LOCKOUT_MS  = 15 * 60 * 1000; // 15 Minuten Sperre
const LOGIN_FAIL_TTL_S  = 300;            // Zähler-TTL ohne Lockout: 5 min

export async function handleLoginFinish(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const ok = await rateLimit(env, `login_finish:${ip}`, 60_000, 20, { strict: true });
  if (!ok) return json(request, { error: "Too many requests" }, 429);

  const body = await readJson(request);
  if (!body) return json(request, { error: "Invalid JSON" }, 400);

  const handle = (body.handle || "").toLowerCase();

  if (!/^[a-z0-9_]+$/.test(handle)) {
    return json(request, { error: "Invalid handle" }, 400);
  }

  // Pro-Handle-Deckel (IP-unabhängig) gegen verteilte Brute-Force über rotierende
  // IPs — komplementär zum IP-Limit oben + dem login_fail-Lockout. Review #7.
  const okHandle = await rateLimit(env, `login_finish_handle:${handle}`, 60_000, 20, { strict: true });
  if (!okHandle) return json(request, { error: "Too many requests" }, 429);

  // Handle-Lockout prüfen (verhindert Brute-Force von verschiedenen IPs)
  const failKey = `login_fail:${handle}`;
  const failRaw = await env.RENEX_KV.get(failKey);
  if (failRaw) {
    try {
      const failData = JSON.parse(failRaw);
      if (failData.until && Date.now() < failData.until) {
        const remainingSec = Math.ceil((failData.until - Date.now()) / 1000);
        return json(request, { error: "Account temporarily locked", retryAfterSec: remainingSec }, 429);
      }
    } catch {}
  }

  // Challenge laden
  const chRaw = await env.RENEX_KV.get(`challenge:login:${handle}`);
  if (!chRaw) {
    return json(request, { error: "Login challenge expired" }, 400);
  }

  let challengeObj;
  try {
    challengeObj = JSON.parse(chRaw);
  } catch {
    return json(request, { error: "Invalid login challenge" }, 400);
  }

  // Age-Check
  if (!challengeObj.ts || Date.now() - challengeObj.ts > 5 * 60 * 1000) {
    await env.RENEX_KV.delete(`challenge:login:${handle}`);
    return json(request, { error: "Login challenge expired" }, 400);
  }

  // Fake-Challenge: User existierte nicht — generisch ablehnen ohne Info zu leaken
  if (challengeObj.fake === true) {
    await env.RENEX_KV.delete(`challenge:login:${handle}`);
    return json(request, { error: "Authentication failed" }, 401);
  }

  // clientDataJSON
  if (!body.response?.clientDataJSON) {
    return json(request, { error: "Missing clientDataJSON" }, 400);
  }

  let clientData;
  try {
    clientData = JSON.parse(base64urlToString(body.response.clientDataJSON));
  } catch {
    return json(request, { error: "Invalid clientDataJSON" }, 400);
  }

  if (clientData.type !== "webauthn.get") {
    return json(request, { error: "Invalid WebAuthn type" }, 400);
  }

  if (!["https://renex.id", "https://app.renex.id"].includes(clientData.origin)) {
    await env.RENEX_KV.delete(`challenge:login:${handle}`);
    return json(request, { error: "Invalid origin" }, 400);
  }

  if (clientData.challenge !== challengeObj.challenge) {
    return json(request, { error: "Challenge mismatch" }, 400);
  }

  // Credential im Array finden (Multi-Passkey)
  const credentials = await readCredentials(env, handle);
  if (!credentials || credentials.length === 0) {
    return json(request, { error: "Authentication failed" }, 401);
  }

  const matchedCred = credentials.find(c => c.credential_id === body.id);
  if (!matchedCred) {
    await env.RENEX_KV.delete(`challenge:login:${handle}`);
    return json(request, { error: "Credential mismatch" }, 400);
  }

  // authenticatorData
  if (!body.response?.authenticatorData) {
    return json(request, { error: "Missing authenticatorData" }, 400);
  }

  let authData;
  try {
    const bin = base64urlToString(body.response.authenticatorData);
    authData = Uint8Array.from(bin, c => c.charCodeAt(0));
  } catch {
    return json(request, { error: "Invalid authenticatorData" }, 400);
  }

  if (authData.length < 37) {
    return json(request, { error: "Invalid authenticatorData length" }, 400);
  }

  // RP ID Hash
  const rpIdHash = authData.slice(0, 32);
  const expectedHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode("renex.id"))
  );

  for (let i = 0; i < 32; i++) {
    if (rpIdHash[i] !== expectedHash[i]) {
      return json(request, { error: "Invalid rpIdHash" }, 400);
    }
  }

  // FLAGS
  const flags = authData[32];
  if (!(flags & 0x01)) return json(request, { error: "User presence required" }, 400);
  if (!(flags & 0x04)) return json(request, { error: "User verification required" }, 400);

  // signCount
  const newSignCount =
    (authData[33] << 24) |
    (authData[34] << 16) |
    (authData[35] << 8)  |
    authData[36];

  // Per-Credential signCount prüfen (Replay-Schutz)
  const storedSignCount = Number(matchedCred.signCount || 0);

  if (storedSignCount > 0 && newSignCount <= storedSignCount) {
    return json(request, { error: "Replay detected" }, 403);
  }

  // Kryptographische Signatur prüfen
  const storedPublicKeyJwk = matchedCred.publicKeyJwk;
  if (!storedPublicKeyJwk) {
    return json(request, { error: "Passkey re-registration required" }, 403);
  }

  if (!body.response?.signature) {
    return json(request, { error: "Missing signature" }, 400);
  }

  let publicKey;
  try {
    if (storedPublicKeyJwk.kty === "EC") {
      publicKey = await crypto.subtle.importKey(
        "jwk",
        { ...storedPublicKeyJwk, key_ops: ["verify"] },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"]
      );
    } else if (storedPublicKeyJwk.kty === "RSA") {
      publicKey = await crypto.subtle.importKey(
        "jwk",
        { ...storedPublicKeyJwk, key_ops: ["verify"] },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]
      );
    } else {
      return json(request, { error: "Unsupported key type" }, 403);
    }
  } catch {
    return json(request, { error: "Public key import failed" }, 500);
  }

  // verifyData = authData || SHA-256(clientDataJSON)
  const clientDataJSONBytes = new Uint8Array(base64urlToArrayBuffer(body.response.clientDataJSON));
  const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSONBytes));
  const verifyData = new Uint8Array(authData.length + clientDataHash.length);
  verifyData.set(authData, 0);
  verifyData.set(clientDataHash, authData.length);

  const sigBytes = new Uint8Array(base64urlToArrayBuffer(body.response.signature));

  let signatureValid = false;
  try {
    if (storedPublicKeyJwk.kty === "EC") {
      const rawSig = derToRawECDSA(sigBytes);
      signatureValid = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey, rawSig, verifyData
      );
    } else {
      signatureValid = await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        publicKey, sigBytes, verifyData
      );
    }
  } catch {
    signatureValid = false;
  }

  if (!signatureValid) {
    // Fehlversuch zählen → bei LOGIN_FAIL_LIMIT Sperre aktivieren
    try {
      const raw2 = await env.RENEX_KV.get(failKey);
      const prev = raw2 ? JSON.parse(raw2) : { count: 0 };
      const newCount = (prev.count || 0) + 1;
      const locked   = newCount >= LOGIN_FAIL_LIMIT;
      await env.RENEX_KV.put(
        failKey,
        JSON.stringify({ count: newCount, until: locked ? Date.now() + LOGIN_LOCKOUT_MS : null }),
        { expirationTtl: locked ? Math.ceil(LOGIN_LOCKOUT_MS / 1000) : LOGIN_FAIL_TTL_S }
      );
    } catch {}
    return json(request, { error: "Authentication failed" }, 401);
  }

  // Challenge + Fail-Counter löschen (erfolgreicher Login)
  await env.RENEX_KV.delete(`challenge:login:${handle}`);
  await env.RENEX_KV.delete(failKey).catch(() => {});

  // signCount + last_used pro Credential persistieren
  matchedCred.signCount = newSignCount;
  matchedCred.last_used = Date.now();
  await env.RENEX_KV.put(
    `webauthn:${handle}`,
    JSON.stringify({ credentials })
  );

  // Session
  const sessionToken = "sess_" + crypto.randomUUID();
  const uaHash = base64url(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(request.headers.get("User-Agent") || "")
    )
  );

  const now = Date.now();
  await env.RENEX_KV.put(
    `session:${sessionToken}`,
    JSON.stringify({
      handle,
      createdAt: now,
      lastRefreshed: now,           // Sliding-TTL Anker (M4)
      exp: now + 2_592_000_000,     // 30d in ms (initial; KV TTL refresht später)
      ua: uaHash || null
    }),
    { expirationTtl: 2_592_000 }    // 30d in Sekunden (KV TTL — sliding, = Cookie)
  );

  // Session-Index aktualisieren (für spätere Revocation)
  await registerSessionToken(env, handle, sessionToken);

  // Cookie Max-Age = 30 Tage, KV-TTL ebenfalls 30 Tage (konsistent). KV ist
  // Source-of-Truth: bei 30d Inaktivität expirt KV → requireSession returnt
  // null → 401 → Re-Login. Aktive User bekommen sliding-Refresh in requireSession.
  const sessionCookie = `session=${sessionToken}; HttpOnly; Secure; SameSite=Strict; Domain=renex.id; Path=/; Max-Age=2592000`;
  return new Response(JSON.stringify({ authenticated: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": sessionCookie,
      ...corsHeaders(request),
    },
  });
}
