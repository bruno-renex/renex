<!--
  LoginModal — Erste interaktive Komponente in Svelte 5.
  Migration von /renex/index.html #login-modal (~600 Zeilen Vanilla).
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { userStore } from '../stores/user.svelte.js';
  import { sessionStore } from '../stores/session.svelte.js';
  import { loginWithPasskey, validateHandle } from '../lib/passkey.js';
  import { captureException } from '../lib/sentry.js';

  // Reactive: lang aus Store ableiten
  let lang = $derived(i18nStore.lang);

  // Local state
  let handle = $state("");
  let consentChecked = $state(false);
  let isSubmitting = $state(false);
  let statusMessage = $state("");
  let statusType = $state(""); // "" | "info" | "error" | "success"

  // Derived: handle valid?
  let validation = $derived(validateHandle(handle));
  let canSubmit = $derived(
    validation.ok && consentChecked && !isSubmitting
  );

  function setStatus(message, type = "info") {
    statusMessage = message;
    statusType = type;
  }

  function clearStatus() {
    statusMessage = "";
    statusType = "";
  }

  async function onSubmit(e) {
    e?.preventDefault();
    if (!canSubmit) return;
    isSubmitting = true;
    clearStatus();

    try {
      setStatus(lang.loginAuthenticating || "Authentifiziere…", "info");
      const result = await loginWithPasskey(handle, {
        termsAccepted: consentChecked,
      });

      // Erfolg: User-Store updaten + Session prüfen
      userStore.setUser(result.handle);
      setStatus(
        result.status === "registered"
          ? (lang.registerSuccess || "Account erstellt!")
          : (lang.loginSuccess || "Eingeloggt!"),
        "success"
      );

      // Session re-check (setzt korrekten State)
      await sessionStore.check();
    } catch (e) {
      const code = e.message.split(":")[0];
      let userMsg;
      switch (code) {
        case "invalid_handle":  userMsg = lang.handleInvalid || "Ungültiger Handle"; break;
        case "terms_required":  userMsg = lang.consentRequired || "AGB akzeptieren"; break;
        case "user_cancelled":  userMsg = lang.passkeyCancelled || "Abgebrochen"; break;
        case "webauthn_failed": userMsg = lang.passkeyFailed || "Passkey-Fehler"; break;
        default:
          userMsg = lang.loginFailed || "Login fehlgeschlagen";
          captureException(e, { handle, code });
      }
      setStatus(userMsg, "error");
    } finally {
      isSubmitting = false;
    }
  }

  function onKeydown(e) {
    if (e.key === "Enter" && canSubmit) onSubmit();
  }
</script>

<div class="login-modal" role="dialog" aria-labelledby="login-title">
  <div class="login-card">
    <div class="logo-wrap">
      <div class="logo" id="login-title">RENE<span class="x">X</span></div>
      <p class="slogan">{lang.loginSlogan || "You are the key."}</p>
    </div>

    <form class="form" onsubmit={onSubmit}>
      <input
        type="text"
        class="handle-input"
        class:invalid={handle.length > 0 && !validation.ok}
        placeholder={lang.loginPlaceholder || "Name"}
        autocomplete="username"
        spellcheck="false"
        autocapitalize="off"
        autocorrect="off"
        bind:value={handle}
        onkeydown={onKeydown}
        disabled={isSubmitting}
      />

      <label class="consent">
        <input
          type="checkbox"
          bind:checked={consentChecked}
          disabled={isSubmitting}
        />
        <span class="consent-text">
          {lang.consentPrefix || "Ich akzeptiere die"}
          <a href="/agb/" target="_blank" rel="noopener">{lang.consentTerms || "AGB"}</a>
          {lang.consentAnd || "und"}
          <a href="/datenschutz/" target="_blank" rel="noopener">{lang.consentPrivacy || "Datenschutzerklärung"}</a>{lang.consentSuffix || "."}
        </span>
      </label>

      <button
        type="submit"
        class="login-btn"
        disabled={!canSubmit}
      >
        {#if isSubmitting}
          <span class="spinner"></span>
          {lang.loginAuthenticating || "Authentifiziere…"}
        {:else}
          {lang.loginBtn || "Login mit Passkey"}
        {/if}
      </button>

      {#if statusMessage}
        <span class="status status-{statusType}">{statusMessage}</span>
      {/if}
    </form>

    <div class="lang-row">
      {#each i18nStore.supported as code}
        <button
          type="button"
          class="lang-pill"
          class:active={code === i18nStore.currentLang}
          onclick={() => i18nStore.setLang(code)}
          disabled={isSubmitting}
        >
          {code === "de" ? "🇩🇪 DE" : code === "en" ? "🇬🇧 EN" : "🇪🇸 ES"}
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .login-modal {
    position: fixed;
    inset: 0;
    background: var(--bg-body);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 20px;
    overflow-y: auto;
  }

  .login-card {
    width: 100%;
    max-width: 380px;
    padding: 32px 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
  }

  .logo-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .logo {
    font-size: 56px;
    font-weight: 800;
    letter-spacing: 0.18em;
    user-select: none;
    color: var(--text-primary);
  }

  .logo .x {
    color: var(--accent-voice);
    text-shadow: 0 0 24px rgba(56, 189, 248, 0.6);
  }

  .slogan {
    font-size: 12px;
    letter-spacing: 0.3em;
    color: var(--text-secondary);
    text-transform: uppercase;
    font-weight: 600;
  }

  .form {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .handle-input {
    width: 100%;
    padding: 12px 14px;
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 10px;
    color: var(--text-primary);
    font-size: 15px;
    text-align: center;
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .handle-input:focus {
    border-color: var(--accent-voice);
    box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.15);
  }

  .handle-input.invalid {
    border-color: var(--status-error);
  }

  .handle-input::placeholder {
    color: var(--text-muted);
  }

  .consent {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    font-size: 12px;
    color: var(--text-secondary);
    line-height: 1.5;
    cursor: pointer;
    user-select: none;
  }

  .consent input[type="checkbox"] {
    margin-top: 2px;
    accent-color: var(--accent-voice);
    cursor: pointer;
    flex-shrink: 0;
  }

  .consent a {
    color: var(--accent-voice);
    text-decoration: underline;
  }

  .consent a:hover {
    text-decoration: none;
  }

  .login-btn {
    width: 100%;
    padding: 13px;
    background: var(--accent-voice);
    color: #07070a;
    border: none;
    border-radius: 10px;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.02em;
    cursor: pointer;
    transition: background 0.15s, transform 0.1s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  .login-btn:hover:not(:disabled) {
    background: #0ea5e9;
  }

  .login-btn:active:not(:disabled) {
    transform: scale(0.98);
  }

  .login-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(7, 7, 10, 0.2);
    border-top-color: #07070a;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .status {
    text-align: center;
    font-size: 12px;
    min-height: 18px;
  }

  .status-info    { color: var(--text-muted); }
  .status-success { color: var(--status-success); }
  .status-error   { color: var(--status-error); }

  .lang-row {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }

  .lang-pill {
    padding: 6px 12px;
    border-radius: 20px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-panel-alt);
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
    transition: all 0.15s;
  }

  .lang-pill:hover:not(:disabled) {
    background: rgba(56, 189, 248, 0.1);
    color: var(--text-primary);
  }

  .lang-pill.active {
    background: var(--accent-voice-dim);
    color: var(--accent-voice);
    border-color: var(--accent-voice);
  }
</style>
