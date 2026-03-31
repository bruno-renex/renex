import { bootApp } from "./appBoot.js";
bootApp();

import {
  initE2EKeys,
  debugPrintMyPublicKey,
  loadPublicKey,
  idbSet,
  dmSessionId,
  deriveMessageKey,
  deriveSessionKeyBytesForRotation,
  getLastRotationTime,
  setLastRotationTime,
  getRotationMap,
  findCmkForRotationIndex,
  signMessage,
  verifyMessageSig,
  getSigPubForDevice,
  setRotationIndex
} from "./e2e.js";

import {
  ensureConversationReady,
  bootConversation,
  fetchAndStoreCMK,
  fallbackBootstrap,
  isAuthority,
  rotateEpoch,
  rotateCMK
} from "./sessionManager.js";

import { apiFetch } from "./api.js";
import lang from "./i18n.js";
import {
  encryptGroupMessage,
  decryptGroupMessage,
  getOrCreateGroupSK,
  getGroupSK,
  distributeGroupSK
} from "./groupSessionManager.js";
// ======================================================
// CONFIG
// ======================================================
const API = "https://api.renex.id";
const MAX_MESSAGE_LENGTH = 1000;
const SEND_COOLDOWN_MS = 2000;
const deferredInboundMessages = [];
const deferredInboundIds = new Set();
// GSK-Requests: verhindert Spam (max 1 Request pro Sender pro Session)
const pendingGskRequests = new Set();

// ======================================================
// CMK v2 – Epoch Definition (GLOBAL)
// ======================================================

// ⏱️ 1 Stunde pro Epoch (stabil, push-freundlich, group-fähig)
const EPOCH_MS = 3_600_000;

// ======================================================
// DOM ELEMENTS
// ======================================================
let messagesEl;
let indicatorEl;
let unreadCountEl;
let sendBtn;
let inputEl;
let warningEl;
let titleEl;
let withUser = null;

// ======================================================
// STATE
// ======================================================
let firstLoad = true;
let unreadCount = 0;
let lastSendTime = 0;
let cooldownTimer = null;
let sendFailsafeTimer = null;
let fallbackFlushTimer = null; // Race-Guard: Fallback-CMK Flush verzögern bis Authority-CMK ankommt
let e2eReady = false;
let lastSendBtnState = null;
let sessionKeyBytes = null;   // Uint8Array(32) — current SK
let sessionCmkBytes = null;   // Uint8Array(32) — CMK (für Re-Derivation alter Epochs)
let sessionRotationIndex = 0; // aktueller Rotation-Index
let sentMessageCount = 0;     // Zähler für Rotation-Trigger

// Recovery nach IDB-Reset: falls rotationIndex=0 aber laut Backend höher → sync
async function recoverRotationIndexIfNeeded(sid) {
  if (sessionRotationIndex > 0 || isGroupConversation(withUser)) return; // nur DM + nur wenn 0
  try {
    const res = await apiFetch(`/chat/rotation-index?peer=${encodeURIComponent(withUser)}`);
    const recovered = Number(res?.rotationIndex) || 0;
    if (recovered > 0) {
      console.warn(`[rotationIndex] IDB-Reset erkannt — recovery ${recovered} vom Backend`);
      sessionRotationIndex = recovered;
      await setRotationIndex(sid, recovered);
      const skBytes = await deriveSessionKeyBytesForRotation(sessionCmkBytes, sid, recovered);
      sessionKeyBytes = skBytes;
      skCache.set(`${sid}:${recovered}`, skBytes);
    }
  } catch (e) {
    console.warn("[rotationIndex] Recovery fehlgeschlagen:", e);
  }
}
const ROTATION_THRESHOLD = 50;
const ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
let timeRotationTimer = null;
const skCache = new Map();    // "sid:rotationIndex" → Uint8Array(32)
let hasInboxKeys = false;

// ======================================================
// DEFERRED SEND QUEUE (First message before CMK)
// ======================================================
let deferredQueue = []; 
// 🔁 Flush Guards
let isFlushingDeferred = false;
let deferredBackoff = 1000;          // Start 1s
const MAX_DEFERRED_BACKOFF = 15000;  // Max 15s

// ======================================================
// SEND-BUTTON LOGIK (zentral)
// ======================================================
// ======================================================
// FIX 3 — canSend ist REIN UI
// ======================================================
function canSend() {
  return true; // UI blockiert nicht mehr wegen pending
}

function updateSendButton() {
  if (!sendBtn) return;
  sendBtn.disabled = !canSend();
}

// ======================================================
// 🔁 AUTO-RETRY für pending Messages nach Cooldown
// ======================================================
async function retryPendingIfPossible() {
  // nichts zu tun
  if (!e2eReady) return;
  if (pendingByTempId.size !== 1) return;

  const [tempId, div] = pendingByTempId.entries().next().value;
  if (!div || !div.textContent) return;

  const now = Date.now();
  if (now - lastSendTime < SEND_COOLDOWN_MS) return;

  console.log("🔁 Retry pending message nach Cooldown");

  // Text aus DOM holen (minimal & robust)
  const text = div.querySelector("div")?.textContent;
  if (!text) return;

  // pending entfernen, wir senden neu
  pendingByTempId.delete(tempId);
  div.remove();

// 🔒 DOM Guard
if (!inputEl || !sendBtn) {
  console.warn("Retry abgebrochen – DOM nicht bereit");
  return;
}

inputEl.value = text;
sendBtn.click();  
}

// ======================================================
// URL PARAMS
// ======================================================
const params = new URLSearchParams(window.location.search);
withUser = params.get("with");

// ── Sicherheit: withUser nur erlaubte Zeichen (a-z0-9_:- oder UUID) ──────
// Verhindert XSS/Injection via manipulierte URLs
const _VALID_HANDLE = /^[a-z0-9_]{1,64}$/i;
const _VALID_UUID   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const _VALID_DM_ID  = /^[a-z0-9_]{1,32}:[a-z0-9_]{1,32}$/i;
if (!withUser || !(_VALID_HANDLE.test(withUser) || _VALID_UUID.test(withUser) || _VALID_DM_ID.test(withUser))) {
  alert(lang.noChatPartner);
  throw new Error("withUser ungültig oder fehlt");
}

// Gruppenname sofort aus URL-Param setzen (verhindert UUID-Flash)
// decodeURIComponent kann werfen → absichern
let _initialGroupName = null;
try {
  const rawName = params.get("name");
  if (rawName) _initialGroupName = decodeURIComponent(rawName).slice(0, 64);
} catch {}

if (!withUser) {
  alert(lang.noChatPartner);
  throw new Error("withUser fehlt");
}

// ======================================================
// 🔔 GLOBAL CONTROL → CMK_READY Listener (Lifecycle-safe)
// ======================================================
const bc = ("BroadcastChannel" in window)
  ? new BroadcastChannel("renex-control")
  : null;

  // 🔁 Fallback für Tabs ohne BroadcastChannel Event
window.addEventListener("storage", (e) => {

  if (e.key !== "renex-control-event") return;

  try {
    const event = JSON.parse(e.newValue || "{}");

    if (event?.type !== "DELIVERED") return;

    console.log("📬 Storage delivery event", event);

    document.querySelectorAll(".me[data-id]").forEach(el => {

      const id = el.dataset.id;
      if (!id) return;

      if (el.dataset.status === "delivered") return;

      updateRenderedMessageStatus(id, "delivered");

    });

  } catch {}
});

if (bc) {
  bc.onmessage = async (e) => {
    // Signatur-Prüfung: nur Events vom eigenen Tab akzeptieren
    const bcToken = sessionStorage.getItem("renex_bc_token");
    if (!bcToken || e.data?._bcToken !== bcToken) return;

    const event = e.data;

// 🔔 LIVE DELIVERY STATUS
if (event?.type === "DELIVERED") {

  console.log("📬 Live delivery update", event);

  // alle eigenen Nachrichten im Chat prüfen
  document.querySelectorAll(".me[data-id]").forEach(el => {

    const id = el.dataset.id;
    if (!id) return;

    // Status nur upgraden
    if (el.dataset.status === "delivered") return;

    updateRenderedMessageStatus(id, "delivered");

  });

  return;
}

// 🗑️ MESSAGE DELETED (von Peer oder eigene Bestätigung)
if (event?.type === "MESSAGE_DELETED") {
  markMessageDeleted(event.messageId);
  return;
}

// ✏️ MESSAGE EDITED (von Peer)
if (event?.type === "MESSAGE_EDITED" || event?.type === "message_edited") {
  handleMessageEdited(event).catch(() => {});
  return;
}

// 😂 REACTION UPDATED (von Peer oder eigene Bestätigung via anderem Tab)
if (event?.type === "REACTION_UPDATED" || event?.type === "reaction_updated") {
  const { messageId, reactions } = event;
  if (messageId && reactions) {
    reactionsCache.set(messageId, reactions);
    const el = document.querySelector(`[data-id="${messageId}"]`);
    if (el) renderReactionBar(el, messageId);
  }
  return;
}

// 🔔 LIVE NEW MESSAGE
if (event?.type === "NEW_MESSAGE") {
  const msg = event.message;
  if (!msg) return;
  const me = getMyUser();
  // Gruppen: msg.groupId (immer) oder msg.sid (= group UUID); DM: from/to
  const isForThisChat = isGroupConversation(withUser)
    ? (msg.groupId === withUser || msg.sid === withUser)
    : ((msg.from === withUser && msg.to === me) || (msg.from === me && msg.to === withUser));
  if (isForThisChat && e2eReady) {
    const wasAtBottom = isUserAtBottom();
    processMessage(msg).then(isNew => {
      if (!isNew) return;
      if (wasAtBottom) { scrollToBottom(); unreadCount = 0; }
      else { unreadCount++; }
      updateUnreadIndicator();
      // Delivered-Status nur für DMs — Gruppen: status='sent' ist die Server-Bestätigung (✓)
      if (msg.from === withUser && !isGroupConversation(withUser)) {
        apiFetch("/chat/delivered", {
          method: "POST",
          body: JSON.stringify({ with: withUser })
        }).catch(() => {});
      }
      // Gruppen: last_read_ts im Backend aktualisieren damit Inbox korrekte Zahl zeigt
      if (isGroupConversation(withUser)) {
        _markGroupReadDebounced();
      }
    }).catch(() => {});
  }
  return;
}

  // 🔑 CMK_ROTATED: Non-Authority hat neuen CMK empfangen → SK aktualisieren
  if (event?.type === "CMK_ROTATED" && event.peer === withUser) {
    console.log("🔑 CMK_ROTATED empfangen → SK aktualisieren", event);
    try {
      const entry = await bootConversation(getMyUser(), withUser);
      if (entry?.skBytes) {
        sessionKeyBytes = entry.skBytes;
        sessionRotationIndex = entry.rotationIndex ?? sessionRotationIndex;
        sessionCmkBytes = entry.cmkBytes ?? sessionCmkBytes;
        skCache.set(`${dmSessionId(getMyUser(), withUser)}:${sessionRotationIndex}`, sessionKeyBytes);
        console.log("🔑 SK nach CMK-Rotation aktualisiert:", { rotationIndex: sessionRotationIndex });
      }
    } catch (err) {
      console.error("CMK_ROTATED handling failed", err);
    }
    return;
  }

  // 🔑 DEVICE_ADDED: Authority sendet bestehenden CMK an alle Devices (inkl. neues)
  // KEIN CMK-Rotate! Neues Device soll alte Nachrichten lesen können.
  // CMK-Rotation nur bei Device-Revoke (noch nicht implementiert).
  if (event?.type === "DEVICE_ADDED" && event.peer === withUser) {
    console.log("🔑 DEVICE_ADDED → CMK re-wrap für alle Devices:", event.peer);
    // Cache invalidieren → nächster fetchInboxKeys holt frische Devices
    invalidateInboxKeyCache(event.peer);
    const cooldownKey = `cmkRewrapCooldown:${withUser}`;
    const lastRewrap = Number(sessionStorage.getItem(cooldownKey) || 0);
    if (Date.now() - lastRewrap < 30_000) {
      console.log("⏸️ CMK Re-wrap Cooldown aktiv — übersprungen");
      return;
    }
    sessionStorage.setItem(cooldownKey, String(Date.now()));
    if (isAuthority(getMyUser(), withUser) && e2eReady && sessionCmkBytes) {
      // Bestehenden CMK für alle Devices (inkl. neues) neu wrappen und senden
      const sid = dmSessionId(getMyUser(), withUser);
      fetchInboxKeys(withUser).then(async inboxDevices => {
        if (!Array.isArray(inboxDevices) || inboxDevices.length === 0) return;
        const { wrapCMKForInboxDevices } = await import("./e2e.js");
        const peerPayloads = await wrapCMKForInboxDevices(inboxDevices.slice(-10), sessionCmkBytes);
        await apiFetch("/chat/send", {
          method: "POST",
          body: JSON.stringify({ to: withUser, e2e: true, v: 2, type: "cmk", sid, message: "__cmk__", payloads: peerPayloads })
        });
        // KV updaten: peer + eigene Devices
        let kvPayloads = peerPayloads;
        try {
          const myDevices = await fetchInboxKeys(getMyUser());
          if (Array.isArray(myDevices) && myDevices.length > 0) {
            const myPayloads = await wrapCMKForInboxDevices(myDevices.slice(-10), sessionCmkBytes);
            kvPayloads = [...peerPayloads, ...myPayloads];
          }
        } catch {}
        await apiFetch("/e2e/cmk/store", {
          method: "POST",
          body: JSON.stringify({ to: withUser, payloads: kvPayloads })
        }).catch(() => {});
        console.log("🔑 CMK re-wrapped für Peer-Devices:", inboxDevices.length, "+ eigene Devices:", kvPayloads.length - peerPayloads.length);
      }).catch(e => console.warn("⚠️ CMK re-wrap nach Device-Event fehlgeschlagen", e));
    }
    return;
  }

  // 🔑 DEVICE_ADDED_SELF: Eigenes neues Device → CMK für aktuelles Gespräch in KV ablegen
  if (event?.type === "DEVICE_ADDED_SELF") {
    if (!isAuthority(getMyUser(), withUser) || !e2eReady || !sessionCmkBytes) return;
    console.log("🔑 DEVICE_ADDED_SELF → CMK für eigene neue Devices re-wrappen:", withUser);
    // Cache invalidieren → eigene neuen Devices werden frisch geladen
    invalidateInboxKeyCache(getMyUser());
    const cooldownKey = `cmkSelfRewrapCooldown:${withUser}`;
    const lastRewrap = Number(sessionStorage.getItem(cooldownKey) || 0);
    if (Date.now() - lastRewrap < 30_000) {
      console.log("⏸️ CMK Self-Re-wrap Cooldown aktiv — übersprungen");
      return;
    }
    sessionStorage.setItem(cooldownKey, String(Date.now()));
    const sid = dmSessionId(getMyUser(), withUser);
    Promise.all([fetchInboxKeys(withUser), fetchInboxKeys(getMyUser())]).then(async ([peerDevices, myDevices]) => {
      const { wrapCMKForInboxDevices } = await import("./e2e.js");
      const peerPayloads = Array.isArray(peerDevices) && peerDevices.length > 0
        ? await wrapCMKForInboxDevices(peerDevices.slice(-10), sessionCmkBytes)
        : [];
      const myPayloads = Array.isArray(myDevices) && myDevices.length > 0
        ? await wrapCMKForInboxDevices(myDevices.slice(-10), sessionCmkBytes)
        : [];
      const kvPayloads = [...peerPayloads, ...myPayloads];
      if (kvPayloads.length === 0) return;
      if (peerPayloads.length > 0) {
        await apiFetch("/chat/send", {
          method: "POST",
          body: JSON.stringify({ to: withUser, e2e: true, v: 2, type: "cmk", sid, message: "__cmk__", payloads: peerPayloads })
        });
      }
      await apiFetch("/e2e/cmk/store", {
        method: "POST",
        body: JSON.stringify({ to: withUser, payloads: kvPayloads })
      }).catch(() => {});
      console.log("🔑 CMK self-re-wrapped: Peer-Devices:", peerPayloads.length, "/ eigene Devices:", myPayloads.length);
    }).catch(e => console.warn("⚠️ CMK self-re-wrap fehlgeschlagen", e));
    return;
  }

  // 🔑 DEVICE_REMOVED: Authority rotiert CMK → Forward Secrecy für entferntes Device
  if (event?.type === "DEVICE_REMOVED" && event.peer === withUser) {
    console.log("🔑 DEVICE_REMOVED → CMK Rotation (Forward Secrecy):", event.peer);
    if (isAuthority(getMyUser(), withUser) && e2eReady) {
      const cooldownKey = `cmkRotateCooldown:${withUser}`;
      const lastRotate = Number(sessionStorage.getItem(cooldownKey) || 0);
      if (Date.now() - lastRotate < 10_000) {
        console.log("⏸️ CMK Rotation Cooldown aktiv — übersprungen");
        return;
      }
      sessionStorage.setItem(cooldownKey, String(Date.now()));
      rotateCMK(getMyUser(), withUser, apiFetch, fetchInboxKeys)
        .then(ok => {
          if (ok) {
            console.log("✅ CMK nach Device-Removal rotiert — Forward Secrecy aktiv");
            // Session-State aktualisieren
            bootConversation(getMyUser(), withUser).then(entry => {
              if (entry?.skBytes) {
                sessionKeyBytes = entry.skBytes;
                sessionCmkBytes = entry.cmkBytes ?? sessionCmkBytes;
                sessionRotationIndex = entry.rotationIndex ?? sessionRotationIndex;
              }
            });
          }
        })
        .catch(e => console.warn("⚠️ CMK Rotation nach Device-Removal fehlgeschlagen", e));
    }
    return;
  }

  // 🔑 GSK_READY: Gruppen-Sender-Key empfangen → deferred Nachrichten entschlüsseln
  if (event?.type === "GSK_READY" && event.groupId === withUser) {
    console.log("🔑 GSK_READY → reload + flush deferred Gruppen-Nachrichten:", event.from);
    // loadMessages holt evtl. verpasste Nachrichten aus DB; flush entschlüsselt Placeholder
    loadMessages().catch(() => {}).finally(() => flushDeferredInboundMessages().catch(() => {}));
    return;
  }

  // 👋 GROUP_MEMBER_JOINED / 🚪 GROUP_MEMBER_LEFT:
  // Nicht direkt showSystemMessage — stattdessen loadMessages() triggern,
  // damit die persistierte DB-Zeile (type:"system") gerendert wird (kein Duplicate).
  if ((event?.type === "GROUP_MEMBER_JOINED" || event?.type === "GROUP_MEMBER_LEFT") && event.groupId === withUser) {
    initGroupMembersUI(withUser);
    loadMessages().catch(() => {});
    return;
  }

  // ✏️ GROUP_RENAMED: Titel sofort updaten + System-Message laden
  if (event?.type === "GROUP_RENAMED" && event.groupId === withUser) {
    if (titleEl && event.newName) titleEl.textContent = event.newName;
    loadMessages().catch(() => {});
    return;
  }

  // 🔑 REQUEST_GSK: ein Gruppen-Mitglied fehlt unser GSK → sofort re-distribuieren
  if (event?.type === "REQUEST_GSK" && event.groupId === withUser) {
    const myHandle = getMyUser();
    if (!myHandle || event.from === myHandle) return;
    console.log("🔑 REQUEST_GSK → re-distribuiere GSK an:", event.from);
    fetchInboxKeys(event.from)
      .then(devices => {
        if (!devices?.length) return;
        const tagged = devices.map(d => ({ ...d, memberHandle: event.from }));
        return distributeGroupSK(withUser, myHandle, tagged, apiFetch);
      })
      .catch(e => console.warn("⚠️ GSK re-distribute on REQUEST_GSK fehlgeschlagen:", e));
    return;
  }

  // 🗑️ AUTO-DELETE: Vorschlag / Akzeptiert / Abgelehnt / Gruppen-Admin-Änderung
  const isAdEvent = event?.type === "AUTO_DELETE_SET" &&
    (event.peer === withUser || event.groupId === withUser);
  if (isAdEvent) {
    console.log("🗑️ AUTO_DELETE_SET:", event.action, "days:", event.days);
    if (event.action === "propose") {
      showAutoDeleteProposal(event.days);
    } else if (event.action === "accept") {
      updateAutoDeleteHeaderLabel(event.days);
      showAutoDeleteBanner(`✅ Auto-Delete aktiv: ${autoDeleteLabel(event.days)}`, "success");
    } else if (event.action === "decline" || event.action === "cancel") {
      updateAutoDeleteHeaderLabel(null);
      showAutoDeleteBanner("🗑️ Auto-Delete deaktiviert", "info");
    }
    return;
  }

    if (e.data?.type !== "CMK_READY") return;
    if (e.data.peer !== withUser) return;

    console.log("🔄 CMK_READY empfangen → SessionKey aktualisieren", { wasReady: e2eReady });

    try {

      // Fallback-Flush-Timer canceln — Authority-CMK hat Vorrang (Fallback-Race-Fix)
      if (fallbackFlushTimer) {
        clearTimeout(fallbackFlushTimer);
        fallbackFlushTimer = null;
        console.log("✅ CMK_READY: Fallback-Flush-Timer gecancelt — sende mit Authority-CMK");
      }

      // CMK aus IDB laden (kann neuer CMK sein der Fallback überschrieben hat)
      const entry = await bootConversation(
        localStorage.getItem("my_user"),
        withUser
      );

      if (!entry?.skBytes) return;

      const wasReady = e2eReady;
      sessionKeyBytes = entry.skBytes; // 🔑 immer aktualisieren
      sessionCmkBytes = entry.cmkBytes ?? sessionCmkBytes;
      sessionRotationIndex = entry.rotationIndex ?? 0;
      skCache.set(`${dmSessionId(getMyUser(), withUser)}:${sessionRotationIndex}`, sessionKeyBytes);

      // Recovery nach IDB-Reset: falls rotationIndex=0 aber laut Backend höher
      await recoverRotationIndexIfNeeded(dmSessionId(getMyUser(), withUser));

      e2eReady = true;
      updateSendButton();

      if (!wasReady) {
        // Erstmals bereit: alles flushen
        await loadMessages();
        await flushDeferredQueue();
        await flushDeferredInboundMessages();
      } else {
        // CMK ausgetauscht (Fallback → Authority CMK):
        // Deferred Queue nochmals flushen (mit korrektem CMK) + Nachrichten neu laden
        await loadMessages();
        await flushDeferredQueue();  // noch ausstehende Nachrichten mit Authority-CMK senden
        await flushDeferredInboundMessages();
      }

    } catch (err) {
      console.error("CMK_READY handling failed", err);
    }
  };
}

