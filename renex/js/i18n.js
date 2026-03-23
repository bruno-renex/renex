import de from "./lang/de.js";
import en from "./lang/en.js";

const LANGS = { de, en };
const STORAGE_KEY = "renex_lang";

// ── Aktive Sprache ermitteln ──────────────────────────
export function getLang() {
  return localStorage.getItem(STORAGE_KEY) || "en";
}

// ── Sprache wechseln (Seite wird neu geladen) ─────────
export function setLang(code) {
  localStorage.setItem(STORAGE_KEY, code);
  location.reload();
}

// ── Übersetzungs-Objekt ───────────────────────────────
const lang = LANGS[getLang()] ?? de;
export default lang;

// ── DOM-Elemente mit data-i18n automatisch befüllen ───
//
//   data-i18n="key"              → el.textContent = lang[key]
//   data-i18n-html="key"        → el.innerHTML   = lang[key]  (für <br> etc.)
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
    if (typeof val === "string") el.innerHTML = val;
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    const val = lang[el.dataset.i18nPlaceholder];
    if (typeof val === "string") el.placeholder = val;
  });
  document.querySelectorAll("[data-i18n-title]").forEach(el => {
    const val = lang[el.dataset.i18nTitle];
    if (typeof val === "string") el.title = val;
  });
  // Seitentitel
  const titleKey = document.documentElement.dataset.i18nTitle;
  if (titleKey && lang[titleKey]) document.title = lang[titleKey];
}
