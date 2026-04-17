import { startGlobalControlPolling } from "./controlSocket.js";
import { initServiceWorker, subscribeToPush, initInstallPrompt, isStandalone } from "./pushManager.js";
import { checkAppVersion } from "./versionCheck.js";
import { initVoiceUI } from "./voice/voiceUI.js";
import { initVoiceButtons } from "./voice/voiceButtons.js";
import { initVoiceList } from "./voice/voiceList.js";

export function bootApp() {
  // Version-Check zuerst (unabhängig von Login-Status) — erkennt veraltete PWA-Shells
  checkAppVersion().catch(() => {});

  // nur wenn eingeloggt
  const me = localStorage.getItem("my_user");
  if (!me) return;

  // PWA Install-Prompt immer initialisieren (auch für Gäste sichtbar)
  initInstallPrompt();

  // Service Worker registrieren (Push + Badge)
  initServiceWorker().then((reg) => {
    if (!reg) return;
    // Auto-Subscribe wenn bereits Permission granted (z.B. nach Reinstall)
    if (Notification.permission === "granted") {
      subscribeToPush().catch(() => {});
    }
  });

  // Gäste nutzen Polling statt WebSocket — kein WS-Ticket für Guest-Sessions
  // (requireSession schlägt fehl → 401 → ungewollter Redirect zur Login-Seite)
  const isGuest = !!sessionStorage.getItem("guestSession");
  if (isGuest) return;

  // einmalig starten
  if (window.__controlPollerStarted) return;
  window.__controlPollerStarted = true;

  startGlobalControlPolling();

  // Voice-UI initialisieren (Overlay + Signaling-Listener + Anrufliste)
  try { initVoiceUI();      } catch (e) { console.warn("initVoiceUI failed", e); }
  try { initVoiceButtons(); } catch (e) { console.warn("initVoiceButtons failed", e); }
  try { initVoiceList();    } catch (e) { console.warn("initVoiceList failed", e); }

  // Version-Check auch bei Tab-Wake-Up (PWA nach längerer Inaktivität)
  if (!window.__versionVisibilityHandler) {
    window.__versionVisibilityHandler = true;
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        checkAppVersion().catch(() => {});
      }
    });
  }
}