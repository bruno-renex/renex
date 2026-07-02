// ======================================================
// PQXDH Bundle-Publishing + OPK-Topup (Client-Hook) — Migration M2
// ======================================================
// Dark-Launch PUBLISH-ONLY (Bauplan §4.3): publiziert das eigene Prekey-Bundle
// nach Login (analog M1 kemEk in e2eKeys.uploadInboxKeyIfNeeded) und füllt den
// Server-OPK-Pool nach, wenn er zur Neige geht.
//
// Fresh-ID-Disziplin (Gegenstück zum Server-Tombstone): beim Topup werden NUR
// frisch erzeugte OPKs hochgeladen (pqxdhKeys.topUpOpks) — eine bereits
// konsumierte opk_id wird nie erneut publiziert. Zusammen mit dem Tombstone
// (Re-Insert läuft in UNIQUE-Konflikt) ist die OPK-Reuse-Kante damit auf
// BEIDEN Seiten zu.
//
// Best-effort: wirft nie in den Login-Flow (try/catch + log), Server-Fehler
// sind non-fatal. Guests publizieren nicht (Server verlangt requireSession).
// ======================================================
import { apiFetch } from './api.js';
import { idbGet, idbSet } from './idb.js';
import { bytesToB64 } from './bytes.js';
import { buildPublishBundle, topUpOpks } from './pqxdhKeys.js';

const OPK_TARGET = 100;      // Soll-Poolgröße auf dem Server (= Upload-Max)
const OPK_LOW_WATER = 20;    // darunter → Topup
const MARKER_PREFIX = 'pqxdh:published:';   // IDB-Marker pro Device

/**
 * Publiziert das PQXDH-Bundle dieses Geräts, falls (a) noch nie publiziert
 * oder (b) SPK/PQSPK rotiert; sonst prüft es den Server-OPK-Count und lädt
 * bei Low-Water NUR frische OPKs nach.
 *
 * @param {{handle?:string, deviceId?:string}} [ids] — injizierbar (Tests);
 *        Default: localStorage `my_user` / `device_id:<handle>` (Muster e2eKeys.getDeviceId).
 * @returns {Promise<{ok:boolean, action:'published'|'topup'|'noop'|'skipped', opks?:number}>}
 */
export async function publishPqxdhBundleIfNeeded(ids = {}) {
  try {
    const handle = String(
      ids.handle
      ?? (typeof localStorage !== 'undefined' ? localStorage.getItem('my_user') : '')
      ?? ''
    ).toLowerCase();
    const deviceId = ids.deviceId
      ?? (typeof localStorage !== 'undefined' && handle
            ? localStorage.getItem(`device_id:${handle}`) : null);
    if (!handle || !deviceId) {
      return { ok: false, action: 'skipped' };   // vor Login / kein Device
    }

    const markerKey = MARKER_PREFIX + deviceId;
    const marker = await idbGet(markerKey);

    // ── Erst-Publish ODER SPK/PQSPK-Rotation → volles Bundle hochladen ──
    const bundle = await buildPublishBundle({ opkCount: OPK_TARGET });
    const fingerprint = `${bundle.spk.spkId}:${bundle.pqspk.pqspkId}`;
    if (!marker || marker.fingerprint !== fingerprint) {
      // ⚠️ Cap auf die NEUESTEN OPK_TARGET: nach Topups liegen lokal >100 Privs
      // (alte konsumierte-aber-unverbrauchte bleiben liegen) — der Server-
      // Validator lehnt >100 als bad_opks ab. Neueste zuletzt (Insertion-Order),
      // ältere sind am wahrscheinlichsten schon konsumiert (Tombstone ignoriert
      // sie eh). INSERT OR IGNORE macht Überschneidungen harmlos.
      const opks = bundle.opks.slice(-OPK_TARGET);
      const res = await apiFetch('/e2e/pqxdh/upload', {
        method: 'POST',
        body: { deviceId, ...bundle, opks },
      });
      if (!res.ok) {
        console.warn('🔑 pqxdh publish fehlgeschlagen (non-fatal):', res.status, res.error);
        return { ok: false, action: 'published' };
      }
      await idbSet(markerKey, { fingerprint, at: Date.now() });
      console.log(`🔑 pqxdh Bundle publiziert (${opks.length} OPKs) — ${handle}:${deviceId}`);
      return { ok: true, action: 'published', opks: opks.length };
    }

    // ── Schon publiziert → Server-Count prüfen, bei Low-Water Fresh-Topup ──
    const cnt = await apiFetch(
      `/e2e/pqxdh/opk-count?user=${encodeURIComponent(handle)}&device=${encodeURIComponent(deviceId)}`
    );
    if (!cnt.ok) return { ok: false, action: 'noop' };
    const remaining = Number(cnt.data?.count) || 0;
    if (remaining >= OPK_LOW_WATER) return { ok: true, action: 'noop' };

    const { added } = await topUpOpks(Math.min(OPK_TARGET - remaining, OPK_TARGET));
    const res = await apiFetch('/e2e/pqxdh/upload', {
      method: 'POST',
      body: {
        deviceId,
        ik: bundle.ik, spk: bundle.spk, pqspk: bundle.pqspk,   // Pflichtfelder (Validator); KV-Overwrite identisch
        opks: added.map(o => ({ opkId: o.opkId, opk: bytesToB64(o.pub) })),
      },
    });
    if (!res.ok) {
      console.warn('🔑 pqxdh OPK-Topup fehlgeschlagen (non-fatal):', res.status, res.error);
      return { ok: false, action: 'topup' };
    }
    console.log(`🔑 pqxdh OPK-Topup: +${added.length} (Server hatte ${remaining}) — ${handle}:${deviceId}`);
    return { ok: true, action: 'topup', opks: added.length };
  } catch (e) {
    console.warn('🔑 pqxdh publish übersprungen (non-fatal):', e?.message);
    return { ok: false, action: 'skipped' };
  }
}
