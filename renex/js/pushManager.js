// ======================================================
// RENEX Push Manager — Frontend Push-Subscribe + Badge
// Abstraktion: transport_type Feld ermöglicht spätere
// Erweiterung (UnifiedPush, native App Push, etc.)
// ======================================================

import { apiFetch } from "./api.js";

const VAPID_PUBLIC_KEY_STORAGE = "renex_vapid_pub";
let swRegistration = null;

// ── SERVICE WORKER REGISTRATION ─────────────────────────
export async function initServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    console.warn("Push: Service Worker not supported");
    return null;
  }

  try {
    swRegistration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    console.log("SW registered:", swRegistration.scope);

    // Warten bis SW aktiv ist
    if (swRegistration.installing) {
      await new Promise((resolve) => {
        swRegistration.installing.addEventListener("statechange", (e) => {
          if (e.target.state === "activated") resolve();
        });
      });
    }

    return swRegistration;
  } catch (err) {
    console.error("SW registration failed:", err);
    return null;
  }
}

// ── VAPID PUBLIC KEY vom Server holen ───────────────────
async function getVapidPublicKey() {
  // Cache im localStorage
  const cached = localStorage.getItem(VAPID_PUBLIC_KEY_STORAGE);
  if (cached) return cached;

  const res = await apiFetch("/push/vapid-key");
  const data = await res.json();
  if (data.publicKey) {
    localStorage.setItem(VAPID_PUBLIC_KEY_STORAGE, data.publicKey);
    return data.publicKey;
  }
  throw new Error("Could not fetch VAPID public key");
}

// ── PUSH PERMISSION + SUBSCRIBE ─────────────────────────
export async function subscribeToPush() {
  if (!swRegistration) {
    swRegistration = await initServiceWorker();
  }
  if (!swRegistration) return null;

  // Bereits subscribed?
  const existing = await swRegistration.pushManager.getSubscription();
  if (existing) {
    // Server-Sync sicherstellen
    await syncSubscription(existing);
    return existing;
  }

  // Permission prüfen (NICHT requestPermission — das muss aus User-Gesture kommen!)
  // Wenn Permission noch nicht granted → null zurückgeben (Banner kümmert sich)
  if (Notification.permission !== "granted") {
    console.warn("Push: Permission not granted yet, skipping subscribe");
    return null;
  }

  // VAPID Key
  const vapidKey = await getVapidPublicKey();
  const applicationServerKey = urlBase64ToUint8Array(vapidKey);

  // Subscribe
  const subscription = await swRegistration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });

  // An Backend senden
  await syncSubscription(subscription);

  return subscription;
}

// ── PUSH SUBSCRIPTION AN BACKEND SENDEN ─────────────────
async function syncSubscription(subscription) {
  const subJson = subscription.toJSON();
  await apiFetch("/push/subscribe", {
    method: "POST",
    body: JSON.stringify({
      endpoint: subJson.endpoint,
      keys: subJson.keys,
      transport_type: "web_push",
    }),
  });
}

// ── UNSUBSCRIBE ─────────────────────────────────────────
export async function unsubscribeFromPush() {
  if (!swRegistration) return;
  const sub = await swRegistration.pushManager.getSubscription();
  if (sub) {
    // Backend informieren
    await apiFetch("/push/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    await sub.unsubscribe();
  }
}

// ── PUSH STATUS PRÜFEN ─────────────────────────────────
export async function getPushStatus() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { supported: false, permission: "unavailable", subscribed: false };
  }

  const permission = Notification.permission;
  let subscribed = false;

  if (swRegistration) {
    const sub = await swRegistration.pushManager.getSubscription();
    subscribed = !!sub;
  }

  return { supported: true, permission, subscribed };
}

// ── BADGE COUNT UPDATE ──────────────────────────────────
export function updateBadge(count) {
  // Via Service Worker
  if (swRegistration?.active) {
    swRegistration.active.postMessage({ type: "SET_BADGE", count });
  }

  // Direct API (Chromium 81+)
  if (count > 0 && navigator.setAppBadge) {
    navigator.setAppBadge(count).catch(() => {});
  } else if (navigator.clearAppBadge) {
    navigator.clearAppBadge().catch(() => {});
  }
}

// ── PWA INSTALL PROMPT ──────────────────────────────────
let deferredPrompt = null;

export function initInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    // Event dispatchen damit UI den Install-Button zeigen kann
    window.dispatchEvent(new CustomEvent("renex-install-available"));
  });
}

export async function triggerInstall() {
  if (!deferredPrompt) return false;
  deferredPrompt.prompt();
  const result = await deferredPrompt.userChoice;
  deferredPrompt = null;
  return result.outcome === "accepted";
}

export function isInstallable() {
  return deferredPrompt !== null;
}

// Erkennung: Läuft als installierte PWA?
export function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches
    || window.navigator.standalone === true;
}

// ── HELPER ──────────────────────────────────────────────
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}
