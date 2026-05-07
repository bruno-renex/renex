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

const app = mount(App, {
  target: document.getElementById('app'),
});

export default app;
