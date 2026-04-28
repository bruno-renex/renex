// ======================================================
// WebSocket Service — Real-time Messaging
// ======================================================
// Wraps WebSocket connection to /chat/ws.
// Features:
//   - Auto-reconnect mit exponential backoff
//   - Heartbeat (ping/pong)
//   - Auto-Ticket-Refresh (POST /auth/ws-ticket)
//   - Event-System für Subscriber
//
// Phase 1A.6.5 Skeleton — Real WS connection working.
// E2E-Decrypt der empfangenen Messages folgt Phase 1B.
// ======================================================

import { API, apiFetch } from './api.js';
import { captureException } from './sentry.js';

let _ws = null;
let _isConnected = false;
let _reconnectTimer = null;
let _reconnectDelay = 1000; // exponential backoff start
let _pingTimer = null;
let _pongTimeoutTimer = null;
let _running = false;

// Event-Listeners
const _listeners = new Map(); // event-name → Set<callback>

function _emit(event, payload) {
  const set = _listeners.get(event);
  if (!set) return;
  for (const cb of set) {
    try { cb(payload); }
    catch (e) { captureException(e, { context: "ws-listener:" + event }); }
  }
}

export const ws = {
  on(event, callback) {
    if (!_listeners.has(event)) _listeners.set(event, new Set());
    _listeners.get(event).add(callback);
    // Return unsubscribe-fn
    return () => _listeners.get(event)?.delete(callback);
  },

  off(event, callback) {
    _listeners.get(event)?.delete(callback);
  },

  get isConnected() { return _isConnected; },

  /**
   * Connect / start the WS lifecycle.
   * Idempotent — multiple calls harmless.
   */
  async start() {
    if (_running) return;
    _running = true;
    await _connect();
  },

  stop() {
    _running = false;
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
    if (_pongTimeoutTimer) { clearTimeout(_pongTimeoutTimer); _pongTimeoutTimer = null; }
    if (_ws) {
      try { _ws.close(); } catch {}
      _ws = null;
    }
    _isConnected = false;
  },

  send(obj) {
    if (!_ws || _ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      _ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      captureException(e, { context: "ws-send" });
      return false;
    }
  },
};

async function _connect() {
  if (!_running) return;

  // 1) Get ws-ticket
  let wsUrl = `wss://api.renex.id/chat/ws`;
  try {
    const r = await apiFetch("/auth/ws-ticket", { method: "POST" });
    if (r.ok && r.data?.ticket) {
      wsUrl = `wss://api.renex.id/chat/ws?ticket=${encodeURIComponent(r.data.ticket)}`;
    }
  } catch (e) {
    captureException(e, { context: "ws-ticket" });
  }

  // 2) Open
  try {
    _ws = new WebSocket(wsUrl);
  } catch (e) {
    captureException(e, { context: "ws-init" });
    _scheduleReconnect();
    return;
  }

  _ws.onopen = () => {
    _isConnected = true;
    _reconnectDelay = 1000; // reset backoff
    _emit("open", null);
    _startHeartbeat();
  };

  _ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); }
    catch { return; }

    // Pong → reset pong-timeout
    if (msg.type === "pong") {
      if (_pongTimeoutTimer) { clearTimeout(_pongTimeoutTimer); _pongTimeoutTimer = null; }
      return;
    }

    // Generic event emit
    _emit("message", msg);
    if (msg.type) _emit(msg.type, msg);
  };

  _ws.onclose = (event) => {
    _isConnected = false;
    _stopHeartbeat();
    _emit("close", { code: event.code });
    if (_running) _scheduleReconnect();
  };

  _ws.onerror = () => {
    _emit("error", null);
    // close-handler will trigger reconnect
  };
}

function _scheduleReconnect() {
  if (!_running) return;
  if (_reconnectTimer) return;
  const delay = Math.min(_reconnectDelay, 30_000);
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    _reconnectDelay = Math.min(_reconnectDelay * 2, 30_000);
    _connect();
  }, delay);
}

function _startHeartbeat() {
  if (_pingTimer) clearInterval(_pingTimer);
  _pingTimer = setInterval(() => {
    if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
    try {
      _ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      // Pong-Timeout (10s) — wenn kein Pong kommt: Reconnect
      if (_pongTimeoutTimer) clearTimeout(_pongTimeoutTimer);
      _pongTimeoutTimer = setTimeout(() => {
        if (_ws) {
          try { _ws.close(); } catch {}
        }
      }, 10_000);
    } catch {}
  }, 25_000); // every 25s
}

function _stopHeartbeat() {
  if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
  if (_pongTimeoutTimer) { clearTimeout(_pongTimeoutTimer); _pongTimeoutTimer = null; }
}
