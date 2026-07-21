<!--
  AddContactModal — Kontakt-Anfrage senden via Handle
  Migration von /renex/index.html #add-contact-popup.
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { inboxStore } from '../stores/inbox.svelte.js';
  import { apiFetch } from '../lib/api.js';
  import { validateHandle } from '../lib/passkey.js';
  import { captureException } from '../lib/sentry.js';
  import { orgStore, requestOpenInvite } from '../stores/org.svelte.js';

  let { isOpen = $bindable(false) } = $props();

  let lang = $derived(i18nStore.lang);

  let handleInput = $state("");
  let isSubmitting = $state(false);
  let statusMessage = $state("");
  let statusType = $state(""); // "" | "info" | "error" | "success"
  let showInviteBridge = $state(false);   // eGov 1.1: Org + Handle-Suche ins Leere → Einladen anbieten

  $effect(() => { void orgStore.ensureProbed(); });

  let validation = $derived(validateHandle(handleInput));
  let canSubmit = $derived(validation.ok && !isSubmitting);

  $effect(() => {
    if (isOpen) {
      handleInput = "";
      statusMessage = "";
      statusType = "";
      showInviteBridge = false;
      // Auto-focus
      setTimeout(() => {
        document.getElementById("ac-input")?.focus();
      }, 50);
    }
  });

  function close() {
    if (isSubmitting) return;
    isOpen = false;
  }

  async function onSubmit() {
    if (!canSubmit) return;
    isSubmitting = true;
    statusMessage = lang.sendingRequest || "Sende Anfrage…";
    statusType = "info";

    try {
      const r = await apiFetch("/contacts/request", {
        method: "POST",
        body: { contact: validation.value },
      });

      if (r.ok) {
        // Backend gibt diverse Statuse: "requested", "accepted", "already_pending", "already_exists"
        const s = r.data?.status;
        if (s === "accepted") {
          statusMessage = lang.contactAccepted || "Kontakt akzeptiert (gegenseitige Anfrage)";
        } else if (s === "already_exists") {
          statusMessage = lang.alreadyContact || "Bereits in Kontaktliste";
        } else if (s === "already_pending") {
          statusMessage = lang.alreadyPending || "Anfrage bereits offen";
        } else {
          statusMessage = lang.requestSent || "Anfrage gesendet ✓";
        }
        statusType = "success";
        inboxStore.loadContacts().catch(() => {});
        setTimeout(() => close(), 1500);
      } else if (r.status === 404) {
        statusMessage = lang.userNotFound || "User nicht gefunden";
        statusType = "error";
        // eGov 1.1: Bürger haben kein RENEX-Konto → für Orgs die Sackgasse in
        // eine Brücke zum Einladungs-Panel verwandeln (rein additiv, ＋ bleibt).
        if (orgStore.isOrg) showInviteBridge = true;
      } else if (r.status === 410) {
        statusMessage = lang.accountDeleted || "Account gelöscht";
        statusType = "error";
      } else if (r.status === 429) {
        // Backend kann hier "cooldown" oder "rate_limit" zurückgeben
        if (r.data?.error === "cooldown") {
          statusMessage = lang.contactCooldown || "Anfrage wurde abgelehnt — 7 Tage Sperre";
        } else {
          statusMessage = lang.rateLimitReached || "Zu viele Anfragen — bitte warten";
        }
        statusType = "error";
      } else if (r.status === 400 && r.data?.error === "Cannot add yourself") {
        statusMessage = lang.cannotAddSelf || "Eigenen Handle nicht möglich";
        statusType = "error";
      } else {
        statusMessage = r.data?.error || lang.requestFailed || "Anfrage fehlgeschlagen";
        statusType = "error";
      }
    } catch (e) {
      captureException(e, { context: "addContact" });
      statusMessage = lang.requestFailed || "Anfrage fehlgeschlagen";
      statusType = "error";
    } finally {
      isSubmitting = false;
    }
  }

  function onKeydown(e) {
    if (e.key === "Enter" && canSubmit) { e.preventDefault(); onSubmit(); }
    if (e.key === "Escape") close();
  }

  function onBackdropClick(e) {
    if (e.target.classList.contains("ac-overlay")) close();
  }

  // Brücke: Dialog schließen + Org-Invite-Panel öffnen (via Event, InboxList hört).
  function goToInvite() {
    isOpen = false;
    requestOpenInvite();
  }
