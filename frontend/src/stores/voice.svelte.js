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
  startVoiceTimer,
  cancelVoiceTimer,
  isVoiceTimerActive,
} from '../lib/voiceTimers.js';
import {
  fetchIceServers, getLocalMedia, createPeerConnection,
  addLocalTracks, cleanupPeerConnection, setLocalAudioMuted,
  extractDtlsFingerprint, createAudioLevelMeter,
} from '../lib/voiceRTC.js';
import { signMessage, verifyMessageSig } from '../lib/messageSig.js';
import { getDeviceId } from '../lib/e2eKeys.js';
import { getSigPubForDevice, getCMKIfExists } from '../lib/cmk.js';
import { ensureSecureDmSession, tryFetchAndUnwrapCMK, sendCmkRequest } from '../lib/chatPipeline.js';
import { dmSessionId, getRotationMap } from '../lib/session.js';
import {
  encryptSdp, decryptSdp,
  encryptIce, decryptIce,
  isVoiceEnvelope,
} from '../lib/voiceCrypto.js';

/**
 * Helper: kurzen CMK-Fingerprint für Logging (erste 4 hex bytes — keine echte
 * Identifikation, nur damit Mismatches im Log unterscheidbar sind).
 */
function _cmkFp(cmkBytes) {
  if (!cmkBytes || cmkBytes.length < 4) return '?';
  return Array.from(cmkBytes.slice(0, 4))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Rotation-aware Voice-Decrypt mit KV-Fetch-Fallback. Strategie identisch zu
 * chat-decrypt (chatPipeline.decryptIncomingMessage):
 *
 *   1. primaryCmk (lokaler active) probieren — Standard-Pfad
 *   2. Rotation-Map durchgehen (newest first) — falls Rotation asymmetric
 *   3. KV-Fetch (Peer's wrapped CMK) — falls Peer einen neuen CMK an unser
 *      Device gewrappt hat den wir lokal noch nicht haben (frisches device
 *      hinzugefügt, recovery, etc.)
 *
 * @param {(cmk: Uint8Array) => Promise<any>} decryptFn
 * @param {Uint8Array} primaryCmk
 * @param {string} me
 * @param {string} peer
 * @returns {Promise<any>}
 * @throws letzten Decrypt-Error wenn alles fehlschlägt
 */
async function _decryptVoiceWithRotation(decryptFn, primaryCmk, me, peer) {
  const tried = [];
  let lastErr;

  // 1. Primary
  try {
    tried.push(_cmkFp(primaryCmk));
    return await decryptFn(primaryCmk);
  } catch (e) { lastErr = e; }

  // 2. Rotation-Map (newest first)
  try {
    const sid = dmSessionId(me, peer);
    const map = await getRotationMap(sid);
    if (map && map.length > 0) {
      for (let i = map.length - 1; i >= 0; i--) {
        const cmkBytes = map[i]?.cmkBytes;
        if (!Array.isArray(cmkBytes) || cmkBytes.length !== 32) continue;
        const candidate = new Uint8Array(cmkBytes);
        const fp = _cmkFp(candidate);
        if (tried.includes(fp)) continue;
        tried.push(fp);
        try {
          return await decryptFn(candidate);
        } catch (e) { lastErr = e; }
      }
    }
  } catch {}

  // 3. KV-Fetch (Peer hat möglicherweise neuen CMK gewrappt der lokal fehlt)
  try {
    const fetched = await tryFetchAndUnwrapCMK(peer, { storeIfFresh: false });
    if (fetched instanceof Uint8Array && fetched.length === 32) {
      const fp = _cmkFp(fetched);
      if (tried.includes(fp)) {
        console.log(`📞 Voice decrypt: KV-fetch returnte identischen CMK ${fp} (skip)`);
      } else {
        tried.push(fp);
        try {
          return await decryptFn(fetched);
        } catch (e) { lastErr = e; }
      }
    } else {
      console.log(`📞 Voice decrypt: KV-fetch returnte ${fetched ? 'invalid bytes' : 'null'} (kein wrap verfügbar)`);
    }
  } catch (e) {
    console.warn(`📞 Voice decrypt: KV-fetch failed: ${e?.message}`);
  }

  console.warn(`📞 Voice decrypt failed — versucht: [${tried.join(', ')}], lastErr=${lastErr?.message}`);
  throw lastErr || new Error('voice_decrypt_failed_all_keys');
}

/**
 * Erstellt ein signiertes auth-Objekt für eine Voice-SDP.
 * Schützt gegen Backend-MITM: Backend sieht zwar SDP+fp+sig, kann aber den
 * fp nicht ändern weil es kein gültiges sig erzeugen kann (privater Sigkey
 * ist nur auf dem Sender-Device).
 *
 * @returns {Promise<{fp,sig,fromDeviceId}|null>} null wenn fp nicht extrahierbar
 */
async function _buildAuth(sdp, callId, sdpType) {
  const fp = extractDtlsFingerprint(sdp);
  if (!fp) return null;
  const fromDeviceId = getDeviceId();
  // Sig-payload formal stabil: callId|sdpType|fp — bindet fp an den konkreten Call.
  // signMessage signiert (iv|ct|sid|epoch) — wir nutzen die gleiche Signatur-Logik
  // mit voice-spezifischen Slots: iv=callId, ct=fp, sid='voice', epoch=0
  // (epoch=0 weil Voice-Calls keine epoch-rotation haben — ECDSA-P256 ist
  // nicht epoch-gebunden, eindeutigkeit kommt aus callId).
  // sdpType (offer/answer) wird in der ct-position mit-eingeflochten.
  const ctPayload = `${sdpType}:${fp}`;
  const sig = await signMessage(callId, ctPayload, 'voice', 0);
  return { fp, sig, fromDeviceId };
}

/**
 * Verifiziert ein empfangenes auth-Objekt:
 *   1. fp im auth muss mit dem fp in der SDP übereinstimmen (sonst hat Backend
 *      die SDP modifiziert nach der Signierung — MITM-Indiz)
 *   2. Signatur muss mit dem Public-Sigkey des Sender-Devices verifyen
 *
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function _verifyAuth(receivedSdp, auth, callId, sdpType, fromHandle) {
  if (!auth || typeof auth !== 'object') return { ok: false, reason: 'no_auth' };
  if (typeof auth.fp !== 'string' || typeof auth.sig !== 'string' || typeof auth.fromDeviceId !== 'string') {
    return { ok: false, reason: 'malformed_auth' };
  }
  const sdpFp = extractDtlsFingerprint(receivedSdp);
  if (!sdpFp) return { ok: false, reason: 'no_sdp_fp' };
  if (sdpFp !== auth.fp) {
    // Backend (oder MITM) hat SDP modifiziert nach Signierung — Audio wäre
    // entschlüsselbar von wem auch immer den modifizierten fp gesetzt hat.
    return { ok: false, reason: 'fp_mismatch' };
  }
  // sigPub des Sender-Devices aus IDB-Cache (ggf. nachgeladen via fetchPeerDevices).
  // getSigPubForDevice liest aus dem peer-device-cache (storePeerDevices).
  let sigPub = await getSigPubForDevice(fromHandle, auth.fromDeviceId);
  if (!sigPub) {
    // Cache-miss: device evtl. erst kürzlich added → einmal force-fetch
    const { default: nullDefault } = { default: null };  // satisfy linter
    void nullDefault;
    try {
      const { fetchPeerDevices } = await import('../lib/chatPipeline.js');
      // fetchPeerDevices ist privat — fallback: api-call selbst
      const r = await apiFetch(`/e2e/inbox/get?user=${encodeURIComponent(fromHandle)}`);
      if (r.ok && Array.isArray(r.data?.devices)) {
        const { storePeerDevices } = await import('../lib/cmk.js');
        await storePeerDevices(fromHandle, r.data.devices);
        sigPub = await getSigPubForDevice(fromHandle, auth.fromDeviceId);
      }
    } catch {}
  }
  if (!sigPub) return { ok: false, reason: 'no_sigpub' };
  const ctPayload = `${sdpType}:${auth.fp}`;
  const ok = await verifyMessageSig(callId, ctPayload, 'voice', 0, auth.sig, sigPub);
  return ok ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

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
// Speaker-Toggle entfernt (B18, Phase 1B): keine echte Browser-API für
// Earpiece↔Loudspeaker-Switch in iOS Safari/PWA, und auf Android nur über
// setSinkId mit enumerierten Geräten. Wird in Phase 1C+ als Device-Picker
// re-introduced wenn BT-Headset-Switching nötig wird.
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

// No-Answer-Timeout: 30s — wenn der Call nach 30s noch in RINGING ist, automatisch
// cancel (caller) / decline (callee). Beides erzeugt missed-call-Eintrag bei Peer.
// Timer-Verwaltung via voiceTimers.js (testbare Helper-Schicht).
export const RING_TIMEOUT_MS = 30_000;

// Mid-Call-Reconnect: iceConnectionState='disconnected' bedeutet nicht failed —
// Browser versucht selbst zu re-connecten. Wenn das nach 5s nicht klappt,
// triggern wir pc.restartIce() — neue ICE-Gathering-Runde, ohne SDP-Renegotiate.
// Bei echtem Network-Wechsel (WiFi→5G) hilft das oft. Bei totalem Server-Loss
// nicht — dann läuft eh der iceConnectionState=failed-Pfad.
// Timer-Verwaltung via voiceTimers.js (testbare Helper-Schicht).
export const RESTART_ICE_DELAY_MS = 5_000;
let _isConnectionDegraded = $state(false);

function _clearRestartIceTimer() {
  cancelVoiceTimer('restart-ice');
}

function _clearNoAnswerTimer() {
  cancelVoiceTimer('no-answer');
}

function _startNoAnswerTimer(role) {
  startVoiceTimer('no-answer', RING_TIMEOUT_MS, () => {
    // Nur greifen wenn noch in RINGING — sonst hat Peer/User schon reagiert
    if (_state !== STATES.RINGING) return;
    console.warn(`📞 No-Answer-Timeout nach 30s (${role}) → automatic cancel/decline`);
    if (role === 'caller') {
      void voiceStore.endCall();        // sendet /voice/cancel
    } else {
      void voiceStore.declineCall();    // sendet /voice/decline
    }
  });
}

// Live-Duration als $derived (re-renders über Interval)
let _now = $state(Date.now());
setInterval(() => { _now = Date.now(); }, 1000);

// ── Non-reactive WebRTC-Refs ───────────────────────────
// Diese sollen NICHT $state sein — Svelte würde versuchen sie
// zu proxy'en, was bei nativen Crypto-/Media-Objekten Probleme gibt.
let _pc = null;                  // RTCPeerConnection
let _localStream = null;         // MediaStream (mic)
let _remoteStream = null;        // MediaStream from peer (set by ontrack)
let _localMeterDispose = null;   // () => void — stoppt local audio meter
let _remoteMeterDispose = null;  // () => void — stoppt remote audio meter
// CMK (32-Byte Uint8Array) für die laufende Call-Session — encryptet alle
// SDP- und ICE-Bodies. Bei _hardReset cleared (Forward Secrecy: ein gestolzener
// Memory-Dump würde nur den aktuellen Call leaken, nicht historische CMK-Sicht).
let _callCmk = null;

// Audio-Levels (0..1). Reactive damit Avatar-Pulse-Animation drauf reagieren kann.
let _localLevel = $state(0);
let _remoteLevel = $state(0);
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
  _clearNoAnswerTimer();
  _clearRestartIceTimer();
  _isConnectionDegraded = false;
  if (_localMeterDispose) { try { _localMeterDispose(); } catch {} _localMeterDispose = null; }
  if (_remoteMeterDispose) { try { _remoteMeterDispose(); } catch {} _remoteMeterDispose = null; }
  _localLevel = 0;
  _remoteLevel = 0;
  cleanupPeerConnection(_pc, _localStream);
  _pc = null;
  _localStream = null;
  _remoteStream = null;
  _pendingRemoteIce = [];
  _localIceQueue = null;
  _callCmk = null;
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

// Bei Fehlern länger sichtbar lassen, damit User die Fehlermeldung lesen
// kann. Sonst (sauberes Hangup/Decline) reicht die kurze Fade-Animation.
function _scheduleReset() {
  setTimeout(_resetUiState, _errorMsg ? 3500 : 600);
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

async function _sendIceCandidate(cand, callId, peerHandle) {
  if (!_callCmk) {
    console.warn('📞 ICE-send ohne CMK — skip (call wahrscheinlich am Beenden)');
    return;
  }
  const me = userStore.myUser;
  const candidateObj = cand.toJSON ? cand.toJSON() : cand;
  try {
    const ec = await encryptIce(_callCmk, candidateObj, me, peerHandle, callId);
    return apiFetch('/voice/ice', {
      method: 'POST',
      body: { to: peerHandle, callId, candidate: { ec } },
    });
  } catch (e) {
    captureException(e, { context: 'voice.encryptIce' });
    console.warn('📞 encryptIce failed:', e?.message);
  }
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
      // Audio-Level-Meter für remote stream starten
      if (_remoteMeterDispose) { try { _remoteMeterDispose(); } catch {} }
      _remoteMeterDispose = createAudioLevelMeter(stream, (lvl) => {
        _remoteLevel = lvl;
      });
    },
    onIceConnectionStateChange: (ics) => {
      // Mid-Call-Reconnect: bei `disconnected` (transient) wartet der Browser
      // ~5s auf seine eigenen Reconnect-Versuche. Wenn das nicht reicht,
      // trigger wir manuell pc.restartIce() — frische ICE-Gathering-Runde
      // ohne komplette SDP-Renegotiation. Bei `connected`-Recovery: Banner weg.
      if (ics === 'disconnected' && _state === STATES.ACTIVE) {
        _isConnectionDegraded = true;
        startVoiceTimer('restart-ice', RESTART_ICE_DELAY_MS, () => {
          if (!_pc || _state !== STATES.ACTIVE) return;
          if (_pc.iceConnectionState !== 'disconnected') return;  // Browser hat sich erholt
          console.warn('📞 ICE long-disconnected → pc.restartIce()');
          try { _pc.restartIce(); } catch (e) {
            console.warn('📞 restartIce failed:', e?.message);
          }
        });
      } else if (ics === 'connected' || ics === 'completed') {
        _clearRestartIceTimer();
        _isConnectionDegraded = false;
      }
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
  // Audio-Level-Meter für local stream — wir zeigen den im UI als Pulse
  // damit User sehen ob Mic wirklich aufnimmt (silent-mic-bug detection).
  if (_localMeterDispose) { try { _localMeterDispose(); } catch {} }
  _localMeterDispose = createAudioLevelMeter(stream, (lvl) => {
    _localLevel = lvl;
  });
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
  get startedAt()    { return _startedAt; },
  get history()      { return _history; },
  get errorMsg()     { return _errorMsg; },
  get isReconnecting() { return _isReconnecting; },
  get isConnectionDegraded() { return _isConnectionDegraded; },
  get localLevel()  { return _localLevel; },
  get remoteLevel() { return _remoteLevel; },

  get durationSec() {
    if (_state !== STATES.ACTIVE || !_startedAt) return 0;
    return Math.floor((_now - _startedAt) / 1000);
  },

  get isInCall() {
    // ENDED mit Fehler: Overlay bleibt sichtbar bis _scheduleReset → IDLE,
    // damit der User die Fehlermeldung (z.B. fehlende Mic-Permission, no_cmk)
    // lesen kann statt eine 600ms-Blink-Animation zu sehen.
    if (_state === STATES.IDLE) return false;
    if (_state === STATES.ENDED) return !!_errorMsg;
    return true;
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
      // CMK sicherstellen BEVOR getUserMedia (sonst hängt User mit aktivem
      // Mic während Backend-Roundtrips). ensureSecureDmSession kann cmk_req
      // triggern und ein paar Sekunden warten.
      const me = userStore.myUser;
      const cmk = await ensureSecureDmSession(me, peer.handle);
      if (!cmk) {
        _errorMsg = 'no_cmk';
        await _hardReset();
        _writeHistoryEntry(true);
        _state = STATES.ENDED;
        _scheduleReset();
        return { ok: false, error: 'no_cmk' };
      }

      _callCmk = cmk;
      const pc = await _setupPeerConnection(_callId, peer.handle);
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);

      // DTLS-Fingerprint signieren (gegen Backend-MITM): Backend sieht zwar
      // auth.fp+sig, kann aber den fp nicht ändern weil dann die signature
      // ungültig wäre. Backend hat keinen Zugriff auf unseren privaten
      // signing-key. SDP-Body selbst ist CMK-encrypted — Backend sieht den
      // SDP-Inhalt (insb. ICE-Candidates mit IPs) nicht.
      const auth = await _buildAuth(offer.sdp, _callId, 'offer');
      const ec = await encryptSdp(cmk, offer.sdp, 'offer', me, peer.handle, _callId);
      // Diagnose: log AAD-Komponenten zur Vergleichbarkeit mit Receiver-Side
      console.log(`📞 Voice encrypt offer: me=${me} to=${peer.handle} callId=${String(_callId).slice(0,8)} ivLen=${ec.iv?.length} ctLen=${ec.ct?.length} cmkFp=${_cmkFp(cmk)}`);
      const r = await apiFetch('/voice/ring', {
        method: 'POST',
        body: {
          to: peer.handle,
          callId: _callId,
          sdp: { type: offer.type, ec },
          ...(auth ? { auth } : {}),
        },
      });
      if (!r.ok) {
        _errorMsg = r.error || 'ring_failed';
        await _hardReset();
        _writeHistoryEntry(true);
        _state = STATES.ENDED;
        _scheduleReset();
        return { ok: false, error: _errorMsg };
      }
      // Backend hat call_log inserted — gepufferte ICE-Candidates senden
      await _flushLocalIceQueue(_callId, peer.handle);
      // 30s Timer: wenn callee nicht annimmt, automatisch cancel
      _startNoAnswerTimer('caller');
      return { ok: true, callId: _callId };
    } catch (e) {
      captureException(e, { context: 'voice.startCall' });
      _errorMsg = e?.message || 'media_or_rtc_failed';
      await _hardReset();
      _writeHistoryEntry(true);
      _state = STATES.ENDED;
      _scheduleReset();
      return { ok: false, error: _errorMsg };
    }
  },

  /**
   * WS-Handler: incoming voice:ring vom Caller.
   * Setzt UI auf "incoming ringing", speichert den Offer für späteren acceptCall.
   */
  async receiveCall(payload) {
    const fromHandle = payload?.from;
    // Helper: silent auto-decline (Schema-Fehler, no_cmk, decrypt-fail, MITM).
    // Schreibt Missed-Call-Eintrag in History, damit der User auf dem Pixel
    // wenigstens sieht dass jemand versucht hat anzurufen — sonst wäre der
    // Anrufversuch komplett unsichtbar wenn die CMK noch nicht propagiert ist.
    const autoDecline = async (reason) => {
      console.error(`🚨 Voice incoming auto-decline (${reason}) von ${fromHandle}`);
      try {
        await apiFetch('/voice/decline', {
          method: 'POST',
          body: { callId: payload?.callId },
        });
      } catch {}
      if (fromHandle && _state === STATES.IDLE) {
        _history = [
          {
            id: crypto.randomUUID(),
            peer: { handle: fromHandle, displayName: null },
            direction: 'incoming',
            ts: Date.now(),
            duration: 0,
            missed: true,
            withVideo: false,
            reason,
          },
          ..._history,
        ].slice(0, 50);
      }
    };

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
    // SDP-Body ist CMK-encrypted — vor Auth-Verify entschlüsseln.
    // CMK muss existieren (Caller hat ensureSecureDmSession schon gemacht
    // und seine CMK ggf. via /e2e/cmk/store an unsere Devices verteilt).
    const me = userStore.myUser;
    const ec = payload.sdp?.ec;
    if (!ec || !isVoiceEnvelope(ec) || payload.sdp?.type !== 'offer') {
      await autoDecline('schema_mismatch');
      return;
    }
    let cmk = await getCMKIfExists(fromHandle);
    if (!cmk) {
      // Fallback: ensureSecureDmSession kann via cmk_req nachladen
      cmk = await ensureSecureDmSession(me, fromHandle);
    }
    if (!cmk) {
      await autoDecline('no_cmk');
      return;
    }
    // Diagnose: log AAD-Komponenten + Caller's deviceId (für Multi-Device-Tracking)
    const callerDeviceId = payload.auth?.fromDeviceId || '?';
    console.log(`📞 Voice decrypt offer: me=${me} from=${fromHandle}/${callerDeviceId.slice(0,8)} callId=${String(payload.callId).slice(0,8)} cmkFp=${_cmkFp(cmk)}`);
    let plainSdp;
    try {
      plainSdp = await _decryptVoiceWithRotation(
        (k) => decryptSdp(k, ec, 'offer', fromHandle, me, payload.callId),
        cmk, me, fromHandle
      );
    } catch (firstErr) {
      // First decrypt fail — wahrscheinlich Multi-Device-CMK-Divergenz auf Peer-Seite
      // (z.B. Peer hat 2 Devices mit unterschiedlichen CMKs für unsere DM).
      // Send cmk_req → das gerade rufende Peer-Device redistributiert seinen
      // CMK an unser Device, dann KV-fetch + retry.
      console.warn(`📞 Voice decrypt failed first try, sending cmk_req + retrying`);
      try {
        await sendCmkRequest(fromHandle);
      } catch {}
      // Kurz warten damit Peer den cmk_req sehen + redistributen + KV propagieren kann
      await new Promise(r => setTimeout(r, 2500));
      // Retry mit forciertem KV-fetch (storeIfFresh: true diesmal, damit der neue
      // wirklich lokal landet — peer hat ja gerade frisch redistributiert)
      try {
        const fresh = await tryFetchAndUnwrapCMK(fromHandle, { storeIfFresh: true });
        if (fresh instanceof Uint8Array && fresh.length === 32 && _cmkFp(fresh) !== _cmkFp(cmk)) {
          console.log(`📞 Voice retry: KV liefert NEUEN CMK ${_cmkFp(fresh)} (war ${_cmkFp(cmk)}) — versuche decrypt`);
          plainSdp = await decryptSdp(fresh, ec, 'offer', fromHandle, me, payload.callId);
        } else {
          throw firstErr;
        }
      } catch (e) {
        await autoDecline(`decrypt_failed:${e?.message || 'unknown'}`);
        return;
      }
    }
    // Auth-Verify VOR Annahme: wenn der Caller einen signierten fp mitschickt,
    // muss der zur SDP passen + signature mit Caller-sigPub verifyen. Failure
    // → call sofort declinen, NICHT mal das ringing-UI zeigen.
    if (payload.auth) {
      const v = await _verifyAuth(plainSdp, payload.auth, payload.callId, 'offer', fromHandle);
      if (!v.ok) {
        await autoDecline(`mitm_${v.reason}`);
        return;
      }
    }
    _direction = 'incoming';
    _peer = { handle: fromHandle, displayName: null };
    _callId = payload.callId;
    _state = STATES.RINGING;
    _isMuted = false;
    _isVideoOn = false;
    _errorMsg = null;
    // CMK schon hier persistieren — acceptCall nutzt es zum Encrypten
    // des Answer-SDP + ICE.
    _callCmk = cmk;

    // Offer für späteren acceptCall ablegen — als Property, kein $state weil
    // das ein RTCSessionDescriptionInit-Objekt ist. Wir legen den decrypteten
    // SDP-Klartext ab (RTCPeerConnection braucht plaintext-SDP).
    voiceStore._incomingOffer = { type: 'offer', sdp: plainSdp };
    // 30s Timer: wenn User nicht akzeptiert/declined, automatisch decline
    // (markiert call als missed beim Caller).
    _startNoAnswerTimer('callee');
  },

  /**
   * Caller-side: WS-Handler für voice:answer.
   */
  async _handleAnswer(payload) {
    if (!_pc || _state !== STATES.RINGING || _direction !== 'outgoing') return;
    if (payload.callId !== _callId) return;
    const peerHandle = _peer?.handle;
    const me = userStore.myUser;
    // Answer-SDP ist CMK-encrypted — erst decrypten, dann auth verifyen.
    const ec = payload.sdp?.ec;
    if (!ec || !isVoiceEnvelope(ec) || payload.sdp?.type !== 'answer') {
      console.error(`🚨 Voice answer ohne ec-Envelope von ${peerHandle} — Schema-Mismatch`);
      _errorMsg = 'incompatible_peer';
      void voiceStore.endCall();
      return;
    }
    if (!_callCmk) {
      console.error(`🚨 Voice answer ohne lokalen CMK — abbrechen`);
      _errorMsg = 'no_cmk';
      void voiceStore.endCall();
      return;
    }
    let plainSdp;
    try {
      plainSdp = await _decryptVoiceWithRotation(
        (k) => decryptSdp(k, ec, 'answer', peerHandle, me, _callId),
        _callCmk, me, peerHandle
      );
    } catch (e) {
      console.error(`🚨 Voice answer-decrypt failed: ${e?.message}`);
      _errorMsg = 'decrypt_failed';
      void voiceStore.endCall();
      return;
    }
    // Auth-Verify: signed DTLS-fingerprint vom Callee. Wenn Backend die SDP
    // modifiziert hat (MITM-Versuch), ist der fp im SDP ≠ fp in auth, oder
    // die signature failed → reject call sofort.
    if (peerHandle) {
      const v = await _verifyAuth(plainSdp, payload.auth, _callId, 'answer', peerHandle);
      if (!v.ok) {
        console.error(`🚨 Voice MITM-Verdacht (answer): ${v.reason}`);
        _errorMsg = `mitm_${v.reason}`;
        void voiceStore.endCall();
        return;
      }
    }
    try {
      // Callee hat geantwortet → No-Answer-Timer canceln
      _clearNoAnswerTimer();
      await _pc.setRemoteDescription({ type: 'answer', sdp: plainSdp });
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
    // Candidate ist CMK-encrypted — erst decrypten, dann an PC weitergeben.
    const ec = payload.candidate?.ec;
    if (!ec || !isVoiceEnvelope(ec)) {
      console.warn(`📞 ICE candidate ohne ec-Envelope — Schema-Mismatch, skip`);
      return;
    }
    if (!_callCmk) {
      console.warn(`📞 ICE candidate ohne lokalen CMK — skip`);
      return;
    }
    const me = userStore.myUser;
    const fromHandle = payload.from;
    let candidateObj;
    try {
      candidateObj = await _decryptVoiceWithRotation(
        (k) => decryptIce(k, ec, fromHandle, me, _callId),
        _callCmk, me, fromHandle
      );
    } catch (e) {
      console.warn(`📞 ICE-decrypt failed von ${fromHandle}: ${e?.message}`);
      return;
    }
    // Diagnose: Candidate-Typ (host/srflx/relay) zeigt NAT-Profil des Peers
    const c = candidateObj?.candidate || '';
    const m = c.match(/typ (host|srflx|prflx|relay)/);
    console.log(`📞 ICE remote candidate: ${m?.[1] || 'unknown'}`);
    if (_pc.remoteDescription) {
      try {
        await _pc.addIceCandidate(candidateObj);
      } catch (e) {
        console.warn(`📞 addIceCandidate failed:`, e?.message);
      }
    } else {
      _pendingRemoteIce.push(candidateObj);
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

    // User hat akzeptiert → kein no-answer mehr möglich
    _clearNoAnswerTimer();
    _state = STATES.CONNECTING;
    try {
      const me = userStore.myUser;
      // _callCmk wurde in receiveCall schon gesetzt — defensiv nochmal prüfen
      if (!_callCmk) {
        _callCmk = await getCMKIfExists(_peer.handle);
        if (!_callCmk) _callCmk = await ensureSecureDmSession(me, _peer.handle);
      }
      if (!_callCmk) throw new Error('no_cmk');

      const pc = await _setupPeerConnection(_callId, _peer.handle);
      await pc.setRemoteDescription(offer);
      await _flushPendingIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Sign own DTLS-fingerprint für Caller (gegen Backend-MITM, gleich wie
      // beim ring/offer-Pfad). SDP-Body wird mit CMK encrypted.
      const auth = await _buildAuth(answer.sdp, _callId, 'answer');
      const ec = await encryptSdp(_callCmk, answer.sdp, 'answer', me, _peer.handle, _callId);
      const r = await apiFetch('/voice/answer', {
        method: 'POST',
        body: {
          callId: _callId,
          sdp: { type: answer.type, ec },
          ...(auth ? { auth } : {}),
        },
      });
      if (!r.ok) {
        _errorMsg = r.error || 'answer_failed';
        await _hardReset();
        _writeHistoryEntry(true);
        _state = STATES.ENDED;
        _scheduleReset();
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
      _scheduleReset();
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
    _scheduleReset();
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
    _scheduleReset();
  },

  /**
   * Lokal-only beenden (z.B. peer hat hangup geschickt — wir senden nichts zurück).
   */
  async _endLocallyOnly(missed) {
    if (_state === STATES.IDLE || _state === STATES.ENDED) return;
    _writeHistoryEntry(missed);
    _state = STATES.ENDED;
    await _hardReset();
    _scheduleReset();
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
