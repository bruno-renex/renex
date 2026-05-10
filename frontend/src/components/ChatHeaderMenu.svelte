<!--
  ChatHeaderMenu — 3-Punkte-Dropdown mit Slide-Submenüs.

  Inhalt je nach Chat-Typ + Rolle:
    DM:    Notifications, Auto-Delete (Konsens), Kontakt entfernen
    Group: Notifications, Auto-Delete (LWW), Mitglieder hinzufügen,
           Per Link einladen, Gruppenname ändern (Admin),
           Teilnehmer entfernen (Admin), Gruppe verlassen

  Pattern: state-driven view = 'main' | 'notifications' | 'autoDelete' | 'removeMember'.
  Slide-Animation per CSS-Transform (Hauptmenü ←→ Submenu).
  Click-outside / Escape schließt komplett.
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { inboxStore } from '../stores/inbox.svelte.js';
  import { chatStore } from '../stores/chat.svelte.js';
  import { toastStore } from '../stores/toast.svelte.js';
  import { profileCache } from '../stores/profileCache.svelte.js';
  import { notificationsStore } from '../stores/notifications.svelte.js';
  import { autoDeleteStore, autoDeleteLabel, ALLOWED_DAYS } from '../stores/autoDelete.svelte.js';
  import { userStore } from '../stores/user.svelte.js';
  import { apiFetch } from '../lib/api.js';
  import InviteLinkModal from './InviteLinkModal.svelte';
  import AddGroupMembersModal from './AddGroupMembersModal.svelte';

  let { chat } = $props();

  let lang = $derived(i18nStore.lang);
  let me   = $derived(userStore.myUser);
  let isGroup = $derived(chat?.type === 'group');

  let open = $state(false);
  let view = $state('main');           // main | notifications | autoDelete | removeMember
  let busy = $state(false);
  let containerEl = $state(null);
  let showInviteLink = $state(false);
  let showAddMembers = $state(false);
  let groupMembers = $state([]);

  let mute = $derived(notificationsStore.getMuteFor(chat));
  let isMuted = $derived(!!mute);
  let adSetting = $derived(autoDeleteStore.getFor(chat));
  let myRole = $derived(adSetting?.myRole || (chat?.myRole) || 'member');
  let isAdmin = $derived(myRole === 'admin');

  // Setting laden wenn Dropdown geöffnet wird
  $effect(() => {
    if (open && chat) {
      autoDeleteStore.loadFor(chat);
    }
  });

  // Click-outside + Escape
  $effect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (containerEl && !containerEl.contains(e.target)) close();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (view !== 'main') view = 'main';
        else close();
      }
    };
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

  function toggleOpen() {
    open = !open;
    if (open) view = 'main';
  }
  function close() { open = false; view = 'main'; }
  function back() { view = 'main'; }

  // ── Notifications ────────────────────────────────────
  async function applyMute(level, durationMin) {
    if (busy) return;
    busy = true;
    try { await notificationsStore.setMute(chat, level, durationMin); }
    finally { busy = false; close(); }
  }

  // ── Auto-Delete ──────────────────────────────────────
  async function setAutoDelete(days) {
    if (busy) return;
    busy = true;
    try {
      const r = await autoDeleteStore.set(chat, days);
      if (r.ok) {
        if (chat.type === 'dm') {
          toastStore.push(
            (lang.autoDeleteProposal || ((label) => `📤 Vorschlag gesendet: ${label}`))(autoDeleteLabel(days, lang)),
            { kind: 'info' }
          );
        } else {
          toastStore.push(
            days ? (lang.autoDeleteSet || ((l) => `✅ Auto-Delete: ${l}`))(autoDeleteLabel(days, lang))
                 : (lang.autoDeleteDisabled || '✅ Auto-Delete deaktiviert'),
            { kind: 'success' }
          );
        }
      } else {
        toastStore.push(r.error || 'Fehler', { kind: 'error' });
      }
    } finally { busy = false; close(); }
  }

  async function acceptAutoDelete() {
    if (busy) return;
    busy = true;
    try { await autoDeleteStore.accept(chat); }
    finally { busy = false; close(); }
  }

  async function declineAutoDelete() {
    if (busy) return;
    busy = true;
    try { await autoDeleteStore.decline(chat); }
    finally { busy = false; close(); }
  }

  // ── DM: Kontakt entfernen ────────────────────────────
  async function onRemoveContact() {
    if (busy || !chat?.peer) return;
    const peer = chat.peer;
    const dn = profileCache.get(peer);
    const display = dn ? `${dn} (@${peer})` : `@${peer}`;
    const confirmText = (lang.removeContactConfirm || 'Kontakt {peer} entfernen? Der Chat-Verlauf bleibt lokal erhalten.')
      .replace('{peer}', display);
    if (!confirm(confirmText)) return;
    busy = true;
    close();
    try {
      const r = await inboxStore.removeContact(peer);
      if (r.ok) {
        chatStore.selectChat(null);
        toastStore.push((lang.removeContactSuccess || 'Kontakt entfernt').replace('{peer}', display), { kind: 'success' });
      } else {
        toastStore.push(lang.removeContactFailed || 'Kontakt konnte nicht entfernt werden', { kind: 'error' });
      }
    } finally { busy = false; }
  }

  // ── Group: Add Members ───────────────────────────────
  // Mitglieder hinzufügen → Modal mit Kontakt-Picker (Multi-Select + Suche).
  // Field-Mismatch zum Backend (`handle` vs. `members:[]`) ist im Modal selbst korrigiert.
  function onAddMembers() {
    if (!chat?.key) return;
    close();
    showAddMembers = true;
  }
  // Bridge: aus dem AddGroupMembersModal heraus auf "Per Link einladen" wechseln.
  function openInviteLinkFromAdd() {
    showInviteLink = true;
  }

  function onInviteByLink() {
    open = false;
    showInviteLink = true;
  }

  // ── Group: Rename ────────────────────────────────────
  async function onRename() {
    if (busy || !chat?.key) return;
    const cur = chat.name || '';
    const next = prompt(lang.renameGroupPrompt || 'Neuer Gruppenname:', cur);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === cur) return;
    busy = true;
    close();
    try {
      const r = await apiFetch('/groups/rename', {
        method: 'POST',
        body: { groupId: chat.key, name: trimmed },
      });
      if (r.ok) {
        // Optimistisches lokales Update — WS-Echo (group_renamed) ist idempotent.
        inboxStore.renameGroup(chat.key, trimmed);
        chatStore.renameSelectedIfMatch(chat.key, trimmed);
        chatStore.appendLocalSystemMessage(
          chat.key,
          `${me} hat die Gruppe in "${trimmed}" umbenannt`,
          Date.now()
        );
        toastStore.push(lang.groupRenamed || 'Gruppe umbenannt', { kind: 'success' });
      } else {
        toastStore.push(r.error || lang.groupRenameFailed || 'Umbenennen fehlgeschlagen', { kind: 'error' });
      }
    } finally { busy = false; }
  }

  // ── Group: Remove Member (Admin) ─────────────────────
  async function loadMembers() {
    if (!chat?.key) return;
    try {
      const r = await apiFetch(`/groups/members?groupId=${encodeURIComponent(chat.key)}`);
      if (r.ok && Array.isArray(r.data?.members)) {
        groupMembers = r.data.members.filter(m => m.handle !== me);
      }
    } catch {}
  }

  async function onRemoveMember(handle) {
    if (busy) return;
    if (!confirm((lang.removeMemberConfirm || 'Mitglied @{h} aus der Gruppe entfernen?').replace('{h}', handle))) return;
    busy = true;
    try {
      const r = await apiFetch('/groups/remove', {
        method: 'POST',
        body: { groupId: chat.key, member: handle },
      });
      if (r.ok) {
        toastStore.push(lang.memberRemoved || 'Mitglied entfernt', { kind: 'success' });
        groupMembers = groupMembers.filter(m => m.handle !== handle);
      } else {
        toastStore.push(r.error || 'Fehler', { kind: 'error' });
      }
    } finally { busy = false; }
  }

  // ── Group: Leave ─────────────────────────────────────
  async function onLeave() {
    if (busy || !chat?.key) return;
    if (!confirm(lang.leaveGroupConfirm || 'Gruppe wirklich verlassen?')) return;
    busy = true;
    close();
    try {
      const r = await apiFetch('/groups/leave', {
        method: 'POST',
        body: { groupId: chat.key },
      });
      if (r.ok) {
        chatStore.selectChat(null);
        toastStore.push(lang.groupLeft || 'Gruppe verlassen', { kind: 'success' });
      } else {
        toastStore.push(r.error || 'Fehler', { kind: 'error' });
      }
    } finally { busy = false; }
  }

  // Mute-Status für Anzeige im Hauptmenü
  let muteStatusText = $derived.by(() => {
    if (!mute) return null;
    if (mute.expiresAt) {
      const d = new Date(mute.expiresAt);
      const today = new Date();
      const sameDay = d.toDateString() === today.toDateString();
      return sameDay
        ? d.toLocaleTimeString(lang.locale || 'de-DE', { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString(lang.locale || 'de-DE', { day: 'numeric', month: 'short' });
    }
    return lang.muteIndefiniteShort || '∞';
  });

  let adStatusText = $derived.by(() => {
    if (!adSetting || adSetting.status === 'off') return lang.autoDeleteOff || 'Aus';
    if (adSetting.status === 'pending') return (lang.autoDeletePending || 'Anstehend') + ' · ' + autoDeleteLabel(adSetting.days, lang);
    return autoDeleteLabel(adSetting.days, lang);
  });

  let isPendingFromPeer = $derived(
    adSetting?.status === 'pending' && adSetting?.proposedBy && adSetting.proposedBy !== me
  );
</script>

<div class="menu-wrap" bind:this={containerEl}>
  <button
    class="action-btn"
    onclick={toggleOpen}
    title={lang.moreActions || 'Mehr'}
    aria-label={lang.moreActions || 'More'}
    aria-expanded={open}
    aria-haspopup="menu"
  >
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="1.6"/>
      <circle cx="12" cy="12" r="1.6"/>
      <circle cx="19" cy="12" r="1.6"/>
    </svg>
  </button>

  {#if open}
    <div class="menu" role="menu">
      <div class="slider" data-view={view}>

        <!-- ═══════ MAIN ═══════ -->
        <div class="pane main-pane">
          {#if isPendingFromPeer}
            <div class="pending-banner">
              <strong>@{adSetting.proposedBy}</strong>
              {lang.autoDeleteProposalIncoming || 'schlägt Auto-Delete vor:'}
              {autoDeleteLabel(adSetting.days, lang)}
              <div class="pending-actions">
                <button class="mini-btn ok" onclick={acceptAutoDelete} disabled={busy}>{lang.accept || 'Akzeptieren'}</button>
                <button class="mini-btn no" onclick={declineAutoDelete} disabled={busy}>{lang.decline || 'Ablehnen'}</button>
              </div>
            </div>
            <div class="menu-sep"></div>
          {/if}

          <button class="menu-item" onclick={() => view = 'notifications'} role="menuitem">
            <span class="ico">{isMuted ? '🔕' : '🔔'}</span>
            <span class="label">{lang.notifications || 'Benachrichtigungen'}</span>
            <span class="value">{muteStatusText || (lang.notificationsOn || 'An')}</span>
            <span class="chevron">›</span>
          </button>

          <button class="menu-item" onclick={() => view = 'autoDelete'} role="menuitem">
            <span class="ico">⏱</span>
            <span class="label">{lang.autoDeleteLabel || 'Auto-Delete'}</span>
            <span class="value">{adStatusText}</span>
            <span class="chevron">›</span>
          </button>

          <div class="menu-sep"></div>

          {#if isGroup}
            <button class="menu-item" onclick={onAddMembers} role="menuitem">
              <span class="ico">👥</span>
              <span class="label">{lang.addMembers || 'Mitglieder hinzufügen'}</span>
            </button>
            <button class="menu-item" onclick={onInviteByLink} role="menuitem">
              <span class="ico">🔗</span>
              <span class="label">{lang.inviteByLinkLabel || 'Per Link einladen'}</span>
            </button>

            {#if isAdmin}
              <div class="menu-sep"></div>
              <button class="menu-item" onclick={onRename} role="menuitem">
                <span class="ico">✏️</span>
                <span class="label">{lang.renameGroup || 'Gruppenname ändern'}</span>
              </button>
              <button class="menu-item" onclick={() => { view = 'removeMember'; loadMembers(); }} role="menuitem">
                <span class="ico">👤</span>
                <span class="label">{lang.removeMemberLabel || 'Teilnehmer entfernen'}</span>
                <span class="chevron">›</span>
              </button>
            {/if}

            <div class="menu-sep"></div>
            <button class="menu-item danger" onclick={onLeave} disabled={busy} role="menuitem">
              <span class="ico">🚪</span>
              <span class="label">{lang.leaveGroup || 'Gruppe verlassen'}</span>
            </button>
          {:else}
            <button class="menu-item danger" onclick={onRemoveContact} disabled={busy} role="menuitem">
              <span class="ico">🗑</span>
              <span class="label">{lang.removeContact || 'Kontakt entfernen'}</span>
            </button>
          {/if}
        </div>

        <!-- ═══════ NOTIFICATIONS ═══════ -->
        <div class="pane sub-pane">
          <button class="back-btn" onclick={back} aria-label={lang.backBtn || 'Zurück'}>
            <span class="back-arrow">‹</span> {lang.notifications || 'Benachrichtigungen'}
          </button>
          <div class="menu-sep"></div>
          {#if isMuted}
            <div class="info-row">
              {#if mute?.expiresAt}
                {(lang.muteUntil || 'Stumm bis')}: <strong>{muteStatusText}</strong>
              {:else}
                {lang.muteIndefinite || 'Stummgeschaltet (manuell aufheben)'}
              {/if}
            </div>
            <button class="menu-item highlight" onclick={() => applyMute('nothing', null)} disabled={busy}>
              🔔 {lang.unmute || 'Wieder einschalten'}
            </button>
            <div class="menu-sep"></div>
          {/if}
          <div class="menu-label">{lang.muteFor || 'Stumm für'}</div>
          <button class="menu-item" onclick={() => applyMute('all', 60)} disabled={busy}>{lang.mute1h || '1 Stunde'}</button>
          <button class="menu-item" onclick={() => applyMute('all', 8 * 60)} disabled={busy}>{lang.mute8h || '8 Stunden'}</button>
          <button class="menu-item" onclick={() => applyMute('all', 24 * 60)} disabled={busy}>{lang.mute24h || '24 Stunden'}</button>
          <button class="menu-item" onclick={() => applyMute('all', null)} disabled={busy}>{lang.muteForever || 'Bis ich es wieder einschalte'}</button>
          {#if isGroup}
            <div class="menu-sep"></div>
            <button class="menu-item" onclick={() => applyMute('mentions_only', null)} disabled={busy}>@ {lang.muteMentionsOnly || 'Nur @-Erwähnungen'}</button>
          {/if}
        </div>

        <!-- ═══════ AUTO-DELETE ═══════ -->
        <div class="pane sub-pane">
          <button class="back-btn" onclick={back} aria-label={lang.backBtn || 'Zurück'}>
            <span class="back-arrow">‹</span> {lang.autoDeleteLabel || 'Auto-Delete'}
          </button>
          <div class="menu-sep"></div>
          {#if !isGroup}
            <div class="info-row small">
              {lang.autoDeleteDmHint || 'Beide Seiten müssen zustimmen. Vorschlag wird an Peer gesendet.'}
            </div>
          {:else}
            <div class="info-row small">
              {lang.autoDeleteGroupHint || 'Jedes Mitglied darf ändern. Alle bekommen eine System-Nachricht.'}
            </div>
          {/if}
          {#each ALLOWED_DAYS as days}
            <button
              class="menu-item radio"
              class:active={(adSetting?.days || 0) === days && adSetting?.status !== 'pending'}
              onclick={() => setAutoDelete(days)}
              disabled={busy}
            >
              <span class="radio-dot">{(adSetting?.days || 0) === days && adSetting?.status !== 'pending' ? '●' : '○'}</span>
              <span class="label">{autoDeleteLabel(days, lang)}</span>
            </button>
          {/each}
        </div>

        <!-- ═══════ REMOVE MEMBER (Admin) ═══════ -->
        <div class="pane sub-pane">
          <button class="back-btn" onclick={back} aria-label={lang.backBtn || 'Zurück'}>
            <span class="back-arrow">‹</span> {lang.removeMemberLabel || 'Teilnehmer entfernen'}
          </button>
          <div class="menu-sep"></div>
          {#if groupMembers.length === 0}
            <div class="info-row small">{lang.noOtherMembers || 'Keine weiteren Mitglieder'}</div>
          {/if}
          {#each groupMembers as m (m.handle)}
            <button class="menu-item" onclick={() => onRemoveMember(m.handle)} disabled={busy}>
              <span class="label">@{m.handle}</span>
              <span class="kick">×</span>
            </button>
          {/each}
        </div>

      </div>
    </div>
  {/if}
</div>

<InviteLinkModal
  bind:isOpen={showInviteLink}
  convoId={isGroup ? chat?.key : null}
  groupName={isGroup ? (chat?.name || null) : null}
/>

{#if isGroup}
  <AddGroupMembersModal
    bind:isOpen={showAddMembers}
    groupId={chat?.key}
    groupName={chat?.name || ''}
    onInviteByLink={openInviteLinkFromAdd}
  />
{/if}

<style>
  .menu-wrap { position: relative; display: inline-block; }

  .action-btn {
    width: 36px; height: 36px; border-radius: 50%;
    border: none; background: transparent; color: var(--text-muted);
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: all 0.15s;
  }
  .action-btn:hover { background: var(--accent-voice-dim); color: var(--accent-voice); }

  .menu {
    position: absolute; top: calc(100% + 4px); right: 0;
    width: 260px;
    background: var(--bg-panel);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    z-index: 100;
    overflow: hidden;
    animation: drop 0.12s ease-out;
  }
  @keyframes drop { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }

  /* Slider with 4 panes side-by-side */
  .slider {
    display: flex;
    width: 400%;
    transition: transform 0.18s ease-out;
  }
  .slider[data-view="main"]           { transform: translateX(0); }
  .slider[data-view="notifications"]  { transform: translateX(-25%); }
  .slider[data-view="autoDelete"]     { transform: translateX(-50%); }
  .slider[data-view="removeMember"]   { transform: translateX(-75%); }

  .pane {
    width: 25%;
    flex-shrink: 0;
    padding: 6px;
    box-sizing: border-box;
  }

  .menu-item {
    display: flex; align-items: center; gap: 10px;
    width: 100%; text-align: left;
    padding: 9px 10px;
    background: transparent; border: none; border-radius: 6px;
    color: var(--text-primary); font-size: 13px; cursor: pointer;
  }
  .menu-item:hover:not(:disabled) { background: var(--bg-panel-alt); }
  .menu-item:disabled { opacity: 0.5; cursor: wait; }

  .menu-item .ico { width: 20px; text-align: center; flex-shrink: 0; }
  .menu-item .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .menu-item .value { font-size: 11px; color: var(--text-muted); flex-shrink: 0; }
  .menu-item .chevron { color: var(--text-muted); margin-left: 2px; flex-shrink: 0; }
  .menu-item .kick { color: var(--status-error); font-size: 16px; }

  .menu-item.danger { color: var(--status-error); }
  .menu-item.danger:hover:not(:disabled) { background: rgba(239, 68, 68, 0.08); }
  .menu-item.highlight { color: var(--accent-voice); font-weight: 600; }

  .menu-item.radio .radio-dot { color: var(--accent-voice); width: 14px; flex-shrink: 0; }
  .menu-item.radio.active { background: var(--accent-voice-dim); }

  .menu-sep { height: 1px; background: var(--border-subtle); margin: 4px 6px; }

  .menu-label {
    font-size: 10px; font-weight: 700;
    color: var(--text-muted); text-transform: uppercase;
    letter-spacing: 0.05em; padding: 6px 10px 4px;
  }

  .info-row {
    padding: 8px 10px; font-size: 12px; color: var(--text-secondary);
    background: var(--bg-panel-alt); border-radius: 6px; margin: 0 0 4px;
  }
  .info-row.small { font-size: 11px; padding: 6px 10px; }

  .back-btn {
    display: flex; align-items: center; gap: 4px;
    width: 100%; padding: 8px 10px;
    background: transparent; border: none; color: var(--text-muted);
    font-size: 12px; font-weight: 600; cursor: pointer; border-radius: 6px;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .back-btn:hover { color: var(--text-primary); background: var(--bg-panel-alt); }
  .back-arrow { font-size: 18px; line-height: 1; }

  .pending-banner {
    padding: 10px;
    background: var(--accent-voice-dim);
    border: 1px solid var(--accent-voice);
    border-radius: 6px;
    margin: 0 0 4px;
    font-size: 12px;
    color: var(--text-primary);
  }
  .pending-actions {
    display: flex; gap: 6px; margin-top: 6px;
  }
  .mini-btn {
    flex: 1; padding: 5px 8px; border-radius: 4px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-panel); color: var(--text-primary);
    font-size: 11px; font-weight: 600; cursor: pointer;
  }
  .mini-btn:hover:not(:disabled) { background: var(--bg-panel-alt); }
  .mini-btn.ok { border-color: var(--accent-voice); color: var(--accent-voice); }
  .mini-btn.no { border-color: var(--status-error); color: var(--status-error); }
  .mini-btn:disabled { opacity: 0.5; cursor: wait; }
</style>
