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
import {
  decryptIncomingMessage, sendEncryptedDm,
  ensureSecureDmSession, clearChatPipelineCaches,
  sendCmkRequest,
  editEncryptedDm, decryptEditedMessage,
  invalidateDecryptCacheFor,
  sendEncryptedGroup, decryptIncomingGroupMessage,
  editEncryptedGroup, decryptEditedGroupMessage,
} from '../lib/chatPipeline.js';
import { inboxStore } from './inbox.svelte.js';
import { getCMKIfExists } from '../lib/cmk.js';
import { isGuestHandle } from '../lib/guestNames.js';
import { stripFormatting } from '../lib/messageFormat.js';
import { unwrapAttachmentPlaintext } from '../lib/attachmentCrypto.js';
import { shadowOnReceive } from '../lib/ratchetShadow.js';
import {
  isPendingCmkReq, markPendingCmkReq, clearPendingCmkReq,
  isCmkUnavailable, markCmkUnavailable, clearCmkUnavailable, clearAllCmkState,
} from '../lib/cmkRequestState.js';

let _selectedChat = $state(null); // { type, key, name, peer? }
let _messages = $state([]);       // Array of { id, from, ts, text, status, isMe, ... }
let _isLoading = $state(false);
let _draftText = $state("");
let _replyingTo = $state(null);   // { id, from, text } — aktive Quote-Reply, null = kein Reply
let _editingMsg = $state(null);   // { id, originalText } — aktive Edit-Session, null = nicht im Edit-Mode
let _pendingJumpTo = $state(null); // msgId — wird von ChatView via $effect konsumiert (scroll+highlight)

// Drafts pro Chat persistieren (im memory, später localStorage)
const _drafts = new Map();

// Member-Liste pro Group cachen (für GSK-Distribution beim Send).
// Invalidiert bei group_member_joined / group_member_left / group_member_removed.
const _groupMemberCache = new Map();
async function _loadGroupMembers(groupId) {
  try {
    const r = await apiFetch(`/groups/members?groupId=${encodeURIComponent(groupId)}`);
    if (r.ok && Array.isArray(r.data?.members)) {
      const handles = r.data.members.map(m => String(m.member_handle || '').toLowerCase()).filter(Boolean);
      _groupMemberCache.set(groupId, handles);
      return handles;
    }
  } catch (e) {
    captureException(e, { context: 'loadGroupMembers', groupId });
  }
  return [];
}
function _invalidateGroupMembers(groupId) {
  if (groupId) _groupMemberCache.delete(groupId);
}

