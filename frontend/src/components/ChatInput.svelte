<!--
  ChatInput — Textarea + Send-Button + Attachment-Buttons
  Auto-grow textarea, Enter sendet (Shift+Enter = Zeilenumbruch).
-->
<script>
  import { chatStore } from '../stores/chat.svelte.js';
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { profileCache } from '../stores/profileCache.svelte.js';

  let replyAuthorName = $derived(
    chatStore.replyingTo?.from
      ? (profileCache.get(chatStore.replyingTo.from) || chatStore.replyingTo.from)
      : ''
  );

  let lang = $derived(i18nStore.lang);

  let text = $state(chatStore.draftText);
  let textareaEl = $state(null);
  let isSending = $state(false);
  // Tracking für Draft-Restore beim Edit-Cancel: Edit überschreibt draftText, beim
  // Verlassen des Edit-Modes wollen wir den vorherigen Draft wiederherstellen.
  let _draftBeforeEdit = '';

  // Edit-Mode-Init: NUR beim Übergang in den Edit-Mode eines bestimmten Messages
  // den Original-Text vor-laden. WICHTIG: kein direktes `text !== originalText`-
  // Check als Trigger — sonst feuert der Effect bei jedem Tastendruck (Text ändert
  // sich → Effect rennt → setzt text auf originalText zurück → User-Edits weg).
  // Stattdessen: per-msg-id-Trigger, der nur einmal pro Edit-Session feuert.
  let _lastSeenEditId = null;
  $effect(() => {
    const cur = chatStore.editingMsg;
    if (cur && cur.id !== _lastSeenEditId) {
      _draftBeforeEdit = text;
      text = cur.originalText;
      _lastSeenEditId = cur.id;
      // Auto-Focus + Cursor ans Ende
      setTimeout(() => {
        if (textareaEl) {
          textareaEl.focus();
          textareaEl.setSelectionRange(text.length, text.length);
        }
      }, 30);
    } else if (!cur && _lastSeenEditId) {
      // Edit-Mode beendet (cancel oder save) — beim nächsten setEditing wieder triggern
      _lastSeenEditId = null;
    }
  });

  // Sync zurück → Store (für Persistenz beim Switch — aber NICHT während Edit-Mode,
  // sonst würde der Draft mit dem Edit-Originaltext überschrieben).
  $effect(() => {
    if (!chatStore.editingMsg) chatStore.setDraft(text);
  });

  // Auto-grow Textarea
  $effect(() => {
    if (textareaEl) {
      textareaEl.style.height = "auto";
      textareaEl.style.height = Math.min(textareaEl.scrollHeight, 140) + "px";
    }
  });

  let canSend = $derived(text.trim().length > 0 && !isSending);

  async function send() {
    if (!canSend) return;
    isSending = true;
    try {
      if (chatStore.editingMsg) {
        // Edit-Path: kein neuer Send, sondern Update der Original-Message
        const editId = chatStore.editingMsg.id;
        const newText = text.trim();
        if (newText === chatStore.editingMsg.originalText) {
          // No-op Edit — einfach Edit-Mode verlassen
          chatStore.clearEditing();
          text = _draftBeforeEdit;
          _draftBeforeEdit = '';
          return;
        }
        const r = await chatStore.editMessage(editId, newText);
        if (r.ok) {
          chatStore.clearEditing();
          text = _draftBeforeEdit;
          _draftBeforeEdit = '';
        } else {
          alert((lang.editFailed || 'Bearbeiten fehlgeschlagen') + (r.error ? ': ' + r.error : ''));
        }
      } else {
        await chatStore.sendMessage(text);
        text = "";
      }
    } finally {
      isSending = false;
      textareaEl?.focus();
    }
  }

  function cancelEdit() {
    chatStore.clearEditing();
    text = _draftBeforeEdit;
    _draftBeforeEdit = '';
    textareaEl?.focus();
  }

  function onKeydown(e) {
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      if (chatStore.editingMsg) {
        e.preventDefault();
        cancelEdit();
      } else if (chatStore.replyingTo) {
        e.preventDefault();
        chatStore.clearReplyingTo();
      }
    }
  }

  function onAttach() {
    alert("Attachment — Phase 1A.6 stub. Folgt mit File-Upload-Migration.");
  }

  function onEmoji() {
    alert("Emoji-Picker — Phase 1A.6 stub. Folgt mit Emoji-Migration.");
  }
</script>

