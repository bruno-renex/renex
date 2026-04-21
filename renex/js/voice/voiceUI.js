// ======================================================
// voiceUI.js — Call-Overlay (Phase 2: Real WebRTC)
//
// Öffentliche API:
//   initVoiceUI()              — einmalig beim App-Start
//   startOutgoingCall(peer)    — Anruf starten (Call-Button / DevTools)
//
// Reagiert auf voice:* Events vom BroadcastChannel und steuert
// den VoiceCall (Mic, RTCPeerConnection) inkl. Offer/Answer,
// ICE-Austausch, Stats-Overlay und Push-to-Talk.
// ======================================================
import {
  voiceBus,
  initVoiceSignalingInbound,
  sendRing,
  sendAnswer,
  sendIce,
  sendDecline,
  sendCancel,
  sendHangup,
  fetchIceServers,
  newCallId,
} from "./voiceSignaling.js";
import { VoiceCall, CallState, getUserMediaWithFallback } from "./voiceClient.js";

// ── Singleton-State ──────────────────────────────────────
let _active   = null;              // VoiceCall | null
let _overlay  = null;
let _inited   = false;
let _ringAudioCtx = null;
let _ringNodes = null;
let _durationTimer = null;
let _iceServersCache = null;

// Nur das oberste Fenster betreibt die Voice-UI. Iframes delegieren
// Call-Start via postMessage an das Parent. So gibt es NIE zwei parallel
// laufende Overlays / Ringtones / PeerConnections für denselben User.
const _isTopWindow = (() => {
  try { return window.top === window.self; } catch { return false; }
})();

// Outbound ICE Queue — zwischen setLocalDescription und dem
// bestätigten /voice/ring (bzw. /voice/answer) feuert der Browser
// bereits die ersten ICE-Candidates. Backend weist sie mit 404 ab
// (voice_state noch nicht gesetzt). Queue puffert sie bis das
// Signaling-Setup bestätigt ist und flusht dann.
let _iceReady  = false;
let _iceQueue  = [];   // Array<candidate>
function resetIceQueue() { _iceReady = false; _iceQueue = []; }
function flushIceQueue(call) {
  _iceReady = true;
  const pending = _iceQueue.splice(0);
  for (const c of pending) {
    sendIce({ to: call.peer, callId: call.callId, candidate: c }).catch(() => {});
  }
}

// ── Text ────────────────────────────────────────────────
const T = {
  incoming:   "Eingehender Anruf",
  calling:    "Rufe an…",
  connecting: "Verbinde…",
  connected:  "Verbunden",
  ended:      "Beendet",
  accept:     "Annehmen",
  decline:    "Ablehnen",
  hangup:     "Auflegen",
  cancel:     "Abbrechen",
  mute:       "Stumm",
  unmute:     "Stumm aus",
  ptt:        "PTT",
  hold:       "Halten",
  busy:       "Besetzt",
  notContact: "Kein Kontakt",
  micDenied:  "Kein Mikrofon-Zugriff — in den Browser-Einstellungen erlauben",
  micNotFound: "Kein Mikrofon gefunden",
  micInUse:    "Mikrofon wird bereits von anderer App genutzt",
  micUnsupported: "Mikrofon wird nicht unterstützt",
  error:      "Fehler",
};

// ── ICE Server Cache ────────────────────────────────────
async function getIceServers() {
  if (_iceServersCache && _iceServersCache.exp > Date.now()) return _iceServersCache.servers;
  const servers = await fetchIceServers();
  _iceServersCache = { servers, exp: Date.now() + 4 * 60 * 1000 };   // 4 min TTL
  return servers;
}

