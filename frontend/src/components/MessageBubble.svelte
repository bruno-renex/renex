<!--
  MessageBubble — eine einzelne Nachricht im Chat
  Stil:
   - eigene Nachrichten rechts, accent-cyan
   - fremde Nachrichten links, panel-bg
   - System-Nachrichten zentriert, italic
-->
<script>
  /**
   * @type {{
   *   message: {
   *     id: string,
   *     from: string,
   *     ts: number,
   *     text: string,
   *     status?: "sending" | "sent" | "delivered" | "read" | "failed",
   *     isMe?: boolean,
   *     verified?: boolean | null,   // E2E-Sig-Verify: true=ok, false=Tampering, null=unkonklusiv
   *     _unrecoverable?: boolean,    // 🔓✗ — CMK permanent verloren
   *     replyTo?: { from, text },
   *     attachment?: { type, url, name }
   *   },
   *   showSender?: boolean,          // bei Group-Chats: Sender-Name anzeigen
   *   onReply?: (message) => void    // Callback wenn User die Bubble als Reply markieren will
   * }}
   */
  import { profileCache } from '../stores/profileCache.svelte.js';
  import { i18nStore } from '../stores/i18n.svelte.js';
  import AttachmentView from './AttachmentView.svelte';
  import { formatMessage, stripFormatting } from '../lib/messageFormat.js';
  import { openExternalLink } from '../stores/linkWarning.svelte.js';
  import { isGuestHandle, guestDisplayName } from '../lib/guestNames.js';
  import { swipeReply } from '../lib/swipeReply.js';

  let { message, showSender = false, onReply = null, onEdit = null, onDelete = null, onReact = null, onJumpTo = null, onSenderClick = null, myHandle = null } = $props();

  function handleSenderClick(e) {
    e.stopPropagation();
    if (onSenderClick && message.from) onSenderClick(message.from);
  }

  function handleReplyPreviewClick(e) {
    e.stopPropagation();
    if (onJumpTo && message.replyTo?.id) onJumpTo(message.replyTo.id);
  }

  // 7 erlaubte Emojis (Backend whitelist — chatRoutes.js:456)
  const REACTION_EMOJIS = ["💀","🔥","🗿","😭","🫡","💯","🤝"];

  let pickerOpen = $state(false);
  let pickerWrapEl = $state(null);

  function togglePicker(e) {
    e.stopPropagation();
    pickerOpen = !pickerOpen;
  }

  function pickEmoji(emoji, e) {
    e.stopPropagation();
    pickerOpen = false;
    if (onReact) onReact(message, emoji);
  }

  function toggleExistingReaction(emoji, e) {
    e.stopPropagation();
    if (onReact) onReact(message, emoji);
  }

  // Click-outside / Escape schließt den offenen Reaktion-Picker.
  $effect(() => {
    if (!pickerOpen) return;
    const onClick = (e) => {
      if (pickerWrapEl && !pickerWrapEl.contains(e.target)) pickerOpen = false;
    };
    const onKey = (e) => { if (e.key === 'Escape') pickerOpen = false; };
    // setTimeout damit der Open-Click den Listener nicht direkt wieder schließt
    const id = setTimeout(() => {
      document.addEventListener('mousedown', onClick);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  });

  let canReact = $derived(
    !!onReact &&
    !message.type &&
    message.status !== "sending" &&
    message.status !== "failed" &&
    !message._unrecoverable &&
    message.text !== "🔐 …"
  );

  // Reactions als Chip-Liste: { emoji, count, mine }
  let reactionChips = $derived.by(() => {
    const reactions = message.reactions || {};
    const me = (myHandle || '').toLowerCase();
    return Object.entries(reactions)
      .filter(([_, handles]) => Array.isArray(handles) && handles.length > 0)
      .map(([emoji, handles]) => ({
        emoji,
        count: handles.length,
        mine: me ? handles.some(h => String(h).toLowerCase() === me) : false,
      }));
  });

  // Sender-Name reaktiv: Display-Name wenn bekannt, sonst Tiername bei Gästen
  // (analog zu ChatHeader/InboxList/GroupMembersModal), sonst @handle. In Gruppen
  // war früher ein roher "@guest_xxxx" sichtbar, was die Tiername-Konvention
  // brach (in DMs verdeckt, weil DMs den Sender ausblenden).
  let senderName = $derived(
    message.from
      ? (profileCache.get(message.from)
          || (isGuestHandle(message.from) ? guestDisplayName(message.from) : message.from))
      : ''
  );

  // Reply-Author reaktiv (für Quote-Reply-Box im Bubble). Gleiche Tiername-Logik.
  let replyAuthorName = $derived(
    message.replyTo?.from
      ? (profileCache.get(message.replyTo.from)
          || (isGuestHandle(message.replyTo.from) ? guestDisplayName(message.replyTo.from) : message.replyTo.from))
      : ''
  );

  // System-Message-Renderer: backend schreibt englischen Klartext wie
  // "guest_xxxx is now realHandle" oder "__guest_convert_notice__" oder
  // "X is now Admin". Wir formatieren das hier lokalisiert + mit Tiernamen.
  let systemText = $derived.by(() => {
    const raw = String(message.message || '');
    if (!raw) return '';
    const lng = i18nStore.lang;
    // Sentinel: alte verschlüsselte Nachrichten sind nach Gast-Convert nicht
    // mehr lesbar (CMK/GSK-Wechsel) — der Backend-Hinweis informiert die anderen.
    if (raw === '__guest_convert_notice__') {
      return lng.sysGuestConvertNotice
        || 'Ein Gast hat sich registriert. Frühere Nachrichten bleiben verschlüsselt.';
    }
    // Pattern: "<guest_xxxx> is now <realHandle>" (DM + Gruppe nach Convert)
    const conv = raw.match(/^(guest_[a-z0-9]+) is now ([a-z0-9_]+)$/i);
    if (conv) {
      const oldH = conv[1].toLowerCase();
      const newH = conv[2].toLowerCase();
      const oldDisplay = isGuestHandle(oldH) ? guestDisplayName(oldH) : `@${oldH}`;
      const tmpl = lng.sysGuestNowReal || '{old} ist jetzt @{new}';
      return tmpl.replace('{old}', oldDisplay).replace('{new}', newH);
    }
    // Pattern: "<handle> is now Admin" (Group-Admin-Promotion)
    const admin = raw.match(/^([a-z0-9_]+) is now Admin$/i);
    if (admin) {
      const h = admin[1].toLowerCase();
      const display = isGuestHandle(h) ? guestDisplayName(h) : `@${h}`;
      const tmpl = lng.sysNowAdmin || '{user} ist jetzt Admin';
      return tmpl.replace('{user}', display);
    }
    // Fallback: roher Text (für unbekannte System-Messages)
    return raw;
  });

  // Reply-Action nur erlauben wenn die Bubble eine "fertige" Message ist:
  // - kein System-/Control-Type
  // - nicht im Sending-Zustand (optimistic — id ist temp)
  // - nicht failed
  // - nicht der 🔐-Placeholder (Text muss bekannt sein für Preview-Encrypt)
  // - nicht unrecoverable
  let canReply = $derived(
    !!onReply &&
    !message.type &&
    message.status !== "sending" &&
    message.status !== "failed" &&
    !message._unrecoverable &&
    message.text !== "🔐 …"
  );

  function handleReplyClick(e) {
    e.stopPropagation();
    if (canReply) onReply(message);
  }

  // Edit/Delete nur für eigene Bubbles. 15-Min-Window prüfen wir client-seitig
  // (UX), Server enforced es trotzdem (Source of Truth).
  const EDIT_WINDOW_MS = 15 * 60 * 1000;
  let withinEditWindow = $derived(
    message.ts && (Date.now() - message.ts < EDIT_WINDOW_MS)
  );
  let canEdit = $derived(
    !!onEdit && message.isMe &&
    !message.type &&
    message.status !== "sending" &&
    message.status !== "failed" &&
    !message._unrecoverable &&
    message.text !== "🔐 …" &&
    withinEditWindow
  );
  let canDelete = $derived(
    !!onDelete && message.isMe &&
    !message.type &&
    message.status !== "sending" &&
    message.status !== "failed"
  );

  function handleEditClick(e) {
    e.stopPropagation();
    if (canEdit) onEdit(message);
  }
  function handleDeleteClick(e) {
    e.stopPropagation();
    if (canDelete) onDelete(message);
  }

  // Text in Render-Segmente zerlegen (Markdown-Subset + Autolinks).
  // Reagiert reaktiv auf message.text-Änderungen (z.B. Edit).
  let textSegments = $derived(message.text ? formatMessage(message.text) : []);

  // Reply-Preview: Markdown-strippen, damit "**Hi**" als "Hi" angezeigt wird.
  let replyPreviewText = $derived(
    message.replyTo?.text ? stripFormatting(message.replyTo.text) : ''
  );

  // Link-Klick-Handler: Phishing-Heuristik vor jedem Open.
  function handleLinkClick(href, e) {
    e.preventDefault();
    e.stopPropagation();
    openExternalLink(href);
  }

  let timeStr = $derived.by(() => {
    const d = new Date(message.ts);
    return d.toLocaleTimeString("de-CH", {
      hour: "2-digit",
      minute: "2-digit",
    });
  });

  let statusIcon = $derived.by(() => {
    if (!message.isMe) return "";
    switch (message.status) {
      case "sending":   return "○";
      case "sent":      return "✓";
      case "delivered": return "✓✓";
      case "read":      return "✓✓";
      case "failed":    return "⚠";
      default:          return "";
    }
  });
</script>

{#snippet renderSegments(segs)}{#each segs as seg, i (i)}{#if seg.type === 'text'}{seg.value}{:else if seg.type === 'link'}<a
        class="msg-link"
        href={seg.href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        referrerpolicy="no-referrer"
        title={seg.href}
        onclick={(e) => handleLinkClick(seg.href, e)}
      >{seg.text}</a>{:else if seg.type === 'code'}<code class="msg-code">{seg.value}</code>{:else if seg.type === 'codeblock'}<pre class="msg-codeblock"><code>{seg.value}</code></pre>{:else if seg.type === 'bold'}<strong>{@render renderSegments(seg.children)}</strong>{:else if seg.type === 'italic'}<em>{@render renderSegments(seg.children)}</em>{/if}{/each}{/snippet}

{#if message.type === 'system'}
  <div class="system-row">
    <div class="system-bubble">{systemText}</div>
  </div>
{:else}
<div class="bubble-row" class:me={message.isMe}>
  {#if message.isMe && (canDelete || canEdit || canReact || canReply)}
    <div class="action-cluster">
      {#if canDelete}
        <button class="bubble-action danger" onclick={handleDeleteClick} title="Löschen" aria-label="Löschen">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6"/><path d="M14 11v6"/>
          </svg>
        </button>
      {/if}
      {#if canEdit}
        <button class="bubble-action" onclick={handleEditClick} title="Bearbeiten" aria-label="Bearbeiten">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9"/>
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
          </svg>
        </button>
      {/if}
      {#if canReact}
        <div class="reaction-wrap" bind:this={pickerWrapEl}>
          <button class="bubble-action" onclick={togglePicker} title="Reagieren" aria-label="Reagieren">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
              <line x1="9" y1="9" x2="9.01" y2="9"/>
              <line x1="15" y1="9" x2="15.01" y2="9"/>
            </svg>
          </button>
          {#if pickerOpen}
            <div class="reaction-picker" role="menu">
              {#each REACTION_EMOJIS as emoji}
                <button class="picker-emoji" onclick={(e) => pickEmoji(emoji, e)} title={emoji} aria-label={emoji}>{emoji}</button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      {#if canReply}
        <button class="bubble-action" onclick={handleReplyClick} title="Antworten" aria-label="Antworten">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 17 4 12 9 7"/>
            <path d="M20 18v-2a4 4 0 0 0-4-4H4"/>
          </svg>
        </button>
      {/if}
    </div>
  {/if}
  <div class="bubble" class:me={message.isMe} class:tampered={message.verified === false} data-msg-id={message.id} use:swipeReply={canReply && onReply ? () => onReply(message) : null}>
    {#if showSender && !message.isMe}
      {#if onSenderClick}
        <button
          type="button"
          class="sender sender-clickable"
          onclick={handleSenderClick}
          title={senderName}
          aria-label="Aktionen für {senderName}"
        >{senderName}</button>
      {:else}
        <div class="sender">{senderName}</div>
      {/if}
    {/if}

    {#if message.replyTo}
      {#if message.replyTo.id && onJumpTo}
        <button
          type="button"
          class="reply-preview reply-preview-clickable"
          onclick={handleReplyPreviewClick}
          title="Zur Original-Nachricht springen"
        >
          <div class="reply-author">{replyAuthorName}</div>
          <div class="reply-text">{replyPreviewText}</div>
        </button>
      {:else}
        <div class="reply-preview">
          <div class="reply-author">{replyAuthorName}</div>
          <div class="reply-text">{replyPreviewText}</div>
        </div>
      {/if}
    {/if}

    {#if message.verified === false}
      <div class="tamper-warning" title="Signatur ungültig — diese Nachricht wurde verändert oder stammt nicht vom angegebenen Absender.">
        ⚠️ Signatur ungültig — Manipulation möglich
      </div>
    {/if}

    {#if message.attachment}
      <AttachmentView attachment={message.attachment} />
    {/if}

    {#if message.text}
      <div class="text">{@render renderSegments(textSegments)}</div>
    {/if}

    <div class="meta">
      <span class="time">{timeStr}</span>
      {#if message.edited}
        <span class="edited-mark" title="Bearbeitet">(bearbeitet)</span>
      {/if}
      {#if !message.isMe && message.verified === null && message.text && message.text !== "🔐 …"}
        <span
          class="unverified-mark"
          title="Signatur konnte nicht geprüft werden — Sender-Pubkey fehlt im Cache. Inhalt ist E2E-verschlüsselt, aber Authentizität nicht bestätigt."
        >ⓘ</span>
      {/if}
      {#if message.isMe}
        <span class="status-icon" class:read={message.status === "read"} class:failed={message.status === "failed"}>
          {statusIcon}
        </span>
      {/if}
    </div>
    {#if reactionChips.length > 0}
      <div class="reactions-row">
        {#each reactionChips as chip (chip.emoji)}
          <button
            class="reaction-chip"
            class:mine={chip.mine}
            onclick={(e) => toggleExistingReaction(chip.emoji, e)}
            title={chip.mine ? 'Eigene Reaktion entfernen' : 'Auch reagieren'}
          >
            <span class="chip-emoji">{chip.emoji}</span>
            <span class="chip-count">{chip.count}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
  {#if !message.isMe && (canReply || canReact)}
    <div class="action-cluster">
      {#if canReact}
        <div class="reaction-wrap" bind:this={pickerWrapEl}>
          <button class="bubble-action" onclick={togglePicker} title="Reagieren" aria-label="Reagieren">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
              <line x1="9" y1="9" x2="9.01" y2="9"/>
              <line x1="15" y1="9" x2="15.01" y2="9"/>
            </svg>
          </button>
          {#if pickerOpen}
            <div class="reaction-picker" role="menu">
              {#each REACTION_EMOJIS as emoji}
                <button class="picker-emoji" onclick={(e) => pickEmoji(emoji, e)} title={emoji} aria-label={emoji}>{emoji}</button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      {#if canReply}
        <button class="bubble-action" onclick={handleReplyClick} title="Antworten" aria-label="Antworten">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 17 4 12 9 7"/>
            <path d="M20 18v-2a4 4 0 0 0-4-4H4"/>
          </svg>
        </button>
      {/if}
    </div>
  {/if}
</div>
{/if}

<style>
  .system-row {
    display: flex;
    justify-content: center;
    margin: 12px 0 4px;
  }
  .system-bubble {
    font-size: 11px;
    color: var(--text-muted);
    background: var(--bg-panel-alt);
    border-radius: 12px;
    padding: 4px 12px;
    max-width: 80%;
    text-align: center;
  }

  .bubble-row {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 4px 0;
    padding: 0 14px;
  }

  .bubble-row.me {
    justify-content: flex-end;
  }

  /* Action-Cluster (Reply/Edit/Delete) — nur sichtbar bei Hover über die Row.
     Auf Touch-Devices (kein Hover) immer sichtbar mit reduzierter Opacity. */
  .action-cluster {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .bubble-row:hover .action-cluster {
    opacity: 0.85;
  }

  @media (hover: none) {
    .action-cluster {
      opacity: 0.5;
    }
  }

  .bubble-action {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: none;
    background: var(--bg-panel-alt);
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s, color 0.15s;
  }

  .bubble-action:hover {
    background: var(--accent-voice);
    color: #07070a;
  }

  .bubble-action.danger:hover {
    background: var(--status-error, #ef4444);
    color: #fff;
  }

  .edited-mark {
    font-size: 10px;
    color: var(--text-muted);
    opacity: 0.7;
    font-style: italic;
  }

  .bubble.me .edited-mark {
    color: rgba(7, 7, 10, 0.6);
  }

  /* Sig-Verify unkonklusiv (verified===null) — dezenter Indicator,
     unterscheidet sich von tampered (verified===false → eigene Warnung). */
  .unverified-mark {
    font-size: 11px;
    color: var(--text-muted);
    opacity: 0.6;
    cursor: help;
  }

  /* Reaction-Picker — kleines Popover mit den 7 erlaubten Emojis */
  .reaction-wrap {
    position: relative;
  }

  .reaction-picker {
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-bottom: 6px;
    display: flex;
    gap: 2px;
    padding: 6px;
    background: var(--bg-panel);
    border: 1px solid var(--border-subtle);
    border-radius: 24px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 10;
  }

  .picker-emoji {
    width: 30px;
    height: 30px;
    border: none;
    background: transparent;
    border-radius: 50%;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    transition: background 0.1s, transform 0.1s;
  }

  .picker-emoji:hover {
    background: var(--bg-panel-alt);
    transform: scale(1.2);
  }

  /* Reaktion-Chips unter der Bubble */
  .reactions-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }

  .reaction-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 7px;
    border: 1px solid var(--border-subtle);
    border-radius: 12px;
    background: var(--bg-panel-alt);
    color: var(--text-primary);
    font-size: 11px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }

  .reaction-chip:hover {
    background: var(--bg-panel);
  }

  .reaction-chip.mine {
    border-color: var(--accent-voice);
    background: var(--accent-voice-dim, rgba(56,189,248,0.15));
  }

  .bubble.me .reaction-chip {
    background: rgba(7, 7, 10, 0.15);
    border-color: rgba(7, 7, 10, 0.2);
    color: rgba(7, 7, 10, 0.85);
  }

  .bubble.me .reaction-chip.mine {
    border-color: rgba(7, 7, 10, 0.6);
    background: rgba(7, 7, 10, 0.25);
  }

  .chip-emoji { font-size: 13px; line-height: 1; }
  .chip-count { font-weight: 600; font-size: 11px; }

  .bubble {
    max-width: 70%;
    padding: 8px 12px 6px;
    background: var(--bg-panel);
    border: 1px solid var(--border-subtle);
    border-radius: 16px 16px 16px 4px;
    color: var(--text-primary);
    word-wrap: break-word;
    overflow-wrap: anywhere;
    /* Swipe-to-Reply: vertikales Scrollen bleibt beim Browser, die horizontale
       Geste übernimmt die swipeReply-Action (use:swipeReply auf dieser Bubble). */
    touch-action: pan-y;
  }

  .bubble.me {
    background: var(--accent-voice);
    color: #07070a;
    border-color: var(--accent-voice);
    border-radius: 16px 16px 4px 16px;
  }

  /* Tampering: roter Border + Warnbanner. Sticht visuell heraus. */
  .bubble.tampered {
    border-color: var(--status-error, #ef4444);
    border-width: 2px;
  }

  .tamper-warning {
    font-size: 11px;
    font-weight: 600;
    color: var(--status-error, #ef4444);
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid var(--status-error, #ef4444);
    border-radius: 6px;
    padding: 4px 8px;
    margin-bottom: 6px;
    cursor: help;
  }

  .bubble.me .tamper-warning {
    background: rgba(239, 68, 68, 0.2);
    color: #fff;
  }

  .sender {
    font-size: 11px;
    font-weight: 700;
    color: var(--accent-voice);
    margin-bottom: 4px;
  }
  .sender-clickable {
    background: none;
    border: none;
    padding: 1px 4px;
    margin: 0 0 4px -4px;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
    color: var(--accent-voice);
    text-align: left;
    transition: background 0.12s;
  }
  .sender-clickable:hover { background: rgba(56, 189, 248, 0.15); }
  .sender-clickable:focus-visible {
    outline: 2px solid var(--accent-voice);
    outline-offset: 1px;
  }

  .reply-preview {
    border-left: 3px solid var(--accent-voice);
    padding: 4px 8px;
    margin-bottom: 6px;
    background: rgba(56, 189, 248, 0.08);
    border-radius: 4px;
    text-align: left;
  }

  /* Klickbare Reply-Vorschau (Jump-to-Original) */
  button.reply-preview {
    display: block;
    width: 100%;
    border: none;
    border-left: 3px solid var(--accent-voice);
    color: inherit;
    cursor: pointer;
    font: inherit;
    transition: background 0.15s;
  }
  button.reply-preview:hover {
    background: rgba(56, 189, 248, 0.18);
  }
  .bubble.me button.reply-preview:hover {
    background: rgba(7, 7, 10, 0.18);
  }

  /* Highlight-Animation beim Jump auf eine Bubble */
  :global(.bubble.jump-highlight) {
    animation: jump-flash 1.4s ease-out;
  }
  @keyframes jump-flash {
    0%   { box-shadow: 0 0 0 3px var(--accent-voice); }
    50%  { box-shadow: 0 0 0 3px var(--accent-voice); }
    100% { box-shadow: 0 0 0 0 transparent; }
  }

  .bubble.me .reply-preview {
    border-left-color: rgba(7, 7, 10, 0.4);
    background: rgba(7, 7, 10, 0.1);
  }

  .reply-author {
    font-size: 10px;
    font-weight: 700;
    color: var(--accent-voice);
    margin-bottom: 1px;
  }

  .bubble.me .reply-author {
    color: #07070a;
    opacity: 0.7;
  }

  .reply-text {
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 240px;
  }

  .bubble.me .reply-text {
    color: rgba(7, 7, 10, 0.7);
  }

  .text {
    font-size: 14px;
    line-height: 1.4;
    white-space: pre-wrap;
  }

  /* Klickbare Links im Nachrichtentext.
     - Fremd-Bubble: accent-cyan (gleicher Stil wie sender/reply-author)
     - Eigene Bubble (cyan-BG): dunkler Hintergrund → unterstrichen + bold,
       Farbe bleibt fast-schwarz für Kontrast. */
  .msg-link {
    color: var(--accent-voice);
    text-decoration: underline;
    text-underline-offset: 2px;
    word-break: break-all;
  }
  .msg-link:hover {
    text-decoration-thickness: 2px;
  }
  .bubble.me .msg-link {
    color: #07070a;
    text-decoration: underline;
    font-weight: 600;
  }

  /* Inline-Code: monospace mit dezentem Hintergrund.
     In eigener Bubble (cyan-BG) brauchen wir kontrastierenden Hintergrund. */
  :global(.msg-code) {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.88em;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 1px 5px;
    color: var(--accent-voice);
  }
  .bubble.me :global(.msg-code) {
    background: rgba(7, 7, 10, 0.18);
    border-color: rgba(7, 7, 10, 0.25);
    color: #07070a;
  }

  /* Code-Block: eigene Box mit horizontalem Scroll bei langen Zeilen. */
  :global(.msg-codeblock) {
    margin: 6px 0;
    padding: 8px 10px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    overflow-x: auto;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.4;
    color: var(--text-primary);
  }
  :global(.msg-codeblock code) {
    background: transparent;
    border: none;
    padding: 0;
    color: inherit;
    font-size: inherit;
  }
  .bubble.me :global(.msg-codeblock) {
    background: rgba(7, 7, 10, 0.15);
    border-color: rgba(7, 7, 10, 0.2);
    color: #07070a;
  }

  /* Bold/Italic erben Farbe automatisch — keine Extra-Regeln nötig. */

  .meta {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 5px;
    margin-top: 2px;
    font-size: 10px;
    color: var(--text-muted);
  }

  .bubble.me .meta {
    color: rgba(7, 7, 10, 0.6);
  }

  .status-icon {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 11px;
  }

  .status-icon.read {
    color: var(--accent-voice);
    opacity: 1;
  }

  .bubble.me .status-icon.read {
    color: #0ea5e9;
    opacity: 1;
  }

  .status-icon.failed {
    color: var(--status-error);
  }
</style>
