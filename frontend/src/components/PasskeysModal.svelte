<!--
  PasskeysModal — Passkey-Management
  Migration von /renex/index.html #passkeys-overlay.

  Features:
   - Liste aller Passkeys des Users (GET /auth/passkeys)
   - "+ Add Passkey"-Button mit Name-Prompt → ruft addPasskey() Lib
   - Delete pro Passkey (mindestens 1 muss bleiben)
   - Created-At + Last-Used-At-Anzeige
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { userStore } from '../stores/user.svelte.js';
  import { apiFetch } from '../lib/api.js';
  import { captureException } from '../lib/sentry.js';

  let { isOpen = $bindable(false) } = $props();

  let lang = $derived(i18nStore.lang);

  let passkeys = $state([]);
  let isLoading = $state(false);
  let isAdding = $state(false);
  let errorMsg = $state("");

  $effect(() => {
    if (isOpen) {
      loadPasskeys();
    }
  });

  async function loadPasskeys() {
    isLoading = true;
    errorMsg = "";
    try {
      const r = await apiFetch("/auth/passkeys");
      if (r.ok && Array.isArray(r.data?.passkeys)) {
        passkeys = r.data.passkeys;
      } else {
        passkeys = [];
        errorMsg = lang.passkeysLoadFailed || "Passkeys konnten nicht geladen werden";
      }
    } catch (e) {
      captureException(e, { context: "loadPasskeys" });
      errorMsg = lang.passkeysLoadFailed || "Passkeys konnten nicht geladen werden";
    } finally {
      isLoading = false;
    }
  }

  async function onAddPasskey() {
    if (isAdding) return;
    const name = prompt(lang.passkeyNamePrompt || "Name für diesen Passkey (z.B. iPhone, MacBook)");
    if (name === null) return; // User cancelled

    isAdding = true;
    errorMsg = "";
    try {
      // addPasskey() aus passkey.js (folgt in nächster Sub-Phase mit voller Migration)
      const { addPasskey } = await import("../lib/passkey.js")
        .then(m => m.addPasskey ? m : { addPasskey: null });

      if (!addPasskey) {
        errorMsg = "Add-Passkey-Funktion noch nicht implementiert (Phase 1A.6 stub)";
        return;
      }

      await addPasskey(userStore.myUser, name || null);
      await loadPasskeys();
    } catch (e) {
      if (e.name !== "NotAllowedError" && e.message !== "user_cancelled") {
        errorMsg = (lang.passkeyAddFailed || "Hinzufügen fehlgeschlagen") + ": " + (e.message || "");
        captureException(e, { context: "addPasskey" });
      }
    } finally {
      isAdding = false;
    }
  }

  async function onDeletePasskey(credentialId) {
    if (passkeys.length <= 1) {
      errorMsg = lang.passkeyCannotRemoveLast || "Letzter Passkey kann nicht entfernt werden";
      return;
    }
    if (!confirm(lang.passkeyDeleteConfirm || "Diesen Passkey wirklich entfernen?")) return;

    errorMsg = "";
    try {
      const r = await apiFetch("/auth/passkeys", {
        method: "DELETE",
        body: { credential_id: credentialId },
      });
      if (r.ok) {
        await loadPasskeys();
      } else {
        errorMsg = lang.passkeyDeleteFailed || "Entfernen fehlgeschlagen";
      }
    } catch (e) {
      captureException(e, { context: "deletePasskey" });
      errorMsg = lang.passkeyDeleteFailed || "Entfernen fehlgeschlagen";
    }
  }

  function close() {
    isOpen = false;
  }

  function onBackdropClick(e) {
    if (e.target.classList.contains("pk-overlay")) close();
  }

  function formatDate(ts) {
    if (!ts) return lang.passkeyNeverUsed || "Noch nie verwendet";
    return new Date(ts).toLocaleDateString(lang.locale || "de-DE", {
      day: "numeric", month: "short", year: "numeric",
    });
  }

  function deviceIcon(name) {
    const n = (name || "").toLowerCase();
    if (n.includes("iphone") || n.includes("ipad")) return "📱";
    if (n.includes("mac") || n.includes("macbook")) return "💻";
    if (n.includes("android")) return "📱";
    if (n.includes("yubi") || n.includes("key")) return "🔑";
    return "🔐";
  }
</script>