export const chatStore = {
  get selectedChat() { return _selectedChat; },
  get messages() { return _messages; },
  get isLoading() { return _isLoading; },
  get draftText() { return _draftText; },
  get replyingTo() { return _replyingTo; },
  get editingMsg() { return _editingMsg; },
  get pendingJumpTo() { return _pendingJumpTo; },

  clearPendingJump() { _pendingJumpTo = null; },

  /**
   * Wie selectChat, aber merkt sich eine Message-ID auf die ChatView danach
   * scrollen soll (smooth + jump-highlight). Use-Case: Click auf Reaktions-Toast
   * → öffne Chat + springe zur reagierten Nachricht. ChatView's $effect picks
   * pendingJumpTo + messages.length auf und sucht das Bubble-Element im DOM
   * sobald gerendert.
   */
  async selectChatAndJump(chat, msgId) {
    _pendingJumpTo = msgId || null;
    await this.selectChat(chat);
  },

  /**
   * Startet eine Edit-Session: ChatInput öffnet sich mit dem Original-Text vorbefüllt.
   * Pre-Conditions: nur eigene, fertig-decryptete, nicht-failed Messages.
   * 15-Minuten-Window wird vom Backend erzwungen — wir lassen Edit lokal trotzdem zu
   * und zeigen den Server-Error wenn er kommt (UX besser als pre-emptive Disable
   * mit unklarem Tooltip).
   */
  setEditing(msg) {
    if (!msg || !msg.id || !msg.isMe) { _editingMsg = null; return; }
    if (msg.text === '🔐 …' || msg._unrecoverable) return;
    if (msg.status === 'sending' || msg.status === 'failed') return;
    _editingMsg = { id: msg.id, originalText: msg.text };
    _replyingTo = null;  // Edit + Reply schließen sich aus
  },
  clearEditing() { _editingMsg = null; },

  /**
   * Führt den Edit aus: encrypted neuen Plaintext mit der mk der Original-Message
   * + ruft `/chat/message/edit`. Optimistic-Patch der lokalen Message.
   */
  async editMessage(msgId, newText) {
    if (!_selectedChat || !msgId || !newText.trim()) return { ok: false };
    const trimmed = newText.trim();
    const m = _messages.find(x => x.id === msgId);
    if (!m || !m.isMe) return { ok: false, error: 'not_own' };
    const myHandle = userStore.myUser;
    let result;
    if (_selectedChat.type === 'group' || _selectedChat.type === 'channel') {
      // Original-Row mitgeben für Archive-Lookup (GSK-Rotation 15min-Window).
      // Channel nutzt dieselbe GSK-Edit-Pipeline (channel-agnostisch).
      result = await editEncryptedGroup(myHandle, _selectedChat.key, msgId, trimmed, m._raw || m);
    } else {
      const peer = _selectedChat.peer;
      result = await editEncryptedDm(myHandle, peer, m._raw || m, msgId, trimmed);
    }
    if (result.ok) {
      _patchMessage(msgId, { text: trimmed, edited: true, editedAt: Date.now() });
    }
    return result;
  },

  /**
   * Löscht eine eigene Message (DELETE /chat/message/delete) + entfernt sie
   * optimistic aus der Liste. Backend broadcastet `message_deleted` an Peer/Group.
   */
  async deleteMessage(msgId) {
    if (!msgId) return { ok: false };
    const m = _messages.find(x => x.id === msgId);
    if (!m || !m.isMe) return { ok: false, error: 'not_own' };
    // Optimistic: aus UI entfernen
    const before = _messages;
    _messages = _messages.filter(x => x.id !== msgId);
    try {
      const r = await apiFetch('/chat/message/delete', {
        method: 'POST',
        body: { id: msgId },
      });
      if (!r.ok) {
        // Rollback bei Fehler
        _messages = before;
        return { ok: false, error: r.error };
      }
      return { ok: true };
    } catch (e) {
      _messages = before;
      captureException(e, { context: 'deleteMessage' });
      return { ok: false, error: e?.message };
    }
  },

  /**
   * WS-Handler: peer hat eine Message bei sich gelöscht → bei uns ebenfalls entfernen.
   */
  handleMessageDeleted(event) {
    const id = event?.messageId;
    if (!id) return;
    if (!_messages.some(x => x.id === id)) return;
    _messages = _messages.filter(x => x.id !== id);
  },

  /**
   * Toggle Reaction auf eine Message. Backend liefert vollen reactions-Snapshot zurück
   * + broadcastet `reaction_updated` an die Beteiligten. Wir patchen optimistic NICHT
   * (Toggle-Logic wäre fragil) — warten auf Response, das ist schnell genug.
   */
  async toggleReaction(msgId, emoji) {
    if (!msgId || !emoji) return { ok: false };
    const r = await apiFetch('/chat/react', {
      method: 'POST',
      body: { messageId: msgId, emoji },
    });
    if (r.ok && r.data?.reactions) {
      _patchMessage(msgId, { reactions: r.data.reactions });
    }
    return r;
  },

  /**
   * WS-Handler: jemand (peer/group-member) hat reagiert oder seine Reaktion entfernt.
   * Event hat den vollen reactions-Snapshot — einfach lokal überschreiben.
   */
  handleReactionUpdated(event) {
    const id = event?.messageId;
    if (!id) return;
    if (!_messages.some(x => x.id === id)) return;
    _patchMessage(id, { reactions: event.reactions || {} });
  },

  /**
   * WS-Handler: peer hat eine Message editiert → ciphertext decrypten + lokal patchen.
   * Invalidiert auch den decrypt-Cache, damit ein Reload des Chats die EDITIERTE
   * Version frisch decryptet (sonst würde der Cache die alte Plaintext-Version
   * zurückgeben und der editierte Text verschwinden).
   */
  async handleMessageEdited(event) {
    const id = event?.messageId;
    // DEBUG (Step A): nachvollziehen warum Empfänger den Edit nicht sieht.
    console.log('🛠️ EDIT-DBG event received', {
      id: id?.slice(0, 8),
      from: event?.from,
      hasCipher: !!event?.ciphertext,
      cipherLen: event?.ciphertext?.length,
      rotIdx: event?.rotationIndex,
      groupId: event?.groupId,
      convoId: event?.convoId,
      messagesInStore: _messages.length,
      selectedChatKey: _selectedChat?.key,
      selectedChatType: _selectedChat?.type,
    });
    if (!id) { console.warn('🛠️ EDIT-DBG abort: no event.messageId'); return; }
    const m = _messages.find(x => x.id === id);
    if (!m) {
      console.warn('🛠️ EDIT-DBG message not in _messages (Chat nicht aktiv) — Cache invalidieren damit beim Re-Open der frische Text geladen wird', {
        id: id.slice(0, 8),
      });
      // FIX: Cache invalidieren auch wenn die Message gerade nicht im aktiven
      // Chat ist. Sonst liefert decryptIncomingMessage beim nächsten /chat/list
      // den alten gecachten Text statt aus dem edited_message-Field zu lesen.
      invalidateDecryptCacheFor(id);
      return;
    }
    invalidateDecryptCacheFor(id);
    const myHandle = userStore.myUser;
    const original = m._raw || m;
    console.log('🛠️ EDIT-DBG message found, original meta:', {
      hasRaw: !!m._raw,
      sid: original.sid,
      epoch: original.epoch,
      rotIdx: original.rotation_index ?? original.rotationIndex,
      from: m.from,
      to: m.to,
    });
    // Group vs DM erkennen — robuster Fallback gegen Reload-Race:
    //  1. event.groupId  — Backend setzt es jetzt explizit (chatRoutes.js editEvent)
    //  2. event.convoId  — falls UUID-Format → Group
    //  3. original.groupId / original.convo_id — falls bereits in _raw vorhanden
    //  4. _selectedChat — letzter Fallback wenn Chat aktiv
    // UUID-Pattern (RFC 4122 v4-ähnlich) statt String-Heuristiken.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);
    const groupId =
      (isUuid(event.groupId) && event.groupId) ||
      (isUuid(event.convoId) && event.convoId) ||
      (isUuid(original.groupId) && original.groupId) ||
      (isUuid(original.convo_id) && original.convo_id) ||
      (isUuid(original.convoId) && original.convoId) ||
      ((_selectedChat?.type === 'group' || _selectedChat?.type === 'channel') ? _selectedChat.key : null);
    let newText;
    if (groupId) {
      newText = await decryptEditedGroupMessage(event, original, myHandle, groupId);
    } else {
      const peer = m.from === myHandle ? m.to : m.from;
      console.log('🛠️ EDIT-DBG DM decrypt attempt, peer:', peer);
      newText = await decryptEditedMessage(event, original, myHandle, peer);
    }
    if (typeof newText !== 'string') {
      console.warn('🛠️ EDIT-DBG decrypt FAILED — newText is', typeof newText, newText);
    } else {
      console.log('🛠️ EDIT-DBG decrypt OK, patching UI with new text (len ' + newText.length + ')');
    }
    if (typeof newText === 'string') {
      // _raw aktualisieren, damit ein nachträgliches _decryptOne (z.B. nach
      // Reload) den editierten Cipher inkl. neuer Sig sieht.
      const newRaw = {
        ...original,
        edited_message: event.ciphertext,
        editedMessage: event.ciphertext,
        edited_at: event.ts || Date.now(),
        editedAt: event.ts || Date.now(),
      };
      _patchMessage(id, {
        text: newText,
        edited: true,
        editedAt: event.ts || Date.now(),
        _raw: newRaw,
      });
    }
  },

  setReplyingTo(msg) {
    if (!msg || !msg.id) { _replyingTo = null; return; }
    // Reply-Preview braucht: id (für Backend), from (Anzeige), text (für Encrypt + Anzeige).
    // Bei noch-nicht-decrypteten Messages (text === "🔐 …") kein Reply zulassen — sonst
    // würde "🔐 …" als Preview verschickt.
    if (msg.text === "🔐 …") return;
    _replyingTo = { id: msg.id, from: msg.from, text: msg.text };
    _editingMsg = null;  // Reply + Edit schließen sich aus
  },

  clearReplyingTo() { _replyingTo = null; },

  /**
   * Wählt einen Chat aus.
   * @param {object} chat - { type: "dm"|"group", key: string, name: string, peer?: string }
   */
  async selectChat(chat) {
    // Idempotent: Re-Select des bereits aktiven Chats ist no-op.
    // Verhindert doppeltes /chat/list + _decryptAllE2E bei Doppel-Klick
    // oder Svelte-Re-Renders auf demselben Inbox-Item.
    if (_selectedChat && chat
        && _selectedChat.key === chat.key
        && _selectedChat.type === chat.type) {
      return;
    }

    // Save current draft before switching
    if (_selectedChat) {
      _drafts.set(_selectedChat.key, _draftText);
    }

    _selectedChat = chat;
    _draftText = chat ? (_drafts.get(chat.key) || "") : "";
    _messages = [];
    _replyingTo = null;
    _editingMsg = null;

    if (!chat) return;

    // Inbox live aktualisieren: Unread-Badge ausblenden sobald Chat geöffnet wird.
    // Backend resettet unread_counters automatisch bei /chat/list (DM) — siehe
    // chatRoutes.js:155. Für Gruppen rufen wir /groups/mark-read explizit auf.
    inboxStore.markRead(chat.key);
    if (chat.type === 'group' && chat.key) {
      apiFetch('/groups/mark-read', {
        method: 'POST',
        body: { groupId: chat.key, lastReadTs: Date.now() },
      }).catch(() => {});
    }

    // KEIN Pre-Fetch mehr: das hat eine Race-Condition geschaffen, in der BEIDE
    // Seiten beim Chat-Öffnen gleichzeitig eigene CMKs erzeugten. Stattdessen:
    // ensureSecureDmSession passiert nur beim ersten Send (in sendEncryptedDm),
    // und decryptIncomingMessage holt CMKs lazy aus KV bei Bedarf.
    const myHandle = userStore.myUser;

    // Load messages from API + decrypt e2e messages async
    _isLoading = true;
    try {
      const peerOrConvo = chat.type === "dm" ? (chat.peer || chat.key) : chat.key;
      const r = await apiFetch(`/chat/list?with=${encodeURIComponent(peerOrConvo)}`);
      if (r.ok && Array.isArray(r.data?.messages)) {
        // GSK-Control-Messages (gsk / request_gsk) sind Signalling — nie rendern.
        // Backend speichert sie in D1 für Gast-Polling, daher kommen sie hier mit zurück.
        const visible = r.data.messages.filter(m => m.type !== 'gsk' && m.type !== 'request_gsk');
        // Backend liefert reactions als separates Top-Level-Feld { msgId → { emoji: [handles] } }
        // (chatRoutes.js /chat/list). _normalizeMessage erwartet sie aber AM Message-Objekt —
        // ohne Merge wären Reaktionen nach jedem Chat-Wechsel weg, weil WS-Events während
        // ein anderer Chat aktiv war in handleReactionUpdated früh-returnen.
        const rxMap = (r.data.reactions && typeof r.data.reactions === 'object') ? r.data.reactions : {};
        const initial = visible.map(m => _normalizeMessage({ ...m, reactions: rxMap[m.id] }, myHandle));
        _messages = initial;

        if (chat.type === "dm" && chat.peer) {
          void _decryptAllE2E(chat.peer, myHandle);
        } else if (chat.type === "group" || chat.type === "channel") {
          // Member-Cache vorbefüllen für späteres Senden.
          void _loadGroupMembers(chat.key);
          void _decryptAllGroupE2E(chat.key, myHandle);
        }
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

  /**
   * Refresh des aktuell geöffneten Chats ohne Reset/Flicker.
   * Use-Case: PWA war suspended (Background), WS wurde gekappt, Push-Nachrichten
   * landeten am Gerät aber nicht im _messages-State. Beim Resume (visibilitychange
   * → visible) holen wir die letzten Messages frisch und mergen per ID-Dedup.
   * Idempotent: bei Doppel-Aufruf ohne neue Server-Messages no-op.
   */
  async refreshSelected() {
    if (!_selectedChat) return;
    const chat = _selectedChat;
    const myHandle = userStore.myUser;
    try {
      const peerOrConvo = chat.type === "dm" ? (chat.peer || chat.key) : chat.key;
      const r = await apiFetch(`/chat/list?with=${encodeURIComponent(peerOrConvo)}`);
      if (!r.ok || !Array.isArray(r.data?.messages)) return;

      // Während des Fetches kann der User den Chat gewechselt haben → discard.
      if (!_selectedChat || _selectedChat.key !== chat.key || _selectedChat.type !== chat.type) return;

      const visible = r.data.messages.filter(m => m.type !== 'gsk' && m.type !== 'request_gsk');
      const rxMap = (r.data.reactions && typeof r.data.reactions === 'object') ? r.data.reactions : {};
      const existingIds = new Set(_messages.map(m => m.id).filter(Boolean));
      const fresh = [];
      for (const m of visible) {
        if (m.id && existingIds.has(m.id)) continue;
        fresh.push(_normalizeMessage({ ...m, reactions: rxMap[m.id] }, myHandle));
      }
      // Reaktionen für BEREITS geladene Messages aktualisieren — sonst gehen Reaktions-
      // Events verloren die während PWA-Suspend oder fremdem Chat-Tab arrivierten
      // (handleReactionUpdated früh-returnt wenn Message nicht im aktiven _messages).
      if (Object.keys(rxMap).length > 0) {
        _messages = _messages.map(m => {
          const next = rxMap[m.id];
          if (!next) return m;
          return { ...m, reactions: next };
        });
      }
      if (fresh.length === 0) {
        // Trotzdem Badge clearen: /chat/list hat serverseitig unread_counters
        // bereits gelöscht — lokal nachziehen.
        inboxStore.markRead(chat.key);
        return;
      }

      _messages = [..._messages, ...fresh].sort((a, b) => (a.ts || 0) - (b.ts || 0));
      inboxStore.markRead(chat.key);

      if (chat.type === "dm" && chat.peer) {
        void _decryptAllE2E(chat.peer, myHandle);
      } else if (chat.type === "group" || chat.type === "channel") {
        void _decryptAllGroupE2E(chat.key, myHandle);
      }
    } catch (e) {
      captureException(e, { context: "chatStore.refreshSelected" });
    }
  },

  setDraft(text) {
    _draftText = text || "";
  },

  /**
   * Real send via /chat/send API.
   * DM: E2E-Encrypt via lib/chatPipeline.js (CMK + Session + Sig).
   * Group: Plaintext (Group-E2E folgt in Phase 1C).
   */
  async sendMessage(text, opts = {}) {
    const attachment = opts?.attachment || null;
    if (!_selectedChat) return;
    // Mit Attachment darf Text leer sein; ohne Attachment muss Text da sein.
    if (!attachment && !text.trim()) return;

    const myHandle = userStore.myUser || "me";
    const trimmed = (text || "").trim();
    const tempId = crypto.randomUUID();

    // Snapshot + clear: weitere Sends sollen NICHT auf der gleichen Reply hängen.
    const replyTo = _replyingTo;
    _replyingTo = null;

    // Optimistic UI — Attachment-Meta direkt anzeigen (Photo-Vorschau ohne Round-Trip).
    const optimisticMsg = {
      id: tempId,
      from: myHandle,
      ts: Date.now(),
      text: trimmed,
      status: "sending",
      isMe: true,
      _isOptimistic: true,
      replyTo: replyTo ? { id: replyTo.id, from: replyTo.from, text: replyTo.text } : undefined,
      attachment: attachment ? {
        type:       attachment.type,
        key:        attachment.r2Key,
        fileKey:    attachment.fileKey,
        iv:         attachment.iv,
        fileName:   attachment.fileName,
        mimeType:   attachment.mimeType,
        fileSize:   attachment.fileSize,
        // GIF-Felder (kein R2, direkt vom GIPHY-CDN)
        gifUrl:     attachment.gifUrl,
        gifPreview: attachment.gifPreview,
        gifId:      attachment.gifId,
      } : undefined,
    };
    _messages = [..._messages, optimisticMsg];
    _draftText = "";
    _drafts.delete(_selectedChat.key);

    // 'channel' wird wie 'group' behandelt: Sender-Keys-Pattern + convo-id-Send.
    // Backend leitet aus conversations.type='channel' die richtige Member-Quelle ab.
    const isGroup = _selectedChat.type === "group" || _selectedChat.type === "channel";
    const peer = _selectedChat.peer || _selectedChat.key;

    try {
      let r;
      if (!isGroup) {
        // DM → E2E-encrypted send
        const result = await sendEncryptedDm(myHandle, peer, trimmed, replyTo, attachment);
        r = result.ok
          ? { ok: true, data: { message: result.message } }
          : { ok: false, error: result.error };
      } else {
        // Group → E2E via GSK (Sender-Keys-Pattern, Phase 1C).
        // Member-Liste aus inboxStore.groups holen, Fallback auf /groups/members.
        const groupId = _selectedChat.key;
        let memberHandles = _groupMemberCache.get(groupId);
        if (!memberHandles) {
          memberHandles = await _loadGroupMembers(groupId);
        }
        const result = await sendEncryptedGroup(myHandle, groupId, memberHandles, trimmed, replyTo, attachment);
        r = result.ok
          ? { ok: true, data: { message: result.message } }
          : { ok: false, error: result.error };
      }

      if (r.ok && r.data?.message) {
        const serverMsg = _normalizeMessage(r.data.message, myHandle);
        // Optimistic-Replace: Klartext lokal behalten (eigene Message muss nicht neu decryptet werden)
        // Reply-Preview ebenfalls als Plaintext halten — sonst würde sie in der Bubble als "🔐" angezeigt
        // bis ein _decryptAllE2E-Sweep läuft (das passiert für eigene Sends nicht sofort).
        // Attachment-Object lokal preservieren — _normalizeMessage liest nur attachment_key
        // aus DB-Spalten, das ist bei GIFs leer (gifUrl/gifPreview/gifId stecken im
        // verschlüsselten Envelope, nicht in DB-Columns). Sonst überschreibt undefined die
        // optimistischen GIF-Felder und der Sender sieht eine leere Bubble.
        const localReplyTo = replyTo ? { id: replyTo.id, from: replyTo.from, text: replyTo.text } : undefined;
        _messages = _messages.map(m =>
          m.id === tempId
            ? {
                ...serverMsg,
                text: trimmed,
                status: "sent",
                replyTo: localReplyTo,
                attachment: m.attachment || serverMsg.attachment,
              }
            : m
        );
        // Inbox-Liste live aktualisieren — Sidebar zeigt sofort die letzte Nachricht
        // statt „No chat yet" bis zum nächsten Reload.
        inboxStore.bumpActivity(_selectedChat.key, trimmed, serverMsg.ts || Date.now());
        // Guest-Counter: GuestBanner hört auf dieses Event und inkrementiert
        // msgCount optimistic + pingt nach 1.5s frisch das Backend. Vorher
        // sah der Gast den Counter erst nach dem 30s/60s-Polling-Tick.
        if (userStore.isGuest && typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('renex:guest-message-sent'));
        }
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

    // GSK-Control-Messages werden vom App-WS-Handler getrennt verarbeitet
    // (groupCrypto.handleIncomingGSKMessage / handleIncomingRequestGSK) und
    // dürfen NIE in der Render-Liste landen.
    if (rawMsg.type === 'gsk' || rawMsg.type === 'request_gsk') return;

    const msg = _normalizeMessage(rawMsg, myHandle);

    // Self-Push-Filter: Backend pusht eigene DM-Messages auch an alle eigenen Devices
    // (Multi-Device-Self-Sync). Aktuelles Sender-Tab erkennt sich am deviceId und skipt
    // — das Optimistic-Replace-Flow behandelt die Message bereits via /chat/send-Response.
    // Andere Tabs/Devices nehmen die Message via diesen Pfad auf.
    // userStore.deviceId ist per-User-skoped (Bug 13 Fix).
    if (msg.isMe) {
      const myDeviceId = userStore.deviceId;
      const senderDeviceId = rawMsg.deviceId || rawMsg.device_id;
      if (myDeviceId && senderDeviceId && senderDeviceId === myDeviceId) {
        return;  // eigene Send-Echo — bereits im UI via Optimistic+Response
      }
    }

    // Dedup: keine Message ID darf 2× in der Liste sein.
    if (msg.id && _messages.some(m => m.id === msg.id)) return;

    // P3.0 Shadow-Ratchet (Dark-Launch §4.4): parallel-derive + fp-Vergleich
    // für FRESH E2E-DMs vom Peer (History trägt kein shadowV4 → advanct nie).
    // Fire-and-forget, wirft nie, beeinflusst Rendering/Decrypt nicht. Whitelist
    // statt !type (type==='' darf nicht durchrutschen); msgId → Redelivery-Dedup.
    const _shadowType = !rawMsg.type || rawMsg.type === 'message';
    if (rawMsg.shadowV4 && !rawMsg.groupId && _shadowType && !msg.isMe && msg.from) {
      void shadowOnReceive(
        msg.from,
        rawMsg.deviceId || rawMsg.device_id,
        rawMsg.shadowV4,
        userStore.deviceId,
        rawMsg.id
      );
    }

    // Inbox-Key bestimmen: bei DM der nicht-mir-Handle (Sidebar zeigt Peer),
    // bei Group die groupId. Gilt unabhängig davon ob aktueller Chat oder
    // ein anderer — Sidebar muss in beiden Fällen aktualisiert werden.
    const isGroupMsg = !!rawMsg.groupId;
    const inboxKey = isGroupMsg
      ? rawMsg.groupId
      : (msg.isMe ? msg.to : msg.from);
    // Plain-Text-Variante für Sidebar-Last-Message — Markdown-Marker
    // (`**bold**`, `` `code` ``) wegrechnen, damit die Preview lesbar bleibt.
    const previewText = msg.e2e ? '' : stripFormatting(msg.text || '');

    if (inboxKey) {
      inboxStore.bumpActivity(inboxKey, previewText, msg.ts || Date.now());
    }

    const isForCurrentChat = _selectedChat && (
      (_selectedChat.type === "dm"   && (msg.from === _selectedChat.peer || msg.to === _selectedChat.peer)) ||
      ((_selectedChat.type === "group" || _selectedChat.type === "channel") && rawMsg.groupId === _selectedChat.key)
    );

    // Unread-Counter nur für eingehende Messages (nicht eigene Multi-Device-Echos)
    // und nur wenn der Chat NICHT gerade offen ist.
    if (!msg.isMe && !isForCurrentChat && inboxKey) {
      inboxStore.incrementUnread(inboxKey);
    }

    if (!isForCurrentChat) return;

    _messages = [..._messages, msg];

    // Async-Decrypt — DM via CMK-Pipeline, Group/Channel via GSK-Pipeline.
    if (msg.e2e && _selectedChat.type === "dm" && _selectedChat.peer) {
      void _decryptOne(rawMsg, myHandle, _selectedChat.peer);
    } else if (msg.e2e && (_selectedChat.type === "group" || _selectedChat.type === "channel")) {
      void _decryptOneGroup(rawMsg, myHandle, _selectedChat.key);
    }
  },

  /**
   * Member-Cache invalidation — vom WS-Handler bei Membership-Events gerufen.
   * Beim nächsten Send wird die Mitgliederliste frisch geladen.
   */
  invalidateGroupMembers(groupId) {
    _invalidateGroupMembers(groupId);
  },

  /**
   * Fügt eine lokale System-Bubble in den aktuell sichtbaren Chat ein.
   * Wird genutzt wenn der Server eine Setting-Change-Notification (z.B.
   * Auto-Delete in Gruppen) als Control-Message pushed — die zugehörige
   * D1-System-Message läge zwar bereits in der DB, würde aber erst beim
   * nächsten Chat-Open via /chat/list sichtbar. Für Live-Sichtbarkeit
   * injizieren wir hier eine Client-seitige Repräsentation.
   *
   * No-op wenn der Chat nicht (mehr) ausgewählt ist oder die convoId
   * nicht zum aktiven Chat passt.
   *
   * @param {string} convoId - Backend-Convo-ID (DM "alice:bob" oder Group-UUID)
   * @param {string} text - Plaintext der System-Message
   * @param {number} [ts] - epoch ms (Default: now)
   */
  /**
   * Aktualisiert den Namen des aktiven Chats, falls er der angegebenen
   * Gruppe entspricht. No-op sonst. Triggert reaktiven Re-Render des
   * ChatHeaders über $derived(chatStore.selectedChat).
   */
  renameSelectedIfMatch(groupId, newName) {
    if (!groupId || !newName) return;
    if ((_selectedChat?.type !== 'group' && _selectedChat?.type !== 'channel') || _selectedChat?.key !== groupId) return;
    if (_selectedChat.name === newName) return;
    _selectedChat = { ..._selectedChat, name: newName };
  },

  appendLocalSystemMessage(convoId, text, ts) {
    if (!_selectedChat || !convoId || !text) return;
    const myKey = (_selectedChat.type === 'group' || _selectedChat.type === 'channel')
      ? _selectedChat.key
      : (userStore.myUser && _selectedChat.peer
          ? [userStore.myUser, _selectedChat.peer].sort().join(':')
          : null);
    if (myKey !== convoId) return;
    const id = `sys_${crypto.randomUUID()}`;
    if (_messages.some(m => m.id === id)) return;
    _messages = [..._messages, {
      id,
      from: null,
      ts: ts || Date.now(),
      type: 'system',
      message: text,
      text,
      isMe: false,
    }];
  },

  /**
   * Wird gerufen wenn eine CMK frisch importiert wurde (z.B. nach erfolgreichem
   * mirrorRotateCMKForPeer): Bestehende 🔐-Messages des aktuell sichtbaren Chats
   * mit dieser CMK erneut decrypten. Ohne diesen Trigger blieben Messages, die
   * vor der Rotation aber nach Ankunft der neuen CMK eingingen, dauerhaft 🔐.
   *
   * Idempotent: bei nicht-aktivem Chat oder fehlenden 🔐-Messages no-op.
   * In-flight-Guard wird vorher gelöscht damit der Retry-Sweep nicht durch
   * den 1.5s-Dedup-Throttle blockiert wird.
   */
  retryDecryptForPeer(peerHandle) {
    if (!peerHandle) return;
    if (_selectedChat?.type !== 'dm' || _selectedChat?.peer !== peerHandle) return;
    const myHandle = userStore.myUser;
    if (!myHandle) return;
    _decryptAllInFlight.delete(peerHandle);
    void _decryptAllE2E(peerHandle, myHandle);
  },

  clear() {
    _selectedChat = null;
    _messages = [];
    _draftText = "";
    _drafts.clear();
    clearAllCmkState();
    clearChatPipelineCaches();
  },

  /**
   * Wird vom WS-Listener gerufen wenn der Peer ein `cmk_unavailable` schickt:
   * Beide Seiten haben Storage verloren → CMK ist permanent verloren.
   * Wir markieren alle 🔐-Messages als „nicht entschlüsselbar" und stoppen Retries.
   */
  markCmkUnavailable(peerHandle) {
    if (!peerHandle) return;
    markCmkUnavailable(peerHandle);
    if (_selectedChat?.type === 'dm' && _selectedChat?.peer === peerHandle) {
      _messages = _messages.map(m =>
        (m.e2e && m.text === '🔐 …')
          ? { ...m, text: '🔓✗ Nicht entschlüsselbar (Schlüssel verloren)', _unrecoverable: true }
          : m
      );
    }
  },

  /**
   * Test-Helper: ist Peer als „CMK unavailable" markiert?
   */
  isCmkUnavailable(peerHandle) {
    return isCmkUnavailable(peerHandle);
  },
};

// ── E2E-Decrypt-Helpers (Phase 1A.6.x.2) ──────────────

// Exponential Backoff für Decrypt-Failures.
// 3s → 8s → 25s → 60s = total ~96s, dann aufgeben.
// Wenn ein cmk_req pending ist → Retries pausiert bis Antwort/Timeout.
// Wenn cmk_unavailable empfangen → komplett aufgeben.
const DECRYPT_RETRY_DELAYS_MS = [3000, 8000, 25000, 60000];

// v4-Double-Ratchet-Fehlschläge sind TRANSIENT (Session etabliert/primt in <1s,
// Reconcile-Ordering während des History-Sweeps) — KEIN Netz-Round-Trip wie beim
// Legacy-cmk_req. Der 3s-Erststart des CMK-Ladders war die „erst nach einiger Zeit
// lesbar"-Ursache. Darum ein schneller Start (250ms) mit großzügigem Tail: was
// vorher erst nach 3–25s zurückkam, kommt jetzt in <1s — ohne die Erfolgsrate zu
// senken (späte Attempts decken denselben Zeitraum ab).
const DECRYPT_RETRY_DELAYS_V4_MS = [250, 700, 1800, 4000, 10000, 25000];

// Erkennt eine v4-Nachricht (single: top-level header_b64; multi: payloads[].header_b64).
function _isV4Msg(m) {
  return !!(m && (m.header_b64 ||
    (Array.isArray(m.payloads) && m.payloads.some(p => p && p.header_b64))));
}

// Concurrency-Cap für initial Sweep (Performance QW1, 2026-05-02).
// Verhindert dass bei 1000-Message-Chats 1000 parallele crypto.subtle-Tasks
// IDB + Crypto-Worker thrashen. 8 ist heuristisch gut für Browser
// (typisch 4 Cores × 2 für IO/CPU-Mix).
const DECRYPT_CONCURRENCY = 8;

/**
 * Mini-Semaphore: läuft `task` aus, blockt wenn `active >= max` erreicht ist.
 * Returns Promise das auflöst wenn task fertig ist.
 */
function _makeSemaphore(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => { active--; next(); });
  };
  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    next();
  });
}
const _decryptSlot = _makeSemaphore(DECRYPT_CONCURRENCY);

