// ======================================================
// authCode.js — Aktivierungscode für Empfänger-Auth (eGov 1.3)
// ======================================================
// Der Zweitfaktor gehört der ORG und dem PAPIER (Entscheid 2026-07-15):
// keine SMS, keine Telefonnummer, keine E-Mail bei RENEX. Die Org erzeugt den
// Code, hasht ihn im EIGENEN Browser und übergibt den Klartext out-of-band
// (zweiter Brief, eigenes Praxis-SMS, Telefonat, persönlich).
//
// RENEX sieht den Klartext NIE: gehasht wird an beiden Enden client-seitig,
// der Server speichert nur salt+hash und vergleicht constant-time.
// Das Salt ist über /invite/info öffentlich (der Bürger braucht es zum
// Rechnen) — ohne den Hash wertlos; die Sicherheit liegt im Online-Rate-Limit
// (5 Versuche + DO-Limiter), NICHT im Offline-Widerstand.
//
// Alphabet: Crockford-Base32 OHNE 0/O/1/I/L/U — Verwechslungen auf Papier sind
// der reale Fehlerfall (Bank-PIN-Brief-Erfahrung), nicht Entropie-Knappheit.
// 8 Zeichen à 32 Werte ≈ 40 bit — mehr als genug gegen 5 Online-Versuche.
// ======================================================

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';   // 30 Zeichen, ohne 0O1IL U
const CODE_LEN = 8;

/**
 * Kryptografisch zufälliger Code, gruppiert als "ABCD-EFGH" (Papier-freundlich).
 * Rejection-Sampling statt `% ALPHABET.length` — vermeidet Modulo-Bias
 * (256 % 30 ≠ 0). Für einen Auth-Code die korrekte Hygiene, auch wenn der Bias
 * gegen 5 Online-Versuche praktisch irrelevant wäre.
 */
export function generateAuthCode() {
  const limit = 256 - (256 % ALPHABET.length);   // größtes bias-freies Vielfaches
  let out = '';
  while (out.length < CODE_LEN) {
    for (const b of crypto.getRandomValues(new Uint8Array(CODE_LEN))) {
      if (b >= limit) continue;                  // verwerfen statt verzerren
      out += ALPHABET[b % ALPHABET.length];
      if (out.length === CODE_LEN) break;
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/**
 * Normalisiert die Nutzereingabe für das Hashing — MUSS an beiden Enden
 * identisch laufen. Bewusst minimal: Groß-/Kleinschreibung, Leerzeichen und
 * Bindestriche egal, plus die klassische Crockford-Regel U→V.
 * Zeichen, die es im Alphabet nicht gibt (0/O/1/I/L), werden NICHT geraten —
 * sie führen schlicht zu einem falschen Hash und damit zu „Code ungültig".
 * (Raten wäre gefährlicher: zwei verschiedene Eingaben könnten kollidieren.)
 */
export function normalizeAuthCode(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/U/g, 'V');
}

/** Salt für einen neuen Code (16 Byte, base64). */
export function generateCodeSalt() {
  return _b64(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * SHA-256(salt ‖ normalisierter Code) als base64 — identisch an beiden Enden.
 * @param {string} salt  base64 (aus generateCodeSalt bzw. /invite/info)
 * @param {string} code  Klartext-Code (roh, wird hier normalisiert)
 */
export async function hashAuthCode(salt, code) {
  const saltBytes = _unb64(salt);
  const codeBytes = new TextEncoder().encode(normalizeAuthCode(code));
  const buf = new Uint8Array(saltBytes.length + codeBytes.length);
  buf.set(saltBytes, 0);
  buf.set(codeBytes, saltBytes.length);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return _b64(new Uint8Array(digest));
}

/** Komplettpaket für die Org: Klartext (einmal anzeigen!) + salt/hash für den Server. */
export async function createAuthCode() {
  const code = generateAuthCode();
  const salt = generateCodeSalt();
  const hash = await hashAuthCode(salt, code);
  return { code, salt, hash };
}

function _b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function _unb64(b64) {
  const s = atob(String(b64 || ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
