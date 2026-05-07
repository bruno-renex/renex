<!--
  ContactItem — einzelner Eintrag in der Inbox-Liste
  Wird sowohl für DMs als auch Groups verwendet.
-->
<script>
  /** @type {{
    name: string,           // Display-Text (handle oder group-name)
    subtitle?: string,       // Optional: zweite Zeile (Last-Message-Preview)
    initials?: string,       // Optional: Avatar-Initialen (Auto wenn fehlt)
    isGroup?: boolean,       // Group-Icon statt Initials
    unreadCount?: number,    // Badge
    isOnline?: boolean,      // Grüner Online-Punkt
    isActive?: boolean,      // Currently selected
    dimmed?: boolean,        // Ausgegraut (z.B. Kontakt ohne Chat-Aktivität)
    onclick?: () => void
  }} */
  let {
    name,
    subtitle = "",
    initials = null,
    isGroup = false,
    unreadCount = 0,
    isOnline = false,
    isActive = false,
    dimmed = false,
    onclick = () => {}
  } = $props();

  let computedInitials = $derived.by(() => {
    if (initials) return initials;
    return (name || "?")
      .split(/[\s._-]+/)
      .map(p => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  });
</script>

<button
  class="contact-item"
  class:active={isActive}
  class:has-unread={unreadCount > 0}
  class:dimmed={dimmed}
  {onclick}
  type="button"
>
  <div class="avatar" class:group={isGroup}>
    {#if isGroup}
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
    {:else}
      {computedInitials}
    {/if}
    {#if isOnline && !isGroup}
      <span class="online-dot" aria-label="Online"></span>
    {/if}
  </div>

  <div class="meta">
    <div class="name">{name}</div>
    {#if subtitle}
      <div class="subtitle">{subtitle}</div>
    {/if}
  </div>

  {#if unreadCount > 0}
    <span class="unread-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
  {/if}
</button>

<style>
  .contact-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    background: transparent;
    border: none;
    border-radius: 10px;
    cursor: pointer;
    text-align: left;
    transition: background 0.1s;
    width: 100%;
  }

  .contact-item:hover {
    background: var(--bg-panel-alt);
  }

  .contact-item.active {
    background: var(--accent-voice-dim);
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
    position: relative;
    flex-shrink: 0;
  }

  .avatar.group {
    color: var(--accent-voice);
    background: var(--accent-voice-dim);
    border-color: var(--accent-voice);
  }

  .online-dot {
    position: absolute;
    bottom: 0;
    right: 0;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: var(--status-success);
    border: 2px solid var(--bg-panel);
  }

  .meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .has-unread .name {
    color: var(--text-primary);
    font-weight: 700;
  }

  .subtitle {
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .contact-item.dimmed .name {
    color: var(--text-muted);
    font-weight: 500;
  }
  .contact-item.dimmed .avatar {
    opacity: 0.55;
  }
  .contact-item.dimmed .subtitle {
    font-style: italic;
    opacity: 0.8;
  }

  .unread-badge {
    flex-shrink: 0;
    min-width: 20px;
    height: 20px;
    border-radius: 10px;
    background: var(--accent-voice);
    color: #07070A;
    font-size: 11px;
    font-weight: 800;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 6px;
    line-height: 1;
  }
</style>
