// ======================================================
// voiceClient.js — Phase 2: Real WebRTC P2P
//
// Ein VoiceCall kapselt genau einen 1:1-Anruf:
//   - RTCPeerConnection (direkt P2P, STUN/TURN-Fallback via iceServers)
//   - getUserMedia (Mic) mit Gamer-Tuning
//   - Opus-Preferenzen via SDP-Munging (FEC an, DTX aus, hohe Bitrate)
//   - getStats()-Polling → emittiert "stats" Events (RTT/Jitter/Loss)
//   - Push-to-Talk (Track-Enable-Toggle → null-latency)
//
// Audio fliesst NICHT über den Worker — nur Signaling.
// ======================================================

export const CallState = Object.freeze({
  IDLE:        "idle",
  DIALING:     "dialing",      // wir rufen an, warten auf Answer
  RINGING:     "ringing",      // wir werden angerufen
  CONNECTING:  "connecting",   // ICE läuft
  CONNECTED:   "connected",    // Audio fliesst
  ENDED:       "ended",
});

// Audio-Constraints: bevorzugte ("ideal") statt erzwungene ("exact") Werte.
// Ältere Chromium-Versionen (z.B. Brave auf Huawei 2019 ≈ Chromium 75-80)
// interpretieren rohe Zahlen als "exact" und werfen OverconstrainedError
// OHNE vorher den Permission-Dialog zu zeigen → Mikro-Zugriff scheint blockiert.
const AUDIO_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl:  false,   // Gaming-Headsets regeln selbst
    channelCount:   { ideal: 1 },
    sampleRate:     { ideal: 48000 },
  },
  video: false,
};

// Fallback-Constraints für sehr alte Browser: nur `audio: true`
// Wenn auch das fehlschlägt, gibt es wirklich kein Mikro / keine Permission.
const AUDIO_CONSTRAINTS_FALLBACK = { audio: true, video: false };

// Helper: versucht zuerst die guten Constraints, fällt bei
// OverconstrainedError auf die simplen zurück.
// Exportiert damit UI-Code getUserMedia FRÜH im Click-Handler aufrufen kann
// (User-Gesture bleibt erhalten — wichtig für alte Browser).
export async function getUserMediaWithFallback() {
  try {
    return await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
  } catch (e) {
    // Nur bei Constraints-Problemen Fallback — NotAllowedError muss weiter oben
    // als Permission-Fehler behandelt werden.
    if (e?.name === "OverconstrainedError" || e?.name === "ConstraintNotSatisfiedError") {
      console.warn("[voiceClient] Constraints zu strikt, nutze Fallback:", e.name);
      return await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS_FALLBACK);
    }
    throw e;
  }
}

// Opus-Parameter: FEC an, DTX aus, Stereo aus, max Bitrate
// (DTX erzeugt beim Gaming hörbare Cuts, FEC rettet Packet-Loss)
const OPUS_FMTP = {
  maxaveragebitrate: 64000,
  maxplaybackrate:   48000,
  stereo:            0,
  usedtx:            0,
  useinbandfec:      1,
  minptime:          10,
  ptime:             20,
};

// =========================================================
export class VoiceCall extends EventTarget {
  constructor({ callId, peer, direction, iceServers }) {
    super();
    this.callId    = callId;
    this.peer      = peer;
    this.direction = direction;                  // 'outgoing' | 'incoming'
    this.iceServers = iceServers || [{ urls: "stun:stun.cloudflare.com:3478" }];

    this.state     = CallState.IDLE;
    this.startedAt = Date.now();
    this.answeredAt = null;
    this.endedAt   = null;
    this.endReason = null;

    this.pc        = null;           // RTCPeerConnection
    this.localStream  = null;
    this.remoteStream = null;
    this.remoteAudioEl = null;
    this._pendingIce = [];           // ICE-Candidates, die vor setRemoteDescription ankamen
    this._statsTimer = null;
    this._lastStats  = { rttMs: null, jitterMs: null, loss: 0, quality: "unknown" };

    // Push-to-Talk
    this._pttEnabled = false;         // ist PTT aktiv?
    this._muted      = false;
    this._pttHeld    = false;
  }

