// ======================================================
// Proof-of-Work (L1) — adaptive CPU-Kosten pro /chat/send
// ======================================================
// Härtungs-Item L1 (Plan: "Proof of Human"-Analyse): JEDE echte Nachricht
// kostet nachweisbare CPU-Arbeit → Hochfrequenz-/Massenversand wird teuer.
// EHRLICHER CLAIM: Kostenanstieg gegen Automatisierung — KEIN Mensch-Beweis,
// kein Badge. Bypassbar durch Fork/Abtippen (by design, siehe Analyse).
//
// Mechanik: Client findet `nonce`, sodass SHA-256(sid|epoch|sig|nonce) N
// führende Null-Bits hat. Server rechnet EINEN Hash nach (billig). Rein
// SHA-256 → föderationssicher, kein Durable Object, keine Migration.
//
// Scope: nur echte User-Nachrichten. Pulse (returnt früh) und Control-
// Messages (cmk/gsk/…) sind ausgenommen — sie tragen keine `sig` und ihr
// Volumen ist klein/legitim.
//
// Pure Funktionen für Node-Unit-Tests (tests/pow.test.js); der Client
// spiegelt powPreimage + countLeadingZeroBits in frontend/src/lib/powCore.js
// (mit synchronem @noble/hashes-SHA-256). Der Cross-Check-Test beweist, dass
// beide SHA-256-Implementierungen identische Bytes liefern.
// ======================================================

// Default-Schwierigkeit (führende Null-Bits). Überschreibbar via env.POW_MIN_BITS.
// ~2^N Hashes erwartet: 17 ≈ 130k ≈ <30ms (sync, Handy) — für Menschen unmerklich.
export const POW_FLOOR_BITS = 17;
// Tier für neue Accounts (<24h). Aktuell NICHT verdrahtet (Session trägt nur
// Session-Alter, nicht Account-Alter) — Hook für späteres Tuning.
export const POW_NEW_ACCOUNT_BITS = 20;
const NEW_ACCOUNT_MS = 24 * 3600_000;

// Preimage: sid|epoch|sig|nonce. `sig` (ECDSA über iv|ct|sid|epoch) bindet den
// Inhalt; fehlt sig, bindet ctB64 (jede Nachricht hat frische IV → unique).
export function powPreimage({ sid, epoch, sig, ctB64, nonce }) {
  const bind = (typeof sig === "string" && sig.length) ? sig : (ctB64 || "");
  return `${sid ?? ""}|${epoch ?? 0}|${bind}|${nonce ?? ""}`;
}

// Zählt führende Null-Bits in einem Hash (Uint8Array).
export function countLeadingZeroBits(bytes) {
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0) { bits += 8; continue; }
    // b ∈ 1..255 → clz32 zählt die 24 Pad-Bits mit → abziehen.
    bits += Math.clz32(b) - 24;
    break;
  }
  return bits;
}

// Erforderliche Bits aus Signalen (Account-Alter-Tier + Floor). Pure/testbar.
export function requiredPowBits({
  accountAgeMs = Infinity,
  floorBits = POW_FLOOR_BITS,
  newAccountBits = POW_NEW_ACCOUNT_BITS,
} = {}) {
  if (Number.isFinite(accountAgeMs) && accountAgeMs < NEW_ACCOUNT_MS) {
    return Math.max(floorBits, newAccountBits);
  }
  return floorBits;
}

// Verifiziert eine PoW. Async (ein crypto.subtle.digest).
// @returns {Promise<{ok:boolean, bits:number, reason:'ok'|'weak'|'missing'}>}
export async function verifyPow({ sid, epoch, sig, ctB64, nonce, requiredBits }) {
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 64) {
    return { ok: false, bits: 0, reason: "missing" };
  }
  const pre = powPreimage({ sid, epoch, sig, ctB64, nonce });
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pre));
  const bits = countLeadingZeroBits(new Uint8Array(buf));
  return { ok: bits >= requiredBits, bits, reason: bits >= requiredBits ? "ok" : "weak" };
}
