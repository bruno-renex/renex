import { startGlobalControlPolling } from "./controlSocket.js";

export function bootApp() {
  // nur wenn eingeloggt
  const me = localStorage.getItem("my_user");
  if (!me) return;

  // Gäste nutzen Polling statt WebSocket — kein WS-Ticket für Guest-Sessions
  // (requireSession schlägt fehl → 401 → ungewollter Redirect zur Login-Seite)
  const isGuest = !!sessionStorage.getItem("guestSession");
  if (isGuest) return;

  // einmalig starten
  if (window.__controlPollerStarted) return;
  window.__controlPollerStarted = true;

  startGlobalControlPolling();
}