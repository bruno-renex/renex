import { bootApp } from "./appBoot.js";
bootApp();

import {
  initE2EKeys,
  debugPrintMyPublicKey,
  loadPublicKey,
  idbSet,
  dmSessionId,
  peerFromDmSid,
  getCMKIfExists,
  deleteCMK,
  deriveMessageKey,
  deriveSessionKeyBytesForRotation,
  getLastRotationTime,
  setLastRotationTime,
  getRotationMap,
  findCmkForRotationIndex,
  signMessage,
  verifyMessageSig,
  getSigPubForDevice,
  setRotationIndex,
  uploadInboxKeyIfNeeded
} from "./e2e.js";

import {
  ensureConversationReady,
  ensureBootstrapped,
  bootConversation,
  fetchAndStoreCMK,
  fallbackBootstrap,
  isAuthority,
  rotateEpoch,
  rotateCMK,
  syncCMKToOwnDevices
} from "./sessionManager.js";

import { apiFetch } from "./api.js";
import lang from "./i18n.js";
import { guestDisplayName, replaceGuestHandles } from "./shared/guestUtils.js";
import { getDisplayName, prefetchProfiles } from "./profiles.js";
import { e2eLog } from "./e2eLog.js";
import { getGuestPrivJwk, getGuestDeviceId, clearGuestSession, setGuestSession } from "./shared/guestStorage.js";
import { formatTimestamp } from "./shared/timeFormat.js";
import {
  encryptGroupMessage,
  decryptGroupMessage,
  getOrCreateGroupSK,
  getGroupSK,
  distributeGroupSK,
  receiveGroupSK,
  rotateGroupSK,
  syncGroupSKToOwnDevices,
  fetchOwnGroupSKFromKV
} from "./groupSessionManager.js";

// ── Extracted Modules ──────────────────────────────────────
import {
  API, MAX_MESSAGE_LENGTH, SEND_COOLDOWN_MS, EPOCH_MS,
  ROTATION_THRESHOLD, ROTATION_INTERVAL_MS, MAX_DEFERRED_BACKOFF,
  MAX_INBOUND_RETRIES, STALE_MESSAGE_MAX_AGE_MS, MAX_DECRYPT_CACHE, INBOX_KEY_TTL,
  REACTION_EMOJIS, _guestData, _isGuestMode,
  _VALID_HANDLE, _VALID_UUID, _VALID_DM_ID
} from "./chatState.js";
import {
  abToB64, b64ToAb, e2eEncrypt, e2eDecrypt, e2eEncryptBytes,
  generateFileKey, exportKeyB64, importKeyB64,
  compressImage, downloadAndDecryptFile,
  uploadFile as _uploadFile,
  uploadMyPublicKeyIfNeeded as _uploadMyPublicKeyIfNeeded,
  escapeHtml, linkify, lruCacheSet as _lruCacheSet
} from "./chatCrypto.js";
import {
  isAutoDeleted, decryptFailedText, autoDeleteLabel,
  sweepExpiredMessages, startExpirySweep, stopExpirySweep,
  showAutoDeleteBanner, updateAutoDeleteHeaderLabel,
  showAutoDeleteProposal,
  initAutoDeleteUI,
  setup as setupAutoDelete
} from "./chatAutoDelete.js";
import {
  fetchPresence, formatLastSeen, presenceLabel,
  initDMPresence,
  fetchAcceptedContacts, invalidateContactsCache,
  setup as setupPresence
} from "./chatPresence.js";
import {
  showReplyBar, clearReplyBar, getReplyState,
  reactionsCache, renderReactionBar, sendReaction,
  closeContextMenu, showContextMenu, attachContextMenu,
  showReactionPicker,
  setup as setupContextMenu
} from "./chatContextMenu.js";

// ── Wrappers für Module mit Kontext-Abhängigkeiten ──
function uploadFile(file, attachmentType) {
  return _uploadFile(file, attachmentType, { isGroupConversation, withUser, getMyUser, showSystemToast });
}
function uploadMyPublicKeyIfNeeded() {
  return _uploadMyPublicKeyIfNeeded(getDeviceId, loadPublicKey, apiFetch);
}
function lruCacheSet(key, value) {
  _lruCacheSet(decryptedCache, MAX_DECRYPT_CACHE, key, value);
}

// ======================================================
// REACTION TOAST
// ======================================================
// Einfacher System-Toast (kein Klick-Ziel) — für Fehler, Warnungen, Infos
function showSystemToast(text, durationMs = 4000, isHtml = false) {
  const container = document.getElementById("chat-toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.style.cssText = "pointer-events:auto;background:var(--bg-secondary,#1e1e1e);border:1px solid var(--border,#333);border-radius:12px;padding:10px 14px;display:flex;align-items:center;gap:10px;box-shadow:0 4px 16px rgba(0,0,0,.4);animation:chatToastIn .25s ease;";
  const span = document.createElement("span");
  span.style.cssText = "font-size:13px;color:var(--text-primary,#fff);";
  if (isHtml) {
    span.innerHTML = text; // nur für vertrauenswürdige i18n-Strings mit <strong> etc.
  } else {
    span.textContent = text; // default: XSS-sicher
  }
  toast.appendChild(span);
  if (!document.getElementById("chat-toast-style")) {
    const s = document.createElement("style");
    s.id = "chat-toast-style";
    s.textContent = `@keyframes chatToastIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}`;
    document.head.appendChild(s);
  }
  container.appendChild(toast);
  const dismiss = () => { toast.style.opacity = "0"; toast.style.transition = "opacity .3s"; setTimeout(() => toast.remove(), 300); };
  setTimeout(dismiss, durationMs);
}

// ======================================================
// GUEST MODE HELPERS
// ======================================================
let _guestCountdownTimer = null;

function showGuestBanner() {
  const banner = document.getElementById("guest-banner");
  if (!banner || !_guestData) return;

  // Gastname im Banner anzeigen (Tiername statt "Guest")
  const displayName = _guestData.guestHandle ? guestDisplayName(_guestData.guestHandle) : lang.guestLabel;
  const nameEl = document.getElementById("guest-name-display");
  if (nameEl) {
    nameEl.textContent = displayName;
    nameEl.removeAttribute("data-i18n"); // verhindert Überschreibung durch applyI18n()
  }

  banner.style.display = "flex";
  updateGuestBannerCount();
  _startGuestCountdown();

  // Toast beim Beitreten
  showSystemToast(lang.guestJoined(displayName), 5000, true);
}

function updateGuestBannerCount() {
  const el = document.getElementById("guest-msgs-display");
  if (!el || !_guestData) return;
  const left = Math.max(0, (_guestData.msgLimit || 50) - (_guestData.msgCount || 0));
  el.textContent = String(left);
  // Bei niedrigem Nachrichtenlimit: warnen
  if (left <= 5) el.style.color = "#ef4444";
  // Nachrichtenlimit erreicht → Full-Lock (Overlay + Polling-Stop + Passkey-CTA).
  // Timer-Feld NICHT mehr fälschlich auf "expired" setzen — das war ein UI-Bug.
  if (left === 0) {
    el.textContent = "0";
    el.style.color = "#ef4444";
    lockGuestSession("limit");
  }
}

function _startGuestCountdown() {
  if (_guestCountdownTimer) clearInterval(_guestCountdownTimer);
  const tick = () => {
    const timerEl = document.getElementById("guest-timer-display");
    if (!timerEl || !_guestData?.expiresAt) return;
    const ms = Math.max(0, _guestData.expiresAt - Date.now());
    const h  = Math.floor(ms / 3_600_000);
    const m  = Math.floor((ms % 3_600_000) / 60_000);
    // Unter 1h: Minuten + Sekunden zeigen; sonst: Stunden + Minuten
    if (ms > 0 && ms < 3_600_000) {
      const s = Math.floor((ms % 60_000) / 1_000);
      timerEl.textContent = `${m}m ${String(s).padStart(2,"0")}s`;
    } else {
      timerEl.textContent = `${h}h ${String(m).padStart(2,"0")}m`;
    }
    // Ablauf-Warnung (< 1 Stunde)
    if (ms > 0 && ms < 3_600_000) timerEl.style.color = "#f59e0b";
    if (ms === 0) {
      timerEl.textContent = lang.expired;
      timerEl.style.color = "#ef4444";
      // Interval stoppen — kein weiterer Tick nötig
      clearInterval(_guestCountdownTimer);
      _guestCountdownTimer = null;
      // Full-Lock: Polling stoppen, Overlay einblenden, Passkey-CTA zeigen
      lockGuestSession("expired");
    }
  };
  tick();
  // Über 1h: alle 60s ticken reicht; unter 1h: jede Sekunde für Sekunden-Anzeige
  const intervalMs = (_guestData?.expiresAt && (_guestData.expiresAt - Date.now()) > 3_600_000) ? 60_000 : 1_000;
  _guestCountdownTimer = setInterval(tick, intervalMs);
}

// ─────────────────────────────────────────────────────────────
// GUEST LOCK — sperrt Chat komplett (lesen + schreiben) und zeigt
// Passkey-Login-Aufforderung. Wird bei "Message limit reached" (429)
// oder "Session expired" (410) aufgerufen. Gilt für DM + Group gleich.
// ─────────────────────────────────────────────────────────────
let _guestLocked = false;
function lockGuestSession(reason /* "limit" | "expired" */) {
  if (_guestLocked) return;
  _guestLocked = true;

  // 1) Polling stoppen — kein weiteres Lesen
  try { if (typeof stopPolling === "function") stopPolling(); } catch {}

  // 2) WebSocket (falls offen) schliessen — kein Live-Empfang mehr
  try {
    if (window._renexWs && typeof window._renexWs.close === "function") {
      window._renexWs.close();
    }
  } catch {}

  // 3) Countdown anhalten
  if (_guestCountdownTimer) { clearInterval(_guestCountdownTimer); _guestCountdownTimer = null; }

  // 4) Input hart sperren
  if (inputEl) {
    inputEl.contentEditable = "false";
    inputEl.blur();
  }
  if (sendBtn) sendBtn.disabled = true;

  // 5) Send-Cooldown deaktivieren (Retry verhindern)
  try { if (_guestData) _guestData.msgCount = _guestData.msgLimit || 20; } catch {}

  // 6) Overlay einblenden
  showGuestLockOverlay(reason);
}

function showGuestLockOverlay(reason) {
  // Bereits vorhandenes Overlay nicht doppeln
  if (document.getElementById("guest-lock-overlay")) return;

  const wrapper = document.getElementById("chat-wrapper") || document.body;

  const title = (reason === "expired")
    ? (lang.guestExpiredTitle || "Guest access expired")
    : (lang.guestLimitTitle   || "Message limit reached");
  const desc  = (reason === "expired")
    ? (lang.guestExpired  || "Your guest access has expired. Sign in with a Passkey to continue.")
    : (lang.guestLimitReached || "Limit reached. Sign in with a Passkey to keep reading and writing.");
  const btnText = lang.convertToPasskey || "Login with Passkey";

  const overlay = document.createElement("div");
  overlay.id = "guest-lock-overlay";
  overlay.style.cssText = [
    "position:absolute",
    "inset:0",
    "z-index:500",
    "background:rgba(10,12,16,0.92)",
    "backdrop-filter:blur(6px)",
    "-webkit-backdrop-filter:blur(6px)",
    "display:flex",
    "flex-direction:column",
    "align-items:center",
    "justify-content:center",
    "gap:16px",
    "padding:24px",
    "text-align:center",
    "user-select:none",
    "animation:guestLockIn .3s ease"
  ].join(";");

  // Styles einmalig injizieren
  if (!document.getElementById("guest-lock-style")) {
    const s = document.createElement("style");
    s.id = "guest-lock-style";
    s.textContent = `
      @keyframes guestLockIn { from { opacity:0 } to { opacity:1 } }
      #guest-lock-overlay .lock-icon { font-size:48px; line-height:1; }
      #guest-lock-overlay .lock-title { font-size:18px; font-weight:700; color:var(--text-primary,#fff); max-width:320px; }
      #guest-lock-overlay .lock-desc { font-size:13px; color:var(--text-secondary,#b3b3b3); max-width:320px; line-height:1.5; }
      #guest-lock-overlay .lock-btn {
        margin-top:8px; padding:12px 24px; border-radius:10px; border:none;
        background:var(--accent-voice,#38bdf8); color:#fff; font-size:14px; font-weight:700;
        cursor:pointer; box-shadow:0 4px 16px rgba(56,189,248,0.35);
        transition:transform .12s ease, box-shadow .12s ease;
      }
      #guest-lock-overlay .lock-btn:hover { transform:translateY(-1px); box-shadow:0 6px 20px rgba(56,189,248,0.45); }
      #guest-lock-overlay .lock-btn:active { transform:translateY(0); }
    `;
    document.head.appendChild(s);
  }

  const icon = document.createElement("div");
  icon.className = "lock-icon";
  icon.textContent = reason === "expired" ? "⏱️" : "🔒";

  const h = document.createElement("div");
  h.className = "lock-title";
  h.textContent = title;

  const p = document.createElement("div");
  p.className = "lock-desc";
  p.textContent = desc;

  const btn = document.createElement("button");
  btn.className = "lock-btn";
  btn.type = "button";
  btn.textContent = btnText;
  btn.addEventListener("click", () => { try { convertGuest(); } catch {} });

  overlay.appendChild(icon);
  overlay.appendChild(h);
  overlay.appendChild(p);
  overlay.appendChild(btn);

  // Sicherstellen dass wrapper positionierbar ist
  const cs = getComputedStyle(wrapper);
  if (cs.position === "static") wrapper.style.position = "relative";

  wrapper.appendChild(overlay);
}

// ─────────────────────────────────────────────────────────────
// GUEST STATE PERSISTENCE
// _guestData ist nur In-Memory. Ohne Persistenz gehen Sends nach
// einem Seiten-Reload (z. B. PDF/Attachment-Viewer auf iOS) verloren
// → Zähler "springt" auf 20 zurück. Fix: nach jedem Send speichern
// UND beim Load die authoritative Server-State via /invite/ping holen.
// ─────────────────────────────────────────────────────────────
function persistGuestData() {
  if (!_guestData) return;
  try { setGuestSession(_guestData); } catch {}
}

async function syncGuestStateFromServer() {
  if (!_guestData?.token) return;
  try {
    const r = await fetch(`${API}/invite/ping`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-Guest-Token": _guestData.token },
      body: "{}",
    });
    if (r.status === 410 || r.status === 401) { lockGuestSession("expired"); return; }
    if (!r.ok) return;
    const data = await r.json().catch(() => null);
    if (!data?.ok) return;

    // Server ist die Wahrheit — In-Memory + localStorage angleichen
    _guestData.msgCount  = data.msgCount;
    _guestData.msgLimit  = data.msgLimit;
    _guestData.expiresAt = data.expiresAt;
    persistGuestData();
    updateGuestBannerCount();

    if (data.expired) { lockGuestSession("expired"); return; }
    if ((data.msgsLeft || 0) <= 0) { lockGuestSession("limit"); return; }
  } catch { /* offline → nichts tun, UI behält letzten Stand */ }
}

// Tab kommt zurück (PDF-Viewer geschlossen, App-Switch, BFCache-Restore)
// → Server-State nachladen, damit der Banner nicht stale ist.
if (_guestData) {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !_guestLocked) syncGuestStateFromServer();
  });
  window.addEventListener("pageshow", (e) => {
    if (!_guestLocked) syncGuestStateFromServer();
  });
  // Initial sync beim Laden — falls localStorage hinter Server zurückhängt
  syncGuestStateFromServer();
}

// Gast-Nachricht als Klartext senden (kein E2E)
async function guestSendMessage(text) {
  const now    = Date.now();
  if (now - lastSendTime < SEND_COOLDOWN_MS) { showCooldownWarning(); return; }
  lastSendTime = now;

  const tempId     = `tmp-${now}-${Math.random().toString(16).slice(2)}`;
  const pendingDiv = renderMessage({ from: getMyUser(), message: text, ts: now, tempId, status: "pending" });
  if (pendingDiv) pendingByTempId.set(tempId, pendingDiv);
  inputEl.textContent = "";
  scrollToBottom();
  updateSendButton();

  try {
    const isGroup = isGroupConversation(withUser);
    const bodyObj = isGroup
      ? { to: getMyUser(), convoId: withUser, message: text, e2e: false }
      : { to: withUser, message: text, e2e: false };

    const res  = await fetch(`${API}/chat/send`, {
      method:      "POST",
      credentials: "include",
      headers:     { "Content-Type": "application/json" },
      body:        JSON.stringify(bodyObj),
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 429 && data?.error === "Message limit reached") {
      if (pendingDiv) { pendingDiv.remove(); pendingByTempId.delete(tempId); }
      lockGuestSession("limit");
      return;
    }

    if (res.status === 410) {
      if (pendingDiv) { pendingDiv.remove(); pendingByTempId.delete(tempId); }
      lockGuestSession("expired");
      return;
    }

    if (!res.ok) {
      if (pendingDiv) { pendingDiv.remove(); pendingByTempId.delete(tempId); }
      showSystemToast(lang.sendFailedError(data?.error || lang.unknownError));
      return;
    }

    // Optimistic bubble bestätigen
    if (pendingDiv && data?.message?.id) {
      pendingDiv.classList.remove("pending");
      pendingDiv.dataset.id     = data.message.id;
      pendingDiv.dataset.status = "sent";
      pendingByTempId.delete(tempId);
      renderedMessageIds.add(data.message.id);
    }

    // Lokalen msg_count hochzählen + persistieren (Reload-safe)
    if (_guestData) {
      _guestData.msgCount = (_guestData.msgCount || 0) + 1;
      persistGuestData();
    }
    updateGuestBannerCount();

  } catch (e) {
    if (pendingDiv) { pendingDiv.remove(); pendingByTempId.delete(tempId); }
    showSystemToast("⚠️ Netzwerkfehler — bitte erneut versuchen");
  }
}

// Gast → echten Account konvertieren
function convertGuest() {
  if (!_guestData?.token) return;
  // Token in sessionStorage sichern, damit auth.js nach Passkey-Reg weiterleiten kann
  sessionStorage.setItem("pendingGuestConvert", JSON.stringify({
    token:         _guestData.token,
    convoId:       _guestData.convoId,
    convoType:     _guestData.convoType,
    inviterHandle: _guestData.inviterHandle || withUser,
  }));
  // Zur Login/Register-Seite — top-Level navigieren (auch wenn wir im iframe/Panel sind)
  window.top.location.href = "/?registerGuest=1";
}

// Einladungslink erstellen (für registrierte User)
let _inviteLinkPending = false;
async function createInviteLink() {
  if (_inviteLinkPending) return; // Doppelklick / Spam verhindern
  _inviteLinkPending = true;

  const statusEl = document.getElementById("chat-invite-status");
  if (statusEl) statusEl.textContent = "…";

  const isGroup = isGroupConversation(withUser);
  const bodyObj = isGroup ? { convoId: withUser } : {};
  const fmt = (url) => (lang.linkCopiedClipboard || ((u) => u))(url);

  // Fetch-Promise — wird ggf. direkt an ClipboardItem übergeben
  const doFetch = () => fetch(`${API}/invite/create`, {
    method:      "POST",
    credentials: "include",
    headers:     { "Content-Type": "application/json" },
    body:        JSON.stringify(bodyObj),
  }).then(r => r.json().catch(() => ({}))).then(data => {
    if (!data.inviteUrl) throw new Error("no_url");
    return data.inviteUrl;
  });

  try {
    let copied = false;

    // ── Methode 1: ClipboardItem + Promise (Safari-kompatibel) ──────────
    // Hält den User-Gesture-Kontext aufrecht, auch nach await fetch()
    if (navigator.clipboard && window.ClipboardItem) {
      try {
        const urlPromise = doFetch();
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": urlPromise.then(u => new Blob([fmt(u)], { type: "text/plain" }))
          })
        ]);
        await urlPromise; // Fehler propagieren falls fetch fehlschlug
        copied = true;
      } catch (e) {
        if (e.message === "no_url") throw e; // API-Fehler weitergeben
        // Clipboard-Permission verweigert → Fallback
      }
    }

    // ── Methode 2: writeText (Chrome, Firefox, neueres Safari) ──────────
    if (!copied && navigator.clipboard?.writeText) {
      try {
        const url = await doFetch();
        await navigator.clipboard.writeText(fmt(url));
        copied = true;
      } catch (e) {
        if (e.message === "no_url") throw e;
      }
    }

    // ── Methode 3: execCommand-Fallback (ältere Browser) ────────────────
    if (!copied) {
      const url = await doFetch();
      const ta = document.createElement("textarea");
      ta.value = fmt(url);
      ta.style.cssText = "position:fixed;top:0;left:0;width:2em;height:2em;opacity:0;";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { copied = document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
      if (!copied) {
        // Letzter Ausweg: Link im Toast anzeigen zum manuellen Kopieren
        if (statusEl) statusEl.textContent = "";
        showSystemToast("🔗 " + url, 10000);
        return;
      }
    }

    if (statusEl) statusEl.textContent = "";
    showSystemToast("🔗 " + (lang.linkCopiedInfo || lang.linkCopied), 4000);

  } catch (e) {
    if (statusEl) statusEl.textContent = "❌";
    showSystemToast(e.message === "no_url"
      ? lang.linkCreateFailed
      : lang.networkError);
  } finally {
    setTimeout(() => { _inviteLinkPending = false; }, 5000);
  }
}

