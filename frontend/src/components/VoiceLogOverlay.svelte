<!--
  VoiceLogOverlay — Temporäres Debug-Tool für iOS-PWA Voice-Diagnose.
  Aktiviert via ?voice-debug=1 (einmal aufrufen, persistiert in localStorage).
  Deaktivieren: ?voice-debug=0
  Fängt console.log/warn/error ab und zeigt Zeilen die "📞" enthalten on-screen.
  Voice-Code wird NICHT angefasst — pure Capture-Schicht.
-->
<script>
  import { onMount } from 'svelte';

  let enabled = $state(false);
  let expanded = $state(true);
  let lines = $state([]);
  let copyState = $state("idle");

  const MAX_LINES = 200;

  onMount(() => {
    const url = new URL(window.location.href);
    const param = url.searchParams.get('voice-debug');
    if (param === '1') {
      localStorage.setItem('voice-debug', '1');
    } else if (param === '0') {
      localStorage.removeItem('voice-debug');
    }
    enabled = localStorage.getItem('voice-debug') === '1';
    if (!enabled) return;

    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);

    function capture(level, args) {
      try {
        const first = args.length ? String(args[0]) : '';
        if (!first.includes('📞')) return;
        const ts = new Date().toLocaleTimeString('de-CH', { hour12: false }) +
                   '.' + String(Date.now() % 1000).padStart(3, '0');
        const rest = args.slice(1).map(a => {
          if (a === null) return 'null';
          if (a === undefined) return 'undefined';
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch { return String(a); }
        }).join(' ');
        const text = rest ? `${first} ${rest}` : first;
        lines = [...lines.slice(-(MAX_LINES - 1)), { ts, level, text }];
      } catch {/* never break console */}
    }

    console.log = function(...args) { capture('log', args); return origLog(...args); };
    console.warn = function(...args) { capture('warn', args); return origWarn(...args); };
    console.error = function(...args) { capture('err', args); return origError(...args); };
  });

  async function copyAll() {
    const txt = lines.map(l => `[${l.ts}] ${l.text}`).join('\n');
    try {
      await navigator.clipboard.writeText(txt);
      copyState = "copied";
      setTimeout(() => copyState = "idle", 1500);
    } catch {
      copyState = "fail";
      setTimeout(() => copyState = "idle", 1500);
    }
  }

  function clearAll() { lines = []; }
  function toggle() { expanded = !expanded; }
</script>

{#if enabled}
  <div class="vlo" class:expanded>
    <div class="vlo-bar">
      <button class="vlo-toggle" onclick={toggle} aria-label="Toggle log">
        📞 {lines.length}{expanded ? ' ▾' : ' ▴'}
      </button>
      {#if expanded}
        <button class="vlo-act" onclick={copyAll}>
          {copyState === "copied" ? "✓ kopiert" : copyState === "fail" ? "✗ fehler" : "Kopieren"}
        </button>
        <button class="vlo-act" onclick={clearAll}>Clear</button>
      {/if}
    </div>
    {#if expanded}
      <div class="vlo-list">
        {#each lines as l (l.ts + l.text.slice(0, 20))}
          <div class="vlo-row vlo-{l.level}">
            <span class="vlo-ts">{l.ts.slice(-9)}</span>
            <span class="vlo-text">{l.text}</span>
          </div>
        {/each}
        {#if lines.length === 0}
          <div class="vlo-empty">Noch keine 📞-Logs. Voice-Call starten.</div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .vlo {
    position: fixed;
    left: 8px; right: 8px; bottom: 8px;
    z-index: 999999;
    background: rgba(10, 14, 20, 0.95);
    color: #d8ffd8;
    border: 1px solid #2a3a4a;
    border-radius: 8px;
    font: 11px/1.35 ui-monospace, "SF Mono", Menlo, monospace;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    pointer-events: auto;
  }
  .vlo-bar {
    display: flex; gap: 6px;
    padding: 4px 6px;
    border-bottom: 1px solid #1a2a3a;
  }
  .vlo-toggle {
    flex: 1; text-align: left;
    background: transparent; color: #aaffaa;
    border: 0; padding: 4px 6px;
    font: inherit; cursor: pointer;
  }
  .vlo-act {
    background: #1e3a5a; color: #e0f0ff;
    border: 0; border-radius: 4px;
    padding: 4px 8px;
    font: inherit; cursor: pointer;
  }
  .vlo-act:active { background: #2c5080; }
  .vlo-list {
    max-height: 40vh;
    overflow-y: auto;
    padding: 4px 0;
    -webkit-overflow-scrolling: touch;
  }
  .vlo-row {
    display: flex; gap: 6px;
    padding: 1px 6px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .vlo-ts {
    color: #6a8aa8;
    flex-shrink: 0;
  }
  .vlo-text { flex: 1; }
  .vlo-warn .vlo-text { color: #ffcc66; }
  .vlo-err  .vlo-text { color: #ff8080; }
  .vlo-empty {
    color: #6a8aa8;
    padding: 8px;
    text-align: center;
  }
</style>
