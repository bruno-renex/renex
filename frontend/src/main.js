// ======================================================
// RENEX — Svelte 5 Entry Point
// ======================================================
import { mount } from 'svelte';
import App from './App.svelte';
import { sessionStore } from './stores/session.svelte.js';
import { initSentry } from './lib/sentryInit.js';
import './app.css';

// Sentry initialisieren (silent no-op im Dev / wenn Backend keine DSN liefert).
// Fire-and-forget: blockiert App-Start nicht.
void initSentry();

// Persistenten Speicher anfordern: schützt IndexedDB (E2E-Schlüssel + entschlüsselte
// v4-History) vor Storage-Pressure-Eviction. Ohne das kann iOS/Safari IDB unter
// Speicherdruck stillschweigend räumen → verlorene Ratchet-Keys = unlesbare History
// ohne Recovery (besonders für kontolose Gäste kritisch). Fire-and-forget, best-effort.
if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
  navigator.storage.persist()
    .then((granted) => console.log(`💾 Persistent storage: ${granted ? 'granted' : 'best-effort'}`))
    .catch(() => {});
}

// iOS-Auto-Zoom-Sicherheitsnetz (2026-07-14): Kern-Fix ist die 16px-Regel in
// app.css (Touch-Inputs). Zusätzlich unterdrückt maximum-scale=1 auf iOS den
// Fokus-Auto-Zoom für evtl. übersehene Felder. NUR iOS: Apple ignoriert
// maximum-scale beim PINCH-Zoom seit iOS 10 (Accessibility bleibt intakt),
// respektiert es aber beim Fokus-Zoom. Auf Android würde dieselbe Direktive
// den Pinch-Zoom real deaktivieren (WCAG 1.4.4) → dort bewusst NICHT gesetzt.
// (iPadOS meldet sich als "MacIntel" mit Touch → zweite Bedingung.)
const _isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (_isIOS) {
  const _vp = document.querySelector('meta[name="viewport"]');
  if (_vp && !/maximum-scale/.test(_vp.content)) {
    _vp.content += ', maximum-scale=1';
  }
}

// Session-Check beim App-Start (einmal, OUTSIDE von $effect — sonst loop).
// Skip via ?dev=skipSessionCheck — nur für UI-Tests im Dev.
const params = new URLSearchParams(location.search);
if (params.get("dev") !== "skipSessionCheck") {
  sessionStore.check();
}

// Versteckter Debug-Menü-Zugang: ?debug=1 schaltet ein, ?debug=0 aus (persistiert
// in localStorage). Ohne das Flag ist der Debug-Eintrag im Profil-Menü unsichtbar.
const _dbg = params.get("debug");
if (_dbg === "1") localStorage.setItem("renex_debug", "1");
else if (_dbg === "0") localStorage.removeItem("renex_debug");

// P3.1: v4-Double-Ratchet-SENDEN (opt-in, default aus). Empfangen ist immer an.
// ?ratchetsend=1 aktivieren / =0 zurück auf Legacy. Kill-Switch bleibt lokal.
const _rs = params.get("ratchetsend");
if (_rs === "1") localStorage.setItem("renex_ratchet_send", "1");
else if (_rs === "0") localStorage.removeItem("renex_ratchet_send");

const app = mount(App, {
  target: document.getElementById('app'),
});

export default app;
