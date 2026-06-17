// ======================================================
// RateLimiterDO — atomarer Rate-Limiter via Durable Object (M2)
// ======================================================
// Ersetzt die nicht-atomare KV-read-then-write-Zählung in `rateLimit()`
// (auth.js) für die abuse-kritischen Buckets (login/register/recovery).
// Ein DO pro Rate-Limit-Key (via idFromName) serialisiert die
// Read-Modify-Write-Operation → harter Cut bei `limit`, kein Burst-Overshoot.
//
// KV bleibt für alle anderen Buckets (auth.js `rateLimit()` ohne {strict}).
// Quelle/Plan: docs/BACKLOG_PHASE3A.md (Item M2).
// ======================================================

/**
 * Pure, deterministische Kern-Logik des Limiters — in Node testbar (der DO
 * selbst läuft nur im Workers-Runtime, daher Logik hier isoliert).
 *
 * @param {{bucket:number,count:number}|null} state - gespeicherter Zustand
 * @param {number} now      - Date.now()
 * @param {number} windowMs - Fenstergröße in ms
 * @param {number} limit    - max. erlaubte Anfragen pro Fenster
 * @returns {{allow:boolean, state:{bucket:number,count:number}}}
 */
export function rateLimitDecision(state, now, windowMs, limit) {
  // Bucket monoton halten: ein Rückwärts-Sprung der Wall-Clock darf den Zähler
  // nicht in ein früheres Fenster zurücksetzen (Review-Finding #11).
  const bucket = Math.max(Math.floor(now / windowMs), state ? state.bucket : 0);
  // Fenster gewechselt → Zähler zurücksetzen.
  const count = (state && state.bucket === bucket) ? state.count : 0;
  if (count >= limit) {
    return { allow: false, state: { bucket, count } };
  }
  return { allow: true, state: { bucket, count: count + 1 } };
}

export class RateLimiterDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const windowMs = Number(url.searchParams.get("w"));
    const limit = Number(url.searchParams.get("l"));
    if (!windowMs || !Number.isFinite(limit) || limit < 0) {
      return new Response(JSON.stringify({ error: "bad_params" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Atomar: ein DO ist single-threaded und die Storage-Input-Gates
    // serialisieren read→write — keine zwei Requests sehen denselben Zähler
    // (Cloudflares dokumentiertes Atomic-Counter-Pattern).
    const prev = await this.state.storage.get("rl");
    const { allow, state } = rateLimitDecision(prev || null, Date.now(), windowMs, limit);
    if (allow) {
      await this.state.storage.put("rl", state);
    }
    // Cleanup-Alarm bei JEDER Entscheidung (auch deny) neu setzen — sonst plant
    // ein Key unter Dauer-Deny nie Cleanup und der Zähler bleibt liegen (Finding #4).
    try { await this.state.storage.setAlarm(Date.now() + 2 * windowMs); } catch {}

    return new Response(JSON.stringify({ allow }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Aufräum-Alarm: veralteten Zähler löschen → DO evictet danach (kein
  // unbegrenztes Storage-Wachstum bei Per-IP-Keys).
  async alarm() {
    try {
      await this.state.storage.deleteAll();
    } catch (e) {
      console.error("rl alarm cleanup failed:", e?.message);
    }
  }
}
