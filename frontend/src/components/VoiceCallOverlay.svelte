<!--
  VoiceCallOverlay — Fullscreen-Overlay während aktivem Anruf
  Migration von /renex/js/voice/voiceUI.js (~600 Zeilen Vanilla).

  Phase 1A.6 Skeleton: UI komplett, WebRTC-Integration folgt Phase 1B.
-->
<script>
  import { voiceStore } from '../stores/voice.svelte.js';
  import { i18nStore } from '../stores/i18n.svelte.js';

  let lang = $derived(i18nStore.lang);
  let state = $derived(voiceStore.state);
  let direction = $derived(voiceStore.direction);
  let peer = $derived(voiceStore.peer);
  let isInCall = $derived(voiceStore.isInCall);
  let durationSec = $derived(voiceStore.durationSec);

  // Format duration HH:MM:SS or MM:SS
  let durationStr = $derived.by(() => {
    const s = durationSec;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => n.toString().padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  });

  let initials = $derived.by(() => {
    if (!peer?.displayName && !peer?.handle) return "?";
    return (peer.displayName || peer.handle)
      .replace(/^@/, "")
      .split(/[\s._-]+/)
      .map(p => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  });

  let statusText = $derived.by(() => {
    switch (state) {
      case "ringing":    return direction === "incoming"
                            ? (lang.callIncoming || "Eingehender Anruf…")
                            : (lang.callRinging || "Klingelt…");
      case "connecting": return lang.callConnecting || "Verbindet…";
      case "active":     return durationStr;
      case "ended":      return lang.callEnded || "Beendet";
      default:           return "";
    }
  });

  function onAccept() { voiceStore.acceptCall(); }
  function onDecline() { voiceStore.declineCall(); }
  function onHangup() { voiceStore.endCall(); }
  function onToggleMute() { voiceStore.toggleMute(); }
  function onToggleVideo() { voiceStore.toggleVideo(); }
  function onTogglePtt() { voiceStore.togglePttMode(); }

  // Error-Messages aus dem Store (z.B. 'no_cmk', 'NotAllowedError') sind
  // technisch — User-facing in lesbaren Klartext umsetzen. Fallback auf
  // den Raw-String falls der Code unbekannt ist (developer-debugging).
  function readableError(err) {
    if (!err) return '';
    if (err === 'no_cmk') {
      return lang.voiceErrorNoCmk
        || 'Verschlüsselungsschlüssel mit diesem Kontakt fehlt. Sende erst eine Textnachricht und versuche es danach erneut.';
    }
    if (err === 'busy') {
      return lang.voiceErrorBusy || 'Der Empfänger ist gerade in einem anderen Anruf.';
    }
    if (err === 'ring_failed' || err === 'answer_failed') {
      return lang.voiceErrorSignaling || 'Verbindung zum Server fehlgeschlagen. Bitte erneut versuchen.';
    }
    if (err === 'ice_failed') {
      return lang.voiceErrorIce || 'Audio-Verbindung konnte nicht aufgebaut werden (Netzwerk/Firewall).';
    }
    if (err === 'incompatible_peer') {
      return lang.voiceErrorIncompat || 'Das andere Gerät verwendet eine inkompatible App-Version.';
    }
    if (typeof err === 'string') {
      const lower = err.toLowerCase();
      if (lower.includes('notallowed') || lower.includes('permission')) {
        return lang.voiceErrorPermission
          || 'Mikrofon-Berechtigung fehlt. Bitte in den Browser-Einstellungen erlauben.';
      }
      if (lower.includes('notfound') || lower.includes('devicenotfound')) {
        return lang.voiceErrorNoMic || 'Kein Mikrofon gefunden.';
      }
      if (lower.includes('notreadable') || lower.includes('trackstart')) {
        return lang.voiceErrorMicBusy
          || 'Mikrofon wird von einer anderen App benutzt.';
      }
    }
    return err;
  }

  let pttMode = $derived(voiceStore.pttMode);
  let pttPressed = $derived(voiceStore.pttPressed);
  let isCallActive = $derived(state === 'active' || state === 'connecting');

  // Spacebar-Hold = Push-to-Talk (nur wenn pttMode aktiv + Call läuft).
  // Repeat-Events bei gehaltener Taste werden gefiltert (event.repeat).
  // Wir respect-en Eingabefelder: wenn focus auf input/textarea → space normal eintippen.
  $effect(() => {
    if (!pttMode || !isCallActive) return;
    const isTextInput = (el) => {
      if (!el) return false;
      const tag = el.tagName?.toLowerCase();
      return tag === 'input' || tag === 'textarea' || el.isContentEditable;
    };
    const onKeyDown = (e) => {
      if (e.code !== 'Space' || e.repeat) return;
      if (isTextInput(document.activeElement)) return;
      e.preventDefault();
      voiceStore.setPttPressed(true);
    };
    const onKeyUp = (e) => {
      if (e.code !== 'Space') return;
      if (isTextInput(document.activeElement)) return;
      e.preventDefault();
      voiceStore.setPttPressed(false);
    };
    // Wenn Tab in Hintergrund geht (visibility) → release auch
    const onBlur = () => voiceStore.setPttPressed(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      voiceStore.setPttPressed(false);
    };
  });

  // Touch-Hold-Handler für mobile (PTT-Button)
  function onPttHoldDown(e) {
    e.preventDefault();
    voiceStore.setPttPressed(true);
  }
  function onPttHoldUp(e) {
    e.preventDefault();
    voiceStore.setPttPressed(false);
  }

  // Avatar-Pulse-Effekt aus dem Audio-Level: bei active call zeigt der Avatar
  // wer gerade spricht. remoteLevel = peer redet (peer-avatar pulses).
  // Threshold 0.04 damit Hintergrund-Rauschen nicht ständig pulst.
  let activeAudioLevel = $derived(state === 'active' ? voiceStore.remoteLevel : 0);
  let avatarScale = $derived(1 + Math.min(0.18, activeAudioLevel * 0.4));
  let avatarGlow = $derived(activeAudioLevel > 0.04 ? activeAudioLevel : 0);

  // Remote-Audio-Element: voiceStore pushed neuen MediaStream sobald
  // RTCPeerConnection.ontrack feuert. autoPlay + playsInline für iOS Safari.
  let remoteAudioEl = $state(null);
  let _unsubRemote = null;

  $effect(() => {
    if (!remoteAudioEl) return;
    _unsubRemote = voiceStore.onRemoteStream((stream) => {
      // srcObject ist nicht reactive über Svelte — manuell setzen
      remoteAudioEl.srcObject = stream || null;
      if (stream) {
        // Best effort: bei iOS muss play() nach User-Gesture aufgerufen werden.
        // Da Accept/Start eine User-Action sind, ist der AudioContext schon
        // unlocked — play() sollte ohne NotAllowedError gehen.
        const p = remoteAudioEl.play();
        if (p && typeof p.catch === 'function') {
          p.catch((e) => console.warn('remote audio play() failed:', e?.message));
        }
      }
    });
    return () => {
      if (_unsubRemote) { _unsubRemote(); _unsubRemote = null; }
    };
  });
</script>

{#if isInCall}
  <!-- Remote-Audio: hidden, autoplay sobald srcObject gesetzt wird.
       Liegt außerhalb der visible-card damit es auch bei state-Änderungen erhalten bleibt. -->
  <audio bind:this={remoteAudioEl} autoplay playsinline style="display:none;"></audio>

  <div class="voice-overlay" class:incoming-ringing={state === 'ringing' && direction === 'incoming'}>
    <div class="overlay-content">
      {#if voiceStore.isReconnecting}
        <div class="reconnect-banner">
          <span class="reconnect-spinner"></span>
          {lang.reconnecting || "Verbindung wird wiederhergestellt…"}
        </div>
      {:else if voiceStore.isConnectionDegraded}
        <div class="degraded-banner">
          <span class="reconnect-spinner"></span>
          {lang.connectionDegraded || "Verbindung schwach…"}
        </div>
      {:else if voiceStore.errorMsg?.startsWith?.('mitm_')}
        <!-- Security-Warning: getrennte UI weil semantisch ≠ normaler Fehler.
             fp_mismatch: SDP wurde unterwegs modifiziert.
             bad_signature/no_sigpub: signature konnte nicht verifyt werden. -->
        <div class="mitm-banner">
          {voiceStore.errorMsg.includes('fp_mismatch')
            ? (lang.voiceMitmFp || '🚨 Audio-Verschlüsselung kompromittiert. Anruf abgebrochen.')
            : (lang.voiceMitmSig || '🚨 Anrufer-Signatur ungültig. Anruf abgebrochen.')}
        </div>
      {:else if voiceStore.errorMsg}
        <div class="error-banner">⚠️ {readableError(voiceStore.errorMsg)}</div>
      {/if}
      <!-- Peer Info -->
      <div class="peer-info">
        <div
          class="peer-avatar pulse-{state === 'ringing' ? 'on' : 'off'}"
          class:speaking={avatarGlow > 0}
          style="--avatar-scale: {avatarScale}; --avatar-glow: {avatarGlow};"
        >
          {initials}
        </div>
        <div class="peer-name">{peer?.displayName || peer?.handle || "Unknown"}</div>
        {#if peer?.handle && peer?.displayName}
          <div class="peer-handle">@{peer.handle}</div>
        {/if}
        <div class="status-text" class:active={state === 'active'}>
          {statusText}
        </div>
      </div>

      <!-- Controls -->
      <div class="controls">
        {#if state === 'ringing' && direction === 'incoming'}
          <!-- Incoming Call: Accept + Decline -->
          <button class="btn-control btn-decline" onclick={onDecline} aria-label="Decline">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" transform="rotate(135 12 12)"/>
            </svg>
          </button>
          <button class="btn-control btn-accept" onclick={onAccept} aria-label="Accept">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
            </svg>
          </button>
        {:else if state === 'active' || state === 'connecting'}
          <!-- Active Call: Mute + Video + Speaker + Hangup -->
          <button
            class="btn-control btn-secondary"
            class:on={voiceStore.isMuted}
            onclick={onToggleMute}
            aria-label="Mute"
          >
            {#if voiceStore.isMuted}
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="1" y1="1" x2="23" y2="23"/>
                <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
                <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>
                <line x1="12" y1="19" x2="12" y2="23"/>
              </svg>
            {:else}
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="23"/>
              </svg>
            {/if}
          </button>

          <button
            class="btn-control btn-secondary"
            class:on={voiceStore.isVideoOn}
            onclick={onToggleVideo}
            aria-label="Video"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="23 7 16 12 23 17 23 7"/>
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
            </svg>
          </button>

          <!-- Speaker-Toggle entfernt (B18 / Phase 1B):
               iOS Safari/PWA hat KEINE Browser-API für Earpiece/Loudspeaker-Switch.
               Android Chrome: setSinkId nur für enumerierte Geräte (Headphones, BT),
               nicht für nativen Speaker-Toggle. Re-introduce in Phase 1C+ wenn
               ein echter Device-Picker (BT-Headset etc.) gebaut wird. -->

          <button
            class="btn-control btn-secondary"
            class:on={pttMode}
            onclick={onTogglePtt}
            aria-label={lang.pttToggle || 'Push-to-Talk Modus'}
            title={lang.pttToggle || 'Push-to-Talk Modus'}
          >
            {#if pttMode}
              <!-- Lock-Closed (PTT aktiv = nur sprechen wenn gehalten) -->
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
            {:else}
              <!-- Lock-Open (Open-Mic) -->
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
              </svg>
            {/if}
          </button>

          <button class="btn-control btn-decline" onclick={onHangup} aria-label="Hangup">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" transform="rotate(135 12 12)"/>
            </svg>
          </button>
        {:else if state === 'ringing' && direction === 'outgoing'}
          <!-- Outgoing ringing: only hangup -->
          <button class="btn-control btn-decline" onclick={onHangup} aria-label="Cancel">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" transform="rotate(135 12 12)"/>
            </svg>
          </button>
        {/if}
      </div>

      <!-- Push-to-Talk-Hold-Banner: nur sichtbar wenn PTT aktiv im laufenden Call.
           Spacebar gehalten ODER Touch auf den Banner gehalten = Mic an. -->
      {#if pttMode && isCallActive}
        <button
          class="ptt-hold"
          class:speaking={pttPressed}
          onpointerdown={onPttHoldDown}
          onpointerup={onPttHoldUp}
          onpointerleave={onPttHoldUp}
          oncontextmenu={(e) => e.preventDefault()}
          aria-label={lang.pttHold || 'Halten zum Sprechen'}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
          </svg>
          <span class="ptt-hold-label">
            {pttPressed
              ? (lang.pttSpeaking || 'Aufnahme läuft…')
              : (lang.pttHold || 'Halten zum Sprechen (Leertaste)')}
          </span>
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .error-banner {
    background: rgba(239, 68, 68, 0.15);
    border: 1px solid var(--status-error, #ef4444);
    color: var(--status-error, #ef4444);
    border-radius: 8px;
    padding: 8px 12px;
    margin-bottom: 16px;
    font-size: 13px;
    text-align: center;
  }

  /* Avatar-Pulse aus Audio-Level (#5): Avatar skaliert + glüht mit Peer-Sprachlautstärke.
     CSS-Custom-Properties --avatar-scale (1..1.18) und --avatar-glow (0..1)
     werden inline gesetzt aus voiceStore.remoteLevel. */
  .peer-avatar.speaking {
    transform: scale(var(--avatar-scale, 1));
    box-shadow: 0 0 calc(20px + 30px * var(--avatar-glow, 0)) var(--accent-voice);
    transition: transform 0.06s ease-out, box-shadow 0.06s ease-out;
  }

  /* MITM-Banner: prominenter, persistent — User soll das nicht überlesen */
  .mitm-banner {
    background: var(--status-error, #ef4444);
    border: 2px solid #fff;
    color: #fff;
    border-radius: 10px;
    padding: 14px 16px;
    margin-bottom: 18px;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.4;
    text-align: center;
    box-shadow: 0 0 24px rgba(239, 68, 68, 0.6);
  }

  .reconnect-banner,
  .degraded-banner {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    background: rgba(245, 158, 11, 0.15);
    border: 1px solid var(--status-warning, #f59e0b);
    color: var(--status-warning, #f59e0b);
    border-radius: 8px;
    padding: 8px 12px;
    margin-bottom: 16px;
    font-size: 13px;
  }

  .reconnect-spinner {
    width: 14px;
    height: 14px;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: reconnect-spin 0.8s linear infinite;
  }

  @keyframes reconnect-spin {
    to { transform: rotate(360deg); }
  }

  /* Push-to-Talk Hold-Banner: groß, klar, drückbar */
  .ptt-hold {
    margin: 24px auto 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 80%;
    max-width: 320px;
    min-height: 56px;
    padding: 14px 20px;
    border-radius: 28px;
    border: 2px solid var(--text-muted);
    background: rgba(255, 255, 255, 0.05);
    color: var(--text-secondary);
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
    touch-action: none;  /* iOS Safari long-press hijack vermeiden */
    transition: background 0.1s, border-color 0.1s, color 0.1s, transform 0.05s;
  }

  .ptt-hold:hover {
    border-color: var(--text-secondary);
  }

  .ptt-hold:active,
  .ptt-hold.speaking {
    background: var(--accent-voice);
    border-color: var(--accent-voice);
    color: #07070a;
    transform: scale(0.98);
    box-shadow: 0 0 24px var(--accent-voice);
  }

  .ptt-hold-label {
    font-feature-settings: "tnum";
  }
  .voice-overlay {
    position: fixed;
    inset: 0;
    background: linear-gradient(135deg, #0a0a0d 0%, #14141a 50%, #0f1418 100%);
    z-index: 1500;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fadeIn 0.2s ease-out;
  }

  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  /* Subtle glow background */
  .voice-overlay::before {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(circle at 50% 30%, rgba(56, 189, 248, 0.12) 0%, transparent 60%);
    pointer-events: none;
  }

  /* Pulse-Animation for incoming call */
  .voice-overlay.incoming-ringing::after {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(circle at 50% 30%, rgba(16, 185, 129, 0.15) 0%, transparent 50%);
    animation: ring-pulse 1.5s ease-in-out infinite;
    pointer-events: none;
  }

  @keyframes ring-pulse {
    0%, 100% { opacity: 0.5; }
    50%      { opacity: 1; }
  }

  .overlay-content {
    position: relative;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 60px;
    padding: 40px 24px;
    width: 100%;
    max-width: 420px;
  }

  /* Peer Info */
  .peer-info {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
  }

  .peer-avatar {
    width: 130px;
    height: 130px;
    border-radius: 50%;
    background: var(--bg-panel-alt);
    border: 3px solid var(--accent-voice);
    color: var(--accent-voice);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 44px;
    font-weight: 800;
    text-shadow: 0 0 20px rgba(56, 189, 248, 0.5);
    user-select: none;
  }

  .peer-avatar.pulse-on {
    animation: avatar-pulse 1.4s ease-in-out infinite;
  }

  @keyframes avatar-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.5); }
    50%      { box-shadow: 0 0 0 18px rgba(56, 189, 248, 0); }
  }

  .peer-name {
    font-size: 24px;
    font-weight: 700;
    color: var(--text-primary);
    text-align: center;
  }

  .peer-handle {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 13px;
    color: var(--text-muted);
  }

  .status-text {
    margin-top: 8px;
    font-size: 14px;
    color: var(--text-secondary);
    font-weight: 500;
  }

  .status-text.active {
    color: var(--accent-voice);
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 18px;
    font-weight: 700;
    letter-spacing: 0.05em;
  }

  /* Controls */
  .controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 18px;
    flex-wrap: wrap;
  }

  .btn-control {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.1s, background 0.15s;
  }

  .btn-control:hover { transform: scale(1.05); }
  .btn-control:active { transform: scale(0.95); }

  .btn-secondary {
    background: var(--bg-panel-alt);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
  }

  .btn-secondary:hover {
    background: var(--bg-panel);
  }

  .btn-secondary.on {
    background: var(--accent-voice-dim);
    color: var(--accent-voice);
    border-color: var(--accent-voice);
  }

  .btn-accept {
    background: var(--status-success);
    color: white;
    width: 72px;
    height: 72px;
    box-shadow: 0 0 24px rgba(16, 185, 129, 0.5);
    animation: accept-glow 1.5s ease-in-out infinite;
  }

  @keyframes accept-glow {
    0%, 100% { box-shadow: 0 0 24px rgba(16, 185, 129, 0.5); }
    50%      { box-shadow: 0 0 36px rgba(16, 185, 129, 0.8); }
  }

  .btn-accept:hover { background: #059669; }

  .btn-decline {
    background: var(--status-error);
    color: white;
    width: 72px;
    height: 72px;
    box-shadow: 0 0 24px rgba(239, 68, 68, 0.4);
  }

  .btn-decline:hover { background: #dc2626; }
</style>
