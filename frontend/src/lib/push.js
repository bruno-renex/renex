// ======================================================
// Push-Notification Lib — Service Worker + Web Push
// ======================================================
// Mirror der existierenden /renex/js/pushManager.js Logik.
// Funktioniert auf:
//   - Desktop: Chrome, Firefox, Edge, Safari
//   - Mobile: Android Chrome, iOS PWA (16.4+, installiert)
//
// Wichtig (iOS PWA): requestPermission() MUSS synchron nach User-Gesture
// aufgerufen werden — vor jeglichem await auf andere Promises.
// ======================================================

import { API, apiFetch } from './api.js';
import { captureException } from './sentry.js';

const VAPID_PUBLIC_KEY_STORAGE = "renex_vapid_pub";
let _swRegistration = null;

// ── Service Worker Registration ─────────────────────────
export async function initServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return null;
  }
  try {
    _swRegistration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    if (_swRegistration.installing) {
      await new Promise((resolve) => {
        _swRegistration.installing.addEventListener("statechange", (e) => {
          if (e.target.state === "activated") resolve();
        });
      });
    }
    return _swRegistration;
  } catch (e) {
    captureException(e, { context: "initServiceWorker" });
    return null;
  }
}

// ── Status ──────────────────────────────────────────────
export async function getPushStatus() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { supported: false, permission: "unavailable", subscribed: false };
  }
  const permission = Notification.permission;
  let subscribed = false;
  if (_swRegistration) {
    const sub = await _swRegistration.pushManager.getSubscription();
    subscribed = !!sub;
  }
  return { supported: true, permission, subscribed };
}

// ── Subscribe ───────────────────────────────────────────
export async function subscribeToPush() {
  if (!_swRegistration) {
    _swRegistration = await initServiceWorker();
  }
  if (!_swRegistration) return null;

  const existing = await _swRegistration.pushManager.getSubscription();
  if (existing) {
    await _syncSubscription(existing);
    return existing;
  }

  if (Notification.permission !== "granted") {
    return null;
  }

  const vapidKey = await _getVapidPublicKey();
  const applicationServerKey = _urlBase64ToUint8Array(vapidKey);

  const subscription = await _swRegistration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });

  await _syncSubscription(subscription);
  return subscription;
}

// ── Permission-Request ──────────────────────────────────
// MUSS synchron nach Click aufgerufen werden (iOS-Anforderung).
export async function requestPermissionAndSubscribe() {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    return { granted: false };
  }
  await initServiceWorker();
  await subscribeToPush();
  return { granted: true };
}

// ── Helpers ─────────────────────────────────────────────
async function _getVapidPublicKey() {
  const cached = localStorage.getItem(VAPID_PUBLIC_KEY_STORAGE);
  if (cached) return cached;
  const r = await fetch(`${API}/push/vapid-key`);
  const d = await r.json();
  if (d.publicKey) {
    localStorage.setItem(VAPID_PUBLIC_KEY_STORAGE, d.publicKey);
    return d.publicKey;
  }
  throw new Error("VAPID public key fetch failed");
}

async function _syncSubscription(subscription) {
  const subJson = subscription.toJSON();
  await apiFetch("/push/subscribe", {
    method: "POST",
    body: {
      endpoint: subJson.endpoint,
      keys: subJson.keys,
      transport_type: "web_push",
    },
  });
}

function _urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// ── PWA-Install Detection ──────────────────────────────
export function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches
    || window.navigator.standalone === true;
}
