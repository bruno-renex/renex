<!--
  RENEX — Root App Component
  Migration-Strategie: nach und nach werden Vanilla-Components
  in Svelte portiert. Dieser App.svelte wird der Container.
-->
<script>
  // Svelte 5 Runes
  let count = $state(0);
  let now = $state(new Date());

  // Live-Clock zeigt dass Reactivity läuft
  setInterval(() => {
    now = new Date();
  }, 1000);

  function increment() {
    count++;
  }
</script>

<main>
  <div class="brand">
    <span class="r">RENE</span><span class="x">X</span>
  </div>

  <p class="tagline">YOU ARE THE KEY.</p>
  <p class="sub">AI-FREE • PASSKEY-ONLY • HUMANS ONLY</p>

  <div class="status">
    <div class="row">
      <span class="label">Svelte</span>
      <span class="value ok">5.55 ✓</span>
    </div>
    <div class="row">
      <span class="label">Vite</span>
      <span class="value ok">5.4 ✓</span>
    </div>
    <div class="row">
      <span class="label">Reactive Test</span>
      <span class="value">{now.toLocaleTimeString('de-CH')}</span>
    </div>
    <div class="row">
      <span class="label">Counter Test</span>
      <button class="counter" onclick={increment}>{count}</button>
    </div>
  </div>

  <p class="phase">Phase 1A.6 — Svelte Migration foundation laid 🚀</p>
</main>

<style>
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 18px;
    padding: 20px;
    text-align: center;
  }

  .brand {
    font-size: 48px;
    font-weight: 800;
    letter-spacing: 0.18em;
    user-select: none;
  }

  .brand .r {
    color: var(--text-primary);
  }

  .brand .x {
    color: var(--accent-voice);
    text-shadow: 0 0 20px rgba(56, 189, 248, 0.6);
  }

  .tagline {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.3em;
    color: var(--text-secondary);
    text-transform: uppercase;
  }

  .sub {
    font-size: 11px;
    letter-spacing: 0.2em;
    color: var(--text-muted);
    text-transform: uppercase;
  }

  .status {
    margin-top: 24px;
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 14px;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 280px;
  }

  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 13px;
  }

  .label {
    color: var(--text-muted);
  }

  .value {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    color: var(--text-primary);
  }

  .value.ok {
    color: var(--status-success);
  }

  .counter {
    background: var(--accent-voice-dim);
    color: var(--accent-voice);
    border: 1px solid var(--accent-voice);
    border-radius: 6px;
    padding: 4px 14px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 13px;
    font-weight: 600;
    transition: background 0.15s;
  }

  .counter:hover {
    background: rgba(56, 189, 248, 0.25);
  }

  .phase {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 16px;
  }
</style>
