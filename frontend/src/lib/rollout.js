// ======================================================
// rollout.js — server-gesteuerte, reversible Rollout-Flags (P3.2 GA)
// ======================================================
// Der Server (GET /e2e/rollout, KV `rollout:flags`) liefert die DEFAULT-
// Aktivierung der v4-Krypto-Schichten (ratchetSend, pqRekey) für ALLE Konten,
// OHNE dass jeder Client per-Device opt-in setzen muss. Global umschaltbar via
// `wrangler kv key put` ohne Redeploy → Kill-Switch greift beim nächsten Poll.
//
// FAIL-SAFE: nie gefetcht / Fehler / kein Cache → alles AUS (Legacy). Ein
// Netzausfall aktiviert NIE versehentlich v4.
// PRÄZEDENZ: explizites per-Device-`localStorage` (Test-Geräte, Opt-out) hat
// IMMER Vorrang vor dem Rollout-Default (siehe ratchetSession.ratchetSendEnabled).
//
// Der Cache (localStorage renex_rollout) macht die Flags beim nächsten Start
// sofort synchron verfügbar (vor dem ersten Fetch); ein Kill propagiert online
// beim nächsten Poll (Init + Foreground + Intervall).
// ======================================================
import { apiFetch } from './api.js';

const CACHE_KEY = 'renex_rollout';
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;   // Cache max. 7 Tage alt nutzen
const POLL_MS = 5 * 60 * 1000;               // Foreground-Poll alle 5 Min

let _flags = null;   // { ratchetSend:boolean, pqRekey:boolean } | null (= unbekannt → AUS)

// Synchron: Cache beim Modul-Load lesen, damit die Flags sofort einen Wert haben.
(function _loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const c = JSON.parse(raw);
    if (c && typeof c.ts === 'number' && (Date.now() - c.ts) < CACHE_TTL_MS && c.flags) {
      _flags = { ratchetSend: c.flags.ratchetSend === true, pqRekey: c.flags.pqRekey === true, voice: c.flags.voice === true };
    }
  } catch { /* fail-safe: _flags bleibt null (AUS) */ }
})();

/**
 * Ist 1:1-Voice global aktiv? (KV rollout:flags {"voice":true})
 * Voice haengt am self-hosted coturn-Relay — ohne Relay scheitern Calls erst
 * nach dem Klingeln im ICE-Timeout, deshalb wird der Einstieg (Hoerer-Button)
 * ausgeblendet und der Server weist /voice/ring & Co. mit 503 ab.
 * Fail-safe AUS. Per-Device-Override zum Testen: localStorage renex_voice='1'/'0'.
 */
export function voiceEnabled() {
  try {
    const explicit = localStorage.getItem('renex_voice');
    if (explicit === '1') return true;
    if (explicit === '0') return false;
  } catch { /* localStorage kaputt → Rollout entscheidet */ }
  return rolloutDefault('voice');
}

/** Rollout-Default für eine Schicht. Unbekannt → false (fail-safe). */
export function rolloutDefault(key) {
  return !!(_flags && _flags[key] === true);
}

/** Holt die Flags vom Server + cached sie. Wirft nie; bei Fehler bleibt der letzte Stand. */
export async function fetchRolloutFlags() {
  try {
    const r = await apiFetch('/e2e/rollout');
    if (!r || !r.ok || !r.data || typeof r.data !== 'object') return;
    const flags = { ratchetSend: r.data.ratchetSend === true, pqRekey: r.data.pqRekey === true, voice: r.data.voice === true };
    _flags = flags;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ flags, ts: Date.now() })); } catch {}
  } catch { /* Netzfehler → letzter bekannter Stand bleibt (fail-safe zu AUS wenn nie gefetcht) */ }
}

// Einmalige Verkabelung: Initial-Fetch + Foreground-Poll + Intervall. Idempotent.
let _started = false;
export function startRolloutPolling() {
  if (_started) return;
  _started = true;
  void fetchRolloutFlags();
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void fetchRolloutFlags();
    });
    setInterval(() => { void fetchRolloutFlags(); }, POLL_MS);
  } catch { /* kein document/setInterval (Tests) → nur der Initial-Fetch */ }
}
