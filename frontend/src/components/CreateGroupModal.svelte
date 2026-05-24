<!--
  CreateGroupModal — Gruppe erstellen mit Member-Auswahl
  Migration von /renex/index.html #create-group-popup.

  2-Step Flow:
   Step 1: Group-Name eingeben
   Step 2: Members aus Kontaktliste auswählen
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { inboxStore } from '../stores/inbox.svelte.js';
  import { apiFetch } from '../lib/api.js';
  import { captureException } from '../lib/sentry.js';

  let { isOpen = $bindable(false) } = $props();

  let lang = $derived(i18nStore.lang);
  let contacts = $derived(inboxStore.contacts);

  let step = $state(1); // 1 = name, 2 = members
  let groupName = $state("");
  let selectedHandles = $state(new Set());
  let isSubmitting = $state(false);
  let errorMsg = $state("");
  let memberSearch = $state("");

  $effect(() => {
    if (isOpen) {
      step = 1;
      groupName = "";
      selectedHandles = new Set();
      errorMsg = "";
      memberSearch = "";
      setTimeout(() => {
        document.getElementById("cg-name-input")?.focus();
      }, 50);
    }
  });

  // Validierung
  let trimmedName = $derived(groupName.trim());
  let canProceedToStep2 = $derived(trimmedName.length >= 2 && trimmedName.length <= 50);
  // Members sind optional: leere Gruppe (nur Creator) erlaubt — Cold-Start-Flow,
  // User kann nach Erstellung per Invite-Link / AddGroupMembersModal einladen.
  // Backend (groupRoutes.js) akzeptiert members=[] (GSK-Distribution geguarded).
  let canCreate = $derived(canProceedToStep2 && !isSubmitting);

  // Step 2: Live-Filter auf Handle + DisplayName
  let filteredContacts = $derived.by(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(c => {
      const h = (c.handle || "").toLowerCase();
      const dn = (c.displayName || "").toLowerCase();
      return h.includes(q) || dn.includes(q);
    });
  });

  // Selected-Chips: nachschlagen aus contacts, fallback auf nur Handle
  let selectedContactList = $derived.by(() => {
    const out = [];
    for (const h of selectedHandles) {
      const c = contacts.find(x => x.handle === h);
      out.push(c ? c : { handle: h, displayName: null });
    }
    return out;
  });

  function close() {
    if (isSubmitting) return;
    isOpen = false;
  }

  function next() {
    if (!canProceedToStep2) return;
    step = 2;
    errorMsg = "";
  }

  function back() {
    step = 1;
    errorMsg = "";
  }

  function toggleMember(handle) {
    const next = new Set(selectedHandles);
    if (next.has(handle)) next.delete(handle);
    else next.add(handle);
    selectedHandles = next;
  }

  async function createGroup() {
    if (!canCreate) return;
    isSubmitting = true;
    errorMsg = "";

    try {
      const r = await apiFetch("/groups/create", {
        method: "POST",
        body: {
          name: trimmedName,
          members: [...selectedHandles],
        },
      });

      if (r.ok) {
        isOpen = false;
        inboxStore.loadGroups().catch((e) => captureException(e, { context: "loadGroups after createGroup" }));
      } else {
        errorMsg = r.data?.error || lang.groupCreateFailed || "Gruppen-Erstellung fehlgeschlagen";
      }
    } catch (e) {
      captureException(e, { context: "createGroup" });
      errorMsg = lang.groupCreateFailed || "Gruppen-Erstellung fehlgeschlagen";
    } finally {
      isSubmitting = false;
    }
  }

  function onKeydown(e) {
    if (e.key === "Escape") close();
    if (e.key === "Enter") {
      if (step === 1 && canProceedToStep2) { e.preventDefault(); next(); }
      else if (step === 2 && canCreate) { e.preventDefault(); createGroup(); }
    }
  }

  function onBackdropClick(e) {
    if (e.target.classList.contains("cg-overlay")) close();
  }
</script>