async function _decryptOne(rawMsg, myHandle, peerHandle, attempt = 0) {
  try {
    // Hard-Stop: Peer hat cmk_unavailable gesendet → nie wieder versuchen.
    if (isCmkUnavailable(peerHandle)) {
      _patchMessage(rawMsg.id, {
        text: '🔓✗ Nicht entschlüsselbar (Schlüssel verloren)',
        _unrecoverable: true,
      });
      return;
    }

    // Wenn die Message editiert wurde: edited_message als Cipher verwenden.
    // Format: JSON-String {iv, ct, sig?, rotationIndex?}. Original ct_b64 bleibt im
    // DB-Row, aber Anzeige-Text muss aus dem Edit kommen. Sig muss ebenfalls aus
    // dem Edit kommen — sonst false-positive "Manipulation möglich"-Warnung
    // (Original-Sig matcht NICHT die edited iv/ct). Bei alten Edits ohne sig:
    // sig=null → decryptIncomingMessage skippt verify, verified bleibt null.
    let toDecrypt = rawMsg;
    const editedJson = rawMsg.edited_message || rawMsg.editedMessage;
    if (editedJson) {
      try {
        const parsed = JSON.parse(editedJson);
        if (parsed && parsed.iv && parsed.ct) {
          toDecrypt = {
            ...rawMsg,
            ivB64: parsed.iv, iv_b64: parsed.iv,
            ctB64: parsed.ct, ct_b64: parsed.ct,
            sig: parsed.sig || null,
            rotation_index: parsed.rotationIndex ?? rawMsg.rotation_index,
            rotationIndex: parsed.rotationIndex ?? rawMsg.rotationIndex,
          };
        }
      } catch {}
    }

    const result = await decryptIncomingMessage(toDecrypt, myHandle, peerHandle);
    const { text, verified, replyText } = result;
    if (text != null) {
      // Cache-Hit nicht loggen — sonst spammed jeder Chat-(Re-)Open die Konsole
      // mit "decrypt OK"-Zeilen für jede gecachte Message (kein crypto-Work).
      if (!result._cached) {
        console.log(`🔓 decrypt OK id=${rawMsg.id?.slice(0,8)} from=${rawMsg.from}`);
      }
      // Attachment-Envelope auspacken: Magic-Prefix → Caption + AttachmentMeta (+ Reply).
      const { caption, attachmentMeta, reply } = unwrapAttachmentPlaintext(text);
      const patch = { text: caption, verified };
      if (attachmentMeta) {
        // Attachment-Meta mit den (Plaintext-)attachment_key/_type vom Server mergen.
        // GIFs haben kein R2 — gifUrl/gifPreview/gifId müssen mit-rübergerettet werden,
        // sonst rendert AttachmentView <img src=undefined>. (Group-Pfad weiter unten
        // hatte das schon, DM-Pfad war Copy-Paste-Lücke.)
        patch.attachment = {
          type:       attachmentMeta.type     || rawMsg.attachment_type     || rawMsg.attachmentType,
          key:        attachmentMeta.r2Key    || rawMsg.attachment_key      || rawMsg.attachmentKey,
          fileKey:    attachmentMeta.fileKey,
          iv:         attachmentMeta.iv,
          fileName:   attachmentMeta.fileName,
          mimeType:   attachmentMeta.mimeType,
          fileSize:   attachmentMeta.fileSize,
          // GIF-Felder (kein R2, direkt vom GIPHY-CDN)
          gifUrl:     attachmentMeta.gifUrl,
          gifPreview: attachmentMeta.gifPreview,
          gifId:      attachmentMeta.gifId,
        };
      }
      // Reply-Preview-Text patchen, wenn die Message eine Reply ist und der Decrypt geklappt hat.
      // _normalizeMessage hat replyTo bereits mit Placeholder "🔐" angelegt — text dort patchen.
      // WICHTIG: id mit-rüberretten, sonst verliert der Empfänger den Jump-to-Original-Klick
      // (Bubble rendert ohne id einen nicht-klickbaren <div> statt <button>).
      // v4 (P3.2-B): Vorschau kommt aus dem Envelope (reply.preview, forward-secret) —
      // hat Vorrang, damit sie auch nach Reload aus dem v4-Store sichtbar ist; Legacy
      // v2 nutzt weiter die separat entschlüsselte result.replyText.
      const replyToId = rawMsg.replyToId || rawMsg.reply_to_id || reply?.id;
      const previewText = (reply && typeof reply.preview === 'string') ? reply.preview : replyText;
      if (replyToId && typeof previewText === 'string') {
        const replyFrom = rawMsg.replyFrom || rawMsg.reply_from || reply?.from;
        patch.replyTo = { id: replyToId, from: replyFrom, text: previewText };
      }
      _patchMessage(rawMsg.id, patch);
      // unavailable-Flag clearen: erfolgreicher Decrypt zeigt dass ein CMK
      // funktioniert → wir sind nicht permanent verloren.
      // pendingCmkReq-Flag NICHT pauschal clearen: in Multi-Device-Race
      // entstehen Mix-Konstellationen wo manche Messages mit unserem aktiven CMK
      // decrypten, andere mit einem CMK den der Peer nicht mehr hat (unrecoverable).
      // Hier zu clearen würde aus decryptIncomingMessage einen cmk_req-Storm machen
      // (jede unrecoverable Message triggert sofort einen neuen Send weil das Flag
      // immer wieder gecleart wurde). 30s-Timeout aus markPendingCmkReq macht
      // die natürliche Freigabe; expliziter Clear passiert nur im Success-Pfad
      // von decryptIncomingMessage (= "ich habe DEN CMK bekommen den ich brauchte").
      clearCmkUnavailable(peerHandle);
      return;
    }
    console.warn(`🔒 decrypt FAIL id=${rawMsg.id?.slice(0,8)} from=${rawMsg.from} attempt=${attempt} sid=${rawMsg.sid} epoch=${rawMsg.epoch} ivLen=${(rawMsg.ivB64 || rawMsg.iv_b64 || "").length}`);

    // v4 (Double-Ratchet) → schneller Ladder (transiente Fehlschläge).
    // Legacy (CMK) → grober Ladder, weil auf eine cmk_req-Netzantwort gewartet wird.
    const isV4 = _isV4Msg(rawMsg);
    const ladder = isV4 ? DECRYPT_RETRY_DELAYS_V4_MS : DECRYPT_RETRY_DELAYS_MS;
    if (attempt >= ladder.length) return;  // aufgeben

    // Pause-on-pending gilt nur für Legacy (v4 wartet auf keine cmk_response).
    const baseDelay = ladder[attempt];
    const delay = (!isV4 && isPendingCmkReq(peerHandle))
      ? Math.max(baseDelay, 5000)   // mindestens 5s wenn wir auf cmk_response warten (Legacy)
      : baseDelay;

    setTimeout(() => {
      // Nochmal prüfen ob CMK inzwischen unrecoverable
      if (isCmkUnavailable(peerHandle)) return;
      const stillThere = _messages.find(m => m.id === rawMsg.id);
      if (stillThere && stillThere.text === "🔐 …") {
        void _decryptOne(rawMsg, myHandle, peerHandle, attempt + 1);
      }
    }, delay);
  } catch (e) {
    console.error("🔒 decrypt EXCEPTION", e);
    captureException(e, { context: "decryptOne" });
  }
}

