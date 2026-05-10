// ======================================================
// Presence Store — Live Online/Offline-Status pro Kontakt
// ======================================================
// Backend: GET /presence?handles=alice,bob,...  (presenceRoutes.js)
//   → { alice: { online: true, ts }, bob: { online: false, lastSeen } }
//
// Backend setzt KV `presence:<handle>` via WebSocket-DO _setOnline/_setOffline
// (auth.js). Online-TTL ist 5min, Offline 7d.
//
// Backend broadcastet KEINE WS-Events bei Status-Change → Frontend pollt
// alle POLL_MS aus dem inboxStore.contacts. Pragmatisch für Beta — sauberer
// wäre Backend-WS-Broadcast (Follow-Up wenn Performance-Issues).
//
// API:
//   presenceStore.isOnline(handle) → boolean
//   presenceStore.lastSeenFor(handle) → number|null (epoch ms)
//   presenceStore.refreshNow(handles?) → Promise<void>
//   presenceStore.startPolling(getHandles) / stopPolling()
//   presenceStore.clear()
// ======================================================
import { apiFetch } from '../lib/api.js';
import { captureException } from './../lib/sentry.js';

const POLL_MS = 30_000;
// Frontend-Heartbeat pingt alle 25s → Backend refresht presence-KV bei jedem ping.
// 120s deckt komfortabel ~5 Ping-Cycles ab (verträgt 1-2 verpasste Pings ohne Flackern).
// KV-TTL ist 5min, also auch eine sichere Untergrenze gegen falsche "online"-Anzeigen.
const ONLINE_GRACE_MS = 120_000;

// _status[handle] = { online: bool, ts?, lastSeen? }
let _status = $state({});
let _pollTimer = null;
let _getHandles = null;

async function _fetchPresence(handles) {
  const list = (handles || []).filter(h => typeof h === 'string' && h.length > 0);
  if (list.length === 0) return;
  // Backend-Cap: 50 Handles pro Request — chunked falls mehr.
  const chunks = [];
  for (let i = 0; i < list.length; i += 50) chunks.push(list.slice(i, i + 50));
  try {
    const merged = {};
    for (const chunk of chunks) {
      const r = await apiFetch(`/presence?handles=${encodeURIComponent(chunk.join(','))}`);
      if (r.ok && r.data && typeof r.data === 'object') {
        for (const [h, v] of Object.entries(r.data)) merged[h] = v;
      }
    }
    if (Object.keys(merged).length > 0) {
      _status = { ..._status, ...merged };
    }
  } catch (e) {
    captureException(e, { context: 'presence.fetch' });
  }
}

export const presenceStore = {
  get status() { return _status; },

  /** Liefert true wenn online + ts noch innerhalb der Grace-Period. */
  isOnline(handle) {
    if (!handle) return false;
    const s = _status[handle];
    if (!s || !s.online) return false;
    if (typeof s.ts === 'number' && Date.now() - s.ts > ONLINE_GRACE_MS) return false;
    return true;
  },

  /** Letzter bekannter Offline-Zeitpunkt (für „zuletzt gesehen"-Anzeige). */
  lastSeenFor(handle) {
    if (!handle) return null;
    const s = _status[handle];
    return s && typeof s.lastSeen === 'number' ? s.lastSeen : null;
  },

  /** Einmalig refreshen (z.B. beim Chat-Open für sofortigen Status). */
  async refreshNow(handles) {
    const h = Array.isArray(handles) ? handles : (_getHandles ? _getHandles() : []);
    await _fetchPresence(h);
  },

  /**
   * Startet das Polling. `getHandles` ist eine Function die jedes Tick die
   * aktuelle Handle-Liste liefert (typisch: () => inboxStore.contacts.map(c => c.handle)).
   */
  startPolling(getHandles) {
    if (typeof getHandles !== 'function') return;
    _getHandles = getHandles;
    if (_pollTimer) clearInterval(_pollTimer);
    // Sofort erstes Fetch + dann periodisch
    void _fetchPresence(getHandles());
    _pollTimer = setInterval(() => {
      void _fetchPresence(getHandles());
    }, POLL_MS);
  },

  stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    _getHandles = null;
  },

  clear() {
    this.stopPolling();
    _status = {};
  },
};
