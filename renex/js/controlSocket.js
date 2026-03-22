// /js/controlSocket.js
// Ersetzt controlPoller.js — WebSocket statt Long-Polling
// Gleiche processControlMessage Logik, gleiche BroadcastChannel Nutzung.

import { apiFetch } from "./api.js";
import { getDeviceId, idbGet, dmSessionId } from "./e2e.js";
import { isAuthority, ensureBootstrapped, receiveCMK, handleEpochRotate, rotateCMK, receiveCMKRotation } from "./sessionManager.js";

// ── State ────────────────────────────────────────────────
let ws = null;
let running = false;
let reconnectTimer = null;
let backoff = 1000;
const MAX_BACKOFF = 30000;

// Verhindert doppelte Verarbeitung (gleich wie controlPoller.js)
const processedControlIds = new Set();

// ── BroadcastChannel (gleich wie controlPoller.js) ───────
const bc = ("BroadcastChannel" in window)
  ? new BroadcastChannel("renex-control")
  : null;

function notify(event) {
  if (bc) bc.postMessage(event);
  else localStorage.setItem("renex-control-event", JSON.stringify({ ...event, t: Date.now() }));
}

// ── Helpers (1:1 aus controlPoller.js) ───────────────────
async function findSenderDeviceJwk(from, fromDeviceId) {
  const devices = (await idbGet(`peer-devices:${from}`)) || [];
  const d = devices.find(x => x.deviceId === fromDeviceId);
  return d?.jwk || null;
}

async function fetchInboxKeys(peerHandle) {
  const res = await apiFetch(`/e2e/inbox/get?user=${peerHandle}`);
  console.log("📮 CONTROL inbox fetch result:", res);
  if (Array.isArray(res.devices)) return res.devices;
  if (Array.isArray(res.keys)) return res.keys;
  return [];
}

// ── Control Message Processing (1:1 aus controlPoller.js) ─
async function processControlMessage(m) {
  console.log("📨 WS MESSAGE RECEIVED:", m.type ?? "chat", m);
  const me = localStorage.getItem("my_user");
  if (!me) return;

  // 1) CMK_REQ: wenn ich Leader → CMK senden
  if (m.type === "cmk_req") {
    const peer = m.from;
    if (!peer) return;

    console.log("⚖ CONTROL authority check:", { me, peer, authority: isAuthority(me, peer) });

    if (!isAuthority(me, peer)) return;

    sessionStorage.removeItem(`bootstrapped:${dmSessionId(me, peer)}`);
    await ensureBootstrapped(me, peer, fetchInboxKeys, apiFetch);
    return;
  }

  // 2) CMK: importieren
  if (m.type === "cmk" && Array.isArray(m.payloads)) {
    const ok = await receiveCMK({
      from: m.from,
      myDeviceId: getDeviceId(),
      payloads: m.payloads,
      findSenderDeviceJwk
    });

    console.log("✅ receiveCMK result:", ok);

    if (ok) notify({ type: "CMK_READY", peer: m.from });
    return;
  }

  // 3) EPOCH ROTATE
  if (m.type === "epoch_rotate" && typeof m.rotationIndex === "number") {
    const ok = await handleEpochRotate(me, m.from, m.rotationIndex);
    if (ok) notify({ type: "EPOCH_ROTATED", peer: m.from, rotationIndex: m.rotationIndex });
    return;
  }

  // 4) CMK ROTATE: Non-Authority empfängt neuen CMK
  if (m.type === "cmk_rotate" && Array.isArray(m.payloads) && typeof m.fromRotationIndex === "number") {
    const ok = await receiveCMKRotation({
      me,
      from: m.from,
      myDeviceId: getDeviceId(),
      fromRotationIndex: m.fromRotationIndex,
      payloads: m.payloads
    });
    if (ok) notify({ type: "CMK_ROTATED", peer: m.from, fromRotationIndex: m.fromRotationIndex });
    return;
  }

  // 5) DEVICE ADDED: Authority soll CMK rotieren
  if (m.type === "device_added" && m.from) {
    if (isAuthority(me, m.from)) {
      console.log("🔑 Device hinzugefügt → CMK Rotation für:", m.from);
      notify({ type: "DEVICE_ADDED", peer: m.from });
    }
    return;
  }

  // 6) DELIVERY EVENT
  if (m.type === "delivered") {
    console.log("📬 CONTROL delivered event:", m);
    notify({ type: "DELIVERED", from: m.from, sid: m.sid, ts: m.ts });
    return;
  }

  // 4) LIVE MESSAGE
  if (!m.type && m.from) {
    console.log("💬 LIVE MESSAGE:", m);
    notify({ type: "NEW_MESSAGE", message: m });
    return;
  }
}

// ── WebSocket Verbindung ──────────────────────────────────
function connect() {
  if (!running) return;

  const token = localStorage.getItem("session_token");
  const me = localStorage.getItem("my_user");
  if (!token || !me) return;

  const wsUrl = `wss://api.renex.id/chat/ws?token=${encodeURIComponent(token)}`;

  console.log("🔌 Control WebSocket connecting...");

  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    console.warn("WebSocket init failed:", e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("🟢 Control WebSocket connected");
    backoff = 1000; // Reset bei Erfolg
  };

  ws.onmessage = async (event) => {
    try {
      const m = JSON.parse(event.data);

      // Doppel-Processing verhindern (gleich wie controlPoller.js)
      if (!m?.id) return;
      if (processedControlIds.has(m.id)) return;
      processedControlIds.add(m.id);

      // Memory-Schutz für lange Sessions
      if (processedControlIds.size > 1000) {
        processedControlIds.clear();
        console.log("🧹 processedControlIds zurückgesetzt");
      }

      await processControlMessage(m);
    } catch (e) {
      console.warn("⚠️ WS message error:", e);
    }
  };

  ws.onclose = (event) => {
    ws = null;
    console.log(`🔴 Control WebSocket closed (code: ${event.code})`);

    // 1001 = Going Away (Tab close), 1000 = Normal → kein Reconnect nötig
    if (!running || event.code === 1000) return;

    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose wird danach automatisch aufgerufen
    console.warn("⚠️ Control WebSocket error");
  };
}

function scheduleReconnect() {
  if (!running) return;
  console.log(`🔄 Reconnect in ${backoff}ms`);
  reconnectTimer = setTimeout(() => {
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
    connect();
  }, backoff);
}

// ── Public API (gleiche Namen wie controlPoller.js) ───────
export function startGlobalControlPolling() {
  if (running) return;
  running = true;
  console.log("🌍 GlobalControl WebSocket gestartet");
  connect();
}

export function stopGlobalControlPolling() {
  running = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) {
    ws.close(1000, "App stopped");
    ws = null;
  }
}