const renderedMessageIds = new Set();   // echte Server-IDs

// ── Reply-State ───────────────────────────────────────────
let _replyState = null; // { id, from, plaintext }

const replyBar       = document.getElementById("reply-bar");
const replyBarFrom   = document.getElementById("reply-bar-from");
const replyBarText   = document.getElementById("reply-bar-text");
const replyBarCancel = document.getElementById("reply-bar-cancel");

function showReplyBar(id, from, plaintext) {
  _replyState = { id, from, plaintext };
  if (replyBarFrom) replyBarFrom.textContent = from + ": ";
  if (replyBarText) replyBarText.textContent = plaintext.slice(0, 80) + (plaintext.length > 80 ? "…" : "");
  replyBar?.classList.add("visible");
  document.getElementById("msg-input")?.focus();
}

function clearReplyBar() {
  _replyState = null;
  replyBar?.classList.remove("visible");
  if (replyBarFrom) replyBarFrom.textContent = "";
  if (replyBarText) replyBarText.textContent = "";
}

replyBarCancel?.addEventListener("click", clearReplyBar);

// ── Reaktionen ────────────────────────────────────────────
const REACTION_EMOJIS = ["👍🏽","👎🏽","😂","🔥","💀","❤️"];
// Cache: messageId → { emoji: [handles] }
const reactionsCache = new Map();

function renderReactionBar(div, messageId) {
  let bar = div.querySelector(".reaction-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "reaction-bar";
    // Nach timestamp einfügen
    const ts = div.querySelector(".timestamp");
    if (ts) ts.after(bar); else div.appendChild(bar);
  }
  bar.innerHTML = "";
  const data = reactionsCache.get(messageId) || {};
  const me = getMyUser();
  Object.entries(data).forEach(([emoji, handles]) => {
    if (!handles.length) return;
    const pill = document.createElement("button");
    pill.className = "reaction-pill" + (handles.includes(me) ? " mine" : "");
    pill.title = handles.join(", ");
    const emojiSpan = document.createElement("span");
    emojiSpan.textContent = emoji;
    const countSpan = document.createElement("span");
    countSpan.className = "reaction-count";
    countSpan.textContent = handles.length > 1 ? String(handles.length) : "";
    pill.append(emojiSpan, countSpan);
    pill.addEventListener("click", (e) => { e.stopPropagation(); sendReaction(messageId, emoji, div); });
    bar.appendChild(pill);
  });
}

async function sendReaction(messageId, emoji, div) {
  try {
    const res = await apiFetch("/chat/react", {
      method: "POST",
      body: JSON.stringify({ messageId, emoji })
    });
    if (res.reactions) {
      reactionsCache.set(messageId, res.reactions);
      renderReactionBar(div, messageId);
    }
  } catch (e) { console.warn("React failed", e); }
}

function showReactionPicker(div, messageId) {
  // Nur einen Picker gleichzeitig
  document.querySelectorAll(".reaction-picker.visible").forEach(p => {
    p.classList.remove("visible");
  });
  let picker = div.querySelector(".reaction-picker");
  if (!picker) {
    picker = document.createElement("div");
    picker.className = "reaction-picker";
    REACTION_EMOJIS.forEach(emoji => {
      const btn = document.createElement("button");
      btn.textContent = emoji;
      btn.title = emoji;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        picker.classList.remove("visible");
        sendReaction(messageId, emoji, div);
      });
      picker.appendChild(btn);
    });
    div.appendChild(picker);
  }
  picker.classList.toggle("visible");
  // Klick ausserhalb schliesst Picker
  setTimeout(() => {
    document.addEventListener("click", function close() {
      picker.classList.remove("visible");
      document.removeEventListener("click", close);
    }, { once: true });
  }, 0);
}
const pendingByTempId = new Map();      // tempId -> div
// 🔥 Status Tracking (verhindert verlorene Updates)
const renderedMessageStatus = new Map(); // messageId -> status
// 🗑️ Bereits gelöschte Nachrichten (verhindert Render nach Delete-Event)
const deletedMessageIds = new Set();
// 🔁 Retry-Zähler für deferred inbound Messages (GSK-Wartezeit)
const deferredInboundRetryCount = new Map(); // messageId → retryCount
const MAX_INBOUND_RETRIES = 4; // nach 4 Flush-Runden → permanent failed
// 🔐 Decrypt Cache: verhindert doppelte Crypto + doppelte Logs
// LRU-Eviction: ältesten Eintrag löschen statt ganzen Cache (Map iteriert in Einfügereihenfolge)
const decryptedCache = new Map(); // msg.id -> plaintext
const MAX_DECRYPT_CACHE = 2000;

// ── Inbox Preview Cache ──────────────────────────────────
// Speichert die letzte entschlüsselte Nachricht pro Konversation in localStorage
// → Inbox kann Vorschau anzeigen ohne erneuten Decrypt
function savePreviewCache(convoId, { text, ts, from }) {
  if (!convoId || !ts || typeof text !== "string") return;
  const numTs = Number(ts);
  if (!numTs) return;
  try {
    // Nie eine neuere Nachricht mit einer älteren überschreiben
    const existing = JSON.parse(localStorage.getItem(`renex_preview_${convoId}`) || "null");
    if (existing && Number(existing.ts) > numTs) return;
    localStorage.setItem(`renex_preview_${convoId}`, JSON.stringify({
      text: text.slice(0, 80), ts: numTs, from: from || ""
    }));
  } catch {}
}
function lruCacheSet(key, value) {
  if (decryptedCache.has(key)) decryptedCache.delete(key); // ans Ende verschieben (LRU)
  decryptedCache.set(key, value);
  if (decryptedCache.size > MAX_DECRYPT_CACHE) {
    decryptedCache.delete(decryptedCache.keys().next().value); // ältesten löschen
  }
}


// ======================================================
// 🔐 SESSION HANDSHAKE (Ephemeral Key Exchange)
// ======================================================

function loadPeerPublicKeyJwk(peerHandle) {
  const raw = localStorage.getItem(`e2e-peer-${peerHandle}-jwk`);
  if (!raw) return null;
  return JSON.parse(raw);
}

// ======================================================
// 🔐 E2E STEP 3.2: Peer Public Key laden & speichern
// ======================================================
async function fetchAndStorePeerPublicKey(peerHandle) {
  try {
    // 1️⃣ Erst normale Chat-Keys
    const res = await apiFetch(`/chat/keys/get?user=${peerHandle}`);
    console.log("🔍 /chat/keys/get raw:", res);

    let devices = Array.isArray(res.devices) ? res.devices : [];

    // 2️⃣ Fallback → Inbox-Key
    if (devices.length === 0) {
      console.log("ℹ️ Keine Chat-Keys – versuche Inbox-Key:", peerHandle);

      const inbox = await apiFetch(`/e2e/inbox/get?user=${peerHandle}`);

      if (!inbox || !Array.isArray(inbox.devices) || inbox.devices.length === 0) {
        console.warn("⛔ Peer hat auch keinen Inbox-Key:", peerHandle);
        return false;
      }

      devices = inbox.devices;
      console.log("📮 Inbox-Key(s) geladen:", devices.length);
    }

    // 3️⃣ EINHEITLICH speichern (egal woher)
    await idbSet(`peer-devices:${peerHandle}`, devices);

hasInboxKeys = devices.length > 0;

console.log(
  "✅ Peer Devices verfügbar:",
  peerHandle,
  devices.length,
  "| hasInboxKeys =",
  hasInboxKeys
);

return true;

  } catch (err) {
    console.warn("ℹ️ Peer Key fetch fehlgeschlagen", err);
    return false;
  }
}

// ======================================================
// 🔐 INBOX KEYS LADEN (für First Message Bootstrap)
// TTL-Cache: vermeidet redundante KV-Reads bei device_added / CMK-Rotation
// ======================================================
const inboxKeyCache = new Map(); // handle → { devices, expiresAt }
const INBOX_KEY_TTL = 30_000;   // 30s: kurz genug dass neue Devices erscheinen

export function invalidateInboxKeyCache(handle) {
  inboxKeyCache.delete(handle);
}