// =========================================================
// Public
// =========================================================
export function initVoiceUI() {
  if (_inited) return;
  _inited = true;

  // Iframe: keine eigene UI. Nur in DevTools als Platzhalter.
  if (!_isTopWindow) {
    window.RenexVoice = Object.freeze({
      startCall: (peer) => {
        // an das Top-Fenster weiterleiten
        try {
          window.top.postMessage(
            { type: "RENEX_VOICE_START_CALL", peer: String(peer || "").toLowerCase() },
            window.location.origin
          );
        } catch {}
        return Promise.resolve();
      },
      get active() { return null; },
      get stats()  { return null; },
    });
    return;
  }

  initVoiceSignalingInbound();
  mountOverlay();

  // DevTools-Zugriff
  window.RenexVoice = Object.freeze({
    startCall: startOutgoingCall,
    get active() { return _active; },
    get stats() { return _active?.lastStats || null; },
  });

  voiceBus.addEventListener("voice:ring",    (e) => onIncomingRing(e.detail));
  voiceBus.addEventListener("voice:answer",  (e) => onPeerAnswer(e.detail));
  voiceBus.addEventListener("voice:ice",     (e) => onPeerIce(e.detail));
  voiceBus.addEventListener("voice:decline", (e) => onPeerEnd(e.detail, "decline"));
  voiceBus.addEventListener("voice:cancel",  (e) => onPeerEnd(e.detail, "cancel"));
  voiceBus.addEventListener("voice:hangup",  (e) => onPeerEnd(e.detail, "hangup"));

  // Nachrichten aus Child-iframes (Chat-Panel) — Call-Start-Requests
  window.addEventListener("message", (ev) => {
    if (ev.origin !== window.location.origin) return;
    if (!ev.data || ev.data.type !== "RENEX_VOICE_START_CALL") return;
    const peer = String(ev.data.peer || "").toLowerCase();
    if (peer) startOutgoingCall(peer).catch(() => {});
  });

  // Deep-Link: /chat/?with=peer&call=1 → Auto-Call starten
  maybeHandleCallDeepLink();

  // PTT Global Hotkey (Space, wenn PTT aktiv)
  window.addEventListener("keydown", onKeydownPtt);
  window.addEventListener("keyup",   onKeyupPtt);
  window.addEventListener("blur",    () => _active?.setPTTHeld?.(false));
}

export async function startOutgoingCall(to) {
  // Delegation ins Top-Fenster wenn aus Iframe gerufen
  if (!_isTopWindow) {
    try {
      window.top.postMessage(
        { type: "RENEX_VOICE_START_CALL", peer: String(to || "").toLowerCase() },
        window.location.origin
      );
    } catch {}
    return;
  }
  if (_active) { console.warn("Voice: bereits in einem Call"); return; }
  const peer = String(to || "").toLowerCase();
  if (!peer) return;

  // ── SCHRITT 1: Mikro-Permission ZUERST — im User-Gesture-Kontext ──
  // Gleiche Begründung wie bei acceptIncoming: alte Browser verlieren die
  // User-Gesture nach async-awaits → Permission-Dialog erscheint nicht.
  let micStream;
  try {
    micStream = await getUserMediaWithFallback();
  } catch (e) {
    console.warn("getUserMedia failed at outgoing", e?.name, e?.message);
    let msg = T.error;
    if (e?.name === "NotAllowedError" || e?.name === "SecurityError") {
      msg = T.micDenied;
    } else if (e?.name === "NotFoundError" || e?.name === "DevicesNotFoundError") {
      msg = T.micNotFound || T.micDenied;
    } else if (e?.name === "NotReadableError" || e?.name === "TrackStartError") {
      msg = T.micInUse || T.micDenied;
    } else if (e?.name === "OverconstrainedError" || e?.name === "ConstraintNotSatisfiedError") {
      msg = T.micUnsupported || T.micDenied;
    }
    // Kein Call aktiv → Toast/Fehlermeldung via kurzzeitigen Placeholder
    // (kein endLocal nötig, da noch kein Overlay aufgebaut wurde)
    try { window.alert(msg); } catch {}
    return;
  }

  const callId = newCallId();
  let iceServers;
  try { iceServers = await getIceServers(); } catch { iceServers = undefined; }

  resetIceQueue();
  const call = new VoiceCall({ callId, peer, direction: "outgoing", iceServers });
  bindCallEvents(call);
  _active = call;
  call.markDialing();
  renderFor(call);
  showOverlay();

  let offer;
  try {
    offer = await call.createLocalOffer(micStream);
  } catch (e) {
    console.warn("createLocalOffer failed", e);
    try { micStream.getTracks().forEach(t => t.stop()); } catch {}
    endLocal("error", T.error);
    return;
  }

  try {
    const res = await sendRing({ to: peer, callId, sdp: offer });
    if (res?.error) {
      const reason =
        res.error === "busy"          ? T.busy :
        res.error === "Not a contact" ? T.notContact :
        T.error;
      endLocal("error", reason);
      return;
    }
    // Backend hat voice_state geschrieben → bisher gepufferte ICE flushen
    flushIceQueue(call);
  } catch (e) {
    console.warn("voice:ring failed", e);
    endLocal("error", T.error);
  }
}

