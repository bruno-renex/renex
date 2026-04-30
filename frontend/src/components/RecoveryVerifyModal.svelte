<!--
  RecoveryVerifyModal — Verifikation beim 2. Login
  Spec: docs/RECOVERY.md §6.3, §5.4

  Flow:
   1. Modal öffnet wenn user.phraseVerified === false beim Bootstrap
   2. User gibt 12-Wort-Phrase ein
   3. Frontend: Salt fetchen → MasterKey ableiten → Bundle decrypten
   4. Wenn Decrypt klappt → markVerified() → Modal schließt
   5. Bei Fehler: max 5 Versuche (Backend-Rate-Limit), dann 1h-Cooldown

  ESC + Backdrop-Click sind disabled — App-Entry ohne Verify nicht möglich.
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import {
    validatePhrase, normalizePhrase,
    deriveMasterKey, deriveMasterKeyRaw, decryptBundle,
    getBundle, markVerified,
  } from '../lib/recovery.js';
  import { cacheMasterKey } from '../lib/masterKey.js';
  import { restoreCmksFromBundle } from '../lib/cmkBundleSync.js';
  import { captureException } from '../lib/sentry.js';

  let { isOpen = $bindable(false), onComplete = () => {} } = $props();

  let lang = $derived(i18nStore.lang);

  let inputs = $state(Array(12).fill(''));
  let isVerifying = $state(false);
  let errorMsg = $state('');
  let attemptsLeft = $state(5);

  // Composed-Phrase aus 12 Eingabefeldern
  let composedPhrase = $derived(inputs.map(s => s.trim().toLowerCase()).join(' '));
  let isComplete = $derived(inputs.every(s => s.trim().length > 0));

  function handleInput(idx, e) {
    const val = e.target.value;
    // Wenn User mehrere Wörter pasted: auto-split auf alle Inputs
    if (val.includes(' ') || val.includes('\n')) {
      const words = val.split(/[\s\n]+/).filter(Boolean);
      const newInputs = [...inputs];
      for (let i = 0; i < words.length && (idx + i) < 12; i++) {
        newInputs[idx + i] = words[i].toLowerCase();
      }
      inputs = newInputs;
    } else {
      inputs[idx] = val.toLowerCase();
    }
    errorMsg = '';
  }

  function handleKeydown(idx, e) {
    if (e.key === 'Tab') return; // normales Tab
    if (e.key === ' ' || e.key === 'Enter') {
      // Space/Enter im Feld: zum nächsten Feld springen
      e.preventDefault();
      const next = document.getElementById(`recv-word-${idx + 1}`);
      if (next) next.focus();
      else if (isComplete) verify();
    }
    if (e.key === 'Backspace' && !inputs[idx] && idx > 0) {
      e.preventDefault();
      const prev = document.getElementById(`recv-word-${idx - 1}`);
      if (prev) prev.focus();
    }
  }

  async function verify() {
    if (!isComplete || isVerifying) return;

    const phrase = composedPhrase;
    if (!validatePhrase(phrase)) {
      errorMsg = lang.recoveryInvalidPhrase || 'Phrase ist nicht gültig (BIP39-Fehler).';
      return;
    }

    isVerifying = true;
    errorMsg = '';

    try {
      // Salt + Bundle holen
      const data = await getBundle();
      if (!data || !data.blob) {
        errorMsg = lang.recoveryNoBundle || 'Kein Recovery-Bundle gefunden.';
        return;
      }

      // MasterKey ableiten + Decrypt-Test
      const masterKey = await deriveMasterKey(phrase, data.salt);

      let bundle;
      try {
        bundle = await decryptBundle(data.blob, masterKey);
      } catch {
        // Decrypt failed → Phrase falsch
        attemptsLeft = Math.max(0, attemptsLeft - 1);
        errorMsg = attemptsLeft > 0
          ? `${lang.recoveryWrongPhrase || 'Falsch.'} ${attemptsLeft} ${lang.attemptsLeft || 'Versuche übrig'}.`
          : (lang.recoveryCooldown || 'Zu viele falsche Versuche. Versuche es in 1 Stunde erneut.');
        return;
      }

      // Phrase korrekt → masterKey cachen + CMKs restoren
      try {
        const masterKeyBytes = await deriveMasterKeyRaw(phrase, data.salt);
        await cacheMasterKey(masterKeyBytes);
        await restoreCmksFromBundle(bundle);
      } catch (e) {
        // Cache/Restore-Fehler ist non-fatal für Verify selbst
        captureException(e, { context: 'recoveryVerifyCacheRestore' });
      }

      // Erfolg: Backend markieren
      const r = await markVerified();
      if (!r.ok) {
        if (r.error === 'unauthorized' || r.error === 'Too many requests') {
          errorMsg = lang.recoveryCooldown || 'Zu viele Versuche.';
          return;
        }
        throw new Error(r.error || 'verify_failed');
      }

      isOpen = false;
      onComplete();
    } catch (e) {
      captureException(e, { context: 'recoveryVerify' });
      errorMsg = (lang.recoveryVerifyFailed || 'Verifikation fehlgeschlagen') + ': ' + (e.message || '');
    } finally {
      isVerifying = false;
    }
  }

  // Block ESC
  function onKeydown(e) {
    if (e.key === 'Escape') e.preventDefault();
  }
  $effect(() => {
    if (isOpen) {
      window.addEventListener('keydown', onKeydown);
      return () => window.removeEventListener('keydown', onKeydown);
    }
  });
