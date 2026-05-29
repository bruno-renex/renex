<!--
  ChannelEditModal — Phase 3A.5: Channel-Detail + Private Channels

  Tabs:
   - Allgemein  : Name + Topic editieren (PATCH /servers/<sid>/channels/<cid>)
   - Berechtigungen: Privacy-Toggle + Access-Liste (channel_permission_overrides)

  Permissions:
   - Geöffnet wird das Modal aus ServerSettingsModal's Channels-Tab.
   - Aktionen gated by MANAGE_CHANNELS (Name/Topic) bzw. MANAGE_ROLES (Permissions).
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { serverStore } from '../stores/serverStore.svelte.js';
  import { toastStore } from '../stores/toast.svelte.js';
  import { Permissions } from '../lib/permissions.js';

  let { isOpen = $bindable(false), channelId = null } = $props();

  let lang = $derived(i18nStore.lang);
  let detail = $derived(serverStore.selectedServerDetail);
  let serverId = $derived(detail?.server?.id);
  let channel = $derived(detail?.channels?.find(c => c.id === channelId));

  // Permission checks
  let myMembership = $derived(detail?.myMembership);
  let myRoles = $derived(
    detail?.roles?.filter(r => myMembership?.roleIds?.includes(r.id)) || []
  );
  let myEffective = $derived(
    myMembership?.isOwner === true
      ? 0xFFFF
      : myRoles.reduce((a, r) => a | r.permissions, 0)
  );
  let canManageChannels = $derived(
    myMembership?.isOwner === true || (myEffective & Permissions.MANAGE_CHANNELS) === Permissions.MANAGE_CHANNELS
  );
  let canManageRoles = $derived(
    myMembership?.isOwner === true || (myEffective & Permissions.MANAGE_ROLES) === Permissions.MANAGE_ROLES
  );

  let activeTab = $state('general');     // 'general' | 'permissions'
  let didInitTab = $state(false);
  $effect(() => {
    if (isOpen && !didInitTab && channel) {
      activeTab = canManageRoles ? 'permissions' : 'general';
      didInitTab = true;
    } else if (!isOpen) {
      didInitTab = false;
    }
  });

  // ── General-Tab State ──
  let nameInput = $state('');
  let topicInput = $state('');
  let didInitInputs = $state(false);
  $effect(() => {
    if (isOpen && channel && !didInitInputs) {
      nameInput = channel.name || '';
      topicInput = channel.topic || '';
      didInitInputs = true;
    } else if (!isOpen) {
      didInitInputs = false;
    }
  });
  let isDirtyGeneral = $derived(
    !!channel && (
      nameInput.trim() !== (channel.name || '') ||
      (topicInput.trim() || '') !== (channel.topic || '')
    )
  );
  let savingGeneral = $state(false);

  async function saveGeneral() {
    if (!channelId || !canManageChannels || savingGeneral || !isDirtyGeneral) return;
    savingGeneral = true;
    const patch = {};
    if (nameInput.trim() !== (channel?.name || '')) patch.name = nameInput.trim();
    if ((topicInput.trim() || '') !== (channel?.topic || '')) patch.topic = topicInput.trim() || null;
    const r = await serverStore.updateChannel(serverId, channelId, patch);
    savingGeneral = false;
    if (r.ok) {
      toastStore.push(lang.channelSavedToast || '✅ Channel gespeichert', { kind: 'success' });
    } else {
      toastStore.push((lang.error || 'Fehler') + ': ' + r.error, { kind: 'error' });
    }
  }

  // ── Permissions-Tab State ──
  let overrides = $state([]);
  let permsLoading = $state(false);
  let busyPerm = $state(null);   // 'kind:id' während Set/Delete

  async function loadOverrides() {
    if (!serverId || !channelId) return;
    permsLoading = true;
    const r = await serverStore.listChannelPermissions(serverId, channelId);
    permsLoading = false;
    overrides = r.ok ? r.overrides : [];
    if (!r.ok) toastStore.push((lang.error || 'Fehler') + ': ' + r.error, { kind: 'error' });
  }
  $effect(() => {
    if (isOpen && channelId && canManageRoles && activeTab === 'permissions') void loadOverrides();
  });

  let everyoneRole = $derived(detail?.roles?.find(r => r.isDefault));
  let isPrivate = $derived(
    !!everyoneRole && overrides.some(o =>
      o.targetKind === 'role' &&
      o.targetId === everyoneRole.id &&
      (o.denyBits & Permissions.VIEW_CHANNEL) === Permissions.VIEW_CHANNEL
    )
  );

  // Wer hat zusätzlich Zugriff (ausser everyone-Deny-Override) — allow VIEW_CHANNEL
  let accessGrants = $derived(
    overrides
      .filter(o => !(o.targetKind === 'role' && o.targetId === everyoneRole?.id))
      .filter(o => (o.allowBits & Permissions.VIEW_CHANNEL) === Permissions.VIEW_CHANNEL)
  );

  // Verbleibende Rollen / Members als Optionen für "+ Hinzufügen"
  let availableRoles = $derived(
    (detail?.roles || []).filter(r =>
      !r.isDefault &&
      !accessGrants.some(g => g.targetKind === 'role' && g.targetId === r.id)
    )
  );
  let availableMembers = $derived(
    (detail?.members || []).filter(m =>
      m.handle !== myMembership?.handle &&
      !accessGrants.some(g => g.targetKind === 'member' && g.targetId === m.handle)
    )
  );

  let selectedRoleToAdd = $state('');
  let selectedMemberToAdd = $state('');

  async function togglePrivate() {
    if (!canManageRoles || !everyoneRole || busyPerm) return;
    busyPerm = `role:${everyoneRole.id}`;
    let r;
    if (isPrivate) {
      r = await serverStore.deleteChannelPermission(serverId, channelId, 'role', everyoneRole.id);
    } else {
      r = await serverStore.setChannelPermission(serverId, channelId, 'role', everyoneRole.id, 0, Permissions.VIEW_CHANNEL);
    }
    busyPerm = null;
    if (r.ok) await loadOverrides();
    else toastStore.push((lang.error || 'Fehler') + ': ' + r.error, { kind: 'error' });
  }

  async function addRoleAccess() {
    if (!selectedRoleToAdd || busyPerm) return;
    const roleId = selectedRoleToAdd;
    busyPerm = `role:${roleId}`;
    const existing = overrides.find(o => o.targetKind === 'role' && o.targetId === roleId);
    const newAllow = (existing?.allowBits || 0) | Permissions.VIEW_CHANNEL;
    const r = await serverStore.setChannelPermission(serverId, channelId, 'role', roleId, newAllow, existing?.denyBits || 0);
    busyPerm = null;
    selectedRoleToAdd = '';
    if (r.ok) await loadOverrides();
    else toastStore.push((lang.error || 'Fehler') + ': ' + r.error, { kind: 'error' });
  }

  async function addMemberAccess() {
    if (!selectedMemberToAdd || busyPerm) return;
    const handle = selectedMemberToAdd;
    busyPerm = `member:${handle}`;
    const existing = overrides.find(o => o.targetKind === 'member' && o.targetId === handle);
    const newAllow = (existing?.allowBits || 0) | Permissions.VIEW_CHANNEL;
    const r = await serverStore.setChannelPermission(serverId, channelId, 'member', handle, newAllow, existing?.denyBits || 0);
    busyPerm = null;
    selectedMemberToAdd = '';
    if (r.ok) await loadOverrides();
    else toastStore.push((lang.error || 'Fehler') + ': ' + r.error, { kind: 'error' });
  }

  async function removeAccess(o) {
    if (busyPerm) return;
    busyPerm = `${o.targetKind}:${o.targetId}`;
    const newAllow = (o.allowBits & ~Permissions.VIEW_CHANNEL) >>> 0;
    let r;
    if (newAllow === 0 && o.denyBits === 0) {
      r = await serverStore.deleteChannelPermission(serverId, channelId, o.targetKind, o.targetId);
    } else {
      r = await serverStore.setChannelPermission(serverId, channelId, o.targetKind, o.targetId, newAllow, o.denyBits);
    }
    busyPerm = null;
    if (r.ok) await loadOverrides();
    else toastStore.push((lang.error || 'Fehler') + ': ' + r.error, { kind: 'error' });
  }

  function roleName(roleId) {
    return detail?.roles?.find(r => r.id === roleId)?.name || roleId;
  }

  function close() { isOpen = false; }
  function onBackdropClick(e) { if (e.target === e.currentTarget) close(); }
  function onKey(e) { if (e.key === 'Escape' && isOpen) close(); }
