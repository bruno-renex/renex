import { startGlobalControlPolling } from "./controlSocket.js";
import { initServiceWorker, subscribeToPush, initInstallPrompt, isStandalone } from "./pushManager.js";
import { checkAppVersion } from "./versionCheck.js";
import { hasGuestSession } from "./shared/guestStorage.js";
import { initVoiceUI } from "./voice/voiceUI.js";
import { initVoiceButtons } from "./voice/voiceButtons.js";
import { initVoiceList } from "./voice/voiceList.js";
import { initVoiceRooms } from "./voice/voiceRooms.js";

// Threshold für "lange Pause" — >30 min Inaktivität → Silent-Update statt Banner
const LONG_PAUSE_MS = 30 * 60 * 1000;

export function bootApp() {
  // App-Start = Silent Mode: User hat die App gerade geöffnet, direkt auf
  // aktuelle Version reloaden ist nicht störend.
  checkAppVersion({ silent: true }).catch(() => {});

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
  const isGuest = hasGuestSession();
  if (isGuest) return;

  // Einmalig starten — pro TOP-Window, nicht pro iframe.
  // Der Chat läuft im iframe von index.html und importiert appBoot. Ohne diesen
  // Guard entstünden zwei WS-Verbindungen pro User-DO → Events (z.B. Reactions,
  // NEW_MESSAGE) kämen doppelt im Client an. Same-Origin → window.top zugreifbar.
  let flagHolder = window;
  try {
    if (window.top && window.top !== window.self) flagHolder = window.top;
  } catch {
    // Cross-Origin Frame (sollte hier nie vorkommen, aber defensive)
  }
  if (flagHolder.__controlPollerStarted) return;
  flagHolder.__controlPollerStarted = true;

  startGlobalControlPolling();

  // Voice-UI initialisieren (Overlay + Signaling-Listener + Anrufliste + Group-Rooms)
  try { initVoiceUI();      } catch (e) { console.warn("initVoiceUI failed", e); }
  try { initVoiceRooms();   } catch (e) { console.warn("initVoiceRooms failed", e); }
  try { initVoiceButtons(); } catch (e) { console.warn("initVoiceButtons failed", e); }
  try { initVoiceList();    } catch (e) { console.warn("initVoiceList failed", e); }

  // Version-Check bei Tab-Wake-Up (PWA nach längerer Inaktivität).
  // Hybrid-Modus:
  //  • Away >30min  → Silent Auto-Update (User war weg, kein Chat in Arbeit)
  //  • Away <30min  → Banner (aktive Session, User entscheidet)
  if (!window.__versionVisibilityHandler) {
    window.__versionVisibilityHandler = true;
    let _lastHiddenTs = 0;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        _lastHiddenTs = Date.now();
      } else {
        const awayMs = _lastHiddenTs ? Date.now() - _lastHiddenTs : 0;
        const silent = awayMs > LONG_PAUSE_MS;
        checkAppVersion({ silent }).catch(() => {});
      }
    });
  }

  // Periodischer Version-Check während aktiver Session (alle 15 Min).
  // Schließt die Lücke "Tab seit Stunden offen" — sonst sieht der User Updates
  // erst nach Tab-Switch oder Reload. Banner-Modus, da User aktiv ist.
  // Cooldowns/Dismiss-Logik in versionCheck.js verhindern Spam/Doppel-Banner.
  if (!flagHolder.__versionPeriodicCheck) {
    flagHolder.__versionPeriodicCheck = true;
    setInterval(() => {
      if (document.hidden) return; // kein Hintergrund-Polling (iOS-PWA-Akku)
      checkAppVersion({ silent: false }).catch(() => {});
    }, 15 * 60 * 1000);
  }
}