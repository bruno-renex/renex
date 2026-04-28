<!--
  PendingRequestsModal — Eingehende + Ausgehende Kontaktanfragen verwalten
  Migration von /renex/index.html #requests-modal.
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { inboxStore } from '../stores/inbox.svelte.js';

  let { isOpen = $bindable(false) } = $props();

  let lang = $derived(i18nStore.lang);
  let pendingIn = $derived(inboxStore.pendingIn);
  let pendingOut = $derived(inboxStore.pendingOut);

  let busyHandles = $state(new Set());

  function close() { isOpen = false; }
  function onBackdropClick(e) {
    if (e.target.classList.contains("rq-overlay")) close();
  }

  async function accept(handle) {
    const next = new Set(busyHandles); next.add(handle); busyHandles = next;
    await inboxStore.acceptRequest(handle);
    next.delete(handle); busyHandles = new Set(next);
  }
  async function reject(handle) {
    if (!confirm(lang.rejectConfirm || "Diese Anfrage ablehnen?")) return;
    const next = new Set(busyHandles); next.add(handle); busyHandles = next;
    await inboxStore.rejectRequest(handle);
    next.delete(handle); busyHandles = new Set(next);
  }
  async function cancel(handle) {
    if (!confirm(lang.cancelConfirm || "Anfrage zurückziehen?")) return;
    const next = new Set(busyHandles); next.add(handle); busyHandles = next;
    await inboxStore.cancelRequest(handle);
    next.delete(handle); busyHandles = new Set(next);
  }

  function initials(handle) {
    return handle.slice(0, 2).toUpperCase();
  }
</script>

{#if isOpen}
  <div class="rq-overlay" role="presentation" onclick={onBackdropClick}>
    <div class="rq-dialog" role="dialog" aria-labelledby="rq-title" aria-modal="true">
      <div class="rq-header">
        <h3 id="rq-title">📩 {lang.contactRequests || "Kontaktanfragen"}</h3>
        <button class="close-btn" onclick={close} aria-label="Close">×</button>
      </div>

      {#if pendingIn.length === 0 && pendingOut.length === 0}
        <div class="empty">
          <div class="empty-icon">📭</div>
          <p>{lang.noPendingRequests || "Keine offenen Anfragen"}</p>
        </div>
      {:else}
        <!-- Eingehende -->
        {#if pendingIn.length > 0}
          <div class="section">
            <div class="section-title">
              {lang.incomingRequests || "Eingehende"} <span class="count">{pendingIn.length}</span>
            </div>
            {#each pendingIn as req (req.handle)}
              <div class="request-item">
                <div class="avatar">{initials(req.handle)}</div>
                <div class="info">
                  <div class="handle">@{req.handle}</div>
                  <div class="hint">{lang.wantsToAddYou || "möchte dich als Kontakt hinzufügen"}</div>
                </div>
                <div class="actions">
                  <button
                    class="btn btn-accept"
                    onclick={() => accept(req.handle)}
                    disabled={busyHandles.has(req.handle)}
                    title={lang.acceptBtn || "Annehmen"}
                  >✓</button>
                  <button
                    class="btn btn-reject"
                    onclick={() => reject(req.handle)}
                    disabled={busyHandles.has(req.handle)}
                    title={lang.rejectBtn || "Ablehnen"}
                  >×</button>
                </div>
              </div>
            {/each}
          </div>
        {/if}

        <!-- Ausgehende -->
        {#if pendingOut.length > 0}
          <div class="section">
            <div class="section-title">
              {lang.outgoingRequests || "Gesendete"} <span class="count">{pendingOut.length}</span>
            </div>
            {#each pendingOut as req (req.handle)}
              <div class="request-item">
                <div class="avatar">{initials(req.handle)}</div>
                <div class="info">
                  <div class="handle">@{req.handle}</div>
                  <div class="hint">{lang.waitingForResponse || "wartet auf Antwort…"}</div>
                </div>
                <div class="actions">
                  <button
                    class="btn btn-cancel"
                    onclick={() => cancel(req.handle)}
                    disabled={busyHandles.has(req.handle)}
                    title={lang.cancelRequestBtn || "Zurückziehen"}
                  >{lang.cancelBtn || "Abbrechen"}</button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .rq-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 1100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    animation: fadeIn 0.15s ease-out;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .rq-dialog {
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

  .rq-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 14px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .rq-header h3 { margin: 0; font-size: 16px; color: var(--text-primary); }

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

  .empty {
    text-align: center;
    padding: 30px 0;
    color: var(--text-muted);
  }
  .empty-icon { font-size: 36px; margin-bottom: 8px; opacity: 0.6; }

  .section { margin-bottom: 16px; }
  .section-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent-voice);
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .count {
    background: var(--accent-voice);
    color: #07070a;
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 10px;
    font-weight: 800;
  }

  .request-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    margin-bottom: 6px;
  }

  .avatar {
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

  .info { flex: 1; min-width: 0; }
  .handle {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 13px;
    font-weight: 700;
    color: var(--text-primary);
  }
  .hint {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 2px;
  }

  .actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .btn {
    padding: 7px 10px;
    border-radius: 8px;
    border: 1px solid transparent;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-accept {
    background: var(--status-success);
    color: white;
    width: 36px;
    height: 36px;
    padding: 0;
  }
  .btn-accept:hover:not(:disabled) { background: #059669; }

  .btn-reject {
    background: transparent;
    color: var(--status-error);
    border-color: var(--status-error);
    width: 36px;
    height: 36px;
    padding: 0;
  }
  .btn-reject:hover:not(:disabled) { background: rgba(239, 68, 68, 0.1); }

  .btn-cancel {
    background: var(--bg-panel);
    color: var(--text-muted);
    border-color: var(--border-subtle);
    font-weight: 600;
    font-size: 12px;
  }
  .btn-cancel:hover:not(:disabled) {
    color: var(--status-error);
    border-color: var(--status-error);
  }
</style>