// Akzeptierte Kontakte für Invite-Autocomplete (lazy, gecacht pro Session)
let _cachedAcceptedContacts = null;
async function fetchAcceptedContacts() {
  if (_cachedAcceptedContacts) return _cachedAcceptedContacts;
  try {
    const data = await apiFetch("/contacts/list");
    _cachedAcceptedContacts = (data.contacts || [])
      .filter(c => c.status === "accepted")
      .map(c => c.contact_handle || c.handle || "")
      .filter(Boolean);
  } catch { _cachedAcceptedContacts = []; }
  return _cachedAcceptedContacts;
}

async function fetchInboxKeys(peerHandle) {
  // Cache-Hit?
  const cached = inboxKeyCache.get(peerHandle);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.devices;
  }

  try {
    const res = await apiFetch(`/e2e/inbox/get?user=${peerHandle}`);
    const devices = Array.isArray(res.devices) ? res.devices : [];

    // Ergebnis cachen (auch leeres Array — verhindert Hammer bei offline-User)
    inboxKeyCache.set(peerHandle, { devices, expiresAt: Date.now() + INBOX_KEY_TTL });

    if (devices.length === 0) {
      console.warn("ℹ️ Keine Inbox-Keys für", peerHandle);
      return [];
    }

    console.log("📮 Inbox-Keys geladen:", peerHandle, devices.length);
    return devices;
  } catch (e) {
    console.warn("Inbox-Key fetch failed", e);
    // Bei Fehler: alten Cache zurückgeben falls vorhanden
    return cached?.devices ?? [];
  }
}

// ======================================================
// E2E: Message entschlüsseln (robust & sicher)
// ======================================================
async function decryptMessageIfNeeded(msg, otherHandle) {

  // ── System-Messages (join/leave) → kein Decrypt nötig ──
  if (msg?.type === "system") return msg.message || msg.text || "";

    // ✅ Wenn wir diese Message schon mal erfolgreich entschlüsselt haben:
  if (msg?.id && decryptedCache.has(msg.id)) {
    return decryptedCache.get(msg.id);
  }

  // ──────────────────────────────────────────────────────────────
  // GRUPPEN-NACHRICHT: Sender Keys Protokoll (kein CMK / SessionKey)
  // ──────────────────────────────────────────────────────────────
  if (isGroupConversation(withUser)) {
    // Eigene Nachrichten: Outbox Cache (kein Decrypt nötig)
    if (msg.from === getMyUser()) {
      const cached = getCachedSentMessage(msg.id);
      if (cached !== null) return cached;
      // Cache-Miss nach Seiten-Reload → eigene Nachricht über eigenen GSK entschlüsseln
      // (IDB hat eigenen GSK gespeichert → wir können eigene Nachrichten selbst entschlüsseln)
      if (msg.ivB64 && msg.ctB64) {
        const chainIndex = typeof msg.rotationIndex === "number" ? msg.rotationIndex : 0;
        const result = await decryptGroupMessage(withUser, getMyUser(), msg.ivB64, msg.ctB64, chainIndex);
        if (typeof result === "string" && result !== "__decrypt_failed__" && msg?.id) {
          lruCacheSet(msg.id, result);
        }
        return result;
      }
      return null; // kein E2E-Payload → skip
    }
    // Kein E2E-Payload → nicht entschlüsselbar
    if (!msg.ivB64 || !msg.ctB64) return null;
    // chainIndex aus rotationIndex (im Backend so gespeichert)
    const chainIndex = typeof msg.rotationIndex === "number" ? msg.rotationIndex : 0;
    const result = await decryptGroupMessage(withUser, msg.from, msg.ivB64, msg.ctB64, chainIndex);
    // null = GSK fehlt noch → deferred (wird nach GSK_READY flush wiederholt)
    if (result === null) return null;
    // Erfolg: in Decrypt-Cache aufnehmen
    if (typeof result === "string" && result !== "__decrypt_failed__" && msg?.id) {
      lruCacheSet(msg.id, result);
    }
    return result; // Plaintext oder "__decrypt_failed__"
  }

  // ✅ Wenn E2E noch nicht ready → NICHT decrypten, NICHT warnen
if (!e2eReady || !(sessionKeyBytes instanceof Uint8Array)) {
  return null;
}

  // --------------------------------------------------
  // Control Messages → niemals decrypten
  // --------------------------------------------------
  
  // Eigene v1 Nachrichten
  if (msg.from === getMyUser() && msg.v !== 2) {
    if (typeof msg.message === "string") return msg.message;
  }

  // Kein Ciphertext
  if (typeof msg.ivB64 !== "string" || typeof msg.ctB64 !== "string") {
    return null;
  }

  try {

    const sessionId =
      msg.sid || dmSessionId(getMyUser(), otherHandle);

    // 🔄 Rotation-aware: richtigen SK für diesen Rotation-Index holen
    const msgRotationIndex = typeof msg.rotationIndex === "number" ? msg.rotationIndex : 0;
    let skForDecrypt = sessionKeyBytes; // default: current SK

    if (msgRotationIndex !== sessionRotationIndex) {
      const cacheKey = `${sessionId}:${msgRotationIndex}`;
      if (skCache.has(cacheKey) && skCache.get(cacheKey)) {
        skForDecrypt = skCache.get(cacheKey);
      } else {
        // Rotation-Map: richtigen CMK für diesen rotationIndex finden (CMK-Rotation-aware)
        const rotationMap = await getRotationMap(sessionId);
        const historicCmk = findCmkForRotationIndex(rotationMap, msgRotationIndex);
        if (historicCmk) {
          skForDecrypt = await deriveSessionKeyBytesForRotation(historicCmk, sessionId, msgRotationIndex);
          skCache.set(cacheKey, skForDecrypt);
        } else if (sessionCmkBytes) {
          // Fallback: aktueller CMK (backward-compat vor Rotation-Map)
          skForDecrypt = await deriveSessionKeyBytesForRotation(sessionCmkBytes, sessionId, msgRotationIndex);
          skCache.set(cacheKey, skForDecrypt);
        }
      }
    }

    if (!(skForDecrypt instanceof Uint8Array)) return null;

    const baseEpoch =
      typeof msg.epoch === "number"
        ? msg.epoch
        : Math.floor(msg.ts / EPOCH_MS);

    const epochsToTry = [
      baseEpoch,
      baseEpoch - 1,
      baseEpoch + 1
    ];

    for (const ep of epochsToTry) {
      try {
        const mk = await deriveMessageKey(
          skForDecrypt,
          sessionId,
          ep
        );

        const decrypted = await e2eDecrypt(
          mk,
          msg.ivB64,
          msg.ctB64
        );

if (typeof decrypted === "string") {

  // 🔏 Signatur prüfen (nur bei Peer-Nachrichten mit sig-Feld)
  let finalText = decrypted;
  if (msg.from !== getMyUser() && msg.sig && msg.deviceId) {
    const sigPub = await getSigPubForDevice(msg.from, msg.deviceId);
    if (sigPub) {
      const sigOk = await verifyMessageSig(
        msg.ivB64, msg.ctB64,
        msg.sid || sessionId, baseEpoch,  // signierte Epoch = msg.epoch, nicht Loop-var ep
        msg.sig, sigPub
      );
      if (!sigOk) {
        console.warn("🚨 Signatur-Fehler — mögliche Manipulation!", msg.id);
        finalText = "⚠️ [Nachricht konnte nicht verifiziert werden]";
      }
    }
    // kein sigPub → alte Nachricht oder Upload ausstehend → nicht warnen
  }

  // ✅ Cache setzen (vor return) — LRU-Eviction via lruCacheSet
  if (msg?.id) {
    lruCacheSet(msg.id, finalText);
  }

  console.log("🔐 MK-DECRYPT success", {
    id: msg.id,
    epoch: ep
  });

  return finalText;   // "" ist hier erlaubt!
}

      } catch {
        // try next epoch
      }
    }

    // Diagnose: mehr Kontext für Debugging
    console.warn("❌ MK decrypt failed (all epochs)", msg.id, {
      msgRotationIndex: typeof msg.rotationIndex === "number" ? msg.rotationIndex : 0,
      sessionRotationIndex,
      hasCmk: !!sessionCmkBytes,
      sid: msg.sid || "(keins)",
      computedSid: dmSessionId(getMyUser(), otherHandle)
    });

    return "__decrypt_failed__";  // 🔥 Sentinel: permanenter Fehler — NICHT deferred!

  } catch (e) {
    console.warn("❌ decrypt crash", e);
    return null;
  }
}

// ======================================================
// E2E: BASE64 HELPERS (für iv/ciphertext)
// ======================================================
function abToB64(ab) {
  const bytes = new Uint8Array(ab);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function b64ToAb(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ======================================================
// E2E: Encrypt / Decrypt (AES-GCM)
// ======================================================
async function e2eEncrypt(aesKey, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV empfohlen
  const data = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    data
  );

  return {
    ivB64: abToB64(iv.buffer),
    ctB64: abToB64(ciphertext)
  };
}

async function e2eDecrypt(aesKey, ivB64, ctB64) {
  const iv = new Uint8Array(b64ToAb(ivB64));
  const ciphertext = b64ToAb(ctB64);

  const plaintextBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    aesKey,
    ciphertext
  );

  return new TextDecoder().decode(plaintextBuf);
}

// ======================================================
// E2E: PUBLIC KEY UPLOAD (NUR HIER)
// ======================================================
async function uploadMyPublicKeyIfNeeded() {
  const deviceId = getDeviceId();

  const pub = await loadPublicKey();
  if (!pub) {
    console.warn("❌ Kein Public Key vorhanden");
    return false;
  }

  const jwk = await crypto.subtle.exportKey("jwk", pub);

  await apiFetch("/chat/keys/upload", {
    method: "POST",
    body: JSON.stringify({ jwk, deviceId })
  });

  console.log("✅ Public Key hochgeladen:", deviceId);
  return true;
}

// ======================================================
// SESSION HELPERS
// ======================================================
function getMyUser() {
  return localStorage.getItem("my_user");
}

// Gruppen-Konversation = UUID (zukünftig als withUser gesetzt)
// DM = "alice:bob" oder Handle-String
function isGroupConversation(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id));
}
// Inbox-Preview-Cache-Key: Gruppen → UUID, DMs → "alice:bob" (alphabetisch sortiert)
function previewConvoId(peer) {
  if (isGroupConversation(peer)) return peer;
  const me = (getMyUser() || "").toLowerCase();
  const p  = peer.toLowerCase();
  return me < p ? `${me}:${p}` : `${p}:${me}`;
}
// ======================================================
// DEVICE ID (STABIL PRO GERÄT)
// ======================================================
function getDeviceId() {
  let id = localStorage.getItem("device_id");
  if (!id) {
    id = "dev_" + crypto.randomUUID();
    localStorage.setItem("device_id", id);
  }
  return id;
}

// ======================================================
// FLUSH DEFERRED QUEUE (after CMK ready)
// ======================================================
async function flushDeferredQueue() {
  if (!e2eReady) return;
  if (!(sessionKeyBytes instanceof Uint8Array)) return;
if (deferredQueue.length === 0) return;

  // 🔒 Parallel-Guard
  if (isFlushingDeferred) {
    console.log("⏳ flushDeferredQueue läuft bereits");
    return;
  }

  isFlushingDeferred = true;

  console.log("🚀 Starte flushDeferredQueue:", deferredQueue.length);

  try {

    while (deferredQueue.length > 0) {

      const item = deferredQueue[0]; // 🔥 IMMER erstes Element (keine Kopie!)

      if (!(sessionKeyBytes instanceof Uint8Array) || sessionKeyBytes.length !== 32) {
        throw new Error("SessionKey fehlt");
      }

      const sessionId = dmSessionId(getMyUser(), withUser);
      const epoch = Math.floor(Date.now() / EPOCH_MS);

      const mk = await deriveMessageKey(sessionKeyBytes, sessionId, epoch);
      const { ivB64, ctB64 } = await e2eEncrypt(mk, item.text);

      // 🔏 Nachricht signieren — verhindert Backend-Manipulation von ctB64
      const sig      = await signMessage(ivB64, ctB64, sessionId, epoch);
      const deviceId = getDeviceId();

      const res = await apiFetch("/chat/send", {
        method: "POST",
        body: JSON.stringify({
          to: withUser,
          e2e: true,
          v: 2,
          sid: sessionId,
          epoch,
          ivB64,
          ctB64,
          sig,
          deviceId
        })
      });

      // 🚦 Rate Limit Handling
      if (res?.rateLimited) {

        console.warn("⏸️ Rate-Limit → Backoff:", deferredBackoff, "ms");

        await new Promise(r => setTimeout(r, deferredBackoff));

        deferredBackoff = Math.min(
          deferredBackoff * 2,
          MAX_DEFERRED_BACKOFF
        );

        continue; // 🔁 Versuche gleiche Nachricht erneut
      }

      // ✅ Erfolg → Backoff reset
      deferredBackoff = 1000;

      const saved = res?.message;

      if (item.tempId) {
        const div = pendingByTempId.get(item.tempId);
        if (div && saved?.id) {
          div.classList.remove("pending");
          div.dataset.id = saved.id;
          renderedMessageIds.add(saved.id);
        }
        pendingByTempId.delete(item.tempId);
      }

      // 🔥 WICHTIG: Erst jetzt entfernen
      deferredQueue.shift();

      await new Promise(r => setTimeout(r, SEND_COOLDOWN_MS));
    }

  } catch (e) {
    console.error("❌ flushDeferredQueue Fehler:", e);
  }

  isFlushingDeferred = false;
  updateSendButton();
}

// ======================================================
// FLUSH DEFERRED INBOUND (Messages received before CMK)
// ======================================================
// ── Group mark-read debounced ─────────────────────────────
// Verhindert DB-Spam bei vielen Nachrichten im Burst
let _markGroupReadTimer = null;
function _markGroupReadDebounced() {
  if (!isGroupConversation(withUser)) return;
  clearTimeout(_markGroupReadTimer);
  _markGroupReadTimer = setTimeout(() => {
    // Neueste ts aus dem DOM lesen
    const bubbles = document.querySelectorAll("#messages [data-ts]");
    let maxTs = 0;
    bubbles.forEach(b => { const t = Number(b.dataset.ts || 0); if (t > maxTs) maxTs = t; });
    if (!maxTs) return;
    const prevTs = Number(localStorage.getItem(`renex_group_read_${withUser}`) || 0);
    if (maxTs <= prevTs) return; // nichts Neues
    localStorage.setItem(`renex_group_read_${withUser}`, String(maxTs));
    apiFetch("/groups/mark-read", {
      method: "POST",
      body: JSON.stringify({ groupId: withUser, lastReadTs: maxTs })
    }).catch(() => {});
  }, 800); // 800ms nach letzter Aktivität
}

