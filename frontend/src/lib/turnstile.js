// ======================================================
// Turnstile Helper — lazy load + Widget-Render
// ======================================================
// Cloudflare Turnstile = Privacy-friendly Captcha (kein Tracking).
// Site-Key ist PUBLIC (siehe /public/join/index.html, /public/feedback/index.html).
// Backend verifiziert Token über env.TURNSTILE_SECRET (geheim).
//
// Verwendung in Svelte:
//   const handle = await renderTurnstile(containerEl, {
//     onToken: (t) => myToken = t,
//     onExpired: () => myToken = null,
//   });
//   // ...
//   handle.reset();   // bei Submit-Fehler — neuer Token nötig
//   handle.dispose(); // beim Component-Unmount
// ======================================================

const SITE_KEY = '0x4AAAAAACtyEOf-Gqc2i4DY';
const TURNSTILE_API = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__renexTurnstileReady';

let _scriptPromise = null;

/**
 * Lädt das Cloudflare-Turnstile-API-Skript vorab, ohne ein Widget zu rendern.
 * Idempotent — mehrfacher Aufruf führt nur zu einem Script-Tag.
 * Verwendung: beim Modal-Open aufrufen, damit ein späteres `renderTurnstile()`
 * das Skript bereits im Cache hat → render() ist dann praktisch instant.
 */
export function preloadTurnstileScript() {
  return _loadScript();
}

function _loadScript() {
  if (_scriptPromise) return _scriptPromise;
  _scriptPromise = new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('not_browser'));
      return;
    }
    if (window.turnstile) { resolve(); return; }
    // Globaler Ready-Callback (von ?onload= aufgerufen)
    window.__renexTurnstileReady = () => resolve();
    const s = document.createElement('script');
    s.src = TURNSTILE_API;
    s.async = true;
    s.defer = true;
    s.onerror = () => reject(new Error('turnstile_load_failed'));
    document.head.appendChild(s);
  });
  return _scriptPromise;
}

/**
 * Rendert ein Turnstile-Widget in `container`. Returnt einen Handle mit
 * `reset()` und `dispose()`.
 *
 * @param {HTMLElement} container
 * @param {{
 *   onToken: (token: string) => void,
 *   onExpired?: () => void,
 *   onError?: () => void,
 *   theme?: 'auto'|'light'|'dark',
 *   size?: 'normal'|'compact'|'invisible',
 * }} opts
 */
export async function renderTurnstile(container, opts = {}) {
  if (!container) throw new Error('no_container');
  await _loadScript();
  if (!window.turnstile) throw new Error('turnstile_unavailable');

  const widgetId = window.turnstile.render(container, {
    sitekey: SITE_KEY,
    theme: opts.theme || 'dark',
    size: opts.size || 'normal',
    callback: (token) => {
      try { opts.onToken?.(token); } catch {}
    },
    'expired-callback': () => {
      try { opts.onExpired?.(); } catch {}
    },
    'error-callback': () => {
      try { opts.onError?.(); } catch {}
    },
  });

  return {
    widgetId,
    reset() {
      try { window.turnstile?.reset(widgetId); } catch {}
    },
    dispose() {
      try { window.turnstile?.remove(widgetId); } catch {}
    },
  };
}
