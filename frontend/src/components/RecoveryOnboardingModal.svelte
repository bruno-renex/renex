<!--
  RecoveryOnboardingModal — Welcome-Flow nach Register
  Spec: docs/RECOVERY.md §6.1, §5.1

  Flow:
   1. Generiert Phrase + Salt + leeres Bundle
   2. Schreibt Salt + initial-Bundle ins Backend
   3. Zeigt Phrase prominent, Copy + Print-Button
   4. User ☑ "Ich habe gespeichert" → Continue → Modal schließt
   5. recovery_phrase_shown_at = now (Backend-side via init)

  ESC + Backdrop-Click sind disabled — User muss bewusst durchklicken.
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { userStore } from '../stores/user.svelte.js';
  import {
    generatePhrase, randomSalt, deriveMasterKey, deriveMasterKeyRaw,
    encryptBundle, initRecovery, putBundle,
  } from '../lib/recovery.js';
  import { cacheMasterKey } from '../lib/masterKey.js';
  import { captureException } from '../lib/sentry.js';

  let { isOpen = $bindable(false), onComplete = () => {} } = $props();

  let lang = $derived(i18nStore.lang);

  // States
  let phrase = $state('');
  let words = $derived(phrase ? phrase.split(' ') : []);
  let isGenerating = $state(false);
  let isSavingBundle = $state(false);
  let acknowledged = $state(false);
  let errorMsg = $state('');
  let copyConfirm = $state(false);

  // Bei Modal-Open: Phrase + Salt generieren + Bundle initialisieren.
  // Stop-Condition errorMsg verhindert Endlos-Loop wenn Setup fehlschlägt
  // (z.B. salt_exists 409): User klickt „Erneut versuchen" um zu retry.
  $effect(() => {
    if (isOpen && !phrase && !isGenerating && !errorMsg) {
      void initSetup();
    }
  });

  async function initSetup() {
    isGenerating = true;
    errorMsg = '';
    try {
      // 1. Phrase + Salt generieren (sync, schnell)
      const newPhrase = generatePhrase();
      const salt = randomSalt();

      // 2. Salt zum Backend schreiben (one-shot)
      const initRes = await initRecovery(salt);
      if (!initRes.ok) {
        // Idempotenz: Backend liefert 409 + code:salt_exists wenn schon initialisiert.
        // Match per status (eindeutig) statt String-Vergleich auf der Error-Message.
        if (initRes.status === 409 || initRes.code === 'salt_exists') {
          errorMsg = lang.recoveryAlreadyExists || 'Recovery-Setup existiert bereits. Bitte logge dich neu ein.';
          return;
        }
        throw new Error(initRes.error || 'init_failed');
      }

      // 3. MasterKey ableiten (~500ms) — sowohl als CryptoKey für Bundle-Encrypt
      //    als auch als Raw-Bytes für IDB-Cache (Auto-Sync auf CMK-Änderungen).
      const masterKey = await deriveMasterKey(newPhrase, salt);
      const masterKeyBytes = await deriveMasterKeyRaw(newPhrase, salt);

      // 4. Initial-Bundle: leer (User hat noch keine Convos)
      const initialBundle = {
        ts: Date.now(),
        cmks: {},
        gsks: {},
      };
      // L2: handle als AAD-Binding → Bundle-Ciphertext gehört nachweislich
      // zu DIESEM User. encryptBundle markiert v=2 wenn handle gegeben.
      const blob = await encryptBundle(initialBundle, masterKey, userStore.myUser);
      isSavingBundle = true;
      const putRes = await putBundle(blob);
      isSavingBundle = false;
      if (!putRes.ok) {
        throw new Error(putRes.error || 'bundle_put_failed');
      }

      // MasterKey-Cache → ermöglicht Auto-Sync ohne erneute Phrase-Eingabe.
      // Non-fatal: bei Fehler gehts trotzdem weiter (User hat Phrase + Bundle).
      try {
        await cacheMasterKey(masterKeyBytes);
      } catch (e) {
        captureException(e, { context: 'recoveryOnboardingCacheMasterKey' });
      }

      // 5. Phrase erst NACH erfolgreichem Backend-Schreib anzeigen.
      //    Sonst: User notiert Phrase, Backend-Fehler → Phrase nutzlos.
      phrase = newPhrase;
    } catch (e) {
      captureException(e, { context: 'recoveryOnboardingInit' });
      errorMsg = (lang.recoverySetupFailed || 'Setup fehlgeschlagen') + ': ' + (e.message || '');
    } finally {
      isGenerating = false;
    }
  }

  async function copyPhrase() {
    try {
      await navigator.clipboard.writeText(phrase);
      copyConfirm = true;
      setTimeout(() => copyConfirm = false, 2000);
    } catch (e) {
      errorMsg = lang.copyFailed || 'Kopieren fehlgeschlagen';
    }
  }

  function printPhrase() {
    window.print();
  }

  function onContinue() {
    if (!acknowledged || !phrase) return;
    isOpen = false;
    onComplete();
  }

  // Block ESC + Backdrop-Click
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
  <div class="rec-overlay" role="presentation">
    <div class="rec-dialog" role="dialog" aria-labelledby="rec-title" aria-modal="true">
      <h3 id="rec-title">🔑 {lang.recoveryTitle || 'Deine Recovery-Phrase'}</h3>

      <p class="rec-intro">
        {lang.recoveryIntro || 'Diese 12 Wörter sind dein einziger Weg zurück, wenn du alle deine Geräte verlierst.'}
      </p>

      {#if isGenerating}
        <div class="rec-loading">
          <span class="spinner"></span>
          {isSavingBundle
            ? (lang.recoverySaving || 'Speichere…')
            : (lang.recoveryDeriving || 'Generiere Phrase…')}
        </div>
      {:else if errorMsg}
        <div class="rec-error">{errorMsg}</div>
        <button class="rec-retry" onclick={initSetup}>
          {lang.retry || 'Erneut versuchen'}
        </button>
      {:else if phrase}
        <div class="rec-grid">
          {#each words as word, i}
            <div class="rec-word">
              <span class="rec-num">{i + 1}</span>
              <span class="rec-text">{word}</span>
            </div>
          {/each}
        </div>

        <div class="rec-actions">
          <button class="rec-btn-secondary" onclick={copyPhrase}>
            {copyConfirm ? '✓ ' + (lang.copied || 'Kopiert') : '📋 ' + (lang.copy || 'Kopieren')}
          </button>
          <button class="rec-btn-secondary" onclick={printPhrase}>
            🖨️ {lang.print || 'Drucken'}
          </button>
        </div>

        <div class="rec-warning">
          ⚠️ {lang.recoveryWarning || 'Wir können sie NICHT für dich wiederherstellen. Schreibe sie auf Papier, nicht ins Cloud-Drive.'}
        </div>

        <label class="rec-checkbox">
          <input type="checkbox" bind:checked={acknowledged} />
          <span>{lang.recoveryAck || 'Ich habe meine Phrase sicher notiert.'}</span>
        </label>

        <button
          class="rec-btn-primary"
          disabled={!acknowledged}
          onclick={onContinue}
        >
          {lang.continue || 'Weiter'}
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .rec-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.85);
    z-index: 1200;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }

  .rec-dialog {
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

  .rec-intro {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.5;
    margin-bottom: 20px;
  }

  .rec-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 60px 20px;
    color: var(--text-muted);
    font-size: 13px;
  }

  .rec-error {
    padding: 12px 14px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid var(--status-error);
    border-radius: 8px;
    color: var(--status-error);
    font-size: 12px;
    margin-bottom: 14px;
  }

  .rec-retry {
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    color: var(--text-primary);
    padding: 8px 14px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 13px;
  }

  .rec-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    padding: 14px;
    margin-bottom: 16px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }

  .rec-word {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 6px 8px;
    background: var(--bg-panel);
    border-radius: 6px;
    border: 1px solid var(--border-subtle);
  }

  .rec-num {
    font-size: 10px;
    color: var(--text-muted);
    min-width: 14px;
    text-align: right;
  }

  .rec-text {
    font-size: 13px;
    color: var(--text-primary);
    font-weight: 600;
    user-select: text;
  }

  .rec-actions {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
  }

  .rec-btn-secondary {
    flex: 1;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    color: var(--text-primary);
    padding: 9px 12px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 12px;
    transition: all 0.1s;
  }

  .rec-btn-secondary:hover {
    border-color: var(--accent-voice);
    color: var(--accent-voice);
  }

  .rec-warning {
    padding: 10px 12px;
    background: rgba(239, 68, 68, 0.06);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 8px;
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.5;
    margin-bottom: 16px;
  }

  .rec-checkbox {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    margin-bottom: 16px;
    cursor: pointer;
    font-size: 13px;
    color: var(--text-primary);
    line-height: 1.4;
  }

  .rec-checkbox input {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    margin: 0;
    cursor: pointer;
  }

  .rec-btn-primary {
    width: 100%;
    background: var(--accent-voice);
    border: none;
    color: var(--bg-panel);
    padding: 12px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 600;
    transition: opacity 0.1s;
  }

  .rec-btn-primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid var(--border-subtle);
    border-top-color: var(--accent-voice);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* Print-Layout: nur die Phrase, ohne Modal-Chrome */
  @media print {
    .rec-overlay {
      position: static;
      background: white;
      padding: 0;
    }
    .rec-dialog {
      box-shadow: none;
      border: 1px solid black;
      max-width: 100%;
      color: black;
    }
    h3, .rec-intro, .rec-warning {
      color: black;
    }
    .rec-grid {
      background: white;
      border: 1px solid black;
    }
    .rec-word {
      background: white;
      border: 1px solid #ccc;
    }
    .rec-actions, .rec-checkbox, .rec-btn-primary {
      display: none;
    }
  }
</style>
