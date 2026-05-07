// ======================================================
// voiceRooms.js — Phase 5: Mesh-basierte Group-Voice-Rooms
//
// Pro RENEX-Gruppe gibt es einen impliziten Voice-Room
// (roomId = conversation UUID). Join/Leave via REST, Presence
// via Heartbeat, Audio via Mesh-P2P (jede Verbindung ist eine
// normale VoiceCall-Instanz aus voiceClient.js).
//
// Max 4 Teilnehmer (Mesh-Limit). Bei >4 → SFU nötig (future).
//
// Signaling-Flow:
//   - Ich joine einen Room mit existierenden Members [A, B]
//     → erstelle PC zu A, PC zu B
//     → sende voice:room:offer an A und B via /voice/room/:id/signal
//   - A und B empfangen voice:room:offer (Event-Type "voice:room:offer")
//     → erstellen ihrerseits PC, beantworten mit voice:room:answer
//   - Trickle-ICE für beide Richtungen via voice:room:ice
//
// Wichtig: Wer joined, initiiert. Das vermeidet das klassische
// "both sides try to offer at once" Problem.
// ======================================================
import { apiFetch } from "../api.js";
import { voiceBus, fetchIceServers } from "./voiceSignaling.js";
import { VoiceCall, CallState } from "./voiceClient.js";

const HEARTBEAT_MS = 45_000;            // 45s heartbeat (Backend-TTL: 90s)
const MAX_HEARTBEAT_FAILS = 3;          // erst nach 3 Fehlern in Folge aussteigen

const _isTopWindow = (() => {
  try { return window.top === window.self; } catch { return false; }
})();

// ── Singleton-State ─────────────────────────────────────
let _inited = false;
let _room = null;   // { roomId, members: [{handle, joinedAt, lastSeen}], peers: Map<handle, VoiceCall> }
let _heartbeatTimer = null;
let _heartbeatFails = 0;
let _iceServersCache = null;

// ── Public event bus (damit UI sich dranhängen kann) ────
export const roomBus = new EventTarget();

async function getIceServers() {
  if (_iceServersCache && _iceServersCache.exp > Date.now()) return _iceServersCache.servers;
  const servers = await fetchIceServers();
  _iceServersCache = { servers, exp: Date.now() + 4 * 60 * 1000 };
  return servers;
}

// =========================================================
// REST helpers
// =========================================================
async function roomPost(roomId, action, body = null) {
  return apiFetch(`/voice/room/${encodeURIComponent(roomId)}/${action}`, {
    method: "POST",
    body: body ? JSON.stringify(body) : JSON.stringify({}),
  });
}
async function roomGet(roomId, action) {
  return apiFetch(`/voice/room/${encodeURIComponent(roomId)}/${action}`);
}

// =========================================================
// Join / Leave
// =========================================================
export async function joinRoom(roomId) {
  if (!_isTopWindow) {
    // Iframe → Parent delegieren
    try {
      window.top.postMessage(
        { type: "RENEX_VOICE_JOIN_ROOM", roomId: String(roomId || "").toLowerCase() },
        window.location.origin
      );
    } catch (e) {
      console.warn("[voiceRooms] postMessage to top failed:", e);
    }
    return;
  }

  if (_room && _room.roomId === roomId) return _room;
  if (_room && _room.roomId !== roomId) await leaveRoom().catch(() => {});

  const res = await roomPost(roomId, "join");
  if (!res || res.error) {
    console.warn("[voiceRooms] join failed:", res?.error);
    roomBus.dispatchEvent(new CustomEvent("room:error", { detail: { error: res?.error || "join failed" } }));
    return null;
  }

  _room = {
    roomId:  res.roomId,
    me:      res.me,
    members: res.members || [],
    peers:   new Map(),
    localStream: null,
    _muted: false,
    _pttEnabled: false,
  };

  // Mic schon mal öffnen (wir brauchen den Track für alle Peers)
  try {
    _room.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl:  false,
        channelCount:     1,
        sampleRate:       48000,
      },
      video: false,
    });
  } catch (e) {
    console.warn("[voiceRooms] getUserMedia denied:", e?.name);
    roomBus.dispatchEvent(new CustomEvent("room:mic-denied"));
    await roomPost(roomId, "leave").catch(() => {});
    _room = null;
    return null;
  }

  // Für alle existierenden Members (ausser mir) PC aufbauen und Offer senden
  const existing = _room.members.filter(x => x.handle !== _room.me);
  for (const mem of existing) {
    await ensurePeerAndOffer(mem.handle).catch(e =>
      console.warn("[voiceRooms] initial offer failed for", mem.handle, e?.message)
    );
  }

  // Heartbeat starten
  startHeartbeat();

  roomBus.dispatchEvent(new CustomEvent("room:joined", { detail: { ..._room, peers: undefined } }));
  return _room;
}

