// ======================================================
// VERSION CHECK — erkennt neue App-Version und triggert Reload
// ======================================================
// Problem: iOS PWA + Browser cachen HTML/JS aggressiv → User sieht
// nach Deploy die alte Version. Dieser Check holt /version.json
// (no-store Header) und vergleicht mit localStorage.
//
// Bei Mismatch: Banner anzeigen + Force-Reload aller Caches.
// ======================================================

import lang from "./i18n.js";

const VERSION_KEY = "renex_app_version";
const VERSION_URL = "/version.json";

// Die HTML-Datei trägt die Version als <meta name="renex-version" content="...">.
// Nur wenn HTML-Version === Server-Version ist, sind wir wirklich auf dem aktuellen
// Build. Damit verhindern wir das iOS-PWA-Problem, dass ein fehlgeschlagener Reload
// localStorage vorzeitig setzt und so zukünftige Updates nie mehr sichtbar werden.
function getHtmlVersion() {
  try {
    const el = document.querySelector('meta[name="renex-version"]');
    return el?.getAttribute("content") || null;
  } catch { return null; }
}

// Einmaliger Check beim App-Start
export async function checkAppVersion() {
  try {
    // Cache-Buster damit der Browser nicht stillschweigend cachet
    const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, {
      cache: "no-store",
      credentials: "omit"
    });
    if (!res.ok) return;
    const data = await res.json();
    const serverVersion = data?.version;
    if (!serverVersion) return;

    const localVersion = localStorage.getItem(VERSION_KEY);
    const htmlVersion  = getHtmlVersion();

    // Fall 1: wir laufen TATSÄCHLICH auf der aktuellen Version
    // (HTML-Tag matched Server-version). Nur dann localStorage sync.
    if (htmlVersion && htmlVersion === serverVersion) {
      if (localVersion !== serverVersion) {
        localStorage.setItem(VERSION_KEY, serverVersion);
      }
      return;
    }

    // Fall 2: altes HTML läuft noch → Banner zeigen (egal was localStorage sagt)
    if (htmlVersion) {
      console.warn(`🔄 App-Version veraltet: html=${htmlVersion}, server=${serverVersion}`);
      showUpdateBanner(serverVersion);
      return;
    }

    // Fall 3: kein HTML-Marker (z.B. ganz altes Deployment ohne Marker).
    // Fallback auf localStorage-Vergleich wie früher.
    if (!localVersion) {
      localStorage.setItem(VERSION_KEY, serverVersion);
      return;
    }
    if (localVersion !== serverVersion) {
      console.warn(`🔄 App-Version veraltet (fallback): local=${localVersion}, server=${serverVersion}`);
      showUpdateBanner(serverVersion);
    }
  } catch (e) {
    console.warn("Version check failed:", e.message);
  }
}

function showUpdateBanner(newVersion) {
  // Guard: nur einen Banner gleichzeitig
  if (document.getElementById("renex-update-banner")) return;

  const banner = document.createElement("div");
  banner.id = "renex-update-banner";
  // Safe-Area-Top für iOS-PWA (Notch / Dynamic Island)
  banner.style.cssText = [
    "position:fixed",
    "top:0", "left:0", "right:0",
    "z-index:99999",
    "background:var(--accent-voice,#38BDF8)",
    "color:#07070A",
    "padding:calc(env(safe-area-inset-top,0px) + 10px) 14px 10px",
    "display:flex", "align-items:center", "justify-content:space-between",
    "gap:10px",
    "font-size:14px", "font-weight:600",
    "box-shadow:0 4px 16px rgba(0,0,0,0.35)",
    "font-family:system-ui,-apple-system,sans-serif",
    "animation:renexSlideDown 240ms ease-out",
  ].join(";");

  // Animation-Keyframes einmalig injizieren
  if (!document.getElementById("renex-update-banner-style")) {
    const style = document.createElement("style");
    style.id = "renex-update-banner-style";
    style.textContent = "@keyframes renexSlideDown{from{transform:translateY(-100%)}to{transform:translateY(0)}}";
    document.head.appendChild(style);
  }

  const text = document.createElement("span");
  text.textContent = "🔄 " + (lang?.newVersionAvailable || "Neue Version verfügbar");
  text.style.cssText = "flex:1;min-width:0;";

  const btn = document.createElement("button");
  btn.textContent = lang?.reloadNow || "Jetzt aktualisieren";
  btn.style.cssText = "padding:7px 14px;border-radius:999px;border:none;background:#07070A;color:var(--accent-voice,#38BDF8);font-size:13px;font-weight:800;cursor:pointer;flex-shrink:0;";
  btn.addEventListener("click", () => forceReload(newVersion));

  const dismissBtn = document.createElement("button");
  dismissBtn.textContent = "✕";
  dismissBtn.title = lang?.dismissBtn || "Schliessen";
  dismissBtn.style.cssText = "padding:4px 8px;border-radius:6px;border:none;background:transparent;color:#07070A;font-size:16px;cursor:pointer;flex-shrink:0;opacity:0.7;";
  dismissBtn.addEventListener("click", () => banner.remove());

  banner.append(text, btn, dismissBtn);
  document.body.appendChild(banner);
}

async function forceReload(newVersion) {
  try {
    // WICHTIG: version NICHT hier in localStorage schreiben.
    // Wenn der Reload auf iOS-PWA nicht wirklich greift (cached shell),
    // würde das den User dauerhaft ausschliessen vom Banner-System.
    // Das Speichern passiert nach dem Reload — wenn die HTML-Meta-Version
    // mit der Server-Version übereinstimmt (siehe checkAppVersion oben).

    // Alle Caches leeren (PWA Service Worker Caches etc.)
    if ("caches" in window) {
      const names = await caches.keys();
      await Promise.all(names.map(n => caches.delete(n)));
    }

    // Service Worker: unregister UND update. unregister ist aggressiver —
    // iOS-PWA cacht den SW-Shell hartnäckig, deshalb killen wir ihn hier
    // komplett; beim nächsten Load registriert index.html ihn neu.
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister().catch(() => r.update())));
    }
  } catch (e) {
    console.warn("Force-reload cleanup failed:", e.message);
  }

  // Hard-Reload mit Cache-Busting (_v-Query triggert CDN-neu-fetch;
  // Cloudflare Pages respektiert den Query-String als Cache-Key).
  const url = new URL(window.location.href);
  url.searchParams.set("_v", newVersion);
  // location.replace (kein History-Eintrag) + neue URL → Browser muss neu laden
  window.location.replace(url.toString());
}