// In-flight Guard für _decryptAllE2E. Defense-in-depth gegen schnelle
// Mehrfach-Aufrufe (auch wenn selectChat schon idempotent ist).
// Eintrag wird nach DECRYPT_ALL_GUARD_MS gelöscht damit echte Re-Decrypts
// (z.B. nach echtem Chat-Wechsel + Zurück) nicht blockiert werden.
const _decryptAllInFlight = new Set();
const DECRYPT_ALL_GUARD_MS = 1500;

async function _decryptAllE2E(peerHandle, myHandle) {
  // Dedup: wenn für diesen Peer schon ein Sweep läuft (oder gerade lief)
  // → skip. Verhindert doppeltes Decrypten + UI-Flackern bei z.B.
  // device_added → Re-Render → Re-Select-Chain.
  if (_decryptAllInFlight.has(peerHandle)) {
    console.log(`🔓 _decryptAllE2E: peer=${peerHandle} schon in-flight, skip`);
    return;
  }
  _decryptAllInFlight.add(peerHandle);
  setTimeout(() => _decryptAllInFlight.delete(peerHandle), DECRYPT_ALL_GUARD_MS);

  // Snapshot — patches by id, so Liste-Mutation ok während Decrypt.
  // WICHTIG: Backend /chat/list returnt camelCase (ivB64, ctB64), NICHT snake_case.
  // Eigene Messages (isMe) MÜSSEN auch decrypted werden — auf Reload haben sie
  // keine optimistic-Plaintext mehr, nur Ciphertext aus DB. CMK ist symmetrisch.
  const snapshot = _messages.filter(m =>
    m.e2e &&
    m.text === "🔐 …" &&
    (m._raw?.ivB64 || m._raw?.iv_b64 ||
     // v4-MULTI (P3.2): Ciphertext steckt per-Device in payloads[], NICHT
     // top-level → sonst filtert der History-Sweep v4-multi-Nachrichten aus
     // und sie bleiben nach Chat-Reopen 🔐 (der forward-secret Klartext-Store
     // wird dann nie konsultiert). v4-single hat weiterhin top-level ivB64.
     (Array.isArray(m._raw?.payloads) && m._raw.payloads.some(p => p && p.header_b64)))
  );
  console.log(`🔓 _decryptAllE2E: peer=${peerHandle} totalMsgs=${_messages.length} toDecrypt=${snapshot.length}`);

  // Wenn Peer als unrecoverable bekannt → alle Messages direkt patchen, kein Decrypt-Versuch.
  if (isCmkUnavailable(peerHandle)) {
    for (const m of snapshot) {
      _patchMessage(m.id, {
        text: '🔓✗ Nicht entschlüsselbar (Schlüssel verloren)',
        _unrecoverable: true,
      });
    }
    return;
  }

  // QW1 (2026-05-02): Concurrency-Cap statt unbounded fan-out.
  // Bei N=1000 Messages spawnen wir nicht 1000 parallele Crypto-Tasks
  // (würde IDB + Crypto-Worker thrashen), sondern max DECRYPT_CONCURRENCY
  // gleichzeitig. UI-Updates kommen früh (erste 8 Messages decrypten sofort,
  // dann incremental).
  // Legacy-CMK (symmetrisch, ordnungsunabhängig) → Concurrency-Pool wie bisher.
  // v4 (Double-Ratchet) → SERIELL in chronologischer Reihenfolge (snapshot ist
  // ts-sortiert): alle v4-Nachrichten eines Sender-Geräts teilen ein FIFO-Lock
  // (sess:peer:dev). Serielles Dispatch stellt sicher, dass die init-tragende
  // (ältere) Nachricht die Session ETABLIERT, bevor abhängige (neuere) kommen.
  // Out-of-order (Pool) setzt sonst den Rezenz-Anker durch eine neuere Nachricht
  // hoch → ältere init-Nachricht gilt als „stale" → reconcile_stale_init → 🔐 →
  // Retry. Per-Message-Timeout verhindert, dass eine langsame (Netz-)Nachricht die
  // Kette blockiert; ihr eigener Backoff-Retry fängt sie später.
  const v4Msgs = [];
  for (const m of snapshot) {
    const raw = m._raw || m;
    if (_isV4Msg(raw)) v4Msgs.push(raw);
    else void _decryptSlot(() => _decryptOne(raw, myHandle, peerHandle));
  }
  void (async () => {
    for (const raw of v4Msgs) {
      await Promise.race([
        _decryptOne(raw, myHandle, peerHandle).catch(() => {}),
        new Promise(r => setTimeout(r, 4000)),
      ]);
    }
  })();

  // Proactive CMK-Acquisition: wenn beim Chat-Öffnen lokal keine CMK existiert,
  // ABER e2e-Messages zu decrypten sind, sofort einen cmk_req triggern.
  // Sonst würde der Decrypt-Retry-Loop bis zu 36s warten (3s+8s+25s) bevor was passiert.
  // Dedup: markPendingCmkReq verhindert doppelte Sends.
  if (snapshot.length > 0) {
    void _kickCmkAcquisitionIfNeeded(peerHandle);
  }
}

