// ======================================================
// PrekeyDO — atomarer One-Time-Prekey-Consume via Durable Object (M2 / PQXDH)
// ======================================================
// Spec: docs/CRYPTO_PQ_SIGNAL_BUILDPLAN.md §4.3 (PHASE 2 — PQXDH-Handshake).
//
// Ein DO pro Ziel-(user,device) via idFromName('pqxdh:'+user+':'+deviceId)
// serialisiert den Consume der One-Time-Prekeys (OPKs) dieses Geräts — analog
// RateLimiterDO (KV-race → atomarer DO). Die OPK-Pubs selbst liegen in D1
// (`pqxdh_opk`, RENEX_DB); der DO pop't GENAU EINEN Eintrag pro Consume via
// `DELETE … RETURNING` und rationiert per-Requester (Cap) gegen Pool-Erschöpfung.
//
// ⚠️ Warum blockConcurrencyWhile statt nur Input-Gate: der D1-Subrequest ist
// KEINE Storage-Operation → das Input-Gate öffnet währenddessen. Der ganze
// kritische Abschnitt (Cap-RMW + D1-Pop) läuft daher in blockConcurrencyWhile
// → kein zweiter Consume läuft dazwischen, keine OPK wird doppelt ausgegeben,
// der Cap-Zähler kann nicht ge-race't werden.
//
// Erschöpfung ist by-design KEIN Fehler: leerer Pool ODER Cap überschritten →
// `opk:null` (Handshake fällt auf SPK-only zurück, bleibt funktionsfähig).
// ======================================================

/**
 * Pure, deterministische Per-Requester-Cap-Logik (sliding bucket) — in Node
 * testbar (der DO selbst läuft nur im Workers-Runtime). Identisches Fenster-
 * Muster wie rateLimitDecision: Bucket monoton (Wall-Clock-Rücksprung darf den
 * Zähler nicht in ein früheres Fenster zurücksetzen).
 *
 * @param {{bucket:number,count:number}|null} state - gespeicherter Zustand
 * @param {number} now      - Date.now()
 * @param {number} windowMs - Fenstergröße in ms
 * @param {number} cap      - max. OPK-Consumes eines Requesters pro Fenster
 * @returns {{allow:boolean, state:{bucket:number,count:number}}}
 */
export function opkCapDecision(state, now, windowMs, cap) {
  const bucket = Math.max(Math.floor(now / windowMs), state ? state.bucket : 0);
  const count = (state && state.bucket === bucket) ? state.count : 0;
  if (count >= cap) {
    return { allow: false, state: { bucket, count } };
  }
  return { allow: true, state: { bucket, count: count + 1 } };
}

function _json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export class PrekeyDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/consume") {
      return _json({ error: "not_found" }, 404);
    }

    let body;
    try { body = await request.json(); } catch { return _json({ error: "bad_json" }, 400); }
    const user = String(body?.user || "").toLowerCase();
    const deviceId = String(body?.deviceId || "");
    const requester = String(body?.requester || "").toLowerCase();
    const windowMs = Number(url.searchParams.get("w"));
    const cap = Number(url.searchParams.get("l"));
    if (!user || !deviceId || !requester || !windowMs || !Number.isFinite(cap) || cap < 0) {
      return _json({ error: "bad_params" }, 400);
    }

    // Ganze Sektion serialisiert → atomar über den D1-Subrequest hinweg.
    const result = await this.state.blockConcurrencyWhile(async () => {
      // 1) Per-Requester-Cap: rationiert OPKs, damit ein einzelner Requester den
      //    Pool nicht leersaugen kann (DoS → sonst alle neuen Handshakes SPK-only).
      const capKey = `cap:${requester}`;
      const prev = await this.state.storage.get(capKey);
      const dec = opkCapDecision(prev || null, Date.now(), windowMs, cap);
      if (!dec.allow) {
        return { opk: null, reason: "capped" };
      }

      // 2) Atomarer Einweg-Consume: genau EINE noch verfügbare OPK-Reihe als
      //    Grabstein markieren (consumed_at) + Pub zurückgeben. TOMBSTONE statt
      //    Hard-DELETE → ein späterer Re-Upload derselben opk_id kann sie NICHT
      //    wiederbeleben (schließt die OPK-Reuse-Kante). D1/SQLite kann kein
      //    `UPDATE … LIMIT` → rowid-Subquery. RETURNING liefert die Pub in einem
      //    Round-Trip. D1-Fehler (z.B. Tabelle vor gegateter Migration) →
      //    graceful SPK-only statt 500.
      let row = null;
      try {
        row = await this.env.RENEX_DB.prepare(
          `UPDATE pqxdh_opk SET consumed_at = ?
             WHERE rowid = (
               SELECT rowid FROM pqxdh_opk
                WHERE user_handle = ? AND device_id = ? AND consumed_at IS NULL
                ORDER BY rowid LIMIT 1
             )
           RETURNING opk_id AS opkId, opk_pub AS opk`
        ).bind(Date.now(), user, deviceId).first();
      } catch (e) {
        console.error("prekey consume D1 error:", e?.message);
        return { opk: null, reason: "error" };
      }

      if (!row || !row.opkId || !row.opk) {
        // Pool leer → SPK-only. Kein Cap-Slot für den No-op verbrauchen.
        return { opk: null, reason: "empty" };
      }

      // Cap-Zähler NUR bei erfolgreichem Pop committen.
      await this.state.storage.put(capKey, dec.state);
      return { opk: { opkId: row.opkId, opk: row.opk }, reason: "ok" };
    });

    // Aufräum-Alarm bei jeder Entscheidung neu setzen → veraltete Cap-Zähler
    // werden gelöscht, der DO evictet danach (kein unbegrenztes Storage-Wachstum).
    try { await this.state.storage.setAlarm(Date.now() + 2 * windowMs); } catch {}

    return _json(result, 200);
  }

  async alarm() {
    try {
      await this.state.storage.deleteAll();
    } catch (e) {
      console.error("prekey alarm cleanup failed:", e?.message);
    }
  }
}
