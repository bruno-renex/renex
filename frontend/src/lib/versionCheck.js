// ======================================================
// Version-Polling — erkennt deployed-version > tab-version
// ======================================================
// Liest `<meta name="renex-version">` aus dem geladenen HTML (das ist die
// Version mit der dieser Tab gestartet ist), pollt periodisch /version.json
// (das wird bei jedem Deploy von deploy.sh überschrieben). Bei Mismatch
// → Callback feuert (UI zeigt typischerweise einen Reload-Toast).
//
// Mit Service-Worker `skipWaiting()` wird die NÄCHSTE Page-Load das neue
// Bundle laden. Reload ist die UX die das forciert.
//
// Network-Strategie: cache: 'no-store' damit wir nicht auf einen alten
// /version.json aus dem Browser-Cache hereinfallen.
// ======================================================

const VERSION_URL = '/version.json';
const DEFAULT_INTERVAL_MS = 5 * 60_000;  // 5 Minuten

/**
 * Liest die aktuelle Tab-Version aus dem Meta-Tag.
 * @returns {string|null}
 */
export function getCurrentVersion() {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector('meta[name="renex-version"]');
  return el?.getAttribute('content') || null;
}

/**
 * Holt die aktuelle Server-Version aus version.json.
 * @returns {Promise<string|null>}
 */
export async function fetchServerVersion() {
  try {
    const res = await fetch(VERSION_URL + '?_=' + Date.now(), {
      cache: 'no-store',
      credentials: 'omit',
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.version === 'string' ? data.version : null;
  } catch {
    return null;
  }
}

/**
 * Vergleicht zwei Versionen. Gibt true zurück wenn server-version sich von
 * tab-version unterscheidet (nicht null und nicht gleich).
 *
 * Ein neueres Format würde z.B. semver-Vergleich machen — hier reicht
 * String-Equality, da wir nur "neue Version verfügbar?" beantworten.
 */
export function isVersionMismatch(tabVersion, serverVersion) {
  if (!tabVersion || !serverVersion) return false;
  return tabVersion !== serverVersion;
}

/**
 * Startet das periodische Polling. Erste Prüfung läuft NICHT sofort
 * (sonst zeigt der Toast direkt nach Deploy für jeden geladenen Tab).
 * Erste Prüfung nach `intervalMs`.
 *
 * Bei Mismatch wird `onMismatch(serverVersion, tabVersion)` einmalig
 * aufgerufen — der Caller kann sich dort den Toast zeigen.
 * Polling läuft weiter, ruft aber NICHT erneut bei demselben Mismatch.
 *
 * @param {(serverVersion: string, tabVersion: string) => void} onMismatch
 * @param {{ intervalMs?: number }} [opts]
 * @returns {() => void} stop-function
 */
export function startVersionPolling(onMismatch, opts = {}) {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const tabVersion = getCurrentVersion();
  if (!tabVersion) return () => {};  // Meta-Tag fehlt → kein Polling sinnvoll

  let stopped = false;
  let notified = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    const serverVersion = await fetchServerVersion();
    if (stopped) return;

    if (!notified && isVersionMismatch(tabVersion, serverVersion)) {
      notified = true;
      try { onMismatch(serverVersion, tabVersion); } catch {}
    }
    if (!stopped) {
      timer = setTimeout(tick, intervalMs);
    }
  }

  timer = setTimeout(tick, intervalMs);

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
