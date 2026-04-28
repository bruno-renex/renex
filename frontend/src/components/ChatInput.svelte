<!--
  ChatInput — Textarea + Send-Button + Attachment-Buttons
  Auto-grow textarea, Enter sendet (Shift+Enter = Zeilenumbruch).
-->
<script>
  import { chatStore } from '../stores/chat.svelte.js';
  import { i18nStore } from '../stores/i18n.svelte.js';

  let lang = $derived(i18nStore.lang);

  let text = $state(chatStore.draftText);
  let textareaEl = $state(null);
  let isSending = $state(false);

  // Sync mit Store (bei Chat-Switch)
  $effect(() => {
    text = chatStore.draftText;
  });

  // Sync zurück → Store (für Persistenz beim Switch)
  $effect(() => {
    chatStore.setDraft(text);
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
      await chatStore.sendMessage(text);
      text = "";
    } finally {
      isSending = false;
      textareaEl?.focus();
    }
  }

  function onKeydown(e) {
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      send();
    }
  }

  function onAttach() {
    alert("Attachment — Phase 1A.6 stub. Folgt mit File-Upload-Migration.");
  }

  function onEmoji() {
    alert("Emoji-Picker — Phase 1A.6 stub. Folgt mit Emoji-Migration.");
  }
</script>

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

<style>
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