<div class="chat-input-wrap">
{#if chatStore.editingMsg}
  <div class="reply-banner edit-mode">
    <div class="reply-banner-bar"></div>
    <div class="reply-banner-body">
      <div class="reply-banner-label">{lang.editingMessage || "Bearbeiten"}</div>
      <div class="reply-banner-text">{chatStore.editingMsg.originalText}</div>
    </div>
    <button class="reply-banner-cancel" onclick={cancelEdit} title={lang.cancel || "Abbrechen"} aria-label={lang.cancel || "Abbrechen"}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  </div>
{:else if chatStore.replyingTo}
  <div class="reply-banner">
    <div class="reply-banner-bar"></div>
    <div class="reply-banner-body">
      <div class="reply-banner-label">{lang.replyingTo || "Antwort an"} <strong>{replyAuthorName}</strong></div>
      <div class="reply-banner-text">{chatStore.replyingTo.text}</div>
    </div>
    <button class="reply-banner-cancel" onclick={() => chatStore.clearReplyingTo()} title={lang.cancel || "Abbrechen"} aria-label={lang.cancel || "Abbrechen"}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  </div>
{/if}
<div class="chat-input">
  <button class="icon-btn" onclick={onAttach} title="Attach file" aria-label="Attach file">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
    </svg>
  </button>

  <button class="icon-btn" onclick={onEmoji} title="Emoji" aria-label="Emoji">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
      <line x1="9" y1="9" x2="9.01" y2="9"/>
      <line x1="15" y1="9" x2="15.01" y2="9"/>
    </svg>
  </button>

  <textarea
    bind:this={textareaEl}
    bind:value={text}
    onkeydown={onKeydown}
    placeholder={lang.messagePlaceholder || "Nachricht schreiben…"}
    rows="1"
    autocomplete="off"
    autocorrect="off"
    autocapitalize="sentences"
    spellcheck="true"
    disabled={isSending}
  ></textarea>

  <button
    class="send-btn"
    class:active={canSend}
    onclick={send}
    disabled={!canSend}
    title="Send"
    aria-label="Send"
  >
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="22" y1="2" x2="11" y2="13"/>
      <polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg>
  </button>
</div>
</div>

<style>
  .chat-input-wrap {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }

  .reply-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    background: var(--bg-panel);
    border-top: 1px solid var(--border-subtle);
  }

  .reply-banner-bar {
    width: 3px;
    align-self: stretch;
    background: var(--accent-voice);
    border-radius: 2px;
    flex-shrink: 0;
  }

  .reply-banner.edit-mode .reply-banner-bar {
    background: var(--status-warning, #f59e0b);
  }

  .reply-banner.edit-mode .reply-banner-label {
    color: var(--status-warning, #f59e0b);
    font-weight: 600;
  }

  .reply-banner-body {
    flex: 1;
    min-width: 0;
  }

  .reply-banner-label {
    font-size: 11px;
    color: var(--text-muted);
    margin-bottom: 1px;
  }

  .reply-banner-label strong {
    color: var(--accent-voice);
    font-weight: 700;
  }

  .reply-banner-text {
    font-size: 12px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .reply-banner-cancel {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: all 0.15s;
  }

  .reply-banner-cancel:hover {
    background: var(--bg-panel-alt);
    color: var(--text-primary);
  }

  .chat-input {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    padding: 10px 14px;
    border-top: 1px solid var(--border-subtle);
    background: var(--bg-panel);
    flex-shrink: 0;
  }

  .icon-btn {
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
    flex-shrink: 0;
    transition: all 0.15s;
  }

  .icon-btn:hover {
    background: var(--bg-panel-alt);
    color: var(--text-primary);
  }

  textarea {
    flex: 1;
    min-height: 36px;
    max-height: 140px;
    padding: 8px 14px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 18px;
    color: var(--text-primary);
    font-size: 14px;
    font-family: inherit;
    line-height: 1.4;
    resize: none;
    overflow-y: auto;
  }

  textarea::placeholder {
    color: var(--text-muted);
  }

  textarea:focus {
    border-color: var(--accent-voice);
  }

  .send-btn {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: none;
    background: var(--bg-panel-alt);
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: all 0.15s;
  }

  .send-btn.active {
    background: var(--accent-voice);
    color: #07070a;
  }

  .send-btn.active:hover {
    background: #0ea5e9;
  }

  .send-btn:disabled {
    cursor: not-allowed;
  }
</style>
