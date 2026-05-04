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
} from '../lib/chatPipeline.js';
import { inboxStore } from './inbox.svelte.js';
import { getCMKIfExists } from '../lib/cmk.js';
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
    if (_selectedChat.type !== 'dm') {
      // Group-Edit nicht im Plaintext-Pfad implementiert — Phase 1C
      return { ok: false, error: 'group_edit_unsupported' };
    }
    const myHandle = userStore.myUser;
    const peer = _selectedChat.peer;
    const result = await editEncryptedDm(myHandle, peer, m._raw || m, msgId, trimmed);
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
    if (!id) return;
    const m = _messages.find(x => x.id === id);
    if (!m) return;
    invalidateDecryptCacheFor(id);
    const myHandle = userStore.myUser;
    const peer = m.from === myHandle ? m.to : m.from;
    const original = m._raw || m;
    const newText = await decryptEditedMessage(event, original, myHandle, peer);
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
        const initial = visible.map(m => _normalizeMessage(m, myHandle));
        _messages = initial;

        if (chat.type === "dm" && chat.peer) {
          void _decryptAllE2E(chat.peer, myHandle);
        } else if (chat.type === "group") {
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

  setDraft(text) {
    _draftText = text || "";
  },

  /**
   * Real send via /chat/send API.
   * DM: E2E-Encrypt via lib/chatPipeline.js (CMK + Session + Sig).
   * Group: Plaintext (Group-E2E folgt in Phase 1C).
   */
  async sendMessage(text) {
    if (!_selectedChat || !text.trim()) return;

    const myHandle = userStore.myUser || "me";
    const trimmed = text.trim();
    const tempId = crypto.randomUUID();

    // Snapshot + clear: weitere Sends sollen NICHT auf der gleichen Reply hängen.
    const replyTo = _replyingTo;
    _replyingTo = null;

    // Optimistic UI
    const optimisticMsg = {
      id: tempId,
      from: myHandle,
      ts: Date.now(),
      text: trimmed,
      status: "sending",
      isMe: true,
      _isOptimistic: true,
      replyTo: replyTo ? { id: replyTo.id, from: replyTo.from, text: replyTo.text } : undefined,
    };
    _messages = [..._messages, optimisticMsg];
    _draftText = "";
    _drafts.delete(_selectedChat.key);

    const isGroup = _selectedChat.type === "group";
    const peer = _selectedChat.peer || _selectedChat.key;

    try {
      let r;
      if (!isGroup) {
        // DM → E2E-encrypted send
        const result = await sendEncryptedDm(myHandle, peer, trimmed, replyTo);
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
        const result = await sendEncryptedGroup(myHandle, groupId, memberHandles, trimmed, replyTo);
        r = result.ok
          ? { ok: true, data: { message: result.message } }
          : { ok: false, error: result.error };
      }

      if (r.ok && r.data?.message) {
        const serverMsg = _normalizeMessage(r.data.message, myHandle);
        // Optimistic-Replace: Klartext lokal behalten (eigene Message muss nicht neu decryptet werden)
        // Reply-Preview ebenfalls als Plaintext halten — sonst würde sie in der Bubble als "🔐" angezeigt
        // bis ein _decryptAllE2E-Sweep läuft (das passiert für eigene Sends nicht sofort).
        const localReplyTo = replyTo ? { id: replyTo.id, from: replyTo.from, text: replyTo.text } : undefined;
        _messages = _messages.map(m =>
          m.id === tempId
            ? { ...serverMsg, text: trimmed, status: "sent", replyTo: localReplyTo }
            : m
        );
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

    if (!_selectedChat) return;

    const isForCurrentChat =
      (_selectedChat.type === "dm"   && (msg.from === _selectedChat.peer || msg.to === _selectedChat.peer)) ||
      (_selectedChat.type === "group" && rawMsg.groupId === _selectedChat.key);

    if (!isForCurrentChat) return;

    _messages = [..._messages, msg];

    // Async-Decrypt — DM via CMK-Pipeline, Group via GSK-Pipeline.
    if (msg.e2e && _selectedChat.type === "dm" && _selectedChat.peer) {
      void _decryptOne(rawMsg, myHandle, _selectedChat.peer);
    } else if (msg.e2e && _selectedChat.type === "group") {
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
      const patch = { text, verified };
      // Reply-Preview-Text patchen, wenn die Message eine Reply ist und der Decrypt geklappt hat.
      // _normalizeMessage hat replyTo bereits mit Placeholder "🔐" angelegt — text dort patchen.
      // WICHTIG: id mit-rüberretten, sonst verliert der Empfänger den Jump-to-Original-Klick
      // (Bubble rendert ohne id einen nicht-klickbaren <div> statt <button>).
      const replyToId = rawMsg.replyToId || rawMsg.reply_to_id;
      if (replyToId && typeof replyText === 'string') {
        const replyFrom = rawMsg.replyFrom || rawMsg.reply_from;
        patch.replyTo = { id: replyToId, from: replyFrom, text: replyText };
      }
      _patchMessage(rawMsg.id, patch);
      // Ein erfolgreicher Decrypt heißt: CMK ist da → pending-Flag + ggf. fälschlich
      // gesetztes unavailable-Flag clearen (z.B. nach Bundle-Restore mitten im Flow).
      clearPendingCmkReq(peerHandle);
      clearCmkUnavailable(peerHandle);
      return;
    }
    console.warn(`🔒 decrypt FAIL id=${rawMsg.id?.slice(0,8)} from=${rawMsg.from} attempt=${attempt} sid=${rawMsg.sid} epoch=${rawMsg.epoch} ivLen=${(rawMsg.ivB64 || rawMsg.iv_b64 || "").length}`);

    if (attempt >= DECRYPT_RETRY_DELAYS_MS.length) return;  // aufgeben

    // Wenn cmk_req pending: Retry verzögern bis Antwort kommt (Pause-on-pending).
    // Sonst: Backoff-Delay verwenden.
    const baseDelay = DECRYPT_RETRY_DELAYS_MS[attempt];
    const delay = isPendingCmkReq(peerHandle)
      ? Math.max(baseDelay, 5000)   // mindestens 5s wenn wir auf cmk_response warten
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
    (m._raw?.ivB64 || m._raw?.iv_b64)
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
  for (const m of snapshot) {
    const raw = m._raw || m;
    void _decryptSlot(() => _decryptOne(raw, myHandle, peerHandle));
  }

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
    const result = await decryptIncomingGroupMessage(rawMsg, myHandle, groupId);
    const { text, verified, replyText } = result;
    if (text != null) {
      if (!result._cached) {
        console.log(`🔓 group decrypt OK id=${rawMsg.id?.slice(0,8)} from=${rawMsg.from}`);
      }
      const patch = { text, verified };
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
      // Sonst (Plaintext-Group oder kein Preview): Plaintext direkt.
      text: hasReplyCt ? "🔐" : (m.replyMessage || m.reply_message || ""),
    } : undefined,
    attachment: m.attachment_key ? {
      type: m.attachment_type,
      key: m.attachment_key,
    } : undefined,
    // Raw-Original bewahren — wird vom async-Decrypter in _decryptAllE2E benötigt
    _raw: m,
  };
}