async function flushDeferredInboundMessages() {
if (!e2eReady) return;
// DMs brauchen sessionKeyBytes; Gruppen nutzen GSK (kein SK nötig)
if (!isGroupConversation(withUser) && !(sessionKeyBytes instanceof Uint8Array)) return;
if (deferredInboundMessages.length === 0) return;
  console.log("📥 Flush deferred INBOUND", deferredInboundMessages.length);

  const queue = [...deferredInboundMessages];
  deferredInboundMessages.length = 0;

  // Phase 1: alle Decryptions parallel ausführen (Crypto ist CPU-bound, kein Vorteil aus Sequenz)
  const decrypted = await Promise.allSettled(
    queue.map(m => decryptMessageIfNeeded(m, withUser).catch(e => {
      console.warn("Deferred inbound decrypt failed", e);
      return "__decrypt_failed__";
    }))
  );

  // Phase 2: Ergebnisse sequenziell verarbeiten (DOM-Reihenfolge + Re-Queue)
  for (let i = 0; i < queue.length; i++) {
    const m = queue[i];
    const text = decrypted[i].status === "fulfilled" ? decrypted[i].value : "__decrypt_failed__";

    console.debug("[flush]", { from: m.from, ts: m.ts, result: text === null ? "null(deferred)" : text === "__decrypt_failed__" ? "FAILED" : text === "__control__" ? "control" : "OK:"+String(text).slice(0,20) });

    if (text === null || text === "__control__") {
      // GSK noch nicht verfügbar → Retry-Zähler erhöhen
      const retries = (deferredInboundRetryCount.get(m.id) || 0) + 1;
      deferredInboundRetryCount.set(m.id, retries);
      if (retries >= MAX_INBOUND_RETRIES) {
        // Nach MAX_INBOUND_RETRIES Versuchen → permanent failed
        const el = document.querySelector(`[data-id="${m.id}"]`);
        if (el) {
          const textEl = el.querySelector("div:not(.sender-name):not(.timestamp)");
          if (textEl) textEl.textContent = decryptFailedText(m.ts);
        }
        deferredInboundIds.delete(m.id);
        deferredInboundRetryCount.delete(m.id);
      } else {
        deferredInboundMessages.push(m); // nochmal versuchen
      }
      continue;
    }

    if (text === "__decrypt_failed__") {
      // Gruppen: nochmal GSK anfordern (bis MAX_INBOUND_RETRIES)
      if (isGroupConversation(withUser) && m.from && m.from !== getMyUser()) {
        const retries = deferredInboundRetryCount.get(m.id) || 0;
        if (retries < MAX_INBOUND_RETRIES) {
          deferredInboundRetryCount.set(m.id, retries + 1);
          deferredInboundMessages.push(m); // erneut in Queue
          requestGSKFrom(withUser, m.from).catch(() => {});
          continue;
        }
      }
      const el = document.querySelector(`[data-id="${m.id}"]`);
      if (el) {
        const textEl = el.querySelector("div:not(.sender-name):not(.timestamp)");
        if (textEl) textEl.textContent = decryptFailedText(m.ts);
      }
      if (m?.id) deferredInboundIds.delete(m.id);
      deferredInboundRetryCount.delete(m.id);
      continue;
    }

    if (m?.id) {
      renderedMessageIds.add(m.id);
      deferredInboundIds.delete(m.id);
      deferredInboundRetryCount.delete(m.id);
    }

    // Existierende Platzhalter-Bubble updaten (kein Duplikat)
    const existingBubble = m.id ? document.querySelector(`[data-id="${m.id}"]`) : null;
    if (existingBubble) {
      const textEl = existingBubble.querySelector("div:not(.sender-name):not(.timestamp)");
      if (textEl) textEl.textContent = text;
    } else {
      renderMessage({ id: m.id, from: m.from, message: text, ts: m.ts, status: m.status });
    }
    savePreviewCache(previewConvoId(withUser), { text, ts: m.ts || Date.now(), from: m.from });
  }

  scrollToBottom();

  // 📖 Gruppen: mark-read nach flush aktualisieren
  // (für Nachrichten die via WebSocket ankamen, nicht via loadMessages)
  if (isGroupConversation(withUser)) {
    _markGroupReadDebounced();
  }
}

// ======================================================
// REQUEST_GSK — Pull-Mechanismus wenn GSK eines Senders fehlt
// Sendet "request_gsk" Control-Message an den Sender (über Gruppen-Routing)
// Der Sender antwortet mit distributeGroupSK() gezielt für unsere Devices
// ======================================================
async function requestGSKFrom(groupId, senderHandle) {
  const key = `${groupId}:${senderHandle}`;
  if (pendingGskRequests.has(key)) return; // max 1 Request pro Sender pro Session
  pendingGskRequests.add(key);
  try {
    await apiFetch("/chat/send", {
      method: "POST",
      body: JSON.stringify({
        to:            senderHandle,
        convoId:       groupId,
        type:          "request_gsk",
        requestedFrom: senderHandle  // Nur der Angefragte antwortet (Handler-Filter)
      })
    });
    console.log("📩 GSK angefordert von:", senderHandle, "in Gruppe:", groupId);
  } catch (e) {
    console.warn("⚠️ requestGSKFrom fehlgeschlagen:", e);
    // 429 (Rate-Limit) oder 403 (nicht Mitglied) → kein Retry
    const status = e?.status ?? e?.code;
    if (!status || (status !== 429 && status !== 403)) {
      pendingGskRequests.delete(key); // Retry nur bei echtem Netzwerkfehler
    }
  }
}

