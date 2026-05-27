<!--
  ServersView — Sidebar-Liste für Phase-3A-Server
  Spec: docs/SERVERS.md §6

  Modi:
    1. KEINE Server-Auswahl: zeigt Server-Liste + "+ Server erstellen"
    2. Server selektiert: zeigt Header (mit Back-Button) + Channel-Liste
       (mit Unread-Badge) + Member-Liste. Channel-Klick öffnet den Channel
       via chatStore.selectChat({type:'channel'}).

  Eingebettet in InboxList als activeSection === 'servers'.
-->
<script>
  import { onMount } from 'svelte';
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { serverStore } from '../stores/serverStore.svelte.js';
  import { chatStore } from '../stores/chat.svelte.js';
  import { inboxStore } from '../stores/inbox.svelte.js';
  import { toastStore } from '../stores/toast.svelte.js';
  import { Permissions, resolvePermissions } from '../lib/permissions.js';
  import CreateServerModal from './CreateServerModal.svelte';
  import ServerSettingsModal from './ServerSettingsModal.svelte';
  import ServerInviteModal from './ServerInviteModal.svelte';

  let lang = $derived(i18nStore.lang);
  let servers = $derived(serverStore.servers);
  let selectedId = $derived(serverStore.selectedServerId);
  let detail = $derived(serverStore.selectedServerDetail);
  let isLoading = $derived(serverStore.isLoading);
  let errorMsg = $derived(serverStore.errorMsg);

  let createModalOpen = $state(false);
  let settingsModalOpen = $state(false);
  let busyLeave = $state(false);

  // Hat User MANAGE_ROLES oder MANAGE_SERVER oder ist Owner? → Settings-Button zeigen
  let canOpenSettings = $derived.by(() => {
    if (!detail) return false;
    if (detail.myMembership?.isOwner === true) return true;
    const myRoles = detail.roles?.filter(r => detail.myMembership?.roleIds?.includes(r.id)) || [];
    const eff = resolvePermissions({
      isOwner:    false,
      roles:      myRoles,
      overrides:  [],
      userHandle: detail.myMembership?.handle || '',
    });
    return (eff & (Permissions.MANAGE_ROLES | Permissions.MANAGE_SERVER)) !== 0;
  });

  // Hat User INVITE_MEMBERS (oder Owner)? → Invite-Button zeigen
  let canInvite = $derived.by(() => {
    if (!detail) return false;
    if (detail.myMembership?.isOwner === true) return true;
    const myRoles = detail.roles?.filter(r => detail.myMembership?.roleIds?.includes(r.id)) || [];
    const eff = resolvePermissions({
      isOwner:    false,
      roles:      myRoles,
      overrides:  [],
      userHandle: detail.myMembership?.handle || '',
    });
    return (eff & Permissions.INVITE_MEMBERS) !== 0;
  });

  let busyInvite = $state(false);
  let inviteUrl = $state(null);
  let inviteModalOpen = $state(false);
  async function onCreateInvite() {
    if (!selectedId || busyInvite) return;
    busyInvite = true;
    // Default: 7 Tage gültig, unbegrenzte Uses. Feingranulare Optionen (maxUses,
    // ttl, initialRole) sind Phase 3A.5.
    const r = await serverStore.createInvite(selectedId, { ttlMin: 10080, maxUses: 0 });
    busyInvite = false;
    if (!r.ok) {
      toastStore.push((lang.inviteCreateFailed || 'Invite-Erstellung fehlgeschlagen') + ': ' + r.error, { kind: 'error' });
      return;
    }
    // NICHT hier auto-kopieren: navigator.clipboard.writeText scheitert auf
    // Safari/iOS nach dem await (User-Geste abgelaufen). Stattdessen Modal mit
    // Copy-Button (frische Geste) + Web-Share öffnen.
    inviteUrl = r.url;
    inviteModalOpen = true;
  }

  // Beim ersten Mount: Server-Liste laden
  onMount(() => {
    if (servers.length === 0) void serverStore.loadServers();
  });

  function serverInitials(name) {
    if (!name) return '?';
    return name
      .split(/[\s._-]+/)
      .map(p => p[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  function onSelectServer(id) {
    serverStore.selectServer(id);
  }

  function onBackToList() {
    serverStore.selectServer(null);
  }

  function onChannelClick(channel) {
    if (!channel?.id) return;
    // Channel öffnet ChatView. Backend leitet aus conversations.type='channel'
    // den richtigen Recipient-Set ab (server_members statt conversation_members).
    // GSK-Pipeline funktioniert unverändert (channel-agnostisch).
    // chat.name ohne #-Prefix — ChatHeader rendert # als Avatar-Symbol separat.
    chatStore.selectChat({
      type:        'channel',
      key:         channel.id,
      name:        channel.name,
      topic:       channel.topic || null,
      serverId:    detail?.server?.id || null,
      // In Phase 3A sind alle Server-Member auch Channel-Member.
      memberCount: detail?.members?.length || 0,
    });
  }

  async function onLeaveServer() {
    if (!selectedId || busyLeave) return;
    const serverName = detail?.server?.name || '';
    const isOwner = detail?.myMembership?.isOwner;
    const confirmText = isOwner
      ? (lang.leaveServerOwnerConfirm || 'Du bist Owner. Wenn andere Mitglieder existieren, musst du zuerst transferieren. Trotzdem versuchen?')
      : ((lang.leaveServerConfirm || 'Server „{name}" verlassen?').replace('{name}', serverName));
    if (!confirm(confirmText)) return;

    busyLeave = true;
    const r = await serverStore.leaveServer(selectedId);
    busyLeave = false;

    if (r.ok) {
      toastStore.push(
        r.serverDeleted
          ? (lang.serverDeletedToast || '🗑 Server gelöscht (du warst Solo-Owner)')
          : (lang.serverLeftToast || '👋 Server verlassen'),
        { kind: 'success' }
      );
    } else if (r.error === 'owner_transfer_required') {
      toastStore.push(
        lang.leaveServerOwnerTransferRequired || '⚠ Übergib das Eigentum erst an ein anderes Mitglied.',
        { kind: 'error' }
      );
    } else {
      toastStore.push((lang.leaveServerFailed || 'Verlassen fehlgeschlagen') + ': ' + r.error, { kind: 'error' });
    }
  }
</script>

{#if !selectedId}
  <!-- ═══════ Server-Liste ═══════ -->
  <div class="srv-section">
    <header class="srv-section-header">
      <h2 class="srv-section-title">{lang.serversLabel || 'Servers'}</h2>
      <button class="srv-add-btn" onclick={() => createModalOpen = true} title={lang.createServerBtn || 'Server erstellen'}>
        +
      </button>
    </header>

    {#if errorMsg}
      <div class="srv-error">{errorMsg}</div>
    {/if}

    {#if isLoading && servers.length === 0}
      <div class="srv-empty">
        <span class="spinner"></span>
        {lang.loading || 'Lade…'}
      </div>
    {:else if servers.length === 0}
      <div class="srv-empty">
        <p>{lang.serversEmpty || 'Noch keine Server.'}</p>
        <button class="btn-primary" onclick={() => createModalOpen = true}>
          {lang.createServerBtn || '+ Server erstellen'}
        </button>
      </div>
    {:else}
      <ul class="srv-list">
        {#each servers as s (s.id)}
          <li>
            <button class="srv-item" onclick={() => onSelectServer(s.id)}>
              <div class="srv-avatar" class:owner={s.isOwner}>
                {serverInitials(s.name)}
              </div>
              <div class="srv-info">
                <div class="srv-name">
                  {s.name}
                  {#if s.isOwner}
                    <span class="srv-owner-badge" title="Owner">👑</span>
                  {/if}
                </div>
                <div class="srv-meta">
                  {s.memberCount} {s.memberCount === 1 ? (lang.memberSingular || 'Mitglied') : (lang.members || 'Mitglieder')}
                </div>
              </div>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{:else}
  <!-- ═══════ Server-Detail (Channel-Liste) ═══════ -->
  <div class="srv-section">
    <header class="srv-detail-header">
      <button class="srv-back-btn" onclick={onBackToList} aria-label={lang.backBtn || 'Zurück'}>
        ‹
      </button>
      <div class="srv-detail-title">
        {detail?.server?.name || '…'}
        {#if detail?.myMembership?.isOwner}
          <span class="srv-owner-badge">👑</span>
        {/if}
      </div>
      {#if canInvite}
        <button class="srv-settings-btn" onclick={onCreateInvite} disabled={busyInvite} title={lang.inviteCreateBtn || 'Invite-Link erstellen'}>
          {#if busyInvite}<span class="spinner-sm"></span>{:else}🔗{/if}
        </button>
      {/if}
      {#if canOpenSettings}
        <button class="srv-settings-btn" onclick={() => settingsModalOpen = true} title={lang.serverSettingsBtn || 'Server-Einstellungen'}>⚙</button>
      {/if}
      <button class="srv-leave-btn" onclick={onLeaveServer} disabled={busyLeave} title={lang.leaveServerBtn || 'Server verlassen'}>
        {#if busyLeave}<span class="spinner-sm"></span>{:else}⤴{/if}
      </button>
    </header>

    {#if detail?.server?.description}
      <p class="srv-description">{detail.server.description}</p>
    {/if}

    {#if !detail}
      <div class="srv-empty">
        <span class="spinner"></span>
        {lang.loading || 'Lade…'}
      </div>
    {:else}
      <div class="srv-channels-header">
        {lang.channelsHeading || 'Channels'}
        <span class="srv-channels-count">({detail.channels.length})</span>
      </div>
      <ul class="srv-channel-list">
        {#each detail.channels as c (c.id)}
          <li>
            <button class="srv-channel-item" onclick={() => onChannelClick(c)}>
              <span class="srv-channel-hash">#</span>
              <span class="srv-channel-name">{c.name}</span>
              {#if c.kind === 'voice'}
                <span class="srv-channel-kind">🔊</span>
              {/if}
              {#if inboxStore.unreadFor(c.id) > 0}
                <span class="srv-channel-badge">{inboxStore.unreadFor(c.id) > 99 ? '99+' : inboxStore.unreadFor(c.id)}</span>
              {/if}
            </button>
            {#if c.topic}
              <div class="srv-channel-topic">{c.topic}</div>
            {/if}
          </li>
        {/each}
      </ul>

      <div class="srv-members-header">
        {lang.membersHeading || 'Mitglieder'}
        <span class="srv-channels-count">({detail.members.length})</span>
      </div>
      <ul class="srv-member-list">
        {#each detail.members as m (m.handle)}
          <li class="srv-member-item">
            <div class="srv-member-avatar">{serverInitials(m.nickname || m.handle)}</div>
            <div class="srv-member-info">
              <div class="srv-member-name">
                @{m.handle}
                {#if m.isOwner}<span class="srv-owner-badge">👑</span>{/if}
              </div>
              {#if m.nickname}<div class="srv-member-nick">„{m.nickname}"</div>{/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<CreateServerModal bind:isOpen={createModalOpen} />
<ServerSettingsModal bind:isOpen={settingsModalOpen} />
<ServerInviteModal bind:isOpen={inviteModalOpen} url={inviteUrl} />

<style>
  .srv-section {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .srv-section-header,
  .srv-detail-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }

  .srv-section-title {
    flex: 1;
    margin: 0;
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .srv-add-btn,
  .srv-back-btn,
  .srv-leave-btn,
  .srv-settings-btn {
    background: transparent;
    border: 1px solid var(--border-subtle);
    color: var(--text-muted);
    width: 28px;
    height: 28px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.12s;
  }
  .srv-add-btn:hover,
  .srv-back-btn:hover,
  .srv-leave-btn:hover:not(:disabled),
  .srv-settings-btn:hover {
    border-color: var(--accent-voice);
    color: var(--accent-voice);
    background: var(--accent-voice-dim);
  }
  .srv-leave-btn:disabled { opacity: 0.5; cursor: wait; }

  .srv-detail-title {
    flex: 1;
    font-size: 14px;
    font-weight: 700;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .srv-error {
    margin: 10px 12px;
    padding: 9px 12px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid var(--status-error);
    border-radius: 6px;
    color: var(--status-error);
    font-size: 12px;
  }

  .srv-empty {
    padding: 32px 16px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: center;
  }

  .srv-list,
  .srv-channel-list,
  .srv-member-list {
    list-style: none;
    margin: 0;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .srv-item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
    color: var(--text-primary);
    transition: all 0.12s;
  }
  .srv-item:hover {
    background: var(--bg-panel-alt);
    border-color: var(--border-subtle);
  }

  .srv-avatar {
    width: 38px;
    height: 38px;
    border-radius: 30%;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    color: var(--text-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 12px;
    flex-shrink: 0;
  }
  .srv-avatar.owner {
    color: var(--accent-voice);
    background: var(--accent-voice-dim);
    border-color: var(--accent-voice);
  }

  .srv-info {
    flex: 1;
    min-width: 0;
  }

  .srv-name {
    font-size: 13px;
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .srv-meta {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 2px;
  }

  .srv-owner-badge {
    font-size: 11px;
  }

  .srv-description {
    margin: 8px 14px 0;
    font-size: 12px;
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .srv-channels-header,
  .srv-members-header {
    padding: 14px 14px 6px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .srv-channels-count {
    color: var(--text-muted);
    margin-left: 4px;
    font-weight: 400;
  }

  .srv-channel-item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 10px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
    color: var(--text-primary);
    font-size: 13px;
    transition: all 0.12s;
  }
  .srv-channel-item:hover {
    background: var(--bg-panel-alt);
    border-color: var(--border-subtle);
  }

  .srv-channel-hash {
    color: var(--text-muted);
    font-weight: 700;
  }

  .srv-channel-name {
    flex: 1;
  }

  .srv-channel-kind {
    font-size: 11px;
  }

  .srv-channel-badge {
    min-width: 16px;
    height: 16px;
    border-radius: 999px;
    background: var(--accent-voice);
    color: #07070A;
    font-size: 10px;
    font-weight: 800;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 5px;
    line-height: 1;
    box-sizing: border-box;
  }

  .srv-channel-topic {
    padding: 0 10px 4px 24px;
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1.4;
  }

  .srv-member-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: 6px;
  }

  .srv-member-avatar {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    color: var(--text-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 10px;
    flex-shrink: 0;
  }

  .srv-member-info {
    flex: 1;
    min-width: 0;
  }

  .srv-member-name {
    font-size: 12px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .srv-member-nick {
    font-size: 10px;
    color: var(--text-muted);
    font-style: italic;
  }

  .btn-primary {
    background: var(--accent-voice);
    color: #07070a;
    border: none;
    padding: 9px 18px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
  }
  .btn-primary:hover { opacity: 0.9; }

  .spinner {
    display: inline-block;
    width: 18px;
    height: 18px;
    border: 2px solid var(--border-subtle);
    border-top-color: var(--accent-voice);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  .spinner-sm {
    display: inline-block;
    width: 11px;
    height: 11px;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
</style>