// =========================================================
// Inbound handlers
// =========================================================
async function onIncomingRing(detail) {
  if (_active) {
    // Bereits in Call → direkt busy-Decline
    sendDecline({ callId: detail.callId }).catch(() => {});
    return;
  }
  let iceServers;
  try { iceServers = await getIceServers(); } catch { iceServers = undefined; }

  resetIceQueue();
  // Callee: voice_state wurde vom Backend beim Ring-Handler bereits
  // gesetzt (Seite = "ringing"). ICE darf also sofort fliessen.
  _iceReady = true;

  const call = new VoiceCall({
    callId: detail.callId,
    peer:   String(detail.from || "").toLowerCase(),
    direction: "incoming",
    iceServers,
  });
  bindCallEvents(call);
  _active = call;
  call.markRinging();
  renderFor(call);
  showOverlay();
  startRingtone(/*incoming*/ true);
  setMediaSessionForCall(call);

  // Remote-Offer bereits jetzt setzen (erlaubt frühes Trickle-ICE)
  try { if (detail.sdp) await call.applyRemoteOffer(detail.sdp); } catch (e) {
    console.warn("applyRemoteOffer failed:", e?.message);
  }
}

async function onPeerAnswer(detail) {
  if (!_active || _active.callId !== detail.callId) return;
  _active.markConnecting();
  try {
    if (detail.sdp) await _active.applyRemoteAnswer(detail.sdp);
  } catch (e) {
    console.warn("applyRemoteAnswer failed:", e?.message);
    endLocal("error", T.error);
    return;
  }
  // connected-Event kommt vom iceState-Listener des VoiceCall
  stopRingtone();
}

async function onPeerIce(detail) {
  if (!_active || _active.callId !== detail.callId) return;
  await _active.addRemoteIce(detail.candidate).catch(() => {});
}

function onPeerEnd(detail, reason) {
  if (!_active || _active.callId !== detail.callId) return;
  endLocal(reason);
}

// =========================================================
// Call events → UI
// =========================================================
function bindCallEvents(call) {
  call.addEventListener("icecandidate", (e) => {
    if (!_iceReady) {
      _iceQueue.push(e.detail);
      return;
    }
    sendIce({ to: call.peer, callId: call.callId, candidate: e.detail }).catch(() => {});
  });
  call.addEventListener("state", () => {
    updateOverlay();
    if (call.state === CallState.CONNECTED) {
      startDurationTimer();
      call.startStatsPolling(2000);
      document.getElementById("section-voice")?.classList.add("voice-live");
    } else if (call.state === CallState.ENDED) {
      document.getElementById("section-voice")?.classList.remove("voice-live");
    }
  });
  call.addEventListener("stats", (e) => renderStats(e.detail));
  call.addEventListener("mute", () => updateOverlay());
  call.addEventListener("ptt",  () => updateOverlay());
}

