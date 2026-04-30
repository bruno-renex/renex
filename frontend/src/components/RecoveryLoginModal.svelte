<!--
  RecoveryLoginModal — Cross-Device-Recovery auf neuem Browser
  Spec: docs/RECOVERY.md §5.3, §6.4

  Flow:
   Step 1: Auth — Handle + Passkey (Cross-Device via QR/Bluetooth oder Hardware-Key)
   Step 2: Phrase — 12 Wörter eingeben
   Step 3: Decrypt — Bundle laden, MasterKey ableiten, Inhalt zurück
   Step 4: Done — App lädt mit (TODO: IndexedDB-Persistenz erfordert Svelte-E2E-Lib)

  Voraussetzung: User hat NOCH MINDESTENS EINEN funktionierenden Passkey
  (z.B. Hardware-Key, Cross-Device-Passkey via anderem Gerät, iCloud-Keychain).
  Pure-Phrase-only-Recovery ohne Passkey ist NICHT möglich (WebAuthn-Spec).
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { userStore } from '../stores/user.svelte.js';
  import { sessionStore } from '../stores/session.svelte.js';
  import { loginWithPasskey, validateHandle } from '../lib/passkey.js';
  import {
    validatePhrase, deriveMasterKey, deriveMasterKeyRaw, decryptBundle,
    getBundle, markVerified,
  } from '../lib/recovery.js';
  import { cacheMasterKey } from '../lib/masterKey.js';
  import { restoreCmksFromBundle } from '../lib/cmkBundleSync.js';
  import { captureException } from '../lib/sentry.js';

  let { isOpen = $bindable(false), onComplete = () => {} } = $props();

  let lang = $derived(i18nStore.lang);

  // ── Step 1: Auth ─────────────────────────────────────
  let step = $state(1);  // 1=auth, 2=phrase, 3=success
  let handle = $state('');
  let consentChecked = $state(true);  // Recovery-User hat bereits AGB akzeptiert
  let isAuthing = $state(false);
  let authError = $state('');

  // ── Step 2: Phrase ───────────────────────────────────
  let inputs = $state(Array(12).fill(''));
  let isVerifying = $state(false);
  let phraseError = $state('');
  let attemptsLeft = $state(5);

  // ── Step 3: Success-Stats ────────────────────────────
  let recoveredCmkCount = $state(0);
  let recoveredGskCount = $state(0);

  let handleValid = $derived(validateHandle(handle).ok);
  let composedPhrase = $derived(inputs.map(s => s.trim().toLowerCase()).join(' '));
  let isPhraseComplete = $derived(inputs.every(s => s.trim().length > 0));

  // ── Step 1: Authentifikation ─────────────────────────
  async function doAuth(e) {
    e?.preventDefault();
    if (!handleValid || isAuthing) return;

    isAuthing = true;
    authError = '';
    try {
      const result = await loginWithPasskey(handle, { termsAccepted: consentChecked });
      // Recovery-Login akzeptiert nur "logged_in" (nicht "registered" — User hat schon Account)
      if (result.status !== 'logged_in') {
        authError = lang.recoveryNotRegistered || 'Account nicht gefunden. Recovery braucht einen existierenden Account.';
        // Logout + zurück
        await sessionStore.logout();
        return;
      }
      userStore.setUser(result.handle);
      // Session-State auf AUTHED setzen — sonst bleibt App.showApp false
      // (sessionState === 'anonymous' aus initialem Bootstrap-Check) und
      // nach Modal-Schliessen ist der Screen schwarz.
      await sessionStore.check();
      step = 2;
    } catch (e) {
      const code = e.message?.split(':')[0];
      switch (code) {
        case 'invalid_handle':  authError = lang.handleInvalid || 'Ungültiger Handle'; break;
        case 'user_cancelled':  authError = lang.passkeyCancelled || 'Abgebrochen'; break;
        case 'webauthn_failed': authError = lang.passkeyFailed || 'Passkey-Fehler'; break;
        default:
          authError = lang.loginFailed || 'Login fehlgeschlagen';
          captureException(e, { context: 'recoveryLoginAuth', code });
      }
    } finally {
      isAuthing = false;
    }
  }

  // ── Step 2: Phrase-Eingabe Helpers ───────────────────
  function handleInput(idx, e) {
    const val = e.target.value;
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
    phraseError = '';
  }

  function handleKeydown(idx, e) {
    if (e.key === 'Tab') return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      const next = document.getElementById(`recl-word-${idx + 1}`);
      if (next) next.focus();
      else if (isPhraseComplete) doRecover();
    }
    if (e.key === 'Backspace' && !inputs[idx] && idx > 0) {
      e.preventDefault();
      const prev = document.getElementById(`recl-word-${idx - 1}`);
      if (prev) prev.focus();
    }
  }

  // ── Step 2 → 3: Phrase verifizieren + Bundle decrypten ─
  async function doRecover() {
    if (!isPhraseComplete || isVerifying) return;

    const phrase = composedPhrase;
    if (!validatePhrase(phrase)) {
      phraseError = lang.recoveryInvalidPhrase || 'Phrase ist nicht gültig (BIP39-Fehler).';
      return;
    }

    isVerifying = true;
    phraseError = '';

    try {
      const data = await getBundle();
      if (!data || !data.blob) {
        phraseError = lang.recoveryNoBundle || 'Kein Recovery-Bundle gefunden.';
        return;
      }

      const masterKey = await deriveMasterKey(phrase, data.salt);

      let bundle;
      try {
        bundle = await decryptBundle(data.blob, masterKey);
      } catch {
        attemptsLeft = Math.max(0, attemptsLeft - 1);
        phraseError = attemptsLeft > 0
          ? `${lang.recoveryWrongPhrase || 'Falsch.'} ${attemptsLeft} ${lang.attemptsLeft || 'Versuche übrig'}.`
          : (lang.recoveryCooldown || 'Zu viele falsche Versuche. Versuche es in 1 Stunde erneut.');
        return;
      }

      // Stats
      recoveredCmkCount = Object.keys(bundle.cmks || {}).length;
      recoveredGskCount = Object.keys(bundle.gsks || {}).length;

      // CMKs aus Bundle in IDB importieren (Spec RECOVERY.md §13).
      // Dadurch werden alte Konversationen nach erfolgreichem Recovery
      // wieder lesbar. GSKs folgen mit Phase 1C.
      try {
        const masterKeyBytes = await deriveMasterKeyRaw(phrase, data.salt);
        await cacheMasterKey(masterKeyBytes);
        const restoreRes = await restoreCmksFromBundle(bundle);
        console.log('📥 Recovery-Restore:', {
          v: bundle.v,
          imported: restoreRes.imported,
          skipped: restoreRes.skipped,
          gsks: recoveredGskCount,
          bundleTs: bundle.ts,
        });
      } catch (e) {
        // Restore-Fehler sind non-fatal — User kommt trotzdem in App,
        // alte Convos bleiben dann verschlüsselt bis zum nächsten Recovery-Versuch.
        captureException(e, { context: 'recoveryLoginRestore' });
        console.error('🔓 Recovery decrypt OK aber Restore fehlgeschlagen:', e);
      }

      // Backend als verified markieren
      const r = await markVerified();
      if (!r.ok) {
        if (r.error === 'Too many requests') {
          phraseError = lang.recoveryCooldown || 'Zu viele Versuche.';
          return;
        }
        // Verify-Fehler ist non-fatal — User sieht trotzdem Step 3
        captureException(new Error('markVerified_failed'), { error: r.error });
      }

      step = 3;
    } catch (e) {
      captureException(e, { context: 'recoveryLoginDecrypt' });
      phraseError = (lang.recoveryVerifyFailed || 'Recovery fehlgeschlagen') + ': ' + (e.message || '');
    } finally {
      isVerifying = false;
    }
  }

  function close() {
    isOpen = false;
    onComplete();
  }

  // ESC blocken in Step 1+2 (User muss bewusst durchgehen oder Cancel klicken)
  function onKeydown(e) {
    if (e.key === 'Escape' && step !== 3) e.preventDefault();
  }
  $effect(() => {
    if (isOpen) {
      window.addEventListener('keydown', onKeydown);
      return () => window.removeEventListener('keydown', onKeydown);
    }
  });

  function cancel() {
    isOpen = false;
  }