// ======================================================
// 🔑 RESET CHAT KEYS — Manueller E2E-Reset für DMs
// ======================================================
// Wenn der Auto-Heal-Mechanismus versagt (z.B. weil der Peer offline war oder
// seine Inbox-Keys in KV veraltet sind), kann der User manuell einen sauberen
// Key-Austausch erzwingen. Schritt für Schritt:
//   1) Confirm-Dialog
//   2) `cmk_reset`-Control-Message an Peer senden (er löscht seinen lokalen CMK)
//   3) Lokalen CMK löschen
//   4) Bootstrap-Guards leeren
//   5) ensureConversationReady → Authority generiert neuen CMK, Non-Authority requestet
//   6) Kurz warten, Messages neu laden
// ⚠️ Alte Nachrichten bleiben unentschlüsselbar — Preis für frischen Schlüssel.
let _keyResetInProgress = false;
async function resetChatKeys() {
  if (_keyResetInProgress) return;
  if (!withUser || isGroupConversation(withUser)) return; // nur DMs
  if (!confirm(lang.resetKeysConfirm || "Reset encryption keys for this chat? Old messages will stay unreadable.")) return;

  _keyResetInProgress = true;
  const statusEl = document.getElementById("chat-key-reset-status");
  if (statusEl) statusEl.textContent = "…";

  const me  = getMyUser();
  const peer = withUser;
  const sid = dmSessionId(me, peer);

  try {
    // 1) Peer benachrichtigen (er räumt seinen lokalen CMK weg)
    try {
      await apiFetch("/chat/send", {
        method: "POST",
        body: JSON.stringify({
          to: peer,
          e2e: false,
          v: 1,
          type: "cmk_reset",
          message: "__cmk_reset__",
          sid
        })
      });
    } catch (e) {
      console.warn("cmk_reset send failed (non-fatal):", e);
    }

    // 2) Lokalen CMK + Bootstrap-Guard wegwerfen
    try { await deleteCMK(peer); } catch {}
    try { sessionStorage.removeItem(`bootstrapped:${sid}`); } catch {}
    try { sessionStorage.removeItem(`cmk_req_sent:${sid}`); } catch {}
    // RAM-Cache leeren
    sessionKeyBytes = null;
    sessionCmkBytes = null;
    sessionRotationIndex = 0;
    skCache.clear();
    // Alle bisher-failed-Bubbles aus DOM + Tracking entfernen
    // damit nach dem Re-Bootstrap neu gerendert werden kann
    try {
      for (const id of _decryptFailedRenderedIds) {
        const el = messagesEl?.querySelector(`[data-id="${id}"]`);
        if (el) el.remove();
        renderedMessageIds.delete(id);
        decryptedCache?.delete?.(id);
      }
      _decryptFailedRenderedIds.clear();
    } catch {}

    // 3) Bootstrap neu auslösen (Authority → sendet neuen CMK; sonst → cmk_req)
    try {
      await ensureConversationReady(me, peer, fetchInboxKeys, apiFetch);
    } catch (e) {
      console.warn("ensureConversationReady nach Reset fehlgeschlagen:", e);
    }

    // 4) Session frisch booten (setzt sessionKeyBytes etc.)
    try {
      const entry = await bootConversation(me, peer);
      if (entry?.skBytes) {
        sessionKeyBytes = entry.skBytes;
        sessionRotationIndex = entry.rotationIndex ?? 0;
        sessionCmkBytes = entry.cmkBytes ?? sessionCmkBytes;
      }
    } catch {}

    if (statusEl) statusEl.textContent = "";
    showSystemToast(lang.resetKeysDone || "🔁 Keys reset — sending first message will re-establish encryption", 8000);

    // 5) Nachrichten neu laden (nach kurzer Verzögerung — Zeit für Peer-Sync)
    setTimeout(() => { loadMessages?.().catch(() => {}); }, 2000);
    setTimeout(() => { loadMessages?.().catch(() => {}); }, 6000);
  } catch (e) {
    console.error("resetChatKeys failed:", e);
    if (statusEl) statusEl.textContent = "";
    showSystemToast(lang.resetKeysFailed || "⚠️ Could not reset keys — please try again", 5000);
  } finally {
    _keyResetInProgress = false;
  }
}

// Globale Exports für HTML-onclick-Handler (ES-Module sind nicht global)
window.convertGuest   = convertGuest;
window.createInviteLink = createInviteLink;
window.resetChatKeys  = resetChatKeys;

// Guest display name & handle replacement → shared/guestUtils.js

function showChatToast({ emoji, from, chatTarget, groupName }) {
  const container = document.getElementById("chat-toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.style.cssText = "pointer-events:auto;cursor:pointer;background:var(--bg-secondary,#1e1e1e);border:1px solid var(--border,#333);border-radius:12px;padding:10px 14px;display:flex;align-items:center;gap:10px;box-shadow:0 4px 16px rgba(0,0,0,.4);animation:chatToastIn .25s ease;";
  const fromLabel = from && from !== "undefined" ? from : "Jemand";
  toast.innerHTML = `<span style="font-size:20px;line-height:1;">${emoji || "💬"}</span><span style="font-size:13px;color:var(--text-primary,#fff);">${fromLabel} hat auf deine Nachricht reagiert</span>`;
  // CSS-Animation inline einfügen (einmalig)
  if (!document.getElementById("chat-toast-style")) {
    const s = document.createElement("style");
    s.id = "chat-toast-style";
    s.textContent = `@keyframes chatToastIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}`;
    document.head.appendChild(s);
  }
  // Klick → direkt in den Chat
  toast.addEventListener("click", () => {
    if (!chatTarget) return;
    const url = groupName
      ? `/chat?with=${encodeURIComponent(chatTarget)}&name=${encodeURIComponent(groupName)}`
      : `/chat?with=${encodeURIComponent(chatTarget)}`;
    window.location.href = url;
  });
  container.appendChild(toast);
  const dismiss = () => { toast.style.opacity = "0"; toast.style.transition = "opacity .3s"; setTimeout(() => toast.remove(), 300); };
  setTimeout(dismiss, 4000);
}

// ======================================================
// CMK v2 – Epoch Definition (GLOBAL)
// ======================================================
// EPOCH_MS, MAX_MESSAGE_LENGTH, SEND_COOLDOWN_MS etc. → chatState.js

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
let fallbackFlushTimer = null;
let e2eReady = false;
let lastSendBtnState = null;
let sessionKeyBytes = null;
let sessionCmkBytes = null;
let sessionRotationIndex = 0;
let sentMessageCount = 0;

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
// ROTATION_THRESHOLD, ROTATION_INTERVAL_MS → chatState.js
let timeRotationTimer = null;
const deferredInboundMessages = [];
const deferredInboundIds = new Set();
const pendingGskRequests = new Set();
const gskRequestCooldown = new Map();
// Phase 5.2: Exponential-Backoff-State für request_gsk-Retries
const gskRetryTimers = new Map();    // key → setTimeout-Handle
const gskAttemptCount = new Map();   // key → number of attempts so far
const skCache = new Map();    // "sid:rotationIndex" → Uint8Array(32)
let hasInboxKeys = false;

// ======================================================
// DEFERRED SEND QUEUE (First message before CMK)
// ======================================================
let deferredQueue = []; 
// 🔁 Flush Guards
let isFlushingDeferred = false;
let isFlushingDeferredInbound = false;
let deferredBackoff = 1000;          // Start 1s
// MAX_DEFERRED_BACKOFF → chatState.js

// ======================================================
// SEND-BUTTON LOGIK (zentral)
// ======================================================
// ======================================================
// FIX 3 — canSend ist REIN UI
// ======================================================
function canSend() {
  // Gast: Nachrichtenlimit erreicht ODER Session gesperrt → Senden sperren
  if (_guestData) {
    if (_guestLocked) return false;
    const left = Math.max(0, (_guestData.msgLimit || 50) - (_guestData.msgCount || 0));
    if (left === 0) return false;
    if (_guestData.expiresAt && Date.now() > _guestData.expiresAt) return false;
  }
  return true;
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

inputEl.textContent = text;
sendBtn.click();
}

// Guest session → chatState.js (_guestData, _isGuestMode)

// Gäste haben nur einen Chat → Zurück-Button macht keinen Sinn (würde zu /inbox/
// navigieren, was für Gäste nicht existiert). Statt dessen: RENEX-Logo als
// Branding-Anzeige. Der Convert-CTA "Mit Passkey anmelden" im Footer ist der
// einzige sinnvolle Ausweg.
if (_isGuestMode) {
  const _backBtn = document.getElementById("back-btn");
  const _brand   = document.getElementById("guest-brand");
  if (_backBtn) _backBtn.style.display = "none";
  if (_brand)   _brand.style.display   = "block";
}

// ======================================================
// URL PARAMS
// ======================================================
const params = new URLSearchParams(window.location.search);
withUser = params.get("with");

// Validation patterns → chatState.js
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

// Guest-Conversion-Grenze: Timestamp der "X is now Y" System-Nachricht, sofern
// der aktuelle User selbst der konvertierte Teil ist. Alle regulären Messages
// mit ts <= _convertBoundaryTs wurden in der Gast-Ära verschlüsselt und sind
// mit den neuen Account-Keys nicht mehr entschlüsselbar — deshalb stumm ausblenden.
let _convertBoundaryTs = 0;

// Reply-Kontext aus Gruppen-Chat (persönliche Antwort per DM)
let _initialReplyFrom = null;
let _initialReplyText = null;
try {
  const rf = params.get("replyFrom");
  const rt = params.get("replyText");
  if (rf && rt) {
    _initialReplyFrom = decodeURIComponent(rf).slice(0, 64);
    _initialReplyText = decodeURIComponent(rt).slice(0, 200);
  }
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
  // 🔔 Toast: nur wenn meine Nachricht reagiert wurde
  if (event.action === "added" && event.msgAuthor && event.from) {
    const me = getMyUser();
    if (me && event.msgAuthor.toLowerCase() === me.toLowerCase() && event.from.toLowerCase() !== me.toLowerCase()) {
      // Gruppe (UUID) → zum Gruppen-Chat; DM → zum Chat mit dem Reactor
      const isGroup = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.convoId || "");
      const chatTarget = isGroup ? event.convoId : event.from;
      const groupName  = isGroup ? (event.groupName || null) : null;
      showChatToast({ emoji: event.emoji || "💬", from: event.from, chatTarget, groupName });
    }
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

  // Race-Fix: wenn diese Nachricht VON MIR kommt UND ich gerade eigene Messages
  // flushe (pendingByTempId hat Einträge), SKIP die NEW_MESSAGE. Der fetch-
  // Response von flushDeferredQueue adoptiert das pending-Bubble und vergibt
  // die richtige ID. Ohne diesen Skip: Duplikat (pending-Bubble + neue Bubble).
  if (isForThisChat && msg.from === me && pendingByTempId.size > 0
      && msg.id && !renderedMessageIds.has(msg.id)) {
    console.log("⏭️ NEW_MESSAGE von mir übersprungen — pending Flush läuft:", msg.id);
    return;
  }

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

  // 🔑 DEVICE_ADDED_SELF (Gruppen): Eigenes neues Device → GSK für eigene Devices in KV syncen.
  // Phase 5.3: Triggert syncGroupSKToOwnDevices, der den new-device-Erkenner nutzt
  // und Throttle automatisch umgeht.
  if (event?.type === "DEVICE_ADDED_SELF" && isGroupConversation(withUser)) {
    console.log("🔑 DEVICE_ADDED_SELF (Group) → GSK für eigene neue Devices syncen");
    syncGroupSKToOwnDevices(
      withUser,
      getMyUser(),
      (h, opts) => fetchInboxKeys(h, { forceFresh: true, ...(opts || {}) }),
      apiFetch
    ).catch(e => console.warn("⚠️ syncGroupSKToOwnDevices nach DEVICE_ADDED_SELF failed", e));
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
      // Phase 4 #6: Während Recovery nicht rotieren — Race verhindern
      if (isInRecovery(withUser)) {
        _pendingRotation.add(String(withUser || "").toLowerCase());
        console.log("⏸️ DEVICE_REMOVED-Rotation deferred — Recovery läuft");
        return;
      }
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
    // Phase 5.2: Retry-State für diesen Sender aufräumen (Backoff-Timer killen, Counter reset)
    if (event.from) resetGskRequestState(withUser, event.from);
    // loadMessages holt evtl. verpasste Nachrichten aus DB; flush entschlüsselt Placeholder
    loadMessages().catch(() => {}).finally(() => flushDeferredInboundMessages().catch(() => {}));
    // Bubble-State auf "success" setzen für sauberen Cooldown-Visual (Fix 2)
    if (event.from) {
      const stateKey = `decrypt_retry_state:${withUser}:${event.from}`;
      const success = { phase: "success", ts: Date.now() };
      try { sessionStorage.setItem(stateKey, JSON.stringify(success)); } catch {}
      document.dispatchEvent(new CustomEvent("cmk-req-state-change", { detail: { peer: `${withUser}:${event.from}`, state: success } }));
    }
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

  // 🔄 GUEST_CONVERTED: Gast hat sich registriert → Mitgliederliste + Chat refreshen
  if (event?.type === "GUEST_CONVERTED" && event.groupId === withUser) {
    console.log("🔄 Gast konvertiert:", event.oldHandle, "→", event.newHandle);
    initGroupMembersUI(withUser).catch(() => {});
    loadMessages().catch(() => {});
    return;
  }

  // 👤 MEMBER_JOINED: eingeloggter User über Invite-Link beigetreten → GSK proaktiv pushen
  if (event?.type === "member_joined" && event.groupId === withUser) {
    initGroupMembersUI(withUser).catch(() => {});
    const myHandle = _isGuestMode ? _guestData?.guestHandle : getMyUser();
    if (event.handle && event.handle !== myHandle && myHandle) {
      (async () => {
        try {
          await getOrCreateGroupSK(event.groupId, myHandle);
          const r = await apiFetch(`/e2e/inbox/get?user=${encodeURIComponent(event.handle)}`);
          const devs = Array.isArray(r.devices) ? r.devices : [];
          if (devs.length) {
            await distributeGroupSK(event.groupId, myHandle,
              devs.map(d => ({ ...d, memberHandle: event.handle })), apiFetch);
          } else {
            // Race: neues Mitglied hat Key noch nicht hochgeladen → nach 3s nochmal versuchen
            setTimeout(async () => {
              try {
                const r2 = await apiFetch(`/e2e/inbox/get?user=${encodeURIComponent(event.handle)}`);
                const devs2 = Array.isArray(r2.devices) ? r2.devices : [];
                if (devs2.length) {
                  await distributeGroupSK(event.groupId, myHandle,
                    devs2.map(d => ({ ...d, memberHandle: event.handle })), apiFetch);
                }
              } catch (e2) { console.warn("⚠️ GSK retry push zu neuem Mitglied fehlgeschlagen:", e2); }
            }, 3000);
          }
        } catch (e) { console.warn("⚠️ GSK push zu neuem Mitglied fehlgeschlagen:", e); }
      })();
    }
    return;
  }

  // 👤 GUEST_JOINED: Gast hat die Gruppe/DM betreten → Toast + Mitgliederliste neu laden + GSK pushen
  if ((event?.type === "GUEST_JOINED" || event?.type === "guest_joined") &&
      (event.groupId === withUser || event.handle === withUser ||
       (event.groupId && event.groupId.split(":").includes(withUser)))) {
    console.log("👤 Gast beigetreten:", event.handle);
    // Toast für den Einlader anzeigen
    if (!_isGuestMode && event.handle) {
      showSystemToast(`👤 ${guestDisplayName(event.handle)} joined the chat`, 5000);
    }
    initGroupMembersUI(withUser).catch(() => {});
    // Eigenen GSK proaktiv an den neuen Gast senden (Online-Fast-Path)
    // → Gast kann Nachrichten sofort entschlüsseln ohne auf request_gsk zu warten
    const myHandleForGuestJoin = _isGuestMode ? _guestData?.guestHandle : getMyUser();
    if (event.handle && myHandleForGuestJoin && event.handle !== myHandleForGuestJoin) {
      (async () => {
        try {
          await getOrCreateGroupSK(event.groupId, myHandleForGuestJoin);
          const r = await apiFetch(`/e2e/inbox/get?user=${encodeURIComponent(event.handle)}`);
          const devs = Array.isArray(r.devices) ? r.devices : [];
          if (devs.length) {
            await distributeGroupSK(event.groupId, myHandleForGuestJoin,
              devs.map(d => ({ ...d, memberHandle: event.handle })), apiFetch);
          } else {
            // Race: Gast-Key-Upload läuft noch → nach 3s nochmal versuchen
            setTimeout(async () => {
              try {
                const r2 = await apiFetch(`/e2e/inbox/get?user=${encodeURIComponent(event.handle)}`);
                const devs2 = Array.isArray(r2.devices) ? r2.devices : [];
                if (devs2.length) {
                  await distributeGroupSK(event.groupId, myHandleForGuestJoin,
                    devs2.map(d => ({ ...d, memberHandle: event.handle })), apiFetch);
                }
              } catch (e2) { console.warn("⚠️ GSK retry push fehlgeschlagen:", e2); }
            }, 3000);
          }
        } catch (e) { console.warn("⚠️ GSK push zu Gast fehlgeschlagen:", e); }
      })();
    }
    return;
  }

  // 🚫 GROUP_MEMBER_REMOVED: Mitglied wurde entfernt
  if (event?.type === "group_member_removed" && event.groupId === withUser) {
    const myHandle = getMyUser();
    if (event.handle === myHandle) {
      // Ich wurde entfernt → Chat verlassen
      alert(lang.youWereRemoved || "You were removed from this group.");
      window.location.href = "/";
    } else {
      initGroupMembersUI(withUser).catch(() => {});
      loadMessages().catch(() => {});
    }
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
    const myHandle = _isGuestMode ? _guestData?.guestHandle : getMyUser();
    if (!myHandle || event.from === myHandle) return;
    // Cache immer invalidieren: bei GUEST_JOINED könnte ein leeres Ergebnis gecacht worden sein
    // (Race: Gast-Key-Upload kommt nach dem GUEST_JOINED Event → stale empty cache)
    invalidateInboxKeyCache(event.from);
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
      const activeDays = event.days || null; // days=0 → null (deaktiviert)
      updateAutoDeleteHeaderLabel(activeDays, true);
      showAutoDeleteBanner(activeDays ? lang.autoDeleteActive(autoDeleteLabel(activeDays)) : lang.autoDeleteDisabled, "success");
    } else if (event.action === "decline" || event.action === "cancel") {
      const restoreDays = event.original_days || null;
      if (restoreDays) {
        // Peer hat abgelehnt → altes aktives Setting wiederherstellen
        updateAutoDeleteHeaderLabel(restoreDays, true);
        showAutoDeleteBanner("❌ Vorschlag abgelehnt – Auto-Delete bleibt aktiv", "info");
      } else {
        updateAutoDeleteHeaderLabel(null, true);
        showAutoDeleteBanner("🗑️ Auto-Delete deaktiviert", "info");
      }
    }
    return;
  }

    // CMK_RESET: Peer hat die E2E-Schlüssel zurückgesetzt — lokale Session flushen
    // damit die nächste Nachricht mit dem frischen CMK verschlüsselt wird.
    if (e.data?.type === "CMK_RESET" && e.data.peer === withUser) {
      console.warn("🔁 CMK_RESET von Peer empfangen — lokale Session verwerfen");
      sessionKeyBytes = null;
      sessionCmkBytes = null;
      sessionRotationIndex = 0;
      skCache.clear();
      // Failed-Bubbles auch hier wegräumen — neue Chance mit neuem CMK
      try {
        for (const id of _decryptFailedRenderedIds) {
          const el = messagesEl?.querySelector(`[data-id="${id}"]`);
          if (el) el.remove();
          renderedMessageIds.delete(id);
          decryptedCache?.delete?.(id);
        }
        _decryptFailedRenderedIds.clear();
      } catch {}
      e2eReady = false;
      updateSendButton();
      showSystemToast(lang.resetKeysRemote || "🔁 Peer reset keys — re-establishing…", 6000);
      // Bootstrap neu anstossen
      try {
        await ensureConversationReady(getMyUser(), withUser, fetchInboxKeys, apiFetch);
      } catch {}
      // Session frisch booten
      try {
        const entry = await bootConversation(getMyUser(), withUser);
        if (entry?.skBytes) {
          sessionKeyBytes = entry.skBytes;
          sessionRotationIndex = entry.rotationIndex ?? 0;
          sessionCmkBytes = entry.cmkBytes ?? sessionCmkBytes;
          e2eReady = true;
          updateSendButton();
        }
      } catch {}
      setTimeout(() => { loadMessages?.().catch(() => {}); }, 1500);
      return;
    }

    if (e.data?.type !== "CMK_READY") return;
    if (e.data.peer !== withUser) return;

    console.log("🔄 CMK_READY empfangen → SessionKey aktualisieren", { wasReady: e2eReady });

    try {

      // Phase 4 #4: Recovery-Lock räumen — neuer CMK ist da, deferred Messages
      // können jetzt mit frischem SessionKey verschickt werden.
      const peerKey = String(withUser || "").toLowerCase();
      const hadLock = _recoveryInProgress.has(peerKey);
      if (hadLock) {
        _recoveryInProgress.delete(peerKey);
        console.log("🔓 CMK_READY: Recovery-Lock geräumt für", withUser);
      }

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

      // 🔓 Ein frischer CMK kam an → einmaliger Retry aller "decrypt-failed"-Bubbles.
      // Nicht bei jedem Poll, sondern NUR einmalig hier (ereignis-getriggert) —
      // sonst DOM-Thrashing. Nachrichten die immer noch failen, bleiben als
      // Fail-Bubble stehen bis zum nächsten CMK_READY oder Seiten-Reload.
      try {
        if (_decryptFailedRenderedIds.size > 0 && messagesEl) {
          const retryIds = Array.from(_decryptFailedRenderedIds);
          for (const id of retryIds) {
            const oldEl = messagesEl.querySelector(`[data-id="${id}"]`);
            if (oldEl) oldEl.remove();
            renderedMessageIds.delete(id);
            renderedMessageStatus?.delete?.(id);
            // decryptedCache leeren falls alter Fail-Wert drin ist
            decryptedCache?.delete?.(id);
          }
          _decryptFailedRenderedIds.clear();
          console.warn("🔓 CMK_READY: Retry von", retryIds.length, "fehlgeschlagenen Messages");
        }
      } catch (e) { console.warn("Retry-Cleanup fehlgeschlagen:", e); }

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

      // Phase 4 #6: Falls Rotation während Recovery deferred wurde, jetzt nachholen.
      const pendingRotKey = String(withUser || "").toLowerCase();
      if (_pendingRotation.has(pendingRotKey)) {
        _pendingRotation.delete(pendingRotKey);
        console.log("⏰ Post-CMK_READY: deferred Rotation wird ausgeführt");
        doRotationAndRefresh().catch(e => console.warn("⚠️ Deferred Rotation fehlgeschlagen", e));
      }

      // Nach dem Reload explizit nach unten scrollen — falls der User während der
      // Self-Healing-Phase nach oben gescrollt hatte, würde die wasAtBottom-Heuristik
      // sonst nicht greifen und neue Messages wären unsichtbar. Zwei Rounds weil
      // der zweite Poll (via Self-Heal-Timer nach 3s/8s) evtl. noch NEUE msgs bringt.
      try {
        if (typeof scrollToBottom === "function") scrollToBottom();
        setTimeout(() => {
          try { if (typeof scrollToBottom === "function") scrollToBottom(); } catch {}
        }, 500);
      } catch {}

    } catch (err) {
      console.error("CMK_READY handling failed", err);
    }
  };
}

const renderedMessageIds = new Set();   // echte Server-IDs
// Messages die als "🔒 Decrypt-Failed"-Platzhalter-Bubble gerendert wurden.
// Wenn die Message später wieder kommt und OK dekodiert (z.B. nach Self-Heal
// oder Key-Reset), ersetzen wir die alte Bubble durch die echte.
const _decryptFailedRenderedIds = new Set();

// Reply Bar, Reactions, Context Menu → chatContextMenu.js
const pendingByTempId = new Map();      // tempId -> div
// 🔥 Status Tracking (verhindert verlorene Updates)
const renderedMessageStatus = new Map(); // messageId -> status
// ✏️ Zuletzt angewendeter edited_at pro Nachricht (Polling-Fallback für Gäste/WS-off)
const renderedMessageEditedAt = new Map(); // messageId -> edited_at (Number)
// 🔗 Original-SID pro Nachricht — für Edit-Decrypt Fallback nach Guest→Account-Conversion.
// Edits haben keine eigene sid im Payload; wenn die aktuelle Session-SID nicht passt
// (weil der Peer konvertiert wurde), retryen wir mit der gecachten Original-SID damit
// FIX A (SID-Peer-Fallback in decryptMessageIfNeeded) greifen kann.
const messageSidCache = new Map(); // messageId -> m.sid
// 🗑️ Bereits gelöschte Nachrichten (verhindert Render nach Delete-Event)
const deletedMessageIds = new Set();
// 🔁 Retry-Zähler für deferred inbound Messages (GSK-Wartezeit)
const deferredInboundRetryCount = new Map(); // messageId → retryCount
// MAX_INBOUND_RETRIES → chatState.js
// 🔐 Decrypt Cache: verhindert doppelte Crypto + doppelte Logs
// LRU-Eviction: ältesten Eintrag löschen statt ganzen Cache (Map iteriert in Einfügereihenfolge)
const decryptedCache = new Map(); // msg.id -> plaintext
// MAX_DECRYPT_CACHE → chatState.js

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
// lruCacheSet → chatCrypto.js (wrapper at top of file)


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
// INBOX_KEY_TTL → chatState.js

export function invalidateInboxKeyCache(handle) {
  inboxKeyCache.delete(handle);
}

// Presence & Contacts → chatPresence.js

async function fetchInboxKeys(peerHandle, opts = {}) {
  const { forceFresh = false } = opts;

  // Cache-Hit? (skip bei forceFresh — Recovery braucht aktuelle Server-Daten)
  if (!forceFresh) {
    const cached = inboxKeyCache.get(peerHandle);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.devices;
    }
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

    console.log("📮 Inbox-Keys geladen:", peerHandle, devices.length, forceFresh ? "(fresh)" : "(cached-ok)");
    return devices;
  } catch (e) {
    console.warn("Inbox-Key fetch failed", e);
    // Bei Fehler: alten Cache zurückgeben falls vorhanden (nicht bei forceFresh)
    if (!forceFresh) return inboxKeyCache.get(peerHandle)?.devices ?? [];
    return [];
  }
}

