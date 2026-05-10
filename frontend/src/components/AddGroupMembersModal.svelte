<!--
  AddGroupMembersModal — Mitglieder zu existierender Gruppe hinzufügen.

  Pattern recycled aus CreateGroupModal:
    - Kontakt-Liste aus inboxStore.contacts
    - Suchfeld (live filter nach Display-Name + Handle)
    - Multi-Select via Checkboxen
    - Bereits-Mitglieder werden als "Bereits dabei" disabled angezeigt

  Submit: pro selektiertem Member ein POST /groups/invite { groupId, handle }
  (Backend hat keinen Bulk-Endpoint — mehrere parallele Calls).

  Footer enthält "Per Link einladen"-Link für Non-Kontakte → öffnet das
  externe InviteLinkModal (parent kontrolliert).
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { inboxStore } from '../stores/inbox.svelte.js';
  import { profileCache } from '../stores/profileCache.svelte.js';
  import { apiFetch } from '../lib/api.js';
  import { captureException } from '../lib/sentry.js';

  let {
    isOpen = $bindable(false),
    groupId = null,
    groupName = '',
    onInviteByLink = null,   // optional callback: () => void  (öffnet InviteLinkModal)
  } = $props();

  let lang = $derived(i18nStore.lang);
  let contacts = $derived(inboxStore.contacts);

  let selectedHandles = $state(new Set());
  let memberSearch = $state('');
  let isSubmitting = $state(false);
  let errorMsg = $state('');
  let resultMsg = $state('');

  // Aktuelle Member-Handles (für "Bereits dabei"-Markierung).
  // Geladen wenn Modal öffnet — Backend-Call /groups/members.
  let existingMembers = $state(new Set());
  let loadingMembers = $state(false);

  // Modal-Open: State zurücksetzen + Member-Liste laden.
  $effect(() => {
    if (!isOpen) return;
    selectedHandles = new Set();
    memberSearch = '';
    errorMsg = '';
    resultMsg = '';
    void loadExistingMembers();
    setTimeout(() => {
      document.getElementById('agm-search-input')?.focus();
    }, 50);
  });

  async function loadExistingMembers() {
    if (!groupId) return;
    loadingMembers = true;
    try {
      const r = await apiFetch(`/groups/members?groupId=${encodeURIComponent(groupId)}`);
      if (r.ok && Array.isArray(r.data?.members)) {
        existingMembers = new Set(r.data.members.map(m => m.member_handle));
      }
    } catch (e) {
      captureException(e, { context: 'AddGroupMembersModal.loadMembers' });
    } finally {
      loadingMembers = false;
    }
  }

  // Filter: nach Display-Name + Handle. Bereits-Mitglieder bleiben sichtbar
  // (aber sind nicht selektierbar) — gibt User Feedback dass Person schon drin ist.
  let filteredContacts = $derived.by(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(c => {
      const h = (c.handle || '').toLowerCase();
      const dn = (c.displayName || profileCache.get(c.handle) || '').toLowerCase();
      return h.includes(q) || dn.includes(q);
    });
  });

  let canSubmit = $derived(selectedHandles.size > 0 && !isSubmitting && !!groupId);

  function toggleMember(handle) {
    if (existingMembers.has(handle)) return;   // bereits Mitglied — kein Toggle
    const next = new Set(selectedHandles);
    if (next.has(handle)) next.delete(handle);
    else next.add(handle);
    selectedHandles = next;
  }

  async function submit() {
    if (!canSubmit) return;
    isSubmitting = true;
    errorMsg = '';
    resultMsg = '';

    const handles = [...selectedHandles];
    // Parallele Invites — Backend erwartet pro Call { groupId, handle }
    const results = await Promise.allSettled(
      handles.map(h => apiFetch('/groups/invite', {
        method: 'POST',
        body: { groupId, handle: h },
      }))
    );

    const ok = [];
    const failed = [];
    results.forEach((res, i) => {
      const handle = handles[i];
      if (res.status === 'fulfilled' && res.value?.ok) {
        ok.push(handle);
      } else {
        const err = res.status === 'fulfilled'
          ? (res.value?.error || res.value?.data?.error || 'failed')
          : (res.reason?.message || 'failed');
        failed.push({ handle, err });
      }
    });

    isSubmitting = false;

    if (failed.length === 0) {
      // Alle erfolgreich → Modal schließen
      isOpen = false;
      return;
    }
    // Teilerfolg oder kompletter Fehlschlag → Hinweis im Modal lassen, User kann erneut wählen
    if (ok.length > 0) {
      resultMsg = (lang.addMembersPartial || '{ok} hinzugefügt, {fail} fehlgeschlagen')
        .replace('{ok}', ok.length).replace('{fail}', failed.length);
      // Erfolgreiche aus Selection entfernen + zu existing hinzufügen
      const nextSel = new Set(selectedHandles);
      const nextExist = new Set(existingMembers);
      for (const h of ok) { nextSel.delete(h); nextExist.add(h); }
      selectedHandles = nextSel;
      existingMembers = nextExist;
    } else {
      errorMsg = (lang.addMembersAllFailed || 'Hinzufügen fehlgeschlagen') + ': ' + (failed[0]?.err || '');
    }
  }

  function close() {
    if (isSubmitting) return;
    isOpen = false;
  }

  function onBackdropClick(e) {
    if (e.target.classList.contains('agm-overlay')) close();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && canSubmit) {
      e.preventDefault();
      submit();
    }
  }

  function onInviteLinkClick() {
    if (!onInviteByLink) return;
    isOpen = false;
    // Parent ruft sein InviteLinkModal — etwas verzögert damit dieses Modal
    // sauber geschlossen ist bevor das andere aufgeht.
    setTimeout(() => onInviteByLink(), 80);
  }
