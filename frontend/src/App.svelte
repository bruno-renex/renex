<!--
  RENEX — Root App Component (Svelte 5 + Runes)
  Phase 1A.6 Migration in progress.

  Layout (Desktop):
   ┌──────┬──────────────┬─────────────────────────┐
   │ Icon │ Inbox-List   │ Chat-View                │
   │ Strip│ (DMs/Groups/ │ (kommt in nächster       │
   │ 64px │  Voice)      │  Sub-Phase)              │
   │      │ 300px        │ flex                     │
   └──────┴──────────────┴─────────────────────────┘
-->
<script>
  import { userStore } from './stores/user.svelte.js';
  import { i18nStore } from './stores/i18n.svelte.js';
  import { sessionStore } from './stores/session.svelte.js';
  import { inboxStore } from './stores/inbox.svelte.js';
  import { chatStore } from './stores/chat.svelte.js';
  import { voiceStore } from './stores/voice.svelte.js';
  import { ws } from './lib/ws.js';
  import LoginModal from './components/LoginModal.svelte';
  import IconStrip from './components/IconStrip.svelte';
  import InboxList from './components/InboxList.svelte';
  import ChatView from './components/ChatView.svelte';
  import VoiceCallOverlay from './components/VoiceCallOverlay.svelte';

  let sessionState = $derived(sessionStore.state);
  let myUser = $derived(userStore.myUser);

  // Show/hide logic
  let showApp     = $derived(!!myUser && (sessionState === 'authed' || sessionState === 'guest' || sessionState === 'checking' || sessionState === 'idle'));
  let showLogin   = $derived(!myUser && (sessionState === 'anonymous' || sessionState === 'idle' || sessionState === 'checking'));

  // ── WebSocket + Initial Data Loads (when authenticated) ──
  let _bootstrapped = $state(false);

  $effect(() => {
    if (myUser && !_bootstrapped) {
      _bootstrapped = true;
      _bootstrapApp();
    } else if (!myUser && _bootstrapped) {
      _bootstrapped = false;
      _teardownApp();
    }
  });

  async function _bootstrapApp() {
    // Initial Data parallel laden (Errors silent — App-Boot darf nicht blockieren)
    Promise.allSettled([
      inboxStore.loadContacts(),
      inboxStore.loadGroups(),
      inboxStore.loadUnread(),
      voiceStore.loadHistory(),
    ]);

    // WebSocket starten
    ws.start();

    // WS-Listener: incoming messages → chatStore
    ws.on("message", (msg) => {
      if (!msg.type || msg.type === "message") {
        chatStore.receiveMessage(msg);
      }
    });
  }

  function _teardownApp() {
    ws.stop();
    chatStore.clear();
  }
</script>

{#if showLogin}
  <LoginModal />
{:else if showApp}
  <div class="app" class:chat-open={!!chatStore.selectedChat}>
    <IconStrip />
    <InboxList />
    <ChatView />
  </div>
{/if}

<!-- Voice-Call-Overlay (global, über allem) -->
<VoiceCallOverlay />

<style>
  .app {
    flex: 1;
    display: flex;
    height: 100vh;
    height: 100dvh;
    overflow: hidden;
  }

  /* Mobile: Chat-View overlay-style wenn offen */
  @media (max-width: 768px) {
    .app.chat-open :global(.panel-list),
    .app.chat-open :global(.icon-strip) {
      display: none;
    }
    .app:not(.chat-open) :global(.chat-view) {
      display: none;
    }
  }
</style>