{#if isOpen}
  <div class="cg-overlay" role="presentation" onclick={onBackdropClick}>
    <div class="cg-dialog" role="dialog" aria-labelledby="cg-title" aria-modal="true" tabindex="-1" onkeydown={onKeydown}>
      <div class="cg-header">
        <h3 id="cg-title">
          {step === 1 ? (lang.createGroupTitle || "Gruppe erstellen") : (lang.selectMembersTitle || "Mitglieder auswählen")}
        </h3>
        <button class="close-btn" onclick={close} disabled={isSubmitting} aria-label="Close">×</button>
      </div>

      <!-- Progress -->
      <div class="progress">
        <div class="step" class:active={step === 1} class:done={step > 1}>1. Name</div>
        <div class="connector" class:done={step > 1}></div>
        <div class="step" class:active={step === 2}>2. {lang.members || "Mitglieder"}</div>
      </div>

      {#if errorMsg}
        <div class="error">{errorMsg}</div>
      {/if}

      {#if step === 1}
        <p class="hint">
          {lang.groupNameHint || "Gib einen Namen für die Gruppe ein (2-50 Zeichen)."}
        </p>
        <input
          id="cg-name-input"
          type="text"
          class="name-input"
          placeholder={lang.groupNamePlaceholder || "z.B. CS2 Pros 🎯"}
          bind:value={groupName}
          onkeydown={onKeydown}
          maxlength="50"
          autocomplete="off"
          spellcheck="false"
          disabled={isSubmitting}
        />
        <div class="counter">{trimmedName.length}/50</div>

        <div class="buttons">
          <button class="btn btn-secondary" onclick={close}>
            {lang.cancelBtn || "Abbrechen"}
          </button>
          <button class="btn btn-primary" onclick={next} disabled={!canProceedToStep2}>
            {lang.nextBtn || "Weiter"} →
          </button>
        </div>
      {:else}
        <p class="hint">
          {lang.selectMembersHintOptional || "Wähle aus deinen Kontakten — optional. Du kannst die Gruppe auch leer starten und später einladen."}
          {#if selectedHandles.size > 0}
            <strong class="count-badge">{selectedHandles.size} {lang.selected || "ausgewählt"}</strong>
          {/if}
        </p>

        {#if contacts.length === 0}
          <div class="empty-contacts">
            <p>{lang.noContactsToAdd || "Noch keine Kontakte."}</p>
            <p class="hint-sm">{lang.noContactsCreateEmpty || "Kein Problem — erstelle die Gruppe leer und lade Mitglieder später per Invite-Link ein."}</p>
          </div>
        {:else}
          {#if selectedContactList.length > 0}
            <div class="chips-row">
              {#each selectedContactList as c (c.handle)}
                <span class="chip">
                  <span class="chip-label">{c.displayName ? c.displayName : `@${c.handle}`}</span>
                  <button
                    class="chip-x"
                    onclick={() => toggleMember(c.handle)}
                    type="button"
                    aria-label="Remove {c.handle}"
                  >×</button>
                </span>
              {/each}
            </div>
          {/if}

          <input
            type="text"
            class="search-input"
            placeholder={lang.searchContactsPlaceholder || "Kontakte suchen…"}
            bind:value={memberSearch}
            autocomplete="off"
            spellcheck="false"
          />

          <div class="member-list">
            {#if filteredContacts.length === 0}
              <div class="empty-contacts">
                <p>{lang.noContactsMatch || "Keine Kontakte gefunden."}</p>
              </div>
            {/if}
            {#each filteredContacts as c (c.handle)}
              <button
                class="member-item"
                class:selected={selectedHandles.has(c.handle)}
                onclick={() => toggleMember(c.handle)}
                type="button"
              >
                <div class="member-avatar">{c.handle.slice(0, 2).toUpperCase()}</div>
                <div class="member-info">
                  <div class="member-name">
                    {c.displayName ? `${c.displayName} · @${c.handle}` : `@${c.handle}`}
                  </div>
                </div>
                <div class="checkmark" class:on={selectedHandles.has(c.handle)}>
                  {#if selectedHandles.has(c.handle)}✓{/if}
                </div>
              </button>
            {/each}
          </div>
        {/if}

        <div class="buttons">
          <button class="btn btn-secondary" onclick={back} disabled={isSubmitting}>
            ← {lang.backBtn || "Zurück"}
          </button>
          <button class="btn btn-primary" onclick={createGroup} disabled={!canCreate}>
            {#if isSubmitting}
              <span class="spinner"></span>
            {/if}
            {selectedHandles.size === 0
              ? (lang.createEmptyGroupBtn || "Leere Gruppe erstellen")
              : (lang.createGroupBtn || "Gruppe erstellen")}
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .cg-overlay {
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

  .cg-dialog {
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 14px;
    padding: 22px;
    width: 100%;
    max-width: 420px;
    max-height: calc(100vh - 32px);
    max-height: calc(100dvh - 32px);
    overflow-y: auto;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
  }

  .cg-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }
  .cg-header h3 { margin: 0; font-size: 16px; color: var(--text-primary); }

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

  /* Progress */
  .progress {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 16px;
    font-size: 12px;
  }
  .step {
    color: var(--text-muted);
    padding: 4px 8px;
    border-radius: 6px;
  }
  .step.active {
    background: var(--accent-voice-dim);
    color: var(--accent-voice);
    font-weight: 600;
  }
  .step.done {
    color: var(--status-success);
  }
  .connector {
    flex: 1;
    height: 1px;
    background: var(--border-subtle);
  }
  .connector.done {
    background: var(--status-success);
  }

  .error {
    padding: 8px 10px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid var(--status-error);
    border-radius: 6px;
    color: var(--status-error);
    font-size: 12px;
    margin-bottom: 12px;
  }

  .hint {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
    margin-bottom: 12px;
  }
  .hint-sm { font-size: 11px; opacity: 0.7; }

  .count-badge {
    display: inline-block;
    margin-left: 8px;
    padding: 2px 8px;
    background: var(--accent-voice-dim);
    color: var(--accent-voice);
    border-radius: 10px;
    font-size: 11px;
    font-weight: 700;
  }

  .name-input {
    width: 100%;
    padding: 10px 14px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    color: var(--text-primary);
    font-size: 15px;
  }
  .name-input:focus { border-color: var(--accent-voice); }

  .counter {
    font-size: 11px;
    color: var(--text-muted);
    text-align: right;
    margin-top: 4px;
  }

  .empty-contacts {
    padding: 24px 0;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }

  .chips-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
    max-height: 84px;
    overflow-y: auto;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 4px 3px 10px;
    background: var(--accent-voice-dim);
    border: 1px solid var(--accent-voice);
    border-radius: 14px;
    font-size: 12px;
    color: var(--accent-voice);
    max-width: 180px;
  }

  .chip-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chip-x {
    background: transparent;
    border: none;
    color: var(--accent-voice);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .chip-x:hover {
    background: rgba(56, 189, 248, 0.2);
    color: var(--text-primary);
  }

  .search-input {
    width: 100%;
    padding: 8px 12px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    color: var(--text-primary);
    font-size: 13px;
    margin-bottom: 8px;
    box-sizing: border-box;
  }
  .search-input:focus { border-color: var(--accent-voice); outline: none; }

  .member-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 280px;
    overflow-y: auto;
    padding-right: 4px;
  }

  .member-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 10px;
    cursor: pointer;
    text-align: left;
    transition: all 0.15s;
    width: 100%;
  }

  .member-item:hover { background: var(--bg-panel-alt); }

  .member-item.selected {
    background: var(--accent-voice-dim);
    border-color: var(--accent-voice);
  }

  .member-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    color: var(--text-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 11px;
    flex-shrink: 0;
  }

  .member-info {
    flex: 1;
    min-width: 0;
  }

  .member-name {
    font-size: 13px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .checkmark {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 2px solid var(--border-subtle);
    color: var(--accent-voice);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 700;
    flex-shrink: 0;
    background: var(--bg-panel);
  }

  .checkmark.on {
    background: var(--accent-voice);
    color: #07070a;
    border-color: var(--accent-voice);
  }

  .buttons {
    display: flex;
    gap: 8px;
    margin-top: 16px;
    justify-content: flex-end;
  }

  .btn {
    padding: 9px 16px;
    border-radius: 8px;
    border: 1px solid transparent;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-secondary {
    background: var(--bg-panel-alt);
    color: var(--text-secondary);
    border-color: var(--border-subtle);
  }
  .btn-secondary:hover:not(:disabled) { color: var(--text-primary); }

  .btn-primary { background: var(--accent-voice); color: #07070a; }
  .btn-primary:hover:not(:disabled) { background: #0ea5e9; }

  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid rgba(7, 7, 10, 0.2);
    border-top-color: #07070a;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
