<!--
  ChatInput — Textarea + Send-Button + Attachment-Buttons
  Auto-grow textarea, Enter sendet (Shift+Enter = Zeilenumbruch).
-->
<script>
  import { onDestroy } from 'svelte';
  import { chatStore } from '../stores/chat.svelte.js';
  import { pulseStore } from '../stores/pulseStore.svelte.js';
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { profileCache } from '../stores/profileCache.svelte.js';
  import { toastStore } from '../stores/toast.svelte.js';
  import { uploadAttachment } from '../lib/uploadHelper.js';
  import { captureException } from '../lib/sentry.js';
  import GifPickerModal from './GifPickerModal.svelte';

  let replyAuthorName = $derived(
    chatStore.replyingTo?.from
      ? (profileCache.get(chatStore.replyingTo.from) || chatStore.replyingTo.from)
      : ''
  );

  let lang = $derived(i18nStore.lang);

  let text = $state(chatStore.draftText);
  let textareaEl = $state(null);
  let isSending = $state(false);
  let _focused = $state(false);   // Composer fokussiert? (Thinking Pulse)
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

  // Thinking Pulse: „komponiere gerade" = Composer fokussiert + Entwurf nicht leer.
  // Setzt nur ein lokales Flag; der Pulse-Controller hält dann den Energie-Boden,
  // solange formuliert wird (Denkpausen sacken nicht auf calm ab). KEIN Text/Flag
  // geht über die Leitung — nur der abstrakte Energie-Skalar (wie immer).
  $effect(() => {
    pulseStore.setComposing(_focused && text.trim().length > 0);
  });
  onDestroy(() => pulseStore.setComposing(false));

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

  // Hidden file inputs — werden via JS getriggert, sodass wir je nach Button
  // den richtigen accept-Filter setzen können.
  let photoInputEl  = $state(null);
  let cameraInputEl = $state(null);   // Mobile only: capture="environment"
  let fileInputEl   = $state(null);
  let isUploading   = $state(false);

  // Touch-Detection: pointer:coarse → Phone/Tablet (echte Kamera vorhanden + capture funktioniert).
  // Auf Desktop wird "Aufnehmen" nicht gezeigt (capture wird ignoriert → wäre derselbe Picker).
  let isTouchDevice = $state(false);
  $effect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(pointer: coarse)');
    isTouchDevice = mq.matches;
    const onChange = (e) => { isTouchDevice = e.matches; };
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  });

  // Attach-Sheet (Plus-Button → Photo / Camera / Document / GIF). Mobile + Desktop.
  let attachSheetOpen = $state(false);
  let attachAnchorEl  = $state(null);

  function toggleAttachSheet() { attachSheetOpen = !attachSheetOpen; }
  function closeAttachSheet()  { attachSheetOpen = false; }

  function onAttachPhoto()  { closeAttachSheet(); photoInputEl?.click(); }
  function onAttachCamera() { closeAttachSheet(); cameraInputEl?.click(); }
  function onAttachFile()   { closeAttachSheet(); fileInputEl?.click(); }

  // Click-outside + Escape für Attach-Sheet
  $effect(() => {
    if (!attachSheetOpen) return;
    const onClick = (e) => {
      if (attachAnchorEl && !attachAnchorEl.contains(e.target)) closeAttachSheet();
    };
    const onKey = (e) => { if (e.key === 'Escape') closeAttachSheet(); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  });

  // ── Drag & Drop (Desktop) ────────────────────────────
  // Drop-Zone = .chat-input-wrap. MIME-Detection: image/* → photo, sonst → file.
  // dragCounter zählt Enter/Leave-Events, weil dragleave auch beim Hover über
  // Kind-Elementen feuert. Erst bei counter=0 isDragging = false.
  let isDragging = $state(false);
  let _dragCounter = 0;

  function onDragEnter(e) {
    if (!_hasFiles(e)) return;
    e.preventDefault();
    _dragCounter++;
    isDragging = true;
  }
  function onDragOver(e) {
    if (!_hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
  function onDragLeave(e) {
    if (!_hasFiles(e)) return;
    _dragCounter = Math.max(0, _dragCounter - 1);
    if (_dragCounter === 0) isDragging = false;
  }
  function onDrop(e) {
    if (!_hasFiles(e)) return;
    e.preventDefault();
    _dragCounter = 0;
    isDragging = false;
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const kind = (file.type || '').startsWith('image/') ? 'photo' : 'file';
    void _handlePicked(file, kind);
  }

  function _hasFiles(e) {
    const dt = e.dataTransfer;
    if (!dt) return false;
    if (dt.types && dt.types.includes && dt.types.includes('Files')) return true;
    return Array.from(dt.types || []).includes('Files');
  }

  function _errMsg(code) {
    switch (code) {
      case 'file_too_large':    return lang.attachmentTooLarge   || 'Datei zu groß (max. 10 MB).';
      case 'mime_not_allowed':  return lang.attachmentMimeBlocked || 'Dateityp nicht erlaubt.';
      case 'extension_blocked': return lang.attachmentExtBlocked || 'Dateiendung nicht erlaubt.';
      case 'rate_limit':        return lang.attachmentRateLimit  || 'Zu viele Uploads — bitte warten.';
      default:                  return lang.attachmentUploadFailed || 'Upload fehlgeschlagen.';
    }
  }

  async function _handlePicked(file, attachmentType) {
    if (!file) return;
    const chat = chatStore.selectedChat;
    if (!chat) return;
    // convoId herleiten: DM = "alphabetisch sortiert", Group/Channel = chat.key (UUID)
    const isGroupLike = chat.type === 'group' || chat.type === 'channel';
    const me = isGroupLike ? null : (chatStore.selectedChat?.peer);
    const myUser = (typeof localStorage !== 'undefined' ? localStorage.getItem('my_user') : '')?.toLowerCase();
    let convoId;
    if (isGroupLike) {
      convoId = chat.key;
    } else {
      const peer = (chat.peer || chat.key).toLowerCase();
      const a = [myUser, peer].sort();
      convoId = `${a[0]}:${a[1]}`;
    }
    isUploading = true;
    try {
      const meta = await uploadAttachment(file, attachmentType, convoId);
      // Caption ist der aktuelle Eingabetext (kann leer sein).
      const caption = (text || '').trim();
      await chatStore.sendMessage(caption, { attachment: meta });
      // Eingabefeld nur leeren wenn Caption mitgeschickt wurde.
      if (caption) text = '';
    } catch (e) {
      const code = e?.message || '';
      if (!['file_too_large','mime_not_allowed','extension_blocked','rate_limit'].includes(code)) {
        captureException(e, { context: 'attach.upload', attachmentType });
      }
      toastStore.push(_errMsg(code), { kind: 'error' });
    } finally {
      isUploading = false;
    }
  }

  function onPhotoPicked(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    void _handlePicked(file, 'photo');
  }
  function onCameraPicked(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    // Kamera-Aufnahmen sind auch Photos → gleiche Pipeline (EXIF-Strip + Resize)
    void _handlePicked(file, 'photo');
  }
  function onFilePicked(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    void _handlePicked(file, 'file');
  }

  // ── GIF (GIPHY-Privacy-Proxy) ────────────────────────
  // GIFs werden NICHT in R2 gespeichert — die GIPHY-URL geht E2E-encrypted
  // im Message-Body, der Empfänger lädt direkt vom GIPHY-CDN.
  let gifPickerOpen = $state(false);
  function onAttachGif() { gifPickerOpen = true; }

  async function onGifPicked(gif) {
    const chat = chatStore.selectedChat;
    if (!chat || !gif?.url) return;
    const meta = {
      type:       'gif',
      gifUrl:     gif.url,
      gifPreview: gif.preview || gif.url,
      gifId:      gif.id,
    };
    const caption = (text || '').trim();
    try {
      await chatStore.sendMessage(caption, { attachment: meta });
      if (caption) text = '';
    } catch (e) {
      captureException(e, { context: 'attach.gif' });
      toastStore.push(lang.attachmentUploadFailed || 'Upload fehlgeschlagen.', { kind: 'error' });
    }
  }

  // Emoji-Picker: noch nicht implementiert. Button entfernt — folgt später.
</script>

<div
  class="chat-input-wrap"
  class:drag-active={isDragging}
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  role="region"
>
{#if isDragging}
  <div class="drop-overlay">
    <div class="drop-overlay-inner">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="17 8 12 3 7 8"/>
        <line x1="12" y1="3" x2="12" y2="15"/>
      </svg>
      <span>{lang.dropToAttach || 'Datei hier ablegen'}</span>
    </div>
  </div>
{/if}
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
  <input
    bind:this={photoInputEl}
    type="file"
    accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
    onchange={onPhotoPicked}
    style="display:none"
  />
  <!-- Camera-Direkt-Input (mobile only): capture="environment" → iOS/Android öffnen
       direkt die Rückkamera, KEIN OS-Sheet dazwischen. Auf Desktop wird capture
       ignoriert → würde wie photoInputEl wirken; deshalb zeigen wir das Item dort gar nicht. -->
  <input
    bind:this={cameraInputEl}
    type="file"
    accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
    capture="environment"
    onchange={onCameraPicked}
    style="display:none"
  />
  <input
    bind:this={fileInputEl}
    type="file"
    accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.ics,.gif,.txt"
    onchange={onFilePicked}
    style="display:none"
  />

  <div class="attach-anchor" bind:this={attachAnchorEl}>
    <button
      class="icon-btn attach-plus"
      class:open={attachSheetOpen}
      onclick={toggleAttachSheet}
      disabled={isUploading || isSending}
      title={lang.attachMenuTitle || 'Anhang hinzufügen'}
      aria-label={lang.attachMenuTitle || 'Add attachment'}
      aria-haspopup="menu"
      aria-expanded={attachSheetOpen}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </button>

    {#if attachSheetOpen}
      <div class="attach-sheet" role="menu" aria-label={lang.attachMenuTitle || 'Add attachment'}>
        <!-- Mobile: aufgeteilt in Mediathek + Aufnehmen. „Aufnehmen" geht via
             capture="environment" direkt zur Kamera ohne iOS-Sheet. -->
        {#if isTouchDevice}
          <button class="attach-sheet-item" onclick={onAttachPhoto} role="menuitem">
            <span class="attach-sheet-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
            </span>
            <span class="attach-sheet-label">{lang.attachPhotoLibrary || 'Mediathek'}</span>
          </button>
          <button class="attach-sheet-item" onclick={onAttachCamera} role="menuitem">
            <span class="attach-sheet-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                <circle cx="12" cy="13" r="4"/>
              </svg>
            </span>
            <span class="attach-sheet-label">{lang.attachTakePhoto || 'Aufnehmen'}</span>
          </button>
        {:else}
          <!-- Desktop: ein Foto-Item (capture wird ohnehin ignoriert) -->
          <button class="attach-sheet-item" onclick={onAttachPhoto} role="menuitem">
            <span class="attach-sheet-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
            </span>
            <span class="attach-sheet-label">{lang.attachPhotoVideo || 'Foto'}</span>
          </button>
        {/if}
        <button class="attach-sheet-item" onclick={onAttachFile} role="menuitem">
          <span class="attach-sheet-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
            </svg>
          </span>
          <span class="attach-sheet-label">{lang.attachDocument || 'Dokument'}</span>
        </button>
        <button class="attach-sheet-item" onclick={() => { closeAttachSheet(); onAttachGif(); }} role="menuitem">
          <span class="attach-sheet-icon attach-sheet-icon-gif" aria-hidden="true">GIF</span>
          <span class="attach-sheet-label">{lang.attachGif || 'GIF'}</span>
        </button>
      </div>
    {/if}
  </div>

  <textarea
    bind:this={textareaEl}
    bind:value={text}
    onkeydown={onKeydown}
    onfocus={() => (_focused = true)}
    onblur={() => (_focused = false)}
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

<GifPickerModal bind:isOpen={gifPickerOpen} onPick={onGifPicked} />

<style>
  .chat-input-wrap {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    position: relative;
  }

  .chat-input-wrap.drag-active {
    /* sanftes Highlight ohne Layout-Shift — Border via inset shadow */
    box-shadow: inset 0 0 0 2px var(--accent-voice);
  }

  .drop-overlay {
    position: absolute;
    inset: 0;
    background: color-mix(in srgb, var(--bg-panel) 88%, transparent);
    backdrop-filter: blur(2px);
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    border-radius: inherit;
  }
  .drop-overlay-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--accent-voice);
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  .attach-anchor {
    position: relative;
    flex-shrink: 0;
  }

  .attach-plus svg {
    transition: transform 0.18s ease;
  }
  .attach-plus.open svg {
    transform: rotate(45deg);
  }
  .attach-plus.open {
    color: var(--accent-voice);
    background: var(--bg-panel-alt);
  }

  .attach-sheet {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 0;
    min-width: 180px;
    background: var(--bg-panel);
    border: 1px solid var(--border-subtle);
    border-radius: 12px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    z-index: 60;
    animation: attach-sheet-in 0.14s ease;
  }

  @keyframes attach-sheet-in {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .attach-sheet-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    background: transparent;
    border: none;
    border-radius: 8px;
    color: var(--text-primary);
    font-size: 14px;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s;
  }
  .attach-sheet-item:hover {
    background: var(--bg-panel-alt);
  }
  .attach-sheet-item:focus-visible {
    outline: 2px solid var(--accent-voice);
    outline-offset: -2px;
  }

  .attach-sheet-icon {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-panel-alt);
    color: var(--accent-voice);
    flex-shrink: 0;
  }
  .attach-sheet-icon-gif {
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.06em;
  }

  .attach-sheet-label {
    flex: 1;
    min-width: 0;
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
    /* iPhone Home-Indicator unten: padding-bottom mit safe-area-inset.
       Landscape: seitlich auch insetten. */
    padding: 10px max(14px, var(--safe-right)) max(10px, var(--safe-bottom)) max(14px, var(--safe-left));
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
