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

// Einmaliger Check beim App-Start
export async function checkAppVersion() {
  try {
    // Cache-Buster damit der Browser nicht stillschweigend cachet
    const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, {
      cache: "no-store",
      credentials: "omit"
    });
    if (!res.ok) return; // Offline oder 404 → still
    const data = await res.json();
    const serverVersion = data?.version;
    if (!serverVersion) return;

    const localVersion = localStorage.getItem(VERSION_KEY);

    // Erster Start: Version speichern, kein Banner
    if (!localVersion) {
      localStorage.setItem(VERSION_KEY, serverVersion);
      return;
    }

    // Versions gleich → alles gut
    if (localVersion === serverVersion) return;

    // Mismatch → neue Version verfügbar
    console.warn(`🔄 App-Version veraltet: local=${localVersion}, server=${serverVersion}`);
    showUpdateBanner(serverVersion);
  } catch (e) {
    // Netzwerk-Fehler ignorieren — beim nächsten Start nochmal versuchen
    console.warn("Version check failed:", e.message);
  }
}

function showUpdateBanner(newVersion) {
  // Guard: nur einen Banner gleichzeitig
  if (document.getElementById("renex-update-banner")) return;

  const banner = document.createElement("div");
  banner.id = "renex-update-banner";
  banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;background:var(--accent,#38BDF8);color:#fff;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:14px;box-shadow:0 2px 12px rgba(0,0,0,0.3);font-family:sans-serif;";

  const text = document.createElement("span");
  text.textContent = lang?.newVersionAvailable || "New version available";
  text.style.cssText = "flex:1;font-weight:600;";

  const btn = document.createElement("button");
  btn.textContent = lang?.reloadNow || "Reload now";
  btn.style.cssText = "padding:6px 14px;border-radius:8px;border:none;background:#fff;color:var(--accent,#38BDF8);font-size:13px;font-weight:700;cursor:pointer;flex-shrink:0;";
  btn.addEventListener("click", () => forceReload(newVersion));

  const dismissBtn = document.createElement("button");
  dismissBtn.textContent = "✕";
  dismissBtn.title = lang?.dismissBtn || "Dismiss";
  dismissBtn.style.cssText = "padding:4px 8px;border-radius:6px;border:none;background:transparent;color:#fff;font-size:16px;cursor:pointer;flex-shrink:0;opacity:0.8;";
  dismissBtn.addEventListener("click", () => banner.remove());

  banner.append(text, btn, dismissBtn);
  document.body.appendChild(banner);
}

async function forceReload(newVersion) {
  try {
    // Neue Version speichern BEVOR Reload — damit nach Reload kein neuer Banner
    localStorage.setItem(VERSION_KEY, newVersion);

    // Alle Caches leeren (PWA Service Worker Caches etc.)
    if ("caches" in window) {
      const names = await caches.keys();
      await Promise.all(names.map(n => caches.delete(n)));
    }

    // Service Worker aktualisieren
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.update()));
    }
  } catch (e) {
    console.warn("Force-reload cleanup failed:", e.message);
  }

  // Hard-Reload mit Cache-Busting
  const url = new URL(window.location.href);
  url.searchParams.set("_v", newVersion);
  window.location.replace(url.toString());
}
