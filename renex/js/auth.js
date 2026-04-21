import {
  initE2EKeys,
  uploadInboxKeyIfNeeded,
  getDeviceId          // ⬅️ HIER
} from "./e2e.js";
import { initServiceWorker, subscribeToPush } from "./pushManager.js";
import { clearGuestSession } from "./shared/guestStorage.js";

// ================================
// API BASE URL
// ================================
const API = "https://api.renex.id";

// ================================
// TERMS VERSION
// Muss synchron mit AGB/Datenschutz-Gültigkeitsdatum sein.
// ================================
const TERMS_VERSION = "2026-04-15";

// ================================
// BASE64URL HELPERS (KORREKT)
// ================================
function base64urlToUint8Array(base64url) {
  let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  if (pad) base64 += "=".repeat(4 - pad);
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}
function base64urlToArrayBuffer(b64url) {
  return base64urlToUint8Array(b64url).buffer;
}
function arrayBufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ================================
// REGISTER
// ================================
export async function registerWithPasskey(handle) {
  handle = handle.toLowerCase();
  console.log("📝 Register START:", handle);

  const startRes = await fetch(`${API}/auth/register/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle })
  });

  const startData = await startRes.json();
  console.log("📦 register/start:", startData);

  if (!startData.publicKey) {
    alert("❌ Register start fehlgeschlagen");
    return;
  }

    const publicKey = {
  ...startData.publicKey,

  challenge: base64urlToUint8Array(startData.publicKey.challenge),

  user: {
    ...startData.publicKey.user,
    id: base64urlToUint8Array(startData.publicKey.user.id),
  },

  // 🔑 WICHTIG FÜR CHROME / BRAVE
  pubKeyCredParams: startData.publicKey.pubKeyCredParams,

  authenticatorSelection: {
  authenticatorAttachment: "platform",
  userVerification: "required",
  residentKey: "required",
  },

  timeout: startData.publicKey.timeout ?? 60000,
  attestation: startData.publicKey.attestation ?? "none",
};
  console.log("🔐 pubKeyCredParams:", publicKey.pubKeyCredParams);
  console.log("🔐 publicKey (register):", publicKey);

  let credential;
try {
  credential = await navigator.credentials.create({ publicKey });
  console.log("✅ Credential erstellt:", credential);
} catch (err) {
  console.error("❌ Passkey-Erstellung abgebrochen:", err);

  alert(
    "Passkey konnte nicht erstellt werden.\n\n" +
    err.name + "\n" +
    (err.message || "")
  );

  return; // WICHTIG: hier abbrechen, kein /finish call
}

await fetch(`${API}/auth/register/finish`, {
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    handle,
    id: credential.id,
    rawId: arrayBufferToBase64url(credential.rawId),
    type: credential.type,
    termsVersion: TERMS_VERSION,
    response: {
      attestationObject: arrayBufferToBase64url(
        credential.response.attestationObject
      ),
      clientDataJSON: arrayBufferToBase64url(
        credential.response.clientDataJSON
      )
    }
  })
});

  alert("✅ Passkey registriert");
}

// ================================
// ADD PASSKEY (für eingeloggte User)
// ================================
export async function addPasskey(handle, name) {
  handle = handle.toLowerCase();

  const startRes = await fetch(`${API}/auth/register/start`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle })
  });

  const startData = await startRes.json();
  if (!startRes.ok || !startData.publicKey) {
    throw new Error(startData.error || "Register start failed");
  }

  const publicKey = {
    ...startData.publicKey,
    challenge: base64urlToUint8Array(startData.publicKey.challenge),
    user: {
      ...startData.publicKey.user,
      id: base64urlToUint8Array(startData.publicKey.user.id),
    },
    pubKeyCredParams: startData.publicKey.pubKeyCredParams,
    authenticatorSelection: {
      // KEIN authenticatorAttachment → erlaubt Platform, Cross-Device (QR), Security Keys
      userVerification: "required",
      residentKey: "preferred",
    },
    // excludeCredentials vom Backend konvertieren
    excludeCredentials: (startData.publicKey.excludeCredentials || []).map(c => ({
      ...c,
      id: base64urlToUint8Array(c.id),
    })),
    timeout: 60000,
    attestation: "none",
  };

  const credential = await navigator.credentials.create({ publicKey });

  const finishRes = await fetch(`${API}/auth/register/finish`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      handle,
      id: credential.id,
      rawId: arrayBufferToBase64url(credential.rawId),
      type: credential.type,
      name: name || null,
      response: {
        attestationObject: arrayBufferToBase64url(credential.response.attestationObject),
        clientDataJSON: arrayBufferToBase64url(credential.response.clientDataJSON)
      }
    })
  });

  if (!finishRes.ok) {
    const err = await finishRes.json().catch(() => ({}));
    throw new Error(err.error || "Register finish failed");
  }
}

// ================================
// LOGIN
// ================================
export async function loginWithPasskey(handle) {
  handle = handle.toLowerCase();
console.log("🔐 Login START:", handle);

let startRes;
try {
  startRes = await fetch(`${API}/auth/login/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle })
  });
  console.log("✅ login/start response status:", startRes.status);
} catch (e) {
  console.error("❌ FETCH login/start failed:", e);
  alert("Netzwerkfehler bei login/start");
  return;
}

