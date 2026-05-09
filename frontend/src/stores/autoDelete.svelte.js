// ======================================================
// Auto-Delete Store — Setting pro Konversation
// ======================================================
// Backend:
//   DM:    GET/POST /chat/auto-delete (Konsens-Modell propose/accept/decline/cancel)
//   Group: GET/POST /groups/auto-delete (Last-Write-Wins, jedes Mitglied darf)
//
// Werte: 0 = Aus, 1 = 24h, 7 = 7 Tage, 30 = 30 Tage
//
// Reaktion auf Control-Message `auto_delete_set` läuft via App-Level WS-Listener
// (siehe App.svelte) → autoDeleteStore.applyControl().
// ======================================================
import { apiFetch } from '../lib/api.js';
import { userStore } from './user.svelte.js';
import { captureException } from '../lib/sentry.js';
import { chatToConvoId } from './notifications.svelte.js';
import { chatStore } from './chat.svelte.js';
import { i18nStore } from './i18n.svelte.js';

// settings[convoId] = { days, status, proposedBy, originalDays, type: 'dm'|'group' }
let _settings = $state({});

export const ALLOWED_DAYS = [0, 1, 7, 30];

export function autoDeleteLabel(days, lang) {
  if (!days) return lang?.autoDeleteOff || 'Aus';
  if (days === 1)  return lang?.autoDeleteOneDay      || '24h';
  if (days === 7)  return lang?.autoDeleteOneWeek     || '7 Tage';
  if (days === 30) return lang?.autoDeleteThirtyDays  || '30 Tage';
  return `${days}d`;
}