  // ── State machine ──────────────────────────────────────
  setState(next, meta = {}) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    if (next === CallState.CONNECTED && !this.answeredAt) this.answeredAt = meta.answeredAt || Date.now();
    if (next === CallState.ENDED && !this.endedAt)        this.endedAt    = meta.endedAt    || Date.now();
    this.dispatchEvent(new CustomEvent("state", { detail: { prev, next, meta } }));
  }

  markDialing()    { this.setState(CallState.DIALING); }
  markRinging()    { this.setState(CallState.RINGING); }
  markConnecting() { this.setState(CallState.CONNECTING); }
  markConnected(meta = {}) { this.setState(CallState.CONNECTED, meta); }
  markEnded(reason, meta = {}) {
    if (!this.endReason) this.endReason = reason || "hangup";
    this.setState(CallState.ENDED, meta);
    this._teardown();
  }

  get durationMs() {
    if (!this.answeredAt) return 0;
    const end = this.endedAt || Date.now();
    return Math.max(0, end - this.answeredAt);
  }

  // ── Mic + PeerConnection ───────────────────────────────
  async _ensurePC() {
    if (this.pc) return this.pc;
    this.pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceTransportPolicy: "all",
      bundlePolicy: "max-bundle",
    });

    this.pc.addEventListener("icecandidate", (e) => {
      if (e.candidate) {
        this.dispatchEvent(new CustomEvent("icecandidate", { detail: e.candidate.toJSON() }));
      }
    });

    this.pc.addEventListener("iceconnectionstatechange", () => {
      const s = this.pc.iceConnectionState;
      this.dispatchEvent(new CustomEvent("iceState", { detail: s }));
      if (s === "connected" || s === "completed") {
        if (this.state !== CallState.CONNECTED) this.markConnected();
      } else if (s === "failed") {
        // ICE-Restart versuchen (nur einmal, silent)
        if (!this._iceRestartTried) {
          this._iceRestartTried = true;
          try { this.pc.restartIce?.(); } catch {}
        }
      } else if (s === "closed") {
        if (this.state !== CallState.ENDED) this.markEnded("error");
      }
    });

    this.pc.addEventListener("track", (e) => {
      this.remoteStream = e.streams[0] || new MediaStream([e.track]);
      this._attachRemoteAudio();
      this.dispatchEvent(new CustomEvent("remoteTrack", { detail: this.remoteStream }));
    });

    return this.pc;
  }

  async attachLocalAudio(externalStream = null) {
    if (this.localStream) return this.localStream;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia not supported");
    }
    // Externer Stream (z.B. bereits im Click-Handler geholt, damit
    // User-Gesture nicht durch awaits verbraucht wird) hat Vorrang.
    this.localStream = externalStream || await getUserMediaWithFallback();
    const pc = await this._ensurePC();
    for (const track of this.localStream.getAudioTracks()) {
      pc.addTrack(track, this.localStream);
    }
    // Preferred Codec: Opus first
    try {
      const transceiver = pc.getTransceivers().find(t => t.sender?.track?.kind === "audio");
      if (transceiver?.setCodecPreferences && RTCRtpSender.getCapabilities) {
        const caps = RTCRtpSender.getCapabilities("audio");
        const opusFirst = caps?.codecs ? [...caps.codecs].sort((a, b) => {
          const ao = a.mimeType.toLowerCase().endsWith("/opus") ? 0 : 1;
          const bo = b.mimeType.toLowerCase().endsWith("/opus") ? 0 : 1;
          return ao - bo;
        }) : null;
        if (opusFirst) transceiver.setCodecPreferences(opusFirst);
      }
    } catch {}
    return this.localStream;
  }

  _attachRemoteAudio() {
    if (this.remoteAudioEl) return;
    const el = new Audio();
    el.autoplay = true;
    el.playsInline = true;
    el.srcObject = this.remoteStream;
    // Null-Latency-Hint: Jitter-Buffer reduzieren
    try { el.playoutDelayHint = 0.02; } catch {}
    el.play().catch(() => { /* Autoplay blocked → UI setzt es per User-Click fort */ });
    this.remoteAudioEl = el;
  }

  // ── SDP Munging (Opus Tuning) ──────────────────────────
  _munge(sdp) {
    if (!sdp || typeof sdp !== "string") return sdp;
    try {
      const lines = sdp.split("\r\n");
      // Finde Opus Payload-Type in m=audio / a=rtpmap
      let opusPt = null;
      for (const line of lines) {
        const m = line.match(/^a=rtpmap:(\d+)\s+opus\/48000/i);
        if (m) { opusPt = m[1]; break; }
      }
      if (!opusPt) return sdp;

      const fmtpLine = `a=fmtp:${opusPt} ` + Object.entries(OPUS_FMTP)
        .map(([k, v]) => `${k}=${v}`).join(";");

      // Ersetze existierende fmtp-Zeile oder füge neue hinzu
      let replaced = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith(`a=fmtp:${opusPt} `)) {
          lines[i] = fmtpLine;
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        // nach der rtpmap-Zeile einfügen
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].match(new RegExp(`^a=rtpmap:${opusPt}\\s+opus`, "i"))) {
            lines.splice(i + 1, 0, fmtpLine);
            break;
          }
        }
      }

      // Bitrate-Cap (b=AS in kbps)
      const asLine = `b=AS:${Math.round(OPUS_FMTP.maxaveragebitrate / 1000)}`;
      let mIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("m=audio ")) { mIdx = i; break; }
      }
      if (mIdx >= 0) {
        let hasBas = false;
        for (let i = mIdx + 1; i < lines.length && !lines[i].startsWith("m="); i++) {
          if (lines[i].startsWith("b=AS:")) { lines[i] = asLine; hasBas = true; break; }
        }
        if (!hasBas) {
          // nach c= einfügen
          for (let i = mIdx + 1; i < lines.length; i++) {
            if (lines[i].startsWith("c=")) { lines.splice(i + 1, 0, asLine); break; }
          }
        }
      }

      return lines.join("\r\n");
    } catch {
      return sdp;
    }
  }

  // ── Offer/Answer ───────────────────────────────────────
  // `preAcquiredStream` (optional): MediaStream, der bereits im User-Gesture
  // geholt wurde. Wichtig für ältere Browser, wo User-Gesture durch awaits
  // verloren geht — dann zeigt getUserMedia keinen Permission-Dialog mehr.
  async createLocalOffer(preAcquiredStream = null) {
    await this.attachLocalAudio(preAcquiredStream);
    const pc = await this._ensurePC();
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    offer.sdp = this._munge(offer.sdp);
    await pc.setLocalDescription(offer);
    return { type: offer.type, sdp: offer.sdp };
  }

  async createLocalAnswer(preAcquiredStream = null) {
    await this.attachLocalAudio(preAcquiredStream);
    const pc = await this._ensurePC();
    const answer = await pc.createAnswer();
    answer.sdp = this._munge(answer.sdp);
    await pc.setLocalDescription(answer);
    return { type: answer.type, sdp: answer.sdp };
  }

  async applyRemoteOffer(sdp) {
    const pc = await this._ensurePC();
    // Guard: Offer-Doppel-Zustellung überspringen
    const state = pc.signalingState;
    if (state !== "stable" && state !== "have-remote-offer") {
      console.warn("applyRemoteOffer skipped, signalingState =", state);
      return;
    }
    if (state === "have-remote-offer") {
      // bereits gesetzt — Idempotenz
      return;
    }
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await this._flushPendingIce();
  }

  async applyRemoteAnswer(sdp) {
    if (!this.pc) return;
    // Guard: nur setzen wenn PC tatsächlich auf Answer wartet.
    // Vermeidet "wrong state: stable" bei Doppel-Zustellung (mehrere Tabs,
    // mehrere WS-Verbindungen desselben Users).
    const state = this.pc.signalingState;
    if (state !== "have-local-offer") {
      console.warn("applyRemoteAnswer skipped, signalingState =", state);
      return;
    }
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await this._flushPendingIce();
  }

  async addRemoteIce(candidate) {
    if (!candidate) return;
    if (!this.pc || !this.pc.remoteDescription) {
      this._pendingIce.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (e) {
      // Empty/mock candidates werfen → OK
      console.warn("addIceCandidate failed:", e?.message);
    }
  }

  async _flushPendingIce() {
    if (!this.pc || !this._pendingIce.length) return;
    const pending = this._pendingIce.splice(0);
    for (const c of pending) {
      try { await this.pc.addIceCandidate(c); } catch {}
    }
  }

  // ── Mute + PTT ─────────────────────────────────────────
  get muted() { return this._muted; }
  toggleMute() {
    this._muted = !this._muted;
    this._applyMicGate();
    this.dispatchEvent(new CustomEvent("mute", { detail: { muted: this._muted } }));
    return this._muted;
  }

  get pttEnabled() { return this._pttEnabled; }
  setPTT(enabled) {
    this._pttEnabled = !!enabled;
    this._pttHeld = false;
    this._applyMicGate();
    this.dispatchEvent(new CustomEvent("ptt", { detail: { pttEnabled: this._pttEnabled, held: false } }));
  }
  setPTTHeld(held) {
    if (!this._pttEnabled) return;
    this._pttHeld = !!held;
    this._applyMicGate();
    this.dispatchEvent(new CustomEvent("ptt", { detail: { pttEnabled: true, held: this._pttHeld } }));
  }

  _applyMicGate() {
    if (!this.localStream) return;
    // Regel: PTT aus → Mic an (solange nicht muted)
    //        PTT an → Mic nur wenn _pttHeld && !muted
    const shouldBeEnabled = this._pttEnabled
      ? (this._pttHeld && !this._muted)
      : !this._muted;
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = shouldBeEnabled;
    }
  }

  // ── Stats (Gamer-Overlay) ──────────────────────────────
  startStatsPolling(intervalMs = 2000) {
    this.stopStatsPolling();
    this._statsTimer = setInterval(() => this._collectStats().catch(() => {}), intervalMs);
  }
  stopStatsPolling() {
    if (this._statsTimer) clearInterval(this._statsTimer);
    this._statsTimer = null;
  }

  async _collectStats() {
    if (!this.pc) return;
    const stats = await this.pc.getStats();
    let rttMs = null, jitterMs = null, lossPct = null;
    let packetsLost = 0, packetsReceived = 0;

    stats.forEach(r => {
      if (r.type === "remote-inbound-rtp" && r.kind === "audio") {
        if (typeof r.roundTripTime === "number")
          rttMs = Math.round(r.roundTripTime * 1000);
        if (typeof r.jitter === "number")
          jitterMs = Math.round(r.jitter * 1000);
      }
      if (r.type === "inbound-rtp" && r.kind === "audio") {
        packetsLost     += r.packetsLost     || 0;
        packetsReceived += r.packetsReceived || 0;
      }
      if (r.type === "candidate-pair" && r.state === "succeeded" && r.nominated) {
        if (rttMs === null && typeof r.currentRoundTripTime === "number")
          rttMs = Math.round(r.currentRoundTripTime * 1000);
      }
    });
    if (packetsReceived > 0) {
      lossPct = Math.max(0, Math.round((packetsLost / (packetsLost + packetsReceived)) * 100));
    }

    // Quality-Bucket
    let quality = "good";
    if (rttMs !== null) {
      if (rttMs > 200) quality = "bad";
      else if (rttMs > 120) quality = "ok";
    }
    if (lossPct !== null) {
      if (lossPct >= 5) quality = "bad";
      else if (lossPct >= 2 && quality !== "bad") quality = "ok";
    }

    this._lastStats = { rttMs, jitterMs, loss: lossPct, quality };
    this.dispatchEvent(new CustomEvent("stats", { detail: this._lastStats }));
  }

  get lastStats() { return this._lastStats; }

  // ── Teardown ───────────────────────────────────────────
  _teardown() {
    this.stopStatsPolling();
    try { if (this.remoteAudioEl) { this.remoteAudioEl.pause(); this.remoteAudioEl.srcObject = null; this.remoteAudioEl = null; } } catch {}
    try {
      if (this.localStream) {
        for (const t of this.localStream.getTracks()) t.stop();
      }
    } catch {}
    this.localStream = null;
    this.remoteStream = null;
    try {
      if (this.pc) {
        this.pc.onicecandidate = null;
        this.pc.ontrack = null;
        this.pc.close();
      }
    } catch {}
    this.pc = null;
  }

  destroy() {
    this._teardown();
    this.dispatchEvent(new CustomEvent("destroy"));
  }
}
