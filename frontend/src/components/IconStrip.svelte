<!--
  IconStrip — Linke Navigations-Spalte mit Sektion-Icons
  Migration von /renex/index.html .icon-strip
-->
<script>
  import { inboxStore } from '../stores/inbox.svelte.js';
  import ProfileDropdown from './ProfileDropdown.svelte';
  import { serverStore } from '../stores/serverStore.svelte.js';
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { orgStore, requestOpenInvite } from '../stores/org.svelte.js';

  let lang = $derived(i18nStore.lang);
  let activeSection = $derived(inboxStore.activeSection);

  // eGov 1.1: verifizierte Org? → globaler "Bürger einladen"-Einstieg unten.
  // Einmal-Probe beim Mount; für Consumer bleibt isOrg false (Icon versteckt).
  $effect(() => { void orgStore.ensureProbed(); });
  let isOrg = $derived(orgStore.isOrg);
  let unreadDms = $derived(inboxStore.totalUnreadDms);
  let unreadGroups = $derived(inboxStore.totalUnreadGroups);
  let missedVoice = $derived(inboxStore.missedUnseenVoice);
  let unreadServers = $derived(serverStore.totalServersUnread);

  function selectSection(name) {
    inboxStore.setSection(name);
  }

  // Server-Liste (inkl. Unread pro Server) initial laden + bei jeder Unread-Änderung
  // debounced neu ziehen → der Punkt am Servers-Tab + pro Server aktualisiert sich
  // ~live. loadServers ändert nur _servers, nicht unreadCounts → kein Loop.
  let _srvRefreshTimer = null;
  $effect(() => {
    void inboxStore.unreadCounts;   // Abhängigkeit: reagiert auf jede Unread-Änderung
    clearTimeout(_srvRefreshTimer);
    _srvRefreshTimer = setTimeout(() => { void serverStore.loadServers(); }, 1200);
    return () => clearTimeout(_srvRefreshTimer);
  });
</script>

<nav class="icon-strip" aria-label="Sections">
  <div class="strip-brand">RENE<span class="x">X</span></div>

  <div class="strip-icons-top">
    <button
      class="strip-icon"
      class:active={activeSection === 'chats'}
      onclick={() => selectSection('chats')}
      title="Messages"
      aria-label="Messages"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      {#if unreadDms > 0}
        <span class="strip-badge">{unreadDms > 99 ? '99+' : unreadDms}</span>
      {/if}
    </button>

    <button
      class="strip-icon"
      class:active={activeSection === 'groups'}
      onclick={() => selectSection('groups')}
      title="Groups"
      aria-label="Groups"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
      {#if unreadGroups > 0}
        <span class="strip-badge">{unreadGroups > 99 ? '99+' : unreadGroups}</span>
      {/if}
    </button>

    <button
      class="strip-icon"
      class:active={activeSection === 'voice'}
      onclick={() => selectSection('voice')}
      title="Voice"
      aria-label="Voice"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
      </svg>
      {#if missedVoice > 0}
        <span class="strip-badge">{missedVoice > 99 ? '99+' : missedVoice}</span>
      {/if}
    </button>

    <button
      class="strip-icon"
      class:active={activeSection === 'servers'}
      onclick={() => selectSection('servers')}
      title="Servers"
      aria-label="Servers"
    >
      <!-- Server-Stack-Icon (3 gestapelte Rechtecke = symbolisch für Server/Channels) -->
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="2" width="20" height="6" rx="1"/>
        <rect x="2" y="9" width="20" height="6" rx="1"/>
        <rect x="2" y="16" width="20" height="6" rx="1"/>
        <line x1="6" y1="5" x2="6.01" y2="5"/>
        <line x1="6" y1="12" x2="6.01" y2="12"/>
        <line x1="6" y1="19" x2="6.01" y2="19"/>
      </svg>
      {#if unreadServers > 0}
        <span class="strip-dot" aria-label="ungelesene Channel-Nachrichten"></span>
      {/if}
    </button>
  </div>

  <div class="strip-icons-bottom">
    {#if isOrg}
      <!-- eGov 1.1: Aktion (kein Tab!) — Modal öffnen via Event, nicht selectSection.
           Bewusst im Bottom-Cluster (Aktions-Zone neben Profil), NICHT zwischen
           den Ansichts-Tabs, und nur für verifizierte Orgs sichtbar. -->
      <button
        class="strip-icon strip-invite"
        onclick={() => requestOpenInvite()}
        title={lang.inviteCitizenTitle || 'Bürger einladen'}
        aria-label={lang.inviteCitizenTitle || 'Bürger einladen'}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/>
          <polyline points="22 6 12 13 2 6"/>
        </svg>
      </button>
    {/if}
    <ProfileDropdown />
  </div>
</nav>

<style>
  .icon-strip {
    width: 64px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    /* Top: safe-area-inset für Notch. Bottom: home-indicator-Inset.
       padding-left wächst in Landscape (iPhone Notch links). */
    padding: max(14px, var(--safe-top)) 0 max(12px, var(--safe-bottom)) var(--safe-left);
    border-right: 1px solid var(--border-panel);
    background: var(--bg-panel);
    gap: 2px;
    z-index: 10;
  }

  .strip-brand {
    font-size: 13px;
    font-weight: 800;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--text-primary);
    user-select: none;
    margin-bottom: 18px;
  }

  .strip-brand .x {
    color: var(--accent-voice);
    text-shadow: 0 0 8px rgba(56, 189, 248, 0.7);
  }

  .strip-icons-top {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    flex: 1;
  }

  .strip-icon {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s, color 0.15s;
    position: relative;
    flex-shrink: 0;
  }

  .strip-icon:hover {
    background: rgba(255, 255, 255, 0.05);
    color: var(--text-secondary);
  }

  .strip-icon.active {
    background: var(--accent-voice-dim);
    color: var(--accent-voice);
  }

  /* Invite = Aktion, kein Tab: dezent akzentuiert, nie Active-State.
     Optisch von den Ansichts-Tabs abgesetzt (Accent-Farbe + Rahmen). */
  .strip-invite {
    color: var(--accent-voice);
    border: 1px solid var(--accent-voice-dim, rgba(56, 189, 248, 0.25));
    margin-bottom: 6px;
  }
  .strip-invite:hover {
    background: var(--accent-voice-dim, rgba(56, 189, 248, 0.15));
    color: var(--accent-voice);
  }

  .strip-icon.active::before {
    content: '';
    position: absolute;
    left: -1px;
    top: 50%;
    transform: translateY(-50%);
    width: 3px;
    height: 24px;
    background: var(--accent-voice);
    border-radius: 0 3px 3px 0;
  }

  .strip-dot {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--accent-voice);
    box-shadow: 0 0 0 2px var(--bg-panel);
  }

  .strip-badge {
    position: absolute;
    top: 4px;
    right: 4px;
    min-width: 16px;
    height: 16px;
    border-radius: 999px;
    background: var(--accent-voice);
    color: #07070A;
    font-size: 10px;
    font-weight: 800;
    border: 2px solid var(--bg-panel);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 4px;
    line-height: 1;
    box-sizing: border-box;
  }

  .strip-icons-bottom {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding-top: 8px;
  }
</style>
