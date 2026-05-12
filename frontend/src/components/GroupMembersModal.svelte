<!--
  GroupMembersModal — zeigt alle Mitglieder einer Gruppe (read-only).
  Triggered durch Klick auf "X Mitglieder" im ChatHeader.

  Backend: GET /groups/members?groupId=...
  Liefert: { group: {...}, members: [{ member_handle, role, joined_at }, …] }

  Anzeige:
    - Avatar mit Initialen
    - Display-Name (aus profileCache) + @handle
    - 👑-Badge bei Admins
    - "(Du)"-Marker beim eigenen Eintrag
    - Sortierung: Admins zuerst, dann alphabetisch nach Display-Name
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { userStore } from '../stores/user.svelte.js';
  import { profileCache } from '../stores/profileCache.svelte.js';
  import { apiFetch } from '../lib/api.js';
  import { isGuestHandle, guestDisplayName } from '../lib/guestNames.js';
  import { captureException } from '../lib/sentry.js';
  import { memberActionsStore } from '../stores/memberActions.svelte.js';

  let { isOpen = $bindable(false), groupId = null, groupName = '' } = $props();

  let lang = $derived(i18nStore.lang);
  let me   = $derived(userStore.myUser);

  let members = $state([]);
  let loading = $state(false);
  let error   = $state(null);

  // Modal öffnen → Liste laden + Display-Names prefetchen.
  $effect(() => {
    if (!isOpen || !groupId) return;
    void loadMembers();
  });

  async function loadMembers() {
    loading = true;
    error = null;
    try {
      const r = await apiFetch(`/groups/members?groupId=${encodeURIComponent(groupId)}`);
      if (r.ok && Array.isArray(r.data?.members)) {
        // Dedup defensiv: Backend hat PK(convo_id, member_handle), aber
        // each_key_duplicate-Crashes in Sentry zeigen, dass Duplikate trotzdem
        // entstehen (Race? Migration?). Erst-Vorkommen wird gemeldet.
        const seen = new Set();
        const deduped = [];
        for (const m of r.data.members) {
          const h = m.member_handle;
          if (!h) continue;
          if (seen.has(h)) {
            captureException(new Error('Duplicate member handle in /groups/members response'), {
              context: 'GroupMembersModal.load',
              extra: { handle: h, groupId, totalMembers: r.data.members.length },
            });
            continue;
          }
          seen.add(h);
          deduped.push(m);
        }
        members = deduped;
        // Display-Names für Nicht-Gast-Handles prefetchen — der Cache
        // liefert reaktiv die Namen an die UI.
        const handlesToFetch = members
          .map(m => m.member_handle)
          .filter(h => !isGuestHandle(h) && !profileCache.get(h));
        if (handlesToFetch.length > 0) {
          profileCache.prefetch(handlesToFetch);
        }
      } else {
        error = r.error || 'failed';
      }
    } catch (e) {
      captureException(e, { context: 'GroupMembersModal.load' });
      error = e.message || 'failed';
    } finally {
      loading = false;
    }
  }

  // Sortierte Liste: Admins erst, dann alphabetisch nach Display-Name (Fallback Handle).
  // Gäste am Ende ihrer Gruppe (Admin/Member).
  let sortedMembers = $derived.by(() => {
    if (!members.length) return [];
    const enriched = members.map(m => {
      const h = m.member_handle;
      const isGuest = isGuestHandle(h);
      const displayName = isGuest
        ? guestDisplayName(h)
        : (profileCache.get(h) || h);
      return {
        handle: h,
        role: m.role,
        joinedAt: m.joined_at,
        isGuest,
        displayName,
        isMe: h === me,
      };
    });
    return enriched.sort((a, b) => {
      // 1. Admins vor Members
      if (a.role === 'admin' && b.role !== 'admin') return -1;
      if (b.role === 'admin' && a.role !== 'admin') return 1;
      // 2. Echte User vor Gästen
      if (a.isGuest && !b.isGuest) return 1;
      if (b.isGuest && !a.isGuest) return -1;
      // 3. Alphabetisch nach Display-Name
      return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
    });
  });

  function close() { isOpen = false; }
  function onBackdropClick(e) {
    if (e.target.classList.contains('gm-overlay')) close();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  function getInitials(name, handle) {
    const src = (name || handle || '').replace(/^@/, '').replace(/^Guest /, '');
    if (!src) return '?';
    return src
      .split(/[\s._-]+/)
      .map(p => p[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if isOpen}
  <div class="gm-overlay" role="presentation" onclick={onBackdropClick}>
    <div class="gm-dialog" role="dialog" aria-labelledby="gm-title" aria-modal="true">
      <div class="gm-header">
        <div class="gm-title-wrap">
          <h3 id="gm-title">👥 {lang.groupMembersTitle || 'Mitglieder'}</h3>
          {#if groupName}
            <div class="gm-subtitle">{groupName}</div>
          {/if}
        </div>
        <button class="close-btn" onclick={close} aria-label="Close">×</button>
      </div>

      {#if loading && members.length === 0}
        <div class="gm-state">{lang.loadingMembers || 'Lade Mitglieder…'}</div>
      {:else if error}
        <div class="gm-state gm-state-error">{lang.loadMembersFailed || 'Fehler'}</div>
      {:else if sortedMembers.length === 0}
        <div class="gm-state">{lang.noOtherMembers || 'Keine Mitglieder'}</div>
      {:else}
        <div class="gm-count">{sortedMembers.length} {lang.membersHeading || 'Mitglieder'}</div>
        <ul class="gm-list">
          {#each sortedMembers as m (m.handle)}
            {@const isClickable = !m.isMe && !m.isGuest}
            <li class="gm-item-wrap">
              {#if isClickable}
                <button
                  type="button"
                  class="gm-item gm-item-clickable"
                  onclick={() => { close(); memberActionsStore.open(m.handle); }}
                  title={lang.openMemberActions || 'Aktionen anzeigen'}
                >
                  <div class="gm-avatar" class:is-guest={m.isGuest}>
                    {getInitials(m.displayName, m.handle)}
                  </div>
                  <div class="gm-info">
                    <div class="gm-name">
                      <span class="gm-display">{m.displayName}</span>
                    </div>
                    <div class="gm-handle">@{m.handle}</div>
                  </div>
                  {#if m.role === 'admin'}
                    <span class="gm-badge gm-badge-admin" title={lang.roleAdmin || 'Admin'}>
                      👑 {lang.roleAdmin || 'Admin'}
                    </span>
                  {/if}
                </button>
              {:else}
                <div class="gm-item" class:is-me={m.isMe}>
                  <div class="gm-avatar" class:is-guest={m.isGuest}>
                    {getInitials(m.displayName, m.handle)}
                  </div>
                  <div class="gm-info">
                    <div class="gm-name">
                      <span class="gm-display">{m.displayName}</span>
                      {#if m.isMe}
                        <span class="gm-you">({lang.youSuffix || 'Du'})</span>
                      {/if}
                    </div>
                    {#if !m.isGuest}
                      <div class="gm-handle">@{m.handle}</div>
                    {/if}
                  </div>
                  {#if m.role === 'admin'}
                    <span class="gm-badge gm-badge-admin" title={lang.roleAdmin || 'Admin'}>
                      👑 {lang.roleAdmin || 'Admin'}
                    </span>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
{/if}

<style>
  .gm-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
    padding: 16px;
    animation: fadeIn 0.15s ease-out;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .gm-dialog {
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 14px;
    padding: 22px;
    width: 100%;
    max-width: 440px;
    max-height: calc(100vh - 32px);
    max-height: calc(100dvh - 32px);
    overflow-y: auto;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
  }

  .gm-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px;
    margin-bottom: 14px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .gm-title-wrap { flex: 1; min-width: 0; }
  .gm-header h3 {
    margin: 0;
    font-size: 16px;
    color: var(--text-primary);
  }
  .gm-subtitle {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 3px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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

  .gm-state {
    text-align: center;
    padding: 30px 0;
    color: var(--text-muted);
    font-size: 13px;
  }
  .gm-state-error { color: var(--status-error, #ef4444); }

  .gm-count {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent-voice);
    margin-bottom: 8px;
  }

  .gm-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .gm-item-wrap { list-style: none; }
  .gm-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    width: 100%;
    box-sizing: border-box;
  }
  .gm-item.is-me {
    border-color: var(--accent-voice);
    background: var(--accent-voice-dim);
  }
  .gm-item-clickable {
    cursor: pointer;
    text-align: left;
    color: var(--text-primary);
    font: inherit;
    transition: all 0.12s;
  }
  .gm-item-clickable:hover {
    border-color: var(--accent-voice);
    background: var(--bg-panel);
  }
  .gm-item-clickable:focus-visible {
    outline: 2px solid var(--accent-voice);
    outline-offset: 1px;
  }

  .gm-avatar {
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: var(--bg-panel);
    border: 1px solid var(--border-subtle);
    color: var(--text-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 13px;
    flex-shrink: 0;
  }
  .gm-avatar.is-guest {
    color: var(--text-muted);
    font-style: italic;
  }

  .gm-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .gm-name {
    font-size: 13px;
    font-weight: 700;
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .gm-display {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .gm-you {
    font-size: 11px;
    font-weight: 600;
    color: var(--accent-voice);
    flex-shrink: 0;
  }
  .gm-handle {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 11px;
    color: var(--text-muted);
  }

  .gm-badge {
    font-size: 10px;
    font-weight: 800;
    padding: 3px 8px;
    border-radius: 10px;
    flex-shrink: 0;
    letter-spacing: 0.04em;
  }
  .gm-badge-admin {
    background: var(--accent-voice);
    color: #07070a;
  }
</style>
