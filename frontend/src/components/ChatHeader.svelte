<!--
  ChatHeader — Top-Bar des Chat-Views
  Shows peer-info, Voice/Video-Call-Buttons, Back-Button (Mobile).
-->
<script>
  import { chatStore } from '../stores/chat.svelte.js';
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { voiceStore } from '../stores/voice.svelte.js';
  import { profileCache } from '../stores/profileCache.svelte.js';
  import { isGuestHandle, guestDisplayName } from '../lib/guestNames.js';
  import ChatHeaderMenu from './ChatHeaderMenu.svelte';

  let lang = $derived(i18nStore.lang);
  let chat = $derived(chatStore.selectedChat);

  // Display-Name reaktiv aus profileCache ziehen — überschreibt das beim selectChat
  // gesetzte chat.name sobald der Fetch zurückkommt. Gruppen behalten ihren Namen.
  let displayName = $derived.by(() => {
    if (!chat) return null;
    if (chat.type === 'dm' && chat.peer) {
      // Gast → deterministischer „Guest Blue Eagle"-Name (kein Backend-Lookup nötig)
      if (isGuestHandle(chat.peer)) return guestDisplayName(chat.peer);
      return profileCache.get(chat.peer);
    }
    return null;
  });

  let headerName = $derived.by(() => {
    if (chat?.type !== 'dm' || !chat.peer) return chat?.name || '';
    // Gast: nur den hübschen Namen zeigen, nicht @guest_3a7f… anhängen
    if (isGuestHandle(chat.peer)) return displayName || guestDisplayName(chat.peer);
    return displayName ? `${displayName} · @${chat.peer}` : `@${chat.peer}`;
  });

  let initials = $derived.by(() => {
    const src = displayName || chat?.peer || chat?.name || '';
    if (!src) return "?";
    return src
      .replace(/^@/, "")
      .replace(/^Guest /, "")  // "Guest Blue Eagle" → "BE" statt "GB"
      .split(/[\s._-]+/)
      .map(p => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  });

  function onClose() {
    chatStore.selectChat(null);
  }

  function onCall() {
    if (!chat || chat.type !== "dm") return;
    voiceStore.startCall({
      handle: chat.peer || chat.key,
      displayName: displayName || null,
    }, { withVideo: false });
  }

  function onVideoCall() {
    if (!chat || chat.type !== "dm") return;
    voiceStore.startCall({
      handle: chat.peer || chat.key,
      displayName: displayName || null,
    }, { withVideo: true });
  }
</script>

{#if chat}
  <header class="chat-header">
    <button class="back-btn" onclick={onClose} title="Back" aria-label="Close chat">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 18l-6-6 6-6"/>
      </svg>
    </button>

    <div class="avatar" class:group={chat.type === 'group'}>
      {#if chat.type === 'group'}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
      {:else}
        {initials}
      {/if}
    </div>

    <div class="info">
      <div class="name">{headerName}</div>
      <div class="status">
        {#if chat.type === 'group'}
          {chat.memberCount || 0} {lang.members || "Mitglieder"}
        {:else if chat.isOnline}
          <span class="online-dot"></span>
          {lang.online || "Online"}
        {:else}
          {lang.offline || "Offline"}
        {/if}
      </div>
    </div>

    <div class="actions">
      {#if chat.type === 'dm'}
        <button class="action-btn" onclick={onCall} title="Voice call" aria-label="Voice call">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
          </svg>
        </button>
        <button class="action-btn" onclick={onVideoCall} title="Video call" aria-label="Video call">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="23 7 16 12 23 17 23 7"/>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
          </svg>
        </button>
      {/if}
      <ChatHeaderMenu {chat} />
    </div>
  </header>
{/if}

<style>
  .chat-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--bg-panel);
    flex-shrink: 0;
  }

  .back-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 6px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }

  .back-btn:hover {
    background: var(--bg-panel-alt);
    color: var(--text-primary);
  }

  .avatar {
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    color: var(--text-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 13px;
    flex-shrink: 0;
  }

  .avatar.group {
    color: var(--accent-voice);
    background: var(--accent-voice-dim);
    border-color: var(--accent-voice);
  }

  .info {
    flex: 1;
    min-width: 0;
  }

  .name {
    font-size: 14px;
    font-weight: 700;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .status {
    font-size: 11px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 2px;
  }

  .online-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--status-success);
  }

  .actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .action-btn {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }

  .action-btn:hover {
    background: var(--accent-voice-dim);
    color: var(--accent-voice);
  }
</style>
