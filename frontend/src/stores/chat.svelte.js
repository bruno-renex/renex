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
} from '../lib/chatPipeline.js';
import { getCMKIfExists } from '../lib/cmk.js';
import {
  isPendingCmkReq, markPendingCmkReq, clearPendingCmkReq,
  isCmkUnavailable, markCmkUnavailable, clearCmkUnavailable, clearAllCmkState,
} from '../lib/cmkRequestState.js';

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
        // Sofort mit Placeholdern rendern, dann async decrypten
        const initial = r.data.messages.map(m => _normalizeMessage(m, myHandle));
        _messages = initial;

        if (chat.type === "dm" && chat.peer) {
          void _decryptAllE2E(chat.peer, myHandle);
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

    // Optimistic UI
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

    const isGroup = _selectedChat.type === "group";
    const peer = _selectedChat.peer || _selectedChat.key;

    try {
      let r;
      if (!isGroup) {
        // DM → E2E-encrypted send
        const result = await sendEncryptedDm(myHandle, peer, trimmed);
        r = result.ok
          ? { ok: true, data: { message: result.message } }
          : { ok: false, error: result.error };
      } else {
        // Group → Plaintext für jetzt (Group-E2E = Phase 1C)
        r = await apiFetch("/chat/send", {
          method: "POST",
          body: { to: myHandle, convoId: _selectedChat.key, message: trimmed },
        });
      }

      if (r.ok && r.data?.message) {
        const serverMsg = _normalizeMessage(r.data.message, myHandle);
        // Optimistic-Replace: Klartext lokal behalten (eigene Message muss nicht neu decryptet werden)
        _messages = _messages.map(m =>
          m.id === tempId
            ? { ...serverMsg, text: trimmed, status: "sent" }
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

    // Async-Decrypt für ALLE e2e DM-Messages.
    // WICHTIG: NICHT nur Peer-Messages — bei Multi-Device kommen eigene Messages
    // von ANDEREN eigenen Devices via WS. Die brauchen auch Decrypt (kein Optimistic-
    // Replace, da nicht in DIESEM Tab gesendet). Same-Device-Echo ist bereits
    // weiter oben via senderDeviceId-Filter ausgeschlossen.
    if (msg.e2e && _selectedChat.type === "dm" && _selectedChat.peer) {
      void _decryptOne(rawMsg, myHandle, _selectedChat.peer);
    }
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

    const { text, verified } = await decryptIncomingMessage(rawMsg, myHandle, peerHandle);
    if (text != null) {
      console.log(`🔓 decrypt OK id=${rawMsg.id?.slice(0,8)} from=${rawMsg.from}`);
      _patchMessage(rawMsg.id, { text, verified });
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

  for (const m of snapshot) {
    const raw = m._raw || m;
    void _decryptOne(raw, myHandle, peerHandle);
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
    replyTo: m.reply_to_id ? {
      from: m.reply_from,
      text: m.e2e ? "🔐" : (m.reply_message || ""),
    } : undefined,
    attachment: m.attachment_key ? {
      type: m.attachment_type,
      key: m.attachment_key,
    } : undefined,
    // Raw-Original bewahren — wird vom async-Decrypter in _decryptAllE2E benötigt
    _raw: m,
  };
}
