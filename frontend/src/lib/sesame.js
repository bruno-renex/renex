// ======================================================
// Sesame-Core: Recipient-Set-Manager (Migration M1)
// ======================================================
// Liefert die aktuelle Geräte-Menge eines Peers (welche Devices, mit/ohne
// ML-KEM, welche caps) über GET /e2e/devset, gen-gecacht. Die per-(peer,device)-
// SESSION-Schicht (SessionRecord / ensureHybridSession) kommt in P2/P3 obendrauf
// — Sesame liefert nur, WELCHE (peer,device)-Sessions existieren.
//
// gen-Caching: der Server bumpt `gen` bei jeder Recipient-Set-Änderung (neuer
// KEM-Key / neues Device). Ein `device_added`-Push trägt den neuen gen → onDevsetGen
// invalidiert den Cache, sonst greift eine kurze TTL.
// ======================================================
import { apiFetch } from './api.js';

const _cache = new Map();   // peer → { gen, devices, ts }
const TTL_MS = 60_000;

/**
 * Aktuelle Recipient-Devices eines Peers: [{deviceId, hasKem, caps}].
 * @param {string} peer
 * @param {{force?: boolean}} [opts]
 */
export async function getRecipientDevices(peer, { force = false } = {}) {
  const p = String(peer || '').toLowerCase();
  if (!p) return [];
  const c = _cache.get(p);
  if (!force && c && (Date.now() - c.ts) < TTL_MS) return c.devices;

  const r = await apiFetch(`/e2e/devset?user=${encodeURIComponent(p)}`);
  if (!r || !r.ok || !r.data) return c?.devices || [];
  const devices = Array.isArray(r.data.devices) ? r.data.devices : [];
  _cache.set(p, { gen: typeof r.data.gen === 'number' ? r.data.gen : 0, devices, ts: Date.now() });
  return devices;
}

/** Nur die Devices, die bereits einen ML-KEM-Prekey haben (hybrid-fähig). */
export async function getPqCapableDevices(peer, opts) {
  return (await getRecipientDevices(peer, opts)).filter(d => d.hasKem);
}

/**
 * Auf `device_added`-Push (trägt `from` + `gen`) aufrufen: invalidiert den Cache,
 * wenn der gemeldete gen neuer ist als der gecachte → nächster Fetch ist frisch.
 */
export function onDevsetGen(peer, gen) {
  const p = String(peer || '').toLowerCase();
  const c = _cache.get(p);
  if (!c || (typeof gen === 'number' && gen > c.gen)) _cache.delete(p);
}

/** Cache gezielt/global leeren (z.B. bei Logout). */
export function invalidateRecipientCache(peer) {
  if (peer) _cache.delete(String(peer).toLowerCase());
  else _cache.clear();
}