export async function leaveRoom() {
  if (!_room) return;
  const roomId = _room.roomId;

  // Alle Peers schliessen
  for (const [, call] of _room.peers) {
    try { call.destroy(); } catch {}
  }
  _room.peers.clear();

  // Mic-Stream schliessen
  if (_room.localStream) {
    for (const t of _room.localStream.getTracks()) {
      try { t.stop(); } catch {}
    }
  }

  stopHeartbeat();
  const wasRoom = _room;
  _room = null;

  await roomPost(roomId, "leave").catch(() => {});
  roomBus.dispatchEvent(new CustomEvent("room:left", { detail: { roomId: wasRoom.roomId } }));
}

export function getActiveRoom() {
  if (!_room) return null;
  return {
    roomId: _room.roomId,
    me: _room.me,
    members: _room.members.slice(),
    muted: _room._muted,
    pttEnabled: _room._pttEnabled,
  };
}

// =========================================================
// Heartbeat
// =========================================================
function startHeartbeat() {
  stopHeartbeat();
  _heartbeatFails = 0;
  _heartbeatTimer = setInterval(async () => {
    if (!_room) { stopHeartbeat(); return; }
    const res = await roomPost(_room.roomId, "heartbeat").catch(() => null);
    if (!res || res.error || res.rateLimited) {
      _heartbeatFails++;
      console.warn(`[voiceRooms] heartbeat failed (${_heartbeatFails}/${MAX_HEARTBEAT_FAILS})`,
                   res?.error || "network");
      if (_heartbeatFails >= MAX_HEARTBEAT_FAILS) {
        console.warn("[voiceRooms] too many heartbeat fails — leaving room");
        leaveRoom();
      }
      // Sonst: einfach weiter, nächster Versuch in 45s
    } else {
      _heartbeatFails = 0;   // Reset bei Erfolg
    }
  }, HEARTBEAT_MS);
}
function stopHeartbeat() {
  if (_heartbeatTimer) clearInterval(_heartbeatTimer);
  _heartbeatTimer = null;
  _heartbeatFails = 0;
}

// =========================================================
// Peer-Management (Mesh)
// =========================================================
async function makeCall(peerHandle) {
  const iceServers = await getIceServers().catch(() => undefined);
  const call = new VoiceCall({
    callId: `${_room.roomId}:${peerHandle}`,    // für Logging/Debug
    peer: peerHandle,
    direction: "outgoing",
    iceServers,
  });
  // ICE-Candidates → Signal an Peer
  call.addEventListener("icecandidate", (ev) => {
    sendSignal(peerHandle, "ice", { candidate: ev.detail }).catch(() => {});
  });
  // State-Events bubble-raus → UI kann sich ranhängen
  call.addEventListener("state", (ev) => {
    roomBus.dispatchEvent(new CustomEvent("room:peer-state", {
      detail: { peer: peerHandle, prev: ev.detail.prev, next: ev.detail.next },
    }));
  });
  return call;
}

async function ensurePeerAndOffer(peerHandle) {
  if (!_room) return;
  if (_room.peers.has(peerHandle)) return;        // schon da

  const call = await makeCall(peerHandle);
  _room.peers.set(peerHandle, call);

  // Lokalen Audio-Track anhängen (aus dem gemeinsamen localStream)
  call.localStream = _room.localStream;
  const pc = await call._ensurePC();
  for (const track of _room.localStream.getAudioTracks()) {
    pc.addTrack(track, _room.localStream);
  }
  // Mute/PTT-Zustand übernehmen
  applyMicGateToCall(call);

  // Offer erzeugen + via Signal verschicken
  const offer = await pc.createOffer({ offerToReceiveAudio: true });
  offer.sdp = call._munge(offer.sdp);
  await pc.setLocalDescription(offer);

  call.markConnecting();
  await sendSignal(peerHandle, "offer", { sdp: { type: offer.type, sdp: offer.sdp } });
}