{#if isOpen}
  <div class="pk-overlay" role="presentation" onclick={onBackdropClick}>
    <div class="pk-dialog" role="dialog" aria-labelledby="pk-title" aria-modal="true">
      <div class="pk-header">
        <h3 id="pk-title">{lang.passkeysTitle || "Passkeys verwalten"}</h3>
        <button class="close-btn" onclick={close} aria-label="Close">×</button>
      </div>

      <p class="pk-hint">
        {lang.passkeysHint || "Passkeys sind dein Login-Schlüssel. Du kannst mehrere haben (z.B. einen pro Gerät)."}
      </p>

      {#if errorMsg}
        <div class="pk-error">{errorMsg}</div>
      {/if}

      <div class="pk-list">
        {#if isLoading}
          <div class="pk-loading">
            <span class="spinner"></span>
            {lang.loading || "Lade…"}
          </div>
        {:else if passkeys.length === 0}
          <div class="pk-empty">
            {lang.passkeysEmpty || "Keine Passkeys gefunden."}
          </div>
        {:else}
          {#each passkeys as pk (pk.credential_id)}
            <div class="pk-item">
              <div class="pk-icon">{deviceIcon(pk.name)}</div>
              <div class="pk-info">
                <div class="pk-name">
                  {pk.name || (lang.passkeyUnnamed || "Unbenannt")}
                </div>
                <div class="pk-meta">
                  <span>{lang.passkeyCreated || "Erstellt"}: {formatDate(pk.created_at)}</span>
                  <span class="dot">·</span>
                  <span>{lang.passkeyLastUsed || "Zuletzt"}: {formatDate(pk.last_used)}</span>
                </div>
              </div>
              <button
                class="pk-delete"
                onclick={() => onDeletePasskey(pk.credential_id)}
                disabled={passkeys.length <= 1}
                title={passkeys.length <= 1 ? (lang.passkeyCannotRemoveLast || "Letzter Passkey") : ""}
                aria-label="Delete passkey"
              >
                ✕
              </button>
            </div>
          {/each}
        {/if}
      </div>

      <button
        class="pk-add-btn"
        onclick={onAddPasskey}
        disabled={isAdding}
      >
        {#if isAdding}
          <span class="spinner"></span>
          {lang.passkeyAdding || "Wird hinzugefügt…"}
        {:else}
          {lang.passkeyAdd || "+ Passkey hinzufügen"}
        {/if}
      </button>
    </div>
  </div>
{/if}

<style>
  .pk-overlay {
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

  .pk-dialog {
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 14px;
    padding: 22px;
    width: 100%;
    max-width: 440px;
    max-height: calc(100vh - 40px);
    max-height: calc(100dvh - 40px);
    overflow-y: auto;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
  }

  .pk-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .pk-header h3 {
    margin: 0;
    font-size: 17px;
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

  .pk-hint {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
    margin-bottom: 14px;
  }

  .pk-error {
    padding: 10px 12px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid var(--status-error);
    border-radius: 8px;
    color: var(--status-error);
    font-size: 12px;
    margin-bottom: 12px;
  }

  .pk-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 14px;
    min-height: 60px;
  }

  .pk-loading,
  .pk-empty {
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
    padding: 24px 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  .pk-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
  }

  .pk-icon {
    font-size: 24px;
    flex-shrink: 0;
  }

  .pk-info {
    flex: 1;
    min-width: 0;
  }

  .pk-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 2px;
  }

  .pk-meta {
    font-size: 11px;
    color: var(--text-muted);
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .pk-meta .dot {
    opacity: 0.5;
  }

  .pk-delete {
    background: none;
    border: 1px solid transparent;
    color: var(--status-error);
    cursor: pointer;
    font-size: 14px;
    padding: 6px 10px;
    border-radius: 6px;
    opacity: 0.6;
    transition: all 0.15s;
    flex-shrink: 0;
  }

  .pk-delete:hover:not(:disabled) {
    opacity: 1;
    background: rgba(239, 68, 68, 0.1);
    border-color: var(--status-error);
  }

  .pk-delete:disabled {
    opacity: 0.2;
    cursor: not-allowed;
  }

  .pk-add-btn {
    width: 100%;
    padding: 12px;
    background: var(--accent-voice);
    color: #07070a;
    border: none;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  .pk-add-btn:hover:not(:disabled) {
    background: #0ea5e9;
  }

  .pk-add-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(7, 7, 10, 0.2);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
</style>
