import { json, readJson, base64url, base64urlToString, base64urlToArrayBuffer, derToRawECDSA, corsHeaders } from '../utils.js';
import { rateLimit, registerSessionToken } from '../auth.js';

// ======================================================
// AUTH / LOGIN / FINISH handler (extracted for line-count budget)
// Called from authRoutes.js
// ======================================================
export async function handleLoginFinish(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const ok = await rateLimit(env, `login_finish:${ip}`, 60_000, 20);
  if (!ok) return json(request, { error: "Too many requests" }, 429);

  const body = await readJson(request);
  if (!body) return json(request, { error: "Invalid JSON" }, 400);

  const handle = (body.handle || "").toLowerCase();

  if (!/^[a-z0-9_]+$/.test(handle)) {
    return json(request, { error: "Invalid handle" }, 400);
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

  if (clientData.origin !== "https://app.renex.id") {
    await env.RENEX_KV.delete(`challenge:login:${handle}`);
    return json(request, { error: "Invalid origin" }, 400);
  }

  if (clientData.challenge !== challengeObj.challenge) {
    return json(request, { error: "Challenge mismatch" }, 400);
  }

  // Credential-ID MUSS passen
  if (body.id !== challengeObj.credential_id) {
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
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode("app.renex.id"))
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

  // Stored Credential
  const storedRaw = await env.RENEX_KV.get(`webauthn:${handle}`);
  if (!storedRaw) return json(request, { error: "Authentication failed" }, 401);

  const storedObj = JSON.parse(storedRaw);
  const storedSignCount = Number(storedObj.signCount || 0);

  if (storedSignCount > 0 && newSignCount <= storedSignCount) {
    return json(request, { error: "Replay detected" }, 403);
  }

  // Kryptographische Signatur prüfen
  const storedPublicKeyJwk = storedObj.publicKeyJwk;
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
    return json(request, { error: "Authentication failed" }, 401);
  }

  // Challenge löschen (JETZT!)
  await env.RENEX_KV.delete(`challenge:login:${handle}`);

  // signCount persistieren
  await env.RENEX_KV.put(
    `webauthn:${handle}`,
    JSON.stringify({ ...storedObj, signCount: newSignCount, updated_at: Date.now() })
  );

  // Session
  const sessionToken = "sess_" + crypto.randomUUID();
  const uaHash = base64url(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(request.headers.get("User-Agent") || "")
    )
  );

  await env.RENEX_KV.put(
    `session:${sessionToken}`,
    JSON.stringify({
      handle,
      created_at: Date.now(),
      exp: Date.now() + 86_400_000, // 24h in ms
      ua: uaHash || null
    }),
    { expirationTtl: 86_400 }       // 24h in Sekunden (KV TTL)
  );

  // Session-Index aktualisieren (für spätere Revocation)
  await registerSessionToken(env, handle, sessionToken);

  // Max-Age = 86400s = 24h (Cookie-Laufzeit = KV TTL)
  const sessionCookie = `session=${sessionToken}; HttpOnly; Secure; SameSite=Strict; Domain=renex.id; Path=/; Max-Age=86400`;
  return new Response(JSON.stringify({ authenticated: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": sessionCookie,
      ...corsHeaders(request),
    },
  });
}
