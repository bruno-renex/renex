<!--
  InboxList — Mittlere Spalte mit Chat-/Group-/Voice-Listen
  Switcht zwischen Sektionen via inboxStore.activeSection
-->
<script>
  import { inboxStore } from '../stores/inbox.svelte.js';
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { chatStore } from '../stores/chat.svelte.js';
  import { voiceStore } from '../stores/voice.svelte.js';
  import { profileCache } from '../stores/profileCache.svelte.js';
  import { presenceStore } from '../stores/presence.svelte.js';
  import ContactItem from './ContactItem.svelte';
  import PushBanner from './PushBanner.svelte';
  import AddContactModal from './AddContactModal.svelte';
  import CreateGroupModal from './CreateGroupModal.svelte';
  import PendingRequestsModal from './PendingRequestsModal.svelte';
  import InviteLinkModal from './InviteLinkModal.svelte';
  import ServersView from './ServersView.svelte';
  import { isGuestHandle, guestDisplayName } from '../lib/guestNames.js';

  let lang = $derived(i18nStore.lang);
  let activeSection = $derived(inboxStore.activeSection);

  // Filtered/searched lists
  let chats = $derived(inboxStore.filteredContacts);
  let groups = $derived(inboxStore.filteredGroups);
  let searchChats = $state(inboxStore.searchChats);
  let searchGroups = $state(inboxStore.searchGroups);

  // Sync search to store
  $effect(() => { inboxStore.setSearchChats(searchChats); });
  $effect(() => { inboxStore.setSearchGroups(searchGroups); });

  // Show search-input nur wenn viele Items
  const SEARCH_MIN = 8;
  let showSearchChats = $derived(inboxStore.contacts.length >= SEARCH_MIN);
  let showSearchGroups = $derived(inboxStore.groups.length >= SEARCH_MIN);

  // Selection-Sync mit Chat-Store
  let selectedKey = $derived(chatStore.selectedChat?.key
    ? (chatStore.selectedChat.type + ":" + chatStore.selectedChat.key)
    : null);

  function selectChat(contact) {
    // Display-Name aus profileCache (synchron). Falls noch nicht geladen → Background-Fetch
    // läuft schon via inboxStore.loadContacts; ChatHeader rendert reaktiv neu.
    const dn = profileCache.get(contact.handle);
    chatStore.selectChat({
      type: "dm",
      key: contact.handle,
      peer: contact.handle,
      name: dn ? `${dn} · @${contact.handle}` : `@${contact.handle}`,
      // isOnline-Status wird im ChatHeader live aus presenceStore gelesen,
      // nicht mehr aus chat.isOnline (das war stale).
    });
  }

  function selectGroup(group) {
    chatStore.selectChat({
      type: "group",
      key: group.id,
      name: group.name,
      memberCount: group.memberCount,
    });
  }

  // Modal-States
  let showAddContact = $state(false);
  let showCreateGroup = $state(false);
  let showRequests = $state(false);
  let showInviteLink = $state(false);
  let inviteConvoId = $state(null);
  let inviteGroupName = $state(null);

  function openAddContact() { showAddContact = true; }
  function openCreateGroup() { showCreateGroup = true; }
  function openRequests() { showRequests = true; }
  function openInvite1to1() {
    inviteConvoId = null;
    inviteGroupName = null;
    showInviteLink = true;
  }

  // Cross-component Öffnung (eGov 1.1): IconStrip-Bottom-Icon (A) +
  // AddContactModal-Fehler-Brücke (B) dispatchen 'renex:open-invite'.
  // InboxList ist im Nicht-Gast-Layout immer gemountet → sicherer Empfänger.
  $effect(() => {
    const onOpenInvite = () => openInvite1to1();
    window.addEventListener('renex:open-invite', onOpenInvite);
    return () => window.removeEventListener('renex:open-invite', onOpenInvite);
  });
  function openInviteToGroup(groupId, groupName) {
    inviteConvoId = groupId;
    inviteGroupName = groupName;
    showInviteLink = true;
  }

  // Pending requests count (für Banner)
  let pendingCount = $derived(inboxStore.pendingCount);
</script>

