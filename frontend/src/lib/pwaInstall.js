// ======================================================
// PWA Install — Plattform-Detection + Prompt-State
// ======================================================
// Strategie:
//   - Smart Banner zeigt sich nur bei engagierten Usern (>=3 Logins,
//     nicht bereits standalone, nicht innerhalb der letzten 14 Tage dismissed).
//   - Auf Chrome/Android/Edge: nativer beforeinstallprompt-Dialog.
//   - Auf iOS Safari / macOS Safari / Firefox: Anleitungs-Modal.
//   - Privacy: ALLES nur localStorage, kein Server-Touch.
//
// Prinzipien:
//   #3 Open Standard: beforeinstallprompt ist W3C, iOS-Quirk dokumentiert.
//   #4 Privacy by Default: Server lernt nicht ob/wann User installiert.
// ======================================================

const STORAGE_LOGIN_COUNT     = 'pwa.loginCount';
const STORAGE_BANNER_DISMISSED = 'pwa.bannerDismissedAt';
const DISMISS_COOLDOWN_MS     = 14 * 24 * 60 * 60 * 1000;
const MIN_LOGINS_FOR_BANNER   = 3;

let _deferredPrompt = null;   // BeforeInstallPromptEvent (Chrome/Android/Edge)
let _captured = false;
let _listeners = new Set();

// Listener early registrieren — Event kann vor jedem App-Mount feuern.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _deferredPrompt = e;
    _captured = true;
    for (const fn of _listeners) try { fn(); } catch {}
  });
  window.addEventListener('appinstalled', () => {
    _deferredPrompt = null;
    _captured = false;
    // User hat installiert → Banner-Dismiss permanent setzen
    try { localStorage.setItem(STORAGE_BANNER_DISMISSED, String(Date.now())); } catch {}
    for (const fn of _listeners) try { fn(); } catch {}
  });
}

// ======================================================
// Plattform-Detection
// ======================================================

export function isStandalone() {
  if (typeof window === 'undefined') return false;
  // navigator.standalone = iOS-Specific. matchMedia = Standard.
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    window.matchMedia?.('(display-mode: fullscreen)').matches === true ||
    window.navigator?.standalone === true
  );
}

function _ua() {
  return (typeof navigator !== 'undefined' ? navigator.userAgent : '') || '';
}

export function isIOS() {
  const ua = _ua();
  // iPad ab iPadOS 13 reportet als Mac → zusätzlicher Touch-Check
  return /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
}

export function isSafari() {
  const ua = _ua();
  return /^((?!chrome|android|edg|firefox).)*safari/i.test(ua);
}

export function isFirefox() {
  return /Firefox\//.test(_ua());
}

/**
 * Welche Install-Strategie passt zu diesem Browser?
 *   'native'        — beforeinstallprompt ist gekommen, wir können prompt()en
 *   'ios-safari'    — kein API, Anleitung "Share → Home-Bildschirm"
 *   'macos-safari'  — kein API, Anleitung "Datei → Zum Dock"
 *   'firefox'       — Firefox Desktop kann nicht installieren
 *   'unsupported'   — sonstiges (kann via beforeinstallprompt noch kommen)
 */
export function getInstallStrategy() {
  if (_captured) return 'native';
  if (isIOS()) return 'ios-safari';
  if (isFirefox()) return 'firefox';
  if (isSafari()) return 'macos-safari';
  return 'unsupported';
}

export function canPromptNative() {
  return _captured && !!_deferredPrompt;
}

/**
 * Triggert den nativen Install-Prompt. Returnt das User-Choice-Outcome.
 * Auf iOS/anderen ohne Native-API → returnt 'unavailable'.
 */
export async function promptInstallNative() {
  if (!_deferredPrompt) return 'unavailable';
  try {
    _deferredPrompt.prompt();
    const choice = await _deferredPrompt.userChoice;
    _deferredPrompt = null;
    _captured = false;
    for (const fn of _listeners) try { fn(); } catch {}
    return choice?.outcome || 'dismissed';
  } catch {
    return 'error';
  }
}

// ======================================================
// Engagement-Tracking + Dismiss-State
// ======================================================

export function bumpLoginCount() {
  if (typeof localStorage === 'undefined') return 0;
  try {
    const n = Number(localStorage.getItem(STORAGE_LOGIN_COUNT) || '0') + 1;
    localStorage.setItem(STORAGE_LOGIN_COUNT, String(n));
    return n;
  } catch { return 0; }
}

export function getLoginCount() {
  if (typeof localStorage === 'undefined') return 0;
  try { return Number(localStorage.getItem(STORAGE_LOGIN_COUNT) || '0'); } catch { return 0; }
}

export function dismissBanner() {
  try { localStorage.setItem(STORAGE_BANNER_DISMISSED, String(Date.now())); } catch {}
}

export function wasBannerRecentlyDismissed() {
  if (typeof localStorage === 'undefined') return false;
  try {
    const ts = Number(localStorage.getItem(STORAGE_BANNER_DISMISSED) || '0');
    if (!ts) return false;
    return (Date.now() - ts) < DISMISS_COOLDOWN_MS;
  } catch { return false; }
}

/**
 * Soll der Smart Banner JETZT erscheinen?
 */
export function shouldShowBanner() {
  if (typeof window === 'undefined') return false;
  if (isStandalone()) return false;                 // schon installiert
  if (wasBannerRecentlyDismissed()) return false;
  if (getLoginCount() < MIN_LOGINS_FOR_BANNER) return false;
  const strategy = getInstallStrategy();
  // Firefox Desktop kann nicht installieren — Banner wäre frustrierend
  if (strategy === 'firefox') return false;
  return true;
}

/**
 * Subscribe auf beforeinstallprompt-State-Changes (Banner reaktiv updaten).
 */
export function onInstallStateChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// ======================================================
// Manual-Trigger-Bus (für Menu-Item)
// ======================================================
const _forceOpenListeners = new Set();

/**
 * Vom ProfileDropdown gerufen: erzwingt das Banner / iOS-Modal jetzt.
 */
export function requestInstallPrompt() {
  for (const fn of _forceOpenListeners) try { fn(); } catch {}
}

export function onInstallRequested(fn) {
  _forceOpenListeners.add(fn);
  return () => _forceOpenListeners.delete(fn);
}
