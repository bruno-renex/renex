// ======================================================
// Voice Store — Call State + History (Reactive)
// ======================================================
// Phase 1A.6 Skeleton:
//   - call: aktueller Anruf-State
//   - history: Liste vergangener Anrufe
//
// Real WebRTC-Integration (TURN/SFU + Peer-Connections) folgt Phase 1B.
// Hier nur State-Machine + UI-Triggers.
// ======================================================

import { apiFetch } from '../lib/api.js';
import { userStore } from './user.svelte.js';

const STATES = {
  IDLE: "idle",
  RINGING: "ringing",      // outgoing: wartet auf Antwort; incoming: empfängt Klingeln
  CONNECTING: "connecting", // WebRTC-Setup läuft
  ACTIVE: "active",        // Anruf läuft
  ENDED: "ended",
};

let _state = $state(STATES.IDLE);
let _direction = $state(null); // "outgoing" | "incoming"
let _peer = $state(null);      // { handle, displayName, isGroup, groupId? }
let _isMuted = $state(false);
let _isVideoOn = $state(false);
let _isSpeakerOn = $state(true);
let _startedAt = $state(0);
let _history = $state([]);

// Live-Duration als $derived (re-renders über Interval)
let _now = $state(Date.now());
setInterval(() => { _now = Date.now(); }, 1000);

export const voiceStore = {
  STATES,

  get state()       { return _state; },
  get direction()   { return _direction; },
  get peer()        { return _peer; },
  get isMuted()     { return _isMuted; },
  get isVideoOn()   { return _isVideoOn; },
  get isSpeakerOn() { return _isSpeakerOn; },
  get startedAt()   { return _startedAt; },
  get history()     { return _history; },

  // Live-Dauer in Sekunden (nur wenn ACTIVE)
  get durationSec() {
    if (_state !== STATES.ACTIVE || !_startedAt) return 0;
    return Math.floor((_now - _startedAt) / 1000);
  },

  get isInCall() {
    return _state !== STATES.IDLE && _state !== STATES.ENDED;
  },

  /**
   * Outgoing Call starten (Stub).
   * Real-Implementation in Phase 1B mit WebRTC.
   */
  async startCall(peer, { withVideo = false } = {}) {
    _state = STATES.RINGING;
    _direction = "outgoing";
    _peer = peer;
    _isVideoOn = withVideo;
    _isMuted = false;
    _startedAt = 0;

    // Stub: nach 2s simulieren wir "Antwort"
    setTimeout(() => {
      if (_state === STATES.RINGING) {
        _state = STATES.CONNECTING;
        setTimeout(() => {
          if (_state === STATES.CONNECTING) {
            _state = STATES.ACTIVE;
            _startedAt = Date.now();
          }
        }, 800);
      }
    }, 2000);
  },

  /**
   * Incoming Call simulieren (für UI-Tests).
   */
  receiveCall(peer, { withVideo = false } = {}) {
    _state = STATES.RINGING;
    _direction = "incoming";
    _peer = peer;
    _isVideoOn = withVideo;
    _isMuted = false;
    _startedAt = 0;
  },

  acceptCall() {
    if (_state !== STATES.RINGING) return;
    _state = STATES.CONNECTING;
    setTimeout(() => {
      if (_state === STATES.CONNECTING) {
        _state = STATES.ACTIVE;
        _startedAt = Date.now();
      }
    }, 500);
  },

  endCall() {
    const wasActive = _state === STATES.ACTIVE;
    const duration = wasActive ? Math.floor((Date.now() - _startedAt) / 1000) : 0;

    // History-Eintrag (vor dem Reset)
    if (_peer) {
      _history = [
        {
          id: crypto.randomUUID(),
          peer: _peer,
          direction: _direction,
          ts: Date.now(),
          duration,
          missed: !wasActive && _direction === "incoming",
          withVideo: _isVideoOn,
        },
        ..._history,
      ].slice(0, 50);
    }

    _state = STATES.ENDED;
    setTimeout(() => {
      _state = STATES.IDLE;
      _direction = null;
      _peer = null;
      _startedAt = 0;
      _isMuted = false;
      _isVideoOn = false;
    }, 600);
  },

  toggleMute() {
    _isMuted = !_isMuted;
    // Phase 1B: track.enabled = !_isMuted für lokale Mic-Track
  },

  toggleVideo() {
    _isVideoOn = !_isVideoOn;
    // Phase 1B: video-Track hinzufügen/entfernen
  },

  toggleSpeaker() {
    _isSpeakerOn = !_isSpeakerOn;
  },

  // Load call history from API
  // Backend schema: { id, caller, callee, kind, started_at, duration_s, status, end_reason }
  async loadHistory() {
    try {
      const r = await apiFetch("/voice/history?limit=50");
      if (r.ok && Array.isArray(r.data?.calls)) {
        const me = userStore.myUser;
        _history = r.data.calls.map(c => {
          const isOutgoing = c.caller === me;
          const peerHandle = isOutgoing ? c.callee : c.caller;
          return {
            id: c.id,
            peer: { handle: peerHandle, displayName: null },
            direction: isOutgoing ? "outgoing" : "incoming",
            ts: c.started_at,
            duration: c.duration_s || 0,
            missed: c.status === "missed" || c.end_reason === "no_answer",
            withVideo: c.kind === "video",
          };
        });
      }
    } catch {
      // silent fail
    }
  },
};
