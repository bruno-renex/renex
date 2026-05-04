// ======================================================
// Voice Store — Real WebRTC + State-Machine (Phase 1B)
// ======================================================
// Verwaltet einen aktiven 1:1 Voice-Call mit echtem RTCPeerConnection,
// orchestriert Signaling via Backend (/voice/ring, /answer, /ice, /hangup,
// /decline, /cancel) und reagiert auf WS-Events (voice:ring/answer/ice/...)
//
// State-Machine:
//   IDLE → (out) RINGING → CONNECTING → ACTIVE → ENDED → IDLE
//   IDLE → (in)  RINGING → CONNECTING → ACTIVE → ENDED → IDLE
//
// Audio-only für jetzt. Video-Toggle wäre spätere Erweiterung
// (addTrack auf der bestehenden PC + new offer/renegotiate).
// ======================================================

import { apiFetch } from '../lib/api.js';
import { userStore } from './user.svelte.js';
import { captureException } from '../lib/sentry.js';
import {
  fetchIceServers, getLocalMedia, createPeerConnection,
  addLocalTracks, cleanupPeerConnection, setLocalAudioMuted,
} from '../lib/voiceRTC.js';

const STATES = {
  IDLE: 'idle',
  RINGING: 'ringing',       // outgoing: wartet auf Antwort; incoming: empfängt Klingeln
  CONNECTING: 'connecting', // SDP-Exchange + ICE läuft
  ACTIVE: 'active',         // peer connected, Audio fließt
  ENDED: 'ended',
};

let _state = $state(STATES.IDLE);
let _direction = $state(null);   // "outgoing" | "incoming"
let _peer = $state(null);        // { handle, displayName }
let _callId = $state(null);
let _isMuted = $state(false);
let _isVideoOn = $state(false);
let _isSpeakerOn = $state(true);
let _startedAt = $state(0);
let _history = $state([]);
let _errorMsg = $state(null);

// Push-to-Talk: opt-in pro Call. Standard ist Open-Mic (PTT off).
// Wenn _pttMode === true, wird der lokale Mic-Track NUR enabled wenn
// _pttPressed === true (Spacebar oder Touch-Hold). Sonst muted.
let _pttMode = $state(false);
let _pttPressed = $state(false);

// Auto-Retry: wenn ICE failt UND wir der Caller waren, machen wir EINMAL
// einen komplett neuen Call-Versuch (frische callId, frische TURN-credentials,
// frische ICE-gathering). Nur 1 Retry — sonst Endlosschleife bei broken TURN.
let _iceRetryUsed = false;
let _isReconnecting = $state(false);

// Live-Duration als $derived (re-renders über Interval)
let _now = $state(Date.now());
setInterval(() => { _now = Date.now(); }, 1000);

// ── Non-reactive WebRTC-Refs ───────────────────────────
// Diese sollen NICHT $state sein — Svelte würde versuchen sie
// zu proxy'en, was bei nativen Crypto-/Media-Objekten Probleme gibt.
let _pc = null;                  // RTCPeerConnection
let _localStream = null;         // MediaStream (mic)
let _remoteStream = null;        // MediaStream from peer (set by ontrack)
// Pending ICE-Candidates die vor setRemoteDescription ankamen
let _pendingRemoteIce = [];
// Pending ICE-Candidates die wir senden wollen, aber Backend kennt den Call
// noch nicht (call_log noch nicht inserted vor /voice/ring response).
// Wird auf null gesetzt sobald Call angemeldet ist und directly geflusht +
// alle weiteren direkt gesendet.
let _localIceQueue = null;       // null = direkt senden; Array = noch queueen
// Subscriber für remote-stream-Update — VoiceCallOverlay bindet hier ein
const _remoteListeners = new Set();

function _emitRemoteStream() {
  for (const cb of _remoteListeners) {
    try { cb(_remoteStream); } catch {}
  }
}

async function _hardReset() {
  cleanupPeerConnection(_pc, _localStream);
  _pc = null;
  _localStream = null;
  _remoteStream = null;
  _pendingRemoteIce = [];
  _localIceQueue = null;
  _emitRemoteStream();
}

function _resetUiState() {
  _state = STATES.IDLE;
  _direction = null;
  _peer = null;
  _callId = null;
  _startedAt = 0;
  _isMuted = false;
  _isVideoOn = false;
  _errorMsg = null;
  _pttMode = false;
  _pttPressed = false;
  _iceRetryUsed = false;
  _isReconnecting = false;
}