// Cache-Invalidation für Recovery-Szenarien (Peer hat sich neu registriert)
async function invalidatePeerCache(peerHandle) {
  inboxKeyCache.delete(peerHandle);
  try { await idbSet(`peer-devices:${peerHandle}`, null); } catch {}
  console.warn("🗑️ Peer-Cache invalidiert:", peerHandle);
}

// ======================================================
// FIX B — SELF-HEALING für persistente Decrypt-Fehler (DMs)
// Nach N Fails in Folge vom gleichen Peer → cmk_req forcieren
// (umgeht den 30s-Cooldown aus sessionManager.js), max 1x pro 60s.
// Wird zurückgesetzt sobald wieder erfolgreich entschlüsselt wird.
// ======================================================
const _decryptFailCounters = new Map(); // peer → { count, lastHealTs }
const DECRYPT_FAIL_THRESHOLD      = 3;
const DECRYPT_FAIL_RETRIGGER_MS   = 60_000;

// ======================================================
// Phase 4 #4 — Recovery-State-Tracking
// User schreibt während Recovery → Nachricht würde mit altem CMK verschlüsselt.
// Lösung: Während Recovery aktiv ist, in deferredQueue puffern; nach Recovery
// flushen mit frischen Keys. Auch Rotation wird deferred (Phase 4 #6).
// ======================================================
const _recoveryInProgress = new Set(); // peer-handles, die gerade in Recovery sind
const _pendingRotation = new Set(); // peers, deren Rotation während Recovery deferred wurde
// Phase 5.5: Group-Rotation-Lock — während eigener GSK rotiert + neu verteilt wird,
// dürfen Sends nicht raus (sonst encrypten sie mit altem oder neuem GSK je nach Timing).
// Ähnlich zu _recoveryInProgress aber für Gruppen-spezifisches Eigen-Rotieren.
const _groupRotationInProgress = new Set(); // groupIds, die gerade rotieren

function isInRecovery(peer) {
  return _recoveryInProgress.has(String(peer || "").toLowerCase());
}

// Phase 5.5: Group-Rotation-Lock — true wenn gerade eine GSK-Rotation für die
// Gruppe läuft (lokaler GSK-Wechsel + Re-Distribution).
function isGroupRotating(groupId) {
  return _groupRotationInProgress.has(String(groupId || ""));
}

// Phase 5.5: GSK-Rotation mit Lock. Sends werden in deferredQueue gepuffert,
// bis Distribution komplett ist. Danach Auto-Flush mit neuem GSK.
async function withGroupRotationLock(groupId, fn) {
  const key = String(groupId || "");
  _groupRotationInProgress.add(key);
  try {
    return await fn();
  } finally {
    _groupRotationInProgress.delete(key);
    // Aufgestaute Sends nach Rotation flushen (mit neuem GSK)
    if (groupId === withUser && deferredQueue.length > 0) {
      console.log(`📤 Post-Group-Rotation: ${deferredQueue.length} aufgestaute Nachrichten flushen`);
      flushDeferredQueue().catch(e => console.warn("⚠️ Post-Group-Rotation flush fehlgeschlagen", e));
    }
  }
}

async function withRecoveryLock(peer, fn) {
  const key = String(peer || "").toLowerCase();
  _recoveryInProgress.add(key);
  try {
    return await fn();
  } finally {
    _recoveryInProgress.delete(key);
    // Nach Recovery: Local State refreshen + deferredQueue flushen
    try {
      const me = getMyUser();
      if (me && peer && peer === withUser) {
        const entry = await bootConversation(me, peer);
        if (entry?.skBytes) {
          sessionKeyBytes = entry.skBytes;
          sessionCmkBytes = entry.cmkBytes ?? sessionCmkBytes;
          sessionRotationIndex = entry.rotationIndex ?? 0;
          console.log("🔄 Post-Recovery: SessionKey refreshed");
        }
      }
      // Deferred Rotation einlösen falls aufgestaut
      if (_pendingRotation.has(key)) {
        _pendingRotation.delete(key);
        console.log("⏰ Post-Recovery: deferred Rotation wird ausgeführt");
        doRotationAndRefresh().catch(e => console.warn("⚠️ Deferred Rotation fehlgeschlagen", e));
      }
      // Deferred Queue flushen mit neuem SessionKey
      if (deferredQueue.length > 0) {
        console.log(`📤 Post-Recovery: ${deferredQueue.length} aufgestaute Nachrichten flushen`);
        flushDeferredQueue().catch(e => console.warn("⚠️ Post-Recovery flush fehlgeschlagen", e));
      }
    } catch (e) {
      console.warn("⚠️ Post-Recovery refresh fehlgeschlagen", e);
    }
  }
}

async function sendCmkReqNow(peer) {
  if (!peer) {
    e2eLog("CMK_REQ", "skipped", { reason: "no_peer" }, "warn");
    return false;
  }
  const me = getMyUser();
  if (!me || peer === me) {
    e2eLog("CMK_REQ", "skipped", { reason: "self_or_no_me", me, peer }, "warn");
    return false;
  }
  const sid = dmSessionId(me, peer);
  const amAuthority = isAuthority(me, peer);
  e2eLog("CMK_REQ", "start", { peer, sid, authority: amAuthority });

  // ── Asymmetrisches Self-Healing ────────────────────────────
  // Nur die Authority (= alphabetisch kleinerer Handle) darf CMK versenden.
  // Wenn ICH Authority bin: re-bootstrap → neue Inbox-Keys des Peers fetchen
  // und meinen CMK erneut wrappen + senden. Das passt z.B. wenn der Peer
  // sich auf neuem Device registriert hat → seine alten Inbox-Keys sind tot.
  if (amAuthority) {
    return withRecoveryLock(peer, async () => {
      try {
        // Recovery: Cache invalidieren (Peer hat evtl. neue Inbox-Keys),
        // damit ensureBootstrapped frische Server-Daten holt.
        await invalidatePeerCache(peer);
        // `ensureBootstrapped` hat einen 1x-Guard — recoveryMode räumt den selbst weg.
        // recoveryMode=true → alter CMK wird verworfen + frischer erzeugt
        // (löst Divergenz wenn Peer mit eigenem lokalen CMK existiert).
        await ensureBootstrapped(me, peer, (h, o) => fetchInboxKeys(h, { forceFresh: true, ...(o || {}) }), apiFetch, { recoveryMode: true });
        e2eLog("CMK_REQ", "authority_reboot_ok", { peer, sid });
        console.warn("🔁 Self-healing (Authority): CMK re-bootstrap an", peer);
        return true;
      } catch (e) {
        e2eLog("CMK_REQ", "authority_reboot_failed", { peer, sid, err: String(e) }, "error");
        console.warn("Self-healing bootstrap failed:", e);
        return false;
      }
    });
  }

  // ── Non-Authority: CMK beim Peer anfordern ─────────────────
  // Recovery-Lock: User-Sends während der Authority noch antwortet würden mit
  // altem CMK verschlüsselt → für 10s in deferredQueue puffern.
  // Lock wird in receiveCMK frühzeitig geräumt sobald neuer CMK ankommt.
  const peerKey = String(peer || "").toLowerCase();
  _recoveryInProgress.add(peerKey);
  const recoveryTimeout = setTimeout(() => {
    if (_recoveryInProgress.has(peerKey)) {
      _recoveryInProgress.delete(peerKey);
      console.log("⏱️ Recovery-Lock-Timeout (10s) für", peer, "— Queue wird unter altem CMK geflusht");
      if (deferredQueue.length > 0) flushDeferredQueue().catch(() => {});
    }
  }, 10_000);

  // Recovery: Cache invalidieren — der Peer hat evtl. neue Inbox-Keys, an die er
  // den frischen CMK schicken muss. Ohne fresh-fetch könnte er stale Devices nutzen.
  await invalidatePeerCache(peer);
  // Cooldown-Guard aus sessionManager.js entfernen → sofortiger Re-Send erlaubt
  try { sessionStorage.removeItem(`cmk_req_sent:${sid}`); } catch {}
  try {
    await apiFetch("/chat/send", {
      method: "POST",
      body: JSON.stringify({
        to: peer,
        e2e: false,
        v: 1,
        type: "cmk_req",
        message: "__cmk_req__",
        sid
      })
    });
    sessionStorage.setItem(`cmk_req_sent:${sid}`, String(Date.now()));
    e2eLog("CMK_REQ", "sent_to_peer", { peer, sid });
    console.warn("🔁 Self-healing (Non-Authority): CMK_REQ gesendet an", peer);
    return true;
  } catch (e) {
    clearTimeout(recoveryTimeout);
    _recoveryInProgress.delete(peerKey);
    e2eLog("CMK_REQ", "send_failed", { peer, sid, err: String(e) }, "error");
    console.warn("Self-healing cmk_req failed:", e);
    return false;
  }
}

// Zählt NUR "frische" Decrypt-Failures (letzte 5 min) als Anlass für Self-Heal.
// Alte, dauerhaft unentschlüsselbare Messages (Device-Wechsel vor Tagen) sollen
// nicht mehr den Bootstrap-Mechanismus triggern — das hat zu Bootstrap-Stürmen geführt.
const FRESH_FAIL_WINDOW_MS = 5 * 60_000;
function bumpDecryptFailCounter(fromHandle, msgTs) {
  if (!fromHandle) return;
  if (fromHandle === getMyUser()) return;          // eigene Msgs → kein Self-Heal
  if (isGroupConversation(withUser)) return;        // Gruppen haben eigenen GSK-Flow
  // ⏱ Nur frische Messages zählen (alte sind dauerhaft verloren, kein Retry sinnvoll)
  if (msgTs && (Date.now() - Number(msgTs)) > FRESH_FAIL_WINDOW_MS) return;
  const now = Date.now();
  const s = _decryptFailCounters.get(fromHandle) || { count: 0, lastHealTs: 0 };
  s.count++;
  if (s.count >= DECRYPT_FAIL_THRESHOLD &&
      (now - (s.lastHealTs || 0)) > DECRYPT_FAIL_RETRIGGER_MS) {
    s.lastHealTs = now;
    s.count = 0;
    (async () => {
      // Cache invalidieren bevor wir Recovery starten — Peer hat sich evtl. neu
      // registriert (neue Devices) oder hat divergenten CMK → frische Daten holen.
      // sendCmkReqNow ruft das auch nochmal, aber hier doppelt sicher.
      await invalidatePeerCache(fromHandle);
      const ok = await sendCmkReqNow(fromHandle);
      if (ok) {
        // Nach 3s nochmal polling, dann 8s → ggf. sind neue Nachrichten da
        // die jetzt mit dem frischen CMK dekodiert werden können.
        setTimeout(() => { loadMessages?.().catch(() => {}); }, 3000);
        setTimeout(() => { loadMessages?.().catch(() => {}); }, 8000);
      }
    })();
  }
  _decryptFailCounters.set(fromHandle, s);
}

function resetDecryptFailCounter(fromHandle) {
  if (!fromHandle) return;
  if (_decryptFailCounters.has(fromHandle)) _decryptFailCounters.delete(fromHandle);
}

// ======================================================
// FIX C — UI: Bubble für unentschlüsselbare Nachrichten
// Klickbarer "Neuen Schlüssel anfordern"-Button → triggert cmk_req
// und lädt die Liste nach kurzer Verzögerung neu.
// ======================================================
function renderDecryptFailedBubble(m, opts = {}) {
  if (!messagesEl || !m) return null;
  const isGroup = !!opts.isGroup;
  const groupId = opts.groupId || null;
  const div = document.createElement("div");
  const isOwn = m.from?.toLowerCase() === getMyUser()?.toLowerCase();
  div.className = (isOwn ? "me" : "other") + " decrypt-failed";
  if (m.id) div.dataset.id = m.id;
  if (m.ts) div.dataset.ts = String(m.ts);

  const box = document.createElement("div");
  box.className = "msg-text";
  box.style.cssText = "display:flex;flex-direction:column;gap:6px;max-width:320px;";

  const title = document.createElement("div");
  title.style.cssText = "font-weight:600;font-size:13px;color:var(--text-primary,#fff);";
  title.textContent = isOwn
    ? (lang.decryptFailedOwn || "🔒 You can no longer decrypt this message")
    : (lang.decryptFailed || "🔒 Message could not be decrypted");

  const hint = document.createElement("div");
  hint.style.cssText = "font-size:12px;color:var(--text-secondary,#b3b3b3);line-height:1.35;";
  // Phase 5.1: Group vs. DM unterschiedliche Hint-Texte
  // - DM eigene: "Frage Schlüssel auf einer Nachricht von <withUser>"
  // - Group eigene: "Dein Gruppen-Schlüssel ging verloren..." (kein peer-Verweis sinnvoll)
  // - DM fremd: generic "Encryption key unavailable"
  // - Group fremd: "Schlüssel von <sender> fehlt..."
  if (isOwn) {
    hint.textContent = isGroup
      ? (lang.decryptFailedOwnGroupHint || "Your group key was lost. Older messages stay unreadable — new ones will work again.")
      : (lang.decryptFailedOwnHint || "The key was lost. Request a new key on a message from {peer}.").replace(/\{peer\}/g, withUser || "");
  } else {
    hint.textContent = isGroup
      ? (lang.decryptFailedGroupHint || "Key from {peer} is missing. Tap 'Request key' to fetch it.").replace(/\{peer\}/g, m.from || "")
      : (lang.decryptFailedHint || "Encryption key unavailable.");
  }

  // Eigene Nachrichten: nur Text, kein Button (Recovery läuft über Peer-Bubble)
  if (isOwn) {
    box.append(title, hint);
    div.append(box);
    const timeElOwn = document.createElement("div");
    timeElOwn.className = "timestamp";
    timeElOwn.textContent = formatTimestamp(m.ts || Date.now());
    div.append(timeElOwn);
    messagesEl.appendChild(div);
    return div;
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.style.cssText = "align-self:flex-start;margin-top:4px;padding:6px 10px;border-radius:8px;border:none;background:var(--accent-voice,#38bdf8);color:#fff;font-size:12px;font-weight:600;cursor:pointer;min-height:28px;transition:background 0.15s, opacity 0.15s;";

  // ── Persistent button state (überlebt Re-Renders) ─────────────────────
  // Wenn der User den Button bereits geklickt hat, zeigen wir das Ergebnis
  // persistent — damit Re-Render durch loadMessages die UI nicht "zurücksetzt".
  // Phase 5.1: für Gruppen ist peer = sender (m.from), state-key composite (groupId:sender),
  // damit verschiedene Sender unabhängige Button-States haben.
  const peer = isGroup ? m.from : (isOwn ? withUser : m.from);
  const stateKey = isGroup ? `decrypt_retry_state:${groupId}:${peer}` : `decrypt_retry_state:${peer}`;
  const savedRaw = (() => { try { return sessionStorage.getItem(stateKey); } catch { return null; } })();
  const savedState = savedRaw ? (() => { try { return JSON.parse(savedRaw); } catch { return null; } })() : null;
  const STATE_TTL_MS = 15 * 60_000; // 15 Min persistent state

  function applyState(state) {
    if (!state) {
      btn.textContent = lang.decryptRetryBtn || "🔄 Request new key";
      btn.disabled = false;
      btn.style.opacity = "1";
      btn.style.background = "var(--accent-voice,#38bdf8)";
      // Phase 5.1: Group/DM-spezifischen Hint behalten (nicht mit generic überschreiben)
      hint.textContent = isGroup
        ? (lang.decryptFailedGroupHint || "Key from {peer} is missing. Tap 'Request key' to fetch it.").replace(/\{peer\}/g, m.from || "")
        : (lang.decryptFailedHint || "Encryption key unavailable.");
      return;
    }
    if (state.phase === "pending") {
      btn.textContent = lang.decryptRetryPending || "⏳ Requesting…";
      btn.disabled = true;
      btn.style.opacity = "0.7";
    } else if (state.phase === "success") {
      const COOLDOWN_MS = 30_000;
      const remaining = Math.max(0, COOLDOWN_MS - (Date.now() - (state.ts || 0)));
      if (remaining > 0) {
        btn.textContent = `${lang.decryptRetrySuccess || "✅ Key requested"} (${Math.ceil(remaining / 1000)}s)`;
        btn.disabled = true;
        btn.style.opacity = "0.7";
        btn.style.background = "var(--status-speaking,#4ade80)";
        setTimeout(() => applyState(state), 1000);
      } else {
        btn.textContent = lang.decryptRetryAgain || "🔄 Request again";
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.style.background = "var(--accent-voice,#38bdf8)";
      }
      hint.textContent = lang.decryptRetrySuccessHint || "Future messages will work. Older messages encrypted with lost keys cannot be recovered.";
    } else if (state.phase === "error") {
      btn.textContent = lang.decryptRetryErrorBtn || "↻ Try again";
      btn.disabled = false;
      btn.style.opacity = "1";
      btn.style.background = "var(--status-error,#ef4444)";
      hint.textContent = lang.decryptRetryErrorHint || "Key request failed. Check connection and try again.";
    }
  }

  // Bei Re-Render: gespeicherten State wieder anwenden (falls nicht zu alt)
  if (savedState && Date.now() - (savedState.ts || 0) < STATE_TTL_MS) {
    applyState(savedState);
  } else {
    applyState(null);
  }

  // Sync zwischen mehreren Bubbles desselben Peers: CustomEvent hört auf State-Changes.
  // Phase 5.1: bei Gruppen wird `eventPeerKey` (composite groupId:sender) verwendet,
  // damit Bubbles verschiedener Sender in derselben Gruppe unabhängige States haben.
  const eventPeerKey = isGroup ? `${groupId}:${peer}` : peer;
  const onStateChange = (ev) => {
    if (ev?.detail?.peer !== eventPeerKey) return;
    if (!div.isConnected) {
      document.removeEventListener("cmk-req-state-change", onStateChange);
      return;
    }
    applyState(ev.detail.state);
  };
  document.addEventListener("cmk-req-state-change", onStateChange);

  const broadcastState = (state) => {
    document.dispatchEvent(new CustomEvent("cmk-req-state-change", { detail: { peer: eventPeerKey, state } }));
  };

  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    e2eLog("CMK_REQ", "button_click", { peer, msgId: m.id, isOwn, isGroup });
    const pending = { phase: "pending", ts: Date.now() };
    applyState(pending);
    try { sessionStorage.setItem(stateKey, JSON.stringify(pending)); } catch {}
    broadcastState(pending);

    // Pre-Check: Ist der Peer/Sender gerade online? Presence-API ist genauer als
    // Inbox-Keys (die persistent im KV bleiben — auch wenn iPhone offline).
    // Inbox-Keys-Check als Fallback (wenn Presence-API failed oder kein Status).
    let peerReachable = true;
    try {
      const presenceMap = await fetchPresence([peer]);
      const peerPresence = presenceMap?.[peer?.toLowerCase()];
      if (peerPresence && peerPresence.online === false) {
        // Definitiv offline gemäß Presence
        peerReachable = false;
      } else if (!peerPresence) {
        // Kein Presence-Status → fallback auf Inbox-Keys-Existenz
        const peerDevices = await fetchInboxKeys(peer, { forceFresh: true });
        peerReachable = Array.isArray(peerDevices) && peerDevices.length > 0;
      }
      // peerPresence.online === true → peerReachable bleibt true
    } catch {
      // Bei Fehler nicht blockieren — User soll's probieren können
      peerReachable = true;
    }

    if (!peerReachable) {
      const offlineState = { phase: "peer_offline", ts: Date.now() };
      const peerOfflineHint = (lang.decryptRetryPeerOfflineHint
        || "{peer} is currently unreachable. Ask {peer} to open the app, then try again.").replace(/\{peer\}/g, peer);
      const peerOfflineToast = (lang.decryptRetryPeerOfflineToast
        || "⚠️ {peer} unreachable").replace(/\{peer\}/g, peer);
      btn.textContent = lang.decryptRetryErrorBtn || "↻ Try again";
      btn.disabled = false;
      btn.style.opacity = "1";
      btn.style.background = "var(--status-error,#ef4444)";
      hint.textContent = peerOfflineHint;
      try { sessionStorage.setItem(stateKey, JSON.stringify(offlineState)); } catch {}
      broadcastState(offlineState);
      showSystemToast(peerOfflineToast, 4000);
      return;
    }

    // Phase 5.1: Group → request_gsk an den Sender; DM → bestehender cmk_req-Pfad.
    let ok;
    if (isGroup) {
      try {
        await requestGSKFrom(groupId, peer);
        ok = true;
      } catch (e) {
        console.warn("⚠️ requestGSKFrom failed", e);
        ok = false;
      }
    } else {
      ok = await sendCmkReqNow(peer);
    }

    const result = { phase: ok ? "success" : "error", ts: Date.now() };
    applyState(result);
    try { sessionStorage.setItem(stateKey, JSON.stringify(result)); } catch {}
    broadcastState(result);

    // Optional: kurzer Toast (falls chat-toast-container existiert)
    showSystemToast(ok
      ? (lang.decryptRetrySent || "🔁 New key requested")
      : (lang.decryptRetryFailed || "⚠️ Request failed"),
      3500
    );
    // Nach 2s loadMessages → neue Keys ggf. da
    setTimeout(() => { loadMessages?.().catch(() => {}); }, 2000);
  });

  box.append(title, hint, btn);
  div.append(box);

  const timeEl = document.createElement("div");
  timeEl.className = "timestamp";
  timeEl.textContent = formatTimestamp(m.ts || Date.now());
  div.append(timeEl);

  messagesEl.appendChild(div);
  return div;
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

  // 🔏 Signatur prüfen
  let finalText = decrypted;
  if (msg.from !== getMyUser() && msg.deviceId) {
    const sigPub = await getSigPubForDevice(msg.from, msg.deviceId);
    if (sigPub) {
      // sigPub bekannt → Signatur ist Pflicht
      if (!msg.sig) {
        console.warn("🚨 Fehlende Signatur — mögliche Manipulation!", msg.id);
        finalText = "⚠️ [Nachricht konnte nicht verifiziert werden]";
      } else {
        const sigOk = await verifyMessageSig(
          msg.ivB64, msg.ctB64,
          msg.sid || sessionId, ep,
          msg.sig, sigPub
        );
        if (!sigOk) {
          console.warn("🚨 Signatur ungültig — mögliche Manipulation!", msg.id);
          finalText = "⚠️ [Nachricht konnte nicht verifiziert werden]";
        }
      }
    }
    // kein sigPub → alte Nachricht oder Peer-Keys noch nicht gecacht → akzeptieren
  }

  // ✅ Cache setzen (vor return) — LRU-Eviction via lruCacheSet
  if (msg?.id) {
    lruCacheSet(msg.id, finalText);
  }

  e2eLog("DECRYPT", "ok", {
    id: msg.id, peer: otherHandle, from: msg.from,
    sid: sessionId, rot: msgRotationIndex, epoch: ep
  });
  console.log("🔐 MK-DECRYPT success", { id: msg.id, epoch: ep });

  return finalText;   // "" ist hier erlaubt!
}

      } catch {
        // try next epoch
      }
    }

    // ─── FIX A: SID-basierter CMK-Fallback (Guest-Conversion) ───
    // Alte Nachrichten nach Guest→Real-Conversion haben msg.sid = `dm:me:guest_xxx`
    // während der aktuelle Peer jetzt `ret31` ist. Die alte CMK liegt noch in IDB
    // unter `cmk:me:guest_xxx` — wir probieren sie direkt für diese Message.
    try {
      const sidPeer = peerFromDmSid(msg.sid, getMyUser());
      const currentPeerLc = String(otherHandle || "").toLowerCase();
      if (sidPeer && sidPeer !== currentPeerLc) {
        const oldCmk = await getCMKIfExists(sidPeer);
        if (oldCmk instanceof Uint8Array) {
          const fallbackSid = msg.sid;
          const fallbackRot = typeof msg.rotationIndex === "number" ? msg.rotationIndex : 0;
          const fallbackSk = await deriveSessionKeyBytesForRotation(oldCmk, fallbackSid, fallbackRot);
          for (const ep of epochsToTry) {
            try {
              const mkFb = await deriveMessageKey(fallbackSk, fallbackSid, ep);
              const decryptedFb = await e2eDecrypt(mkFb, msg.ivB64, msg.ctB64);
              if (typeof decryptedFb === "string") {
                e2eLog("DECRYPT", "sid_fallback_ok", {
                  id: msg.id, peer: otherHandle, sidPeer, fallbackSid, epoch: ep
                });
                console.log("🔓 Decrypt via SID-Peer-Fallback erfolgreich:", { sidPeer, epoch: ep });
                if (msg?.id) lruCacheSet(msg.id, decryptedFb);
                return decryptedFb;
              }
            } catch { /* next epoch */ }
          }
        }
      }
    } catch (fbErr) {
      console.warn("SID-Fallback Decrypt error:", fbErr);
    }
    // ─── /FIX A ────────────────────────────────────────────────

    // Diagnose: strukturiertes Log + klassischer console.warn (ersteres landet im Ring-Buffer)
    const failContext = {
      id: msg.id,
      peer: otherHandle,
      from: msg.from,
      msgRot: typeof msg.rotationIndex === "number" ? msg.rotationIndex : 0,
      sessionRot: sessionRotationIndex,
      hasCmk: !!sessionCmkBytes,
      sid: msg.sid || "(keins)",
      computedSid: dmSessionId(getMyUser(), otherHandle),
      sidMismatch: msg.sid && msg.sid !== dmSessionId(getMyUser(), otherHandle),
      msgAgeMin: msg.ts ? Math.round((Date.now() - msg.ts) / 60000) : null,
      reason: "all_epochs_failed",
    };
    e2eLog("DECRYPT", "permanent_fail", failContext, "error");
    console.warn("❌ MK decrypt failed (all epochs)", msg.id, failContext);

    return "__decrypt_failed__";  // 🔥 Sentinel: permanenter Fehler — NICHT deferred!

  } catch (e) {
    e2eLog("DECRYPT", "crash", { id: msg.id, peer: otherHandle, err: String(e) }, "error");
    console.warn("❌ decrypt crash", e);
    return null;
  }
}