// =========================================================
// End / teardown
// =========================================================
function endLocal(reason, message) {
  if (!_active) return hideOverlay();

  const c = _active;
  c.markEnded(reason);
  stopDurationTimer();
  stopRingtone();
  clearMediaSession();

  renderEnded(c, message);
  resetIceQueue();
  document.getElementById("section-voice")?.classList.remove("voice-live");
  setTimeout(() => {
    if (_active === c) {
      c.destroy();
      _active = null;
      hideOverlay();
    }
  }, reason === "error" ? 1800 : 700);
}

// =========================================================
// DOM Overlay
// =========================================================
function ensureStyles() {
  if (document.getElementById("voice-overlay-css")) return;
  const link = document.createElement("link");
  link.id = "voice-overlay-css";
  link.rel = "stylesheet";
  link.href = "/js/voice/voiceUI.css";
  document.head.appendChild(link);
}

function mountOverlay() {
  if (_overlay) return;
  ensureStyles();
  _overlay = document.createElement("div");
  _overlay.id = "voice-overlay";
  _overlay.setAttribute("role", "dialog");
  _overlay.setAttribute("aria-modal", "true");
  _overlay.setAttribute("aria-hidden", "true");
  _overlay.innerHTML = `
    <div class="vo-backdrop"></div>
    <div class="vo-card">
      <div class="vo-avatar" aria-hidden="true">🎧</div>
      <div class="vo-peer"></div>
      <div class="vo-status"></div>
      <div class="vo-timer" aria-live="polite"></div>
      <div class="vo-stats">
        <span class="vo-stats-dot" aria-hidden="true"></span>
        <span class="vo-stats-text"></span>
      </div>
      <div class="vo-actions"></div>
    </div>
  `;
  document.body.appendChild(_overlay);
}

function showOverlay() { _overlay?.classList.add("visible"); _overlay?.setAttribute("aria-hidden", "false"); }
function hideOverlay() { _overlay?.classList.remove("visible"); _overlay?.setAttribute("aria-hidden", "true"); }

function renderFor(call) {
  if (!_overlay) return;
  _overlay.querySelector(".vo-peer").textContent = call.peer;
  _overlay.querySelector(".vo-stats").classList.remove("visible");
  updateOverlay();
}

function updateOverlay() {
  if (!_overlay || !_active) return;
  const call = _active;
  const statusEl  = _overlay.querySelector(".vo-status");
  const actionsEl = _overlay.querySelector(".vo-actions");
  const timerEl   = _overlay.querySelector(".vo-timer");

  let statusText = "";
  switch (call.state) {
    case CallState.DIALING:    statusText = T.calling; break;
    case CallState.RINGING:    statusText = T.incoming; break;
    case CallState.CONNECTING: statusText = T.connecting; break;
    case CallState.CONNECTED:  statusText = T.connected; break;
    case CallState.ENDED:      statusText = T.ended; break;
  }
  statusEl.textContent = statusText;
  if (call.state !== CallState.CONNECTED) timerEl.textContent = "";

  actionsEl.innerHTML = "";
  if (call.state === CallState.RINGING) {
    actionsEl.append(
      btn("vo-btn-accept",  T.accept,  () => acceptIncoming()),
      btn("vo-btn-decline", T.decline, () => {
        sendDecline({ callId: call.callId }).catch(() => {});
        endLocal("decline");
      }),
    );
  } else if (call.state === CallState.DIALING) {
    actionsEl.append(
      btn("vo-btn-cancel", T.cancel, () => {
        sendCancel({ to: call.peer, callId: call.callId }).catch(() => {});
        endLocal("cancel");
      }),
    );
  } else if (call.state === CallState.CONNECTING || call.state === CallState.CONNECTED) {
    const muteBtn = btn("vo-btn-mute", call.muted ? T.unmute : T.mute, () => {
      call.toggleMute();
    });
    muteBtn.setAttribute("aria-pressed", String(call.muted));

    const pttBtn = btn("vo-btn-ptt", T.ptt + (call.pttEnabled ? " ✓" : ""), () => {
      call.setPTT(!call.pttEnabled);
    });
    pttBtn.setAttribute("aria-pressed", String(call.pttEnabled));
    pttBtn.title = "Push-to-Talk — Leertaste halten zum Sprechen";

    actionsEl.append(
      muteBtn,
      pttBtn,
      btn("vo-btn-hangup", T.hangup, () => {
        sendHangup({ to: call.peer, callId: call.callId }).catch(() => {});
        endLocal("hangup");
      }),
    );

    // Stats sichtbar machen
    _overlay.querySelector(".vo-stats")?.classList.add("visible");
  }
}