async function _kickCmkAcquisitionIfNeeded(peerHandle) {
  // Kurzer Delay damit erste Decrypt-Attempts (lokale CMK + KV-Single-Flight)
  // eine Chance haben — falls die CMK schon da ist, kein cmk_req nötig.
  await new Promise(r => setTimeout(r, 1500));

  // Inzwischen alles decrypted? Dann skip.
  const stillLocked = _messages.some(m => m.e2e && m.text === "🔐 …");
  if (!stillLocked) return;
  if (isCmkUnavailable(peerHandle)) return;
  if (isPendingCmkReq(peerHandle)) return;  // schon pending

  // Lokale CMK existiert? Dann ist der Fail-Grund anderswo (epoch, signature) —
  // cmk_req würde nichts ändern.
  const localCmk = await getCMKIfExists(peerHandle).catch(() => null);
  if (localCmk) return;

  // Guest-Peer-Sonderfall: Gast hat per Fallback-Bootstrap eine CMK in KV
  // hochgeladen (gewrappt für meine deviceId). cmk_req hilft nicht, weil der
  // Gast sie selber nicht "redistribuieren" kann. Stattdessen direkt
  // ensureSecureDmSession → fetcht aus KV + speichert lokal.
  if (isGuestHandle(peerHandle)) {
    console.warn(`🔍 Proaktiv KV-Fetch für Gast-Peer ${peerHandle} (statt cmk_req)`);
    const myHandle = userStore.myUser;
    if (myHandle) {
      try {
        const cmk = await ensureSecureDmSession(myHandle, peerHandle);
        if (cmk) {
          console.log(`✅ Gast-CMK aus KV importiert für ${peerHandle} — Decrypt-Retry kommt`);
          // _decryptOne läuft eh in seinem Backoff-Loop weiter — der findet
          // die jetzt lokal gespeicherte CMK beim nächsten Versuch.
          return;
        }
      } catch (e) {
        captureException(e, { context: 'kickCmkAcquisition-guest', peerHandle });
      }
    }
    // Fallthrough zu cmk_req falls KV-Fetch fehlschlug (Best-Effort)
  }

  console.warn(`📨 Proaktiv cmk_req → ${peerHandle} (Chat geöffnet, keine lokale CMK)`);
  markPendingCmkReq(peerHandle);
  void sendCmkRequest(peerHandle);
}

