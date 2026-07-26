// ======================================================
// authCode.js (Join-Page-Kopie) — Aktivierungscode, eGov 1.3
// ======================================================
// Eigene Kopie, weil /join self-contained ist (wie i18n.js/guestStorage.js).
// MUSS mit frontend/src/lib/authCode.js identisch hashen — sonst schlägt der
// Vergleich auf dem Server fehl. Bei Änderungen BEIDE Dateien anpassen
// (tests/authCode.test.js prüft die Übereinstimmung).
//
// RENEX sieht den Klartext-Code nie: gehasht wird hier im Bürger-Browser,
// gesendet wird nur der Hash. Das Salt kommt aus /invite/info.
// ======================================================

export function normalizeAuthCode(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/U/g, 'V');
}

export async function hashAuthCode(salt, code) {
  const saltBytes = _unb64(salt);
  const codeBytes = new TextEncoder().encode(normalizeAuthCode(code));
  const buf = new Uint8Array(saltBytes.length + codeBytes.length);
  buf.set(saltBytes, 0);
  buf.set(codeBytes, saltBytes.length);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return _b64(new Uint8Array(digest));
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