/**
 * Zentraler Mic-State-Apply: berücksichtigt PTT-Mode + manuellen Mute.
 * Wahrheitstabelle:
 *   pttMode=false, isMuted=false  → mic ON  (open mic, normal)
 *   pttMode=false, isMuted=true   → mic OFF (manual mute)
 *   pttMode=true,  pttPressed=false → mic OFF (idle, PTT not held)
 *   pttMode=true,  pttPressed=true  → mic ON (PTT held)
 *   isMuted überridet PTT (User kann sich mit Mute-Button hard-muten)
 */
function _applyMicState() {
  const shouldEnable = _pttMode
    ? (_pttPressed && !_isMuted)
    : !_isMuted;
  setLocalAudioMuted(_localStream, !shouldEnable);
}

function _writeHistoryEntry(missed) {
  if (!_peer) return;
  const wasActive = _startedAt > 0;
  const duration = wasActive ? Math.floor((Date.now() - _startedAt) / 1000) : 0;
  _history = [
    {
      id: crypto.randomUUID(),
      peer: _peer,
      direction: _direction,
      ts: Date.now(),
      duration,
      missed: !!missed,
      withVideo: _isVideoOn,
    },
    ..._history,
  ].slice(0, 50);
}

function _sendIceCandidate(cand, callId, peerHandle) {
  return apiFetch('/voice/ice', {
    method: 'POST',
    body: { to: peerHandle, callId, candidate: cand.toJSON ? cand.toJSON() : cand },
  });
}

async function _flushLocalIceQueue(callId, peerHandle) {
  if (!_localIceQueue) return;
  const queue = _localIceQueue;
  _localIceQueue = null;  // ab hier direkt senden
  for (const c of queue) {
    void _sendIceCandidate(c, callId, peerHandle);
  }
}

async function _setupPeerConnection(callId, peerHandle) {
  const config = await fetchIceServers();
  // Bis _localIceQueue auf null gesetzt wird (post /voice/ring|/answer success),
  // werden Candidates lokal gepuffert. Sonst feuern sie BEVOR call_log existiert
  // → Backend returnt 404 für /voice/ice.
  _localIceQueue = [];
  const pc = createPeerConnection(config, {
    onIceCandidate: (cand) => {
      if (_localIceQueue !== null) {
        _localIceQueue.push(cand);
        return;
      }
      void _sendIceCandidate(cand, callId, peerHandle);
    },
    onTrack: (stream) => {
      _remoteStream = stream;
      _emitRemoteStream();
    },
    onConnectionStateChange: (cs) => {
      console.log(`📞 RTC connectionState=${cs}`);
      if (cs === 'connected') {
        if (_state === STATES.CONNECTING) {
          _state = STATES.ACTIVE;
          _startedAt = Date.now();
        }
      } else if (cs === 'failed') {
        // ICE konnte keine working candidate-pairs bilden. Backend-State ist
        // noch auf "ringing/connected" → ohne Cleanup ist der nächste Call
        // mit 409 (busy) blockiert.
        if (_state !== STATES.IDLE && _state !== STATES.ENDED) {
          // Auto-Retry: wenn wir Caller waren und noch nicht gerettet haben,
          // einmal komplett neuen Call versuchen (frische callId + ICE).
          // Callee kann nicht initiieren — er bekommt nur cleanup.
          if (!_iceRetryUsed && _direction === 'outgoing' && _peer) {
            _iceRetryUsed = true;
            const peerSnapshot = { handle: _peer.handle, displayName: _peer.displayName };
            console.warn('📞 ICE failed → Auto-Retry mit neuem Call');
            _isReconnecting = true;
            _errorMsg = null;
            void (async () => {
              try {
                // Lokal cleanen + Backend benachrichtigen, damit KV-state frei wird
                await voiceStore.endCall();
                // Backend KV-Propagation + brief delay damit peer-side cleanup durch ist
                await new Promise(r => setTimeout(r, 1500));
                // Reconnecting-Flag nach erfolgreich gestarteten Call wieder false setzen
                const r = await voiceStore.startCall(peerSnapshot);
                if (!r.ok) {
                  _errorMsg = r.error || 'reconnect_failed';
                }
              } catch (e) {
                captureException(e, { context: 'voice.iceRetry' });
                _errorMsg = e?.message || 'reconnect_failed';
              } finally {
                _isReconnecting = false;
              }
            })();
          } else {
            console.warn('📞 ICE failed → cleanup (kein Retry)');
            _errorMsg = 'ice_failed';
            void voiceStore.endCall();
          }
        }
      } else if (cs === 'closed') {
        // PC wurde explizit geschlossen (von uns via cleanupPeerConnection oder
        // vom Browser nach peer-disconnect). Lokaler Cleanup reicht — Backend
        // wurde schon durch endCall/_handlePeerEnd benachrichtigt.
        if (_state !== STATES.IDLE && _state !== STATES.ENDED) {
          void voiceStore._endLocallyOnly(false);
        }
      }
    },
  });

  // Mikrofon
  const stream = await getLocalMedia({ audio: true, video: false });
  addLocalTracks(pc, stream);

  _pc = pc;
  _localStream = stream;
  // Initialer Mic-State: respektiert pttMode/isMuted falls bereits gesetzt.
  // Wenn pttMode=true beim Setup → Mic startet OFF (User muss Hold drücken).
  _applyMicState();
  return pc;
}

