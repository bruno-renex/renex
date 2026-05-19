// ======================================================
// WebRTC-Helpers für Voice-Calls
// ======================================================
// Kapselt RTCPeerConnection-Lifecycle + getUserMedia + Track-Wiring.
// Das voiceStore orchestriert die High-Level-State-Machine; hier sind nur
// die Low-Level-WebRTC-Operationen.
//
// Audio-only für Phase 1B. Video kann später ergänzt werden via
// addTrack auf der bestehenden PC.
// ======================================================

import { apiFetch } from './api.js';
import { captureException } from './sentry.js';

/**
 * Holt ICE-Server-Konfiguration vom Backend.
 * Backend gibt entweder Cloudflare Realtime TURN (mit credentials) oder
 * STUN-only Fallback zurück.
 *
 * @returns {Promise<RTCConfiguration>}
 */
export async function fetchIceServers() {
  // Default ICE-Policy: 'all' (host + srflx + relay). relay-only war ein
  // Reliability-Experiment, hat aber das Gegenteil bewirkt: Cloudflare
  // Realtime TURN scheint relay-zu-relay nicht zuverlässig zu routen
  // (bestätigt in Logs: 9 relay↔relay Pairs blieben alle in-progress,
  // never succeeded). Direkt-Pairs (host↔prflx) funktionieren wenigstens
  // wenn beide Peers im selben/kompatiblem NAT sind.
  try {
    const r = await apiFetch('/voice/turn-credentials');
    if (r.ok && r.data?.iceServers) {
      return { iceServers: r.data.iceServers };
    }
  } catch (e) {
    captureException(e, { context: 'fetchIceServers' });
  }
  // Fallback: Cloudflare-STUN (Backend liefert das auch im fail-Path)
  return {
    iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
  };
}

/**
 * Holt User-Media (Microphone) und gibt einen MediaStream zurück.
 * Wirft Error wenn Permission denied.
 *
 * @param {{audio?: boolean, video?: boolean}} [opts]
 * @returns {Promise<MediaStream>}
 */
export async function getLocalMedia({ audio = true, video = false } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia not supported');
  }
  return await navigator.mediaDevices.getUserMedia({ audio, video });
}

/**
 * Erstellt eine RTCPeerConnection mit Standard-Handlers.
 * Caller muss separat:
 *   - onIceCandidate: ICE-Candidates an Peer relayen (via /voice/ice)
 *   - onTrack: Remote-Stream an Audio-Element binden
 *   - onConnectionStateChange: state-Wechsel beobachten (für UI)
 *
 * @param {RTCConfiguration} config
 * @param {{
 *   onIceCandidate: (cand: RTCIceCandidate) => void,
 *   onTrack: (stream: MediaStream) => void,
 *   onConnectionStateChange?: (state: RTCPeerConnectionState) => void,
 * }} handlers
 * @returns {RTCPeerConnection}
 */
export function createPeerConnection(config, handlers) {
  const pc = new RTCPeerConnection(config);

  // Diagnose: welche ICE-Server-URLs hat der Browser bekommen?
  // Wenn TURN-Relay nicht klappt, zeigt diese Liste ob das Backend überhaupt
  // ein TURN über UDP / TCP / TLS geliefert hat — manche Networks blocken
  // UDP komplett und brauchen turns:443 als Fallback.
  const allUrls = (config.iceServers || []).flatMap(s =>
    Array.isArray(s.urls) ? s.urls : [s.urls]
  ).filter(Boolean);
  const turnUrls = allUrls.filter(u => String(u).startsWith('turn:') || String(u).startsWith('turns:'));
  const stunUrls = allUrls.filter(u => String(u).startsWith('stun:'));
  console.log(`📞 RTC config: ${turnUrls.length} TURN, ${stunUrls.length} STUN`);
  for (const u of turnUrls) console.log(`📞   TURN-URL: ${u}`);
  for (const u of stunUrls) console.log(`📞   STUN-URL: ${u}`);

  pc.onicecandidate = (e) => {
    if (e.candidate && handlers.onIceCandidate) {
      // Diagnose: Candidate-Typ (host/srflx/relay) + Server-URL (welcher TURN
      // wurde benutzt um relay-Candidate zu allocaten). Bei mehreren TURNs
      // sehen wir so welcher tatsächlich funktioniert.
      const c = e.candidate.candidate || '';
      const m = c.match(/typ (host|srflx|prflx|relay)/);
      const url = e.candidate.url || e.candidate.relatedAddress || '';
      console.log(`📞 ICE local candidate: ${m?.[1] || 'unknown'} ${e.candidate.protocol || ''}${url ? ` via=${url}` : ''}`);
      handlers.onIceCandidate(e.candidate);
    } else if (!e.candidate) {
      console.log(`📞 ICE gathering complete`);
    }
  };

  pc.ontrack = (e) => {
    if (handlers.onTrack && e.streams?.[0]) {
      handlers.onTrack(e.streams[0]);
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`📞 iceConnectionState=${pc.iceConnectionState}`);
    if (handlers.onIceConnectionStateChange) {
      handlers.onIceConnectionStateChange(pc.iceConnectionState);
    }
  };

  pc.onicegatheringstatechange = () => {
    console.log(`📞 iceGatheringState=${pc.iceGatheringState}`);
  };

  if (handlers.onConnectionStateChange) {
    pc.onconnectionstatechange = () => {
      handlers.onConnectionStateChange(pc.connectionState);
    };
  }

  return pc;
}