async function ensurePeerForIncoming(peerHandle) {
  if (!_room) return null;
  if (_room.peers.has(peerHandle)) return _room.peers.get(peerHandle);
  const call = await makeCall(peerHandle);
  call.direction = "incoming";
  _room.peers.set(peerHandle, call);

  // Lokalen Audio-Track jetzt anhängen
  call.localStream = _room.localStream;
  const pc = await call._ensurePC();
  for (const track of _room.localStream.getAudioTracks()) {
    pc.addTrack(track, _room.localStream);
  }
  applyMicGateToCall(call);
  return call;
}

function removePeer(peerHandle) {
  if (!_room) return;
  const call = _room.peers.get(peerHandle);
  if (!call) return;
  try { call.destroy(); } catch {}
  _room.peers.delete(peerHandle);
}

// =========================================================
// Signaling (via /voice/room/:id/signal)
// =========================================================
async function sendSignal(to, kind, extra) {
  if (!_room) return;
  return apiFetch(`/voice/room/${encodeURIComponent(_room.roomId)}/signal`, {
    method: "POST",
    body: JSON.stringify({ to, kind, ...extra }),
  });
}

// =========================================================
// Event handlers (vom voiceBus, gespeist über controlSocket.js)
// =========================================================
async function onRoomMemberJoin(detail) {
  if (!_room || detail.roomId !== _room.roomId) return;
  const handle = String(detail.handle || "").toLowerCase();
  if (handle === _room.me) return;
  // Member-Liste aktualisieren
  if (!_room.members.find(x => x.handle === handle)) {
    _room.members.push({ handle, joinedAt: detail.joinedAt, lastSeen: Date.now() });
    roomBus.dispatchEvent(new CustomEvent("room:members", { detail: { members: _room.members.slice() } }));
  }
  // Der NEUE Member initiiert zu allen Existierenden. Wir sind ein
  // Existierender → warten auf Offer, nichts tun.
}

async function onRoomMemberLeave(detail) {
  if (!_room || detail.roomId !== _room.roomId) return;
  const handle = String(detail.handle || "").toLowerCase();
  _room.members = _room.members.filter(x => x.handle !== handle);
  removePeer(handle);
  roomBus.dispatchEvent(new CustomEvent("room:members", { detail: { members: _room.members.slice() } }));
}

async function onRoomOffer(detail) {
  if (!_room || detail.roomId !== _room.roomId) return;
  const from = String(detail.from || "").toLowerCase();
  if (!detail.sdp) return;
  const call = await ensurePeerForIncoming(from);
  if (!call) return;
  // Remote Offer setzen, Answer erzeugen
  const pc = await call._ensurePC();
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(detail.sdp));
    await call._flushPendingIce();
    const answer = await pc.createAnswer();
    answer.sdp = call._munge(answer.sdp);
    await pc.setLocalDescription(answer);
    call.markConnecting();
    await sendSignal(from, "answer", { sdp: { type: answer.type, sdp: answer.sdp } });
  } catch (e) {
    console.warn("[voiceRooms] onRoomOffer failed:", e?.message);
  }
}

async function onRoomAnswer(detail) {
  if (!_room || detail.roomId !== _room.roomId) return;
  const from = String(detail.from || "").toLowerCase();
  const call = _room.peers.get(from);
  if (!call) return;
  if (!detail.sdp) return;
  try {
    const state = call.pc?.signalingState;
    if (state !== "have-local-offer") {
      console.warn("[voiceRooms] answer skipped, state=", state);
      return;
    }
    await call.pc.setRemoteDescription(new RTCSessionDescription(detail.sdp));
    await call._flushPendingIce();
  } catch (e) {
    console.warn("[voiceRooms] onRoomAnswer failed:", e?.message);
  }
}

