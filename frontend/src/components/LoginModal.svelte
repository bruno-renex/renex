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
  import { renderTurnstile, preloadTurnstileScript } from '../lib/turnstile.js';
  import { isGuestConvertPending, performGuestConvert, clearPendingGuestConvert } from '../lib/guestConvert.js';
  import LandingFeatures from './LandingFeatures.svelte';
  import LandingManifesto from './LandingManifesto.svelte';
  import LandingFooter from './LandingFooter.svelte';
  import PulseLandingCanvas from './PulseLandingCanvas.svelte';

  // Recovery-Login wird im Parent (App.svelte) gerendert, damit das Modal
  // nach Passkey-Auth nicht unmountet (LoginModal selbst verschwindet sobald myUser gesetzt).
  let { onRecoveryClick = () => {} } = $props();

  // Reactive: lang aus Store ableiten
  let lang = $derived(i18nStore.lang);

  // Statement-first Landing (Option B): Hero zeigt zuerst das Brand-Statement +
  // interaktive Pulse-Demo; Login-Card wird per CTA eingeblendet. Bei Guest-
  // Convert (User klickte "Account erstellen") direkt zur Card springen — sonst
  // wäre der erwartete Login-Flow hinter einem extra Klick versteckt.
  let showLogin = $state(isGuestConvertPending());

  // Local state
  let handle = $state("");
  let consentChecked = $state(false);
  let isSubmitting = $state(false);
  let statusMessage = $state("");
  let statusType = $state(""); // "" | "info" | "error" | "success"

  // Turnstile (Anti-Bot bei Neu-Registrierung)
  let turnstileEl = $state(null);
  let cfTurnstileToken = $state(null);
  let _turnstileHandle = null;

  // Derived: handle valid?
  let validation = $derived(validateHandle(handle));
  let canSubmit = $derived(
    validation.ok && consentChecked && !isSubmitting
  );

  // Turnstile-API-Skript schon beim Modal-Open vorladen (im Hintergrund).
  // Render des Widgets bleibt lazy (s.u.) — aber wenn das Skript dann gebraucht
  // wird, ist es bereits im Browser-Cache: spart 300-800 ms beim ersten Render.
  // Idempotent: zweiter Aufruf returnt die existierende Promise.
  $effect(() => {
    void preloadTurnstileScript().catch((e) => {
      captureException(e, { context: 'turnstile.preload' });
    });
  });

  // Turnstile lazy rendern — erst wenn Handle valid + Consent gesetzt.
  // So bleibt das Widget unsichtbar solange der User nicht submitten will.
  // Dank Preload (oben) ist der eigentliche render() dann instant.
  $effect(() => {
    if (!turnstileEl) return;
    let cancelled = false;
    (async () => {
      try {
        const h = await renderTurnstile(turnstileEl, {
          onToken: (t) => { if (!cancelled) cfTurnstileToken = t; },
          onExpired: () => { if (!cancelled) cfTurnstileToken = null; },
          onError: () => { if (!cancelled) cfTurnstileToken = null; },
          theme: 'dark',
        });
        if (cancelled) { h.dispose(); return; }
        _turnstileHandle = h;
      } catch (e) {
        // Turnstile-Load-Fail (z.B. CDN blocked) — Submit klappt dann nur für
        // existing users (login). Neu-Registrierung scheitert mit captcha_required.
        captureException(e, { context: 'turnstile.load' });
      }
    })();
    return () => {
      cancelled = true;
      cfTurnstileToken = null;
      if (_turnstileHandle) { _turnstileHandle.dispose(); _turnstileHandle = null; }
    };
  });

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
        cfTurnstileToken,
      });

      // Erfolg: User-Store updaten + Session prüfen
      userStore.setUser(result.handle);
      setStatus(
        result.status === "registered"
          ? (lang.registerSuccess || "Account erstellt!")
          : (lang.loginSuccess || "Eingeloggt!"),
        "success"
      );

      // Convert-Datenmodell wird in App.svelte $effect verarbeitet (überlebt
      // LoginModal-Unmount). Hier nur: bei Login statt Register obsolete Daten cleanen.
      if (result.status !== "registered" && isGuestConvertPending()) {
        clearPendingGuestConvert();
      }

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
        case "captcha_required":
        case "captcha_failed":
          userMsg = lang.captchaRequired || "Bitte Captcha lösen";
          // Token könnte verbraucht sein — Widget reset für neuen Versuch
          if (_turnstileHandle) {
            try { _turnstileHandle.reset(); cfTurnstileToken = null; } catch {}
          }
          break;
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
  <div class="hero-section">
    <PulseLandingCanvas />

  {#if showLogin}
  <div class="login-card">
    <button
      type="button"
      class="back-link"
      onclick={() => (showLogin = false)}
      disabled={isSubmitting}
    >
      {lang.heroBack || "← Zurück"}
    </button>
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

      <!-- Turnstile-Widget (Anti-Bot bei Neu-Registrierung).
           Lazy: erst rendern wenn Handle valid + AGB akzeptiert (User wird wahrscheinlich submitten).
           Existing-User-Login braucht keinen Token (Backend skipt Verifikation). -->
      {#if validation.ok && consentChecked}
        <div class="turnstile-row" bind:this={turnstileEl}></div>
      {/if}

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

    <!-- Recovery-Link: nur wenn User existing-Account hat aber alle Devices weg -->
    <div class="recovery-row">
      <span class="recovery-divider"></span>
      <button
        type="button"
        class="recovery-link"
        onclick={onRecoveryClick}
        disabled={isSubmitting}
      >
        🆘 {lang.recoveryLoginLink || 'Alle Geräte verloren? Recovery via Phrase'}
      </button>
    </div>

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
  {:else}
    <div class="hero-statement">
      <div class="logo" id="login-title">RENE<span class="x">X</span></div>
      <h1 class="hero-title">
        {lang.heroPrefix || "Du hast einen"}
        <span class="accent">{lang.heroAccent || "Puls"}</span>.<br />
        <span class="line2">{lang.heroLine2 || "Bots nicht."}</span>
      </h1>
      <p class="hero-sub">{lang.heroSub || "Beweg dich — das ist dein Puls."}</p>
      <button type="button" class="hero-cta" onclick={() => (showLogin = true)}>
        {lang.heroCta || "Loslegen →"}
      </button>
      <div class="lang-row">
        {#each i18nStore.supported as code}
          <button
            type="button"
            class="lang-pill"
            class:active={code === i18nStore.currentLang}
            onclick={() => i18nStore.setLang(code)}
          >
            {code === "de" ? "🇩🇪 DE" : code === "en" ? "🇬🇧 EN" : "🇪🇸 ES"}
          </button>
        {/each}
      </div>
    </div>
  {/if}
  </div>

  <!-- Marketing-Sections (scrollen unter dem Hero) -->
  <LandingFeatures />
  <LandingManifesto />
  <LandingFooter />
</div>


<style>
  .login-modal {
    position: fixed;
    inset: 0;
    background: var(--bg-body);
    display: flex;
    flex-direction: column;
    align-items: stretch;
    z-index: 1000;
    /* Safe-area-aware: oben nicht hinter Notch, unten nicht hinter Home-Indicator. */
    padding: max(20px, var(--safe-top)) max(20px, var(--safe-right)) max(20px, var(--safe-bottom)) max(20px, var(--safe-left));
    overflow-y: auto;
  }

  /* Hero-Section: Login-Card zentriert im 1. Viewport. Marketing scrollt drunter.
     position: relative für Particles-Canvas (absolute drin). */
  .hero-section {
    position: relative;
    min-height: 100vh;
    min-height: 100dvh;
    /* Safe-Area + 40px (modal padding top+bottom) abziehen — Card bleibt vertikal zentriert */
    min-height: calc(100dvh - max(20px, var(--safe-top)) - max(20px, var(--safe-bottom)));
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
  }

  /* Login-Card über dem Particles-Canvas (z-index: 0). */
  .hero-section :global(.login-card) {
    position: relative;
    z-index: 1;
  }

  /* ── Statement-first Hero (Option B) ───────────────── */
  .hero-statement {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 640px;
    padding: 0 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 22px;
    animation: statement-in 0.5s ease-out;
  }

  @keyframes statement-in {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .hero-title {
    font-size: clamp(34px, 8vw, 62px);
    font-weight: 800;
    line-height: 1.04;
    letter-spacing: -0.02em;
    color: var(--text-primary);
    margin: 0;
  }

  .hero-title .accent {
    color: var(--accent-voice);
    text-shadow: 0 0 28px rgba(56, 189, 248, 0.55);
  }

  .hero-title .line2 {
    color: var(--text-muted);
  }

  .hero-sub {
    font-size: 15px;
    color: var(--text-secondary);
    line-height: 1.6;
    max-width: 460px;
    margin: 0 auto;
  }

  .hero-cta {
    padding: 14px 34px;
    background: var(--accent-voice);
    color: #07070a;
    border: none;
    border-radius: 12px;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.02em;
    cursor: pointer;
    box-shadow: 0 8px 28px rgba(56, 189, 248, 0.28);
    transition: background 0.15s, transform 0.1s, box-shadow 0.15s;
  }

  .hero-cta:hover {
    background: #0ea5e9;
    box-shadow: 0 10px 34px rgba(56, 189, 248, 0.4);
  }

  .hero-cta:active {
    transform: scale(0.98);
  }

  .back-link {
    align-self: flex-start;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
    padding: 2px 4px;
    margin-bottom: -8px;
    transition: color 0.15s;
  }

  .back-link:hover:not(:disabled) {
    color: var(--text-secondary);
  }

  .back-link:disabled {
    opacity: 0.4;
    cursor: not-allowed;
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

  .turnstile-row {
    display: flex;
    justify-content: center;
    min-height: 65px; /* reserviert Platz, vermeidet Layout-Sprung beim Lazy-Load */
  }

  .status-info    { color: var(--text-muted); }
  .status-success { color: var(--status-success); }
  .status-error   { color: var(--status-error); }

  .recovery-row {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }

  .recovery-divider {
    width: 60%;
    height: 1px;
    background: var(--border-subtle);
  }

  .recovery-link {
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 11px;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 4px;
    transition: color 0.15s;
  }

  .recovery-link:hover:not(:disabled) {
    color: var(--text-secondary);
  }

  .recovery-link:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

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
