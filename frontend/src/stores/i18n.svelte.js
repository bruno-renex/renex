// ======================================================
// i18n Store — Reactive Language-State (Svelte 5 Runes)
// ======================================================
// Verwaltet:
//   - currentLang ("de" | "en" | "es")
//   - lang (translations object für aktuelle Sprache)
//
// Auto-Detection beim ersten Start (Browser-Sprache).
// Persistiert in localStorage als "lang".
// ======================================================

import { get, set } from '../lib/storage.js';
import de from './lang/de.js';
import en from './lang/en.js';
import es from './lang/es.js';

const TRANSLATIONS = { de, en, es };
const SUPPORTED = Object.keys(TRANSLATIONS);
const DEFAULT_LANG = "en";

function detectInitialLang() {
  // 1) localStorage gewinnt
  const stored = get("lang");
  if (stored && SUPPORTED.includes(stored)) return stored;

  // 2) Browser-Sprache
  const browser = (navigator.language || "").slice(0, 2).toLowerCase();
  if (SUPPORTED.includes(browser)) return browser;

  // 3) Default
  return DEFAULT_LANG;
}

let _currentLang = $state(detectInitialLang());
let _lang = $state(TRANSLATIONS[_currentLang]);

export const i18nStore = {
  get currentLang() { return _currentLang; },
  get lang()        { return _lang; },
  get supported()   { return SUPPORTED; },

  setLang(code) {
    if (!SUPPORTED.includes(code)) {
      console.warn(`i18n: unsupported language "${code}", ignoring`);
      return;
    }
    _currentLang = code;
    _lang = TRANSLATIONS[code];
    set("lang", code);
    document.documentElement.lang = code;
  },

  // Convenience: t("key") oder t("key.nested")
  t(key, fallback) {
    return _lang[key] ?? fallback ?? key;
  },
};

// Initial setzen
if (typeof document !== "undefined") {
  document.documentElement.lang = _currentLang;
}