// Crypto functions → chatCrypto.js
// uploadFile, uploadMyPublicKeyIfNeeded → chatCrypto.js (wrapped above)

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

      // WICHTIG: saved.id IMMER zu renderedMessageIds hinzufügen (unabhängig
      // davon ob ein pending-Bubble gefunden wird). Sonst kann der
      // nachfolgende loadMessages/Polling-Cycle eine DUPLIKAT-Bubble rendern.
      if (saved?.id) renderedMessageIds.add(saved.id);

      if (item.tempId) {
        const div = pendingByTempId.get(item.tempId);
        if (div && saved?.id) {
          div.classList.remove("pending");
          div.dataset.id = saved.id;
          div.dataset.status = "sent";
          // Timestamp mit Server-ts aktualisieren und "Sende…" entfernen
          const timeEl = div.querySelector(".timestamp");
          if (timeEl && saved.ts) {
            let meta = formatTimestamp(saved.ts);
            meta += " · " + (lang.statusSent || "Gesendet");
            timeEl.textContent = meta;
          }
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

// 🔒 Parallel-Guard — verhindert Race-Condition beim Retry-Zähler
if (isFlushingDeferredInbound) {
  console.log("⏳ flushDeferredInboundMessages läuft bereits");
  return;
}
isFlushingDeferredInbound = true;

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
  const nowFlush = Date.now();
  for (let i = 0; i < queue.length; i++) {
    const m = queue[i];
    const text = decrypted[i].status === "fulfilled" ? decrypted[i].value : "__decrypt_failed__";

    console.debug("[flush]", { from: m.from, ts: m.ts, result: text === null ? "null(deferred)" : text === "__decrypt_failed__" ? "FAILED" : text === "__control__" ? "control" : "OK:"+String(text).slice(0,20) });

    // 🧹 Stale-Cleanup: Nachrichten älter als STALE_MESSAGE_MAX_AGE_MS (1h) und noch nicht
    // entschlüsselbar → permanent als nicht-entschlüsselbar markieren (kein ewiges Retry)
    const isStale = m.ts && (nowFlush - m.ts) > STALE_MESSAGE_MAX_AGE_MS;
    if (isStale && (text === null || text === "__control__" || text === "__decrypt_failed__")) {
      console.warn("🧹 Stale deferred message permanently failed", { id: m.id, ageMs: nowFlush - m.ts, from: m.from });
      const el = document.querySelector(`[data-id="${m.id}"]`);
      if (el) {
        if (isAutoDeleted(m.ts)) {
          const sysDiv = document.createElement("div");
          sysDiv.className = "system";
          sysDiv.textContent = lang.messageExpired || "⏱ Nachricht automatisch gelöscht";
          el.replaceWith(sysDiv);
        } else {
          const textEl = el.querySelector(".msg-text") || el.querySelector("div:not(.sender-name):not(.timestamp)");
          if (textEl) textEl.textContent = decryptFailedText(m.ts);
        }
      }
      if (m?.id) {
        deferredInboundIds.delete(m.id);
        deferredInboundRetryCount.delete(m.id);
      }
      continue;
    }

    if (text === null || text === "__control__") {
      // GSK noch nicht verfügbar → GSK aktiv anfordern + Retry-Zähler erhöhen
      if (text === null && isGroupConversation(withUser) && m.from) {
        requestGSKFrom(withUser, m.from).catch(() => {});
      }
      const retries = (deferredInboundRetryCount.get(m.id) || 0) + 1;
      deferredInboundRetryCount.set(m.id, retries);
      if (retries >= MAX_INBOUND_RETRIES) {
        // Nach MAX_INBOUND_RETRIES Versuchen → permanent failed
        const el = document.querySelector(`[data-id="${m.id}"]`);
        if (el) {
          if (isAutoDeleted(m.ts)) {
            const sysDiv = document.createElement("div");
            sysDiv.className = "system";
            sysDiv.textContent = lang.messageExpired || "⏱ Nachricht automatisch gelöscht";
            el.replaceWith(sysDiv);
          } else {
            const textEl = el.querySelector("div:not(.sender-name):not(.timestamp)");
            if (textEl) textEl.textContent = decryptFailedText(m.ts);
          }
        }
        deferredInboundIds.delete(m.id);
        deferredInboundRetryCount.delete(m.id);
      } else {
        deferredInboundMessages.push(m); // nochmal versuchen
      }
      continue;
    }

    if (text === "__decrypt_failed__") {
      // Gruppen: nochmal GSK anfordern (max. 2 Versuche — OperationError = falscher Key,
      // weiteres Retry hilft nur wenn ein NEUER korrekter GSK eintrifft)
      const MAX_WRONG_KEY_RETRIES = 2;
      if (isGroupConversation(withUser) && m.from && m.from !== getMyUser()) {
        const retries = deferredInboundRetryCount.get(m.id) || 0;
        if (retries < MAX_WRONG_KEY_RETRIES) {
          deferredInboundRetryCount.set(m.id, retries + 1);
          deferredInboundMessages.push(m); // erneut in Queue
          requestGSKFrom(withUser, m.from).catch(() => {});
          continue;
        }
      }
      const el = document.querySelector(`[data-id="${m.id}"]`);
      if (el) {
        if (isAutoDeleted(m.ts)) {
          const sysDiv = document.createElement("div");
          sysDiv.className = "system";
          sysDiv.textContent = lang.messageExpired || "⏱ Nachricht automatisch gelöscht";
          el.replaceWith(sysDiv);
        } else {
          const textEl = el.querySelector("div:not(.sender-name):not(.timestamp)");
          if (textEl) textEl.textContent = decryptFailedText(m.ts);
        }
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
      // .msg-text explizit verwenden — verhindert dass reply-quote überschrieben wird
      const textEl = existingBubble.querySelector(".msg-text");
      if (textEl) {
        const linkedEdit = linkify(text);
        if (linkedEdit !== escapeHtml(text)) { textEl.innerHTML = linkedEdit; } else { textEl.textContent = text; }
      }
    } else {
      // msg: m mitgeben damit Reply-Quote-Block korrekt gerendert wird
      m.replyPlaintext = null;
      if (m.replyToId && m.replyIv && m.replyCt) {
        try {
          if (isGroupConversation(withUser)) {
            const idx = m.replyRotationIndex ?? (m.rotationIndex > 0 ? m.rotationIndex - 1 : 0);
            const plain = await decryptGroupMessage(withUser, m.from, m.replyIv, m.replyCt, idx);
            if (typeof plain === "string" && plain !== "__decrypt_failed__") m.replyPlaintext = plain;
          } else if (sessionKeyBytes) {
            const rMk = await deriveMessageKey(sessionKeyBytes, dmSessionId(getMyUser(), withUser), m.epoch ?? 0);
            const plain = await e2eDecrypt(rMk, m.replyIv, m.replyCt);
            if (typeof plain === "string" && plain !== "__decrypt_failed__") m.replyPlaintext = plain;
          }
        } catch {}
      }
      // Attachment-Erkennung: ist der decryptierte Text ein JSON-Attachment-Payload?
      let attachment = null;
      let displayText = text;
      if (m.attachmentType && text && text.startsWith("{")) {
        try {
          const parsed = JSON.parse(text);
          attachment = { type: m.attachmentType, payload: parsed };
          displayText = ""; // kein Text in Attachment-Nachrichten
        } catch {}
      }
      renderMessage({ id: m.id, from: m.from, message: displayText, ts: m.ts, status: m.status, msg: m, attachment });
    }
    savePreviewCache(previewConvoId(withUser), { text, ts: m.ts || Date.now(), from: m.from });
  }

  scrollToBottom();

  // 📖 Gruppen: mark-read nach flush aktualisieren
  // (für Nachrichten die via WebSocket ankamen, nicht via loadMessages)
  if (isGroupConversation(withUser)) {
    _markGroupReadDebounced();
  }

  isFlushingDeferredInbound = false;
}

// ======================================================
// REQUEST_GSK — Pull-Mechanismus wenn GSK eines Senders fehlt
// Sendet "request_gsk" Control-Message an den Sender (über Gruppen-Routing)
// Der Sender antwortet mit distributeGroupSK() gezielt für unsere Devices
// ======================================================
async function requestGSKFrom(groupId, senderHandle, opts = {}) {
  // Eigene GSK kann man nicht anfordern
  const _self = _isGuestMode ? _guestData?.guestHandle : getMyUser();
  if (!senderHandle || senderHandle === _self) return;

  const key = `${groupId}:${senderHandle}`;
  const isRetry = !!opts.isRetry;

  // Noch im Cooldown nach 429?
  const cooldownUntil = gskRequestCooldown.get(key);
  if (cooldownUntil && Date.now() < cooldownUntil) return;

  // Pending-Check nur für initialen Call (Retries dürfen durch — sind eigene Schedules)
  if (!isRetry && pendingGskRequests.has(key)) return;
  pendingGskRequests.add(key);

  // Phase 5.2: Cache-Invalidation für den Sender — sein iPhone hat evtl. neue
  // Inbox-Keys nach Re-Login. Nur beim initialen Call (Retries würden Spam machen).
  if (!isRetry) {
    try { await invalidatePeerCache(senderHandle); } catch {}
  }

  try {
    const result = await apiFetch("/chat/send", {
      method: "POST",
      body: JSON.stringify({
        to:            senderHandle,
        convoId:       groupId,
        type:          "request_gsk",
        requestedFrom: senderHandle  // Nur der Angefragte antwortet (Handler-Filter)
      })
    });
    // apiFetch wirft kein Error bei 429 — gibt { rateLimited: true } zurück
    if (result?.rateLimited) {
      pendingGskRequests.delete(key);
      gskRequestCooldown.set(key, Date.now() + 30_000);
      console.warn("⚠️ requestGSKFrom rate-limited — 30s Cooldown");
      return;
    }
    gskRequestCooldown.delete(key);

    // Phase 5.2: Exponential Backoff — wenn Sender offline war oder request verloren ging,
    // automatisch erneut versuchen mit wachsenden Delays. GSK_READY-Handler räumt auf.
    const RETRY_DELAYS = [3000, 8000, 20000]; // 3 weitere Versuche nach initialem
    const attempts = gskAttemptCount.get(key) || 0;
    if (attempts < RETRY_DELAYS.length) {
      const delay = RETRY_DELAYS[attempts];
      gskAttemptCount.set(key, attempts + 1);
      // Vorigen Timer killen falls vorhanden (kein Doppel-Schedule)
      const oldTimer = gskRetryTimers.get(key);
      if (oldTimer) clearTimeout(oldTimer);
      const timer = setTimeout(() => {
        gskRetryTimers.delete(key);
        // Falls inzwischen GSK angekommen ist, hat resetGskRequestState() den Counter geleert
        if ((gskAttemptCount.get(key) || 0) === 0) return;
        requestGSKFrom(groupId, senderHandle, { isRetry: true }).catch(() => {});
      }, delay);
      gskRetryTimers.set(key, timer);
      console.log(`⏳ requestGSKFrom retry #${attempts + 1} für ${senderHandle} scheduled in ${delay}ms`);
    } else {
      console.log("⏸️ requestGSKFrom max retries erreicht — wartet auf weiteren Decrypt-Fail-Trigger");
      gskAttemptCount.delete(key); // Reset → nächster Decrypt-Fail-Trigger startet wieder
    }

    // Pending-Slot nach 10s freigeben (für nächsten Decrypt-Fail-getriggerten Call)
    setTimeout(() => pendingGskRequests.delete(key), 10_000);
  } catch (e) {
    console.warn("⚠️ requestGSKFrom fehlgeschlagen:", e);
    const status = e?.status ?? e?.code;
    if (status === 403 || status === 400) return;
    pendingGskRequests.delete(key);
  }
}

// Phase 5.2: Wenn GSK ankommt, allen Retry-State für diesen Sender aufräumen.
function resetGskRequestState(groupId, senderHandle) {
  const key = `${groupId}:${senderHandle}`;
  pendingGskRequests.delete(key);
  gskRequestCooldown.delete(key);
  gskAttemptCount.delete(key);
  const timer = gskRetryTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    gskRetryTimers.delete(key);
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
  initAttachmentUI();

  if (!messagesEl || !indicatorEl || !unreadCountEl || !sendBtn || !inputEl || !titleEl) {
    console.error("DOM nicht bereit");
    return;
  }

  if (sendBtn.dataset.bound === "1") return;
sendBtn.dataset.bound = "1";

  if (_initialGroupName) {
    titleEl.textContent = _initialGroupName;
  } else if (withUser?.startsWith("guest_")) {
    titleEl.textContent = guestDisplayName(withUser);
  } else if (withUser) {
    const fallback = withUser;
    titleEl.textContent = getDisplayName(withUser, fallback);
    titleEl.dataset.profileHandle = withUser;
    titleEl.dataset.profileFallback = fallback;
    prefetchProfiles([withUser]).catch(() => {});
  }
if (firstLoad) {
  messagesEl.innerHTML = "";
}

  // =========================
  // SEND BUTTON
  // =========================
  sendBtn.addEventListener("click", async () => {
    // ── Edit-Modus: wenn eine Nachricht gerade bearbeitet wird,
    // speichert der Send-Button die Änderung statt eine neue Nachricht zu senden.
    // Intuitiver auf Mobile (Enter-Taste ist nicht immer "senden").
    const editTa = document.querySelector(".edit-textarea");
    if (editTa) {
      const editDiv = editTa.closest(".me, .other");
      const editMsgId = editDiv?.dataset.id;
      const editTextEl = editDiv?.querySelector(".msg-text");
      if (editMsgId && editDiv && editTextEl) {
        const newEditText = editTa.value.trim();
        const originalEditText = editTextEl.textContent || "";
        if (newEditText && newEditText !== originalEditText) {
          await editMessage(editMsgId, newEditText, editDiv, editTextEl, editTa);
        } else {
          cancelInlineEdit(editDiv, editTextEl, editTa);
        }
      }
      return; // niemals normale Send-Logik ausführen während Edit offen ist
    }

    const text = inputEl.textContent.trim();

    if (!text) return;

    // 🔒 GAST PRE-FLIGHT: Wenn Limit oder Zeit lokal schon erreicht → sofort sperren,
    // keinen unnötigen Request mehr auslösen.
    if (_guestData) {
      if (_guestLocked) return;
      const left = (_guestData.msgLimit || 20) - (_guestData.msgCount || 0);
      if (left <= 0) { lockGuestSession("limit"); return; }
      if (_guestData.expiresAt && Date.now() > _guestData.expiresAt) {
        lockGuestSession("expired");
        return;
      }
    }

    // Gäste nutzen jetzt den normalen E2E-Gruppen-Pfad (kein separater Guest-Send mehr)

// ==========================================
// E2E NOT READY → DEFERRED SEND
// Phase 4 #4: DM-Recovery aktiv → puffern (CMK ändert sich gerade).
// Phase 5.5: Group-Rotation aktiv → puffern (eigener GSK ändert sich + verteilt).
// ==========================================
if (!e2eReady
    || (!isGroupConversation(withUser) && isInRecovery(withUser))
    || (isGroupConversation(withUser) && isGroupRotating(withUser))) {

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

  inputEl.textContent = "";
  scrollToBottom();
  updateSendButton();

  if (!e2eReady) console.log("🟡 Nachricht deferred – E2E noch nicht bereit");
  else if (isGroupConversation(withUser) && isGroupRotating(withUser)) console.log("🟡 Nachricht deferred – Group-Rotation läuft, wird mit neuem GSK gesendet");
  else console.log("🟡 Nachricht deferred – Recovery läuft, wird mit frischem CMK gesendet");

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
    
    // Optimistic UI — Reply-State mitgeben damit Quote-Block sofort erscheint
    const tempId = `tmp-${now}-${Math.random().toString(16).slice(2)}`;
    const pendingDiv = renderMessage({
      from:          getMyUser(),
      message:       text,
      tempId,
      ts:            now,
      status:        "pending",
      replyToId:     getReplyState()?.id       || null,
      replyFrom:     getReplyState()?.from     || null,
      replyPlaintext: getReplyState()?.plaintext || null
    });
    if (pendingDiv) pendingByTempId.set(tempId, pendingDiv);

    // _replyState sichern VOR clearReplyBar (sonst ist es null beim Encrypt)
    const _savedReplyState = getReplyState() ? { ...getReplyState() } : null;

    inputEl.textContent = "";
    clearReplyBar();
    scrollToBottom();

    // 🔐 SAFETY: merkt, ob der Send-Vorgang sauber beendet wurde

try {

// ======================================================
// SEND PATH — Gruppe: Sender Keys / DM: CMK v2
// ======================================================
let res;

if (isGroupConversation(withUser)) {

  // ── GRUPPE ─────────────────────────────────────────
  // Reply ZUERST verschlüsseln → chainIndex N
  // Hauptnachricht danach → chainIndex N+1
  // So stimmt der rotationIndex beim Empfänger
  let replyFields = {};
  if (_savedReplyState) {
    const replyEncrypted = await encryptGroupMessage(withUser, getMyUser(), _savedReplyState.plaintext.slice(0, 100));
    replyFields = { replyFrom: _savedReplyState.from || getMyUser(), replyIv: replyEncrypted.ivB64, replyCt: replyEncrypted.ctB64, replyRotationIndex: replyEncrypted.chainIndex };
    if (_savedReplyState.id) replyFields.replyToId = _savedReplyState.id;
  }

  const encrypted = await encryptGroupMessage(withUser, getMyUser(), text);

  // @mention Extraction — Metadata (unverschlüsselt) für Push-Notifications
  const mentionMatches = text.match(/@([a-z0-9_]+)/gi) || [];
  const mentions = mentionMatches.map(m => m.slice(1).toLowerCase()).filter(h => h !== getMyUser());
  const mentionsEveryone = /@everyone\b/i.test(text);

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
      mentions:     mentions.length > 0 ? mentions : undefined,
      mentionsEveryone: mentionsEveryone || undefined,
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
  if (_savedReplyState) {
    const { ivB64: rIv, ctB64: rCt } = await e2eEncrypt(mk, _savedReplyState.plaintext.slice(0, 100));
    replyFieldsDM = { replyFrom: _savedReplyState.from, replyIv: rIv, replyCt: rCt };
    // replyToId nur mitsenden wenn vorhanden (null = cross-chat reply ohne echte Message-ID)
    if (_savedReplyState.id) replyFieldsDM.replyToId = _savedReplyState.id;
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

// 🔴 GAST: Nachrichtenlimit erreicht — permanent, KEIN Retry, KEIN pending
if (res?.guestLimitReached) {
  const div = pendingByTempId.get(tempId);
  if (div) { div.remove(); pendingByTempId.delete(tempId); }
  if (_guestData && res.msgLimit) {
    _guestData.msgCount = res.msgLimit;
    _guestData.msgLimit = res.msgLimit;
  }
  lockGuestSession("limit");
  return;
}

// 🔴 GAST: Session abgelaufen — permanent, KEIN Retry
if (res?.guestExpired) {
  const div = pendingByTempId.get(tempId);
  if (div) { div.remove(); pendingByTempId.delete(tempId); }
  lockGuestSession("expired");
  return;
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

// Gast-Nachrichtenzähler im Banner aktualisieren + persistieren (Reload-safe)
if (_guestData) {
  _guestData.msgCount = (_guestData.msgCount || 0) + 1;
  persistGuestData();
  updateGuestBannerCount();
}

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

  // Context Menu nachträglich aktivieren (war während "pending" blockiert)
  if (!div._ctxAttached) {
    div._ctxAttached = true;
    const textEl = div.querySelector(".msg-text");
    attachContextMenu(div, { id: saved.id, from: getMyUser(), textEl, ts: saved.ts });
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
  const len = inputEl.textContent.length;

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

// Auto-Delete sweep → chatAutoDelete.js
function isUserAtBottom() {
  if (!messagesEl) return true; // ⬅️ WICHTIG
  const threshold = 80;
  const distance =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  return distance <= threshold;
}

// Auto-Delete UI → chatAutoDelete.js

// ======================================================
// 📎 ATTACHMENT UI: Foto, Datei, GIF
// ======================================================
function initAttachmentUI() {
  const photoInput    = document.getElementById("photo-input");
  const fileInput     = document.getElementById("file-input");
  const photoBtn      = document.getElementById("attach-photo-btn");
  const fileBtn       = document.getElementById("attach-file-btn");
  const gifBtn        = document.getElementById("attach-gif-btn");

  if (!photoInput || !fileInput || !photoBtn || !fileBtn || !gifBtn) return;

  // Guard: nur einmal registrieren
  if (photoBtn.dataset.bound === "1") return;
  photoBtn.dataset.bound = "1";

  photoBtn.addEventListener("click", () => photoInput.click());
  fileBtn.addEventListener("click",  () => fileInput.click());
  gifBtn.addEventListener("click",   () => openGifModal());

  photoInput.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) handleFileSelected(f, "photo");
    photoInput.value = "";
  });
  fileInput.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) handleFileSelected(f, "file");
    fileInput.value = "";
  });

  // ── Drag & Drop ─────────────────────────────────────────
  initDragDropUpload();
}

// ======================================================
// 🖱️ DRAG & DROP — Foto/PDF/Datei direkt in Chat ziehen
// ======================================================
const PHOTO_MIME_RE = /^image\/(jpeg|png|webp|heic|heif)$/i;
const ALLOWED_FILE_EXT_RE = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|ics|gif|txt)$/i;

function classifyDroppedFile(file) {
  if (!file) return null;
  if (PHOTO_MIME_RE.test(file.type)) return "photo";
  if (ALLOWED_FILE_EXT_RE.test(file.name || "")) return "file";
  // HEIC/HEIF kommen in manchen Browsern ohne MIME-Type an → per Extension erkennen
  if (/\.(heic|heif|jpg|jpeg|png|webp)$/i.test(file.name || "")) return "photo";
  return null; // nicht unterstützt
}

function initDragDropUpload() {
  const wrapper = document.getElementById("chat-wrapper");
  if (!wrapper || wrapper.dataset.dropBound === "1") return;
  wrapper.dataset.dropBound = "1";

  // Overlay lazy erzeugen
  let overlay = null;
  function getOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "chat-dropzone-overlay";
    overlay.style.cssText = [
      "position:absolute","inset:0","z-index:400","pointer-events:none",
      "display:none","align-items:center","justify-content:center",
      "background:rgba(56,189,248,0.12)","border:3px dashed var(--accent-voice,#38bdf8)",
      "border-radius:14px","backdrop-filter:blur(2px)",
      "-webkit-backdrop-filter:blur(2px)","transition:opacity .12s ease"
    ].join(";");
    const box = document.createElement("div");
    box.style.cssText = "padding:18px 26px;border-radius:12px;background:rgba(10,12,16,0.85);color:#fff;font-size:14px;font-weight:600;display:flex;align-items:center;gap:10px;box-shadow:0 8px 24px rgba(0,0,0,0.4);";
    box.textContent = "📎 " + (lang.dropToSend || "Drop file to send");
    overlay.appendChild(box);

    const cs = getComputedStyle(wrapper);
    if (cs.position === "static") wrapper.style.position = "relative";
    wrapper.appendChild(overlay);
    return overlay;
  }

  let dragDepth = 0; // Counter gegen Flicker bei dragenter auf Kind-Elementen

  function hasFilesPayload(e) {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === "Files") return true;
    }
    return false;
  }

  wrapper.addEventListener("dragenter", (e) => {
    if (!hasFilesPayload(e)) return;
    // Gast gesperrt? → Nicht reagieren (kein Hoffnungs-Overlay)
    if (_guestData && (_guestLocked || !canSend())) return;
    e.preventDefault();
    dragDepth++;
    const ov = getOverlay();
    ov.style.display = "flex";
  });

  wrapper.addEventListener("dragover", (e) => {
    if (!hasFilesPayload(e)) return;
    if (_guestData && (_guestLocked || !canSend())) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });

  wrapper.addEventListener("dragleave", (e) => {
    if (!hasFilesPayload(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && overlay) overlay.style.display = "none";
  });

  wrapper.addEventListener("drop", async (e) => {
    if (!hasFilesPayload(e)) return;
    e.preventDefault();
    dragDepth = 0;
    if (overlay) overlay.style.display = "none";

    // Guard: Gast gesperrt oder Limit erreicht
    if (_guestData && (_guestLocked || !canSend())) {
      if (typeof lockGuestSession === "function" && _guestData) {
        const left = (_guestData.msgLimit || 20) - (_guestData.msgCount || 0);
        if (left <= 0) lockGuestSession("limit");
        else if (_guestData.expiresAt && Date.now() > _guestData.expiresAt) lockGuestSession("expired");
      }
      return;
    }

    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;

    // Sequentiell verarbeiten — gleicher Flow wie File-Picker.
    // handleFileSelected enthält bereits Size-Check, Pending-Bubble, Upload, Send.
    // WICHTIG: Backend hat 2s Hard-Rate-Limit pro Send → zwischen Files warten,
    // sonst blockiert das zweite Attachment mit 429.
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const type = classifyDroppedFile(file);
      if (!type) {
        showSystemToast(lang.dropUnsupported || `⚠️ ${file.name}: Dateityp nicht unterstützt`, 5000);
        continue;
      }
      // Server-Cooldown respektieren (SEND_COOLDOWN_MS = 2000)
      if (i > 0) {
        const wait = Math.max(0, SEND_COOLDOWN_MS - (Date.now() - lastSendTime));
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
      }
      try {
        lastSendTime = Date.now();
        await handleFileSelected(file, type);
      } catch (err) {
        console.error("[drop] upload failed:", err);
      }
    }
  });
}

async function handleFileSelected(file, attachmentType) {
  if (!file) return;
  const MAX_SIZE = 10 * 1024 * 1024;
  if (file.size > MAX_SIZE) {
    showSystemToast("⚠️ Datei zu gross (max. 10 MB)");
    return;
  }

  // Optimistic: Pending-Bubble zeigen
  const tempId = `tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const pendingDiv = renderMessage({
    from: getMyUser(),
    message: "",
    tempId,
    ts: Date.now(),
    status: "pending",
    attachment: { type: attachmentType, payload: null }
  });
  if (pendingDiv) pendingByTempId.set(tempId, pendingDiv);
  scrollToBottom();

  try {
    // Upload + Verschlüsselung
    const result = await uploadFile(file, attachmentType);
    if (!result) {
      pendingDiv?.remove();
      pendingByTempId.delete(tempId);
      return;
    }

    const { attachmentPayloadJson, r2Key } = result;
    await sendAttachmentMessage(attachmentPayloadJson, r2Key, attachmentType, tempId, pendingDiv);
  } catch (err) {
    console.error("[upload] Unhandled error in handleFileSelected:", err);
    showSystemToast(`⚠️ Fehler: ${err.message}`);
    pendingDiv?.remove();
    pendingByTempId.delete(tempId);
  }
}

async function sendAttachmentMessage(attachmentPayloadJson, r2Key, attachmentType, tempId, pendingDiv) {
  const now = Date.now();
  try {
    let res;
    if (isGroupConversation(withUser)) {
      // Gruppen: GSK verschlüsseln
      const encrypted = await encryptGroupMessage(withUser, getMyUser(), attachmentPayloadJson);
      res = await apiFetch("/chat/send", {
        method: "POST",
        body: JSON.stringify({
          to: getMyUser(), // wird von Gruppe ignoriert, braucht aber einen Wert
          convoId: withUser,
          message: "",
          e2e: true,
          v: 2,
          sid: withUser,
          epoch: 0,
          rotationIndex: encrypted.chainIndex,
          ivB64: encrypted.ivB64,
          ctB64: encrypted.ctB64,
          attachmentKey: r2Key,
          attachmentType,
        })
      });
    } else {
      // DM: Session Key
      const sessionId = dmSessionId(getMyUser(), withUser);
      const epoch = Math.floor(now / EPOCH_MS);
      const mk = await deriveMessageKey(sessionKeyBytes, sessionId, epoch);
      const { ivB64, ctB64 } = await e2eEncrypt(mk, attachmentPayloadJson);
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
          attachmentKey: r2Key,
          attachmentType,
        })
      });
    }

    // ── FEHLER-FLAGS zuerst behandeln (kein Throw → würde sonst stumm hängen) ──
    if (res?.guestLimitReached) {
      pendingDiv?.remove();
      pendingByTempId.delete(tempId);
      if (_guestData && res.msgLimit) {
        _guestData.msgCount = res.msgLimit;
        _guestData.msgLimit = res.msgLimit;
        if (typeof persistGuestData === "function") persistGuestData();
      }
      lockGuestSession("limit");
      return;
    }
    if (res?.guestExpired) {
      pendingDiv?.remove();
      pendingByTempId.delete(tempId);
      lockGuestSession("expired");
      return;
    }
    if (res?.rateLimited) {
      // Server-Cooldown (2s) → Bubble als failed markieren statt ewig pending
      if (pendingDiv) {
        pendingDiv.classList.remove("pending");
        pendingDiv.classList.add("failed");
      }
      pendingByTempId.delete(tempId);
      showSystemToast("⏸️ " + (lang.sendCooldown || "Zu schnell gesendet — bitte erneut versuchen"), 4000);
      return;
    }

    // Pending-Bubble updaten mit echter ID + Attachment-Payload
    if (pendingDiv && res?.message?.id) {
      pendingDiv.dataset.id = res.message.id;
      delete pendingDiv.dataset.tempId;
      pendingDiv.classList.remove("pending");
      pendingByTempId.delete(tempId);
      renderedMessageIds.add(res.message.id);

      // Attachment-Payload parsen und Bubble updaten
      try {
        const payload = JSON.parse(attachmentPayloadJson);
        const attEl = pendingDiv.querySelector(".attachment-bubble");
        if (attEl) {
          // Bubble neu rendern mit echtem Payload
          const newDiv = renderMessage({
            id: res.message.id,
            from: getMyUser(),
            message: "",
            ts: now,
            status: "sent",
            attachment: { type: attachmentType, payload }
          });
          if (newDiv) { pendingDiv.replaceWith(newDiv); }
        }
      } catch {}

      // Preview-Cache mit lesbarem Text aktualisieren
      const attachPreview = attachmentType === "photo" ? "📷 Foto"
        : attachmentType === "gif" ? "GIF"
        : attachmentType === "file" ? `📎 ${(() => { try { return JSON.parse(attachmentPayloadJson)?.fileName || "Datei"; } catch { return "Datei"; } })()}`
        : "";
      if (attachPreview) {
        savePreviewCache(previewConvoId(withUser), { text: attachPreview, ts: now, from: getMyUser() });
      }
    } else {
      // Server lieferte weder message.id noch bekanntes Fehler-Flag → Bubble nicht hängen lassen
      if (pendingDiv) {
        pendingDiv.classList.remove("pending");
        pendingDiv.classList.add("failed");
      }
      pendingByTempId.delete(tempId);
      showSystemToast("⚠️ Senden fehlgeschlagen");
    }
  } catch (e) {
    console.warn("Attachment send fehlgeschlagen:", e);
    showSystemToast("⚠️ Senden fehlgeschlagen");
    pendingDiv?.remove();
    pendingByTempId.delete(tempId);
  }
}

// ── GIF-Modal ──────────────────────────────────────────
let _gifSearchTimer = null;
let _gifSearchToken = 0;

function openGifModal() {
  const modal = document.getElementById("gif-modal");
  const input = document.getElementById("gif-search-input");
  const closeBtn = document.getElementById("gif-modal-close");
  if (!modal) return;
  modal.style.display = "block";
  input?.focus();

  // Close-Button
  closeBtn?.addEventListener("click", () => { modal.style.display = "none"; }, { once: true });
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.style.display = "none";
  }, { once: true });

  // Debounced Suche — Listener nur einmal anhängen
  if (input && !input.dataset.gifListenerAttached) {
    input.addEventListener("input", () => {
      clearTimeout(_gifSearchTimer);
      _gifSearchTimer = setTimeout(() => searchGifs(input.value.trim()), 400);
    });
    input.dataset.gifListenerAttached = "1";
  }

  // Trending GIFs beim Öffnen laden
  searchGifs("");
}

async function searchGifs(q) {
  const resultsEl = document.getElementById("gif-results");
  const loadingEl = document.getElementById("gif-loading");
  if (!resultsEl) return;

  const myToken = ++_gifSearchToken;
  if (loadingEl) { loadingEl.style.display = "block"; loadingEl.textContent = ""; }
  resultsEl.style.opacity = "0.5";
  resultsEl.style.transition = "opacity 120ms";

  try {
    const url = q ? `/gif/search?q=${encodeURIComponent(q)}` : `/gif/search`;
    const data = await apiFetch(url);
    if (myToken !== _gifSearchToken) return; // veraltet — neuere Suche läuft
    if (loadingEl) loadingEl.style.display = "none";
    resultsEl.innerHTML = "";
    resultsEl.style.opacity = "1";
    for (const gif of (data.results || [])) {
      if (!gif.preview && !gif.url) continue;
      const img = document.createElement("img");
      img.src = gif.preview || gif.url;
      img.loading = "lazy";
      img.style.cssText = "width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;cursor:pointer;";
      img.addEventListener("click", () => sendGif(gif.url));
      resultsEl.appendChild(img);
    }
  } catch {
    if (myToken !== _gifSearchToken) return;
    resultsEl.style.opacity = "1";
    if (loadingEl) { loadingEl.style.display = "block"; loadingEl.textContent = "⚠️ Suche fehlgeschlagen"; }
  }
}

async function sendGif(gifUrl) {
  const modal = document.getElementById("gif-modal");
  if (modal) modal.style.display = "none";

  const now = Date.now();
  const tempId = `tmp-${now}-${Math.random().toString(16).slice(2)}`;
  const gifPayloadJson = JSON.stringify({ gifUrl });

  // Optimistic Bubble
  const pendingDiv = renderMessage({
    from: getMyUser(),
    message: "",
    tempId,
    ts: now,
    status: "pending",
    attachment: { type: "gif", payload: { gifUrl } }
  });
  if (pendingDiv) pendingByTempId.set(tempId, pendingDiv);
  scrollToBottom();

  // Senden (GIF hat keinen R2-Key — URL geht in E2E-Ciphertext)
  await sendAttachmentMessage(gifPayloadJson, null, "gif", tempId, pendingDiv);
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

      // Presence für alle Mitglieder laden
      const presence = await fetchPresence(_memberHandles);

      // Rename-Handler wird in initAutoDeleteUI() gesetzt (dort ist menuDropdown im Scope)

      memberList.innerHTML = "";
      for (const m of members) {
        const li = document.createElement("li");
        li.style.cssText = "font-size:13px;padding:4px 0;display:flex;align-items:center;gap:6px;justify-content:space-between;";

        const isMe = m.member_handle === myHandle;
        const isAdmin = m.role === "admin";
        const pStatus = presence?.[m.member_handle.toLowerCase()];

        const nameSpan = document.createElement("span");
        nameSpan.style.cssText = "display:flex;align-items:center;gap:6px;";

        // Presence-Dot
        const dot = document.createElement("span");
        dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${pStatus?.online ? "#4ade80" : "var(--border-subtle)"};`;
        nameSpan.appendChild(dot);

        const nameText = document.createElement("span");
        const isGuest = (m.member_handle || "").startsWith("guest_");
        const baseName = guestDisplayName(m.member_handle);
        const shownName = isGuest ? baseName : getDisplayName(m.member_handle, baseName);
        nameText.textContent = `${shownName}${isMe ? " (Du)" : ""}`;
        if (!isGuest && !isMe) {
          nameText.dataset.profileHandle = m.member_handle;
          nameText.dataset.profileFallback = baseName;
        }
        nameSpan.appendChild(nameText);

        if (isAdmin) {
          const pill = document.createElement("span");
          pill.textContent = "Admin";
          pill.style.cssText = "font-size:10px;font-weight:600;padding:1px 6px;border-radius:20px;background:color-mix(in srgb,var(--accent-voice) 18%,transparent);color:var(--accent-voice);letter-spacing:0.03em;flex-shrink:0;";
          nameSpan.appendChild(pill);
        }

        li.appendChild(nameSpan);

        if (!isMe && !_isGuestMode) {
          const isGuest = m.member_handle.startsWith("guest_");
          const isContact = myContacts.includes(m.member_handle);
          const addBtn = document.createElement("button");
          addBtn.style.cssText = "font-size:11px;padding:2px 7px;border-radius:5px;border:1px solid var(--border-subtle);background:var(--bg-panel-alt);color:var(--text-muted);cursor:pointer;white-space:nowrap;flex-shrink:0;transition:opacity 0.15s;";

          if (isGuest) {
            // Gäste können nicht als Kontakt hinzugefügt werden → kein Button
          } else if (isContact) {
            addBtn.textContent = lang.contactAdded;
            addBtn.disabled = true;
            addBtn.style.opacity = "0.45";
            li.appendChild(addBtn);
          } else {
            addBtn.textContent = lang.requestContact;
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
                  addBtn.textContent = lang.contactAdded;
                  invalidateContactsCache(); // Cache invalidieren
                } else if (r.status === "already_pending") {
                  addBtn.textContent = lang.requestPending;
                } else {
                  addBtn.textContent = lang.requestSentConfirm;
                }
                addBtn.style.opacity = "0.5";
              } catch {
                addBtn.textContent = lang.errorLabel;
                setTimeout(() => {
                  addBtn.textContent = lang.requestContact;
                  addBtn.disabled = false;
                  addBtn.style.opacity = "1";
                }, 2000);
              }
            });
            li.appendChild(addBtn);
          }
        }

        // ── Kick-Button (nur Admin, nicht eigenes Handle, nicht im Gast-Modus) ──
        if (amAdmin && !isMe && !_isGuestMode) {
          const kickBtn = document.createElement("button");
          kickBtn.textContent = "×";
          kickBtn.title = lang.confirmRemoveMember(m.member_handle);
          kickBtn.style.cssText = "font-size:14px;font-weight:700;line-height:1;padding:2px 7px;border-radius:5px;border:1px solid var(--border-subtle);background:transparent;color:var(--status-error,#F87171);cursor:pointer;flex-shrink:0;margin-left:4px;transition:opacity 0.15s;";
          kickBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (!confirm(lang.confirmRemoveMember(guestDisplayName(m.member_handle)))) return;
            kickBtn.disabled = true;
            try {
              const r = await apiFetch("/groups/remove", {
                method: "POST",
                body: JSON.stringify({ groupId, handle: m.member_handle })
              });
              if (!r.ok) throw new Error(r.error || "failed");

              // GSK rotieren: neuen Key generieren + an alle verbleibenden Devices verteilen
              const updatedRes = await apiFetch(`/groups/members?groupId=${encodeURIComponent(groupId)}`);
              const remaining = (updatedRes.members || []).filter(x => x.member_handle !== m.member_handle);
              const allDevices = (await Promise.all(
                remaining.map(async rm => {
                  try {
                    const d = await apiFetch(`/e2e/inbox/get?user=${encodeURIComponent(rm.member_handle)}`);
                    return (d.devices || []).map(dev => ({ ...dev, memberHandle: rm.member_handle }));
                  } catch { return []; }
                })
              )).flat();
              if (allDevices.length) {
                // Phase 5.5: Send-Lock während Rotation — Sends während dieser Zeit
                // werden in deferredQueue gepuffert + nach Lock-Release mit neuem GSK gesendet.
                await withGroupRotationLock(groupId, async () => {
                  await rotateGroupSK(groupId, getMyUser(), allDevices, apiFetch);
                });
                console.log("🔑 GSK rotiert nach Kick von", m.member_handle);
              }

              await refreshMembers();
            } catch (err) {
              alert(lang.removeMemberFailed + (err.message || err));
              kickBtn.disabled = false;
            }
          });
          li.appendChild(kickBtn);
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
      } else if (msg.includes("Group full") || msg.includes("full")) {
        alert(lang.groupFull);
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
// formatTimestamp → shared/timeFormat.js

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

async function showSenderPopover(handle, anchorEl, plaintext = "") {
  closeSenderPopover();

  const popover = document.createElement("div");
  popover.style.cssText = "position:fixed;background:var(--bg-panel);border:1px solid var(--border-panel);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.4);padding:12px 14px;z-index:500;min-width:180px;";

  // Header: Avatar + Name — XSS-safe DOM-Konstruktion
  const popoverHeader = document.createElement("div");
  popoverHeader.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:10px;";
  const avatarDiv = document.createElement("div");
  avatarDiv.style.cssText = "width:34px;height:34px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;flex-shrink:0;";
  const _displayHandle = guestDisplayName(handle);
  avatarDiv.textContent = _displayHandle[0].toUpperCase();
  const nameSpanPop = document.createElement("span");
  nameSpanPop.style.cssText = "font-size:14px;font-weight:600;color:var(--text-primary);";
  nameSpanPop.textContent = _displayHandle;
  const presenceSpanPop = document.createElement("span");
  presenceSpanPop.style.cssText = "font-size:11px;color:var(--text-secondary);margin-top:1px;";
  presenceSpanPop.textContent = "…";
  const nameColPop = document.createElement("div");
  nameColPop.style.cssText = "display:flex;flex-direction:column;gap:1px;";
  nameColPop.append(nameSpanPop, presenceSpanPop);
  popoverHeader.append(avatarDiv, nameColPop);
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

  // Presence + Kontaktstatus parallel laden
  const actionEl = popover.querySelector("#sender-popover-action");
  try {
    // Gäste: nur Presence laden, keine Kontakt-Aktionen
    const presence = await fetchPresence([handle]);
    const pStatus = presence?.[handle.toLowerCase()];
    if (presenceSpanPop) {
      presenceSpanPop.textContent = pStatus ? presenceLabel(pStatus) : "";
      presenceSpanPop.style.color = pStatus?.online ? "#4ade80" : "var(--text-secondary)";
    }

    if (_isGuestMode) {
      // Gast-Modus: Hinweis statt Action-Buttons
      const hint = document.createElement("div");
      hint.style.cssText = "font-size:12px;color:var(--text-secondary);padding:6px 0;text-align:center;";
      hint.textContent = lang.registerToAddContacts;
      actionEl.replaceWith(hint);
    } else if ((await fetchAcceptedContacts()).includes(handle)) {
      // → DM öffnen (mit optionalem Reply-Kontext aus Gruppen-Nachricht)
      const btn = document.createElement("a");
      let dmUrl = `/chat?with=${encodeURIComponent(handle)}`;
      if (plaintext) {
        dmUrl += `&replyFrom=${encodeURIComponent(handle)}&replyText=${encodeURIComponent(plaintext.slice(0, 200))}`;
      }
      btn.href = dmUrl;
      btn.style.cssText = "display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:7px;background:var(--accent);color:#fff;font-size:13px;font-weight:600;text-decoration:none;cursor:pointer;";
      btn.textContent = `💬 Persönliche Nachricht an ${handle}`;
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

// linkify, escapeHtml → chatCrypto.js

// ======================================================
function renderMessage({ id, from, message, ts, tempId = null, status = "sent", msg = null,
                         replyToId = null, replyFrom = null, replyPlaintext = null,
                         attachment = null }) {
  // Reply-Felder: direkte Params (optimistic) oder aus msg (server-seitig)
  replyToId    = replyToId    || msg?.replyToId    || null;
  replyFrom    = replyFrom    || msg?.replyFrom    || null;
  replyPlaintext = replyPlaintext || msg?.replyPlaintext || null;

  // Attachment aus msg (server-seitig)
  if (!attachment && msg?.attachmentType) attachment = { type: msg.attachmentType, payload: null };

  if (!messagesEl) return null;

  // 🛡️ HARD GUARD: Pending darf nur lokal sein
if (status === "pending" && from !== getMyUser()) {
  status = "sent";
}

  // Attachment-Nachrichten dürfen leeres message haben
  if (!attachment && (!message || message.length > MAX_MESSAGE_LENGTH)) return null;

const div = document.createElement("div");
// Gruppe: "me" wenn ich der Sender bin; DM: "me" wenn from !== withUser
const isOwnMessage = from?.toLowerCase() === getMyUser()?.toLowerCase();
div.className = isOwnMessage ? "me" : "other";

// Gruppe + fremde Nachricht: Absender-Name anzeigen (Discord-Style)
if (!isOwnMessage && isGroupConversation(withUser) && from) {
  const senderEl = document.createElement("div");
  senderEl.className = "sender-name";
  const senderBase = guestDisplayName(from);
  senderEl.textContent = from.startsWith("guest_") ? senderBase : getDisplayName(from, senderBase);
  if (!from.startsWith("guest_")) {
    senderEl.dataset.profileHandle = from;
    senderEl.dataset.profileFallback = senderBase;
  }
  senderEl.style.cursor = "pointer";
  senderEl.addEventListener("click", (e) => {
    e.stopPropagation();
    const msgText = div.querySelector(".msg-text")?.textContent || "";
    showSenderPopover(from, senderEl, msgText);
  });
  div.appendChild(senderEl);
}

// Sender-Popover nur via Sender-Name-Klick (nicht ganze Bubble)

const textEl = document.createElement("div");
textEl.className = "msg-text";
if (attachment) {
  textEl.textContent = "";
} else {
  const linked = linkify(message || "");
  if (linked !== escapeHtml(message || "")) {
    textEl.innerHTML = linked;
  } else {
    textEl.textContent = message || "";
  }
}

div.appendChild(textEl);

// ── Attachment-Bubble ────────────────────────────
if (attachment) {
  const attEl = document.createElement("div");
  attEl.className = "attachment-bubble";

  if (attachment.type === "gif" && attachment.payload?.gifUrl) {
    // GIF: direkt anzeigen
    const gifWrap = document.createElement("div");
    gifWrap.style.cssText = "display:inline-block;position:relative;";
    const img = document.createElement("img");
    img.src = attachment.payload.gifUrl;
    img.style.cssText = "max-width:220px;max-height:180px;border-radius:8px;display:block;";
    img.alt = "GIF via GIPHY";
    gifWrap.appendChild(img);
    // GIPHY Attribution (Pflicht für Production-API-Key)
    const attr = document.createElement("a");
    attr.href = "https://giphy.com";
    attr.target = "_blank";
    attr.rel = "noopener noreferrer";
    attr.textContent = "via GIPHY";
    attr.style.cssText = "display:block;font-size:10px;line-height:1;color:var(--text-secondary,#8E8E93);text-decoration:none;margin-top:4px;letter-spacing:0.03em;opacity:0.75;user-select:none;";
    gifWrap.appendChild(attr);
    attEl.appendChild(gifWrap);

  } else if (attachment.type === "photo" && attachment.payload) {
    // Foto: Platzhalter mit Lade-Button
    const loadBtn = document.createElement("button");
    loadBtn.style.cssText = "background:var(--bg-panel-alt);border:1px solid var(--border-subtle);border-radius:8px;padding:12px 16px;cursor:pointer;font-size:13px;color:var(--text-primary);display:flex;align-items:center;gap:8px;";
    loadBtn.innerHTML = `<span style="font-size:20px;">🖼️</span> Foto laden`;
    loadBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      loadBtn.disabled = true; loadBtn.textContent = "Lädt…";
      try {
        const plain = await downloadAndDecryptFile(attachment.payload.r2Key, attachment.payload.fileKeyB64, attachment.payload.fileIvB64);
        const blob = new Blob([plain], { type: attachment.payload.mimeType || "image/jpeg" });
        const url = URL.createObjectURL(blob);
        const img = document.createElement("img");
        img.src = url; img.style.cssText = "max-width:220px;max-height:220px;border-radius:8px;display:block;cursor:zoom-in;";
        img.addEventListener("click", (e) => { e.stopPropagation(); window.open(url, "_blank"); });
        attEl.replaceChildren(img);
      } catch { loadBtn.textContent = "⚠️ Fehler beim Laden"; loadBtn.disabled = false; }
    });
    attEl.appendChild(loadBtn);

  } else if (attachment.type === "file" && attachment.payload) {
    // Datei: Download-Button mit Name + Grösse
    const sizeKb = attachment.payload.fileSize ? Math.ceil(attachment.payload.fileSize / 1024) : "?";
    const dlBtn = document.createElement("button");
    dlBtn.style.cssText = "background:var(--bg-panel-alt);border:1px solid var(--border-subtle);border-radius:8px;padding:10px 14px;cursor:pointer;font-size:13px;color:var(--text-primary);display:flex;align-items:center;gap:8px;max-width:220px;text-align:left;";
    dlBtn.innerHTML = `<span style="font-size:18px;">📎</span><div><div style="font-weight:600;word-break:break-all;">${attachment.payload.fileName || lang.fileLabel}</div><div style="font-size:11px;color:var(--text-secondary);">${sizeKb} KB</div></div>`;
    dlBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      dlBtn.disabled = true; dlBtn.style.opacity = "0.6";
      try {
        const plain = await downloadAndDecryptFile(attachment.payload.r2Key, attachment.payload.fileKeyB64, attachment.payload.fileIvB64);
        const blob = new Blob([plain], { type: attachment.payload.mimeType || "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = attachment.payload.fileName || "datei";
        a.click(); URL.revokeObjectURL(url);
      } catch { dlBtn.textContent = "⚠️ Download fehlgeschlagen"; }
      dlBtn.disabled = false; dlBtn.style.opacity = "1";
    });
    attEl.appendChild(dlBtn);

  } else {
    // Pending / noch kein Payload: Upload-Indikator
    const pending = document.createElement("div");
    pending.style.cssText = "padding:10px 14px;font-size:13px;color:var(--text-secondary);display:flex;align-items:center;gap:8px;";
    const icon = attachment.type === "photo" ? "🖼️" : attachment.type === "gif" ? "GIF" : "📎";
    pending.textContent = `${icon} Wird hochgeladen…`;
    attEl.appendChild(pending);
  }

  div.insertBefore(attEl, textEl);
}
// ── Ende Attachment-Bubble ───────────────────────

const timeEl = document.createElement("div");
timeEl.className = "timestamp";

let meta = formatTimestamp(ts);

// Status nur für eigene Nachrichten anzeigen
if (from === getMyUser()) {
  if (status === "delivered") {
    meta += " · " + lang.statusDelivered;
  } else if (status === "sent") {
    meta += " · " + lang.statusSent;
  } else if (status === "pending") {
    meta += " · " + lang.statusSending;
  }
}

timeEl.textContent = meta;
div.appendChild(timeEl);

if (id) div.dataset.id = id;
if (tempId) div.dataset.tempId = tempId;
if (ts) div.dataset.ts = String(ts); // für mark-read Debounce

// 🗑️ Delete-Event kam vor Render → sofort als gelöscht anzeigen
if (id && deletedMessageIds.has(id)) {
  const textEl = div.querySelector(".msg-text");
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

// ↩️ Quote-Block rendern (wenn Nachricht eine Antwort ist — auch cross-chat ohne replyToId)
if (replyToId || (replyFrom && replyPlaintext)) { // Quote-Block immer zeigen wenn replyToId gesetzt, auch wenn Entschlüsselung fehlschlägt
  const quote = document.createElement("div");
  quote.className = "reply-quote";
  quote.dataset.replyToId = replyToId;
  const qFrom = document.createElement("div");
  qFrom.className = "reply-quote-from";
  // Guest-Handle (guest_xyz) → lesbarer Display-Name (z.B. "Guest Silver Cobra")
  qFrom.textContent = replyFrom ? guestDisplayName(replyFrom) : "…";
  const qText = document.createElement("div");
  qText.className = "reply-quote-text";
  qText.textContent = replyPlaintext ? replyPlaintext.slice(0, 100) : "…";
  quote.append(qFrom, qText);
  quote.addEventListener("click", (e) => {
    e.stopPropagation(); // verhindert Context Menu
    const orig = document.querySelector(`[data-id="${replyToId}"]`);
    if (orig) { orig.scrollIntoView({ behavior: "smooth", block: "center" }); orig.classList.add("highlight-flash"); setTimeout(() => orig.classList.remove("highlight-flash"), 1200); }
  });
  quote.addEventListener("contextmenu", (e) => e.stopPropagation());
  div.insertBefore(quote, textEl);
}

// Löschen ist jetzt im Context Menu (Rechtsklick / Long-Press)

// Bestehende Reaktionen aus Cache rendern
if (id && reactionsCache.has(id)) renderReactionBar(div, id);

// 📱 Context Menu: Long-Press (Mobile) + Right-Click (Desktop)
if (id && status !== "pending" && status !== "failed") {
  attachContextMenu(div, { id, from, textEl, ts });
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

  // .msg-text explizit — verhindert dass .reply-quote als Ziel verwendet wird
  const textEl = div.querySelector(".msg-text");
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
      // encryptGroupMessage(groupId, myHandle, plaintext) → { ivB64, ctB64, chainIndex }
      const enc = await encryptGroupMessage(withUser, getMyUser(), newText);
      // Backend erwartet kompaktes JSON als ciphertext-String
      ciphertext = JSON.stringify({ ivB64: enc.ivB64, ctB64: enc.ctB64 });
      rotationIndex = enc.chainIndex ?? null;
    } else {
      const mk = await deriveMessageKey(sessionKeyBytes, dmSessionId(getMyUser(), withUser), Math.floor(Date.now() / EPOCH_MS));
      const enc = await e2eEncrypt(mk, newText);
      ciphertext = JSON.stringify({ ivB64: enc.ivB64, ctB64: enc.ctB64 });
      rotationIndex = sessionRotationIndex;
    }

    await apiFetch("/chat/message/edit", {
      method: "POST",
      body: JSON.stringify({ id: msgId, ciphertext, rotationIndex })
    });

    // Bubble sofort aktualisieren
    ta.remove();
    const linkedNew = linkify(newText);
    if (linkedNew !== escapeHtml(newText)) {
      textEl.innerHTML = linkedNew;
    } else {
      textEl.textContent = newText;
    }
    textEl.style.display = "";
    applyEditedBadge(div);
    savePreviewCache(previewConvoId(withUser), { text: newText, ts: Date.now(), from: getMyUser() });
  } catch (err) {
    cancelInlineEdit(div, textEl, ta);
    alert(lang.editFailed + (err.message || err));
  }
}

function applyEditedBadge(div) {
  if (div.querySelector(".edited-badge-wrap")) return;
  const timeEl = div.querySelector(".timestamp");
  const badge = document.createElement("span");
  badge.className = "edited-badge";
  badge.textContent = lang.statusEdited;
  const wrap = document.createElement("span");
  wrap.className = "edited-badge-wrap";
  wrap.appendChild(badge);
  if (timeEl) timeEl.appendChild(wrap);
  else div.appendChild(wrap);
}

async function handleMessageEdited(event) {
  const { messageId, ciphertext, rotationIndex, from, sid: eventSid } = event;
  if (!messageId || !ciphertext) return;

  const el = document.querySelector(`[data-id="${messageId}"]`);
  if (!el || el.dataset.deleted === "1") return;

  try {
    let plaintext;
    let ivB64, ctB64;
    try { ({ ivB64, ctB64 } = JSON.parse(ciphertext)); } catch { return; }

    if (isGroupConversation(withUser)) {
      plaintext = await decryptGroupMessage(withUser, from, ivB64, ctB64, rotationIndex ?? 0);
    } else {
      // Synthetisches Message-Objekt → decryptMessageIfNeeded nutzen (korrekte Rotation-Logik)
      const fakeMsg = {
        ivB64, ctB64,
        rotationIndex: rotationIndex ?? 0,
        from,
        ts: event.ts || Date.now(),
        id: null   // null → kein Cache-Hit, immer frisch entschlüsseln
      };
      plaintext = await decryptMessageIfNeeded(fakeMsg, withUser);
      // Retry mit Original-SID (Event-Feld oder gecacht beim ersten Render) für
      // Edits aus der Guest-Phase. Ohne diesen Retry schlägt der SID-Peer-Fallback
      // in decryptMessageIfNeeded fehl, weil fakeMsg keine sid hat.
      if (plaintext === "__decrypt_failed__") {
        const origSid = eventSid || messageSidCache.get(messageId);
        if (origSid) {
          plaintext = await decryptMessageIfNeeded({ ...fakeMsg, sid: origSid }, withUser);
        }
      }
    }
    if (!plaintext || plaintext === "__decrypt_failed__") return;

    // .msg-text explizit — verhindert reply-quote Überschreibung
    const textEl = el.querySelector(".msg-text");
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
  // Reply-Quote entfernen (gelöschte Nachricht zeigt keinen Zitat-Block mehr)
  el.querySelector(".reply-quote")?.remove();
  const textEl = el.querySelector(".msg-text");
  if (textEl) {
    textEl.textContent = lang.messageDeleted;
    textEl.style.opacity = "0.5";
    textEl.style.fontStyle = "italic";
  }
  el.querySelector(".delete-btn")?.remove();
  el.dataset.deleted = "1";
}

async function deleteMessage(messageId) {
  try {
    const res = await apiFetch("/chat/message/delete", {
      method: "DELETE",
      body: JSON.stringify({ id: messageId })
    });
    // apiFetch gibt bei 429/Netzwerk-Fehlern { rateLimited: true } zurück statt zu werfen
    // → ohne diese Prüfung würden wir die Nachricht lokal als gelöscht markieren,
    //   obwohl der Server sie nie empfangen hat (sie taucht beim nächsten Poll wieder auf).
    if (res && res.rateLimited) {
      alert(lang.deleteFailed + (res.error || ""));
      return;
    }
    markMessageDeleted(messageId);
  } catch (e) {
    console.warn("⚠️ Delete failed", e);
    alert(lang.deleteFailed + (e?.message || e));
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

  // Original-SID cachen (für Edit-Decrypt Fallback nach Guest→Account-Conversion).
  if (m.sid) messageSidCache.set(m.id, m.sid);

  // ── Guest-Conversion-Boundary (WebSocket-Nachzügler) ─────────────────────
  // Reguläre Messages aus der Gast-Ära still verwerfen, wenn der aktuelle User
  // selbst konvertiert wurde. System-Messages + Control-Types immer durchlassen.
  if (_convertBoundaryTs > 0 &&
      m.type !== "system" &&
      (m.ts || 0) <= _convertBoundaryTs) {
    return false;
  }

  // ── GSK empfangen (Polling-Fallback für Gäste ohne WebSocket) ────────────
  // gsk-Nachrichten werden in D1 gespeichert damit Gäste sie via /chat/list erhalten.
  // Reguläre User empfangen sie bereits via WebSocket (controlSocket.js) — idempotent.
  // groupId: aus m.groupId (WebSocket-Push) oder withUser (D1/Polling — groupId nicht in Schema).
  if (m.type === "gsk" && Array.isArray(m.payloads)) {
    const gskGroupId = m.groupId || (isGroupConversation(withUser) ? withUser : null);
    if (gskGroupId && !renderedMessageIds.has(m.id)) {
      renderedMessageIds.add(m.id);
      receiveGroupSK({
        from:          m.from,
        groupId:       gskGroupId,
        myDeviceId:    getDeviceId(),
        payloads:      m.payloads,
        findSenderDeviceJwkFn: async (handle, deviceId) => {
          try {
            const r = await apiFetch(`/e2e/inbox/get?user=${encodeURIComponent(handle)}`);
            const devs = Array.isArray(r.devices) ? r.devices : [];
            return devs.find(d => d.deviceId === deviceId)?.jwk || null;
          } catch { return null; }
        }
      }).then(ok => {
        if (ok) {
          console.log("🔑 GSK via Polling empfangen von:", m.from, "→ flush deferred");
          flushDeferredInboundMessages().catch(() => {});
        } else {
          // GSK konnte nicht verarbeitet werden (JWK fehlt, Payload-Mismatch, …)
          // → ID aus renderedMessageIds entfernen damit nächster Poll erneut versucht
          renderedMessageIds.delete(m.id);
        }
      }).catch(e => {
        console.warn("⚠️ receiveGroupSK (polling):", e);
        renderedMessageIds.delete(m.id); // Retry erlauben
      });
    }
    return false;
  }

  // ── request_gsk empfangen (Polling-Fallback: Member war offline beim Join) ─
  // Falls ich derjenige bin der den GSK senden soll → jetzt nachholen.
  // D1-Polling: m.groupId fehlt (kein DB-Feld) → withUser als Fallback
  // D1-Polling: m.requestedFrom fehlt → in m.message gespeichert (Fallback)
  const _reqGskGroupId  = m.groupId || (isGroupConversation(withUser) ? withUser : null);
  const _reqGskTarget   = m.requestedFrom || m.message; // m.message = requestedFrom (D1-Fallback)
  const _myHandleForGsk = _isGuestMode ? _guestData?.guestHandle : getMyUser();
  if (m.type === "request_gsk" && _reqGskGroupId && _reqGskTarget === _myHandleForGsk && m.from) {
    // Rate-Limit pro Requester: max 1 Antwort alle 15s. Vorher nur einmal
    // pro Message-ID → wenn alice31 die Antwort aus irgendeinem Grund
    // nicht bekam, gab es keine Retry. Jetzt beantworten wir wiederholte
    // request_gsks — mit Cooldown gegen Spam.
    const gskResponseKey = `gsk_resp:${_reqGskGroupId}:${m.from}`;
    const lastResponse = Number(sessionStorage.getItem(gskResponseKey) || 0);
    if (Date.now() - lastResponse < 15_000) {
      renderedMessageIds.add(m.id);
      return false;
    }
    renderedMessageIds.add(m.id);
    sessionStorage.setItem(gskResponseKey, String(Date.now()));
    (async () => {
      try {
        await getOrCreateGroupSK(_reqGskGroupId, _myHandleForGsk);
        // Inbox-Cache IMMER invalidieren — stale empty cache verhindert sonst
        // die Auflösung wenn alice31 ihre Keys gerade erst hochgeladen hat.
        try { invalidateInboxKeyCache(m.from); } catch {}
        const r = await apiFetch(`/e2e/inbox/get?user=${encodeURIComponent(m.from)}`);
        const devs = Array.isArray(r.devices) ? r.devices : [];
        if (devs.length) {
          await distributeGroupSK(_reqGskGroupId, _myHandleForGsk,
            devs.map(d => ({ ...d, memberHandle: m.from })), apiFetch);
          console.log("🔑 GSK an Requester verteilt:", m.from, "Devices:", devs.length);
        } else {
          // Race: alice31 hat ihre Keys noch nicht hochgeladen → nach 3s retry
          console.warn("⏳ Keine Devices für Requester — Retry in 3s:", m.from);
          setTimeout(async () => {
            try {
              invalidateInboxKeyCache(m.from);
              const r2 = await apiFetch(`/e2e/inbox/get?user=${encodeURIComponent(m.from)}`);
              const devs2 = Array.isArray(r2.devices) ? r2.devices : [];
              if (devs2.length) {
                await distributeGroupSK(_reqGskGroupId, _myHandleForGsk,
                  devs2.map(d => ({ ...d, memberHandle: m.from })), apiFetch);
                console.log("🔑 GSK an Requester verteilt (Retry):", m.from);
              }
            } catch {}
          }, 3000);
        }
      } catch (e) { console.warn("⚠️ request_gsk response fehlgeschlagen:", e); }
    })();
    return false;
  }
  // ─────────────────────────────────────────────────────────────────────────

  // System-Messages (join/leave) direkt als UI-Hinweis rendern — kein Decrypt, kein Bubble
  if (m.type === "system") {
    if (renderedMessageIds.has(m.id)) return false;
    renderedMessageIds.add(m.id);
    const rawSys = m.message || m.text || "";
    if (rawSys === "__guest_convert_notice__") {
      const noticeText = lang.guestConvertNotice || "🔒 Messages from your guest session cannot be displayed after registration";
      // Auffälligerer Hinweis als normale System-Messages
      if (messagesEl) {
        const div = document.createElement("div");
        div.style.cssText = "text-align:center;padding:10px 16px;margin:8px 0;font-size:12px;color:var(--text-secondary);background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:8px;";
        div.textContent = noticeText;
        messagesEl.appendChild(div);
        scrollToBottom();
      }
      savePreviewCache(previewConvoId(withUser), { text: noticeText, ts: m.ts || Date.now(), from: "__system__" });
    } else {
      const sysText = replaceGuestHandles(rawSys);
      showSystemMessage(sysText);
      savePreviewCache(previewConvoId(withUser), { text: sysText, ts: m.ts || Date.now(), from: "__system__" });
    }

    // Polling-Fallback für GUEST_JOINED: GSK proaktiv an neuen Gast senden
    // (Gäste ohne WebSocket empfangen das DO-Push-Event nicht)
    if (isGroupConversation(withUser) && (m.message || "").includes("joined")) {
      const joinedHandle = m.from_user || m.from;
      const myHandle = _isGuestMode ? _guestData?.guestHandle : getMyUser();
      if (joinedHandle && myHandle && joinedHandle !== myHandle) {
        (async () => {
          try {
            await getOrCreateGroupSK(withUser, myHandle);
            const r = await apiFetch(`/e2e/inbox/get?user=${encodeURIComponent(joinedHandle)}`);
            const devs = Array.isArray(r.devices) ? r.devices : [];
            if (devs.length) {
              await distributeGroupSK(withUser, myHandle,
                devs.map(d => ({ ...d, memberHandle: joinedHandle })), apiFetch);
              console.log("✅ GSK proaktiv via Polling an neuen Gast gesendet:", joinedHandle);
            } else {
              // Key-Upload Race → Retry nach 3s
              setTimeout(async () => {
                try {
                  const r2 = await apiFetch(`/e2e/inbox/get?user=${encodeURIComponent(joinedHandle)}`);
                  const devs2 = Array.isArray(r2.devices) ? r2.devices : [];
                  if (devs2.length) {
                    await distributeGroupSK(withUser, myHandle,
                      devs2.map(d => ({ ...d, memberHandle: joinedHandle })), apiFetch);
                  }
                } catch {}
              }, 3000);
            }
          } catch (e) { console.warn("⚠️ GSK Polling-Push fehlgeschlagen:", e); }
        })();
      }
    }

    return true;
  }

  const messageId = m.id;

  // Bereits gerendert → Status + Edit (Polling-Fallback) updaten
  if (renderedMessageIds.has(messageId)) {
    const prevStatus = renderedMessageStatus.get(messageId);
    if (m.status && m.status !== prevStatus) {
      updateRenderedMessageStatus(messageId, m.status);
      renderedMessageStatus.set(messageId, m.status);
    }
    // Edit-Update via Polling: Gäste (und WS-off) empfangen message_edited
    // NICHT über WebSocket → auf edited_at-Änderung reagieren.
    if (m.edited_at && m.edited_message) {
      const prevEditedAt = renderedMessageEditedAt.get(messageId) || 0;
      if (Number(m.edited_at) > prevEditedAt) {
        renderedMessageEditedAt.set(messageId, Number(m.edited_at));
        let editRotIdx = m.rotationIndex;
        try {
          const parsedEdit = JSON.parse(m.edited_message);
          if (parsedEdit?.rotationIndex != null) editRotIdx = parsedEdit.rotationIndex;
        } catch {}
        handleMessageEdited({
          messageId,
          ciphertext:    m.edited_message,
          rotationIndex: editRotIdx,
          from:          m.from,
          ts:            m.edited_at,
          sid:           m.sid, // Original-SID für Guest-Conversion-Fallback beim Edit-Decrypt
        }).catch(() => {});
      }
    }
    return false;
  }

  // Bereits in der Deferred-Queue → nicht nochmal hinzufügen (würde MAX_INBOUND_RETRIES schnell erschöpfen)
  // Gilt für Gruppen (e2eReady=true immer) UND DMs (e2eReady=false bis CMK bereit).
  // flushDeferredInboundMessages() übernimmt das Retry wenn GSK/CMK eintrifft.
  if (deferredInboundIds.has(messageId)) {
    // GSK weiter anfordern (rate-limited via pendingGskRequests, 10s Cooldown)
    if (isGroupConversation(withUser) && m.from && m.from !== getMyUser() && m.ivB64) {
      requestGSKFrom(withUser, m.from).catch(() => {});
    }
    return false;
  }

  // 🔒 SOFORT markieren BEVOR async decrypt startet — verhindert Race-Condition
  // zwischen WebSocket (NEW_MESSAGE) und Polling (loadMessages) die sonst
  // beide gleichzeitig processMessage() für dieselbe ID aufrufen können.
  renderedMessageIds.add(messageId);

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
    // 🧹 Stale: Nachricht älter als 1h und immer noch kein Key → nicht mehr deferren
    if (m.ts && (Date.now() - m.ts) > STALE_MESSAGE_MAX_AGE_MS) {
      console.warn("🧹 Stale msg — skip deferred queue", { id: messageId, ageMs: Date.now() - m.ts });
      renderedMessageIds.add(messageId);
      if (isAutoDeleted(m.ts)) {
        showSystemMessage(lang.messageExpired || "⏱ Nachricht automatisch gelöscht");
      } else {
        renderMessage({ id: messageId, from: m.from, message: decryptFailedText(m.ts), ts: m.ts });
      }
      return true;
    }
    deferredInboundMessages.push(m);
    deferredInboundIds.add(messageId);
    // Phase 5.1: Für Gruppen die Bubble mit Button rendern (statt nur Pending-Text),
    // damit User auch bei "GSK fehlt"-Fall den manuellen Recovery-Button sieht.
    if (isGroupConversation(withUser) && m.from && m.from !== getMyUser()) {
      renderDecryptFailedBubble(m, { isGroup: true, groupId: withUser });
      _decryptFailedRenderedIds.add(messageId);
      // Auto-Trigger im Hintergrund (parallel zum Bubble-Button)
      requestGSKFrom(withUser, m.from).catch(() => {});
    } else {
      renderMessage({
        id: messageId,
        from: m.from,
        message: lang.decryptPending,
        ts: m.ts
      });
    }
    renderedMessageIds.add(messageId);
    return false;
  }

  // Decrypt-Fehler: Gruppen → GSK anfordern + in Deferred-Queue (Retry nach GSK_READY)
  //                 DMs     → Self-Healing (cmk_req) + UI mit Retry-Button
  if (text === "__decrypt_failed__") {
    console.debug("[processMsg] DECRYPT_FAILED", { from: m.from, ts: m.ts, id: messageId });
    // 🧹 Stale: älter als 1h → kein Retry, direkt als permanent-failed rendern
    const isStale = m.ts && (Date.now() - m.ts) > STALE_MESSAGE_MAX_AGE_MS;
    if (isGroupConversation(withUser) && m.from && m.from !== getMyUser() && !isStale) {
      const retries = deferredInboundRetryCount.get(messageId) || 0;
      if (retries < MAX_INBOUND_RETRIES) {
        deferredInboundRetryCount.set(messageId, retries + 1);
        deferredInboundMessages.push(m);
        deferredInboundIds.add(messageId);
        renderedMessageIds.add(messageId); // Verhindert Re-Render durch processMessage
        // Auto-Trigger im Hintergrund (parallel zum Bubble-Button)
        requestGSKFrom(withUser, m.from).catch(() => {});
        // Phase 5.1: Bubble mit Button rendern (analog DM-Fix 1+2)
        renderDecryptFailedBubble(m, { isGroup: true, groupId: withUser });
        _decryptFailedRenderedIds.add(messageId);
        return false;
      }
    }
    renderedMessageIds.add(messageId);
    if (isAutoDeleted(m.ts)) {
      showSystemMessage(lang.messageExpired || "⏱ Nachricht automatisch gelöscht");
    } else if (!isGroupConversation(withUser)) {
      // DM: Self-Healing Counter bumpen — NUR bei frischen Msgs (< 5min)
      // Alte Messages triggern kein Bootstrap mehr (Bootstrap-Storm-Fix)
      bumpDecryptFailCounter(m.from, m.ts);
      // UI: spezielle Bubble mit Retry-Button statt generischem Text
      renderDecryptFailedBubble(m);
      _decryptFailedRenderedIds.add(messageId);
    } else {
      // Gruppen: nach MAX_INBOUND_RETRIES erschöpft oder stale → Bubble mit Button.
      // Eigene Group-Nachrichten landen hier, falls Decrypt fehlschlägt → kein Button (Fix 1).
      renderDecryptFailedBubble(m, { isGroup: true, groupId: withUser });
      _decryptFailedRenderedIds.add(messageId);
    }
    return true;
  }

  // Abgelaufene Nachricht (Auto-Delete) → als System-Message anzeigen, unabhängig vom Decrypt-Ergebnis
  if (isAutoDeleted(m.ts)) {
    renderedMessageIds.add(messageId);
    deferredInboundIds.delete(messageId);
    showSystemMessage(lang.messageExpired || "⏱ Nachricht automatisch gelöscht");
    return true;
  }

  // Normale Nachricht rendern — edited_message bevorzugen wenn vorhanden
  let displayText = text;
  if (m.edited_message) {
    try {
      const editEnc = JSON.parse(m.edited_message); // { ivB64, ctB64, rotationIndex? }
      const editRotIndex = editEnc.rotationIndex ?? m.rotationIndex ?? 0;
      let editedPlain;
      if (isGroupConversation(withUser)) {
        editedPlain = await decryptGroupMessage(withUser, m.from, editEnc.ivB64, editEnc.ctB64, editRotIndex);
      } else {
        const fakeMsg = {
          ivB64: editEnc.ivB64,
          ctB64: editEnc.ctB64,
          rotationIndex: editRotIndex,
          from: m.from,
          ts: m.edited_at || m.ts || Date.now(),
          epoch: m.edited_at ? Math.floor(m.edited_at / EPOCH_MS) : undefined,
          id: null
        };
        editedPlain = await decryptMessageIfNeeded(fakeMsg, withUser);
        // Retry mit Original-SID für Edits aus der Guest-Phase: aktuelle SID passt
        // nicht (Peer ist jetzt konvertiert), aber mit m.sid greift der SID-Peer-
        // Fallback (FIX A) in decryptMessageIfNeeded und lädt den alten Guest-CMK.
        if (editedPlain === "__decrypt_failed__" && m.sid) {
          editedPlain = await decryptMessageIfNeeded({ ...fakeMsg, sid: m.sid }, withUser);
        }
      }
      if (editedPlain && editedPlain !== "__decrypt_failed__") displayText = editedPlain;
    } catch {}
  }

  console.debug("[processMsg] OK", { from: m.from, ts: m.ts, preview: String(displayText).slice(0,20) });
  // Erfolgreicher Decrypt → Self-Healing-Counter für diesen Peer zurücksetzen
  if (!isGroupConversation(withUser)) resetDecryptFailCounter(m.from);
  renderedMessageIds.add(messageId);
  deferredInboundIds.delete(messageId);
  // Reply-Preview entschlüsseln (wenn vorhanden)
  if (m.replyToId && m.replyIv && m.replyCt) {
    try {
      let replyPlain;
      if (isGroupConversation(withUser)) {
        // Gruppe: replyRotationIndex bevorzugen (Reply vor Hauptnachricht verschlüsselt)
        const replyChainIdx = m.replyRotationIndex ?? (m.rotationIndex > 0 ? m.rotationIndex - 1 : 0);
        replyPlain = await decryptGroupMessage(withUser, m.from, m.replyIv, m.replyCt, replyChainIdx);
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

  // Attachment-Payload aus entschlüsseltem Text parsen (wenn vorhanden)
  let incomingAttachment = null;
  if (m.attachmentType && m.attachmentType !== "gif") {
    try {
      const parsed = JSON.parse(displayText);
      if (parsed?.r2Key) {
        incomingAttachment = { type: m.attachmentType, payload: parsed };
      }
    } catch {}
  } else if (m.attachmentType === "gif") {
    try {
      const parsed = JSON.parse(displayText);
      if (parsed?.gifUrl) {
        incomingAttachment = { type: "gif", payload: parsed };
      }
    } catch {}
  }

  const renderedDiv = renderMessage({
    id: messageId,
    from: m.from,
    message: incomingAttachment ? "" : displayText,
    ts: m.ts,
    status: m.status,
    msg: m,
    attachment: incomingAttachment
  });
  // (bearbeitet) Badge wenn Nachricht schon editiert wurde
  if (m.edited_at && renderedDiv) {
    applyEditedBadge(renderedDiv);
    renderedMessageEditedAt.set(messageId, Number(m.edited_at));
  }
  // Attachment-Nachrichten: lesbarer Preview statt Raw-JSON
  const previewText = incomingAttachment
    ? (incomingAttachment.type === "photo" ? lang.photoLabel
     : incomingAttachment.type === "gif"   ? "GIF"
     : incomingAttachment.type === "file"  ? `📎 ${incomingAttachment.payload?.fileName || lang.fileLabel}`
     : displayText)
    : displayText;
  savePreviewCache(previewConvoId(withUser), { text: previewText, ts: m.ts || Date.now(), from: m.from });

  if (m.from === getMyUser()) {
    const pending = document.querySelector(".me.pending");
    if (pending) pending.classList.remove("pending");
  }

  return true;
}

// ──────────────────────────────────────────────────────────────────
// loadMessages() — Promise-Coalescing + 200ms Trailing Cooldown
//
// Warum: 22 Call-Sites (WS-Events, Polling, Visibility-Change, Init-Pfade,
// Self-Healing) feuern `loadMessages` teilweise parallel. Nur der Polling-
// Guard `isLoadingMessages` schützt einen Teil. Event-getriggerte Calls
// laufen gleichzeitig → bis zu 5 parallele /chat/list-Requests in ~1s.
//
// Lösung:
//   1) Läuft bereits ein Fetch? → denselben Promise zurückgeben (Coalescing).
//   2) Letzter Fetch < 200ms her? → stumm skippen (Trailing Debounce).
//
// Unproblematisch weil: neue Nachrichten kommen per WebSocket via
// `processMessage` sofort an. `loadMessages` ist Sync-Fallback, nicht
// Real-Time-Kanal. 200ms Cooldown sind nicht spürbar.
// ──────────────────────────────────────────────────────────────────
let _loadMessagesInflight = null;
let _loadMessagesCoolUntil = 0;

async function loadMessages() {
  if (_loadMessagesInflight) return _loadMessagesInflight;
  if (Date.now() < _loadMessagesCoolUntil) return;
  _loadMessagesInflight = _doLoadMessages()
    .finally(() => {
      _loadMessagesInflight = null;
      _loadMessagesCoolUntil = Date.now() + 200;
    });
  return _loadMessagesInflight;
}

async function _doLoadMessages() {
  try {
    const url = "/chat/list?with=" + withUser;
    const res = await apiFetch(url);

    // 🔴 Gast-Session abgelaufen oder Limit — sofort Full-Lock (kein weiteres Lesen)
    if (res?.guestExpired) { lockGuestSession("expired"); return; }
    if (res?.guestLimitReached) { lockGuestSession("limit"); return; }

    // ⚠️ Rate-Limit / Network-Error: apiFetch gibt { rateLimited: true } zurück
    // statt zu werfen. Ohne diesen Guard würde DELETE-DETEKTION unten mit einer
    // leeren `messages`-Liste laufen und ALLE gerenderten Bubbles fälschlich als
    // "gelöscht" markieren (kompletter Chatverlauf weg auf beiden Seiten,
    // typischerweise durch Request-Flut beim Member-Hinzufügen ausgelöst).
    if (res?.rateLimited) return;

    const { messages: rawMessages = [], reactions: msgReactions = {} } = res || {};

    // ── Guest-Conversion-Boundary ─────────────────────────────────────────
    // Wenn ich selbst (bertha) gerade aus einer Gast-Session konvertiert wurde,
    // finde die "guest_x is now bertha" System-Message → alle Gast-Messages vor
    // diesem Zeitpunkt filtern. Der Inviter sieht alles normal (hat passende Keys).
    // Banner "🔒 Nachrichten aus deiner Gast-Session..." kommt via __guest_convert_notice__.
    const myHandleLc = (getMyUser() || "").toLowerCase();
    let boundaryTs = 0;
    for (const m of rawMessages) {
      if (m.type !== "system") continue;
      const txt = (m.message || m.text || "").trim();
      const match = txt.match(/^(\S+) is now (\S+)$/);
      if (match && myHandleLc && match[2].toLowerCase() === myHandleLc) {
        boundaryTs = m.ts || 0;
        break;
      }
    }
    _convertBoundaryTs = boundaryTs;

    const messages = boundaryTs > 0
      ? rawMessages.filter(m => m.type === "system" || (m.ts || 0) > boundaryTs)
      : rawMessages;

    // Reaktionen in Cache laden UND UI aktualisieren.
    // WICHTIG: Server liefert nur Einträge für Nachrichten MIT Reaktionen.
    // Für Nachrichten im aktuellen Response-Fenster, die nicht in msgReactions
    // stehen, müssen wir eine evtl. alte Cache-Entry bereinigen — sonst bleibt
    // eine entfernte Reaktion sichtbar (Gäste/WS-off empfangen reaction_updated
    // nicht über WebSocket, sind also auf diesen Polling-Sync angewiesen).
    for (const m of messages) {
      if (!m?.id) continue;
      const fresh = msgReactions[m.id] || {};
      const hasFresh = Object.keys(fresh).length > 0;
      if (hasFresh) reactionsCache.set(m.id, fresh);
      else reactionsCache.delete(m.id);
      const el = document.querySelector(`[data-id="${m.id}"]`);
      if (el) renderReactionBar(el, m.id);
    }
    console.warn("📥 SERVER MESSAGES:", messages.length, "withUser:", withUser);

    // 📌 Für Gruppen: "letzte gelesene ts" in localStorage UND Backend speichern
    // → Inbox-Badge zeigt nur wirklich neue Nachrichten (seit diesem Zeitpunkt)
    // Control-Messages (gsk, cmk, …) werden ignoriert — sonst springt mark-read
    // auf deren Timestamp und echte Nachrichten gelten fälschlicherweise als gelesen.
    if (isGroupConversation(withUser) && messages.length > 0) {
      const CTRL_TYPES = new Set(['gsk','cmk','cmk_req','cmk_rotate','epoch_rotate','request_gsk']);
      const realMessages = messages.filter(m => !m.type || !CTRL_TYPES.has(m.type));
      const newestTs = (realMessages[realMessages.length - 1] ?? messages[messages.length - 1])?.ts || 0;
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
    // 🗑️ DELETE-DETEKTION via Polling (Gäste / WS-off)
    // Nachrichten die zuvor gerendert waren, aber jetzt nicht mehr im
    // Server-Response auftauchen (und innerhalb des zurückgegebenen
    // Fensters liegen), wurden gelöscht → Bubble als gelöscht markieren.
    // LIMIT=30 entspricht dem Server-Default in /chat/list.
    //
    // Safety-Net: Bei komplett leerem `messages` (keine einzige Nachricht
    // zurückgeliefert) NICHT als Delete-Signal werten. Legitime leere Gruppen
    // haben keine gerenderten Bubbles, also kostet dieser Guard nichts — er
    // verhindert aber Data-Loss-Cascades bei stale/unvollständigen Responses.
    // ==================================================
    if (messages.length > 0) {
      const CHAT_LIST_LIMIT = 30;
      const returnedIds = new Set(messages.map(m => m.id).filter(Boolean));
      const tsValues = messages.map(m => Number(m.ts) || 0).filter(Boolean);
      const windowMinTs = tsValues.length ? Math.min(...tsValues) : 0;
      // Wenn Response weniger als Limit enthält, deckt sie die gesamte Historie ab
      // → alle gerenderten Bubbles müssen darin vorkommen.
      const coversAll = messages.length < CHAT_LIST_LIMIT;
      const bubbles = messagesEl ? messagesEl.querySelectorAll("[data-id][data-ts]") : [];
      bubbles.forEach(el => {
        const id = el.dataset.id;
        const ts = Number(el.dataset.ts || 0);
        if (!id) return;
        if (el.dataset.deleted === "1") return;
        if (deletedMessageIds.has(id)) return;
        if (returnedIds.has(id)) return;
        // Außerhalb des Response-Fensters → Löschung nicht sicher feststellbar
        if (!coversAll && ts < windowMinTs) return;
        markMessageDeleted(id);
      });
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
    // Phase 4 #6: Rotation NICHT während aktiver Recovery — sonst Race zwischen
    // CMK-Wechsel und Rotation. withRecoveryLock holt's nach Recovery nach.
    if (isInRecovery(withUser)) {
      _pendingRotation.add(String(withUser || "").toLowerCase());
      console.log("⏸️ Rotation deferred — Recovery läuft, wird nach Recovery nachgeholt");
      return;
    }
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

  // Gruppen: deferred Nachrichten nach jedem Poll erneut entschlüsseln versuchen.
  // Gäste haben keinen WebSocket → GSK_READY wird nie via BroadcastChannel getriggert.
  // Dieser Pfad stellt sicher dass die Deferred-Queue auch ohne WS periodisch geleert wird.
  if (isGroupConversation(withUser) && deferredInboundMessages.length > 0) {
    flushDeferredInboundMessages().catch(() => {});
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

  // Mitgliederliste immer laden — auch wenn GSK bereits distribuiert,
  // damit _groupHasGuests bei Page-Reload korrekt gesetzt wird.
  let members = [];
  try {
    const res = await apiFetch(`/groups/members?groupId=${encodeURIComponent(groupId)}`);
    const allMembers = res.members || [];
    members = allMembers.filter(m => m.member_handle !== myHandle);
  } catch (e) {
    console.warn("⚠️ ensureGroupChatReady: Mitgliederliste fehlgeschlagen", e);
  }

  if (members.length === 0) {
    console.log("🏘️ Gruppe hat noch keine anderen Mitglieder:", groupId);
    return;
  }

  // Helper: Verteile GSK an einen Member (mit Logging)
  const distributeOne = async (memberHandle) => {
    try {
      try { invalidateInboxKeyCache(memberHandle); } catch {}
      const devices = await fetchInboxKeys(memberHandle);
      if (!devices?.length) {
        console.warn(`⚠️ distribute: keine Devices für ${memberHandle}`);
        return false;
      }
      const tagged = devices.map(d => ({ ...d, memberHandle }));
      await distributeGroupSK(groupId, myHandle, tagged, apiFetch);
      console.log(`🔑 GSK verteilt an ${memberHandle} (${devices.length} device(s))`);
      return true;
    } catch (e) {
      console.warn(`⚠️ distribute zu ${memberHandle} fehlgeschlagen:`, e?.message || e);
      return false;
    }
  };

  // Schritt 1: Eigenen GSK an alle Members parallel senden (erster Versuch)
  const firstRound = await Promise.allSettled(
    members.map(m => distributeOne(m.member_handle).then(ok => ({ handle: m.member_handle, ok })))
  );
  const failedMembers = new Set(
    firstRound
      .filter(r => r.status === "fulfilled" && !r.value.ok)
      .map(r => r.value.handle)
  );

  // Schritt 2: AGGRESSIVE RETRIES mit wachsendem Intervall (3s, 10s, 30s).
  // Kritisch für Gast-Joins: wenn GSK nicht ankommt, können existierende Member
  // NIE die Messages des neuen Gastes entschlüsseln. Mehrfach-Retries decken ab:
  //  • Race mit Key-Upload-Propagation
  //  • Kurzzeitige Network-/Rate-Limit-Errors
  //  • Cache-Staleness
  if (failedMembers.size > 0) {
    console.warn(`⏳ GSK distribute fehlgeschlagen für ${failedMembers.size} Member(s) — Retries geplant`);
    const RETRY_DELAYS = [3000, 10000, 30000];
    RETRY_DELAYS.forEach((delay, idx) => {
      setTimeout(async () => {
        const stillFailed = Array.from(failedMembers);
        if (stillFailed.length === 0) return;
        console.log(`🔄 GSK Retry #${idx + 1} (nach ${delay}ms) für:`, stillFailed);
        for (const handle of stillFailed) {
          const ok = await distributeOne(handle);
          if (ok) failedMembers.delete(handle);
        }
        // Phase 5.4: Nach LETZTEM Retry — wenn immer noch Members übrig, UX-Hint zeigen
        const isLastRetry = idx === RETRY_DELAYS.length - 1;
        if (isLastRetry && failedMembers.size > 0) {
          const hintKey = `group_offline_hint:${groupId}`;
          // 1x pro Chat-Open zeigen (sessionStorage, wird bei Reload genullt)
          if (!sessionStorage.getItem(hintKey)) {
            const hint = (lang.groupMembersOfflineHint
              || "ℹ️ {count} member(s) currently unreachable. Your messages will be delivered when they're back online.")
              .replace("{count}", String(failedMembers.size));
            try { showSystemMessage(hint); } catch {}
            try { sessionStorage.setItem(hintKey, "1"); } catch {}
            console.warn(`ℹ️ Group: ${failedMembers.size} unerreichbare Member(s) — UX-Hint angezeigt`);
          }
        }
      }, delay);
    });
  }

  // Schritt 3: Fehlende GSKs von Members sequenziell anfordern (Pull)
  let requested = 0;
  for (const member of members) {
    const existingGsk = await getGroupSK(groupId, member.member_handle);
    if (!existingGsk) {
      await requestGSKFrom(groupId, member.member_handle);
      requested++;
      if (requested < members.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  const distributedCount = firstRound.filter(r => r.status === "fulfilled" && r.value.ok).length;
  console.log("✅ GSK Initial-Distribution:", { groupId, members: members.length, distributed: distributedCount, failed: failedMembers.size, requested });
}

// ======================================================
// STARTUP (FIXED ORDER)
// ======================================================

(async () => {
try {

  // 🔒 Startup Guard – verhindert Doppel-Init
if (window.__chatStartupDone) {
  console.warn("⚠️ Chat Startup wurde bereits ausgeführt");
  return;
}
window.__chatStartupDone = true;

  console.log("💬 Chat Startup läuft");

  // ── Module mit Live-Gettern konfigurieren ──
  setupAutoDelete({
    getWithUser: () => withUser,
    getMyUser,
    isGroupConversation,
    getMessagesEl: () => messagesEl
  });
  setupPresence({
    getWithUser: () => withUser,
    isGroupConversation
  });
  setupContextMenu({
    getMyUser,
    startInlineEdit,
    deleteMessage
  });

  // ══ GAST-MODUS: Ephemeres E2E (Key aus sessionStorage) ══════════════
  if (_isGuestMode && _guestData) {
    localStorage.setItem("my_user", _guestData.guestHandle);
    startChat();
    showGuestBanner();
    const inviteItem = document.getElementById("chat-invite-item");
    if (inviteItem) inviteItem.style.display = "none";
    const attachBar = document.getElementById("attach-bar");
    if (attachBar) attachBar.style.display = "none";

    // Ephemeren Key aus localStorage laden und in IDB einspielen
    // damit initE2EKeys() / loadPrivateKey() den gleichen Key findet.
    // Persistent: überlebt Tab-Close (serverseitige TTL 24h ist das Limit).
    const guestDeviceId = _guestData.deviceId || getGuestDeviceId();
    const privJwkRaw    = getGuestPrivJwk();
    if (privJwkRaw && guestDeviceId) {
      try {
        const privJwk   = JSON.parse(privJwkRaw);
        const privKey   = await crypto.subtle.importKey(
          "jwk", privJwk,
          { name: "ECDH", namedCurve: "P-256" },
          false, ["deriveKey"]
        );
        const pubKey    = await crypto.subtle.importKey(
          "jwk", { ...privJwk, d: undefined, key_ops: [] },
          { name: "ECDH", namedCurve: "P-256" },
          true, []
        );
        // In IDB speichern (wird von loadPrivateKey() / wrapCMKForInboxDevices() gelesen)
        await idbSet("e2e-private-key", privKey);
        await idbSet("e2e-public-key",  pubKey);
        // device_id setzen (wird von getDeviceId() gelesen)
        localStorage.setItem("device_id", guestDeviceId);
        // Public Key (neu) in KV hochladen — sichert gegen TTL-Ablauf
        const pubJwk = await crypto.subtle.exportKey("jwk", pubKey);
        apiFetch("/e2e/inbox/upload", {
          method: "POST",
          body: JSON.stringify({ jwk: pubJwk, deviceId: guestDeviceId })
        }).catch(e => console.warn("⚠️ Gast-Key re-upload fehlgeschlagen:", e));
        console.log("🔐 Gast-E2E-Key geladen:", guestDeviceId);
      } catch (e) {
        console.warn("⚠️ Gast-E2E-Key konnte nicht geladen werden:", e);
      }
    } else {
      console.warn("⚠️ Kein Gast-E2E-Key in sessionStorage — Nachrichten evtl. nicht entschlüsselbar");
    }

    // ── Gruppen-Gast: GSK-Flow (wie bisher) ─────────────────────────
    if (isGroupConversation(withUser)) {
      e2eReady = true;
      updateSendButton();
      await initAutoDeleteUI().catch(() => {});
      try { await loadMessages(); } catch (e) { console.warn("Guest loadMessages failed:", e); }
      ensureGroupChatReady(withUser, _guestData.guestHandle)
        .catch(e => console.warn("⚠️ ensureGroupChatReady (guest) failed", e));
      startPolling();
      console.log("👤 Gruppen-Gast gestartet (E2E):", withUser, "als", _guestData.guestHandle);
      return;
    }

    // ── DM-Gast: CMK → SessionKey Bootstrap (wie reguläre User) ───
    const me = _guestData.guestHandle;
    console.warn("🔑 DM-Gast Bootstrap START:", { me, withUser });

    // Guard zurücksetzen — Gast-Join kann Bootstrap unterbrochen haben
    const dmSid = `dm:${[me, withUser].sort().join(":")}`;
    sessionStorage.removeItem(`bootstrapped:${dmSid}`);
    sessionStorage.removeItem(`fallback_bootstrapped:${dmSid}`);
    sessionStorage.removeItem(`cmk_req_sent:${dmSid}`);

    const peerOk = await fetchAndStorePeerPublicKey(withUser);
    console.warn("🔑 DM-Gast peerKey:", peerOk);

    let ok;
    try {
      ok = await ensureConversationReady(me, withUser, fetchInboxKeys, apiFetch);
    } catch (e) {
      console.warn("🔑 DM-Gast ensureConversationReady ERROR:", e);
      ok = false;
    }
    console.warn("🔑 DM-Gast ensureConversationReady:", ok);

    const entry = await bootConversation(me, withUser);
    console.warn("🔑 DM-Gast bootConversation:", entry === null ? "null" : { ready: entry?.ready, hasSkBytes: !!entry?.skBytes, hasCmk: !!entry?.cmkBytes });

    if (entry?.ready && entry?.skBytes) {
      sessionKeyBytes = entry.skBytes;
      sessionCmkBytes = entry.cmkBytes ?? sessionCmkBytes;
      sessionRotationIndex = entry.rotationIndex ?? 0;
      e2eReady = true;
    }

    updateSendButton();
    await initAutoDeleteUI().catch(() => {});

    if (e2eReady) {
      try { await loadMessages(); } catch (e) { console.warn("Guest DM loadMessages failed:", e); }
      // WICHTIG: flushDeferredQueue() für ausgehende Nachrichten die der Gast
      // schon getippt hat bevor E2E ready war. Ohne das bleiben sie in
      // "Sende..."-Status hängen bis der User manuell etwas Neues tippt.
      await flushDeferredQueue();
      await flushDeferredInboundMessages();
      startTimeBasedRotation();
      console.warn("✅ DM-Gast gestartet (E2E bereit):", withUser, "als", me);
    } else {
      // CMK noch nicht da → KV-Fetch + Fallback wie regulärer User
      const kvFetched = await fetchAndStoreCMK(me, withUser, apiFetch, fetchInboxKeys);
      console.warn("🔑 DM-Gast KV-Fetch:", kvFetched);
      if (kvFetched) {
        const e = await bootConversation(me, withUser);
        if (e?.skBytes) {
          sessionKeyBytes = e.skBytes;
          sessionCmkBytes = e.cmkBytes ?? sessionCmkBytes;
          sessionRotationIndex = e.rotationIndex ?? 0;
          e2eReady = true;
          updateSendButton();
          console.warn("✅ DM-Gast: CMK aus KV geladen – E2E bereit");
          await loadMessages();
          await flushDeferredQueue();
          await flushDeferredInboundMessages();
          startTimeBasedRotation();
        }
      }
      if (!e2eReady) {
        const fallbacked = await fallbackBootstrap(me, withUser, fetchInboxKeys, apiFetch);
        console.warn("🔑 DM-Gast fallbackBootstrap:", fallbacked);
        if (fallbacked) {
          const e = await bootConversation(me, withUser);
          if (e?.skBytes) {
            sessionKeyBytes = e.skBytes;
            sessionCmkBytes = e.cmkBytes ?? sessionCmkBytes;
            sessionRotationIndex = e.rotationIndex ?? 0;
            e2eReady = true;
            updateSendButton();
            console.warn("✅ DM-Gast: Fallback Bootstrap – E2E bereit");
            await loadMessages();
            await flushDeferredQueue();
            await flushDeferredInboundMessages();
            startTimeBasedRotation();
          }
        }
      }
      if (!e2eReady) {
        try { await loadMessages(); } catch (e) { console.warn("Guest DM loadMessages failed:", e); }
        console.log("🟡 DM-Gast: warte auf CMK von", withUser);
      }
    }

    startPolling();
    return;
  }
  // ═════════════════════════════════════════════════════════════════════

  // 0️⃣ UI sofort binden — Enter & Click funktionieren von Anfang an.
  // Nachrichten während E2E-Setup werden in deferredQueue gepuffert und
  // nach CMK-Ready via flushDeferredQueue() gesendet.
  startChat();

  // 1️⃣ Eigene E2E-Keys (immer — auch für Gruppen nötig für GSK-Wrap/Unwrap)
  getDeviceId(); // ✅ Device-ID sicher setzen
  await initE2EKeys();
  await debugPrintMyPublicKey();
  await uploadMyPublicKeyIfNeeded();
  // Inbox-Key immer frisch hochladen — stellt sicher dass andere User
  // nach Re-Login den aktuellen Public Key für GSK-Wrapping haben
  uploadInboxKeyIfNeeded().catch(e => console.warn("⚠️ Inbox-Key upload failed:", e));

  // ──────────────────────────────────────────────────────────────
  // 🏘️ GRUPPEN-STARTUP (kein CMK / keine Authority)
  // ──────────────────────────────────────────────────────────────
  if (isGroupConversation(withUser)) {
    // Gruppen brauchen keinen DM-Handshake (CMK). E2E via Sender Keys.
    // e2eReady = true sofort → Nachrichten können direkt gesendet werden.
    e2eReady = true;
    startChat(); // zweiter Aufruf ist idempotent (dataset.bound Guard)
    updateSendButton();

    // Auto-Delete zuerst laden — damit isAutoDeleted() bei loadMessages() korrekt arbeitet
    await initAutoDeleteUI().catch(() => {});

    // Phase 5.3: Multi-Device — wenn lokal kein eigener GSK, aus KV holen
    // (eigenes anderes Device hat ihn evtl. dort abgelegt via syncGroupSKToOwnDevices).
    // Fire-and-forget: blockiert loadMessages nicht; greift wenn KV-Payload da ist.
    const myHandleForGroup = getMyUser();
    if (myHandleForGroup) {
      const localGsk = await getGroupSK(withUser, myHandleForGroup);
      if (!localGsk) {
        // Findfn: erst IDB, dann Inbox-API als Fallback (analog DM-Flow)
        const findSenderJwk = async (fromHandle, deviceId) => {
          try {
            const inboxDevices = await fetchInboxKeys(fromHandle, { forceFresh: true });
            const d = (inboxDevices || []).find(d => d.deviceId === deviceId);
            return d?.jwk || null;
          } catch { return null; }
        };
        fetchOwnGroupSKFromKV(withUser, apiFetch, findSenderJwk)
          .catch(e => console.warn("⚠️ fetchOwnGroupSKFromKV failed", e));
      }
    }

    try { await loadMessages(); } catch (e) { console.warn("Group loadMessages failed", e); }

    // GSK im Hintergrund distribuieren (non-blocking)
    ensureGroupChatReady(withUser, getMyUser())
      .catch(e => console.warn("⚠️ ensureGroupChatReady failed", e));

    // Phase 5.3: Eigener GSK an andere eigene Devices syncen (für Multi-Device).
    // Throttle in syncGroupSKToOwnDevices verhindert Spam.
    if (myHandleForGroup) {
      syncGroupSKToOwnDevices(
        withUser,
        myHandleForGroup,
        (h, opts) => fetchInboxKeys(h, opts),
        apiFetch
      ).catch(e => console.warn("⚠️ syncGroupSKToOwnDevices failed", e));
    }

    // Gruppe als gesehen markieren → Badge auf Inbox-Seite verschwindet
    try {
      const seen = new Set(JSON.parse(localStorage.getItem("renex_seen_groups") || "[]"));
      seen.add(withUser);
      localStorage.setItem("renex_seen_groups", JSON.stringify([...seen]));
    } catch {}
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

  // Phase 2 #1: Multi-Device-Sync — eigene Geräte (z.B. neu hinzugefügtes iPad)
  // bekommen via KV den CMK. Fire-and-forget, blockiert Chat-Start nicht.
  // Throttle in syncCMKToOwnDevices verhindert Spam (5 Min pro sid).
  // forceFresh, damit ein eben erst hinzugefügtes Device nicht durch 30s-Cache verpasst wird.
  syncCMKToOwnDevices(
    localStorage.getItem("my_user"),
    withUser,
    (h) => fetchInboxKeys(h, { forceFresh: true }),
    apiFetch
  ).catch(e => console.warn("⚠️ syncCMKToOwnDevices failed:", e));
}

// 5️⃣ UI starten
startChat();
updateSendButton();

// 6️⃣ Auto-Delete UI zuerst laden — damit isAutoDeleted() bei loadMessages() korrekt arbeitet
await initAutoDeleteUI().catch(() => {});
initDMPresence().catch(() => {});

// 7️⃣ Initial Messages laden wenn E2E bereit —
// sonst ruft der KV-Fetch / Fallback-Bootstrap loadMessages danach auf
if (e2eReady) {
  try {
    await loadMessages();
  } catch (e) {
    console.warn("Initial loadMessages failed", e);
  }
}

// 7b️⃣ Reply-Kontext aus Gruppen-Chat (persönliche Antwort per DM)
if (_initialReplyFrom && _initialReplyText) {
  showReplyBar(null, _initialReplyFrom, _initialReplyText);
}

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

  // Phase 3 #2: Background-Retry für Local-Only-Fallback (Authority offline/gelöscht).
  // Wenn fallbackBootstrap im Local-Only-Modus gelaufen ist, läuft hier alle 60s eine
  // Prüfung: kommen die Inbox-Keys der Authority zurück, wird ein Full-Fallback ausgelöst,
  // der den CMK via KV an die Authority weitergibt.
  const sid = `dm:${[localStorage.getItem("my_user"), withUser].sort().join(":")}`;
  if (sessionStorage.getItem(`fallback_local_only:${sid}`)) {
    console.log("🔁 Local-Only-Fallback erkannt — schnelle Retries 3s/8s/20s, dann alle 60s");
    // UX-Hint: User informieren, dass Authority offline ist
    const authorityOfflineHint = (lang.authorityOfflineHint
      || "⚠️ {peer} is currently unreachable. Your messages will be delivered when {peer} comes back online.").replace(/\{peer\}/g, withUser);
    showSystemMessage(authorityOfflineHint);

    // Schnelle Retry-Schwelle: 3s / 8s / 20s (deckt Network-Race ab in dem Authority
    // beim ersten /chat/keys/get noch nicht antwortet aber gleich danach schon).
    // Anna's ensureSecureDmSession gibt nach ~15s auf — wir müssen also INNERHALB
    // dieses Fensters den CMK in KV haben.
    const tryFullFallback = async () => {
      if (!sessionStorage.getItem(`fallback_local_only:${sid}`)) return false;
      const me = localStorage.getItem("my_user");
      try {
        const peerDevs = await fetchInboxKeys(withUser, { forceFresh: true });
        if (Array.isArray(peerDevs) && peerDevs.length > 0) {
          console.log("🔄 Authority wieder erreichbar — Full-Fallback wird ausgelöst");
          sessionStorage.removeItem(`fallback_bootstrapped:${sid}`);
          await fallbackBootstrap(me, withUser, (h, o) => fetchInboxKeys(h, { forceFresh: true, ...(o || {}) }), apiFetch);
          return !sessionStorage.getItem(`fallback_local_only:${sid}`);  // true = success
        }
      } catch (e) {
        console.warn("⚠️ Local-Only-Retry-Versuch fehlgeschlagen (non-fatal)", e);
      }
      return false;
    };

    // Schneller Retry-Trigger: 3s → 8s → 20s → dann 60s als Backup
    setTimeout(async () => {
      const ok1 = await tryFullFallback();
      if (ok1) return;
      setTimeout(async () => {
        const ok2 = await tryFullFallback();
        if (ok2) return;
        setTimeout(async () => {
          const ok3 = await tryFullFallback();
          if (ok3) return;
          // Nach 3 schnellen Retries: 60s-Interval als Backup
          const localOnlyRetryInterval = setInterval(async () => {
            if (!sessionStorage.getItem(`fallback_local_only:${sid}`)) {
              clearInterval(localOnlyRetryInterval);
              console.log("✅ Local-Only-Retry beendet — Authority erreichbar oder Chat geschlossen");
              return;
            }
            await tryFullFallback();
          }, 60_000);
        }, 20_000);
      }, 8_000);
    }, 3_000);
  }
}

// WebSocket liefert neue Messages via NEW_MESSAGE Event

} catch (startupError) {
  console.error("💥 Chat Startup fehlgeschlagen:", startupError);
  // Recovery-UI: sichtbare Fehlermeldung statt schwarzer Bildschirm
  const el = document.getElementById("messages") || document.body;
  const errDiv = document.createElement("div");
  errDiv.style.cssText = "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:32px 20px;text-align:center;height:100%;";
  const errIcon = document.createElement("div");
  errIcon.style.cssText = "font-size:40px;";
  errIcon.textContent = "⚠️";
  const errText = document.createElement("div");
  errText.style.cssText = "font-size:14px;color:var(--text-secondary);max-width:280px;line-height:1.5;";
  errText.textContent = lang?.chatStartupError || "Chat could not be loaded. Please reload the page.";
  const errBtn = document.createElement("button");
  errBtn.style.cssText = "padding:10px 24px;border-radius:8px;border:none;background:var(--accent,#38BDF8);color:#fff;font-size:14px;font-weight:600;cursor:pointer;";
  errBtn.textContent = lang?.reloadBtn || "Reload";
  errBtn.addEventListener("click", () => location.reload());
  errDiv.append(errIcon, errText, errBtn);
  el.innerHTML = "";
  el.appendChild(errDiv);
}
})();



