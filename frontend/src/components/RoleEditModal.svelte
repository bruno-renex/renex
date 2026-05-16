<!--
  RoleEditModal — Role create/edit für Server-Settings (Phase 3A.5)

  Modi:
   - mode='create': leeres Form, Submit ruft serverStore.createRole
   - mode='edit':   role-Werte vorbefüllt, Submit ruft serverStore.updateRole
                    + Delete-Button (mit Confirm)

  Permission-Toggles: 13 Bits aus permissions.js, ADMINISTRATOR optisch hervorgehoben
  (only-Owner-Bit). Default-Role kann Permissions ändern aber nicht gelöscht werden.
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { serverStore } from '../stores/serverStore.svelte.js';
  import { toastStore } from '../stores/toast.svelte.js';
  import { Permissions, sanitizeBits } from '../lib/permissions.js';

  let {
    isOpen = $bindable(false),
    mode = 'create',           // 'create' | 'edit'
    role = null,               // bei edit: { id, name, color, permissions, position, isDefault, isMentionable }
    serverId,
    isOwner = false,           // ADMINISTRATOR-Bit nur für Owner toggelbar
    actorMaxPosition = 0,      // für Position-Slider-Cap
  } = $props();

  let lang = $derived(i18nStore.lang);

  // Form-State (reset on open)
  let name = $state('');
  let color = $state('');
  let position = $state(1);
  let permissions = $state(0);
  let isMentionable = $state(false);
  let busy = $state(false);
  let errorMsg = $state('');

  $effect(() => {
    if (isOpen) {
      if (mode === 'edit' && role) {
        name = role.name || '';
        color = role.color || '';
        position = role.position ?? 1;
        permissions = role.permissions ?? 0;
        isMentionable = role.isMentionable === true;
      } else {
        name = '';
        color = '';
        position = 1;
        permissions = 0;
        isMentionable = false;
      }
      busy = false;
      errorMsg = '';
    }
  });

  // Permission-Bit-Definitionen mit Labels (DE)
  // Voice-Bits (CONNECT/SPEAK) markiert als "Phase 8 — bisher kein Effekt"
  const PERM_GROUPS = [
    {
      label: () => lang.permGroupGeneral || 'Allgemein',
      bits: [
        { bit: Permissions.VIEW_CHANNEL,     label: () => lang.permViewChannel     || 'Channels sehen' },
        { bit: Permissions.SEND_MESSAGES,    label: () => lang.permSendMessages    || 'Nachrichten senden' },
        { bit: Permissions.MENTION_EVERYONE, label: () => lang.permMentionEveryone || '@everyone erwähnen' },
      ],
    },
    {
      label: () => lang.permGroupModeration || 'Moderation',
      bits: [
        { bit: Permissions.MANAGE_MESSAGES, label: () => lang.permManageMessages || 'Nachrichten löschen/pinnen' },
        { bit: Permissions.KICK_MEMBERS,    label: () => lang.permKickMembers    || 'Mitglieder kicken' },
        { bit: Permissions.BAN_MEMBERS,     label: () => lang.permBanMembers     || 'Mitglieder bannen (Phase 3A.5)' },
      ],
    },
    {
      label: () => lang.permGroupServer || 'Server-Verwaltung',
      bits: [
        { bit: Permissions.MANAGE_CHANNELS, label: () => lang.permManageChannels || 'Channels verwalten' },
        { bit: Permissions.MANAGE_ROLES,    label: () => lang.permManageRoles    || 'Roles verwalten' },
        { bit: Permissions.MANAGE_SERVER,   label: () => lang.permManageServer   || 'Server-Settings ändern' },
        { bit: Permissions.INVITE_MEMBERS,  label: () => lang.permInviteMembers  || 'Mitglieder einladen' },
      ],
    },
    {
      label: () => lang.permGroupVoice || 'Voice (Phase 8)',
      bits: [
        { bit: Permissions.VOICE_CONNECT, label: () => lang.permVoiceConnect || 'Voice-Channel beitreten' },
        { bit: Permissions.VOICE_SPEAK,   label: () => lang.permVoiceSpeak   || 'In Voice-Channel sprechen' },
      ],
    },
  ];

  function togglePerm(bit) {
    if (busy) return;
    if ((permissions & bit) === bit) {
      permissions = permissions & ~bit;
    } else {
      permissions = permissions | bit;
    }
  }

  function isPermOn(bit) {
    return (permissions & bit) === bit;
  }

  let isAdminBitOn = $derived((permissions & Permissions.ADMINISTRATOR) === Permissions.ADMINISTRATOR);

  function toggleAdminBit() {
    if (busy || !isOwner) return;
    if (isAdminBitOn) {
      permissions = permissions & ~Permissions.ADMINISTRATOR;
    } else {
      permissions = permissions | Permissions.ADMINISTRATOR;
    }
  }

  // Default-Role: Position immer 0, nicht editierbar; Name nicht änderbar
  let isDefault = $derived(role?.isDefault === true);

  async function onSubmit(e) {
    e?.preventDefault?.();
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed && !isDefault) {
      errorMsg = lang.roleNameRequired || 'Name ist erforderlich';
      return;
    }
    if (trimmed.length > 64) {
      errorMsg = lang.roleNameTooLong || 'Name zu lang (max 64 Zeichen)';
      return;
    }
    busy = true;
    errorMsg = '';

    const sanitized = sanitizeBits(permissions);
    let r;
    if (mode === 'create') {
      r = await serverStore.createRole(serverId, {
        name:          trimmed,
        color:         color || null,
        permissions:   sanitized,
        position:      Math.max(0, Math.min(position, actorMaxPosition - 1 || 99)),
        isMentionable,
      });
    } else {
      const partial = {};
      if (!isDefault && trimmed !== role.name) partial.name = trimmed;
      if ((color || null) !== (role.color || null)) partial.color = color || null;
      if (sanitized !== role.permissions) partial.permissions = sanitized;
      if (!isDefault && position !== role.position) partial.position = position;
      if (isMentionable !== role.isMentionable) partial.isMentionable = isMentionable;
      r = await serverStore.updateRole(serverId, role.id, partial);
    }

    busy = false;
    if (r.ok) {
      toastStore.push(
        mode === 'create' ? (lang.roleCreated || '✅ Role erstellt') : (lang.roleUpdated || '✅ Role aktualisiert'),
        { kind: 'success' }
      );
      close();
    } else {
      errorMsg = _translateError(r.error);
    }
  }

  async function onDelete() {
    if (busy || !role || isDefault) return;
    if (!confirm((lang.roleDeleteConfirm || 'Role „{name}" wirklich löschen?').replace('{name}', role.name))) return;
    busy = true;
    const r = await serverStore.deleteRole(serverId, role.id);
    busy = false;
    if (r.ok) {
      toastStore.push(lang.roleDeleted || '🗑 Role gelöscht', { kind: 'success' });
      close();
    } else {
      errorMsg = _translateError(r.error);
    }
  }

  function _translateError(err) {
    if (err === 'forbidden_manage_roles') return lang.errForbiddenManageRoles || 'Keine Berechtigung (MANAGE_ROLES)';
    if (err === 'forbidden_role_position') return lang.errForbiddenRolePosition || 'Position zu hoch — du kannst nur Roles unter deiner eigenen verwalten';
    if (err === 'forbidden_administrator_bit') return lang.errForbiddenAdminBit || 'ADMINISTRATOR-Bit kann nur der Owner setzen';
    if (err === 'cannot_delete_default_role') return lang.errCannotDeleteDefault || 'Default-Role kann nicht gelöscht werden';
    if (err === 'Reserved role name') return lang.errReservedName || 'Name reserviert (everyone)';
    return (lang.error || 'Fehler') + ': ' + err;
  }

  function close() { isOpen = false; }
  function onBackdropClick(e) {
    if (e.target.classList.contains('re-overlay')) close();
  }
  function onKey(e) {
    if (e.key === 'Escape' && isOpen) close();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if isOpen}
  <div class="re-overlay" role="presentation" onclick={onBackdropClick}>
    <form class="re-dialog" role="dialog" aria-labelledby="re-title" aria-modal="true" onsubmit={onSubmit}>
      <div class="re-header">
        <h3 id="re-title">
          {#if mode === 'create'}
            {lang.roleCreateTitle || 'Role erstellen'}
          {:else}
            {lang.roleEditTitle || 'Role bearbeiten'}
            {#if role?.color}
              <span class="re-color-dot" style="background:{role.color}"></span>
            {/if}
          {/if}
        </h3>
        <button type="button" class="close-btn" onclick={close} aria-label="Close">×</button>
      </div>

      {#if isDefault}
        <div class="re-info-banner">
          {lang.roleDefaultHint || '🛡 Default-Role „everyone" — Name und Position sind fixiert. Permissions änderbar.'}
        </div>
      {/if}

      <label class="re-field">
        <span class="re-label">{lang.roleNameLabel || 'Name'}</span>
        <input
          type="text"
          bind:value={name}
          placeholder={lang.roleNamePlaceholder || 'z.B. Moderator'}
          maxlength="64"
          required
          disabled={busy || isDefault}
        />
      </label>

      <div class="re-row">
        <label class="re-field re-field-color">
          <span class="re-label">{lang.roleColorLabel || 'Farbe'}</span>
          <input type="color" bind:value={color} disabled={busy} />
        </label>

        <label class="re-field re-field-pos">
          <span class="re-label">{lang.rolePositionLabel || 'Position'} ({position})</span>
          <input
            type="range"
            min="0"
            max={actorMaxPosition > 0 ? actorMaxPosition - 1 : 99}
            bind:value={position}
            disabled={busy || isDefault}
          />
        </label>
      </div>

      <label class="re-checkbox-row">
        <input type="checkbox" bind:checked={isMentionable} disabled={busy} />
        <span>{lang.roleMentionableLabel || '@-Erwähnung erlaubt (z.B. @Moderator)'}</span>
      </label>

      <div class="re-section-label">{lang.permissionsHeading || 'Berechtigungen'}</div>

      {#each PERM_GROUPS as group (group.label())}
        <div class="re-perm-group">
          <div class="re-perm-group-title">{group.label()}</div>
          {#each group.bits as p (p.bit)}
            <label class="re-perm-row" class:active={isPermOn(p.bit)}>
              <input
                type="checkbox"
                checked={isPermOn(p.bit)}
                onchange={() => togglePerm(p.bit)}
                disabled={busy}
              />
              <span>{p.label()}</span>
            </label>
          {/each}
        </div>
      {/each}

      <!-- ADMINISTRATOR — Owner-only Toggle, optisch separiert -->
      <div class="re-perm-group re-perm-admin">
        <div class="re-perm-group-title">{lang.permGroupAdmin || '⚠ Super-Admin'}</div>
        <label class="re-perm-row" class:active={isAdminBitOn} class:disabled={!isOwner}>
          <input
            type="checkbox"
            checked={isAdminBitOn}
            onchange={toggleAdminBit}
            disabled={busy || !isOwner}
          />
          <span>
            {lang.permAdministrator || 'ADMINISTRATOR — Bypass aller Permission-Checks'}
            {#if !isOwner}
              <small class="re-perm-note">{lang.permAdminOwnerOnly || 'nur Owner'}</small>
            {/if}
          </span>
        </label>
      </div>

      {#if errorMsg}
        <div class="re-error">{errorMsg}</div>
      {/if}

      <div class="re-actions">
        {#if mode === 'edit' && !isDefault}
          <button type="button" class="btn-danger" onclick={onDelete} disabled={busy}>
            {lang.delete || 'Löschen'}
          </button>
        {/if}
        <div class="re-actions-right">
          <button type="button" class="btn-secondary" onclick={close} disabled={busy}>
            {lang.cancel || 'Abbrechen'}
          </button>
          <button type="submit" class="btn-primary" disabled={busy || (!name.trim() && !isDefault)}>
            {#if busy}
              <span class="spinner-sm"></span>
              {lang.saving || 'Speichere…'}
            {:else}
              {mode === 'create' ? (lang.create || 'Erstellen') : (lang.save || 'Speichern')}
            {/if}
          </button>
        </div>
      </div>
    </form>
  </div>
{/if}

<style>
  .re-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    z-index: 1100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    animation: fadeIn 0.15s ease-out;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .re-dialog {
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 14px;
    padding: 22px;
    width: 100%;
    max-width: 520px;
    max-height: calc(100vh - 40px);
    max-height: calc(100dvh - 40px);
    overflow-y: auto;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .re-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .re-header h3 {
    margin: 0;
    font-size: 17px;
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .re-color-dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1px solid var(--border-subtle);
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
  }
  .close-btn:hover { color: var(--text-primary); background: var(--bg-panel-alt); }

  .re-info-banner {
    padding: 9px 11px;
    background: var(--accent-voice-dim);
    border: 1px solid var(--accent-voice);
    border-radius: 6px;
    font-size: 12px;
    color: var(--text-primary);
  }

  .re-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .re-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }

  .re-field input[type=text] {
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 9px 11px;
    color: var(--text-primary);
    font-size: 13px;
  }
  .re-field input[type=text]:focus {
    outline: none;
    border-color: var(--accent-voice);
  }
  .re-field input[type=text]:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .re-row {
    display: flex;
    gap: 12px;
  }
  .re-field-color {
    flex: 0 0 auto;
  }
  .re-field-color input[type=color] {
    width: 60px;
    height: 36px;
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    cursor: pointer;
  }
  .re-field-pos {
    flex: 1;
  }
  .re-field-pos input[type=range] {
    width: 100%;
  }

  .re-checkbox-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text-primary);
    cursor: pointer;
  }

  .re-section-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-top: 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .re-perm-group {
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 9px 11px;
  }
  .re-perm-group-title {
    font-size: 11px;
    font-weight: 700;
    color: var(--text-secondary);
    margin-bottom: 6px;
  }
  .re-perm-admin {
    border-color: var(--status-error);
    background: rgba(239, 68, 68, 0.06);
  }
  .re-perm-admin .re-perm-group-title {
    color: var(--status-error);
  }

  .re-perm-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 4px;
    font-size: 13px;
    color: var(--text-primary);
    cursor: pointer;
    border-radius: 4px;
  }
  .re-perm-row:hover:not(.disabled) { background: var(--bg-panel); }
  .re-perm-row.active { color: var(--accent-voice); }
  .re-perm-row.disabled { opacity: 0.5; cursor: not-allowed; }

  .re-perm-note {
    font-size: 10px;
    color: var(--text-muted);
    margin-left: 4px;
    font-style: italic;
  }

  .re-error {
    padding: 9px 11px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid var(--status-error);
    border-radius: 6px;
    color: var(--status-error);
    font-size: 12px;
  }

  .re-actions {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-top: 6px;
  }
  .re-actions-right {
    display: flex;
    gap: 8px;
    margin-left: auto;
  }

  .btn-primary, .btn-secondary, .btn-danger {
    padding: 9px 16px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    transition: opacity 0.12s;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .btn-primary {
    background: var(--accent-voice);
    color: #07070a;
    border: none;
  }
  .btn-primary:hover:not(:disabled) { opacity: 0.9; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-secondary {
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border-subtle);
  }
  .btn-secondary:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-panel-alt); }

  .btn-danger {
    background: transparent;
    color: var(--status-error);
    border: 1px solid var(--status-error);
  }
  .btn-danger:hover:not(:disabled) { background: rgba(239, 68, 68, 0.1); }

  .spinner-sm {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
