<!--
  ProfileDropdown — User-Avatar + Dropdown-Menü
  Migration von /renex/index.html (~150 Zeilen Vanilla DOM-Code in inbox.js).

  Features:
   - Avatar-Circle mit Initialen
   - Click toggelt Dropdown
   - Click outside schließt Dropdown
   - Sub-Menüs (Account, Language, Legal)
   - Sprach-Wechsel funktional
   - Legal-Links öffnen in neuem Tab
   - Logout
   - Stubs für: Display-Name, Passkeys, Debug, Delete Account
     (folgen in nächsten Sub-Phasen)
-->
<script>
  import { userStore } from '../stores/user.svelte.js';
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { sessionStore } from '../stores/session.svelte.js';
  import DisplayNameModal from './DisplayNameModal.svelte';
  import PasskeysModal from './PasskeysModal.svelte';
  import DeleteAccountModal from './DeleteAccountModal.svelte';
  import SettingsDevicesPanel from './SettingsDevicesPanel.svelte';
  import DebugOverlay from './DebugOverlay.svelte';
  import { isStandalone, requestInstallPrompt } from '../lib/pwaInstall.js';

  let lang = $derived(i18nStore.lang);

  // Modal-States (lifted up — die Modals selbst werden hier gerendert)
  let showDisplayNameModal = $state(false);
  let showPasskeysModal = $state(false);
  let showDeleteAccountModal = $state(false);
  let showDevicesModal = $state(false);
  let showDebugOverlay = $state(false);
  let myUser = $derived(userStore.myUser);
  let displayName = $derived(userStore.displayName);

  let isOpen = $state(false);
  let openSubmenu = $state(null); // 'account' | 'lang' | 'legal' | null

  // PWA-Install: Menu-Item nur zeigen wenn nicht bereits standalone
  let canInstall = $derived(!isStandalone());

  function handleInstallApp() {
    isOpen = false;
    requestInstallPrompt();
  }

  // Initials aus Handle (oder Display-Name falls vorhanden)
  let initials = $derived.by(() => {
    const src = (displayName || myUser || "?").trim();
    return src
      .split(/[\s._-]+/)
      .map(p => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  });

  function toggle(e) {
    e?.stopPropagation();
    isOpen = !isOpen;
    if (!isOpen) openSubmenu = null;
  }

  function close() {
    isOpen = false;
    openSubmenu = null;
  }

  function toggleSubmenu(name, e) {
    e?.stopPropagation();
    openSubmenu = openSubmenu === name ? null : name;
  }

  function selectLang(code, e) {
    e?.stopPropagation();
    i18nStore.setLang(code);
    close();
  }

  async function handleLogout(e) {
    e?.stopPropagation();
    close();
    await sessionStore.logout();
  }

  function notImplemented(label) {
    alert(`${label} — wird in Phase 1A.6 noch portiert. Verwende vorerst die Vanilla-App.`);
    close();
  }

  // Click-Outside-Handler — global, aber nur wenn Dropdown offen
  function onWindowClick(e) {
    if (!isOpen) return;
    const wrapper = e.target.closest(".profile-wrapper");
    if (!wrapper) close();
  }

  $effect(() => {
    if (isOpen) {
      window.addEventListener("click", onWindowClick);
      return () => window.removeEventListener("click", onWindowClick);
    }
  });

  // ESC schließt
  function onKeydown(e) {
    if (e.key === "Escape" && isOpen) close();
  }

  $effect(() => {
    if (isOpen) {
      window.addEventListener("keydown", onKeydown);
      return () => window.removeEventListener("keydown", onKeydown);
    }
  });
</script>

<div class="profile-wrapper">
  <button
    type="button"
    class="profile-circle"
    class:open={isOpen}
    onclick={toggle}
    aria-label="Profile menu"
    aria-expanded={isOpen}
    aria-haspopup="menu"
  >
    {initials}
  </button>

  {#if isOpen}
    <div class="dropdown" role="menu">
      <!-- Handle / Account Submenu Trigger -->
      <button
        type="button"
        class="dropdown-item has-sub"
        class:active={openSubmenu === 'account'}
        onclick={(e) => toggleSubmenu('account', e)}
      >
        <span class="handle-label">
          {#if displayName}
            {displayName} · @{myUser}
          {:else}
            @{myUser}
          {/if}
        </span>
        <span class="caret">▸</span>
      </button>

      {#if openSubmenu === 'account'}
        <div class="submenu">
          <button
            type="button"
            class="dropdown-item logout"
            onclick={() => { showDeleteAccountModal = true; close(); }}
          >
            {lang.deleteAccount || "Account löschen"}
          </button>
        </div>
      {/if}

      <div class="divider"></div>

      <!-- Display Name -->
      <button
        type="button"
        class="dropdown-item"
        onclick={() => { showDisplayNameModal = true; close(); }}
      >
        {lang.displayNameMenuLabel || "Anzeigename"}
      </button>

      <!-- Passkeys -->
      <button
        type="button"
        class="dropdown-item"
        onclick={() => { showPasskeysModal = true; close(); }}
      >
        {lang.passkeysLabel || "Passkeys"}
      </button>

      <!-- Devices (Multi-Device Management) -->
      <button
        type="button"
        class="dropdown-item"
        onclick={() => { showDevicesModal = true; close(); }}
      >
        {lang.devicesLabel || "Geräte"}
      </button>

      <!-- Debug / Diagnose -->
      <button
        type="button"
        class="dropdown-item"
        onclick={() => { showDebugOverlay = true; close(); }}
      >
        🛠️ {lang.debugLabel || "Debug / Diagnose"}
      </button>

      <div class="divider"></div>

      <!-- Language Submenu -->
      <button
        type="button"
        class="dropdown-item has-sub"
        class:active={openSubmenu === 'lang'}
        onclick={(e) => toggleSubmenu('lang', e)}
      >
        <span>{lang.langToggleLabel || "Sprache"}</span>
        <span class="caret">▸</span>
      </button>

      {#if openSubmenu === 'lang'}
        <div class="submenu">
          {#each i18nStore.supported as code}
            <button
              type="button"
              class="dropdown-item"
              class:current={code === i18nStore.currentLang}
              onclick={(e) => selectLang(code, e)}
            >
              {code === 'de' ? '🇩🇪 DE – Deutsch' : code === 'en' ? '🇬🇧 EN – English' : '🇪🇸 ES – Español'}
              {#if code === i18nStore.currentLang}
                <span class="check">✓</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}

      <div class="divider"></div>

      <!-- Legal Submenu -->
      <button
        type="button"
        class="dropdown-item has-sub"
        class:active={openSubmenu === 'legal'}
        onclick={(e) => toggleSubmenu('legal', e)}
      >
        <span>{lang.legalLabel || "Rechtliches"}</span>
        <span class="caret">▸</span>
      </button>

      {#if openSubmenu === 'legal'}
        <div class="submenu">
          <a href="/impressum/" target="_blank" rel="noopener" class="dropdown-item link">
            {lang.footerImprint || "Impressum"}
          </a>
          <a href="/datenschutz/" target="_blank" rel="noopener" class="dropdown-item link">
            {lang.footerPrivacy || "Datenschutz"}
          </a>
          <a href="/agb/" target="_blank" rel="noopener" class="dropdown-item link">
            {lang.footerTerms || "AGB"}
          </a>
        </div>
      {/if}

      <a href="/feedback/" target="_blank" rel="noopener" class="dropdown-item link">
        💬 {lang.footerFeedback || "Feedback"}
      </a>

      {#if canInstall}
        <button type="button" class="dropdown-item" onclick={handleInstallApp}>
          📲 {lang.pwaInstallMenuItem || "Als App installieren"}
        </button>
      {/if}

      <div class="divider"></div>

      <!-- Logout -->
      <button
        type="button"
        class="dropdown-item logout"
        onclick={handleLogout}
      >
        {lang.logout || "Logout"}
      </button>
    </div>
  {/if}
</div>

<!-- Modals (außerhalb des Wrappers gerendert, damit Click-Outside auf Dropdown
     nicht das Modal schließt) -->
<DisplayNameModal bind:isOpen={showDisplayNameModal} />
<PasskeysModal bind:isOpen={showPasskeysModal} />
<SettingsDevicesPanel bind:isOpen={showDevicesModal} />
<DebugOverlay bind:isOpen={showDebugOverlay} />
<DeleteAccountModal bind:isOpen={showDeleteAccountModal} />

<style>
  .profile-wrapper {
    position: relative;
    display: inline-block;
    z-index: 100;  /* Über dem icon-strip-Stacking-Context */
  }

  .profile-circle {
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    color: var(--text-primary);
    font-weight: 700;
    font-size: 13px;
    cursor: pointer;
    user-select: none;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .profile-circle:hover,
  .profile-circle.open {
    border-color: var(--accent-voice);
    background: var(--accent-voice-dim);
    color: var(--accent-voice);
  }

  /* Dropdown öffnet NACH OBEN (Avatar ist im IconStrip ganz unten).
     Position relative zur .profile-wrapper. left: 0 = öffnet zur rechten Seite. */
  .dropdown {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 0;
    min-width: 240px;
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 12px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    padding: 6px;
    display: flex;
    flex-direction: column;
    z-index: 200;
    animation: dropdown-in 0.15s ease-out;
  }

  @keyframes dropdown-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 9px 12px;
    border-radius: 8px;
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: background 0.1s;
    text-decoration: none;
    width: 100%;
  }

  .dropdown-item:hover,
  .dropdown-item.active {
    background: var(--bg-panel-alt);
  }

  .dropdown-item.current {
    color: var(--accent-voice);
  }

  .dropdown-item.logout {
    color: var(--status-error);
  }

  .dropdown-item.logout:hover {
    background: rgba(239, 68, 68, 0.08);
  }

  .dropdown-item.link {
    color: var(--text-primary);
  }

  .handle-label {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 180px;
  }

  .caret {
    color: var(--text-muted);
    font-size: 10px;
    transition: transform 0.15s;
  }

  .dropdown-item.active .caret {
    transform: rotate(90deg);
    color: var(--accent-voice);
  }

  .check {
    color: var(--accent-voice);
    font-weight: 700;
  }

  .submenu {
    display: flex;
    flex-direction: column;
    margin: 2px 0 2px 12px;
    padding-left: 8px;
    border-left: 2px solid var(--border-subtle);
  }

  .divider {
    height: 1px;
    background: var(--border-subtle);
    margin: 4px 6px;
  }
</style>
