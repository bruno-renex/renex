// ======================================================
// CONTEXT MENU, REACTIONS, REPLY BAR
// ======================================================
import { apiFetch } from "./api.js";
import lang from "./i18n.js";
import { REACTION_EMOJIS } from "./chatState.js";
import { guestDisplayName } from "./shared/guestUtils.js";

// Module-private state
let _ctxMenu = null;
let _replyState = null;
const reactionsCache = new Map();

// External deps (set via setup)
let _getMyUser, _startInlineEdit, _deleteMessage;

export function setup({ getMyUser, startInlineEdit, deleteMessage }) {
  _getMyUser = getMyUser;
  _startInlineEdit = startInlineEdit;
  _deleteMessage = deleteMessage;
}

export function getReplyState() { return _replyState; }
export { reactionsCache };

// ── Reply Bar ────────────────────────────────────────
const replyBar       = document.getElementById("reply-bar");
const replyBarFrom   = document.getElementById("reply-bar-from");
const replyBarText   = document.getElementById("reply-bar-text");
const replyBarCancel = document.getElementById("reply-bar-cancel");

export function showReplyBar(id, from, plaintext) {
  _replyState = { id, from, plaintext };
  // Guest-Handle → lesbarer Display-Name (z.B. "Guest Silver Cobra")
  if (replyBarFrom) replyBarFrom.textContent = guestDisplayName(from) + ": ";
  if (replyBarText) replyBarText.textContent = plaintext.slice(0, 80) + (plaintext.length > 80 ? "…" : "");
  replyBar?.classList.add("visible");
  document.getElementById("msg-input")?.focus();
}

export function clearReplyBar() {
  _replyState = null;
  replyBar?.classList.remove("visible");
  if (replyBarFrom) replyBarFrom.textContent = "";
  if (replyBarText) replyBarText.textContent = "";
}

replyBarCancel?.addEventListener("click", clearReplyBar);

// ── Reactions ────────────────────────────────────────

export function renderReactionBar(div, messageId) {
  let bar = div.querySelector(".reaction-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "reaction-bar";
    const ts = div.querySelector(".timestamp");
    if (ts) ts.after(bar); else div.appendChild(bar);
  }
  bar.innerHTML = "";
  const data = reactionsCache.get(messageId) || {};
  const me = _getMyUser();
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

export async function sendReaction(messageId, emoji, div) {
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

// ── Context Menu ─────────────────────────────────────

export function closeContextMenu() {
  if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
}

// Globale Close-Listener: nur schliessen wenn der Click AUSSERHALB des
// Menüs stattfand. Ohne diesen Check konnte ein Tap auf ein Menü-Item
// (z.B. "Löschen") das Menü entfernen BEVOR der Item-Handler ausgeführt
// wurde — typisches iOS-PWA-Verhalten mit Pointer-Events.
document.addEventListener("click", (e) => {
  if (_ctxMenu && !_ctxMenu.contains(e.target)) closeContextMenu();
});
document.addEventListener("scroll", closeContextMenu, { passive: true });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeContextMenu(); });

