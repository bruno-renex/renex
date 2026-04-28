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
   *     replyTo?: { from, text },
   *     attachment?: { type, url, name }
   *   },
   *   showSender?: boolean    // bei Group-Chats: Sender-Name anzeigen
   * }}
   */
  let { message, showSender = false } = $props();

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

<div class="bubble-row" class:me={message.isMe}>
  <div class="bubble" class:me={message.isMe}>
    {#if showSender && !message.isMe}
      <div class="sender">{message.from}</div>
    {/if}

    {#if message.replyTo}
      <div class="reply-preview">
        <div class="reply-author">{message.replyTo.from}</div>
        <div class="reply-text">{message.replyTo.text}</div>
      </div>
    {/if}

    <div class="text">{message.text}</div>

    <div class="meta">
      <span class="time">{timeStr}</span>
      {#if message.isMe}
        <span class="status-icon" class:read={message.status === "read"} class:failed={message.status === "failed"}>
          {statusIcon}
        </span>
      {/if}
    </div>
  </div>
</div>

<style>
  .bubble-row {
    display: flex;
    margin: 4px 0;
    padding: 0 14px;
  }

  .bubble-row.me {
    justify-content: flex-end;
  }

  .bubble {
    max-width: 70%;
    padding: 8px 12px 6px;
    background: var(--bg-panel);
    border: 1px solid var(--border-subtle);
    border-radius: 16px 16px 16px 4px;
    color: var(--text-primary);
    word-wrap: break-word;
    overflow-wrap: anywhere;
  }

  .bubble.me {
    background: var(--accent-voice);
    color: #07070a;
    border-color: var(--accent-voice);
    border-radius: 16px 16px 4px 16px;
  }

  .sender {
    font-size: 11px;
    font-weight: 700;
    color: var(--accent-voice);
    margin-bottom: 4px;
  }

  .reply-preview {
    border-left: 3px solid var(--accent-voice);
    padding: 4px 8px;
    margin-bottom: 6px;
    background: rgba(56, 189, 248, 0.08);
    border-radius: 4px;
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
