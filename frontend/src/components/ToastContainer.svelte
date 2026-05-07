<!--
  ToastContainer — rendert toastStore.toasts unten-mitte als Stack.
  Auto-dismiss läuft im Store; hier nur Render + Click-zum-Schließen.
-->
<script>
  import { toastStore } from '../stores/toast.svelte.js';

  let toasts = $derived(toastStore.toasts);
</script>

{#if toasts.length > 0}
  <div class="toast-stack" role="status" aria-live="polite">
    {#each toasts as t (t.id)}
      <button
        class="toast"
        class:info={t.kind === 'info'}
        class:success={t.kind === 'success'}
        class:warn={t.kind === 'warn'}
        class:error={t.kind === 'error'}
        class:actionable={t.hasAction}
        onclick={() => t.hasAction ? toastStore.trigger(t.id) : toastStore.dismiss(t.id)}
        type="button"
        aria-label={t.hasAction ? 'Action' : 'Dismiss'}
      >
        <span class="toast-text">{t.text}</span>
        {#if t.hasAction}
          <span class="toast-arrow" aria-hidden="true">→</span>
        {/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  .toast-stack {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1300;
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none;
    max-width: calc(100vw - 32px);
  }

  .toast {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    background: var(--bg-panel);
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    color: var(--text-primary);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    animation: slideUp 0.18s ease-out;
    text-align: left;
    line-height: 1.4;
    max-width: 100%;
  }

  .toast-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  @keyframes slideUp {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .toast.success { border-color: var(--status-success); }
  .toast.warn    { border-color: #f59e0b; }
  .toast.error   { border-color: var(--status-error); }
  .toast.info    { border-color: var(--accent-voice); }

  .toast:hover {
    background: var(--bg-panel-alt);
  }

  .toast.actionable {
    background: var(--accent-voice-dim);
    border-color: var(--accent-voice);
    color: var(--text-primary);
  }
  .toast.actionable:hover {
    background: var(--bg-panel-alt);
  }

  .toast-arrow {
    color: var(--accent-voice);
    font-weight: 700;
    margin-left: 4px;
  }
</style>