function _patchMessage(id, patch) {
  _messages = _messages.map(m => m.id === id ? { ...m, ...patch } : m);
}

// ── Group-E2E Decrypt-Helpers (Phase 1C) ──────────────

const GROUP_DECRYPT_RETRY_DELAYS_MS = [3000, 8000, 25000, 60000];

async function _decryptOneGroup(rawMsg, myHandle, groupId, attempt = 0) {
  try {
    // Wenn die Message editiert wurde: edited_message als Cipher verwenden — analog
    // zum DM-Pfad in _decryptOne. Ohne diesen Block würde der ORIGINAL-ct vom DB-Row
    // entschlüsselt, der edited_message ignoriert → Empfänger sieht alten Text auch
    // nach Re-Open des Chats.
    let toDecrypt = rawMsg;
    const editedJson = rawMsg.edited_message || rawMsg.editedMessage;
    if (editedJson) {
      try {
        const parsed = JSON.parse(editedJson);
        if (parsed && parsed.iv && parsed.ct) {
          toDecrypt = {
            ...rawMsg,
            ivB64: parsed.iv, iv_b64: parsed.iv,
            ctB64: parsed.ct, ct_b64: parsed.ct,
            sig: parsed.sig || null,
            rotation_index: parsed.rotationIndex ?? rawMsg.rotation_index,
            rotationIndex:  parsed.rotationIndex ?? rawMsg.rotationIndex,
          };
        }
      } catch {}
    }

    const result = await decryptIncomingGroupMessage(toDecrypt, myHandle, groupId);
    const { text, verified, replyText } = result;
    if (text != null) {
      if (!result._cached) {
        console.log(`🔓 group decrypt OK id=${rawMsg.id?.slice(0,8)} from=${rawMsg.from}`);
      }
      // Attachment-Envelope auspacken (analog DM-Pfad).
      const { caption, attachmentMeta } = unwrapAttachmentPlaintext(text);
      const patch = { text: caption, verified };
      if (attachmentMeta) {
        patch.attachment = {
          type:       attachmentMeta.type     || rawMsg.attachment_type     || rawMsg.attachmentType,
          key:        attachmentMeta.r2Key    || rawMsg.attachment_key      || rawMsg.attachmentKey,
          fileKey:    attachmentMeta.fileKey,
          iv:         attachmentMeta.iv,
          fileName:   attachmentMeta.fileName,
          mimeType:   attachmentMeta.mimeType,
          fileSize:   attachmentMeta.fileSize,
          // GIF-Felder (kein R2, direkt vom GIPHY-CDN)
          gifUrl:     attachmentMeta.gifUrl,
          gifPreview: attachmentMeta.gifPreview,
          gifId:      attachmentMeta.gifId,
        };
      }
      const replyToId = rawMsg.replyToId || rawMsg.reply_to_id;
      if (replyToId && typeof replyText === 'string') {
        const replyFrom = rawMsg.replyFrom || rawMsg.reply_from;
        patch.replyTo = { id: replyToId, from: replyFrom, text: replyText };
      }
      _patchMessage(rawMsg.id, patch);
      return;
    }

    console.warn(`🔒 group decrypt FAIL id=${rawMsg.id?.slice(0,8)} from=${rawMsg.from} attempt=${attempt}`);
    if (attempt >= GROUP_DECRYPT_RETRY_DELAYS_MS.length) return;

    // GSK kommt asynchron via WS gsk-Control — Retry mit Backoff.
    setTimeout(() => {
      const stillThere = _messages.find(m => m.id === rawMsg.id);
      if (stillThere && stillThere.text === "🔐 …") {
        void _decryptOneGroup(rawMsg, myHandle, groupId, attempt + 1);
      }
    }, GROUP_DECRYPT_RETRY_DELAYS_MS[attempt]);
  } catch (e) {
    console.error("🔒 group decrypt EXCEPTION", e);
    captureException(e, { context: 'decryptOneGroup' });
  }
}