<div class="panel-list">
  <!-- Push-Notification-Banner (zeigt sich nur wenn Permission != granted) -->
  <PushBanner />

  <!-- ── DMs / Chats ───────────────────────────────────── -->
  {#if activeSection === 'chats'}
    <div class="list-section">
      <div class="panel-list-header">
        <span class="panel-list-title">{lang.tabChats || "Messages"}</span>
        <button
          class="panel-action-btn"
          onclick={openInvite1to1}
          title={lang.inviteByLinkTitle || "Per Link einladen (kein Account nötig)"}
          aria-label="Invite by link"
        >
          📨
        </button>
        <button
          class="panel-action-btn"
          onclick={openAddContact}
          title={lang.addContactTitle || "Add contact"}
          aria-label="Add contact"
        >
          ＋
        </button>
      </div>

      {#if showSearchChats}
        <div class="panel-search">
          <input
            type="search"
            placeholder="🔍 {lang.searchPlaceholder || 'Search…'}"
            bind:value={searchChats}
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
          />
        </div>
      {/if}

      {#if pendingCount > 0}
        <button class="pending-banner" onclick={openRequests} type="button">
          <span>📩 <strong>{pendingCount}</strong> {pendingCount === 1 ? (lang.pendingRequest || "offene Anfrage") : (lang.pendingRequests || "offene Anfragen")}</span>
          <span class="banner-arrow">{lang.viewBtn || "Anzeigen"} →</span>
        </button>
      {/if}

      <div class="contact-scroll">
        {#if chats.length === 0}
          <div class="empty-state">
            <div class="empty-icon">💬</div>
            <p>{lang.noChatsYet || "Noch keine Chats"}</p>
            <button class="empty-cta" onclick={openAddContact}>
              ＋ {lang.addContactBtn || "Kontakt hinzufügen"}
            </button>
          </div>
        {:else}
          <ul>
            {#each chats as c (c.handle)}
              {@const isGuest = isGuestHandle(c.handle)}
              {@const dn = isGuest ? guestDisplayName(c.handle) : profileCache.get(c.handle)}
              {@const hasActivity = !!c.lastSeen}
              {@const itemName = isGuest
                ? dn
                : (dn ? `${dn} · @${c.handle}` : `@${c.handle}`)}
              {@const initials = ((isGuest ? dn.replace(/^Guest /, '') : (dn || c.handle)) || '').slice(0, 2).toUpperCase()}
              <li>
                <ContactItem
                  name={itemName}
                  subtitle={hasActivity ? (c.lastMessage || "") : (lang.noChatYet || "Noch kein Chat")}
                  {initials}
                  unreadCount={inboxStore.unreadFor(c.handle)}
                  isOnline={presenceStore.isOnline(c.handle)}
                  isActive={selectedKey === "dm:" + c.handle}
                  dimmed={!hasActivity}
                  onclick={() => selectChat(c)}
                />
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  {/if}

  <!-- ── Groups ───────────────────────────────────────── -->
  {#if activeSection === 'groups'}
    <div class="list-section">
      <div class="panel-list-header">
        <span class="panel-list-title">{lang.tabGroups || "Groups"}</span>
        <button
          class="panel-action-btn"
          onclick={openCreateGroup}
          title={lang.createGroupBtn || "Create group"}
          aria-label="Create group"
        >
          ＋
        </button>
      </div>

      {#if showSearchGroups}
        <div class="panel-search">
          <input
            type="search"
            placeholder="🔍 {lang.searchPlaceholder || 'Search…'}"
            bind:value={searchGroups}
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
          />
        </div>
      {/if}

      {#if pendingCount > 0}
        <button class="pending-banner" onclick={openRequests} type="button">
          <span>📩 <strong>{pendingCount}</strong> {pendingCount === 1 ? (lang.pendingRequest || "offene Anfrage") : (lang.pendingRequests || "offene Anfragen")}</span>
          <span class="banner-arrow">{lang.viewBtn || "Anzeigen"} →</span>
        </button>
      {/if}

      <div class="contact-scroll">
        {#if groups.length === 0}
          <div class="empty-state">
            <div class="empty-icon">👥</div>
            <p>{lang.noGroupsYet || "Noch keine Gruppen"}</p>
            <button class="empty-cta" onclick={openCreateGroup}>
              ＋ {lang.createGroupBtn || "Gruppe erstellen"}
            </button>
          </div>
        {:else}
          <ul>
            {#each groups as g (g.id)}
              {@const groupSubtitle = g.lastSeen
                ? (g.lastMessage || (g.memberCount ? `${g.memberCount} ${lang.members || "Mitglieder"}` : ""))
                : (g.memberCount ? `${g.memberCount} ${lang.members || "Mitglieder"}` : "")}
              <li>
                <ContactItem
                  name={g.name}
                  subtitle={groupSubtitle}
                  isGroup={true}
                  unreadCount={inboxStore.unreadFor(g.id)}
                  isActive={selectedKey === "group:" + g.id}
                  onclick={() => selectGroup(g)}
                />
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  {/if}

  <!-- ── Voice ────────────────────────────────────────── -->
  {#if activeSection === 'voice'}
    <div class="list-section">
      <div class="panel-list-header">
        <span class="panel-list-title">📞 {lang.tabVoice || "Anrufe"}</span>
      </div>
      <div class="contact-scroll">
        {#if voiceStore.history.length === 0}
          <div class="empty-state">
            <div class="empty-icon">📞</div>
            <p>{lang.noCallsYet || "Noch keine Anrufe"}</p>
            <p class="empty-hint">{lang.openChatForCall || "Öffne einen Chat und tippe oben auf 📞"}</p>
          </div>
        {:else}
          <ul class="call-list">
            {#each voiceStore.history as call (call.id)}
              <li class="call-item" class:missed={call.missed}>
                <div class="call-direction">
                  {#if call.missed}
                    <span class="dir-missed" title="Missed">↙</span>
                  {:else if call.direction === 'outgoing'}
                    <span class="dir-out" title="Outgoing">↗</span>
                  {:else}
                    <span class="dir-in" title="Incoming">↙</span>
                  {/if}
                </div>
                <div class="call-info">
                  <div class="call-name">{call.peer.displayName || profileCache.get(call.peer.handle) || call.peer.handle}</div>
                  <div class="call-meta">
                    {#if call.missed}
                      {lang.callMissed || "Verpasst"}
                    {:else}
                      {Math.floor(call.duration / 60)}:{(call.duration % 60).toString().padStart(2, "0")}
                    {/if}
                    · {new Date(call.ts).toLocaleDateString(lang.locale || "de-DE", { day: "numeric", month: "short" })}
                  </div>
                </div>
                {#if call.withVideo}
                  <span class="video-icon" title="Video">🎥</span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  {/if}

  <!-- ── Servers (Phase 3A) ──────────────────────────── -->
  {#if activeSection === 'servers'}
    <div class="list-section">
      <ServersView />
    </div>
  {/if}
</div>

<!-- Modals -->
<AddContactModal bind:isOpen={showAddContact} />
<CreateGroupModal bind:isOpen={showCreateGroup} />
<PendingRequestsModal bind:isOpen={showRequests} />
<InviteLinkModal bind:isOpen={showInviteLink} convoId={inviteConvoId} groupName={inviteGroupName} />

<style>
  .panel-list {
    width: 300px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border-panel);
    background: rgba(13, 13, 17, 0.9);
    overflow: hidden;
  }

  .list-section {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .panel-list-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    /* Mobile (Notch): padding-top wächst mit safe-area-inset, sonst 16px. */
    padding: max(16px, var(--safe-top)) 14px 12px;
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }

  .panel-list-title {
    font-size: 15px;
    font-weight: 700;
    color: var(--text-primary);
    letter-spacing: 0.01em;
  }

  .panel-action-btn {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    border: none;
    background: var(--accent-voice-dim);
    color: var(--accent-voice);
    font-size: 20px;
    font-weight: 400;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    transition: background 0.15s;
  }

  .panel-action-btn:hover {
    background: rgba(56, 189, 248, 0.2);
  }

  .panel-search {
    padding: 8px 12px;
    flex-shrink: 0;
  }

  .panel-search input {
    width: 100%;
    padding: 8px 12px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    color: var(--text-primary);
    font-size: 13px;
  }

  .panel-search input:focus {
    border-color: var(--accent-voice);
  }

  .contact-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 4px 8px;
  }

  .contact-scroll ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
    text-align: center;
    gap: 10px;
    color: var(--text-muted);
  }

  .empty-icon {
    font-size: 36px;
    opacity: 0.5;
    margin-bottom: 6px;
  }

  .empty-state p {
    font-size: 13px;
    color: var(--text-muted);
  }

  .empty-hint {
    font-size: 11px !important;
    color: var(--text-muted) !important;
    opacity: 0.7;
  }

  .empty-cta {
    margin-top: 8px;
    padding: 8px 14px;
    border-radius: 8px;
    background: var(--accent-voice-dim);
    border: 1px solid var(--accent-voice);
    color: var(--accent-voice);
    font-size: 12px;
    font-weight: 600;
    transition: background 0.15s;
  }

  .empty-cta:hover {
    background: rgba(56, 189, 248, 0.2);
  }

  /* Pending Requests Banner */
  .pending-banner {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin: 6px 10px 4px;
    padding: 9px 12px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    cursor: pointer;
    color: var(--text-primary);
    font-size: 13px;
    text-align: left;
    transition: all 0.15s;
    flex-shrink: 0;
  }

  .pending-banner:hover {
    background: var(--accent-voice-dim);
    border-color: var(--accent-voice);
  }

  .pending-banner strong {
    color: var(--accent-voice);
    font-weight: 800;
  }

  .banner-arrow {
    font-size: 12px;
    font-weight: 600;
    color: var(--accent-voice);
  }

  /* Call list */
  .call-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .call-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 10px;
  }

  .call-item:hover {
    background: var(--bg-panel-alt);
  }

  .call-direction {
    flex-shrink: 0;
    font-size: 16px;
    font-weight: 700;
  }

  .dir-out    { color: var(--accent-voice); }
  .dir-in     { color: var(--status-success); }
  .dir-missed { color: var(--status-error); }

  .call-info {
    flex: 1;
    min-width: 0;
  }

  .call-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .call-item.missed .call-name {
    color: var(--status-error);
  }

  .call-meta {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 1px;
  }

  .video-icon {
    flex-shrink: 0;
    font-size: 14px;
    opacity: 0.7;
  }
</style>