</script>

{#if isOpen}
  <div class="rv-overlay" role="presentation">
    <div class="rv-dialog" role="dialog" aria-labelledby="rv-title" aria-modal="true">
      <h3 id="rv-title">🔑 {lang.recoveryVerifyTitle || 'Recovery-Phrase bestätigen'}</h3>

      <p class="rv-intro">
        {lang.recoveryVerifyIntro || 'Bevor du fortfährst: Bestätige bitte einmal, dass du deine Recovery-Phrase gespeichert hast. Gib alle 12 Wörter ein.'}
      </p>

      <div class="rv-grid">
        {#each inputs as _, i (i)}
          <div class="rv-field">
            <span class="rv-num">{i + 1}</span>
            <input
              id="recv-word-{i}"
              type="text"
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
              value={inputs[i]}
              oninput={(e) => handleInput(i, e)}
              onkeydown={(e) => handleKeydown(i, e)}
              disabled={isVerifying}
            />
          </div>
        {/each}
      </div>

      {#if errorMsg}
        <div class="rv-error">{errorMsg}</div>
      {/if}

      <button
        class="rv-btn-primary"
        disabled={!isComplete || isVerifying || attemptsLeft === 0}
        onclick={verify}
      >
        {#if isVerifying}
          <span class="spinner"></span>
          {lang.recoveryVerifying || 'Prüfe…'}
        {:else}
          {lang.recoveryVerifyBtn || 'Bestätigen'}
        {/if}
      </button>

      <p class="rv-hint">
        {lang.recoveryVerifyHint || 'Du kannst Tab oder Leertaste verwenden, um zwischen den Feldern zu wechseln. Pasten der gesamten Phrase funktioniert auch.'}
      </p>
    </div>
  </div>
{/if}

<style>
  .rv-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.85);
    z-index: 1200;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }

  .rv-dialog {
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 14px;
    padding: 24px;
    width: 100%;
    max-width: 520px;
    max-height: calc(100dvh - 40px);
    overflow-y: auto;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.7);
  }

  h3 {
    margin: 0 0 12px 0;
    font-size: 18px;
    color: var(--text-primary);
  }

  .rv-intro {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.5;
    margin-bottom: 20px;
  }

  .rv-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    margin-bottom: 14px;
  }

  .rv-field {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 4px 6px;
  }

  .rv-field:focus-within {
    border-color: var(--accent-voice);
  }

  .rv-num {
    font-size: 10px;
    color: var(--text-muted);
    min-width: 14px;
    text-align: right;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }

  .rv-field input {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-size: 13px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    outline: none;
    width: 100%;
    min-width: 0;
  }

  .rv-error {
    padding: 10px 12px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid var(--status-error);
    border-radius: 8px;
    color: var(--status-error);
    font-size: 12px;
    margin-bottom: 14px;
  }

  .rv-btn-primary {
    width: 100%;
    background: var(--accent-voice);
    border: none;
    color: var(--bg-panel);
    padding: 12px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    transition: opacity 0.1s;
    margin-bottom: 10px;
  }

  .rv-btn-primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .rv-hint {
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1.4;
    margin: 0;
  }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: var(--bg-panel);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
</style>
