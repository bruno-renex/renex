import de from "./lang/de.js";
import en from "./lang/en.js";
import es from "./lang/es.js";
import { hasGuestSession } from "./guestStorage.js";

const LANGS = { de, en, es };
const STORAGE_KEY = "renex_lang";
const SUPPORTED   = Object.keys(LANGS);
const DEFAULT_LANG = "en";

// ── Browser-Sprache detektieren (für Gäste ohne gespeicherte Präferenz) ──
// navigator.languages bevorzugt (Prioritätenliste), Fallback auf navigator.language.
// Matches: "de-CH" → "de", "en-US" → "en". Nicht unterstützte Sprachen → DEFAULT_LANG.
function detectBrowserLang() {
  try {
    const candidates = [
      ...(Array.isArray(navigator.languages) ? navigator.languages : []),
      navigator.language,
    ].filter(Boolean);
    for (const raw of candidates) {
      const code = String(raw).toLowerCase().split("-")[0];
      if (SUPPORTED.includes(code)) return code;
    }
  } catch {}
  return DEFAULT_LANG;
}

// ── Aktive Sprache ermitteln ──────────────────────────
// Gäste: IMMER Browser-Sprache (ignorieren localStorage, damit der Gast nicht
//         die Sprachpräferenz des Geräte-Owners erbt, wenn derselbe Browser
//         vorher für den regulären Account genutzt wurde).
// Join-Seite (vor Gast-Beitritt, hasGuestSession() ist noch false): gleiche
//         Behandlung wie Gast — localStorage ignorieren, Browser-Sprache nutzen.
// Reguläre User:
//   1) Explizite Wahl aus localStorage (setLang)
//   2) Browser-Sprache
//   3) DEFAULT_LANG
export function getLang() {
  // Gast-Modus oder Join-Seite vor Beitritt → immer Browser-Sprache.
  // Same-origin localStorage kann "de" o.ä. vom Inviter enthalten und darf den
  // Gast nicht überschreiben.
  let isGuest = false;
  try { isGuest = hasGuestSession(); } catch {}
  const onJoinPage = typeof location !== 'undefined' && location.pathname.startsWith('/join');
  if (isGuest || onJoinPage) return detectBrowserLang();

  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && SUPPORTED.includes(stored)) return stored;
  return detectBrowserLang();
}

// ── Sprache wechseln (Seite wird neu geladen) ─────────
export function setLang(code) {
  localStorage.setItem(STORAGE_KEY, code);
  location.reload();
}

// ── Übersetzungs-Objekt ───────────────────────────────
const lang = LANGS[getLang()] ?? de;
export default lang;

// ── Sicherer HTML-Setter (nur erlaubte Inline-Tags, keine Attribute) ──
// Verhindert XSS falls Übersetzungs-Strings je aus externen Quellen kommen.
const SAFE_TAGS = new Set(["BR", "STRONG", "EM", "B", "I", "SPAN"]);

function setSafeHtml(target, htmlString) {
  const doc = new DOMParser().parseFromString(htmlString, "text/html");
  target.textContent = "";
  function importNodes(src, dest) {
    src.childNodes.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        dest.appendChild(document.createTextNode(node.textContent));
      } else if (node.nodeType === Node.ELEMENT_NODE && SAFE_TAGS.has(node.tagName)) {
        const el = document.createElement(node.tagName);
        importNodes(node, el);
        dest.appendChild(el);
      }
      // Alle anderen Nodes (script, img, ...) werden stillschweigend verworfen
    });
  }
  importNodes(doc.body, target);
}

// ── DOM-Elemente mit data-i18n automatisch befüllen ───
//
//   data-i18n="key"              → el.textContent = lang[key]
//   data-i18n-html="key"        → setSafeHtml()   (für <br> etc.)
//   data-i18n-placeholder="key" → el.placeholder = lang[key]
//   data-i18n-title="key"       → el.title       = lang[key]
//
export function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const val = lang[el.dataset.i18n];
    if (typeof val === "string") el.textContent = val;
  });
  document.querySelectorAll("[data-i18n-html]").forEach(el => {
    const val = lang[el.dataset.i18nHtml];
    if (typeof val === "string") setSafeHtml(el, val);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    const val = lang[el.dataset.i18nPlaceholder];
    if (typeof val !== "string") return;
    // contenteditable divs haben kein .placeholder → data-placeholder setzen (für CSS ::before)
    if (el.isContentEditable || el.contentEditable === "true" || el.contentEditable === "plaintext-only") {
      el.dataset.placeholder = val;
    } else {
      el.placeholder = val;
    }
  });
  document.querySelectorAll("[data-i18n-title]").forEach(el => {
    const val = lang[el.dataset.i18nTitle];
    if (typeof val === "string") el.title = val;
  });
  // Seitentitel
  const titleKey = document.documentElement.dataset.i18nTitle;
  if (titleKey && lang[titleKey]) document.title = lang[titleKey];
}
