import { startGlobalControlPolling } from "./controlSocket.js";

export function bootApp() {
  // nur wenn eingeloggt
  const me = localStorage.getItem("my_user");
  const token = localStorage.getItem("session_token");
  if (!me || !token) return;

  // einmalig starten
  if (window.__controlPollerStarted) return;
  window.__controlPollerStarted = true;

  startGlobalControlPolling();
}