// ======================================================
// START
// ======================================================
function startChat() {

// ==========================================
// 🔄 CHAT UI STATE RESET
// ==========================================
console.log("🔄 Chat UI State reset");

  // ------------------------------------------
  // danach erst DOM / UI / Polling
  // ------------------------------------------ 
  messagesEl = document.getElementById("messages");
  indicatorEl = document.getElementById("new-indicator");
  unreadCountEl = document.getElementById("unread-count");
  sendBtn = document.getElementById("send-btn");
  updateSendButton();
  console.log("🔒 Send initial geprüft");
  inputEl = document.getElementById("msg-input");
  warningEl = document.getElementById("length-warning");
  titleEl = document.getElementById("chat-with");

  if (!messagesEl || !indicatorEl || !unreadCountEl || !sendBtn || !inputEl || !titleEl) {
    console.error("DOM nicht bereit");
    return;
  }

  if (sendBtn.dataset.bound === "1") return;
sendBtn.dataset.bound = "1";

  titleEl.textContent = _initialGroupName || withUser;
if (firstLoad) {
  messagesEl.innerHTML = "";
}

  // =========================
  // SEND BUTTON
  // =========================
  sendBtn.addEventListener("click", async () => {
    const text = inputEl.value.trim();

    if (!text) return;

// ==========================================
// E2E NOT READY → DEFERRED SEND
// ==========================================
if (!e2eReady) {

  const tempId = `bootstrap-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;

  const div = renderMessage({
    from: getMyUser(),
    message: text,
    ts: Date.now(),
    tempId,
    status: "pending"
  });

  if (div) pendingByTempId.set(tempId, div);

  deferredQueue.push({ text, tempId });

  inputEl.value = "";
  scrollToBottom();
  updateSendButton();

  console.log("🟡 Nachricht deferred – E2E noch nicht bereit");

  return;
}

if (!isGroupConversation(withUser) && !(sessionKeyBytes instanceof Uint8Array)) {
  console.warn("⚠️ SessionKey fehlt trotz e2eReady");
  return;
}

    // Rate limit
    const now = Date.now();
if (now - lastSendTime < SEND_COOLDOWN_MS) {
  console.log("⏸️ Cooldown aktiv – Send blockiert");
  showCooldownWarning();
  return;
}
    lastSendTime = now;

    // 🧯 Notfall-Failsafe: Button niemals dauerhaft blockieren
    if (sendFailsafeTimer) clearTimeout(sendFailsafeTimer);
    sendFailsafeTimer = setTimeout(() => {
    console.warn("🧯 Send-Failsafe ausgelöst");
    pendingByTempId.clear();
    updateSendButton(); // ✅ NUR freigeben wenn E2E ready
    }, 15000);
    
    // Optimistic UI
    const tempId = `tmp-${now}-${Math.random().toString(16).slice(2)}`;
    const pendingDiv = renderMessage({
      from: getMyUser(),
      message: text,
      tempId,
      status: "pending"
    });
    if (pendingDiv) pendingByTempId.set(tempId, pendingDiv);

    inputEl.value = "";
    clearReplyBar(); // Reply-State nach dem Senden zurücksetzen
    scrollToBottom();

    // 🔐 SAFETY: merkt, ob der Send-Vorgang sauber beendet wurde

try {

// ======================================================
// SEND PATH — Gruppe: Sender Keys / DM: CMK v2
// ======================================================
let res;

if (isGroupConversation(withUser)) {

  // ── GRUPPE ─────────────────────────────────────────
  const encrypted = await encryptGroupMessage(withUser, getMyUser(), text);

  // Reply-Preview E2E verschlüsseln (Gruppe: gleicher GSK)
  let replyFields = {};
  if (_replyState) {
    const replyEncrypted = await encryptGroupMessage(withUser, getMyUser(), _replyState.plaintext.slice(0, 100));
    replyFields = { replyToId: _replyState.id, replyFrom: _replyState.from, replyIv: replyEncrypted.ivB64, replyCt: replyEncrypted.ctB64 };
  }

  res = await apiFetch("/chat/send", {
    method: "POST",
    body: JSON.stringify({
      to:           getMyUser(),
      convoId:      withUser,
      message:      "",
      e2e:          true,
      v:            2,
      sid:          withUser,
      epoch:        Math.floor(Date.now() / EPOCH_MS),
      ivB64:        encrypted.ivB64,
      ctB64:        encrypted.ctB64,
      rotationIndex: encrypted.chainIndex,
      ...replyFields
    })
  });

} else {

  // ── DM: CMK v2 ─────────────────────────────────────

  // 1️⃣ Session-ID (deterministisch)
  const sessionId = dmSessionId(getMyUser(), withUser);

  // 2️⃣ Epoch bestimmen (z. B. 1 Stunde)
  const epoch = Math.floor(Date.now() / EPOCH_MS);

  // 3️⃣ Message Key aus Session Key ableiten
  const mk = await deriveMessageKey(
    sessionKeyBytes,
    sessionId,
    epoch
  );

  // 4️⃣ Mit MK verschlüsseln
  const { ivB64, ctB64 } = await e2eEncrypt(mk, text);

  // Reply-Preview E2E verschlüsseln (DM: gleicher MK)
  let replyFieldsDM = {};
  if (_replyState) {
    const { ivB64: rIv, ctB64: rCt } = await e2eEncrypt(mk, _replyState.plaintext.slice(0, 100));
    replyFieldsDM = { replyToId: _replyState.id, replyFrom: _replyState.from, replyIv: rIv, replyCt: rCt };
  }

  res = await apiFetch("/chat/send", {
    method: "POST",
    body: JSON.stringify({
      to: withUser,
      message: "",
      e2e: true,
      v: 2,
      sid: sessionId,
      epoch,
      rotationIndex: sessionRotationIndex,
      ivB64,
      ctB64,
      ...replyFieldsDM
    })
  });

}

// 🔧 FIX SCHRITT 3 — 429 = warten, NICHT fehlschlagen
if (res?.rateLimited) {
  console.warn("⏸️ Rate-Limit aktiv – Nachricht bleibt pending");

  // ⏱️ lastSendTime zurücksetzen, damit Cooldown korrekt ist
  lastSendTime = Date.now();

  showCooldownWarning();

  // 🔴 WICHTIG:
  // - NICHT pending löschen
  // - NICHT failed setzen
  // - NICHT aus deferredQueue entfernen
  updateSendButton();
  return;
}

// ✅ Erfolg
const saved = res.message;

if (saved?.id) {
  cacheSentMessage(saved.id, text);
  savePreviewCache(previewConvoId(withUser), { text, ts: saved.ts || Date.now(), from: getMyUser() });

  // 📖 Gruppen: eigene gesendete Nachrichten als "gelesen" markieren
  // → Inbox zeigt keinen Badge für eigene Nachrichten
  if (isGroupConversation(withUser) && saved.ts) {
    localStorage.setItem(`renex_group_read_${withUser}`, String(saved.ts));
    apiFetch("/groups/mark-read", {
      method: "POST",
      body: JSON.stringify({ groupId: withUser, lastReadTs: saved.ts })
    }).catch(() => {});
  }

  // 🔄 CMK Rotation-Trigger (nur DMs, nur Authority, alle ROTATION_THRESHOLD Nachrichten)
  if (!isGroupConversation(withUser)) {
    sentMessageCount++;
    if (isAuthority(getMyUser(), withUser) && sentMessageCount >= ROTATION_THRESHOLD) {
      sentMessageCount = 0;
      doRotationAndRefresh().catch(e => console.warn("⚠️ rotateEpoch failed", e));
    }
  }
}

// 🔓 pending → sent auflösen
const div = pendingByTempId.get(tempId);
if (div) {
  div.classList.remove("pending");
  div.dataset.id = saved.id;          // echte Server-ID
  div.dataset.status = "sent";
  renderedMessageIds.add(saved.id);   // gegen Duplikate beim Polling
  pendingByTempId.delete(tempId);     // ⬅️ DAS IST DER SCHLÜSSEL

  // 🗑️ Delete-Button nachträglich hinzufügen (war während "pending" blockiert)
  if (!div.querySelector(".delete-btn")) {
    const delBtn = document.createElement("button");
    delBtn.className = "delete-btn";
    delBtn.title = lang.deleteMessageTitle;
    delBtn.textContent = "×";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(lang.confirmDeleteMessage)) deleteMessage(saved.id);
    });
    div.appendChild(delBtn);
  }
}

// 🕒 Timestamp nachträglich setzen
if (div && saved?.ts) {
  const timeEl = div.querySelector(".timestamp");
  if (timeEl) {
    timeEl.textContent = formatTimestamp(saved.ts);
  }
}


} catch (err) {
  // 🔴 echter Fehler (500 etc.)
  const div = pendingByTempId.get(tempId);
  if (div) {
    div.classList.remove("pending");
    div.classList.add("failed");
  }

  pendingByTempId.delete(tempId);

  alert(lang.sendFailed);
  console.error(err);
} finally {
  // 🧹 Failsafe sauber beenden
  if (sendFailsafeTimer) {
    clearTimeout(sendFailsafeTimer);
    sendFailsafeTimer = null;
  }

// Nur löschen wenn wirklich erledigt
// (success oder echter Fehler)

updateSendButton();
}
});

  // =========================
  // ENTER / SHIFT+ENTER
  // =========================
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

  // Fokus sofort auf das Eingabefeld setzen
  inputEl.focus();
// =========================
// MESSAGE LENGTH CHECK
// =========================
inputEl.addEventListener("input", () => {
  const len = inputEl.value.length;

  // ❌ Zu lang → immer blockieren
  if (len >= MAX_MESSAGE_LENGTH) {
    warningEl.textContent = lang.maxLengthReached(MAX_MESSAGE_LENGTH);
    warningEl.className = "error";
    return;
  }

  // ⚠️ Warnbereich
  if (len >= MAX_MESSAGE_LENGTH - 100) {
    warningEl.textContent = lang.charCounter(len, MAX_MESSAGE_LENGTH);
    warningEl.className = "warn";
  } else {
    warningEl.textContent = "";
    warningEl.className = "";
  }

  // 🔐 ENTSCHEIDUNG ZENTRAL
updateSendButton();
});  

  // =========================
  // INDICATOR CLICK
  // =========================
  indicatorEl.addEventListener("click", () => {
    scrollToBottom();
    unreadCount = 0;
    updateUnreadIndicator();
  });

  // =========================
  // SCROLL
  // =========================
  messagesEl.addEventListener("scroll", () => {
    if (isUserAtBottom()) {
      unreadCount = 0;
      updateUnreadIndicator();
    }
  });

  console.log("DOM OK");
  
  if (!messagesEl) {
  console.warn("⛔ Polling blockiert – DOM nicht bereit");
  return;
}
}

// ======================================================
// HELPERS
// ======================================================
function showSystemMessage(text) {
  if (!messagesEl) return;

  const div = document.createElement("div");
  div.className = "system";
  div.textContent = text;

  messagesEl.appendChild(div);
  scrollToBottom();
}

function isUserAtBottom() {
  if (!messagesEl) return true; // ⬅️ WICHTIG
  const threshold = 80;
  const distance =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  return distance <= threshold;
}

// ======================================================
// 🗑️ AUTO-DELETE UI
// ======================================================
function autoDeleteLabel(days) {
  if (!days) return "Aus";
  const map = { 1: "1 Tag", 7: "1 Woche", 28: "4 Wochen", 90: "90 Tage" };
  return map[days] ?? `${days} Tage`;
}

function showAutoDeleteBanner(text, type = "info") {
  let banner = document.getElementById("auto-delete-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "auto-delete-banner";
    banner.style.cssText = "position:sticky;top:0;z-index:10;padding:8px 16px;font-size:13px;text-align:center;transition:opacity 0.3s;";
    document.getElementById("messages")?.prepend(banner);
  }
  banner.style.background = type === "success" ? "var(--accent)" : "var(--bg-panel)";
  banner.style.color = type === "success" ? "#fff" : "var(--text-secondary)";
  banner.textContent = text;
  banner.style.display = "block";
  setTimeout(() => { banner.style.opacity = "0"; setTimeout(() => banner.remove(), 300); }, 4000);
}

function showAutoDeleteProposal(days) {
  let bar = document.getElementById("auto-delete-proposal");
  if (bar) bar.remove();
  bar = document.createElement("div");
  bar.id = "auto-delete-proposal";
  bar.style.cssText = "position:sticky;top:0;z-index:10;padding:10px 16px;background:var(--bg-panel);border-bottom:1px solid var(--border-panel);display:flex;align-items:center;gap:10px;font-size:13px;";
  // XSS-safe: DOM-Konstruktion statt innerHTML mit User-Daten
  const adTextSpan = document.createElement("span");
  adTextSpan.style.flex = "1";
  const adStrong1 = document.createElement("strong");
  adStrong1.textContent = withUser;
  const adStrong2 = document.createElement("strong");
  adStrong2.textContent = autoDeleteLabel(days);
  adTextSpan.append("🗑️ ", adStrong1, " schlägt Auto-Delete vor: ", adStrong2);
  const adAcceptBtn = document.createElement("button");
  adAcceptBtn.id = "ad-accept";
  adAcceptBtn.style.cssText = "padding:4px 12px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;";
  adAcceptBtn.textContent = "Akzeptieren";
  const adDeclineBtn = document.createElement("button");
  adDeclineBtn.id = "ad-decline";
  adDeclineBtn.style.cssText = "padding:4px 12px;background:transparent;color:var(--text-secondary);border:1px solid var(--border-panel);border-radius:6px;cursor:pointer;";
  adDeclineBtn.textContent = "Ablehnen";
  bar.append(adTextSpan, adAcceptBtn, adDeclineBtn);
  document.getElementById("messages")?.prepend(bar);

  bar.querySelector("#ad-accept").addEventListener("click", async () => {
    try {
      await apiFetch("/chat/auto-delete", { method: "POST", body: JSON.stringify({ peer: withUser, action: "accept", days }) });
      bar.remove();
      showAutoDeleteBanner(`✅ Auto-Delete aktiv: ${autoDeleteLabel(days)}`, "success");
      updateAutoDeleteHeaderLabel(days);
    } catch (e) { console.warn("Auto-Delete accept fehlgeschlagen", e); }
  });

  bar.querySelector("#ad-decline").addEventListener("click", async () => {
    try {
      await apiFetch("/chat/auto-delete", { method: "POST", body: JSON.stringify({ peer: withUser, action: "decline" }) });
      bar.remove();
      showAutoDeleteBanner("❌ Auto-Delete abgelehnt", "info");
    } catch (e) { console.warn("Auto-Delete decline fehlgeschlagen", e); }
  });
}

let _autoDeleteDays = null; // aktuelles Auto-Delete Setting (Tage)

function isAutoDeleted(ts) {
  if (!_autoDeleteDays || !ts) return false;
  return (Date.now() - Number(ts)) > (_autoDeleteDays * 86_400_000);
}

function decryptFailedText(ts) {
  return isAutoDeleted(ts) ? "🗑️ Nachricht gelöscht" : lang.decryptFailed;
}

function updateAutoDeleteHeaderLabel(days) {
  _autoDeleteDays = days || null;
  const lbl = document.getElementById("chat-autodelete-label");
  if (lbl) lbl.textContent = days ? autoDeleteLabel(days) : "Aus";

  // Aktive Option im Submenu mit ✓ markieren
  document.querySelectorAll(".chat-ad-opt").forEach(el => {
    const v = el.dataset.days === "" ? null : Number(el.dataset.days);
    const isActive = v === days;
    el.style.fontWeight = isActive ? "700" : "400";
    el.textContent = el.textContent.replace(" ✓", "") + (isActive ? " ✓" : "");
  });
}

async function initAutoDeleteUI() {
  updateAutoDeleteHeaderLabel(null); // Default: Aus

  const isGroup = isGroupConversation(withUser);
  let amGroupAdmin = false;

  // Aktuelles Setting laden
  try {
    if (isGroup) {
      const s = await apiFetch(`/groups/auto-delete?groupId=${encodeURIComponent(withUser)}`);
      if (s?.status === "active") updateAutoDeleteHeaderLabel(s.days);
      amGroupAdmin = s?.myRole === "admin";
    } else {
      const s = await apiFetch(`/chat/auto-delete?peer=${encodeURIComponent(withUser)}`);
      if (s?.status === "active") updateAutoDeleteHeaderLabel(s.days);
      if (s?.status === "pending" && s?.proposed_by !== getMyUser()) showAutoDeleteProposal(s.days);
    }
  } catch {}

  // ⋮ Menü-Button
  const menuBtn = document.getElementById("chat-menu-btn");
  const menuDropdown = document.getElementById("chat-menu-dropdown");
  const adSubmenu = document.getElementById("chat-autodelete-submenu");
  const adMenuItem = document.getElementById("chat-menu-autodelete");

  // Für Gruppen: Admin-only Optionen sichtbar/versteckt
  const renameMenuItem = document.getElementById("chat-menu-rename");
  if (isGroup && renameMenuItem) renameMenuItem.style.display = amGroupAdmin ? "" : "none";

  // Auto-Delete im Dropdown: Admin → änderbar, Mitglied → read-only (sichtbar)
  if (isGroup && adMenuItem) {
    if (!amGroupAdmin) {
      // Nicht-Admin: Item anzeigen aber read-only (kein Submenu, kein Hover-Cursor)
      adMenuItem.style.cursor = "default";
      adMenuItem.style.opacity = "0.75";
      if (adSubmenu) adSubmenu.style.display = "none";
      adMenuItem.addEventListener("click", (e) => e.stopPropagation(), { capture: true });
      // Hint "(Admin)" einblenden
      const hint = document.getElementById("chat-autodelete-readonly-hint");
      if (hint) hint.style.display = "inline";
    }
  }

  // Rename-Handler (nur einmal setzen)
  if (isGroup && amGroupAdmin && renameMenuItem && !renameMenuItem._listenerSet) {
    renameMenuItem._listenerSet = true;
    renameMenuItem.addEventListener("click", async () => {
      if (menuDropdown) menuDropdown.style.display = "none";
      const titleEl = document.getElementById("chat-with");
      const currentName = titleEl?.textContent.trim() || "";
      const newName = prompt("Gruppenname:", currentName);
      if (!newName || newName.trim() === currentName) return;
      try {
        await apiFetch("/groups/rename", {
          method: "POST",
          body: JSON.stringify({ groupId: withUser, name: newName.trim() })
        });
        if (titleEl) titleEl.textContent = newName.trim();
      } catch (e) {
        alert("Umbenennen fehlgeschlagen: " + (e.message || e));
      }
    });
  }

  if (menuBtn && menuDropdown) {
    const openMenu  = () => { menuDropdown.style.display = "block"; };
    const closeMenu = () => { menuDropdown.style.display = "none"; if (adSubmenu) adSubmenu.style.display = "none"; };

    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      menuDropdown.style.display === "block" ? closeMenu() : openMenu();
    });

    menuDropdown.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", closeMenu);
  }

  // Auto-Delete Submenu toggle
  adMenuItem?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!adSubmenu) return;
    adSubmenu.style.display = adSubmenu.style.display === "block" ? "none" : "block";
  });

  // 🔔 Notifications Mute Toggle
  const muteItem   = document.getElementById("chat-menu-mute");
  const muteStatus = document.getElementById("chat-mute-status");
  const muteLabel  = document.getElementById("chat-mute-label");

  const convoId = isGroup ? withUser : (() => {
    const [a, b] = [getMyUser(), withUser].sort();
    return `${a}:${b}`;
  })();

  let _isMuted = false;

  function updateMuteUI(muted) {
    _isMuted = muted;
    if (muteLabel)  muteLabel.textContent  = muted ? "🔕 Benachrichtigungen" : "🔔 Benachrichtigungen";
    if (muteStatus) {
      muteStatus.textContent  = muted ? "Aus" : "An";
      muteStatus.style.color  = muted ? "var(--text-secondary)" : "var(--accent)";
    }
  }

  // Aktuellen Mute-Status laden
  try {
    const { muted: mutedList } = await apiFetch("/notifications/muted");
    updateMuteUI((mutedList || []).includes(convoId));
  } catch {}

  muteItem?.addEventListener("click", async (e) => {
    e.stopPropagation();
    const newMuted = !_isMuted;
    try {
      await apiFetch("/notifications/mute", {
        method: "POST",
        body: JSON.stringify({ convoId, mute: newMuted })
      });
      updateMuteUI(newMuted);
      // Inbox-Mute-Cache invalidieren → nächster Load holt frischen Stand
      localStorage.setItem("renex_muted_cache_ts", "0");
    } catch (err) { console.warn("Mute toggle failed:", err); }
  });

  // Auto-Delete Optionen
  document.querySelectorAll(".chat-ad-opt").forEach(el => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const days = el.dataset.days === "" ? null : Number(el.dataset.days);
      menuDropdown.style.display = "none";
      if (adSubmenu) adSubmenu.style.display = "none";
      try {
        if (isGroup) {
          // Admin setzt direkt — kein Konsens nötig
          await apiFetch("/groups/auto-delete", { method: "POST", body: JSON.stringify({ groupId: withUser, days }) });
          updateAutoDeleteHeaderLabel(days);
          showAutoDeleteBanner(days ? `✅ Auto-Delete: ${autoDeleteLabel(days)}` : "🗑️ Auto-Delete deaktiviert", "success");
        } else {
          // DM: Konsens-Vorschlag senden
          const action = days === null ? "cancel" : "propose";
          await apiFetch("/chat/auto-delete", { method: "POST", body: JSON.stringify({ peer: withUser, action, days }) });
          updateAutoDeleteHeaderLabel(days);
          if (action === "cancel") {
            showAutoDeleteBanner("🗑️ Auto-Delete deaktiviert", "info");
          } else {
            showAutoDeleteBanner(`📤 Vorschlag gesendet: ${autoDeleteLabel(days)}`, "info");
          }
        }
      } catch (err) { console.warn("Auto-Delete fehlgeschlagen", err); }
    });
  });
}

// ======================================================
// 🏘️ GRUPPE: Member-Liste + Einladen im Chat-Header
// ======================================================
async function initGroupMembersUI(groupId) {
  const membersItem  = document.getElementById("group-members-item");
  const memberList   = document.getElementById("group-member-list");
  const inviteItem   = document.getElementById("group-invite-item");
  const inviteInput  = document.getElementById("group-invite-input");
  const inviteBtn    = document.getElementById("group-invite-btn");
  const leaveItem    = document.getElementById("group-leave-item");
  const leaveBtn     = document.getElementById("group-leave-btn");

  if (!membersItem || !memberList || !inviteItem) return;

  // Sichtbar machen (nur für Gruppen)
  membersItem.style.display = "block";
  inviteItem.style.display  = "block";
  if (leaveItem) leaveItem.style.display = "block";

  // Gruppe verlassen
  if (leaveBtn) {
    leaveBtn.onclick = async () => {
      const groupName = titleEl?.textContent || groupId;
      if (!confirm(lang.confirmLeaveGroup(groupName))) return;
      leaveBtn.disabled = true;
      try {
        await apiFetch("/groups/leave", { method: "POST", body: JSON.stringify({ groupId }) });
        window.location.href = "/inbox.html";
      } catch (e) {
        alert(lang.leaveFailed + (e.message || ""));
        leaveBtn.disabled = false;
      }
    };
  }

  // Mitgliederliste laden
  let _memberHandles = []; // Array für Autocomplete-Dedup

  async function refreshMembers() {
    try {
      const res = await apiFetch(`/groups/members?groupId=${encodeURIComponent(groupId)}`);
      const members = res.members || [];

      // Gruppenname in Header setzen
      if (res.group?.name && titleEl) {
        titleEl.textContent = res.group.name;
      }

      _memberHandles = members.map(m => m.member_handle);

      const myContacts = await fetchAcceptedContacts();
      const myHandle   = getMyUser();
      const amAdmin    = members.find(m => m.member_handle === myHandle)?.role === "admin";

      // Rename-Handler wird in initAutoDeleteUI() gesetzt (dort ist menuDropdown im Scope)

      memberList.innerHTML = "";
      for (const m of members) {
        const li = document.createElement("li");
        li.style.cssText = "font-size:13px;padding:4px 0;display:flex;align-items:center;gap:6px;justify-content:space-between;";

        const isMe = m.member_handle === myHandle;
        const isAdmin = m.role === "admin";

        const nameSpan = document.createElement("span");
        nameSpan.style.cssText = "display:flex;align-items:center;gap:6px;";

        const nameText = document.createElement("span");
        nameText.textContent = `${m.member_handle}${isMe ? " (Du)" : ""}`;
        nameSpan.appendChild(nameText);

        if (isAdmin) {
          const pill = document.createElement("span");
          pill.textContent = "Admin";
          pill.style.cssText = "font-size:10px;font-weight:600;padding:1px 6px;border-radius:20px;background:color-mix(in srgb,var(--accent-voice) 18%,transparent);color:var(--accent-voice);letter-spacing:0.03em;flex-shrink:0;";
          nameSpan.appendChild(pill);
        }

        li.appendChild(nameSpan);

        if (!isMe) {
          const isContact = myContacts.includes(m.member_handle);
          const addBtn = document.createElement("button");
          addBtn.style.cssText = "font-size:11px;padding:2px 7px;border-radius:5px;border:1px solid var(--border-subtle);background:var(--bg-panel-alt);color:var(--text-muted);cursor:pointer;white-space:nowrap;flex-shrink:0;transition:opacity 0.15s;";

          if (isContact) {
            addBtn.textContent = "✓ Kontakt";
            addBtn.disabled = true;
            addBtn.style.opacity = "0.45";
          } else {
            addBtn.textContent = "+ Anfragen";
            addBtn.addEventListener("click", async (e) => {
              e.stopPropagation();
              addBtn.disabled = true;
              addBtn.textContent = "…";
              try {
                const r = await apiFetch("/contacts/request", {
                  method: "POST",
                  body: JSON.stringify({ contact: m.member_handle })
                });
                if (r.status === "already_exists" || r.status === "accepted") {
                  addBtn.textContent = "✓ Kontakt";
                  _cachedAcceptedContacts = null; // Cache invalidieren
                } else if (r.status === "already_pending") {
                  addBtn.textContent = "✓ Ausstehend";
                } else {
                  addBtn.textContent = "✓ Gesendet";
                }
                addBtn.style.opacity = "0.5";
              } catch {
                addBtn.textContent = "✗ Fehler";
                setTimeout(() => {
                  addBtn.textContent = "+ Anfragen";
                  addBtn.disabled = false;
                  addBtn.style.opacity = "1";
                }, 2000);
              }
            });
          }
          li.appendChild(addBtn);
        }

        memberList.appendChild(li);
      }
    } catch (e) {
      console.warn("refreshMembers fehlgeschlagen", e);
    }
  }

  await refreshMembers();

  // Einladen
  inviteBtn?.addEventListener("click", async () => {
    const handle = inviteInput?.value.trim().toLowerCase();
    if (!handle) return;
    inviteBtn.disabled = true;
    try {
      const res = await apiFetch("/groups/invite", {
        method: "POST",
        body: JSON.stringify({ groupId, handle })
      });
      if (res.alreadyMember) { alert(lang.alreadyMember(handle)); return; }
      inviteInput.value = "";
      await refreshMembers();
      // GSK an neues Mitglied distribuieren
      const devices = await fetchInboxKeys(handle);
      if (devices?.length) {
        const tagged = devices.map(d => ({ ...d, memberHandle: handle }));
        await distributeGroupSK(groupId, getMyUser(), tagged, apiFetch)
          .catch(e => console.warn("GSK für neues Mitglied fehlgeschlagen", e));
      }
    } catch (e) {
      let msg = e.message || "";
      try { msg = JSON.parse(msg).error || msg; } catch {}
      if (msg.includes("not found") || msg.includes("404")) {
        alert(lang.userNotFound(handle));
      } else if (msg.includes("Not in your contacts") || msg.includes("contacts")) {
        alert(lang.notInContacts(handle));
      } else {
        alert(lang.inviteFailed + msg);
      }
    } finally {
      inviteBtn.disabled = false;
    }
  });

  inviteInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); inviteBtn?.click(); }
  });

  // Autocomplete-Dropdown für Invite-Input (Kontakte, Mitglieder ausgegraut)
  if (inviteInput && inviteBtn) {
    // Dropdown an body hängen → kein Overflow-Clipping durch Parent
    const acDrop = document.createElement("div");
    acDrop.style.cssText = "display:none;position:fixed;min-width:170px;background:var(--bg-panel);border:1px solid var(--border-subtle);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.4);z-index:9999;max-height:200px;overflow-y:auto;";
    document.body.appendChild(acDrop);

    function positionAcDrop() {
      const r = inviteInput.getBoundingClientRect();
      acDrop.style.left = r.left + "px";
      acDrop.style.top  = (r.bottom + 4) + "px";
      acDrop.style.width = Math.max(r.width, 170) + "px";
    }

    async function renderAcDropdown(query) {
      const contacts = await fetchAcceptedContacts();
      const q = query.trim().toLowerCase();
      const matches = contacts.filter(h => !q || h.includes(q));
      if (!matches.length) { acDrop.style.display = "none"; return; }

      acDrop.innerHTML = "";
      matches.forEach(handle => {
        const isMember = _memberHandles.includes(handle);
        const item = document.createElement("div");
        item.style.cssText = `padding:8px 12px;font-size:13px;cursor:${isMember ? "default" : "pointer"};` +
          `color:${isMember ? "var(--text-secondary)" : "var(--text-primary)"};` +
          `opacity:${isMember ? ".5" : "1"};display:flex;align-items:center;gap:8px;`;
        // XSS-safe: textContent statt innerHTML
        const iconSpan = document.createElement("span");
        iconSpan.textContent = "👤";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = handle;
        item.append(iconSpan, nameSpan);
        if (isMember) {
          const memberSpan = document.createElement("span");
          memberSpan.style.cssText = "font-size:11px;margin-left:auto";
          memberSpan.textContent = "(Mitglied)";
          item.appendChild(memberSpan);
        }
        if (!isMember) {
          item.addEventListener("mousedown", (e) => {
            e.preventDefault();
            inviteInput.value = handle;
            acDrop.style.display = "none";
            inviteBtn.click();
          });
          item.addEventListener("mouseover", () => item.style.background = "var(--bg-panel-alt)");
          item.addEventListener("mouseout",  () => item.style.background = "");
        }
        acDrop.appendChild(item);
      });
      positionAcDrop();
      acDrop.style.display = "block";
    }

    inviteInput.addEventListener("focus", () => renderAcDropdown(inviteInput.value));
    inviteInput.addEventListener("input", () => renderAcDropdown(inviteInput.value));
    inviteInput.addEventListener("blur",  () => setTimeout(() => { acDrop.style.display = "none"; }, 150));
    window.addEventListener("scroll", positionAcDrop, { passive: true });
    window.addEventListener("resize", () => { acDrop.style.display = "none"; }, { passive: true });
  }
}

function scrollToBottom() {
  if (!messagesEl) return;
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function updateUnreadIndicator() {
  if (!unreadCountEl || !indicatorEl) return;

  if (unreadCount > 0) {
    unreadCountEl.textContent = unreadCount;
    indicatorEl.classList.add("visible");
  } else {
    unreadCountEl.textContent = "";
    indicatorEl.classList.remove("visible");
  }
}

function showCooldownWarning() {
  if (!warningEl) return;

  warningEl.textContent = lang.pleaseWait;
  warningEl.className = "warn";

  if (cooldownTimer) clearTimeout(cooldownTimer);
cooldownTimer = setTimeout(() => {
  warningEl.textContent = "";
  warningEl.className = "";
  cooldownTimer = null;

  // 🔁 FIX SCHRITT 4: Retry pending nach Cooldown
  retryPendingIfPossible();
}, SEND_COOLDOWN_MS);
}
function formatTimestamp(ts) {
  if (!ts) return "";

  const d = new Date(ts);
  const time = d.toLocaleTimeString(lang.locale, {
    hour: "2-digit",
    minute: "2-digit"
  });
  const date = d.toLocaleDateString(lang.locale);

  return `${time} · ${date}`;
}

// ======================================================
// OUTBOX CACHE (für eigene gesendete E2E-Nachrichten)
// ======================================================
function cacheSentMessage(id, text) {
  try {
    localStorage.setItem(`outbox:${id}`, text);

    // optional: simple cap (nicht perfekt, aber ok)
    // wenn du willst, machen wir das später sauber mit IndexedDB + Limit 500
  } catch (e) {
    console.warn("outbox cache failed", e);
  }
}

function getCachedSentMessage(id) {
  try {
    return localStorage.getItem(`outbox:${id}`);
  } catch {
    return null;
  }
}

// ======================================================
// RENDER
// ======================================================
// ======================================================
// 👤 SENDER POPOVER (Gruppen-Chat)
// ======================================================
let _activeSenderPopover = null;

function closeSenderPopover() {
  if (_activeSenderPopover) {
    _activeSenderPopover.remove();
    _activeSenderPopover = null;
  }
}

async function showSenderPopover(handle, anchorEl) {
  closeSenderPopover();

  const popover = document.createElement("div");
  popover.style.cssText = "position:fixed;background:var(--bg-panel);border:1px solid var(--border-panel);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.4);padding:12px 14px;z-index:500;min-width:180px;";

  // Header: Avatar + Name — XSS-safe DOM-Konstruktion
  const popoverHeader = document.createElement("div");
  popoverHeader.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:10px;";
  const avatarDiv = document.createElement("div");
  avatarDiv.style.cssText = "width:34px;height:34px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;flex-shrink:0;";
  avatarDiv.textContent = handle[0].toUpperCase();
  const nameSpanPop = document.createElement("span");
  nameSpanPop.style.cssText = "font-size:14px;font-weight:600;color:var(--text-primary);";
  nameSpanPop.textContent = handle;
  popoverHeader.append(avatarDiv, nameSpanPop);
  const actionDiv = document.createElement("div");
  actionDiv.id = "sender-popover-action";
  actionDiv.style.cssText = "font-size:12px;color:var(--text-secondary);";
  actionDiv.textContent = "…";
  popover.append(popoverHeader, actionDiv);

  document.body.appendChild(popover);
  _activeSenderPopover = popover;

  // Position berechnen (über dem Anker)
  const rect = anchorEl.getBoundingClientRect();
  const pw = popover.offsetWidth || 190;
  let left = rect.left;
  let top  = rect.top - popover.offsetHeight - 8;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (top < 8) top = rect.bottom + 8;
  popover.style.left = left + "px";
  popover.style.top  = top  + "px";

  // Kontaktstatus prüfen
  const actionEl = popover.querySelector("#sender-popover-action");
  try {
    const contacts = await fetchAcceptedContacts();
    const isContact = contacts.includes(handle);

    if (isContact) {
      // → DM öffnen
      const btn = document.createElement("a");
      btn.href = `/chat?with=${encodeURIComponent(handle)}`;
      btn.style.cssText = "display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:7px;background:var(--accent);color:#fff;font-size:13px;font-weight:600;text-decoration:none;cursor:pointer;";
      btn.textContent = "💬 Nachricht schreiben";
      actionEl.replaceWith(btn);
    } else {
      // → Kontaktanfrage senden
      const btn = document.createElement("button");
      btn.style.cssText = "display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:7px;background:var(--bg-panel-alt);border:1px solid var(--border-subtle);color:var(--text-primary);font-size:13px;cursor:pointer;width:100%;";
      btn.innerHTML = "＋ Kontakt anfragen";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "…";
        try {
          const r = await apiFetch("/contacts/request", {
            method: "POST",
            body: JSON.stringify({ contact: handle.trim().toLowerCase() })
          });
          if (r.rateLimited) {
            btn.textContent = "⏳ Bitte warten…";
            btn.disabled = false;
          } else if (r.status === "cooldown") {
            btn.textContent = "🚫 Anfrage abgelehnt (Cooldown)";
          } else if (r.status === "already_exists" || r.status === "accepted") {
            btn.textContent = "✓ Bereits Kontakt";
          } else if (r.status === "already_pending") {
            btn.textContent = "⏳ Anfrage ausstehend";
          } else if (r.status === "requested") {
            btn.textContent = "✓ Anfrage gesendet";
          } else {
            btn.textContent = "✓ Anfrage gesendet";
          }
        } catch (e) {
          btn.textContent = "❌ " + (e.message || "Fehler");
          btn.disabled = false;
        }
      });
      actionEl.replaceWith(btn);
    }
  } catch {
    actionEl.textContent = "Fehler beim Laden";
  }

  // Schliessen bei Klick ausserhalb
  setTimeout(() => {
    document.addEventListener("click", closeSenderPopover, { once: true });
  }, 0);
}

// ======================================================
function renderMessage({ id, from, message, ts, tempId = null, status = "sent", msg = null }) {

  if (!messagesEl) return null;

  // 🛡️ HARD GUARD: Pending darf nur lokal sein
if (status === "pending" && from !== getMyUser()) {
  status = "sent";
}

  if (!message || message.length > MAX_MESSAGE_LENGTH) return null;

const div = document.createElement("div");
// Gruppe: "me" wenn ich der Sender bin; DM: "me" wenn from !== withUser
const isOwnMessage = from?.toLowerCase() === getMyUser()?.toLowerCase();
div.className = isOwnMessage ? "me" : "other";

// Gruppe + fremde Nachricht: Absender-Name anzeigen (Discord-Style)
if (!isOwnMessage && isGroupConversation(withUser) && from) {
  const senderEl = document.createElement("div");
  senderEl.className = "sender-name";
  senderEl.textContent = from;
  senderEl.style.cursor = "pointer";
  senderEl.addEventListener("click", (e) => {
    e.stopPropagation();
    showSenderPopover(from, senderEl);
  });
  div.appendChild(senderEl);
}

// Gruppe + fremde Nachricht: Klick auf Bubble öffnet Popover
if (!isOwnMessage && isGroupConversation(withUser) && from) {
  div.style.cursor = "pointer";
  div.addEventListener("click", (e) => {
    if (e.target.closest(".sender-name")) return; // bereits oben behandelt
    showSenderPopover(from, div);
  });
}

const textEl = document.createElement("div");
textEl.textContent = message;

div.appendChild(textEl);

const timeEl = document.createElement("div");
timeEl.className = "timestamp";

let meta = formatTimestamp(ts);

// Status nur für eigene Nachrichten anzeigen
if (from === getMyUser()) {
  if (status === "delivered") {
    meta += " · Zugestellt";
  } else if (status === "sent") {
    meta += " · Gesendet";
  } else if (status === "pending") {
    meta += " · Sende…";
  }
}

timeEl.textContent = meta;
div.appendChild(timeEl);

if (id) div.dataset.id = id;
if (tempId) div.dataset.tempId = tempId;
if (ts) div.dataset.ts = String(ts); // für mark-read Debounce

// 🗑️ Delete-Event kam vor Render → sofort als gelöscht anzeigen
if (id && deletedMessageIds.has(id)) {
  const textEl = div.querySelector("div:not(.sender-name):not(.timestamp)");
  if (textEl) {
    textEl.textContent = lang.messageDeleted;
    textEl.style.opacity = "0.5";
    textEl.style.fontStyle = "italic";
  }
  div.dataset.deleted = "1";
  messagesEl.appendChild(div);
  return div;
}

if (status) {
  div.dataset.status = status;
}

if (id && status) {
  renderedMessageStatus.set(id, status);
}

if (status === "pending" && from === getMyUser()) {
  div.classList.add("pending");
}
if (status === "failed") div.classList.add("failed");

// ↩️ Quote-Block rendern (wenn Nachricht eine Antwort ist)
if (msg && msg.replyToId && (msg.replyFrom || msg.replyPlaintext)) {
  const quote = document.createElement("div");
  quote.className = "reply-quote";
  quote.dataset.replyToId = msg.replyToId;
  const qFrom = document.createElement("div");
  qFrom.className = "reply-quote-from";
  qFrom.textContent = msg.replyFrom || "…";
  const qText = document.createElement("div");
  qText.className = "reply-quote-text";
  qText.textContent = msg.replyPlaintext ? msg.replyPlaintext.slice(0, 100) : "…";
  quote.append(qFrom, qText);
  quote.addEventListener("click", (e) => {
    e.stopPropagation();
    const orig = document.querySelector(`[data-id="${msg.replyToId}"]`);
    if (orig) { orig.scrollIntoView({ behavior: "smooth", block: "center" }); orig.classList.add("highlight-flash"); setTimeout(() => orig.classList.remove("highlight-flash"), 1200); }
  });
  div.insertBefore(quote, textEl);
}

// ↩️ Reply-Button für alle Nachrichten (nicht pending/failed)
if (id && status !== "pending" && status !== "failed") {
  const replyBtn = document.createElement("button");
  replyBtn.title = "Antworten";
  replyBtn.textContent = "↩";
  replyBtn.style.cssText = "position:absolute;bottom:4px;" + (isOwnMessage ? "left:22px;" : "right:22px;") +
    "background:none;border:none;cursor:pointer;font-size:11px;opacity:0.18;padding:0;transition:opacity 0.15s;color:var(--text-secondary);";
  replyBtn.addEventListener("mouseenter", () => replyBtn.style.opacity = "0.8");
  replyBtn.addEventListener("mouseleave", () => replyBtn.style.opacity = "0.18");
  replyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const txt = textEl?.textContent || "";
    showReplyBar(id, from, txt);
  });
  div.appendChild(replyBtn);
}

// 😂 Reaction-Picker: Smiley-Button für alle Nachrichten (nicht pending/failed)
if (id && status !== "pending" && status !== "failed") {
  const reactBtn = document.createElement("button");
  reactBtn.className = "react-btn";
  reactBtn.title = "Reagieren";
  reactBtn.textContent = "😊";
  reactBtn.style.cssText = "position:absolute;bottom:4px;" + (isOwnMessage ? "left:6px;" : "right:6px;") +
    "background:none;border:none;cursor:pointer;font-size:11px;opacity:0.18;padding:0;transition:opacity 0.15s;";
  reactBtn.addEventListener("mouseenter", () => reactBtn.style.opacity = "0.8");
  reactBtn.addEventListener("mouseleave", () => reactBtn.style.opacity = "0.18");
  reactBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showReactionPicker(div, id);
  });
  div.appendChild(reactBtn);
  // Bestehende Reaktionen aus Cache rendern
  if (reactionsCache.has(id)) renderReactionBar(div, id);
}

// 🗑️ Delete-Button + ✏️ Edit-Button für eigene Nachrichten (nicht pending/failed)
if (id && from === getMyUser() && status !== "pending" && status !== "failed") {
  // ✏️ Edit-Button (nur innerhalb 15 Minuten)
  const EDIT_WINDOW_MS = 15 * 60 * 1000;
  if (ts && Date.now() - Number(ts) < EDIT_WINDOW_MS) {
    const editBtn = document.createElement("button");
    editBtn.className = "edit-btn";
    editBtn.title = "Bearbeiten";
    editBtn.textContent = "✏";
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      startInlineEdit(div, id, textEl.textContent);
    });
    div.appendChild(editBtn);
  }

  const delBtn = document.createElement("button");
  delBtn.className = "delete-btn";
  delBtn.title = lang.deleteMessageTitle;
  delBtn.textContent = "×";
  delBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (confirm(lang.confirmDeleteMessage)) deleteMessage(id);
  });
  div.appendChild(delBtn);
}

messagesEl.appendChild(div);
return div;
}

// ======================================================
// UPDATE MESSAGE STATUS (ohne Re-Render)
// ======================================================
function updateRenderedMessageStatus(messageId, status) {

  if (!status) return;

  const el = document.querySelector(`[data-id="${messageId}"]`);
  if (!el) return;

  // Status nur für eigene Nachrichten
  if (!el.classList.contains("me")) return;

  const currentStatus = el.dataset.status;
if (currentStatus === "delivered") return;

  const timeEl = el.querySelector(".timestamp");
  if (!timeEl) return;

  // Timestamp extrahieren (vor dem ersten " · ")
  const ts = timeEl.textContent.split(" · ")[0];

  let meta = ts;

if (status === "delivered") {
  meta += " · " + lang.statusDelivered;
} else if (status === "sent") {
  meta += " · " + lang.statusSent;
}

el.dataset.status = status;  
timeEl.textContent = meta;

renderedMessageStatus.set(messageId, status);
}

// ======================================================
// MESSAGE EDIT
// ======================================================

function startInlineEdit(div, msgId, currentText) {
  // Verhindert doppeltes Öffnen
  if (div.querySelector(".edit-textarea")) return;

  const textEl = div.querySelector("div:not(.sender-name):not(.timestamp):not(.edited-badge-wrap)");
  if (!textEl) return;

  const originalText = currentText || textEl.textContent;
  textEl.style.display = "none";

  const ta = document.createElement("textarea");
  ta.className = "edit-textarea";
  ta.value = originalText;
  ta.rows = Math.min(6, Math.max(1, Math.ceil(originalText.length / 40)));
  div.insertBefore(ta, div.querySelector(".timestamp"));
  ta.focus();
  ta.selectionStart = ta.selectionEnd = ta.value.length;

  ta.addEventListener("keydown", async (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const newText = ta.value.trim();
      if (newText && newText !== originalText) {
        await editMessage(msgId, newText, div, textEl, ta);
      } else {
        cancelInlineEdit(div, textEl, ta);
      }
    }
    if (e.key === "Escape") cancelInlineEdit(div, textEl, ta);
  });
}

function cancelInlineEdit(div, textEl, ta) {
  ta.remove();
  textEl.style.display = "";
}

async function editMessage(msgId, newText, div, textEl, ta) {
  try {
    let ciphertext, rotationIndex;
    if (isGroupConversation(withUser)) {
      const { encrypted } = await encryptGroupMessage(newText, withUser);
      ciphertext = encrypted;
      rotationIndex = null;
    } else {
      const enc = await encryptMessage(newText);
      ciphertext = enc.ciphertext;
      rotationIndex = enc.rotationIndex ?? sessionRotationIndex;
    }

    await apiFetch("/chat/message/edit", {
      method: "POST",
      body: JSON.stringify({ id: msgId, ciphertext, rotationIndex })
    });

    // Bubble sofort aktualisieren
    ta.remove();
    textEl.textContent = newText;
    textEl.style.display = "";
    applyEditedBadge(div);
    savePreviewCache(previewConvoId(withUser), { text: newText, ts: Date.now(), from: getMyUser() });
  } catch (err) {
    cancelInlineEdit(div, textEl, ta);
    alert("Bearbeiten fehlgeschlagen: " + (err.message || err));
  }
}

function applyEditedBadge(div) {
  if (div.querySelector(".edited-badge-wrap")) return;
  const timeEl = div.querySelector(".timestamp");
  const badge = document.createElement("span");
  badge.className = "edited-badge";
  badge.textContent = "(bearbeitet)";
  const wrap = document.createElement("span");
  wrap.className = "edited-badge-wrap";
  wrap.appendChild(badge);
  if (timeEl) timeEl.appendChild(wrap);
  else div.appendChild(wrap);
}

async function handleMessageEdited(event) {
  const { messageId, ciphertext, rotationIndex, from } = event;
  if (!messageId || !ciphertext) return;

  const el = document.querySelector(`[data-id="${messageId}"]`);
  if (!el || el.dataset.deleted === "1") return;

  try {
    let plaintext;
    if (isGroupConversation(withUser)) {
      plaintext = await decryptGroupMessage({ message: ciphertext }, withUser);
    } else {
      plaintext = await decryptMessage(ciphertext, rotationIndex ?? 0);
    }
    if (!plaintext || plaintext === "__decrypt_failed__") return;

    const textEl = el.querySelector("div:not(.sender-name):not(.timestamp):not(.edited-badge-wrap)");
    if (textEl) textEl.textContent = plaintext;
    applyEditedBadge(el);
    savePreviewCache(previewConvoId(withUser), { text: plaintext, ts: Date.now(), from });
  } catch {}
}

// ======================================================
// MESSAGE DELETE
// ======================================================

function markMessageDeleted(messageId) {
  // Immer in Set eintragen — auch wenn DOM-Element noch nicht da ist
  deletedMessageIds.add(messageId);

  const el = document.querySelector(`[data-id="${messageId}"]`);
  if (!el) return;

  // Schon als gelöscht markiert → nochmal ist ok
  if (el.dataset.deleted === "1") return;

  // Absender-Name (.sender-name) und Timestamp (.timestamp) überspringen →
  // nur den eigentlichen Text-Div treffen (hat keine Klasse)
  const textEl = el.querySelector("div:not(.sender-name):not(.timestamp)");
  if (textEl) {
    textEl.textContent = lang.messageDeleted;
    textEl.style.opacity = "0.5";
    textEl.style.fontStyle = "italic";
  }
  // Delete-Button entfernen falls vorhanden
  el.querySelector(".delete-btn")?.remove();
  el.dataset.deleted = "1";
}

async function deleteMessage(messageId) {
  try {
    await apiFetch("/chat/message/delete", {
      method: "DELETE",
      body: JSON.stringify({ id: messageId })
    });
    markMessageDeleted(messageId);
  } catch (e) {
    console.warn("⚠️ Nachricht konnte nicht gelöscht werden", e);
  }
}

// ======================================================
// LOAD MESSAGES (FINAL CLEAN VERSION)
// ======================================================
// ======================================================
// processMessage: einzelne Nachricht decrypt + render
// Gibt true zurück wenn die Nachricht NEU war
// ======================================================
async function processMessage(m) {
  if (!m?.id || !m?.from) return false;

  // System-Messages (join/leave) direkt als UI-Hinweis rendern — kein Decrypt, kein Bubble
  if (m.type === "system") {
    if (renderedMessageIds.has(m.id)) return false;
    renderedMessageIds.add(m.id);
    const sysText = m.message || m.text || "";
    showSystemMessage(sysText);
    savePreviewCache(previewConvoId(withUser), { text: sysText, ts: m.ts || Date.now(), from: "__system__" });
    return true;
  }

  const messageId = m.id;

  // Bereits gerendert → nur Status updaten
  if (renderedMessageIds.has(messageId)) {
    const prevStatus = renderedMessageStatus.get(messageId);
    if (m.status && m.status !== prevStatus) {
      updateRenderedMessageStatus(messageId, m.status);
      renderedMessageStatus.set(messageId, m.status);
    }
    return false;
  }

  if (deferredInboundIds.has(messageId) && !e2eReady) return false;

  let text;
  try {
    text = await decryptMessageIfNeeded(m, withUser);
  } catch {
    text = "🔒 Verschlüsselte Nachricht (Fehler)";
  }

  // Key fehlt noch → Placeholder + deferred (wird nach CMK/GSK-Empfang entschlüsselt)
  if (text === null) {
    // Kein E2E-Payload vorhanden → kann nie entschlüsselt werden, nicht deferred
    if (!m.ivB64 && !m.ctB64) {
      renderedMessageIds.add(messageId);
      return false; // System-/Control-Message ohne Payload still skippen
    }
    deferredInboundMessages.push(m);
    deferredInboundIds.add(messageId);
    renderMessage({
      id: messageId,
      from: m.from,
      message: "🔒 Nachricht wird entschlüsselt…",
      ts: m.ts
    });
    renderedMessageIds.add(messageId);
    // Gruppen-GSK fehlt → beim Sender anfordern (Pull-Mechanismus)
    if (isGroupConversation(withUser) && m.from && m.from !== getMyUser()) {
      requestGSKFrom(withUser, m.from).catch(() => {});
    }
    return false;
  }

  // Decrypt-Fehler: Gruppen → GSK anfordern + in Deferred-Queue (Retry nach GSK_READY)
  //                 DMs     → permanent (falscher CMK / anderes Gerät)
  if (text === "__decrypt_failed__") {
    console.debug("[processMsg] DECRYPT_FAILED", { from: m.from, ts: m.ts, id: messageId });
    if (isGroupConversation(withUser) && m.from && m.from !== getMyUser()) {
      const retries = deferredInboundRetryCount.get(messageId) || 0;
      if (retries < MAX_INBOUND_RETRIES) {
        deferredInboundRetryCount.set(messageId, retries + 1);
        deferredInboundMessages.push(m);
        deferredInboundIds.add(messageId);
        renderedMessageIds.add(messageId); // Verhindert Re-Render durch processMessage
        requestGSKFrom(withUser, m.from).catch(() => {});
        // Platzhalter rendern (wird durch flush-Update ersetzt)
        renderMessage({ id: messageId, from: m.from, message: "🔒 Schlüssel wird angefordert…", ts: m.ts });
        return false;
      }
    }
    renderedMessageIds.add(messageId);
    renderMessage({ id: messageId, from: m.from, message: decryptFailedText(m.ts), ts: m.ts });
    return true;
  }

  // Normale Nachricht rendern — edited_message bevorzugen wenn vorhanden
  let displayText = text;
  if (m.edited_message) {
    try {
      const editedPlain = isGroupConversation(withUser)
        ? await decryptGroupMessage({ message: m.edited_message }, withUser)
        : await decryptMessage(m.edited_message, m.rotationIndex ?? 0);
      if (editedPlain && editedPlain !== "__decrypt_failed__") displayText = editedPlain;
    } catch {}
  }

  console.debug("[processMsg] OK", { from: m.from, ts: m.ts, preview: String(displayText).slice(0,20) });
  renderedMessageIds.add(messageId);
  deferredInboundIds.delete(messageId);
  // Reply-Preview entschlüsseln (wenn vorhanden)
  if (m.replyToId && m.replyIv && m.replyCt) {
    try {
      let replyPlain;
      if (isGroupConversation(withUser)) {
        // Gruppe: mit GSK des Senders entschlüsseln (gleicher chainIndex wie Hauptnachricht)
        replyPlain = await decryptGroupMessage(withUser, m.from, m.replyIv, m.replyCt, m.rotationIndex ?? 0);
      } else {
        // DM: mit MK entschlüsseln
        const rMk = await deriveMessageKey(sessionKeyBytes, dmSessionId(getMyUser(), withUser), m.epoch ?? 0);
        replyPlain = await e2eDecrypt(rMk, m.replyIv, m.replyCt);
      }
      if (typeof replyPlain === "string" && replyPlain !== "__decrypt_failed__") {
        m.replyPlaintext = replyPlain;
      }
    } catch {}
  }

  const renderedDiv = renderMessage({
    id: messageId,
    from: m.from,
    message: displayText,
    ts: m.ts,
    status: m.status,
    msg: m   // ganzes msg-Objekt für Reply-Quote
  });
  // (bearbeitet) Badge wenn Nachricht schon editiert wurde
  if (m.edited_at && renderedDiv) applyEditedBadge(renderedDiv);
  savePreviewCache(previewConvoId(withUser), { text: displayText, ts: m.ts || Date.now(), from: m.from });

  if (m.from === getMyUser()) {
    const pending = document.querySelector(".me.pending");
    if (pending) pending.classList.remove("pending");
  }

  return true;
}

async function loadMessages() {
  try {
    const url = "/chat/list?with=" + withUser;
    const { messages = [], reactions: msgReactions = {} } = await apiFetch(url);
    // Reaktionen in Cache laden
    Object.entries(msgReactions).forEach(([msgId, data]) => reactionsCache.set(msgId, data));
    console.warn("📥 SERVER MESSAGES:", messages.length, "withUser:", withUser);

    // 📌 Für Gruppen: "letzte gelesene ts" in localStorage UND Backend speichern
    // → Inbox-Badge zeigt nur wirklich neue Nachrichten (seit diesem Zeitpunkt)
    if (isGroupConversation(withUser) && messages.length > 0) {
      const newestTs = messages[messages.length - 1]?.ts || 0;
      if (newestTs) {
        const prevTs = Number(localStorage.getItem(`renex_group_read_${withUser}`) || 0);
        localStorage.setItem(`renex_group_read_${withUser}`, String(newestTs));
        // Backend nur updaten wenn neuere Ts (verhindert unnötige DB-Writes)
        if (newestTs > prevTs) {
          apiFetch("/groups/mark-read", {
            method: "POST",
            body: JSON.stringify({ groupId: withUser, lastReadTs: newestTs })
          }).catch(() => {}); // fire-and-forget
        }
      }
    }

    const wasAtBottom = isUserAtBottom();

    let added = false;

    for (const m of messages) {
      const isNew = await processMessage(m);
      if (isNew) {
        added = true;
        if (m.from === withUser && !wasAtBottom) unreadCount++;
      }
    }

    // ==================================================
    // SCROLL LOGIC
    // ==================================================
    if (firstLoad) {
      scrollToBottom();
      firstLoad = false;
      unreadCount = 0;
    }
    else if (added && wasAtBottom) {
      scrollToBottom();
      unreadCount = 0;
    }

updateUnreadIndicator();

// ==================================================
// DELIVERED STATUS MELDEN (nur DMs)
// Gruppen: status='sent' = Server-Bestätigung ✓, kein weiteres Tracking
// ==================================================
if (!isGroupConversation(withUser) && messages.some(m =>
  m &&
  m.from === withUser &&
  m.to === getMyUser() &&
  m.type !== "cmk" &&
  m.type !== "cmk_req"
)) {
  try {
    await apiFetch("/chat/delivered", {
      method: "POST",
      body: JSON.stringify({
        with: withUser
      })
    });
  } catch (e) {
    console.warn("Delivered update failed", e);
  }
}

} catch (e) {
  console.error("Load messages failed:", e);
}
}

// ======================================================
// ZEITBASIERTE ROTATION
// ======================================================

async function doRotationAndRefresh() {
  const ok = await rotateEpoch(getMyUser(), withUser, apiFetch);
  if (ok) {
    const entry = await bootConversation(getMyUser(), withUser);
    if (entry?.skBytes) {
      sessionKeyBytes = entry.skBytes;
      sessionRotationIndex = entry.rotationIndex ?? sessionRotationIndex;
      sessionCmkBytes = entry.cmkBytes ?? sessionCmkBytes;
      skCache.set(`${dmSessionId(getMyUser(), withUser)}:${sessionRotationIndex}`, sessionKeyBytes);
      console.log("🔄 Lokaler SK nach Rotation aktualisiert:", { rotationIndex: sessionRotationIndex });
    }
  }
}

async function startTimeBasedRotation() {
  if (!isAuthority(getMyUser(), withUser)) return;
  if (timeRotationTimer) return;

  const sid = dmSessionId(getMyUser(), withUser);

  // Initialisierung: falls noch nie rotiert, jetzt als Startzeit speichern
  const lastRotation = await getLastRotationTime(sid);
  if (lastRotation === 0) {
    await setLastRotationTime(sid, Date.now());
  }

  // Stündlich prüfen ob 24h seit letzter Rotation vergangen sind
  timeRotationTimer = setInterval(async () => {
    if (!e2eReady || !sessionCmkBytes) return;
    const last = await getLastRotationTime(sid);
    if (Date.now() - last < ROTATION_INTERVAL_MS) return;
    console.log("⏰ Zeitbasierte Rotation ausgelöst");
    doRotationAndRefresh().catch(e => console.warn("⚠️ Zeitbasierte Rotation fehlgeschlagen", e));
  }, 60 * 60 * 1000); // stündlich prüfen ob 24h vergangen
}

// ======================================================
// POLLING (Lifecycle-Safe)
// ======================================================

let poller = null;
let pollingActive = false;
let isLoadingMessages = false;
let pollScheduled = false; // 🔒 verhindert Doppel-Timer

// Adaptives Poll-Interval:
// WS verbunden  → 60s (nur Safety-Net, schont Batterie)
// WS getrennt   →  5s (responsiver Fallback)
const POLL_DELAY_WS_ON  = 60000;
const POLL_DELAY_WS_OFF =  5000;
const MAX_POLL_DELAY    = 60000;
let pollDelay = POLL_DELAY_WS_OFF; // konservativ starten bis WS-Status bekannt

// WS-Zustand beobachten → Poll-Interval anpassen
window.addEventListener("renex-ws-state", (e) => {
  if (e.detail?.connected) {
    pollDelay = POLL_DELAY_WS_ON;
    console.log("📶 WS verbunden — Poll-Interval: 60s");
  } else {
    pollDelay = POLL_DELAY_WS_OFF;
    console.log("📵 WS getrennt — Poll-Interval: 5s");
  }
});

async function pollLoop() {
  if (!pollingActive) return;
  
  if (isLoadingMessages) {
    scheduleNextPoll();
    return;
  }

  isLoadingMessages = true;

  try {
    await loadMessages();
    // Erfolg → zurück auf aktuell korrektes Interval (WS-abhängig)
    // pollDelay wurde bereits via renex-ws-state gesetzt — nicht überschreiben
  } catch (e) {
    console.error("Polling error", e);
    pollDelay = Math.min(pollDelay * 2, MAX_POLL_DELAY);
    console.log("⏳ Poll Backoff aktiv:", pollDelay, "ms");
  }

  isLoadingMessages = false;
  scheduleNextPoll();
}

function scheduleNextPoll() {
  if (!pollingActive) return;
  if (pollScheduled) return;

  pollScheduled = true;

  poller = setTimeout(() => {
    pollScheduled = false;
    pollLoop();
  }, pollDelay);
}

function startPolling() {

  if (!messagesEl) {
    console.warn("⛔ Polling nicht gestartet – DOM fehlt");
    return;
  }

  if (pollingActive) return;

  pollingActive = true;
  pollDelay = POLL_DELAY_WS_OFF; // startet konservativ, wird via renex-ws-state angepasst
  pollScheduled = false;

  pollLoop();
}

function stopPolling() {
  pollingActive = false;
  pollScheduled = false;

  if (poller) {
    clearTimeout(poller);
    poller = null;
  }
}

document.addEventListener("visibilitychange", async () => {
  if (document.hidden) {
    stopPolling();
    return;
  }

  if (!e2eReady) {
    stopPolling();
    return;
  }

  // Polling neu starten (war gestoppt während Tab hidden)
  startPolling();

  if (!isLoadingMessages) {
    try {
      await loadMessages(); // sofort synchronisieren
    } catch (e) {
      console.warn("Reload on focus failed", e);
    }
  }

});

// ======================================================
// 🏘️ GRUPPE: Chat-Bereitschaft sicherstellen
// 1. Eigenen GSK generieren (falls noch nicht vorhanden)
// 2. GSK an alle anderen Mitglieder-Devices distribuieren
//    (einmalig pro Session, tracked via sessionStorage)
// ======================================================
async function ensureGroupChatReady(groupId, myHandle) {
  // Eigenen GSK bereitstellen (IDB-persistent)
  await getOrCreateGroupSK(groupId, myHandle);

  // Nur einmal pro Session distribuieren (verhindert Spam beim Tab-Reload)
  const distKey = `gsk-dist:${groupId}`;
  if (sessionStorage.getItem(distKey)) {
    console.log("🔑 GSK bereits in dieser Session distribuiert:", groupId);
    return;
  }

  // Mitgliederliste vom Server holen
  let members = [];
  try {
    const res = await apiFetch(`/groups/members?groupId=${encodeURIComponent(groupId)}`);
    members = (res.members || []).filter(m => m.member_handle !== myHandle);
  } catch (e) {
    console.warn("⚠️ ensureGroupChatReady: Mitgliederliste fehlgeschlagen", e);
    return;
  }

  if (members.length === 0) {
    console.log("🏘️ Gruppe hat noch keine anderen Mitglieder:", groupId);
    sessionStorage.setItem(distKey, "1");
    return;
  }

  // Pro Mitglied: Devices laden + eigenen GSK senden + fehlende GSKs anfordern
  // Promise.allSettled → alle Members parallel, kein sequenzielles Warten
  const results = await Promise.allSettled(members.map(async (member) => {
    const devices = await fetchInboxKeys(member.member_handle);
    if (!devices?.length) return { handle: member.member_handle, distributed: false, requested: false };

    // 1) Eigenen GSK an Member senden (Push)
    const tagged = devices.map(d => ({ ...d, memberHandle: member.member_handle }));
    await distributeGroupSK(groupId, myHandle, tagged, apiFetch);

    // 2) Falls wir ihren GSK noch nicht haben → anfordern (Pull)
    const existingGsk = await getGroupSK(groupId, member.member_handle);
    if (!existingGsk) await requestGSKFrom(groupId, member.member_handle);

    return { handle: member.member_handle, distributed: true, requested: !existingGsk };
  }));

  const distributed = results.filter(r => r.status === "fulfilled" && r.value?.distributed).length;
  const requested   = results.filter(r => r.status === "fulfilled" && r.value?.requested).length;
  const failed      = results.filter(r => r.status === "rejected").length;
  if (failed > 0) console.warn("⚠️ GSK distribute fehlgeschlagen für", failed, "Members");

  sessionStorage.setItem(distKey, "1");
  console.log("✅ GSK distribuiert:", { groupId, members: members.length, distributed, requested, failed });
}

// ======================================================
// STARTUP (FIXED ORDER)
// ======================================================

(async () => {

  // 🔒 Startup Guard – verhindert Doppel-Init
if (window.__chatStartupDone) {
  console.warn("⚠️ Chat Startup wurde bereits ausgeführt");
  return;
}
window.__chatStartupDone = true;

  console.log("💬 Chat Startup läuft");

  // 0️⃣ UI sofort binden — Enter & Click funktionieren von Anfang an.
  // Nachrichten während E2E-Setup werden in deferredQueue gepuffert und
  // nach CMK-Ready via flushDeferredQueue() gesendet.
  startChat();

  // 1️⃣ Eigene E2E-Keys (immer — auch für Gruppen nötig für GSK-Wrap/Unwrap)
  getDeviceId(); // ✅ Device-ID sicher setzen
  await initE2EKeys();
  await debugPrintMyPublicKey();
  await uploadMyPublicKeyIfNeeded();

  // ──────────────────────────────────────────────────────────────
  // 🏘️ GRUPPEN-STARTUP (kein CMK / keine Authority)
  // ──────────────────────────────────────────────────────────────
  if (isGroupConversation(withUser)) {
    // Gruppen brauchen keinen DM-Handshake (CMK). E2E via Sender Keys.
    // e2eReady = true sofort → Nachrichten können direkt gesendet werden.
    e2eReady = true;
    startChat(); // zweiter Aufruf ist idempotent (dataset.bound Guard)
    updateSendButton();

    try { await loadMessages(); } catch (e) { console.warn("Group loadMessages failed", e); }

    // GSK im Hintergrund distribuieren (non-blocking)
    ensureGroupChatReady(withUser, getMyUser())
      .catch(e => console.warn("⚠️ ensureGroupChatReady failed", e));

    // Gruppe als gesehen markieren → Badge auf Inbox-Seite verschwindet
    try {
      const seen = new Set(JSON.parse(localStorage.getItem("renex_seen_groups") || "[]"));
      seen.add(withUser);
      localStorage.setItem("renex_seen_groups", JSON.stringify([...seen]));
    } catch {}

    initAutoDeleteUI().catch(() => {});
    initGroupMembersUI(withUser).catch(() => {});
    startPolling();
    console.log("🟢 Gruppen-Chat gestartet:", withUser);
    return; // DM-Startup überspringen
  }

  // 2️⃣ Peer Public Key (nur DMs)
  const peerOk = await fetchAndStorePeerPublicKey(withUser);
  if (!peerOk) {
    e2eReady = false;
    alert(lang.noPeerKey);
    return;
  }
  console.log("📦 hasInboxKeys nach Fetch:", hasInboxKeys);
  
// 3️⃣ Conversation Lifecycle sicherstellen
const ok = await ensureConversationReady(
  localStorage.getItem("my_user"),
  withUser,
  fetchInboxKeys,
  apiFetch
);

console.log("🧪 ensureConversationReady() returned:", ok, {
  me: localStorage.getItem("my_user"),
  peer: withUser
});

// 4️⃣ Conversation lokal booten (CMK → SessionKey → e2eReady)
const entry = await bootConversation(
  localStorage.getItem("my_user"),
  withUser
);

if (entry && entry.ready) {
  sessionKeyBytes = entry.skBytes;
  sessionCmkBytes = entry.cmkBytes ?? sessionCmkBytes;
  sessionRotationIndex = entry.rotationIndex ?? 0;
  e2eReady = true;
}

// 5️⃣ UI starten
startChat();
updateSendButton();

// 6️⃣ Initial Messages nur laden wenn E2E bereit —
// sonst ruft der KV-Fetch / Fallback-Bootstrap loadMessages danach auf
if (e2eReady) {
  try {
    await loadMessages();
  } catch (e) {
    console.warn("Initial loadMessages failed", e);
  }
}

// 7️⃣ Auto-Delete UI immer initialisieren (unabhängig von E2E)
initAutoDeleteUI().catch(() => {});

// 8️⃣ Flush nur wenn ready
if (e2eReady) {

  console.log("🟢 Chat gestartet (E2E bereit)");

  await flushDeferredQueue();
  await flushDeferredInboundMessages();
  startTimeBasedRotation();

} else {

  console.log("🟡 Chat gestartet – warte auf CMK", {
    withUser,
    hasInboxKeys,
    e2eReady,
  });

  const me = localStorage.getItem("my_user");

  // 🔑 Schritt 1: CMK aus KV holen (Authority hat früher bootstrapped)
  const kvFetched = await fetchAndStoreCMK(me, withUser, apiFetch, fetchInboxKeys);
  if (kvFetched) {
    const entry = await bootConversation(me, withUser);
    if (entry?.skBytes) {
      sessionKeyBytes = entry.skBytes;
      sessionCmkBytes = entry.cmkBytes ?? sessionCmkBytes;
      sessionRotationIndex = entry.rotationIndex ?? 0;
      e2eReady = true;
      updateSendButton();
      console.log("✅ CMK aus KV geladen – E2E bereit");
      await loadMessages();
      await flushDeferredQueue();
      await flushDeferredInboundMessages();
      startTimeBasedRotation();
    }
  }

  // 🔑 Schritt 2: Fallback Bootstrap — Non-Authority erstellt CMK wenn Authority offline war
  if (!e2eReady) {
    const fallbacked = await fallbackBootstrap(me, withUser, fetchInboxKeys, apiFetch);
    if (fallbacked) {
      const entry = await bootConversation(me, withUser);
      if (entry?.skBytes) {
        sessionKeyBytes = entry.skBytes;
        sessionCmkBytes = entry.cmkBytes ?? sessionCmkBytes;
        sessionRotationIndex = entry.rotationIndex ?? 0;
        e2eReady = true;
        updateSendButton();
        console.log("✅ Fallback Bootstrap: E2E bereit — warte 5s auf Authority-CMK");
        await loadMessages();
        await flushDeferredInboundMessages();
        startTimeBasedRotation();
        // Race-Fix: Deferred Queue erst nach 5s senden
        // → Authority-CMK hat Zeit anzukommen (CMK_READY cancelt diesen Timer)
        // → verhindert Nachrichten die mit Fallback-CMK verschlüsselt wurden und vom Authority nicht entschlüsselt werden können
        fallbackFlushTimer = setTimeout(async () => {
          fallbackFlushTimer = null;
          console.log("⏱️ Fallback-Flush: kein Authority-CMK in 5s — sende mit Fallback-CMK");
          await flushDeferredQueue();
        }, 5000);
      }
    }
  }

  // 🔁 Schritt 3: Letzter Ausweg — alle 30s cmk_req senden bis CMK ankommt
  if (!e2eReady) {
    const cmkRetryInterval = setInterval(async () => {
      if (e2eReady) {
        clearInterval(cmkRetryInterval);
        return;
      }
      console.log("🔁 CMK-Retry: sende neuen cmk_req...");
      await ensureConversationReady(
        localStorage.getItem("my_user"),
        withUser,
        fetchInboxKeys,
        apiFetch
      );
    }, 30_000);
  }
}

// WebSocket liefert neue Messages via NEW_MESSAGE Event
})();