const _decryptAllGroupInFlight = new Set();

async function _decryptAllGroupE2E(groupId, myHandle) {
  if (_decryptAllGroupInFlight.has(groupId)) return;
  _decryptAllGroupInFlight.add(groupId);
  setTimeout(() => _decryptAllGroupInFlight.delete(groupId), DECRYPT_ALL_GUARD_MS);

  const snapshot = _messages.filter(m =>
    m.e2e &&
    m.text === "🔐 …" &&
    (m._raw?.ivB64 || m._raw?.iv_b64)
  );
  console.log(`🔓 _decryptAllGroupE2E: group=${String(groupId).slice(0,8)} toDecrypt=${snapshot.length}`);

  for (const m of snapshot) {
    const raw = m._raw || m;
    void _decryptSlot(() => _decryptOneGroup(raw, myHandle, groupId));
  }
}

// ── Helpers ─────────────────────────────────────────────
/**
 * Backend-Message → Frontend-Message normalisieren.
 * E2E=true Messages werden initial mit Placeholder gerendert; async-Decrypt
 * patcht das `text`-Feld später (siehe _decryptAllE2E + _decryptOne).
 */
function _normalizeMessage(m, myHandle) {
  const isMe = (m.from || m.from_user) === myHandle;
  const text = m.e2e
    ? "🔐 …"  // Placeholder bis async-Decrypt patcht
    : (m.message || m.text || "");

  // Reply-Felder: Backend liefert beide Cases (camelCase aus /chat/list, snake_case aus DB direct).
  const replyToId = m.replyToId || m.reply_to_id;
  const replyFrom = m.replyFrom || m.reply_from;
  const hasReplyCt = !!(m.replyCt || m.reply_ct);

  // Edit-Felder: Backend speichert edited_message (cipher) + edited_at (ts).
  // Wenn edited_message vorhanden → die ANZUZEIGENDE ct kommt daraus, nicht aus
  // ct_b64. Decrypt-Pfad muss das _raw-Objekt entsprechend behandeln.
  const editedAt = m.editedAt || m.edited_at || null;
  const editedMessage = m.editedMessage || m.edited_message || null;

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
    verified: null,  // wird vom Decrypt-Pfad gesetzt: true|false|null
    edited: !!editedAt,
    editedAt: editedAt || null,
    _editedMessage: editedMessage,
    reactions: m.reactions && typeof m.reactions === 'object' ? m.reactions : {},
    replyTo: replyToId ? {
      id: replyToId,        // ID der Original-Message — für Jump-to-Original-Klick
      from: replyFrom,
      // Bei E2E-Reply mit verschlüsselter Preview: Placeholder bis Decrypt patcht.
      // v4 (P3.2-B) trägt die Preview im Envelope → KEIN top-level replyCt, aber
      // m.e2e ist gesetzt → auch dann 🔐 (sonst leere Zitat-Zeile bis/while locked).
      // Sonst (Plaintext-Group oder kein Preview): Plaintext direkt.
      text: (hasReplyCt || m.e2e) ? "🔐" : (m.replyMessage || m.reply_message || ""),
    } : undefined,
    attachment: m.attachment_key ? {
      type: m.attachment_type,
      key: m.attachment_key,
    } : undefined,
    // Raw-Original bewahren — wird vom async-Decrypter in _decryptAllE2E benötigt
    _raw: m,
  };
}
