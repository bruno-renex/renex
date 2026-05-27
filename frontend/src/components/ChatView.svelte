<!--
  ChatView — Hauptbereich rechts: Header + Messages + Input
  Empty-State wenn kein Chat ausgewählt.
-->
<script>
  import { chatStore } from '../stores/chat.svelte.js';
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { userStore } from '../stores/user.svelte.js';
  import { autoDeleteStore, autoDeleteLabel } from '../stores/autoDelete.svelte.js';
  import { toastStore } from '../stores/toast.svelte.js';
  import { memberActionsStore } from '../stores/memberActions.svelte.js';
  import { presenceStore } from '../stores/presence.svelte.js';
  import ChatHeader from './ChatHeader.svelte';
  import MessageBubble from './MessageBubble.svelte';
  import ChatInput from './ChatInput.svelte';

  let lang_for_delete = $derived(i18nStore.lang);
  let myHandle = $derived(userStore.myUser);

  // ── Auto-Delete Inline-Banner (DM-Konsens) ─────────────
  // Persistent über den Messages — User muss aktiv akzeptieren oder ablehnen,
  // statt nur einen ephemeren Toast zu sehen. Unterscheidet:
  //  - Empfänger (proposedBy ≠ me): [Akzeptieren] [Ablehnen]
  //  - Sender (proposedBy === me): Wait-Status mit Cancel
  let adSetting = $derived(autoDeleteStore.getFor(chatStore.selectedChat));
  let isPending = $derived(adSetting?.status === 'pending');
  let isPendingFromPeer = $derived(
    isPending && adSetting?.proposedBy && adSetting.proposedBy !== myHandle
  );
  let isPendingByMe = $derived(
    isPending && adSetting?.proposedBy && adSetting.proposedBy === myHandle
  );
  let adBannerBusy = $state(false);

  async function acceptAd() {
    if (adBannerBusy) return;
    adBannerBusy = true;
    try {
      const r = await autoDeleteStore.accept(chatStore.selectedChat);
      if (!r.ok) toastStore.push(r.error || 'Fehler', { kind: 'error' });
    } finally { adBannerBusy = false; }
  }

  async function declineAd() {
    if (adBannerBusy) return;
    adBannerBusy = true;
    try {
      const r = await autoDeleteStore.decline(chatStore.selectedChat);
      if (!r.ok) toastStore.push(r.error || 'Fehler', { kind: 'error' });
    } finally { adBannerBusy = false; }
  }

  async function cancelAd() {
    if (adBannerBusy) return;
    adBannerBusy = true;
    try {
      // Cancel = Sender zieht eigenen Vorschlag zurück. Backend nutzt action='cancel'.
      const r = await autoDeleteStore.decline(chatStore.selectedChat);
      if (!r.ok) toastStore.push(r.error || 'Fehler', { kind: 'error' });
    } finally { adBannerBusy = false; }
  }

  async function handleDelete(msg) {
    const confirmText = lang_for_delete.confirmDelete || 'Diese Nachricht wirklich löschen?';
    if (!confirm(confirmText)) return;
    const r = await chatStore.deleteMessage(msg.id);
    if (!r.ok) {
      alert((lang_for_delete.deleteFailed || 'Löschen fehlgeschlagen') + (r.error ? ': ' + r.error : ''));
    }
  }

  async function handleReact(msg, emoji) {
    await chatStore.toggleReaction(msg.id, emoji);
  }

  /**
   * Springt zur Bubble mit der gegebenen Message-ID, scrollt sie ins Sicht-
   * feld und blitzt sie kurz auf. Wenn die ID nicht in der aktuellen Liste
   * existiert (z.B. zu alte Message außerhalb des geladenen Fensters), no-op.
   */
  function handleJumpTo(msgId) {
    if (!messagesEl) return;
    const target = messagesEl.querySelector(`[data-msg-id="${CSS.escape(msgId)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('jump-highlight');
    setTimeout(() => target.classList.remove('jump-highlight'), 1500);
  }

  let lang = $derived(i18nStore.lang);
  let chat = $derived(chatStore.selectedChat);
  let isGroupLike = $derived(chat?.type === 'group' || chat?.type === 'channel');
  let messages = $derived(chatStore.messages);
  let isLoading = $derived(chatStore.isLoading);
  let pendingJumpTo = $derived(chatStore.pendingJumpTo);

  // ── Decrypt-Pending-Banner ───────────────────────────────
  // Zeigt einen Hinweis wenn Messages persistent verschlüsselt bleiben.
  //
  // DM-Pfad: Multi-Device-Race nach Guest-Convert — A's Device wurde erst
  // hochgeladen NACHDEM B's CMK-Republish schon durch war. B muss kurz online
  // kommen damit sein `cmk_req`-Handler den fehlenden Wrap nachreicht.
  // Banner verschwindet sobald Peer wieder online ist ODER Decrypt klappt.
  //
  // Gruppen-Pfad: Analoger Race auf GSK-Ebene — entweder ein Sender hat seine
  // GSK noch nicht für mein (neues) Device gewrapt, oder die GSK-Migration nach
  // Convert wurde verpasst (GUEST_CONVERTED-WS-Event verloren).
  // Banner ohne Online-Check (kein einzelner Peer in Group).
  let hasPendingEncrypted = $derived(
    messages.some(m => m.e2e && m.text === '🔐 …')
  );
  let peerIsOnline = $derived(
    chat?.type === 'dm' && chat?.peer ? presenceStore.isOnline(chat.peer) : false
  );
  let showCmkPendingBanner = $derived(
    hasPendingEncrypted && (isGroupLike || (chat?.type === 'dm' && !peerIsOnline))
  );

  let messagesEl = $state(null);

  // Auto-scroll to bottom on new message — aussetzen wenn ein Jump aktiv ist,
  // sonst kämpft scrollTop = scrollHeight gegen das scrollIntoView vom Jump-Effect.
  $effect(() => {
    const _ = messages.length;
    if (pendingJumpTo) return;
    if (messagesEl) {
      setTimeout(() => {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }, 50);
    }
  });

  // Jump-to-Message via toast.action (z.B. Reaktions-Toast): pendingJumpTo wird
  // im chatStore gesetzt, ChatView wartet bis das Bubble-Element im DOM ist.
  // Triggert auf jede messages-Mutation — falls /chat/list noch lädt und das Target
  // im ersten Tick nicht da ist, fired der Effect beim nächsten Update erneut.
  $effect(() => {
    const target = pendingJumpTo;
    const _len = messages.length;
    if (!target || !messagesEl) return;
    const id = setTimeout(() => {
      const el = messagesEl?.querySelector(`[data-msg-id="${CSS.escape(target)}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('jump-highlight');
      setTimeout(() => el.classList.remove('jump-highlight'), 1500);
      chatStore.clearPendingJump();
    }, 80);
    return () => clearTimeout(id);
  });

  // Group messages by date for divider
  let groupedMessages = $derived.by(() => {
    const result = [];
    const seenIds = new Set();
    let lastDate = null;
    for (const msg of messages) {
      if (msg.id && seenIds.has(msg.id)) continue;
      if (msg.id) seenIds.add(msg.id);
      const d = new Date(msg.ts);
      const dateStr = d.toLocaleDateString("de-CH", { day: "numeric", month: "short", year: "numeric" });
      if (dateStr !== lastDate) {
        result.push({ type: "date", id: "date-" + dateStr, dateStr });
        lastDate = dateStr;
      }
      result.push({ type: "msg", ...msg });
    }
    return result;
  });
