// ======================================================
// voiceSignaling.js — REST-Adapter + WS-Event-Router
//
// Phase 1:
//   - Outbound: Senden von ring/answer/ice/decline/cancel/hangup
//     an das Backend via apiFetch (→ Worker → pushToUserDO → Peer WS).
//   - Inbound:  voice:* Events werden von controlSocket.js über den
//     BroadcastChannel als { type: "VOICE_EVENT", payload: ... }
//     weitergegeben. Hier re-dispatchen wir sie als CustomEvents
//     auf dem exportierten voiceBus (EventTarget).
//
// Phase 2 wird hier nur den TURN-Credential-Fetch erweitern und
// SDP/ICE-Payloads bleiben unverändert.
// ======================================================
import { apiFetch } from "../api.js";

// ── Inbound-Event-Bus ────────────────────────────────────
// voiceUI.js hängt sich an: voiceBus.addEventListener("voice:ring", …)
export const voiceBus = new EventTarget();

// BroadcastChannel-Token-Guard (gleiche Logik wie controlSocket.js)
const BC_TOKEN_KEY = "renex_bc_token";
function getBcToken() {
  return sessionStorage.getItem(BC_TOKEN_KEY) || null;
}

// Ein einzelner Listener pro Tab — mehrfach-Init verhindern
let _inboundBound = false;

// Event-ID-Dedup auf BroadcastChannel-Ebene.
// Hintergrund: Jede WS-Verbindung des Users (parent-Tab, iframe, zusätzlicher
// Tab, PWA-Window …) empfängt dasselbe voice:*-Event und postet es über BC.
// Ohne Dedup würde z.B. "voice:answer" mehrfach verarbeitet → WebRTC wirft
// "Called in wrong state: stable".
const _seenEventIds = new Map();   // id → timestamp
const SEEN_MAX_AGE_MS = 60 * 1000;
const SEEN_MAX_SIZE   = 500;
function markEventSeen(id) {
  const now = Date.now();
  if (_seenEventIds.size >= SEEN_MAX_SIZE) {
    // älteste Einträge droppen
    const cutoff = now - SEEN_MAX_AGE_MS;
    for (const [k, t] of _seenEventIds) {
      if (t < cutoff) _seenEventIds.delete(k);
    }
    if (_seenEventIds.size >= SEEN_MAX_SIZE) {
      _seenEventIds.delete(_seenEventIds.keys().next().value);
    }
  }
  _seenEventIds.set(id, now);
}

export function initVoiceSignalingInbound() {
  if (_inboundBound) return;
  _inboundBound = true;

  if ("BroadcastChannel" in window) {
    const bc = new BroadcastChannel("renex-control");
    bc.addEventListener("message", (ev) => {
      const m = ev.data;
      if (!m || m.type !== "VOICE_EVENT") return;
      // Cross-Tab-Injection-Schutz: Token muss zum eigenen Tab passen
      if (m._bcToken && m._bcToken !== getBcToken()) return;
      dispatchInbound(m.payload);
    });
  } else {
    // Fallback: localStorage-Bridge (alt, selten genutzt)
    window.addEventListener("storage", (ev) => {
      if (ev.key !== "renex-control-event" || !ev.newValue) return;
      try {
        const m = JSON.parse(ev.newValue);
        if (m?.type === "VOICE_EVENT") dispatchInbound(m.payload);
      } catch {}
    });
  }
}

function dispatchInbound(payload) {
  if (!payload || typeof payload.type !== "string") return;
  // Dedup: wenn dieselbe Event-ID bereits verarbeitet wurde → droppen
  if (payload.id && _seenEventIds.has(payload.id)) return;
  if (payload.id) markEventSeen(payload.id);
  // payload.type ist z.B. "voice:ring", "voice:answer", "voice:ice", …
  voiceBus.dispatchEvent(new CustomEvent(payload.type, { detail: payload }));
}

// ── Outbound helpers ─────────────────────────────────────
async function post(path, body) {
  return apiFetch(path, {
    method: "POST",
    body: JSON.stringify(body || {}),
  });
}

export function sendRing({ to, callId, sdp }) {
  return post("/voice/ring", { to, callId, sdp });
}
export function sendAnswer({ callId, sdp }) {
  return post("/voice/answer", { callId, sdp });
}
export function sendIce({ to, callId, candidate }) {
  return post("/voice/ice", { to, callId, candidate });
}
export function sendDecline({ callId }) {
  return post("/voice/decline", { callId });
}
export function sendCancel({ to, callId }) {
  return post("/voice/cancel", { to, callId });
}
export function sendHangup({ to, callId }) {
  return post("/voice/hangup", { to, callId });
}

// ── ICE-Server-Config (Phase 1: nur STUN) ────────────────
export async function fetchIceServers() {
  try {
    const r = await apiFetch("/voice/turn-credentials");
    if (Array.isArray(r?.iceServers)) return r.iceServers;
  } catch {}
  return [{ urls: "stun:stun.cloudflare.com:3478" }];
}

// ── Call-History ─────────────────────────────────────────
export async function fetchHistory(limit = 50) {
  try {
    const r = await apiFetch(`/voice/history?limit=${encodeURIComponent(limit)}`);
    if (Array.isArray(r?.calls)) return r.calls;
    console.warn("[voice] history response unexpected:", r);
    return [];
  } catch (e) {
    console.warn("[voice] history fetch failed:", e?.message || e);
    return [];
  }
}

// ── UUID für callId ──────────────────────────────────────
export function newCallId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  // Fallback für ältere Browser
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