export const autoDeleteStore = {
  get settings() { return _settings; },

  /** Liefert das aktuelle Setting für einen Chat (lokaler Cache). */
  getFor(chat) {
    const cid = chatToConvoId(chat);
    if (!cid) return null;
    return _settings[cid] || null;
  },

  /** Lädt das aktuelle Setting vom Backend (DM oder Group). */
  async loadFor(chat) {
    const cid = chatToConvoId(chat);
    if (!cid) return null;
    try {
      let r;
      if (chat.type === 'group') {
        r = await apiFetch(`/groups/auto-delete?groupId=${encodeURIComponent(cid)}`);
      } else {
        const peer = chat.peer || chat.key;
        r = await apiFetch(`/chat/auto-delete?peer=${encodeURIComponent(peer)}`);
      }
      if (!r.ok) return null;
      const d = r.data || {};
      _settings = {
        ..._settings,
        [cid]: {
          days: d.days ?? 0,
          status: d.status || 'off',
          proposedBy: d.proposed_by || null,
          originalDays: d.original_days ?? null,
          type: chat.type,
          myRole: d.myRole || null,
        },
      };
      return _settings[cid];
    } catch (e) {
      captureException(e, { context: 'autoDelete.loadFor' });
      return null;
    }
  },

  /**
   * DM: Vorschlag senden (status=pending, Peer bekommt Toast zum Akzeptieren).
   * Group: direkt setzen (Last-Write-Wins, alle Mitglieder bekommen System-Bubble).
   */
  async set(chat, days) {
    const cid = chatToConvoId(chat);
    if (!cid) return { ok: false, error: 'no_convoid' };

    try {
      let r;
      if (chat.type === 'group') {
        r = await apiFetch('/groups/auto-delete', {
          method: 'POST',
          body: { groupId: cid, days: days || 0 },
        });
      } else {
        const peer = chat.peer || chat.key;
        r = await apiFetch('/chat/auto-delete', {
          method: 'POST',
          body: { peer, action: 'propose', days: days || 0 },
        });
      }
      if (!r.ok) return { ok: false, error: r.error || 'failed' };

      // Local update
      const me = userStore.myUser;
      if (chat.type === 'group') {
        _settings = {
          ..._settings,
          [cid]: {
            days: days || 0,
            status: days ? 'active' : 'off',
            proposedBy: me,
            originalDays: null,
            type: 'group',
            myRole: _settings[cid]?.myRole || 'member',
          },
        };
        // Optimistische System-Bubble für den Setzenden — analog Group-Rename.
        // Toast wird vom UI-Caller (ChatHeaderMenu) gepusht; hier KEIN Toast,
        // sonst Doppel-Anzeige. WS-Echo skipt Self via msg.from !== me.
        // Backend persistiert dieselbe Info als deutsche D1-Message für Reload.
        const lng = i18nStore.lang;
        const text = days
          ? `${me} ${(lng.autoDeleteSetByPeer || 'hat Auto-Delete gesetzt:')} ${autoDeleteLabel(days, lng)}`
          : `${me} ${(lng.autoDeleteDisabledByPeer || 'hat Auto-Delete deaktiviert.')}`;
        chatStore.appendLocalSystemMessage(cid, text, Date.now());
      } else {
        _settings = {
          ..._settings,
          [cid]: {
            days: days || 0,
            status: r.data?.status || 'pending',
            proposedBy: me,
            originalDays: _settings[cid]?.days || null,
            type: 'dm',
          },
        };
      }
      return { ok: true };
    } catch (e) {
      captureException(e, { context: 'autoDelete.set' });
      return { ok: false, error: e.message };
    }
  },

  /** DM: Vorschlag des Peers akzeptieren. */
  async accept(chat) {
    const peer = chat.peer || chat.key;
    if (!peer) return { ok: false };
    const cid = chatToConvoId(chat);
    try {
      const r = await apiFetch('/chat/auto-delete', {
        method: 'POST',
        body: { peer, action: 'accept' },
      });
      if (!r.ok) return { ok: false, error: r.error };
      const newDays = r.data?.days || 0;
      const newStatus = r.data?.status === 'active' ? 'active' : 'off';
      const proposer = _settings[cid]?.proposedBy || peer;
      _settings = {
        ..._settings,
        [cid]: {
          ..._settings[cid],
          status: newStatus,
          days: newDays,
          originalDays: null,
        },
      };
      // Optimistische System-Bubble: aus Konsens-Sicht hat der Vorschlagende
      // (proposer) Auto-Delete „gesetzt"/„deaktiviert", egal wer akzeptiert hat.
      // Konsistent zu autoDeleteRoutes.js (D1-Message-Text).
      const lng = i18nStore.lang;
      const text = newDays > 0
        ? `${proposer} ${(lng.autoDeleteSetByPeer || 'hat Auto-Delete gesetzt:')} ${autoDeleteLabel(newDays, lng)}`
        : `${proposer} ${(lng.autoDeleteDisabledByPeer || 'hat Auto-Delete deaktiviert.')}`;
      chatStore.appendLocalSystemMessage(cid, text, Date.now());
      return { ok: true };
    } catch (e) {
      captureException(e, { context: 'autoDelete.accept' });
      return { ok: false, error: e.message };
    }
  },

  /** DM: Vorschlag des Peers ablehnen — bei vorhandenem original_days zurücksetzen. */
  async decline(chat) {
    const peer = chat.peer || chat.key;
    if (!peer) return { ok: false };
    const cid = chatToConvoId(chat);
    try {
      const r = await apiFetch('/chat/auto-delete', {
        method: 'POST',
        body: { peer, action: 'decline' },
      });
      if (!r.ok) return { ok: false, error: r.error };
      const orig = r.data?.original_days;
      _settings = {
        ..._settings,
        [cid]: orig
          ? { ..._settings[cid], status: 'active', days: orig, originalDays: null }
          : { ..._settings[cid], status: 'off', days: 0, originalDays: null },
      };
      return { ok: true };
    } catch (e) {
      captureException(e, { context: 'autoDelete.decline' });
      return { ok: false, error: e.message };
    }
  },

  /** Eingehende Control-Message vom Peer/Group anwenden (App.svelte WS-Hook). */
  applyControl(msg) {
    const cid = msg.groupId || (msg.from && userStore.myUser
      ? [msg.from, userStore.myUser].sort().join(':')
      : null);
    if (!cid) return;
    const isGroup = !!msg.groupId;

    if (msg.action === 'propose') {
      _settings = {
        ..._settings,
        [cid]: {
          days: msg.days || 0,
          status: 'pending',
          proposedBy: msg.from,
          originalDays: _settings[cid]?.days || null,
          type: 'dm',
        },
      };
    } else if (msg.action === 'accept') {
      _settings = {
        ..._settings,
        [cid]: {
          ..._settings[cid],
          days: msg.days || 0,
          status: msg.days ? 'active' : 'off',
          proposedBy: msg.from || _settings[cid]?.proposedBy,
          originalDays: null,
          type: isGroup ? 'group' : 'dm',
        },
      };
    } else if (msg.action === 'decline' || msg.action === 'cancel') {
      const orig = msg.original_days;
      _settings = {
        ..._settings,
        [cid]: orig
          ? { ..._settings[cid], status: 'active', days: orig, originalDays: null }
          : { ..._settings[cid], status: 'off', days: 0, originalDays: null, type: isGroup ? 'group' : 'dm' },
      };
    }
  },

  clear() { _settings = {}; },
};
