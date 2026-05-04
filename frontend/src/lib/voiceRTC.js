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
  try {
    const r = await apiFetch('/voice/turn-credentials');
    if (r.ok && r.data?.iceServers) {
      return { iceServers: r.data.iceServers };
    }
  } catch (e) {
    captureException(e, { context: 'fetchIceServers' });
  }
  // Fallback: Cloudflare-STUN (kommt im Backend auch im fail-Path)
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

  // Diagnose: welche ICE-Server hat der Browser bekommen?
  const numTurn = (config.iceServers || []).filter(s =>
    (Array.isArray(s.urls) ? s.urls : [s.urls]).some(u => String(u).startsWith('turn:') || String(u).startsWith('turns:'))
  ).length;
  const numStun = (config.iceServers || []).filter(s =>
    (Array.isArray(s.urls) ? s.urls : [s.urls]).some(u => String(u).startsWith('stun:'))
  ).length;
  console.log(`📞 RTC config: ${numTurn} TURN-Server, ${numStun} STUN-Server`);

  pc.onicecandidate = (e) => {
    if (e.candidate && handlers.onIceCandidate) {
      // Diagnose: Candidate-Typ (host/srflx/relay) hilft bei NAT-Diagnose
      const c = e.candidate.candidate || '';
      const m = c.match(/typ (host|srflx|prflx|relay)/);
      console.log(`📞 ICE local candidate: ${m?.[1] || 'unknown'} ${e.candidate.protocol || ''}`);
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