</script>

<main class="chat-view">
  {#if !chat}
    <!-- Empty state -->
    <div class="empty-state">
      <div class="empty-icon">💬</div>
      <h2>{lang.selectChatHint || "Wähle einen Chat"}</h2>
      <p class="hint">{lang.selectChatHintSub || "Klicke auf einen Kontakt links um den Chat zu öffnen."}</p>
    </div>
  {:else}
    <ChatHeader />

    {#if isPendingFromPeer}
      <div class="ad-banner ad-banner-incoming" role="region" aria-label="Auto-Delete Vorschlag">
        <div class="ad-banner-icon">⏱</div>
        <div class="ad-banner-body">
          <div class="ad-banner-title">
            <strong>@{adSetting.proposedBy}</strong>
            {lang.autoDeleteProposalIncoming || 'schlägt Auto-Delete vor:'}
            <strong>{autoDeleteLabel(adSetting.days, lang)}</strong>
          </div>
          <div class="ad-banner-actions">
            <button class="ad-btn ok" onclick={acceptAd} disabled={adBannerBusy}>
              {lang.accept || 'Akzeptieren'}
            </button>
            <button class="ad-btn no" onclick={declineAd} disabled={adBannerBusy}>
              {lang.decline || 'Ablehnen'}
            </button>
          </div>
        </div>
      </div>
    {:else if isPendingByMe}
      <div class="ad-banner ad-banner-outgoing" role="status">
        <div class="ad-banner-icon">📤</div>
        <div class="ad-banner-body">
          <div class="ad-banner-title">
            {(lang.autoDeleteWaitingForPeer || 'Wartet auf Bestätigung:')}
            <strong>{autoDeleteLabel(adSetting.days, lang)}</strong>
          </div>
        </div>
        <button class="ad-btn-small" onclick={cancelAd} disabled={adBannerBusy} title={lang.cancel || 'Abbrechen'}>
          ✕
        </button>
      </div>
    {/if}

    {#if showCmkPendingBanner}
      <div class="cmk-pending-banner" role="status" aria-live="polite">
        <div class="cmk-pending-icon">🔐</div>
        <div class="cmk-pending-body">
          {#if chat.type === 'dm'}
            {(lang.cmkPendingBanner || 'Einige Nachrichten sind noch verschlüsselt. ')}
            <strong>@{chat.peer}</strong>
            {(lang.cmkPendingBannerSuffix || 'muss kurz online kommen — der fehlende Schlüssel lädt dann automatisch nach.')}
          {:else}
            {(lang.cmkPendingBannerGroup || 'Einige Nachrichten sind noch verschlüsselt. Sobald die Absender kurz online kommen, lädt der fehlende Schlüssel automatisch nach.')}
          {/if}
        </div>
      </div>
    {/if}

    <div class="messages-wrapper" bind:this={messagesEl}>
      {#if isLoading}
        <div class="loading">
          <span class="spinner"></span>
        </div>
      {:else if messages.length === 0}
        <div class="empty-chat">
          <p>{lang.noMessagesYet || "Noch keine Nachrichten"}</p>
          <p class="hint-sm">{lang.startConversation || "Schreibe die erste Nachricht 👋"}</p>
        </div>
      {:else}
        {#each groupedMessages as item (item.id)}
          {#if item.type === "date"}
            <div class="date-divider">
              <span>{item.dateStr}</span>
            </div>
          {:else}
            <MessageBubble
              message={item}
              showSender={isGroupLike}
              myHandle={myHandle}
              onReply={(m) => chatStore.setReplyingTo(m)}
              onEdit={(m) => chatStore.setEditing(m)}
              onDelete={(m) => handleDelete(m)}
              onReact={(m, e) => handleReact(m, e)}
              onJumpTo={handleJumpTo}
              onSenderClick={isGroupLike
                ? (handle) => memberActionsStore.open(handle)
                : null}
            />
          {/if}
        {/each}
      {/if}
    </div>

    <ChatInput />
  {/if}
</main>

<style>
  .chat-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg-body);
    min-width: 0;
  }

  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: var(--text-muted);
    padding: 24px;
    text-align: center;
  }

  .empty-icon {
    font-size: 56px;
    opacity: 0.4;
    margin-bottom: 8px;
  }

  .empty-state h2 {
    font-size: 18px;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .hint {
    font-size: 13px;
    color: var(--text-muted);
    max-width: 320px;
  }

  .messages-wrapper {
    flex: 1;
    overflow-y: auto;
    padding: 14px 0 6px;
    display: flex;
    flex-direction: column;
  }

  .loading {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 60px;
  }

  .spinner {
    width: 28px;
    height: 28px;
    border: 3px solid var(--border-panel);
    border-top-color: var(--accent-voice);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .empty-chat {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 60px 24px;
    text-align: center;
    color: var(--text-muted);
  }

  .hint-sm {
    font-size: 12px;
    opacity: 0.7;
  }

  .date-divider {
    display: flex;
    justify-content: center;
    margin: 14px 0 8px;
  }

  .date-divider span {
    background: var(--bg-panel);
    border: 1px solid var(--border-subtle);
    color: var(--text-muted);
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 10px;
    font-weight: 600;
  }

  /* ── CMK-Pending-Hinweis (Multi-Device-Race nach Convert) ───── */
  .cmk-pending-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--bg-panel-alt);
    flex-shrink: 0;
    font-size: 12.5px;
    line-height: 1.4;
    color: var(--text-secondary);
  }
  .cmk-pending-icon {
    font-size: 18px;
    flex-shrink: 0;
    opacity: 0.85;
  }
  .cmk-pending-body {
    flex: 1;
    min-width: 0;
  }
  .cmk-pending-body strong {
    color: var(--text-primary);
    font-weight: 600;
  }

  /* ── Auto-Delete Inline-Banner ─────────────────────── */
  .ad-banner {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
    font-size: 13px;
  }
  .ad-banner-incoming {
    background: var(--accent-voice-dim);
    border-bottom-color: var(--accent-voice);
  }
  .ad-banner-outgoing {
    background: var(--bg-panel-alt);
  }
  .ad-banner-icon {
    font-size: 20px;
    flex-shrink: 0;
  }
  .ad-banner-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ad-banner-title {
    color: var(--text-primary);
    line-height: 1.35;
  }
  .ad-banner-title strong {
    color: var(--accent-voice);
    font-weight: 700;
  }
  .ad-banner-actions {
    display: flex;
    gap: 8px;
  }
  .ad-btn {
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-panel);
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }
  .ad-btn:hover:not(:disabled) {
    background: var(--bg-panel-alt);
  }
  .ad-btn:disabled {
    opacity: 0.5;
    cursor: wait;
  }
  .ad-btn.ok {
    border-color: var(--accent-voice);
    color: var(--accent-voice);
  }
  .ad-btn.ok:hover:not(:disabled) {
    background: var(--accent-voice);
    color: var(--bg-body);
  }
  .ad-btn.no {
    border-color: var(--status-error);
    color: var(--status-error);
  }
  .ad-btn.no:hover:not(:disabled) {
    background: rgba(239, 68, 68, 0.08);
  }
  .ad-btn-small {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .ad-btn-small:hover:not(:disabled) {
    background: var(--bg-panel);
    color: var(--text-primary);
  }
</style>
