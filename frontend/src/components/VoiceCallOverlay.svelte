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
  function onDecline() { voiceStore.endCall(); }
  function onHangup() { voiceStore.endCall(); }
  function onToggleMute() { voiceStore.toggleMute(); }
  function onToggleVideo() { voiceStore.toggleVideo(); }
  function onToggleSpeaker() { voiceStore.toggleSpeaker(); }
</script>

{#if isInCall}
  <div class="voice-overlay" class:incoming-ringing={state === 'ringing' && direction === 'incoming'}>
    <div class="overlay-content">
      <!-- Peer Info -->
      <div class="peer-info">
        <div class="peer-avatar pulse-{state === 'ringing' ? 'on' : 'off'}">
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

          <button
            class="btn-control btn-secondary"
            class:on={voiceStore.isSpeakerOn}
            onclick={onToggleSpeaker}
            aria-label="Speaker"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
            </svg>
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
    </div>
  </div>
{/if}

<style>
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
