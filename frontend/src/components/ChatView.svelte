<!--
  ChatView — Hauptbereich rechts: Header + Messages + Input
  Empty-State wenn kein Chat ausgewählt.
-->
<script>
  import { chatStore } from '../stores/chat.svelte.js';
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { userStore } from '../stores/user.svelte.js';
  import ChatHeader from './ChatHeader.svelte';
  import MessageBubble from './MessageBubble.svelte';
  import ChatInput from './ChatInput.svelte';

  let lang_for_delete = $derived(i18nStore.lang);
  let myHandle = $derived(userStore.myUser);

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
  let messages = $derived(chatStore.messages);
  let isLoading = $derived(chatStore.isLoading);

  let messagesEl = $state(null);

  // Auto-scroll to bottom on new message
  $effect(() => {
    // Track length to retrigger
    const _ = messages.length;
    if (messagesEl) {
      // Wait for DOM update
      setTimeout(() => {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }, 50);
    }
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
              showSender={chat.type === "group"}
              myHandle={myHandle}
              onReply={(m) => chatStore.setReplyingTo(m)}
              onEdit={(m) => chatStore.setEditing(m)}
              onDelete={(m) => handleDelete(m)}
              onReact={(m, e) => handleReact(m, e)}
              onJumpTo={handleJumpTo}
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
</style>