let startData;
try {
  startData = await startRes.json();
  console.log("📦 login/start:", startData);
} catch (e) {
  console.error("❌ JSON parse failed:", e);
  alert("Ungültige Antwort vom Server");
  return;
}

  // =========================
  // 🔁 FALL 1: KEIN PASSKEY → REGISTRIEREN
  // =========================
  if (!startData.publicKey || startData.registered === false) {
    console.log("🆕 Kein Passkey vorhanden → Registrierung");

    const regRes = await fetch(`${API}/auth/register/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle })
    });

    const regData = await regRes.json();
    console.log("📦 register/start:", regData);

    const publicKey = {
      ...regData.publicKey,

      challenge: base64urlToUint8Array(regData.publicKey.challenge),

      user: {
      ...regData.publicKey.user,
      id: base64urlToUint8Array(regData.publicKey.user.id),
      },

      // 🔑 aus REGISTER-Response
      pubKeyCredParams: regData.publicKey.pubKeyCredParams,

      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "required",
      },

      timeout: regData.publicKey.timeout ?? 60000,
      attestation: regData.publicKey.attestation ?? "none",
    };
  
    console.log("🔐 pubKeyCredParams:", publicKey.pubKeyCredParams);
    console.log("🔐 publicKey (register):", publicKey);

    let credential;
try {
  credential = await navigator.credentials.create({ publicKey });
  console.log("✅ Credential erstellt:", credential);
} catch (err) {
  console.error("❌ Passkey-Erstellung abgebrochen:", err);

  alert(
    "Passkey konnte nicht erstellt werden.\n\n" +
    err.name + "\n" +
    (err.message || "")
  );

  return; // WICHTIG: hier abbrechen, kein /finish call
}

    await fetch(`${API}/auth/register/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        handle,
        id: credential.id,
        rawId: arrayBufferToBase64url(credential.rawId),
        type: credential.type,
        termsVersion: TERMS_VERSION,
        response: {
          attestationObject: arrayBufferToBase64url(
            credential.response.attestationObject
          ),
          clientDataJSON: arrayBufferToBase64url(
            credential.response.clientDataJSON
          )
        }
      })
    });

console.log("✅ Registrierung abgeschlossen");

// optional kleine Info
// Kein alert, kein reload — direkt zur Login-Seite (kein Flash)
window.location.replace("/?registered=1");
return;
}

  // =========================
  // 🔐 FALL 2: LOGIN
  // =========================
  const publicKey = {
  ...startData.publicKey,

  challenge: base64urlToArrayBuffer(startData.publicKey.challenge),

  allowCredentials: startData.publicKey.allowCredentials.map(c => ({
    ...c,
    id: base64urlToUint8Array(c.id),
  })),

  userVerification: "required",
};
  console.log("allowCredentials.id instanceof ArrayBuffer?",
  publicKey.allowCredentials[0]?.id instanceof ArrayBuffer
  );


let assertion;

try {
  assertion = await navigator.credentials.get({ publicKey });

  console.log("✅ WebAuthn assertion:", assertion);
} catch (err) {
  console.error("❌ WebAuthn ERROR:", err);

  alert(
    "WebAuthn Fehler:\n\n" +
    err.name + "\n" +
    err.message
  );

  throw err; // wichtig: damit Login sauber abbricht
}

  const res = await fetch(`${API}/auth/login/finish`, {
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    handle,
    id: assertion.id,
    rawId: arrayBufferToBase64url(assertion.rawId),
    type: assertion.type,
    response: {
      authenticatorData: arrayBufferToBase64url(
        assertion.response.authenticatorData
      ),
      clientDataJSON: arrayBufferToBase64url(
        assertion.response.clientDataJSON
      ),
      signature: arrayBufferToBase64url(
        assertion.response.signature
      ),
      userHandle: assertion.response.userHandle
        ? arrayBufferToBase64url(assertion.response.userHandle)
        : null
    }
  })
});
  const data = await res.json();
  console.log("🔐 login/finish:", data);
  