async function onRoomIce(detail) {
  if (!_room || detail.roomId !== _room.roomId) return;
  const from = String(detail.from || "").toLowerCase();
  const call = _room.peers.get(from);
  if (!call) return;
  await call.addRemoteIce(detail.candidate).catch(() => {});
}

// =========================================================
// Mute / PTT (gilt für alle Peers gleichzeitig)
// =========================================================
function applyMicGateToCall(call) {
  if (!_room?.localStream) return;
  const shouldBeEnabled = _room._pttEnabled
    ? (_room._pttHeld && !_room._muted)
    : !_room._muted;
  for (const track of _room.localStream.getAudioTracks()) {
    track.enabled = shouldBeEnabled;
  }
}
function applyMicGateToAll() {
  if (!_room) return;
  const shouldBeEnabled = _room._pttEnabled
    ? (_room._pttHeld && !_room._muted)
    : !_room._muted;
  if (_room.localStream) {
    for (const track of _room.localStream.getAudioTracks()) {
      track.enabled = shouldBeEnabled;
    }
  }
}

export function toggleRoomMute() {
  if (!_room) return false;
  _room._muted = !_room._muted;
  applyMicGateToAll();
  roomBus.dispatchEvent(new CustomEvent("room:mute", { detail: { muted: _room._muted } }));
  return _room._muted;
}
export function setRoomPTT(enabled) {
  if (!_room) return;
  _room._pttEnabled = !!enabled;
  _room._pttHeld = false;
  applyMicGateToAll();
  roomBus.dispatchEvent(new CustomEvent("room:ptt", { detail: { pttEnabled: _room._pttEnabled, held: false } }));
}
export function setRoomPTTHeld(held) {
  if (!_room || !_room._pttEnabled) return;
  _room._pttHeld = !!held;
  applyMicGateToAll();
  roomBus.dispatchEvent(new CustomEvent("room:ptt", { detail: { pttEnabled: true, held: _room._pttHeld } }));
}

// =========================================================
// Init
// =========================================================
export function initVoiceRooms() {
  if (_inited) return;
  _inited = true;

  if (!_isTopWindow) {
    // Iframe: nur Proxy über postMessage an Parent
    window.RenexVoiceRooms = Object.freeze({
      join: (roomId) => joinRoom(roomId),   // nutzt postMessage-Delegation
      leave: () => Promise.resolve(),
      active: () => null,
    });
    return;
  }

  // DevTools-Zugang
  window.RenexVoiceRooms = Object.freeze({
    join:   joinRoom,
    leave:  leaveRoom,
    active: getActiveRoom,
    toggleMute: toggleRoomMute,
    setPTT:     setRoomPTT,
  });

  // WS-Event-Subscriber
  voiceBus.addEventListener("voice:room:join",   (e) => onRoomMemberJoin(e.detail));
  voiceBus.addEventListener("voice:room:leave",  (e) => onRoomMemberLeave(e.detail));
  voiceBus.addEventListener("voice:room:offer",  (e) => onRoomOffer(e.detail));
  voiceBus.addEventListener("voice:room:answer", (e) => onRoomAnswer(e.detail));
  voiceBus.addEventListener("voice:room:ice",    (e) => onRoomIce(e.detail));

  // Postmessage von Iframe → Join/Leave delegieren
  window.addEventListener("message", (ev) => {
    if (ev.origin !== window.location.origin) return;
    if (ev.data?.type === "RENEX_VOICE_JOIN_ROOM" && ev.data.roomId) {
      joinRoom(ev.data.roomId).catch(err => console.warn("[voiceRooms] join failed:", err));
    } else if (ev.data?.type === "RENEX_VOICE_LEAVE_ROOM") {
      leaveRoom().catch(() => {});
    }
  });

  // Leave on unload (best effort — Browser kann es nicht zuverlässig abschliessen,
  // aber TTL auf Backend-Seite räumt dangling members weg)
  window.addEventListener("beforeunload", () => {
    if (_room) {
      const url = `https://api.renex.id/voice/room/${encodeURIComponent(_room.roomId)}/leave`;
      try {
        navigator.sendBeacon(url, new Blob([JSON.stringify({})], { type: "application/json" }));
      } catch {}
    }
  });
}
