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

// P3.1: v4-Double-Ratchet-SENDEN (opt-in, default aus). Empfangen ist immer an.
// ?ratchetsend=1 aktivieren / =0 zurück auf Legacy. Kill-Switch bleibt lokal.
const _rs = params.get("ratchetsend");
if (_rs === "1") localStorage.setItem("renex_ratchet_send", "1");
else if (_rs === "0") localStorage.removeItem("renex_ratchet_send");

const app = mount(App, {
  target: document.getElementById('app'),
});

export default app;