/**
 * Fügt alle Tracks aus einem MediaStream zur PC hinzu.
 * Returns die hinzugefügten RTPSenders (für späteres replaceTrack o.ä.).
 *
 * @param {RTCPeerConnection} pc
 * @param {MediaStream} stream
 * @returns {RTCRtpSender[]}
 */
export function addLocalTracks(pc, stream) {
  const senders = [];
  for (const track of stream.getTracks()) {
    senders.push(pc.addTrack(track, stream));
  }
  return senders;
}

/**
 * Schließt PC + stoppt alle lokalen Tracks. Idempotent.
 *
 * @param {RTCPeerConnection|null} pc
 * @param {MediaStream|null} localStream
 */
export function cleanupPeerConnection(pc, localStream) {
  try {
    if (localStream) {
      for (const t of localStream.getTracks()) {
        try { t.stop(); } catch {}
      }
    }
  } catch {}

  try {
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      try { pc.close(); } catch {}
    }
  } catch {}
}

/**
 * Mute/unmute alle Audio-Tracks im lokalen Stream.
 * @param {MediaStream|null} localStream
 * @param {boolean} muted
 */
export function setLocalAudioMuted(localStream, muted) {
  if (!localStream) return;
  for (const t of localStream.getAudioTracks()) {
    t.enabled = !muted;
  }
}

/**
 * Erstellt einen Audio-Level-Meter für einen MediaStream.
 * Liefert kontinuierlich (per requestAnimationFrame) den RMS-Audio-Level
 * im Bereich 0..1 an den Callback.
 *
 * Nutzt die Web Audio API (AnalyserNode mit fft 256, time-domain data,
 * RMS-Berechnung). CPU-cost: <1% in modern Browsern.
 *
 * @param {MediaStream} stream
 * @param {(level: number) => void} onLevel — wird mit 0..1 gerufen, ~60 Hz
 * @returns {() => void} dispose-Funktion (stoppt RAF + closet AudioContext)
 */
export function createAudioLevelMeter(stream, onLevel) {
  if (!stream || !stream.getAudioTracks().length) return () => {};
  // AudioContext: lazy + lenient — manche Browser blocken bis User-Gesture
  let ctx;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    return () => {};
  }
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.5;
  source.connect(analyser);

  const buf = new Float32Array(analyser.fftSize);
  let raf = 0;
  let disposed = false;

  function tick() {
    if (disposed) return;
    analyser.getFloatTimeDomainData(buf);
    // RMS über alle Samples — entspricht ungefähr der wahrgenommenen Lautstärke
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    // Skalieren auf 0..1, lautes Signal ist typisch 0.3-0.7 RMS
    const level = Math.min(1, rms * 3);
    try { onLevel(level); } catch {}
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);

  return () => {
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    try { source.disconnect(); } catch {}
    try { analyser.disconnect(); } catch {}
    try { ctx.close(); } catch {}
  };
}

/**
 * iOS-PWA-Audio-Unlock. Auf iOS Safari (auch in standalone-PWA) startet jeder
 * AudioContext in `suspended` state. Resume() darf nur aus einem synchronen
 * User-Gesture-Stack-Frame heraus aufgerufen werden — sonst wird's silent
 * ignoriert. Wir rufen das beim "Anruf starten"- und "Annehmen"-Klick auf:
 * - Erzeugt einen kurzlebigen AudioContext im User-Gesture-Frame
 * - Spielt einen 1-Sample-Silent-Buffer ab (klassischer iOS-Unlock-Trick)
 * - Schliesst den Context nach 500ms — getUserMedia muss in dem Fenster laufen
 *
 * Wichtig: KEIN persistenter `_audioUnlocked`-Guard mehr — iOS-Safari benötigt
 * je nach Audio-Session-State einen FRESH unlock pro Call. Symptom: 2nd call
 * in der gleichen PWA-Session lieferte `getUserMedia` einen track mit
 * `readyState=ended` weil Audio-Session zwischen den Calls in 'interrupted'
 * Status gegangen war.
 */
export function unlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      ctx.resume().catch(() => {});
    }
    // 500ms reicht für getUserMedia + addLocalTracks Pipeline
    setTimeout(() => { try { ctx.close(); } catch {} }, 500);
    console.log('📞 audio unlock invoked (user-gesture, ctx.state=' + ctx.state + ')');
  } catch (e) {
    console.warn('📞 audio unlock failed:', e?.message);
  }
}

/**
 * Extrahiert den DTLS-Fingerprint aus einer SDP. Format des SDP-Eintrags:
 *   a=fingerprint:sha-256 XX:XX:XX:...
 *
 * Nimmt den ersten gefundenen Fingerprint (audio + video haben i.d.R. denselben).
 * Returns canonical-form: "sha-256 XX:XX:XX:..." (lowercase hash-name + uppercase hex).
 *
 * @param {string} sdp
 * @returns {string|null}
 */
export function extractDtlsFingerprint(sdp) {
  if (typeof sdp !== 'string') return null;
  const m = sdp.match(/^a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)\s*$/m);
  if (!m) return null;
  const algo = m[1].toLowerCase();
  const hex = m[2].toUpperCase();
  return `${algo} ${hex}`;
}