</script>

{#if isOpen}
  <div class="rl-overlay" role="presentation">
    <div class="rl-dialog" role="dialog" aria-labelledby="rl-title" aria-modal="true">

      {#if step === 1}
        <h3 id="rl-title">🆘 {lang.recoveryLoginTitle || 'Recovery via Phrase'}</h3>
        <p class="rl-intro">
          {lang.recoveryLoginIntroAuth || 'Du hast deine Geräte verloren? Wir stellen deinen Account wieder her. Du brauchst: deinen Handle, einen funktionierenden Passkey (Hardware-Key, anderes Gerät via Bluetooth/QR) und deine 12-Wort-Phrase.'}
        </p>

        <form onsubmit={doAuth} class="rl-form">
          <input
            type="text"
            class="rl-handle"
            class:invalid={handle.length > 0 && !handleValid}
            placeholder={lang.loginPlaceholder || 'Handle (z.B. mark42)'}
            autocomplete="username"
            spellcheck="false"
            autocapitalize="off"
            autocorrect="off"
            bind:value={handle}
            disabled={isAuthing}
          />

          {#if authError}
            <div class="rl-error">{authError}</div>
          {/if}

          <button class="rl-btn-primary" type="submit" disabled={!handleValid || isAuthing}>
            {#if isAuthing}
              <span class="spinner"></span>
              {lang.loginAuthenticating || 'Authentifiziere…'}
            {:else}
              {lang.recoveryLoginAuthBtn || '🔐 Mit Passkey anmelden'}
            {/if}
          </button>

          <button type="button" class="rl-btn-secondary" onclick={cancel} disabled={isAuthing}>
            {lang.cancel || 'Abbrechen'}
          </button>
        </form>

      {:else if step === 2}
        <h3 id="rl-title">🔑 {lang.recoveryLoginPhraseTitle || 'Phrase eingeben'}</h3>
        <p class="rl-intro">
          {lang.recoveryLoginIntroPhrase || 'Authentifizierung erfolgreich. Gib jetzt deine 12-Wort-Phrase ein, um deine Schlüssel wiederherzustellen.'}
        </p>

        <div class="rl-grid">
          {#each inputs as _, i (i)}
            <div class="rl-field">
              <span class="rl-num">{i + 1}</span>
              <input
                id="recl-word-{i}"
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

        {#if phraseError}
          <div class="rl-error">{phraseError}</div>
        {/if}

        <button
          class="rl-btn-primary"
          disabled={!isPhraseComplete || isVerifying || attemptsLeft === 0}
          onclick={doRecover}
        >
          {#if isVerifying}
            <span class="spinner"></span>
            {lang.recoveryDeriving || 'Entschlüssle…'}
          {:else}
            🔓 {lang.recoveryLoginRecoverBtn || 'Wiederherstellen'}
          {/if}
        </button>

      {:else if step === 3}
        <h3 id="rl-title">✅ {lang.recoveryLoginDoneTitle || 'Wiederherstellung erfolgreich'}</h3>
        <p class="rl-intro">
          {lang.recoveryLoginDoneIntro || 'Deine Schlüssel wurden entschlüsselt:'}
        </p>

        <div class="rl-stats">
          <div class="rl-stat">
            <span class="rl-stat-num">{recoveredCmkCount}</span>
            <span class="rl-stat-label">{lang.recoveryStatsCmks || 'DM-Konversationen'}</span>
          </div>
          <div class="rl-stat">
            <span class="rl-stat-num">{recoveredGskCount}</span>
            <span class="rl-stat-label">{lang.recoveryStatsGsks || 'Gruppen'}</span>
          </div>
        </div>

        <div class="rl-todo-warning">
          {lang.recoveryLoginTodoNote || 'Hinweis: Die Wiederherstellung der Nachrichten-Historie auf diesem neuen Browser folgt mit Phase 1A.6 (Svelte-Cutover). Bis dahin: deine Schlüssel sind im Backend gesichert, dein Account ist zugänglich.'}
        </div>

        <button class="rl-btn-primary" onclick={close}>
          {lang.continue || 'Weiter zur App'}
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .rl-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.85);
    z-index: 1300;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }

  .rl-dialog {
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

  .rl-intro {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.5;
    margin-bottom: 20px;
  }

  .rl-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .rl-handle {
    width: 100%;
    padding: 12px 14px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-panel);
    border-radius: 10px;
    color: var(--text-primary);
    font-size: 15px;
    text-align: center;
  }

  .rl-handle:focus {
    border-color: var(--accent-voice);
    outline: none;
  }

  .rl-handle.invalid {
    border-color: var(--status-error);
  }

  .rl-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    margin-bottom: 14px;
  }

  .rl-field {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 4px 6px;
  }

  .rl-field:focus-within {
    border-color: var(--accent-voice);
  }

  .rl-num {
    font-size: 10px;
    color: var(--text-muted);
    min-width: 14px;
    text-align: right;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }

  .rl-field input {
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

  .rl-error {
    padding: 10px 12px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid var(--status-error);
    border-radius: 8px;
    color: var(--status-error);
    font-size: 12px;
  }

  .rl-stats {
    display: flex;
    gap: 12px;
    margin: 16px 0;
  }

  .rl-stat {
    flex: 1;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    padding: 14px;
    text-align: center;
  }

  .rl-stat-num {
    display: block;
    font-size: 28px;
    font-weight: 700;
    color: var(--accent-voice);
    line-height: 1;
    margin-bottom: 4px;
  }

  .rl-stat-label {
    display: block;
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .rl-todo-warning {
    padding: 10px 12px;
    background: rgba(56, 189, 248, 0.06);
    border: 1px solid rgba(56, 189, 248, 0.3);
    border-radius: 8px;
    color: var(--text-secondary);
    font-size: 11px;
    line-height: 1.5;
    margin-bottom: 16px;
  }

  .rl-btn-primary {
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
  }

  .rl-btn-primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .rl-btn-secondary {
    width: 100%;
    background: transparent;
    border: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    padding: 10px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 13px;
    margin-top: 8px;
  }

  .rl-btn-secondary:hover:not(:disabled) {
    border-color: var(--text-secondary);
    color: var(--text-primary);
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