export function showContextMenu(div, { id, from, textEl, ts }) {
  closeContextMenu();
  const isOwn = from === _getMyUser();
  const EDIT_MS = 15 * 60 * 1000;
  const canEdit = isOwn && ts && Date.now() - Number(ts) < EDIT_MS;
  const canReact = !isOwn && !!id;
  const canReply = !!id;
  const canDelete = isOwn && id;

  const menu = document.createElement("div");
  menu.id = "msg-context-menu";
  _ctxMenu = menu;

  // Helper: attach tap/click to menu items. Mobile PWAs verschlucken manchmal
  // normale click-Events wenn auf non-button Divs — daher pointerup als Primär-Trigger.
  const attachTap = (el, handler) => {
    let _handled = false;
    const fire = (e) => {
      if (_handled) return;
      _handled = true;
      e.preventDefault();
      e.stopPropagation();
      try { handler(e); } catch (err) { console.error("[ctx] handler error:", err); }
    };
    el.addEventListener("click", fire);
    // Fallback für Mobile: pointerup feuert auch wenn click verschluckt wird
    el.addEventListener("pointerup", (e) => {
      // nur Primärtaste / Touch
      if (e.button !== undefined && e.button !== 0) return;
      fire(e);
    });
  };

  if (canReact) {
    const emojiRow = document.createElement("div");
    emojiRow.className = "ctx-emoji-row";
    const myReactions = (reactionsCache.get(id) || {});
    REACTION_EMOJIS.forEach(emoji => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ctx-emoji-btn";
      const handles = myReactions[emoji] || [];
      if (handles.includes(_getMyUser())) btn.classList.add("active");
      btn.textContent = emoji;
      attachTap(btn, async () => {
        console.log("[ctx] emoji tap:", emoji, "for msg:", id);
        closeContextMenu();
        try {
          const res = await apiFetch("/chat/react", {
            method: "POST",
            body: JSON.stringify({ messageId: id, emoji })
          });
          if (res?.reactions) { reactionsCache.set(id, res.reactions); renderReactionBar(div, id); }
        } catch (err) { console.warn("React failed", err); }
      });
      emojiRow.appendChild(btn);
    });
    menu.appendChild(emojiRow);
  }

  if (canReply) {
    const replyItem = document.createElement("div");
    replyItem.className = "ctx-item";
    replyItem.setAttribute("role", "button");
    replyItem.setAttribute("tabindex", "0");
    replyItem.innerHTML = '<span class="ctx-item-icon">↩️</span> Antworten';
    attachTap(replyItem, () => {
      console.log("[ctx] reply tap for msg:", id);
      closeContextMenu();
      showReplyBar(id, from, textEl?.textContent || "");
    });
    menu.appendChild(replyItem);
  }

  if (canEdit) {
    const editItem = document.createElement("div");
    editItem.className = "ctx-item";
    editItem.setAttribute("role", "button");
    editItem.setAttribute("tabindex", "0");
    editItem.innerHTML = '<span class="ctx-item-icon">✏️</span> Bearbeiten';
    attachTap(editItem, () => {
      console.log("[ctx] edit tap for msg:", id);
      closeContextMenu();
      if (typeof _startInlineEdit !== "function") {
        console.error("[ctx] _startInlineEdit is not a function:", _startInlineEdit);
        return;
      }
      _startInlineEdit(div, id, textEl?.textContent || "");
    });
    menu.appendChild(editItem);
  }

  if (canDelete) {
    if (canReply || canEdit) {
      const divider = document.createElement("div");
      divider.className = "ctx-divider";
      menu.appendChild(divider);
    }
    const delItem = document.createElement("div");
    delItem.className = "ctx-item danger";
    delItem.setAttribute("role", "button");
    delItem.setAttribute("tabindex", "0");
    delItem.innerHTML = '<span class="ctx-item-icon">🗑️</span> Löschen';
    attachTap(delItem, () => {
      console.log("[ctx] delete tap for msg:", id);
      closeContextMenu();
      if (typeof _deleteMessage !== "function") {
        console.error("[ctx] _deleteMessage is not a function:", _deleteMessage);
        return;
      }
      const msg = lang.confirmDeleteMessage || "Delete this message?";
      if (window.confirm(msg)) _deleteMessage(id);
    });
    menu.appendChild(delItem);
  }

  if (!menu.children.length) return;

  document.body.appendChild(menu);

  const rect = div.getBoundingClientRect();
  const mw = menu.offsetWidth || 180;
  const mh = menu.offsetHeight || 160;
  let x = isOwn ? rect.right - mw : rect.left;
  let y = rect.top - mh - 6;
  if (y < 8) y = rect.bottom + 6;
  if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
  if (x < 8) x = 8;
  menu.style.left = x + "px";
  menu.style.top  = y + "px";
}

function getLiveOpts(div, opts) {
  const liveTextEl = div.querySelector(".msg-text") || opts.textEl;
  return { ...opts, textEl: liveTextEl };
}

export function attachContextMenu(div, opts) {
  let longPressTimer = null;
  let _didScroll = false;
  // Verhindert dass synthesized Click nach Long-Press das Menü nochmals öffnet
  let _longPressOpened = false;

  div.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.pointerType === "mouse") return;
    _didScroll = false;
    _longPressOpened = false;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      if (!_didScroll) {
        _longPressOpened = true;
        showContextMenu(div, getLiveOpts(div, opts));
      }
    }, 500);
  }, { passive: true });

  div.addEventListener("pointerup",    () => { clearTimeout(longPressTimer); longPressTimer = null; });
  div.addEventListener("pointercancel",() => { clearTimeout(longPressTimer); longPressTimer = null; });
  div.addEventListener("pointermove",  (e) => {
    if (Math.abs(e.movementX) > 5 || Math.abs(e.movementY) > 5) {
      _didScroll = true;
      clearTimeout(longPressTimer); longPressTimer = null;
    }
  }, { passive: true });

  div.addEventListener("click", (e) => {
    if (e.target.closest(".sender-name")) return;
    if (e.target.closest(".reaction-pill")) return;
    if (e.target.closest(".reply-quote")) return;
    if (e.target.closest(".reaction-bar")) return;
    // Wenn Long-Press das Menü bereits geöffnet hat → diesen synthesized
    // Click ignorieren (sonst würde das Menü geschlossen+neu geöffnet, was
    // auf Mobile zu verlorenen Taps auf Menü-Items führen kann)
    if (_longPressOpened) {
      _longPressOpened = false;
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    showContextMenu(div, getLiveOpts(div, opts));
  });

  div.addEventListener("contextmenu", (e) => { e.preventDefault(); });
}

export function showReactionPicker(div, messageId) {
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
  setTimeout(() => {
    document.addEventListener("click", function close() {
      picker.classList.remove("visible");
      document.removeEventListener("click", close);
    }, { once: true });
  }, 0);
}
