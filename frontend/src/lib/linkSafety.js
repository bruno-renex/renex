// ======================================================
// linkSafety — IDN-Homograph- und Phishing-Heuristik
// ======================================================
// Vor dem Öffnen eines externen Links wird die URL klassifiziert:
//   - "safe"      → öffnet ohne Rückfrage
//   - "suspicious"→ LinkWarningModal zeigt Warnung mit Begründung
//
// Erkennungsmerkmale (Discord-/Slack-Niveau, kein vollständiger Schutz):
//   - Punycode-Hostname (xn--…)         → potenzielle Homograph-Attack
//   - Gemischte Skripte im Hostname      → z.B. kyrillisches "а" in "apple"
//   - userinfo im URL (user:pass@host)   → klassischer Phishing-Trick
//   - Bekannte Shortener (bit.ly, t.co)  → URL-Ziel intransparent
//
// Bewusst NICHT geprüft (Scope v1):
//   - URL-Blacklists / Safe-Browsing-API (würde Privacy-by-Default verletzen)
//   - Server-Side-Reputation-Checks
// ======================================================

// Bekannte URL-Shortener. Inhalt ist intransparent → Warnung.
const SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd',
  'buff.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at',
  'tiny.cc', 'rb.gy', 'short.io', 'lnkd.in', 'fb.me',
]);

/**
 * Erkennt, ob ein String Zeichen aus mehreren Unicode-Skripten mischt.
 * Klassischer Homograph: "apple" mit kyrillischem "а" (U+0430).
 *
 * Whitelist: ASCII + (genau ein nicht-Latin-Skript) ist ok — z.B. reine
 * japanische Domain. Verdächtig wird's bei Latin + Cyrillic/Greek im
 * selben Label.
 */
function hasMixedScripts(host) {
  // Pro Label (zwischen Punkten) prüfen, nicht über die ganze Domain
  // (subdomain.example.JP wäre sonst falsch-positiv).
  const labels = host.split('.');
  for (const label of labels) {
    const scripts = new Set();
    for (const ch of label) {
      const cp = ch.codePointAt(0);
      // ASCII (Buchstaben+Ziffern+Bindestrich) → "ascii"
      if (cp < 0x80) {
        if (/[a-z0-9-]/i.test(ch)) scripts.add('ascii');
        continue;
      }
      // Cyrillic block
      if (cp >= 0x0400 && cp <= 0x04FF) scripts.add('cyrillic');
      // Greek
      else if (cp >= 0x0370 && cp <= 0x03FF) scripts.add('greek');
      // CJK
      else if ((cp >= 0x3040 && cp <= 0x309F) || (cp >= 0x30A0 && cp <= 0x30FF) || (cp >= 0x4E00 && cp <= 0x9FFF)) scripts.add('cjk');
      // Hangul
      else if (cp >= 0xAC00 && cp <= 0xD7AF) scripts.add('hangul');
      // Arabic
      else if (cp >= 0x0600 && cp <= 0x06FF) scripts.add('arabic');
      // Sonstige → "other"
      else scripts.add('other');
    }
    // ASCII + irgendein anderes Skript im selben Label → verdächtig.
    if (scripts.has('ascii') && scripts.size > 1) return true;
    // Cyrillic+Greek o.ä. ohne ASCII → ebenfalls verdächtig.
    if (scripts.size > 1 && !scripts.has('ascii')) return true;
  }
  return false;
}

/**
 * Versucht, einen Punycode-Hostname in Unicode zu dekodieren, damit der
 * User in der Warnung sieht, wie die URL "in echt" aussieht.
 * Browser können das via URL-Konstruktor + URL.hostname (das bereits
 * dekodierte Form liefert in einigen Engines) — wir nutzen es als Best-Effort.
 */
function tryDecodeHost(host) {
  try {
    // Browser-URL dekodiert IDN bereits in .hostname (zumindest in Chromium).
    const u = new URL('https://' + host);
    return u.hostname;
  } catch {
    return host;
  }
}

/**
 * Analysiert einen Link auf Phishing-Heuristiken.
 *
 * @param {string} href
 * @returns {{ safe: boolean, reason: string|null, host: string, decodedHost: string, hasUserinfo: boolean }}
 */
export function analyzeLink(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return { safe: false, reason: 'invalid', host: '', decodedHost: '', hasUserinfo: false };
  }

  // Nur http(s) — andere Schemas sollten gar nicht hier ankommen,
  // aber Belt-and-Suspenders.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { safe: false, reason: 'invalid', host: '', decodedHost: '', hasUserinfo: false };
  }

  const host = url.hostname;
  const decodedHost = tryDecodeHost(host);
  const hasUserinfo = url.username !== '' || url.password !== '';

  // userinfo: klassischer Phishing-Trick (https://google.com@evil.example)
  if (hasUserinfo) {
    return { safe: false, reason: 'userinfo', host, decodedHost, hasUserinfo: true };
  }

  // Punycode → potenzielle Homograph-Attack
  if (host.includes('xn--') || decodedHost !== host) {
    return { safe: false, reason: 'punycode', host, decodedHost, hasUserinfo: false };
  }

  // Mixed scripts in der dekodierten Form (greift v.a. wenn Browser
  // den IDN bereits dekodiert hat)
  if (hasMixedScripts(decodedHost)) {
    return { safe: false, reason: 'mixed_scripts', host, decodedHost, hasUserinfo: false };
  }

  // URL-Shortener (Inhalt intransparent)
  const hostLower = host.toLowerCase();
  if (SHORTENERS.has(hostLower)) {
    return { safe: false, reason: 'shortener', host, decodedHost, hasUserinfo: false };
  }

  return { safe: true, reason: null, host, decodedHost, hasUserinfo: false };
}

/**
 * Lokalisierte Begründung (DE) — eine pragmatische Minimal-Variante.
 * Wenn i18n kommt, ziehen wir das in lang-Files.
 */
export function reasonText(reason, decodedHost) {
  switch (reason) {
    case 'punycode':
      return `Dieser Link verwendet einen Punycode-Hostname. Die dekodierte Form ist „${decodedHost}". Solche Domains werden für Phishing-Angriffe verwendet.`;
    case 'mixed_scripts':
      return `Dieser Link kombiniert Zeichen aus mehreren Schriftsystemen — typisch für Homograph-Phishing (z.B. kyrillisches „а" statt lateinischem „a").`;
    case 'userinfo':
      return `Dieser Link enthält Benutzername/Passwort vor dem @-Zeichen. Klassischer Phishing-Trick: Die Domain links vom @ ist NICHT das tatsächliche Ziel.`;
    case 'shortener':
      return `Dieser Link verwendet einen URL-Shortener — das tatsächliche Ziel ist nicht sichtbar.`;
    case 'invalid':
      return 'Dieser Link ist ungültig.';
    default:
      return '';
  }
}
