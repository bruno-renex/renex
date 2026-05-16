// ======================================================
// Notifications Store — Mute-Settings pro Konversation
// ======================================================
// Backend: GET/POST /notifications/mute(d) — siehe src/routes/notificationRoutes.js
// Levels:  'all' | 'mentions_only' | 'mentions_and_everyone' | 'nothing' (= unmute)
// Optional: duration in Minuten → expiresAt in DB; auto-cleanup beim nächsten GET.
// ======================================================
import { apiFetch } from '../lib/api.js';
import { userStore } from './user.svelte.js';
import { captureException } from '../lib/sentry.js';

// muted[convoId] = { level, expiresAt }
let _muted = $state({});
let _loaded = $state(false);

/**
 * Berechnet die Backend-convoId für DM oder Group.
 * - DM:    sort([me, peer]).join(":")
 * - Group: chat.key (UUID)
 */
export function chatToConvoId(chat) {
  if (!chat) return null;
  if (chat.type === 'group' || chat.type === 'channel') return chat.key;
  if (chat.type === 'dm') {
    const me   = userStore.myUser;
    const peer = chat.peer || chat.key;
    if (!me || !peer) return null;
    return [me, peer].sort().join(':');
  }
  return null;
}

export const notificationsStore = {
  get muted()  { return _muted; },
  get loaded() { return _loaded; },

  /** Liest aktuelle Mute-Settings vom Backend (1× beim Bootstrap, dann reaktiv). */
  async load() {
    try {
      const r = await apiFetch('/notifications/muted');
      if (r.ok && Array.isArray(r.data?.muted)) {
        const next = {};
        for (const m of r.data.muted) {
          if (m.convoId) next[m.convoId] = { level: m.level || 'all', expiresAt: m.expiresAt || null };
        }
        _muted = next;
      }
      _loaded = true;
    } catch (e) {
      captureException(e, { context: 'notifications.load' });
    }
  },

  /**
   * Liefert die Mute-Settings für einen Chat oder null wenn nicht stumm.
   * Berücksichtigt auto-expire: wenn expiresAt < now → null (lokal, vor Backend-Refresh).
   */
  getMuteFor(chat) {
    const cid = chatToConvoId(chat);
    if (!cid) return null;
    const m = _muted[cid];
    if (!m) return null;
    if (m.expiresAt && Date.now() > m.expiresAt) return null;
    return m;
  },

  /**
   * Setzt einen Mute-Level für einen Chat.
   * @param {object} chat - chatStore.selectedChat-Objekt
   * @param {'all'|'mentions_only'|'mentions_and_everyone'|'nothing'} level
   * @param {number|null} durationMin - 60/480/1440/null (null = bis manuelles unmute)
   */
  async setMute(chat, level, durationMin = null) {
    const cid = chatToConvoId(chat);
    if (!cid) return { ok: false, error: 'no_convoid' };

    const body = { convoId: cid, level };
    if (durationMin) body.duration = durationMin;

    try {
      const r = await apiFetch('/notifications/mute', { method: 'POST', body });
      if (!r.ok) return { ok: false, error: r.error || 'failed' };

      // Lokal updaten — kein full-reload nötig
      if (level === 'nothing') {
        const next = { ..._muted };
        delete next[cid];
        _muted = next;
      } else {
        _muted = {
          ..._muted,
          [cid]: { level, expiresAt: r.data?.expiresAt || null },
        };
      }
      return { ok: true };
    } catch (e) {
      captureException(e, { context: 'notifications.setMute' });
      return { ok: false, error: e.message };
    }
  },

  /** Reset bei Logout — sonst bleiben Mutes vom alten User in IDB-Cache des Tabs. */
  clear() {
    _muted = {};
    _loaded = false;
  },
};
