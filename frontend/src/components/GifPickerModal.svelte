<!--
  GifPickerModal — GIF-Picker mit GIPHY-Suche

  Flow:
    1. Modal öffnet → lädt Trending
    2. User tippt Query → debounced Search
    3. User klickt GIF → onPick(gif) → Modal schließt
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { searchGifs } from '../lib/gifSearch.js';

  /** @type {{ isOpen: boolean, onPick?: (gif: {id:string,url:string,preview:string}) => void }} */
  let { isOpen = $bindable(false), onPick = () => {} } = $props();

  let lang = $derived(i18nStore.lang);

  let query   = $state('');
  let results = $state([]);
  let loading = $state(false);
  let errorMsg = $state(null);

  let _debounceTimer = null;
  let _seq = 0;          // Race-Guard für Search-Antworten

  $effect(() => {
    if (!isOpen) {
      query = '';
      results = [];
      errorMsg = null;
      return;
    }
    // Initial: Trending
    void _runSearch('');
  });

  $effect(() => {
    if (!isOpen) return;
    // Debounce User-Input
    if (_debounceTimer) clearTimeout(_debounceTimer);
    const q = query;
    _debounceTimer = setTimeout(() => { void _runSearch(q); }, 300);
    return () => { if (_debounceTimer) clearTimeout(_debounceTimer); };
  });

  async function _runSearch(q) {
    const mySeq = ++_seq;
    loading = true;
    errorMsg = null;
    try {
      const r = await searchGifs(q);
      if (mySeq !== _seq) return;          // veraltete Antwort
      if (r.ok) {
        results = r.results;
      } else {
        results = [];
        errorMsg = r.error === 'rate_limit'
          ? (lang.gifRateLimit || 'Zu viele Suchen — bitte warten.')
          : r.error === 'not_configured'
          ? (lang.gifNotConfigured || 'GIF-Suche nicht verfügbar.')
          : (lang.gifSearchFailed || 'GIF-Suche fehlgeschlagen.');
      }
    } finally {
      if (mySeq === _seq) loading = false;
    }
  }

  function close() { isOpen = false; }
  function onBackdrop(e) { if (e.target.classList.contains('gif-overlay')) close(); }
  function onKeydown(e) { if (e.key === 'Escape') close(); }

  function pick(gif) {
    onPick(gif);
    close();
  }
</script>

{#if isOpen}
  <div class="gif-overlay" role="presentation" onclick={onBackdrop}>
    <div
      class="gif-dialog"
      role="dialog"
      aria-labelledby="gif-title"
      aria-modal="true"
      tabindex="-1"
      onkeydown={onKeydown}
    >
      <div class="gif-header">
        <h3 id="gif-title">{lang.gifTitle || 'GIF suchen'}</h3>
        <button class="close-btn" onclick={close} aria-label="Close">×</button>
      </div>

      <input
        type="search"
        class="gif-search"
        bind:value={query}
        placeholder={lang.gifSearchPlaceholder || 'GIF suchen…'}
        autofocus
        autocomplete="off"
        autocorrect="off"
        spellcheck="false"
      />

      {#if errorMsg}
        <div class="gif-error">{errorMsg}</div>
      {:else if loading && results.length === 0}
        <div class="gif-loading">
          <span class="spinner"></span>
          {lang.gifSearching || 'Suche…'}
        </div>
      {:else if results.length === 0}
        <div class="gif-empty">{lang.gifNoResults || 'Keine Ergebnisse.'}</div>
      {:else}
        <div class="gif-grid">
          {#each results as g (g.id)}
            <button class="gif-tile" type="button" onclick={() => pick(g)} aria-label={lang.pickGif || 'GIF auswählen'}>
              <img src={g.preview || g.url} alt="" loading="lazy" />
            </button>
          {/each}
        </div>
      {/if}

      <div class="gif-attribution">
        {lang.poweredByGiphy || 'Powered by GIPHY'}
      </div>
    </div>
  </div>
{/if}

<style>
  .gif-overlay {
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

  .gif-dialog {
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 14px;
    padding: 18px;
    width: 100%;
    max-width: 560px;
    max-height: calc(100vh - 32px);
    max-height: calc(100dvh - 32px);
    display: flex;
    flex-direction: column;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
  }

  .gif-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }
  .gif-header h3 { margin: 0; font-size: 15px; color: var(--text-primary); }

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

  .gif-search {
    width: 100%;
    padding: 10px 12px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    color: var(--text-primary);
    font-size: 13px;
    margin-bottom: 12px;
  }
  .gif-search:focus { border-color: var(--accent-voice); outline: none; }

  .gif-loading,
  .gif-empty,
  .gif-error {
    padding: 24px 12px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }
  .gif-error {
    color: var(--status-error);
  }
  .gif-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--border-subtle);
    border-top-color: var(--accent-voice);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .gif-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 6px;
    overflow-y: auto;
    flex: 1;
    min-height: 200px;
  }

  .gif-tile {
    border: 1px solid transparent;
    background: var(--bg-panel-alt);
    border-radius: 8px;
    padding: 0;
    cursor: pointer;
    overflow: hidden;
    transition: border-color 0.12s, transform 0.1s;
    line-height: 0;
  }
  .gif-tile:hover {
    border-color: var(--accent-voice);
  }
  .gif-tile:active {
    transform: scale(0.97);
  }
  .gif-tile img {
    width: 100%;
    height: auto;
    display: block;
    object-fit: cover;
  }

  .gif-attribution {
    margin-top: 10px;
    text-align: right;
    font-size: 10px;
    color: var(--text-muted);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
</style>