function renderEnded(call, message) {
  if (!_overlay) return;
  _overlay.querySelector(".vo-status").textContent = message || T.ended;
  _overlay.querySelector(".vo-actions").innerHTML = "";
}

function renderStats(s) {
  if (!_overlay) return;
  const dot  = _overlay.querySelector(".vo-stats-dot");
  const text = _overlay.querySelector(".vo-stats-text");
  if (!dot || !text) return;
  dot.dataset.quality = s.quality || "unknown";
  const parts = [];
  if (s.rttMs    != null) parts.push(`${s.rttMs} ms`);
  if (s.jitterMs != null) parts.push(`jitter ${s.jitterMs} ms`);
  if (s.loss    != null)  parts.push(`loss ${s.loss}%`);
  text.textContent = parts.join(" · ") || "—";
}

function btn(cls, label, onClick) {
  const b = document.createElement("button");
  b.className = "vo-btn " + cls;
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

// =========================================================
// Accept (Callee)
// =========================================================
async function acceptIncoming() {
  if (!_active || _active.direction !== "incoming") return;
  const call = _active;

  // ── SCHRITT 1: Mikro-Permission ZUERST — im User-Gesture-Kontext ──
  // Ältere Chromium-Versionen (z.B. Brave auf Huawei 2019) verlieren die
  // User-Gesture-Freigabe nach async-awaits und zeigen dann GAR KEINEN
  // Permission-Dialog mehr. Deshalb direkt im Click-Handler anfragen.
  let micStream;
  try {
    micStream = await getUserMediaWithFallback();
  } catch (e) {
    console.warn("getUserMedia failed at accept", e?.name, e?.message);
    let msg = T.error;
    if (e?.name === "NotAllowedError" || e?.name === "SecurityError") {
      msg = T.micDenied;
    } else if (e?.name === "NotFoundError" || e?.name === "DevicesNotFoundError") {
      msg = T.micNotFound || T.micDenied;
    } else if (e?.name === "NotReadableError" || e?.name === "TrackStartError") {
      msg = T.micInUse || T.micDenied;
    } else if (e?.name === "OverconstrainedError" || e?.name === "ConstraintNotSatisfiedError") {
      msg = T.micUnsupported || T.micDenied;
    }
    endLocal("error", msg);
    return;
  }

  call.markConnecting();
  updateOverlay();
  stopRingtone();

  // ── SCHRITT 2: Answer erstellen mit dem bereits geholten Stream ──
  let answer;
  try {
    answer = await call.createLocalAnswer(micStream);
  } catch (e) {
    console.warn("createLocalAnswer failed", e);
    // Stream aufräumen falls answer fehlschlug
    try { micStream.getTracks().forEach(t => t.stop()); } catch {}
    endLocal("error", e?.name === "NotAllowedError" ? T.micDenied : T.error);
    return;
  }

  try {
    const res = await sendAnswer({ callId: call.callId, sdp: answer });
    if (res?.error) { endLocal("error", T.error); return; }
  } catch (e) {
    console.warn("sendAnswer failed", e);
    endLocal("error", T.error);
  }
}

// =========================================================
// Duration
// =========================================================
function startDurationTimer() {
  stopDurationTimer();
  const timerEl = _overlay?.querySelector(".vo-timer");
  if (!timerEl) return;
  const tick = () => {
    if (!_active || _active.state !== CallState.CONNECTED) return;
    const s = Math.floor(_active.durationMs / 1000);
    const m = Math.floor(s / 60);
    timerEl.textContent = `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  tick();
  _durationTimer = setInterval(tick, 1000);
}
function stopDurationTimer() {
  if (_durationTimer) clearInterval(_durationTimer);
  _durationTimer = null;
}

// =========================================================
// Ringtone
// =========================================================
function startRingtone(incoming) {
  try {
    stopRingtone();
    _ringAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _ringAudioCtx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = incoming ? 520 : 440;
    osc.connect(gain);
    osc.start();
    const pattern = incoming ? [[0.40, 0.18], [0.40, 1.50]] : [[0.30, 0.20], [0.30, 1.80]];
    let idx = 0;
    const loop = () => {
      if (!_ringAudioCtx) return;
      const [on, off] = pattern[idx % pattern.length]; idx++;
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(0.0, now);
      gain.gain.linearRampToValueAtTime(incoming ? 0.22 : 0.14, now + 0.02);
      gain.gain.setValueAtTime(incoming ? 0.22 : 0.14, now + on - 0.02);
      gain.gain.linearRampToValueAtTime(0.0, now + on);
      _ringNodes.timer = setTimeout(loop, (on + off) * 1000);
    };
    _ringNodes = { osc, gain, timer: null };
    loop();
  } catch (e) {
    console.warn("Ringtone skipped:", e?.message);
  }
}
function stopRingtone() {
  try {
    if (_ringNodes?.timer) clearTimeout(_ringNodes.timer);
    if (_ringNodes?.osc)   { try { _ringNodes.osc.stop(); } catch {} _ringNodes.osc.disconnect(); }
    if (_ringNodes?.gain)  _ringNodes.gain.disconnect();
  } catch {}
  _ringNodes = null;
  if (_ringAudioCtx && _ringAudioCtx.state !== "closed") _ringAudioCtx.close().catch(() => {});
  _ringAudioCtx = null;
}

// =========================================================
// MediaSession (Lockscreen)
// =========================================================
function setMediaSessionForCall(call) {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title:  call.direction === "incoming" ? T.incoming : T.calling,
      artist: call.peer,
      album:  "RENEX Voice",
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      if (!_active) return;
      if (_active.direction === "incoming" && _active.state === CallState.RINGING) {
        sendDecline({ callId: _active.callId }).catch(() => {});
        endLocal("decline");
      } else {
        sendHangup({ to: _active.peer, callId: _active.callId }).catch(() => {});
        endLocal("hangup");
      }
    });
  } catch {}
}
function clearMediaSession() {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.setActionHandler("pause", null);
  } catch {}
}

// =========================================================
// PTT Hotkey (Space)
// =========================================================
function isTypingTarget(target) {
  if (!target) return false;
  const t = target.tagName;
  if (t === "INPUT" || t === "TEXTAREA" || target.isContentEditable) return true;
  return false;
}
function onKeydownPtt(e) {
  if (!_active?.pttEnabled) return;
  if (e.code !== "Space" && e.key !== " ") return;
  if (isTypingTarget(e.target)) return;
  if (e.repeat) return;
  e.preventDefault();
  _active.setPTTHeld(true);
}
function onKeyupPtt(e) {
  if (!_active?.pttEnabled) return;
  if (e.code !== "Space" && e.key !== " ") return;
  if (isTypingTarget(e.target)) return;
  e.preventDefault();
  _active.setPTTHeld(false);
}

// =========================================================
// Deep-Link (SW → ?call=peer)
// =========================================================
function maybeHandleCallDeepLink() {
  try {
    const u = new URL(window.location.href);
    const peer = u.searchParams.get("call");
    if (!peer) return;
    // Query-Param entfernen, damit Reload nicht nochmal anruft
    u.searchParams.delete("call");
    history.replaceState({}, "", u.toString());
    // Kleine Verzögerung, damit appBoot fertig wird
    setTimeout(() => startOutgoingCall(peer).catch(() => {}), 250);
  } catch {}
}