if (data.authenticated) {
  localStorage.setItem("my_user", handle);
  // Alte Gast-Session komplett löschen (localStorage + sessionStorage + E2E-Keys) —
  // sonst wird requireAnySession fälschlicherweise die Gast-Session zurückgeben.
  clearGuestSession();

  // ✅ HIER IST SCHRITT 2: deviceId erzwingen (SOFORT nach erfolgreichem Login)
  getDeviceId();

  console.log("🔐 Login erfolgreich – starte globales E2E Init");

  try {
    if (!window.crypto?.subtle) {
      alert("Browser unterstützt keine sichere Kryptografie");
      return;
    }

    // 🔐 E2E Keypair lokal sicherstellen
    await initE2EKeys();

    // 📮 Inbox-Key GLOBAL sicherstellen
    await uploadInboxKeyIfNeeded();

    console.log("✅ Globales E2E Init + Inbox-Key OK");
  } catch (e) {
    console.error("❌ Globales E2E Init fehlgeschlagen", e);
    alert("Kryptografie konnte nicht initialisiert werden");
    return;
  }

  // 🔔 Push Notifications: SW registrieren + Permission fragen + Subscribe
  try {
    const reg = await initServiceWorker();
    if (reg) {
      // Permission fragen wenn noch nicht entschieden
      if (Notification.permission === "default") {
        const perm = await Notification.requestPermission();
        if (perm === "granted") {
          await subscribeToPush();
          console.log("🔔 Push nach Login aktiviert");
        }
      } else if (Notification.permission === "granted") {
        // Bereits erlaubt → nur Subscribe sicherstellen
        await subscribeToPush();
        console.log("🔔 Push-Subscription nach Login bestätigt");
      }
    }
  } catch (pushErr) {
    // Push-Fehler dürfen Login nicht blockieren
    console.warn("🔔 Push-Setup nach Login fehlgeschlagen (non-blocking):", pushErr.message);
  }

  // ── Invite-Link-Redirect (eingeloggter User kam über /join/?token=...) ─
  const _redirectUrl = sessionStorage.getItem("pendingInviteRedirect");
  if (_redirectUrl) {
    sessionStorage.removeItem("pendingInviteRedirect");
    window.location.replace(_redirectUrl);
    throw new Error("__redirect__"); // verhindert location.reload() im Caller
  }

  // ── Gast-Konvertierung (falls Gast vorher registriert hat) ────────────
  const _pendingConvert = sessionStorage.getItem("pendingGuestConvert");
  if (_pendingConvert) {
    try {
      const guestInfo = JSON.parse(_pendingConvert);
      sessionStorage.removeItem("pendingGuestConvert");
      // Gast-Session komplett aufräumen (localStorage + sessionStorage + Keys)
      clearGuestSession();

      // Nachrichten des Gastes auf echten Account übertragen
      const convertRes = await fetch(`${API}/invite/convert`, {
        method:      "POST",
        credentials: "include",
        headers:     { "Content-Type": "application/json" },
        body:        JSON.stringify({ guestToken: guestInfo.token }),
      });
      const convertData = await convertRes.json().catch(() => ({}));

      if (convertData.ok && convertData.convoId) {
        // Nach Konvertierung → direkt zum migrierten Chat
        const target = convertData.convoType === "group"
          ? convertData.convoId
          : convertData.inviterHandle || convertData.convoId;
        window.location.replace(`/chat/?with=${encodeURIComponent(target)}`);
      } else {
        window.location.replace("/");
      }
      return;
    } catch (e) {
      console.warn("⚠️ Gast-Konvertierung fehlgeschlagen:", e);
      // Fallthrough → normale Inbox-Weiterleitung
    }
  }
  // ➡️ Weiter zur Inbox
  window.location.replace("/");
}
}

export async function logout() {
  try {
    await fetch(`${API}/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" }
    });
  } catch {
    // egal – lokaler Logout reicht
  }

  localStorage.removeItem("my_user");
  sessionStorage.clear();

  console.log("🚪 Logout abgeschlossen (Keys behalten)");
  window.location.replace("/");
}