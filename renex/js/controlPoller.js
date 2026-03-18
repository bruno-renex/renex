// /js/controlPoller.js
import { apiFetch } from "./api.js";
import { getDeviceId, idbGet, dmSessionId } from "./e2e.js";
import { isAuthority, ensureBootstrapped, receiveCMK } from "./sessionManager.js";

const WS_URL = "wss://renex-backend.highway85.workers.dev/chat/ws";

let running = false;
let ws = null;
let reconnectTimer = null;
let backoff = 1000;
const MAX_BACKOFF = 30000;

// 🧠 Verhindert doppelte Verarbeitung von Control-Events
const processedControlIds = new Set();

const bc = ("BroadcastChannel" in window) ? new BroadcastChannel("renex-control") : null;

function notify(event) {
  if (bc) bc.postMessage(event);
  else localStorage.setItem("renex-control-event", JSON.stringify({ ...event, t: Date.now() }));
}

// 👉 holt peer devices jwk (für CMK decrypt)
async function findSenderDeviceJwk(from, fromDeviceId) {
  const devices = (await idbGet(`peer-devices:${from}`)) || [];
  const d = devices.find(x => x.deviceId === fromDeviceId);
  return d?.jwk || null;
}

// 👉 inbox keys fetch (wie bei dir)
async function fetchInboxKeys(peerHandle) {
  const res = await apiFetch(`/e2e/inbox/get?user=${peerHandle}`);

  console.log("📮 CONTROL inbox fetch result:", res);

  if (Array.isArray(res.devices)) return res.devices;
  if (Array.isArray(res.keys)) return res.keys; // 🔥 wichtig!

  return [];
}

async function processControlMessage(m) {
  console.log("📨 CONTROL MESSAGE RECEIVED:", m.type, m);
  const me = localStorage.getItem("my_user");
  if (!me) return;

  // 1) CMK_REQ: wenn ich Leader -> CMK senden
  if (m.type === "cmk_req") {
    const peer = m.from;
    if (!peer) return;
    
    console.log("⚖ CONTROL authority check:", {
  me,
  peer,
  authority: isAuthority(me, peer)
});

    if (!isAuthority(me, peer)) return;

// 🔥 Force Re-Bootstrap bei explizitem Request
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

// 3) DELIVERY EVENT
if (m.type === "delivered") {

  console.log("📬 CONTROL delivered event:", m);

  notify({
    type: "DELIVERED",
    from: m.from,
    sid: m.sid,
    ts: m.ts
  });

  return;
}

// 4) LIVE MESSAGE
if (!m.type && m.from) {

  console.log("💬 LIVE MESSAGE:", m);

  notify({
    type: "NEW_MESSAGE",
    message: m
  });

  return;
}
}

function connectWebSocket() {
  if (!running) return;

  const token = localStorage.getItem("session_token");
  const me = localStorage.getItem("my_user");
  if (!token || !me) return;

  console.log("🔌 WebSocket connecting...");
  ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    console.log("✅ WebSocket connected");
    backoff = 1000;
  };

  ws.onmessage = async (event) => {
    let m;
    try { m = JSON.parse(event.data); } catch { return; }

    // 🛡️ Doppel-Processing verhindern
    if (m?.id) {
      if (processedControlIds.has(m.id)) return;
      processedControlIds.add(m.id);
      if (processedControlIds.size > 1000) processedControlIds.clear();
    }

    console.log("📨 WS EVENT:", m.type, m);
    await processControlMessage(m);
  };

  ws.onclose = () => {
    ws = null;
    if (!running) return;
    console.warn(`🔄 WebSocket closed — reconnect in ${backoff}ms`);
    reconnectTimer = setTimeout(() => {
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
      connectWebSocket();
    }, backoff);
  };

  ws.onerror = (e) => {
    console.warn("⚠️ WebSocket error", e);
    ws?.close();
  };
}

export function startGlobalControlPolling() {
  console.log("🌍 GlobalControl WebSocket gestartet");
  if (running) return;
  running = true;
  connectWebSocket();
}

export function stopGlobalControlPolling() {
  running = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) { ws.close(); ws = null; }
}
