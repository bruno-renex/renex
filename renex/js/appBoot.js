import { startGlobalControlPolling } from "./controlSocket.js";

export function bootApp() {
  // nur wenn eingeloggt
  const me = localStorage.getItem("my_user");
  if (!me) return;

  // einmalig starten
  if (window.__controlPollerStarted) return;
  window.__controlPollerStarted = true;

  startGlobalControlPolling();
}