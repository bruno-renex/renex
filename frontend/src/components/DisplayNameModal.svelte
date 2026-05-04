<!--
  DisplayNameModal — User kann seinen Anzeigenamen setzen/ändern/zurücksetzen
  Migration von /renex/index.html #display-name-modal.

  Public API:
    Bind <DisplayNameModal bind:isOpen />
    isOpen=true → Modal öffnet, lädt aktuellen Wert
-->
<script>
  import { userStore } from '../stores/user.svelte.js';
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { apiFetch } from '../lib/api.js';
  import { captureException } from '../lib/sentry.js';
  import { profileCache } from '../stores/profileCache.svelte.js';

  let { isOpen = $bindable(false) } = $props();

  let lang = $derived(i18nStore.lang);

  let value = $state("");
  let isSaving = $state(false);
  let errorMsg = $state("");

  // Codepoint-Count (Emojis zählen nicht doppelt)
  let charCount = $derived(Array.from(value.trim()).length);
  let isOverLimit = $derived(charCount > 32);
  let canSave = $derived(!isOverLimit && !isSaving);

  // Initial value setzen wenn Modal öffnet
  $effect(() => {
    if (isOpen) {
      value = userStore.displayName || "";
      errorMsg = "";
      // Auto-focus & select nach kurzem Delay (DOM ready)
      setTimeout(() => {
        const input = document.getElementById("dn-input");
        if (input) {
          input.focus();
          input.select();
        }
      }, 50);
    }
  });

  function close() {
    if (isSaving) return;
    isOpen = false;
  }

  async function save(reset = false) {
    if (!canSave) return;
    errorMsg = "";
    isSaving = true;

    const newValue = reset ? null : value.trim();

    try {
      const r = await apiFetch("/users/me", {
        method: "PATCH",
        body: { display_name: newValue },
      });

      if (r.ok) {
        const finalDn = r.data?.display_name || newValue;
        userStore.setDisplayName(finalDn);
        // Profile-Cache des eigenen Handles direkt aktualisieren — sonst zeigen
        // andere Surfaces (eigene Reply-Bubbles, Group-Sender-Label) bis zum
        // TTL-Ablauf den alten Wert.
        if (userStore.myUser) profileCache.set(userStore.myUser, finalDn);
        // Direkt schließen — close() würde wegen `isSaving === true`-Guard
        // (Backdrop-Schutz) hier no-op sein. Modal explizit zumachen.
        isOpen = false;
      } else if (r.status === 400 && r.data?.error === "too_long") {
        errorMsg = lang.displayNameTooLong || "Anzeigename ist zu lang (max 32 Zeichen)";
      } else if (r.status === 429) {
        errorMsg = lang.displayNameRateLimit || "Zu viele Änderungen — bitte warten";
      } else if (r.data?.error === "invalid_type") {
        errorMsg = lang.displayNameInvalid || "Ungültige Eingabe";
      } else {
        errorMsg = lang.displayNameSaveFailed || "Speichern fehlgeschlagen";
      }
    } catch (e) {
      captureException(e, { context: "saveDisplayName" });
      errorMsg = lang.displayNameSaveFailed || "Speichern fehlgeschlagen";
    } finally {
      isSaving = false;
    }
  }

  function onKeydown(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(false); }
    if (e.key === "Escape") { e.preventDefault(); close(); }
  }

  function onBackdropClick(e) {
    if (e.target.classList.contains("dn-overlay")) close();
  }
</script>

{#if isOpen}
  <div
    class="dn-overlay"
    role="presentation"
    onclick={onBackdropClick}
  >
    <div class="dn-dialog" role="dialog" aria-labelledby="dn-title" aria-modal="true">
      <div class="dn-header">
        <h3 id="dn-title">{lang.displayNameTitle || "Anzeigename"}</h3>
        <button class="close-btn" onclick={close} disabled={isSaving} aria-label="Close">×</button>
      </div>

      <p class="dn-hint">
        {lang.displayNameHint || "Optional. Wird neben deinem Handle angezeigt. Leer lassen für nur @handle."}
      </p>

      <input
        id="dn-input"
        type="text"
        class="dn-input"
        class:over-limit={isOverLimit}
        bind:value
        onkeydown={onKeydown}
        placeholder={lang.displayNamePlaceholder || "z.B. Bertha (Schweiz)"}
        maxlength="200"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        disabled={isSaving}
      />

      <div class="dn-counter" class:over-limit={isOverLimit}>
        {charCount}/32
      </div>

      {#if errorMsg}
        <div class="dn-error">{errorMsg}</div>
      {/if}

      <div class="dn-buttons">
        <button
          class="btn btn-secondary"
          onclick={close}
          disabled={isSaving}
        >
          {lang.cancelBtn || "Abbrechen"}
        </button>

        {#if userStore.displayName}
          <button
            class="btn btn-danger"
            onclick={() => save(true)}
            disabled={isSaving}
          >
            {lang.displayNameReset || "Zurücksetzen"}
          </button>
        {/if}

        <button
          class="btn btn-primary"
          onclick={() => save(false)}
          disabled={!canSave}
        >
          {#if isSaving}
            <span class="spinner"></span>
          {/if}
          {lang.saveBtn || "Speichern"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .dn-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 1100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    animation: fadeIn 0.15s ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .dn-dialog {
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 14px;
    padding: 22px;
    width: 100%;
    max-width: 380px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
    animation: slideUp 0.2s ease-out;
  }

  @keyframes slideUp {
    from { transform: translateY(8px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .dn-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }

  .dn-header h3 {
    margin: 0;
    font-size: 16px;
    color: var(--text-primary);
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

  .close-btn:hover {
    color: var(--text-primary);
    background: var(--bg-panel-alt);
  }

  .dn-hint {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
    margin-bottom: 14px;
  }

  .dn-input {
    width: 100%;
    padding: 10px 12px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    color: var(--text-primary);
    font-size: 14px;
    transition: border-color 0.15s;
  }

  .dn-input:focus {
    border-color: var(--accent-voice);
  }

  .dn-input.over-limit {
    border-color: var(--status-error);
  }

  .dn-counter {
    font-size: 11px;
    color: var(--text-muted);
    text-align: right;
    margin-top: 4px;
  }

  .dn-counter.over-limit {
    color: var(--status-error);
  }

  .dn-error {
    margin-top: 8px;
    padding: 8px 10px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid var(--status-error);
    border-radius: 6px;
    color: var(--status-error);
    font-size: 12px;
  }

  .dn-buttons {
    display: flex;
    gap: 8px;
    margin-top: 16px;
    justify-content: flex-end;
    flex-wrap: wrap;
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

  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: var(--bg-panel-alt);
    color: var(--text-secondary);
    border-color: var(--border-subtle);
  }

  .btn-secondary:hover:not(:disabled) {
    color: var(--text-primary);
  }

  .btn-primary {
    background: var(--accent-voice);
    color: #07070a;
  }

  .btn-primary:hover:not(:disabled) {
    background: #0ea5e9;
  }

  .btn-danger {
    background: transparent;
    color: var(--status-error);
    border-color: var(--status-error);
  }

  .btn-danger:hover:not(:disabled) {
    background: rgba(239, 68, 68, 0.08);
  }

  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid rgba(7, 7, 10, 0.2);
    border-top-color: #07070a;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