async function _flushPendingIce() {
  if (!_pc || !_pc.remoteDescription) return;
  const queue = _pendingRemoteIce;
  _pendingRemoteIce = [];
  for (const cand of queue) {
    try { await _pc.addIceCandidate(cand); } catch {}
  }
}

export const voiceStore = {
  STATES,

  get state()        { return _state; },
  get direction()    { return _direction; },
  get peer()         { return _peer; },
  get callId()       { return _callId; },
  get isMuted()      { return _isMuted; },
  get isVideoOn()    { return _isVideoOn; },
  get isSpeakerOn()  { return _isSpeakerOn; },
  get startedAt()    { return _startedAt; },
  get history()      { return _history; },
  get errorMsg()     { return _errorMsg; },
  get isReconnecting() { return _isReconnecting; },

  get durationSec() {
    if (_state !== STATES.ACTIVE || !_startedAt) return 0;
    return Math.floor((_now - _startedAt) / 1000);
  },

  get isInCall() {
    return _state !== STATES.IDLE && _state !== STATES.ENDED;
  },

  /**
   * Subscribe für remote-stream-Änderungen. VoiceCallOverlay nutzt das,
   * um den `<audio>`-srcObject zu setzen. Unsubscribe-Funktion wird returnt.
   */
  onRemoteStream(cb) {
    _remoteListeners.add(cb);
    // Sofort aktuellen Wert pushen
    try { cb(_remoteStream); } catch {}
    return () => _remoteListeners.delete(cb);
  },

  /**
   * Outgoing Call starten.
   * 1. createOffer → setLocalDescription
   * 2. POST /voice/ring mit offer.sdp
   * 3. Wartet auf voice:answer → setRemoteDescription
   */
  async startCall(peer, { withVideo = false } = {}) {
    if (_state !== STATES.IDLE) return { ok: false, error: 'busy' };
    if (!peer?.handle) return { ok: false, error: 'no_peer' };

    _direction = 'outgoing';
    _peer = peer;
    _callId = crypto.randomUUID();
    _state = STATES.RINGING;
    _isVideoOn = false;  // Video nicht aktiv in 1B
    _isMuted = false;
    _errorMsg = null;

    try {
      const pc = await _setupPeerConnection(_callId, peer.handle);
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);

      const r = await apiFetch('/voice/ring', {
        method: 'POST',
        body: {
          to: peer.handle,
          callId: _callId,
          sdp: { type: offer.type, sdp: offer.sdp },
        },
      });
      if (!r.ok) {
        _errorMsg = r.error || 'ring_failed';
        await _hardReset();
        _writeHistoryEntry(true);
        _state = STATES.ENDED;
        setTimeout(_resetUiState, 600);
        return { ok: false, error: _errorMsg };
      }
      // Backend hat call_log inserted — gepufferte ICE-Candidates senden
      await _flushLocalIceQueue(_callId, peer.handle);
      return { ok: true, callId: _callId };
    } catch (e) {
      captureException(e, { context: 'voice.startCall' });
      _errorMsg = e?.message || 'media_or_rtc_failed';
      await _hardReset();
      _writeHistoryEntry(true);
      _state = STATES.ENDED;
      setTimeout(_resetUiState, 600);
      return { ok: false, error: _errorMsg };
    }
  },

  /**
   * WS-Handler: incoming voice:ring vom Caller.
   * Setzt UI auf "incoming ringing", speichert den Offer für späteren acceptCall.
   */
  async receiveCall(payload) {
    if (_state !== STATES.IDLE) {
      // Bereits in einem Call — Backend hätte busy returnen sollen, aber
      // defensiv: wir lehnen den 2. Anruf ab.
      try {
        await apiFetch('/voice/decline', {
          method: 'POST',
          body: { callId: payload.callId },
        });
      } catch {}
      return;
    }
    _direction = 'incoming';
    _peer = { handle: payload.from, displayName: null };
    _callId = payload.callId;
    _state = STATES.RINGING;
    _isMuted = false;
    _isVideoOn = false;
    _errorMsg = null;

    // Offer für späteren acceptCall ablegen — als Property, kein $state weil
    // das ein RTCSessionDescriptionInit-Objekt ist.
    voiceStore._incomingOffer = payload.sdp;
  },

  /**
   * Caller-side: WS-Handler für voice:answer.
   */
  async _handleAnswer(payload) {
    if (!_pc || _state !== STATES.RINGING || _direction !== 'outgoing') return;
    if (payload.callId !== _callId) return;
    try {
      await _pc.setRemoteDescription(payload.sdp);
      await _flushPendingIce();
      _state = STATES.CONNECTING;
      // ACTIVE-Übergang via onConnectionStateChange
    } catch (e) {
      captureException(e, { context: 'voice.handleAnswer' });
      void voiceStore.endCall();
    }
  },

  /**
   * Caller- & Callee-side: ICE-Candidate vom Peer.
   * Vor setRemoteDescription queueen.
   */
  async _handleIce(payload) {
    if (!payload?.candidate || payload.callId !== _callId) return;
    if (!_pc) return;
    // Diagnose: Candidate-Typ (host/srflx/relay) zeigt NAT-Profil des Peers
    const c = payload.candidate?.candidate || '';
    const m = c.match(/typ (host|srflx|prflx|relay)/);
    console.log(`📞 ICE remote candidate: ${m?.[1] || 'unknown'}`);
    if (_pc.remoteDescription) {
      try {
        await _pc.addIceCandidate(payload.candidate);
      } catch (e) {
        console.warn(`📞 addIceCandidate failed:`, e?.message);
      }
    } else {
      _pendingRemoteIce.push(payload.candidate);
      console.log(`📞 ICE remote candidate queued (${_pendingRemoteIce.length} pending, no remoteDescription yet)`);
    }
  },

  /**
   * Callee-side: Anruf annehmen.
   * 1. setRemoteDescription(offer)
   * 2. createAnswer → setLocalDescription
   * 3. POST /voice/answer mit answer.sdp
   */
  async acceptCall() {
    if (_state !== STATES.RINGING || _direction !== 'incoming') return;
    const offer = voiceStore._incomingOffer;
    if (!offer || !_callId || !_peer?.handle) return;

    _state = STATES.CONNECTING;
    try {
      const pc = await _setupPeerConnection(_callId, _peer.handle);
      await pc.setRemoteDescription(offer);
      await _flushPendingIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      const r = await apiFetch('/voice/answer', {
        method: 'POST',
        body: {
          callId: _callId,
          sdp: { type: answer.type, sdp: answer.sdp },
        },
      });
      if (!r.ok) {
        _errorMsg = r.error || 'answer_failed';
        await _hardReset();
        _writeHistoryEntry(true);
        _state = STATES.ENDED;
        setTimeout(_resetUiState, 600);
        return;
      }
      // call_log ist jetzt status='connected' — gepufferte Candidates senden
      await _flushLocalIceQueue(_callId, _peer.handle);
      // ACTIVE-Übergang via onConnectionStateChange
    } catch (e) {
      captureException(e, { context: 'voice.acceptCall' });
      _errorMsg = e?.message || 'accept_failed';
      await _hardReset();
      _writeHistoryEntry(true);
      _state = STATES.ENDED;
      setTimeout(_resetUiState, 600);
    } finally {
      voiceStore._incomingOffer = null;
    }
  },

  /**
   * Callee-side: incoming ringing ablehnen.
   */
  async declineCall() {
    if (_state !== STATES.RINGING || _direction !== 'incoming') return;
    const callId = _callId;
    _writeHistoryEntry(true);
    _state = STATES.ENDED;
    voiceStore._incomingOffer = null;

    try {
      await apiFetch('/voice/decline', { method: 'POST', body: { callId } });
    } catch (e) {
      captureException(e, { context: 'voice.declineCall' });
    }
    await _hardReset();
    setTimeout(_resetUiState, 600);
  },

  /**
   * Caller- & Callee-side: laufenden oder klingelnden Call beenden.
   * Caller pre-answer: cancel. Sonst: hangup.
   */
  async endCall() {
    if (_state === STATES.IDLE || _state === STATES.ENDED) return;

    const callId = _callId;
    const peerHandle = _peer?.handle;
    const wasOutgoing = _direction === 'outgoing';
    const wasActive = _startedAt > 0;

    _writeHistoryEntry(!wasActive && _direction === 'incoming');
    _state = STATES.ENDED;

    try {
      if (callId && peerHandle) {
        const endpoint = (wasOutgoing && !wasActive) ? '/voice/cancel' : '/voice/hangup';
        console.log(`📞 endCall: POST ${endpoint} → peer=${peerHandle} callId=${callId.slice(0,8)}`);
        const r = await apiFetch(endpoint, {
          method: 'POST',
          body: { callId, to: peerHandle },
        });
        if (!r.ok) {
          console.warn(`📞 endCall: ${endpoint} failed:`, r.error || r.status);
        }
      } else {
        console.warn(`📞 endCall: missing callId/peer (callId=${callId} peer=${peerHandle})`);
      }
    } catch (e) {
      console.error(`📞 endCall: exception`, e?.message);
      captureException(e, { context: 'voice.endCall' });
    }

    await _hardReset();
    setTimeout(_resetUiState, 600);
  },

  /**
   * Lokal-only beenden (z.B. peer hat hangup geschickt — wir senden nichts zurück).
   */
  async _endLocallyOnly(missed) {
    if (_state === STATES.IDLE || _state === STATES.ENDED) return;
    _writeHistoryEntry(missed);
    _state = STATES.ENDED;
    await _hardReset();
    setTimeout(_resetUiState, 600);
  },

  /**
   * WS-Handler: peer hat hangup/decline/cancel geschickt.
   */
  async _handlePeerEnd(payload, kind) {
    if (payload.callId !== _callId) {
      console.warn(`📞 _handlePeerEnd(${kind}): callId mismatch — got ${payload.callId?.slice(0,8)}, local ${_callId?.slice(0,8)}`);
      return;
    }
    console.log(`📞 _handlePeerEnd(${kind}): cleaning up local state`);
    // Bei decline/cancel vor Active = missed/abandoned; bei hangup = beendet
    const missed = (kind === 'decline' && _direction === 'outgoing') ||
                   (kind === 'cancel' && _direction === 'incoming');
    await voiceStore._endLocallyOnly(missed);
  },

  // ── Audio-Controls ─────────────────────────────────
  toggleMute() {
    _isMuted = !_isMuted;
    _applyMicState();
  },

  toggleVideo() {
    // Phase 1B: noch nicht implementiert (audio-only)
    // _isVideoOn = !_isVideoOn;
  },

  toggleSpeaker() {
    // Browser-Lautsprecher-Toggle ist OS-gebunden; wir tracken nur den UI-Toggle
    _isSpeakerOn = !_isSpeakerOn;
  },

  // ── Push-to-Talk ───────────────────────────────────
  get pttMode()    { return _pttMode; },
  get pttPressed() { return _pttPressed; },

  togglePttMode() {
    _pttMode = !_pttMode;
    if (_pttMode) {
      // PTT eingeschaltet: pttPressed startet false → Mic geht aus bis Hold
      _pttPressed = false;
    } else {
      // PTT ausgeschaltet: Mic geht zurück auf isMuted-Zustand
      _pttPressed = false;
    }
    _applyMicState();
  },

  /**
   * Spacebar/Touch-Hold-Down — User drückt Push-to-Talk-Taste.
   * No-op wenn PTT-Mode aus ist.
   */
  setPttPressed(pressed) {
    if (!_pttMode) return;
    if (_pttPressed === pressed) return;  // dedup
    _pttPressed = pressed;
    _applyMicState();
  },

  // ── Call-History laden ─────────────────────────────
  async loadHistory() {
    try {
      const r = await apiFetch('/voice/history?limit=50');
      if (r.ok && Array.isArray(r.data?.calls)) {
        const me = userStore.myUser;
        _history = r.data.calls.map(c => {
          const isOutgoing = c.caller === me;
          const peerHandle = isOutgoing ? c.callee : c.caller;
          return {
            id: c.id,
            peer: { handle: peerHandle, displayName: null },
            direction: isOutgoing ? 'outgoing' : 'incoming',
            ts: c.started_at,
            duration: c.duration_s || 0,
            missed: c.status === 'missed' || c.end_reason === 'no_answer',
            withVideo: c.kind === 'video',
          };
        });
      }
    } catch {
      // silent fail
    }
  },

  // Internal: für WS-Handler in App.svelte (verstecken, aber benutzbar)
  _incomingOffer: null,
};
