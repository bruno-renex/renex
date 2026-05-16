<!--
  LinkWarningModal — Phishing-/Homograph-Warnung vor Link-Klick.

  Wird vom linkWarningStore gesteuert. Mount: einmal in App.svelte.
  Wird gezeigt sobald analyzeLink() einen Link als unsafe einstuft
  (Punycode-IDN, Mixed-Scripts, userinfo, URL-Shortener).

  User-Pfad:
    - "Trotzdem öffnen"  → window.open(href, _blank, noopener,noreferrer)
    - "Abbrechen"        → Modal schließt, nichts passiert
    - Escape / Backdrop  → wie Abbrechen
-->
<script>
  import { linkWarningStore } from '../stores/linkWarning.svelte.js';
  import { reasonText } from '../lib/linkSafety.js';

  let isOpen = $derived(linkWarningStore.isOpen);
  let href = $derived(linkWarningStore.href);
  let analysis = $derived(linkWarningStore.analysis);

  let explanation = $derived(
    analysis ? reasonText(analysis.reason, analysis.decodedHost) : ''
  );

  // Headline je nach Reason — kürzer als die Erklärung, fürs Auge
  let headline = $derived.by(() => {
    if (!analysis) return '';
    switch (analysis.reason) {
      case 'punycode':       return '⚠️ Verdächtige Domain (Punycode)';
      case 'mixed_scripts':  return '⚠️ Verdächtige Domain (gemischte Schrift)';
      case 'userinfo':       return '⚠️ Phishing-Trick erkannt';
      case 'shortener':      return '🔗 URL-Shortener';
      case 'invalid':        return '⚠️ Ungültiger Link';
      default:               return '⚠️ Externer Link';
    }
  });

  function close() {
    linkWarningStore.close();
  }
  function confirm() {
    linkWarningStore.confirmOpen();
  }
  function onBackdropClick(e) {
    if (e.target.classList.contains('lw-overlay')) close();
  }
  function onKey(e) {
    if (!isOpen) return;
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') { e.preventDefault(); confirm(); }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if isOpen}
  <div class="lw-overlay" role="presentation" onclick={onBackdropClick}>
    <div class="lw-dialog" role="dialog" aria-labelledby="lw-title" aria-modal="true">
      <div class="lw-header">
        <h3 id="lw-title">{headline}</h3>
        <button class="close-btn" onclick={close} aria-label="Close">×</button>
      </div>

      <div class="lw-body">
        <p class="lw-explain">{explanation}</p>

        <div class="lw-url-box">
          <div class="lw-url-label">Ziel-URL:</div>
          <div class="lw-url" title={href}>{href}</div>
          {#if analysis && analysis.decodedHost && analysis.decodedHost !== analysis.host}
            <div class="lw-url-label" style="margin-top:8px">Dekodiert:</div>
            <div class="lw-url lw-url-decoded">{analysis.decodedHost}</div>
          {/if}
        </div>

        <p class="lw-tip">
          Im Zweifel: <strong>Abbrechen</strong> und den Absender direkt fragen.
        </p>
      </div>

      <div class="lw-buttons">
        <button class="btn btn-secondary" onclick={close}>Abbrechen</button>
        <button class="btn btn-danger" onclick={confirm}>Trotzdem öffnen</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .lw-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    z-index: 1100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    animation: fadeIn 0.15s ease-out;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .lw-dialog {
    background: var(--bg-panel);
    border: 1px solid var(--status-error, #ef4444);
    border-radius: 14px;
    padding: 22px;
    width: 100%;
    max-width: 460px;
    max-height: calc(100vh - 32px);
    max-height: calc(100dvh - 32px);
    overflow-y: auto;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.7);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .lw-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .lw-header h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
    color: var(--status-error, #ef4444);
    line-height: 1.3;
  }
  .close-btn {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 22px;
    width: 28px;
    height: 28px;
    line-height: 1;
    padding: 0;
    flex-shrink: 0;
  }
  .close-btn:hover { color: var(--text-primary); }

  .lw-body { display: flex; flex-direction: column; gap: 12px; }
  .lw-explain {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-primary);
  }
  .lw-url-box {
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 10px 12px;
  }
  .lw-url-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
    font-weight: 700;
    margin-bottom: 4px;
  }
  .lw-url {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px;
    color: var(--text-primary);
    word-break: break-all;
    line-height: 1.4;
  }
  .lw-url-decoded {
    color: var(--status-error, #ef4444);
    font-weight: 600;
  }
  .lw-tip {
    margin: 0;
    font-size: 12px;
    color: var(--text-muted);
    font-style: italic;
  }

  .lw-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
  .btn {
    padding: 8px 16px;
    border-radius: 8px;
    border: 1px solid transparent;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .btn-secondary {
    background: var(--bg-panel-alt);
    color: var(--text-primary);
    border-color: var(--border-subtle);
  }
  .btn-secondary:hover { background: var(--bg-panel); }
  .btn-danger {
    background: var(--status-error, #ef4444);
    color: #fff;
  }
  .btn-danger:hover { background: #dc2626; }
</style>
