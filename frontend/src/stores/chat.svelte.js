// ======================================================
// Chat Store — Selected Chat + Messages (Reactive)
// ======================================================
// Phase 1A.6 Skeleton:
//   - selectedChat: { type: "dm" | "group", key, name, ... }
//   - messages: Liste von Messages für aktuellen Chat
//   - isTyping (optional, für Future)
//
// Real WebSocket-Integration + E2E-Decrypt folgen in Phase 1B
// (parallel zur CMK-Multi-Device-Migration).
// ======================================================

import { apiFetch } from '../lib/api.js';
import { userStore } from './user.svelte.js';
import { captureException } from '../lib/sentry.js';

let _selectedChat = $state(null); // { type, key, name, peer? }
let _messages = $state([]);       // Array of { id, from, ts, text, status, isMe, ... }
let _isLoading = $state(false);
let _draftText = $state("");

// Drafts pro Chat persistieren (im memory, später localStorage)
const _drafts = new Map();

export const chatStore = {
  get selectedChat() { return _selectedChat; },
  get messages() { return _messages; },
  get isLoading() { return _isLoading; },
  get draftText() { return _draftText; },

  /**
   * Wählt einen Chat aus.
   * @param {object} chat - { type: "dm"|"group", key: string, name: string, peer?: string }
   */
  async selectChat(chat) {
    // Save current draft before switching
    if (_selectedChat) {
      _drafts.set(_selectedChat.key, _draftText);
    }

    _selectedChat = chat;
    _draftText = chat ? (_drafts.get(chat.key) || "") : "";
    _messages = [];

    if (!chat) return;

    // Load messages from API
    // Phase 1A.6.5: real fetch, NO E2E-decrypt yet (Phase 1B)
    // Encrypted messages (e2e=true) zeigen Placeholder bis Phase 1B.
    _isLoading = true;
    try {
      const peerOrConvo = chat.type === "dm" ? (chat.peer || chat.key) : chat.key;
      const r = await apiFetch(`/chat/list?with=${encodeURIComponent(peerOrConvo)}`);
      if (r.ok && Array.isArray(r.data?.messages)) {
        const myHandle = userStore.myUser;
        _messages = r.data.messages.map(m => _normalizeMessage(m, myHandle));
      } else {
        _messages = [];
      }
    } catch (e) {
      captureException(e, { context: "loadChatHistory" });
      _messages = [];
    } finally {
      _isLoading = false;
    }
  },

  setDraft(text) {
    _draftText = text || "";
  },

  /**
   * Real send via /chat/send API.
   * Phase 1A.6.5: Plaintext send (no E2E yet).
   * Phase 1B: E2E-Encrypt + multi-device payloads.
   */
  async sendMessage(text) {
    if (!_selectedChat || !text.trim()) return;

    const myHandle = userStore.myUser || "me";
    const trimmed = text.trim();
    const tempId = crypto.randomUUID();

    // Optimistic UI: Message sofort anzeigen mit "sending"-Status
    const optimisticMsg = {
      id: tempId,
      from: myHandle,
      ts: Date.now(),
      text: trimmed,
      status: "sending",
      isMe: true,
      _isOptimistic: true,
    };
    _messages = [..._messages, optimisticMsg];
    _draftText = "";
    _drafts.delete(_selectedChat.key);

    // Real send via API
    const isGroup = _selectedChat.type === "group";
    const payload = isGroup
      ? { to: myHandle, convoId: _selectedChat.key, message: trimmed }
      : { to: _selectedChat.peer || _selectedChat.key, message: trimmed };

    try {
      const r = await apiFetch("/chat/send", {
        method: "POST",
        body: payload,
      });

      if (r.ok && r.data?.message) {
        // Replace optimistic msg with server-confirmed
        const serverMsg = _normalizeMessage(r.data.message, myHandle);
        _messages = _messages.map(m => m.id === tempId ? { ...serverMsg, status: "sent" } : m);
      } else {
        _messages = _messages.map(m =>
          m.id === tempId ? { ...m, status: "failed" } : m
        );
      }
    } catch (e) {
      captureException(e, { context: "sendMessage" });
      _messages = _messages.map(m =>
        m.id === tempId ? { ...m, status: "failed" } : m
      );
    }
  },

  /**
   * Inject incoming message from WS-handler or test-mocks.
   * Filters: nur Messages für aktuell-selected Chat in messages-Liste anhängen.
   */
  receiveMessage(rawMsg) {
    const myHandle = userStore.myUser;
    const msg = _normalizeMessage(rawMsg, myHandle);

    // Echo-Schutz: eigene Messages nicht doppelt einfügen (kommen via /chat/send Response)
    if (msg.isMe && _messages.some(m => m.id === msg.id)) return;

    if (!_selectedChat) return;

    // Match-Check: gehört Message zum aktuellen Chat?
    const isForCurrentChat =
      (_selectedChat.type === "dm"   && (msg.from === _selectedChat.peer || msg.to === _selectedChat.peer)) ||
      (_selectedChat.type === "group" && rawMsg.groupId === _selectedChat.key);

    if (isForCurrentChat) {
      _messages = [..._messages, msg];
    }
  },

  clear() {
    _selectedChat = null;
    _messages = [];
    _draftText = "";
    _drafts.clear();
  },
};

// ── Helpers ─────────────────────────────────────────────
/**
 * Backend-Message → Frontend-Message normalisieren.
 * Phase 1A.6.5: nur Plaintext + e2e=false. E2E-Decrypt folgt Phase 1B.
 */
function _normalizeMessage(m, myHandle) {
  const isMe = (m.from || m.from_user) === myHandle;
  const text = m.e2e
    ? "🔐 [E2E — Phase 1B]"  // Placeholder bis Decrypt-Implementation
    : (m.message || m.text || "");

  return {
    id: m.id,
    from: m.from || m.from_user,
    to: m.to || m.to_user,
    ts: m.ts || m.created_at || Date.now(),
    text,
    status: m.status || (isMe ? "sent" : "delivered"),
    isMe,
    type: m.type || null,
    e2e: !!m.e2e,
    replyTo: m.reply_to_id ? {
      from: m.reply_from,
      text: m.e2e ? "🔐" : (m.reply_message || ""),
    } : undefined,
    attachment: m.attachment_key ? {
      type: m.attachment_type,
      key: m.attachment_key,
    } : undefined,
  };
}