</script>

<svelte:window onkeydown={onKey} />

{#if isOpen}
  <div class="agm-overlay" role="presentation" onclick={onBackdropClick}>
    <div class="agm-dialog" role="dialog" aria-labelledby="agm-title" aria-modal="true">
      <div class="agm-header">
        <div class="agm-title-wrap">
          <h3 id="agm-title">➕ {lang.addMembers || 'Mitglieder hinzufügen'}</h3>
          {#if groupName}
            <div class="agm-subtitle">{groupName}</div>
          {/if}
        </div>
        <button class="close-btn" onclick={close} disabled={isSubmitting} aria-label="Close">×</button>
      </div>

      {#if errorMsg}
        <div class="agm-state agm-state-error">{errorMsg}</div>
      {/if}
      {#if resultMsg}
        <div class="agm-state agm-state-info">{resultMsg}</div>
      {/if}

      {#if contacts.length === 0}
        <div class="agm-empty">
          <div class="agm-empty-icon">👥</div>
          <p>{lang.noContactsYet || 'Du hast noch keine Kontakte.'}</p>
        </div>
      {:else}
        <input
          id="agm-search-input"
          type="text"
          class="search-input"
          placeholder={lang.searchContactsPlaceholder || 'Kontakte suchen…'}
          bind:value={memberSearch}
          autocomplete="off"
          spellcheck="false"
          disabled={isSubmitting}
        />

        <div class="member-list">
          {#if filteredContacts.length === 0}
            <div class="agm-state">{lang.noContactsMatch || 'Keine Kontakte gefunden.'}</div>
          {/if}
          {#each filteredContacts as c (c.handle)}
            {@const isMember = existingMembers.has(c.handle)}
            {@const isSelected = selectedHandles.has(c.handle)}
            {@const dn = c.displayName || profileCache.get(c.handle) || null}
            <button
              class="member-item"
              class:selected={isSelected}
              class:disabled={isMember}
              onclick={() => toggleMember(c.handle)}
              disabled={isMember || isSubmitting}
              type="button"
            >
              <div class="member-avatar">{c.handle.slice(0, 2).toUpperCase()}</div>
              <div class="member-info">
                <div class="member-name">
                  {dn ? `${dn} · @${c.handle}` : `@${c.handle}`}
                </div>
                {#if isMember}
                  <div class="member-tag">{lang.alreadyMemberLabel || 'Bereits dabei'}</div>
                {/if}
              </div>
              <div class="checkmark" class:on={isSelected}>
                {#if isMember}—{:else if isSelected}✓{/if}
              </div>
            </button>
          {/each}
        </div>
      {/if}

      <div class="buttons">
        <button class="btn btn-secondary" onclick={close} disabled={isSubmitting}>
          {lang.cancel || 'Abbrechen'}
        </button>
        <button class="btn btn-primary" onclick={submit} disabled={!canSubmit}>
          {#if isSubmitting}
            <span class="spinner"></span>
          {/if}
          {selectedHandles.size > 0
            ? `${lang.addBtn || 'Hinzufügen'} (${selectedHandles.size})`
            : (lang.addBtn || 'Hinzufügen')}
        </button>
      </div>

      {#if onInviteByLink}
        <div class="agm-footer">
          <span class="agm-footer-hint">{lang.notInContactsHint || 'Nicht in deinen Kontakten?'}</span>
          <button class="agm-link-btn" type="button" onclick={onInviteLinkClick} disabled={isSubmitting}>
            🔗 {lang.inviteByLinkBtn || 'Per Link einladen'}
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .agm-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    z-index: 1100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    animation: fadeIn 0.15s ease-out;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .agm-dialog {
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
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .agm-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .agm-title-wrap { flex: 1; min-width: 0; }
  .agm-header h3 { margin: 0; font-size: 16px; color: var(--text-primary); }
  .agm-subtitle {
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
  .close-btn:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-panel-alt); }

  .agm-empty {
    text-align: center;
    padding: 30px 0;
    color: var(--text-muted);
  }
  .agm-empty-icon { font-size: 36px; margin-bottom: 8px; opacity: 0.6; }

  .agm-state {
    font-size: 12px;
    color: var(--text-muted);
    padding: 8px 10px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
  }
  .agm-state-error {
    color: var(--status-error, #ef4444);
    border-color: color-mix(in srgb, var(--status-error, #ef4444) 40%, transparent);
  }
  .agm-state-info {
    color: var(--accent-voice);
    border-color: var(--accent-voice);
  }

  .search-input {
    width: 100%;
    padding: 10px 12px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    color: var(--text-primary);
    font-size: 14px;
    box-sizing: border-box;
  }
  .search-input:focus {
    outline: none;
    border-color: var(--accent-voice);
  }

  .member-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 280px;
    overflow-y: auto;
  }

  .member-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    cursor: pointer;
    text-align: left;
    transition: all 0.12s;
    color: var(--text-primary);
    font: inherit;
  }
  .member-item:hover:not(:disabled) { background: var(--bg-panel); }
  .member-item.selected {
    border-color: var(--accent-voice);
    background: var(--accent-voice-dim);
  }
  .member-item.disabled,
  .member-item:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .member-avatar {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--bg-panel);
    border: 1px solid var(--border-subtle);
    color: var(--text-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 12px;
    flex-shrink: 0;
  }

  .member-info {
    flex: 1;
    min-width: 0;
  }
  .member-name {
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .member-tag {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 1px;
  }

  .checkmark {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 1.5px solid var(--border-subtle);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .checkmark.on {
    background: var(--accent-voice);
    color: #07070a;
    border-color: var(--accent-voice);
    font-weight: 800;
  }

  .buttons {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    padding-top: 8px;
  }
  .btn {
    padding: 8px 14px;
    border-radius: 8px;
    border: 1px solid transparent;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: all 0.15s;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-secondary {
    background: transparent;
    border-color: var(--border-subtle);
    color: var(--text-primary);
  }
  .btn-secondary:hover:not(:disabled) { background: var(--bg-panel-alt); }
  .btn-primary {
    background: var(--accent-voice);
    color: #07070a;
  }
  .btn-primary:hover:not(:disabled) { background: #0ea5e9; }

  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .agm-footer {
    margin-top: 6px;
    padding-top: 12px;
    border-top: 1px solid var(--border-subtle);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .agm-footer-hint {
    color: var(--text-muted);
  }
  .agm-link-btn {
    background: transparent;
    border: 1px solid var(--accent-voice);
    color: var(--accent-voice);
    padding: 4px 10px;
    border-radius: 6px;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.12s;
  }
  .agm-link-btn:hover:not(:disabled) {
    background: var(--accent-voice-dim);
  }
  .agm-link-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
