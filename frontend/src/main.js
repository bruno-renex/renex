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

const app = mount(App, {
  target: document.getElementById('app'),
});

export default app;