</script>

<svelte:window onkeydown={onKey} />

{#if isOpen && channel}
  <div class="ce-overlay" role="presentation" onclick={onBackdropClick}>
    <div class="ce-dialog" role="dialog" aria-labelledby="ce-title" aria-modal="true">
      <div class="ce-header">
        <h3 id="ce-title"># {channel.name}</h3>
        <button type="button" class="close-btn" onclick={close} aria-label="Close">×</button>
      </div>

      <nav class="ce-tabs" role="tablist">
        {#if canManageChannels}
          <button
            role="tab"
            class="ce-tab"
            class:active={activeTab === 'general'}
            onclick={() => activeTab = 'general'}
          >
            ⚙ {lang.tabGeneral || 'Allgemein'}
          </button>
        {/if}
        {#if canManageRoles}
          <button
            role="tab"
            class="ce-tab"
            class:active={activeTab === 'permissions'}
            onclick={() => activeTab = 'permissions'}
          >
            🔒 {lang.tabPermissions || 'Berechtigungen'}
            {#if isPrivate}<span class="ce-badge-private">{lang.privateBadge || 'privat'}</span>{/if}
          </button>
        {/if}
      </nav>

      <!-- ── GENERAL TAB ── -->
      {#if activeTab === 'general' && canManageChannels}
        <div class="ce-content">
          <div class="ce-field">
            <label for="ce-name">{lang.channelName || 'Name'}</label>
            <input id="ce-name" type="text" maxlength="64" bind:value={nameInput} disabled={savingGeneral} />
          </div>
          <div class="ce-field">
            <label for="ce-topic">{lang.channelTopic || 'Thema'}</label>
            <input id="ce-topic" type="text" maxlength="1024" bind:value={topicInput} disabled={savingGeneral} />
          </div>
          <button
            type="button"
            class="btn-create"
            onclick={saveGeneral}
            disabled={savingGeneral || !isDirtyGeneral}
          >
            {savingGeneral ? (lang.saving || 'Speichern…') : (lang.save || 'Speichern')}
          </button>
        </div>
      {/if}

      <!-- ── PERMISSIONS TAB ── -->
      {#if activeTab === 'permissions' && canManageRoles}
        <div class="ce-content">
          {#if permsLoading}
            <div class="ce-info-banner">{lang.loading || 'Lädt…'}</div>
          {:else}

            <div class="ce-private-row">
              <label class="ce-toggle">
                <input
                  type="checkbox"
                  checked={isPrivate}
                  onchange={togglePrivate}
                  disabled={busyPerm !== null}
                />
                <span>🔒 {lang.privateChannelToggle || 'Privater Channel'}</span>
              </label>
              <div class="ce-private-hint">
                {isPrivate
                  ? (lang.privateOnHint || 'Nur Mitglieder mit explizitem Zugriff (unten) sehen diesen Channel. Owner + ADMINISTRATOR sehen ihn immer.')
                  : (lang.privateOffHint || 'Alle Server-Mitglieder sehen diesen Channel.')}
              </div>
            </div>

            {#if isPrivate}
              <div class="ce-section">
                <h4>{lang.accessListTitle || 'Wer hat Zugriff'}</h4>
                {#if accessGrants.length === 0}
                  <div class="ce-info-banner">{lang.accessEmpty || 'Noch niemand mit explizitem Zugriff — nur Owner + ADMINISTRATOR sehen den Channel.'}</div>
                {:else}
                  <ul class="ce-access-list">
                    {#each accessGrants as o (o.targetKind + ':' + o.targetId)}
                      <li class="ce-access-item">
                        <span class="ce-access-icon">{o.targetKind === 'role' ? '🛡' : '👤'}</span>
                        <span class="ce-access-name">
                          {o.targetKind === 'role' ? roleName(o.targetId) : '@' + o.targetId}
                        </span>
                        <button
                          type="button"
                          class="btn-danger btn-sm"
                          onclick={() => removeAccess(o)}
                          disabled={busyPerm === `${o.targetKind}:${o.targetId}`}
                        >
                          {(lang.remove || 'Entfernen')}
                        </button>
                      </li>
                    {/each}
                  </ul>
                {/if}

                <div class="ce-add-row">
                  <select bind:value={selectedRoleToAdd} disabled={busyPerm !== null || availableRoles.length === 0}>
                    <option value="">{lang.addRoleSelect || '+ Role hinzufügen…'}</option>
                    {#each availableRoles as r (r.id)}
                      <option value={r.id}>🛡 {r.name}</option>
                    {/each}
                  </select>
                  <button
                    type="button"
                    class="btn-create btn-sm"
                    onclick={addRoleAccess}
                    disabled={!selectedRoleToAdd || busyPerm !== null}
                  >
                    {(lang.add || 'Add')}
                  </button>
                </div>

                <div class="ce-add-row">
                  <select bind:value={selectedMemberToAdd} disabled={busyPerm !== null || availableMembers.length === 0}>
                    <option value="">{lang.addMemberSelect || '+ Member hinzufügen…'}</option>
                    {#each availableMembers as m (m.handle)}
                      <option value={m.handle}>👤 @{m.handle}</option>
                    {/each}
                  </select>
                  <button
                    type="button"
                    class="btn-create btn-sm"
                    onclick={addMemberAccess}
                    disabled={!selectedMemberToAdd || busyPerm !== null}
                  >
                    {(lang.add || 'Add')}
                  </button>
                </div>
              </div>
            {/if}

          {/if}
        </div>
      {/if}

    </div>
  </div>
{/if}

<style>
  .ce-overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center;
    z-index: 1100;
    padding: 16px;
  }
  .ce-dialog {
    width: 100%; max-width: 560px;
    max-height: 90vh;
    background: var(--bg-panel, #18181b);
    border: 1px solid var(--border-panel, #27272a);
    border-radius: 12px;
    display: flex; flex-direction: column;
    overflow: hidden;
  }
  .ce-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 16px;
    border-bottom: 1px solid var(--border-subtle, #2a2a2e);
  }
  .ce-header h3 { margin: 0; font-size: 16px; color: var(--text-primary, #f4f4f5); }
  .close-btn {
    background: transparent; border: none; cursor: pointer;
    color: var(--text-muted, #a1a1aa); font-size: 24px;
    width: 28px; height: 28px; padding: 0;
  }
  .close-btn:hover { color: var(--text-primary, #f4f4f5); }

  .ce-tabs {
    display: flex; gap: 4px;
    padding: 8px 8px 0;
    border-bottom: 1px solid var(--border-subtle, #2a2a2e);
    flex-wrap: wrap;
  }
  .ce-tab {
    background: transparent; border: none; cursor: pointer;
    padding: 8px 14px;
    color: var(--text-muted, #a1a1aa);
    font-size: 13px;
    border-radius: 6px 6px 0 0;
    border-bottom: 2px solid transparent;
    transition: color 0.15s, border-color 0.15s;
  }
  .ce-tab.active {
    color: var(--text-primary, #f4f4f5);
    border-bottom-color: var(--accent, #3b82f6);
  }
  .ce-badge-private {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 6px;
    background: var(--status-warning, #f59e0b);
    color: #000;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 600;
    text-transform: lowercase;
  }

  .ce-content {
    padding: 16px;
    overflow-y: auto;
    flex: 1;
  }

  .ce-field { margin-bottom: 12px; }
  .ce-field label {
    display: block;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted, #a1a1aa);
    margin-bottom: 4px;
  }
  .ce-field input {
    width: 100%;
    padding: 8px 10px;
    background: var(--bg-panel-alt, #27272a);
    border: 1px solid var(--border-panel, #3f3f46);
    border-radius: 6px;
    color: var(--text-primary, #f4f4f5);
    font-size: 13px;
    box-sizing: border-box;
  }

  .btn-create, .btn-danger {
    border: none; border-radius: 6px; cursor: pointer;
    padding: 8px 14px; font-size: 13px;
  }
  .btn-create { background: var(--accent, #3b82f6); color: #fff; }
  .btn-create:disabled { background: var(--bg-panel-alt, #27272a); color: var(--text-muted, #71717a); cursor: not-allowed; }
  .btn-danger { background: var(--status-error, #ef4444); color: #fff; }
  .btn-danger:disabled { background: var(--bg-panel-alt, #27272a); color: var(--text-muted, #71717a); cursor: not-allowed; }
  .btn-sm { padding: 6px 10px; font-size: 12px; }

  .ce-info-banner {
    padding: 10px 12px;
    background: var(--bg-panel-alt, #27272a);
    border-left: 3px solid var(--accent, #3b82f6);
    border-radius: 4px;
    font-size: 12px;
    color: var(--text-muted, #a1a1aa);
    margin: 10px 0;
  }

  .ce-private-row {
    background: var(--bg-panel-alt, #27272a);
    padding: 12px 14px;
    border-radius: 8px;
    margin-bottom: 14px;
  }
  .ce-toggle {
    display: flex; align-items: center; gap: 8px;
    cursor: pointer;
    font-size: 14px;
    color: var(--text-primary, #f4f4f5);
  }
  .ce-toggle input { width: 16px; height: 16px; cursor: pointer; }
  .ce-private-hint {
    margin-top: 6px;
    font-size: 11px;
    color: var(--text-muted, #a1a1aa);
  }

  .ce-section { margin-top: 12px; }
  .ce-section h4 {
    margin: 0 0 8px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted, #a1a1aa);
  }

  .ce-access-list {
    list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 6px;
    margin-bottom: 10px;
  }
  .ce-access-item {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 10px;
    background: var(--bg-panel-alt, #27272a);
    border: 1px solid var(--border-subtle, #2a2a2e);
    border-radius: 6px;
  }
  .ce-access-icon { font-size: 14px; }
  .ce-access-name { flex: 1; font-size: 13px; color: var(--text-primary, #f4f4f5); }

  .ce-add-row {
    display: flex; gap: 8px;
    margin-bottom: 8px;
  }
  .ce-add-row select {
    flex: 1;
    padding: 6px 10px;
    background: var(--bg-panel-alt, #27272a);
    border: 1px solid var(--border-panel, #3f3f46);
    border-radius: 6px;
    color: var(--text-primary, #f4f4f5);
    font-size: 12px;
  }
</style>