</script>

{#if isOpen}
  <div class="ac-overlay" role="presentation" onclick={onBackdropClick}>
    <div class="ac-dialog" role="dialog" aria-labelledby="ac-title" aria-modal="true">
      <div class="ac-header">
        <h3 id="ac-title">{lang.addContactTitle || "Kontakt hinzufügen"}</h3>
        <button class="close-btn" onclick={close} disabled={isSubmitting} aria-label="Close">×</button>
      </div>

      <p class="hint">
        {lang.addContactHint || "Gib den Handle des Users ein (z.B. anna4)."}
      </p>

      <input
        id="ac-input"
        type="text"
        class="handle-input"
        class:invalid={handleInput.length > 0 && !validation.ok}
        placeholder="anna4"
        bind:value={handleInput}
        onkeydown={onKeydown}
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        disabled={isSubmitting}
      />

      <div class="char-hint">
        {lang.handleHint || "3-32 Zeichen, nur a-z, 0-9, _"}
      </div>

      {#if statusMessage}
        <div class="status status-{statusType}">{statusMessage}</div>
      {/if}

      {#if showInviteBridge}
        <div class="invite-bridge">
          <span>{lang.orgBridgeHint || 'Bürger:innen haben kein RENEX-Konto — sie brauchen keinen Handle.'}</span>
          <button class="bridge-btn" onclick={goToInvite} type="button">
            📨 {lang.orgBridgeBtn || 'Einladung erstellen'}
          </button>
        </div>
      {/if}

      <div class="buttons">
        <button class="btn btn-secondary" onclick={close} disabled={isSubmitting}>
          {lang.cancelBtn || "Abbrechen"}
        </button>
        <button class="btn btn-primary" onclick={onSubmit} disabled={!canSubmit}>
          {#if isSubmitting}
            <span class="spinner"></span>
          {/if}
          {lang.sendRequestBtn || "Anfrage senden"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .ac-overlay {
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
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .ac-dialog {
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 14px;
    padding: 22px;
    width: 100%;
    max-width: 380px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
    animation: slideUp 0.2s ease-out;
  }
  @keyframes slideUp { from { transform: translateY(8px); opacity: 0; } }

  /* eGov 1.1: Org-Brücke bei erfolgloser Handle-Suche */
  .invite-bridge {
    margin-top: 10px;
    padding: 12px;
    border: 1px solid var(--accent-voice-dim, rgba(56, 189, 248, 0.25));
    border-radius: 10px;
    background: var(--accent-voice-dim, rgba(56, 189, 248, 0.08));
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.5;
  }
  .bridge-btn {
    align-self: flex-start;
    padding: 8px 14px;
    border-radius: 8px;
    border: 1px solid var(--accent-voice);
    background: transparent;
    color: var(--accent-voice);
    font-weight: 600;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .bridge-btn:hover { background: var(--accent-voice); color: #07070a; }

  .ac-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }
  .ac-header h3 { margin: 0; font-size: 16px; color: var(--text-primary); }

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

  .hint {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
    margin-bottom: 14px;
  }

  .handle-input {
    width: 100%;
    padding: 10px 14px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    color: var(--text-primary);
    font-size: 15px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  .handle-input:focus { border-color: var(--accent-voice); }
  .handle-input.invalid { border-color: var(--status-error); }

  .char-hint {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 4px;
  }

  .status {
    margin-top: 10px;
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 12px;
    text-align: center;
  }
  .status-info    { background: rgba(56, 189, 248, 0.08); color: var(--text-secondary); }
  .status-success { background: rgba(16, 185, 129, 0.1); color: var(--status-success); }
  .status-error   { background: rgba(239, 68, 68, 0.1); color: var(--status-error); }

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

  .btn-primary {
    background: var(--accent-voice);
    color: #07070a;
  }
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
