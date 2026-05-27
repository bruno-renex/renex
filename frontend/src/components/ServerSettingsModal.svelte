<!--
  ServerSettingsModal — Tab-basierte Server-Verwaltung (Phase 3A.5)

  Tabs:
   - Roles  : Liste aller Roles mit Color-Dot, Klick → RoleEditModal
   - Members: Liste mit Multi-Role-Toggles pro User

  Permissions:
   - Roles-Tab: nur sichtbar wenn MANAGE_ROLES (Owner bypassed)
   - Members-Tab: alle Members (read), Toggles nur wenn MANAGE_ROLES
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { serverStore } from '../stores/serverStore.svelte.js';
  import { toastStore } from '../stores/toast.svelte.js';
  import { Permissions, resolvePermissions } from '../lib/permissions.js';
  import RoleEditModal from './RoleEditModal.svelte';
  import { autoDeleteStore, autoDeleteLabel, ALLOWED_DAYS } from '../stores/autoDelete.svelte.js';

  let { isOpen = $bindable(false) } = $props();

  let lang = $derived(i18nStore.lang);
  let detail = $derived(serverStore.selectedServerDetail);
  let serverId = $derived(detail?.server?.id);

  let activeTab = $state('roles');     // 'roles' | 'members' | 'channels'
  let editRole = $state(null);          // role-object → öffnet RoleEditModal in edit-mode
  let editModalOpen = $state(false);    // bindable boolean für RoleEditModal
  let createRoleOpen = $state(false);   // → öffnet RoleEditModal in create-mode

  function openEditRole(r) {
    editRole = r;
    editModalOpen = true;
  }
  // Wenn Edit-Modal sich selbst schliesst (close()), setze auch editRole zurück
  $effect(() => {
    if (!editModalOpen && editRole) editRole = null;
  });
  let busyMember = $state(null);        // 'handle:roleId' während assign/revoke

  // Sortierte Roles (höchste position oben, default ganz unten)
  let sortedRoles = $derived.by(() => {
    if (!detail?.roles) return [];
    return [...detail.roles].sort((a, b) => {
      // Default-Role (everyone) immer ans Ende
      if (a.isDefault && !b.isDefault) return 1;
      if (b.isDefault && !a.isDefault) return -1;
      return (b.position || 0) - (a.position || 0);
    });
  });

  // Mein effektives Permission-Set (für UI-Hide von Action-Buttons)
  let myPerms = $derived.by(() => {
    if (!detail) return 0;
    return resolvePermissions({
      isOwner:    detail.myMembership?.isOwner === true,
      roles:      detail.roles?.filter(r => detail.myMembership?.roleIds?.includes(r.id)) || [],
      overrides:  [],
      userHandle: detail.myMembership?.handle || '',
    });
  });
  let canManageRoles = $derived(
    detail?.myMembership?.isOwner === true || (myPerms & Permissions.MANAGE_ROLES) === Permissions.MANAGE_ROLES
  );
  let canManageChannels = $derived(
    detail?.myMembership?.isOwner === true || (myPerms & Permissions.MANAGE_CHANNELS) === Permissions.MANAGE_CHANNELS
  );
  let canInvite = $derived(
    detail?.myMembership?.isOwner === true || (myPerms & Permissions.INVITE_MEMBERS) === Permissions.INVITE_MEMBERS
  );
  let isOwner = $derived(detail?.myMembership?.isOwner === true);

  // Auto-Delete pro Channel: Settings beim Öffnen des Channels-Tabs laden.
  let busyChannelAd = $state(null);   // channelId während set
  const channelChat = (c) => ({ type: 'channel', key: c.id, serverId });

  $effect(() => {
    if (activeTab === 'channels' && detail?.channels) {
      for (const c of detail.channels) autoDeleteStore.loadFor(channelChat(c));
    }
  });

  async function setChannelAutoDelete(c, days) {
    if (!canManageChannels || busyChannelAd) return;
    busyChannelAd = c.id;
    const r = await autoDeleteStore.set(channelChat(c), days);
    busyChannelAd = null;
    if (!r.ok) {
      toastStore.push((lang.error || 'Fehler') + ': ' + r.error, { kind: 'error' });
    } else {
      toastStore.push('✅ Auto-Delete: ' + autoDeleteLabel(days, lang), { kind: 'success' });
    }
  }

  // ── Invite-Verwaltung (Invites-Tab) ──
  let invites = $state([]);
  let invitesLoading = $state(false);
  let busyInvite = $state(false);
  let busyRevoke = $state(null);   // token während revoke
  let copiedToken = $state(null);  // token mit aktivem "Kopiert"-Feedback

  const inviteUrlFor = (token) => `https://app.renex.id/?join-server=${token}`;

  async function loadInvites() {
    if (!serverId) return;
    invitesLoading = true;
    const r = await serverStore.listInvites(serverId);
    invitesLoading = false;
    invites = r.ok ? r.invites : [];
    if (!r.ok) toastStore.push((lang.error || 'Fehler') + ': ' + r.error, { kind: 'error' });
  }

  $effect(() => {
    if (activeTab === 'invites' && serverId) void loadInvites();
  });

  async function createNewInvite() {
    if (!serverId || busyInvite) return;
    busyInvite = true;
    const r = await serverStore.createInvite(serverId, { ttlMin: 10080, maxUses: 0 });
    busyInvite = false;
    if (!r.ok) {
      toastStore.push((lang.inviteCreateFailed || 'Invite-Erstellung fehlgeschlagen') + ': ' + r.error, { kind: 'error' });
      return;
    }
    await loadInvites();
  }

  async function copyInvite(token) {
    try {
      await navigator.clipboard.writeText(inviteUrlFor(token));
      copiedToken = token;
      setTimeout(() => { if (copiedToken === token) copiedToken = null; }, 2000);
    } catch {
      toastStore.push(lang.copyFailed || 'Kopieren nicht möglich — Link manuell auswählen', { kind: 'info' });
    }
  }

  async function revokeInvite(token) {
    if (busyRevoke) return;
    if (!confirm(lang.inviteRevokeConfirm || 'Diesen Invite-Link widerrufen? Er wird sofort ungültig.')) return;
    busyRevoke = token;
    const r = await serverStore.deleteInvite(serverId, token);
    busyRevoke = null;
    if (!r.ok) {
      toastStore.push((lang.inviteRevokeFailed || 'Widerruf fehlgeschlagen') + ': ' + r.error, { kind: 'error' });
      return;
    }
    invites = invites.filter(i => i.token !== token);
  }

  function inviteExpiryText(inv) {
    if (!inv.expires_at) return lang.inviteNeverExpires || 'unbegrenzt';
    const d = new Date(inv.expires_at);
    if (Date.now() > inv.expires_at) return lang.inviteExpired || 'abgelaufen';
    return d.toLocaleString(lang.locale || 'de-DE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function inviteUsesText(inv) {
    return inv.max_uses > 0 ? `${inv.uses}/${inv.max_uses}` : `${inv.uses}/∞`;
  }

  // Höchste eigene Role-Position (für Position-Slider-Cap im RoleEditModal)
  let actorMaxPosition = $derived.by(() => {
    if (isOwner) return Number.MAX_SAFE_INTEGER;
    const myRoles = detail?.roles?.filter(r => detail?.myMembership?.roleIds?.includes(r.id)) || [];
    return myRoles.reduce((m, r) => Math.max(m, r.position || 0), 0);
  });

  function close() { isOpen = false; }
  function onBackdropClick(e) {
    if (e.target.classList.contains('ss-overlay')) close();
  }
  function onKey(e) {
    if (e.key === 'Escape' && isOpen) close();
  }

  // ── Member-Role-Toggle ──
  async function toggleMemberRole(member, role) {
    if (!canManageRoles) return;
    if (role.isDefault) return; // Default-Role kann nicht entzogen werden
    if (member.isOwner && (role.permissions & Permissions.ADMINISTRATOR)) return; // sinnlos
    const key = `${member.handle}:${role.id}`;
    if (busyMember === key) return;
    busyMember = key;

    const has = (member.roleIds || []).includes(role.id);
    const r = has
      ? await serverStore.revokeRole(serverId, member.handle, role.id)
      : await serverStore.assignRole(serverId, member.handle, role.id);

    busyMember = null;
    if (!r.ok) {
      toastStore.push((lang.error || 'Fehler') + ': ' + r.error, { kind: 'error' });
    }
  }

  function memberInitials(handle, nickname) {
    const src = (nickname || handle || '').replace(/^@/, '');
    return src.split(/[\s._-]+/).map(p => p[0]).join('').slice(0, 2).toUpperCase() || '?';
  }
</script>

<svelte:window onkeydown={onKey} />

{#if isOpen && detail}
  <div class="ss-overlay" role="presentation" onclick={onBackdropClick}>
    <div class="ss-dialog" role="dialog" aria-labelledby="ss-title" aria-modal="true">
      <div class="ss-header">
        <h3 id="ss-title">⚙ {lang.serverSettingsTitle || 'Server-Einstellungen'} — {detail.server.name}</h3>
        <button type="button" class="close-btn" onclick={close} aria-label="Close">×</button>
      </div>

      <nav class="ss-tabs" role="tablist">
        <button
          role="tab"
          class="ss-tab"
          class:active={activeTab === 'roles'}
          onclick={() => activeTab = 'roles'}
        >
          🛡 {lang.tabRoles || 'Roles'} ({detail.roles?.length || 0})
        </button>
        <button
          role="tab"
          class="ss-tab"
          class:active={activeTab === 'members'}
          onclick={() => activeTab = 'members'}
        >
          👥 {lang.tabMembers || 'Mitglieder'} ({detail.members?.length || 0})
        </button>
        <button
          role="tab"
          class="ss-tab"
          class:active={activeTab === 'channels'}
          onclick={() => activeTab = 'channels'}
        >
          # {lang.tabChannels || 'Channels'} ({detail.channels?.length || 0})
        </button>
        {#if canInvite}
          <button
            role="tab"
            class="ss-tab"
            class:active={activeTab === 'invites'}
            onclick={() => activeTab = 'invites'}
          >
            🔗 {lang.tabInvites || 'Invites'}
          </button>
        {/if}
      </nav>

      <!-- ═══════ ROLES TAB ═══════ -->
      {#if activeTab === 'roles'}
        <div class="ss-content">
          {#if canManageRoles}
            <button class="btn-create" onclick={() => createRoleOpen = true}>
              + {lang.roleCreateBtn || 'Role erstellen'}
            </button>
          {:else}
            <div class="ss-info-banner">
              {lang.rolesReadOnly || '👁 Read-only — du brauchst MANAGE_ROLES um Roles zu bearbeiten.'}
            </div>
          {/if}

          <ul class="ss-role-list">
            {#each sortedRoles as r (r.id)}
              <li>
                <button
                  class="ss-role-item"
                  onclick={() => canManageRoles && openEditRole(r)}
                  disabled={!canManageRoles}
                  title={canManageRoles ? (lang.roleEdit || 'Bearbeiten') : ''}
                >
                  <span class="ss-color-dot" style="background:{r.color || '#71717a'}"></span>
                  <span class="ss-role-name">{r.name}</span>
                  {#if r.isDefault}
                    <span class="ss-role-badge">{lang.roleDefault || 'default'}</span>
                  {/if}
                  <span class="ss-role-pos">pos {r.position}</span>
                  {#if r.permissions & Permissions.ADMINISTRATOR}
                    <span class="ss-role-badge ss-role-badge-admin">ADMIN</span>
                  {/if}
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <!-- ═══════ MEMBERS TAB ═══════ -->
      {#if activeTab === 'members'}
        <div class="ss-content">
          {#if !canManageRoles}
            <div class="ss-info-banner">
              {lang.membersReadOnly || '👁 Read-only — du brauchst MANAGE_ROLES um Member-Roles zu ändern.'}
            </div>
          {/if}

          <ul class="ss-member-list">
            {#each detail.members as m (m.handle)}
              <li class="ss-member-item">
                <div class="ss-member-head">
                  <div class="ss-member-avatar">{memberInitials(m.handle, m.nickname)}</div>
                  <div class="ss-member-info">
                    <div class="ss-member-name">
                      @{m.handle}
                      {#if m.isOwner}<span class="ss-owner-badge">👑 {lang.owner || 'Owner'}</span>{/if}
                    </div>
                    {#if m.nickname}<div class="ss-member-nick">„{m.nickname}"</div>{/if}
                  </div>
                </div>

                <!-- Role-Chips (alle Roles, ON/OFF toggelbar wenn canManageRoles) -->
                <div class="ss-role-chips">
                  {#each sortedRoles as r (r.id)}
                    {@const hasIt = (m.roleIds || []).includes(r.id)}
                    {@const busy = busyMember === `${m.handle}:${r.id}`}
                    <button
                      class="ss-role-chip"
                      class:on={hasIt}
                      class:locked={r.isDefault || (m.isOwner && (r.permissions & Permissions.ADMINISTRATOR))}
                      style="--chip-color: {r.color || '#71717a'}"
                      onclick={() => toggleMemberRole(m, r)}
                      disabled={busy || !canManageRoles || r.isDefault}
                      title={r.isDefault ? (lang.roleDefaultLocked || 'Default-Role — nicht entfernbar') : (hasIt ? (lang.roleRevoke || 'Entfernen') : (lang.roleAssign || 'Zuweisen'))}
                    >
                      {#if busy}<span class="spinner-sm"></span>{/if}
                      {r.name}
                    </button>
                  {/each}
                </div>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <!-- ═══════ CHANNELS TAB (Auto-Delete) ═══════ -->
      {#if activeTab === 'channels'}
        <div class="ss-content">
          {#if !canManageChannels}
            <div class="ss-info-banner">
              {lang.channelsAutoDeleteReadOnly || '👁 Read-only — du brauchst MANAGE_CHANNELS um Auto-Delete zu ändern.'}
            </div>
          {:else}
            <div class="ss-info-banner">
              {lang.channelsAutoDeleteHint || 'Auto-Delete löscht Nachrichten im Channel nach Ablauf für alle Mitglieder. Alle bekommen eine System-Nachricht.'}
            </div>
          {/if}

          <ul class="ss-channel-list">
            {#each (detail.channels || []) as c (c.id)}
              {@const ad = autoDeleteStore.getFor({ type: 'channel', key: c.id })}
              <li class="ss-channel-row">
                <div class="ss-channel-label">
                  <span class="ss-channel-hash">#</span>
                  <span class="ss-channel-nm">{c.name}</span>
                </div>
                <div class="ss-ad-options">
                  {#each ALLOWED_DAYS as days}
                    <button
                      class="ss-ad-btn"
                      class:active={(ad?.days || 0) === days}
                      onclick={() => setChannelAutoDelete(c, days)}
                      disabled={!canManageChannels || busyChannelAd === c.id}
                    >
                      {autoDeleteLabel(days, lang)}
                    </button>
                  {/each}
                </div>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <!-- ═══════ INVITES TAB ═══════ -->
      {#if activeTab === 'invites'}
        <div class="ss-content">
          <button class="btn-create" onclick={createNewInvite} disabled={busyInvite}>
            {#if busyInvite}…{:else}+ {lang.inviteCreateBtn || 'Invite-Link erstellen'}{/if}
          </button>

          {#if invitesLoading}
            <div class="ss-info-banner">{lang.loading || 'Lädt…'}</div>
          {:else if invites.length === 0}
            <div class="ss-info-banner">{lang.invitesEmpty || 'Noch keine aktiven Invite-Links. Erstelle einen oben.'}</div>
          {:else}
            <ul class="ss-invite-list">
              {#each invites as inv (inv.token)}
                <li class="ss-invite-row">
                  <div class="ss-invite-link-row">
                    <input class="ss-invite-input" type="text" value={inviteUrlFor(inv.token)} readonly onclick={(e) => e.currentTarget.select()} />
                    <button class="ss-invite-copy" class:copied={copiedToken === inv.token} onclick={() => copyInvite(inv.token)}>
                      {#if copiedToken === inv.token}✓{:else}📋{/if}
                    </button>
                  </div>
                  <div class="ss-invite-meta">
                    <span>{lang.inviteUses || 'Nutzungen'}: {inviteUsesText(inv)}</span>
                    <span>{lang.expiresAt || 'Gültig bis'}: {inviteExpiryText(inv)}</span>
                    <button class="ss-invite-revoke" onclick={() => revokeInvite(inv.token)} disabled={busyRevoke === inv.token}>
                      {#if busyRevoke === inv.token}…{:else}🗑️ {lang.inviteRevokeBtn || 'Widerrufen'}{/if}
                    </button>
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    </div>
  </div>

  <!-- Edit-Modal (öffnet wenn editRole gesetzt + editModalOpen=true) -->
  {#if editRole}
    <RoleEditModal
      bind:isOpen={editModalOpen}
      mode="edit"
      role={editRole}
      {serverId}
      {isOwner}
      {actorMaxPosition}
    />
  {/if}

  <!-- Create-Modal -->
  <RoleEditModal
    bind:isOpen={createRoleOpen}
    mode="create"
    {serverId}
    {isOwner}
    {actorMaxPosition}
  />
{/if}

<style>
  .ss-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    z-index: 1090;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    animation: fadeIn 0.15s ease-out;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .ss-dialog {
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 14px;
    padding: 0;
    width: 100%;
    max-width: 640px;
    max-height: calc(100vh - 40px);
    max-height: calc(100dvh - 40px);
    overflow: hidden;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
  }

  .ss-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .ss-header h3 {
    margin: 0;
    font-size: 15px;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .close-btn {
    background: none;
    border: none;
    font-size: 22px;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
    line-height: 1;
    flex-shrink: 0;
  }
  .close-btn:hover { color: var(--text-primary); background: var(--bg-panel-alt); }

  .ss-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border-subtle);
    padding: 0 12px;
  }
  .ss-tab {
    padding: 11px 14px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.12s;
  }
  .ss-tab:hover { color: var(--text-primary); }
  .ss-tab.active {
    color: var(--accent-voice);
    border-bottom-color: var(--accent-voice);
  }

  .ss-content {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .ss-info-banner {
    padding: 10px 12px;
    background: var(--bg-panel-alt);
    border-radius: 8px;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .btn-create {
    background: var(--accent-voice);
    color: #07070a;
    border: none;
    padding: 9px 14px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    align-self: flex-start;
  }
  .btn-create:hover { opacity: 0.9; }

  .ss-role-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ss-role-item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
    color: var(--text-primary);
    font-size: 13px;
    transition: all 0.12s;
  }
  .ss-role-item:hover:not(:disabled) {
    border-color: var(--accent-voice);
  }
  .ss-role-item:disabled { cursor: default; opacity: 0.85; }

  .ss-color-dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }
  .ss-role-name {
    flex: 1;
    font-weight: 600;
  }
  .ss-role-badge {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--bg-panel);
    color: var(--text-muted);
    border: 1px solid var(--border-subtle);
  }
  .ss-role-badge-admin {
    color: var(--status-error);
    border-color: var(--status-error);
  }
  .ss-role-pos {
    font-size: 10px;
    color: var(--text-muted);
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }

  .ss-member-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .ss-member-item {
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .ss-member-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .ss-member-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--bg-panel);
    border: 1px solid var(--border-subtle);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
    color: var(--text-primary);
  }
  .ss-member-info { flex: 1; min-width: 0; }
  .ss-member-name {
    font-size: 13px;
    font-weight: 700;
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ss-owner-badge {
    font-size: 10px;
    color: var(--accent-voice);
  }
  .ss-member-nick {
    font-size: 11px;
    color: var(--text-muted);
    font-style: italic;
  }

  .ss-role-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .ss-role-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 9px;
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: 12px;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.12s;
  }
  .ss-role-chip:hover:not(:disabled) {
    border-color: var(--chip-color);
    color: var(--chip-color);
  }
  .ss-role-chip.on {
    background: var(--chip-color);
    border-color: var(--chip-color);
    color: #07070a;
  }
  .ss-role-chip.on:hover:not(:disabled) {
    opacity: 0.8;
  }
  .ss-role-chip.locked {
    cursor: not-allowed;
  }
  .ss-role-chip:disabled { opacity: 0.6; cursor: not-allowed; }

  .spinner-sm {
    display: inline-block;
    width: 9px;
    height: 9px;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .ss-channel-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .ss-channel-row {
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .ss-channel-label {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .ss-channel-hash {
    color: var(--text-muted);
    font-weight: 700;
  }
  .ss-channel-nm {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ss-ad-options {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .ss-ad-btn {
    padding: 5px 10px;
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: 12px;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.12s;
  }
  .ss-ad-btn:hover:not(:disabled) {
    border-color: var(--accent-voice);
    color: var(--accent-voice);
  }
  .ss-ad-btn.active {
    background: var(--accent-voice);
    border-color: var(--accent-voice);
    color: #07070a;
  }
  .ss-ad-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .ss-invite-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .ss-invite-row {
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .ss-invite-link-row {
    display: flex;
    gap: 6px;
  }
  .ss-invite-input {
    flex: 1;
    min-width: 0;
    padding: 7px 10px;
    background: var(--bg-panel);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 11px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  .ss-invite-input:focus { border-color: var(--accent-voice); outline: none; }
  .ss-invite-copy {
    flex-shrink: 0;
    padding: 7px 11px;
    background: var(--accent-voice);
    color: #07070a;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
  }
  .ss-invite-copy.copied { background: var(--status-success); }
  .ss-invite-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    font-size: 11px;
    color: var(--text-muted);
  }
  .ss-invite-revoke {
    margin-left: auto;
    padding: 5px 10px;
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    color: var(--text-muted);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.12s;
  }
  .ss-invite-revoke:hover:not(:disabled) {
    color: var(--status-error);
    border-color: var(--status-error);
  }
  .ss-invite-revoke:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
