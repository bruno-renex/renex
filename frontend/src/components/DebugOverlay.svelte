<!--
  DebugOverlay — Diagnose-Tool für Push/SW/Network
  Migration von /renex/index.html #debug-overlay.

  Wichtig für iOS PWA Debugging — keine Browser-DevTools verfügbar.
  Nutzer kann hier den State sehen + Test-Push senden + Snapshot kopieren.
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { userStore } from '../stores/user.svelte.js';
  import { apiFetch, API } from '../lib/api.js';
  import { isStandalone } from '../lib/push.js';
  import { ratchetSendEnabled, pqRekeyEnabled } from '../lib/ratchetSession.js';

  let { isOpen = $bindable(false) } = $props();

  let lang = $derived(i18nStore.lang);

  // Status fields
  let notifPerm = $state("…");
  let notifPermClass = $state("");
  let swState = $state("…");
  let swStateClass = $state("");
  let pushSub = $state("…");
  let pushSubClass = $state("");
  let badgeApi = $state("…");
  let badgeApiClass = $state("");
  let pushStatusJson = $state("");
  let resubLog = $state("");
  let testResultJson = $state("");

  // Loading flags
  let isResubbing = $state(false);
  let isTesting = $state(false);
  let voiceDebugOn = $state(localStorage.getItem('voice-debug') === '1');

  function toggleVoiceDebug() {
    if (voiceDebugOn) {
      localStorage.removeItem('voice-debug');
      voiceDebugOn = false;
    } else {
      localStorage.setItem('voice-debug', '1');
      voiceDebugOn = true;
    }
    // VoiceLogOverlay liest localStorage nur onMount — reload nötig damit
    // sich der Overlay aktiviert/deaktiviert.
    setTimeout(() => location.reload(), 300);
  }
  let copyState = $state("idle"); // "idle" | "copied"

  // E2E / v4-Ratchet — Flags per Tri-State-Zyklus schaltbar (unset → '1' → '0' → unset).
  // Wichtig fürs iPhone-PWA: dort gibt es keine Console, um localStorage zu setzen.
  // Explizites '1'/'0' übersteuert den Server-Rollout (KV rollout:flags); unset = Rollout.
  let ratchetSendFlag = $state(_lsGet('renex_ratchet_send'));
  let pqRekeyFlag = $state(_lsGet('renex_pq_rekey'));
  let ratchetSendEff = $state(false);
  let pqRekeyEff = $state(false);
  let pqrkStatsJson = $state("");
  let rolloutCacheJson = $state("");

  function _lsGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function flagLabel(v) {
    return v === '1' ? "explizit AN ('1')" : v === '0' ? "explizit AUS ('0')" : "(nicht gesetzt → Rollout)";
  }

  function nextFlagLabel(v) {
    return v === null ? "explizit AN" : v === '1' ? "explizit AUS" : "Rollout-Default";
  }

  function cycleFlag(key) {
    const cur = _lsGet(key);
    try {
      if (cur === null) localStorage.setItem(key, '1');
      else if (cur === '1') localStorage.setItem(key, '0');
      else localStorage.removeItem(key);
    } catch {}
    refreshE2E();
  }

  function refreshE2E() {
    ratchetSendFlag = _lsGet('renex_ratchet_send');
    pqRekeyFlag = _lsGet('renex_pq_rekey');
    try { ratchetSendEff = ratchetSendEnabled(); } catch { ratchetSendEff = false; }
    try { pqRekeyEff = pqRekeyEnabled(); } catch { pqRekeyEff = false; }
    const stats = _lsGet('renex_pqrk_stats');
    try { pqrkStatsJson = stats ? JSON.stringify(JSON.parse(stats), null, 2) : ""; }
    catch { pqrkStatsJson = stats || ""; }
    rolloutCacheJson = _lsGet('renex_rollout') || "(kein Cache)";
  }

  $effect(() => {
    if (isOpen) {
      refreshAll();
    }
  });

  function classFromPerm(p) {
    return p === "granted" ? "ok" : (p === "denied" ? "error" : "warn");
  }

  async function refreshAll() {
    // Notification permission
    const perm = (typeof Notification !== "undefined") ? Notification.permission : "unavailable";
    notifPerm = perm;
    notifPermClass = classFromPerm(perm);

    // Service Worker
    try {
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.getRegistration("/");
        if (reg) {
          const active = reg.active ? "active" : (reg.installing ? "installing" : "waiting");
          swState = `${active} (scope=${reg.scope})`;
          swStateClass = reg.active ? "ok" : "warn";
        } else {
          swState = "no-registration";
          swStateClass = "error";
        }
      } else {
        swState = "not-supported";
        swStateClass = "error";
      }
    } catch (e) {
      swState = "error: " + e.message;
      swStateClass = "error";
    }

    // Push subscription
    try {
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.getRegistration("/");
        if (reg) {
          const s = await reg.pushManager.getSubscription();
          if (s) {
            const j = s.toJSON();
            pushSub = `endpoint=${(j.endpoint || "").slice(0, 50)}…`;
            pushSubClass = "ok";
          } else {
            pushSub = "(none)";
            pushSubClass = "warn";
          }
        }
      }
    } catch (e) {
      pushSub = "error: " + e.message;
      pushSubClass = "error";
    }

    // App Badge API
    const hasBadge = typeof navigator.setAppBadge === "function";
    badgeApi = hasBadge ? "supported" : "not-supported";
    badgeApiClass = hasBadge ? "ok" : "warn";

    // E2E / v4-Ratchet-Flags
    refreshE2E();

    // /push/status
    try {
      const r = await apiFetch("/push/status");
      if (r.ok) {
        pushStatusJson = JSON.stringify(r.data, null, 2);
      } else {
        pushStatusJson = `HTTP ${r.status} — ${r.error || ""}`;
      }
    } catch (e) {
      pushStatusJson = "Fetch error: " + e.message;
    }
  }

  async function forceResubscribe() {
    if (isResubbing) return;
    isResubbing = true;
    const log = [];
    const step = (msg, val) => {
      log.push(`[${new Date().toISOString().slice(11, 19)}] ${msg}` + (val !== undefined ? ": " + JSON.stringify(val) : ""));
      resubLog = log.join("\n");
    };

    try {
      step("1. SW: navigator.serviceWorker.ready");
      if (!("serviceWorker" in navigator)) throw new Error("Service Worker not supported");
      const reg = await navigator.serviceWorker.ready;
      step("   → SW scope", reg.scope);

      step("2. Notification.permission", Notification.permission);
      if (Notification.permission !== "granted") {
        throw new Error("Notification permission not granted (current: " + Notification.permission + ")");
      }

      step("3. existing subscription check");
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        step("   → existing subscription found, unsubscribing first");
        await existing.unsubscribe();
        step("   → unsubscribed OK");
      } else {
        step("   → no existing subscription");
      }

      step("4. fetch /push/vapid-key");
      const vRes = await fetch(`${API}/push/vapid-key`);
      step("   → status", vRes.status);
      if (!vRes.ok) throw new Error("VAPID-Key fetch failed: HTTP " + vRes.status);
      const vData = await vRes.json();
      if (!vData.publicKey) throw new Error("VAPID response missing publicKey");
      step("   → publicKey length", vData.publicKey.length);

      step("5. decode VAPID base64url → Uint8Array");
      const k = vData.publicKey;
      const padding = "=".repeat((4 - (k.length % 4)) % 4);
      const base64 = (k + padding).replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      step("   → bytes length", bytes.length);

      step("6. pushManager.subscribe");
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: bytes,
      });
      step("   → SUBSCRIBE OK");
      const subJson = sub.toJSON();
      step("   → endpoint", (subJson.endpoint || "").slice(0, 60) + "…");

      step("7. POST /push/subscribe");
      const sRes = await fetch(`${API}/push/subscribe`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: subJson.endpoint,
          keys: subJson.keys,
          transport_type: "web_push",
        }),
      });
      step("   → status", sRes.status);
      if (!sRes.ok) throw new Error("Backend subscribe failed: " + sRes.status);

      step("✅ ERFOLG — Subscription registriert");
      await refreshAll();
    } catch (e) {
      step("❌ FEHLER", { name: e.name, message: e.message });
    } finally {
      isResubbing = false;
    }
  }

  async function sendTestPush() {
    if (isTesting) return;
    isTesting = true;
    testResultJson = "Wird gesendet…";
    try {
      const r = await apiFetch("/push/test", { method: "POST" });
      testResultJson = JSON.stringify(r.data, null, 2);
    } catch (e) {
      testResultJson = "Fetch error: " + e.message;
    } finally {
      isTesting = false;
    }
  }

  async function copySnapshot() {
    const lines = [
      "RENEX Debug Snapshot",
      "Generated: " + new Date().toISOString(),
      "─────────────────────────────",
      "",
      "Notifications & Service Worker:",
      `  Notification.permission: ${notifPerm}`,
      `  Service Worker:          ${swState}`,
      `  Push Subscription:       ${pushSub}`,
      `  setAppBadge API:         ${badgeApi}`,
      "",
      "User & Device:",
      `  my_user:        ${userStore.myUser || "(not logged in)"}`,
      `  deviceId:       ${userStore.deviceId}`,
      `  App-Version:    ${document.querySelector('meta[name="renex-version"]')?.content || "unknown"}`,
      `  PWA-Mode:       ${isStandalone() ? "PWA (standalone)" : "Browser-Tab"}`,
      `  Lokalzeit:      ${new Date().toISOString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
      `  User-Agent:     ${navigator.userAgent}`,
      "",
      "Backend /push/status:",
      "  " + pushStatusJson.split("\n").join("\n  "),
      "",
      "E2E / v4-Ratchet:",
      `  renex_ratchet_send: ${flagLabel(ratchetSendFlag)} → effektiv ${ratchetSendEff ? "AN" : "AUS"}`,
      `  renex_pq_rekey:     ${flagLabel(pqRekeyFlag)} → effektiv ${pqRekeyEff ? "AN" : "AUS"}`,
      `  Rollout-Cache:      ${rolloutCacheJson}`,
      "  pqrk-Telemetrie:    " + (pqrkStatsJson ? pqrkStatsJson.split("\n").join("\n  ") : "(keine)"),
      "",
      "Re-Subscribe-Resultat:",
      "  " + (resubLog ? resubLog.split("\n").join("\n  ") : "(nicht ausgeführt)"),
      "",
      "Test-Push-Resultat:",
      "  " + (testResultJson ? testResultJson.split("\n").join("\n  ") : "(nicht ausgeführt)"),
    ];
    const text = lines.join("\n");

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;opacity:0;";
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    }
    copyState = "copied";
    setTimeout(() => { copyState = "idle"; }, 2000);
  }

  function close() { isOpen = false; }
  function onBackdropClick(e) {
    if (e.target.classList.contains("dbg-overlay")) close();
  }
</script>

{#if isOpen}
  <div class="dbg-overlay" role="presentation" onclick={onBackdropClick}>
    <div class="dbg-dialog" role="dialog" aria-labelledby="dbg-title" aria-modal="true">
      <div class="dbg-header">
        <h3 id="dbg-title">🛠️ {lang.debugTitle || "Debug / Diagnose"}</h3>
        <button class="close-btn" onclick={close} aria-label="Close">×</button>
      </div>

      <!-- Notifications & SW -->
      <div class="section">
        <div class="section-title">Notifications & Service Worker</div>
        <div class="grid">
          <div class="label">Notification.permission</div>
          <div class="value {notifPermClass}">{notifPerm}</div>
          <div class="label">Service Worker</div>
          <div class="value {swStateClass}">{swState}</div>
          <div class="label">Push Subscription</div>
          <div class="value {pushSubClass}">{pushSub}</div>
          <div class="label">setAppBadge API</div>
          <div class="value {badgeApiClass}">{badgeApi}</div>
        </div>
      </div>

      <!-- /push/status -->
      <div class="section">
        <div class="section-title">Backend — /push/status</div>
        <div class="output">{pushStatusJson || "(noch keine Daten)"}</div>
      </div>

      <!-- User & Device -->
      <div class="section">
        <div class="section-title">User & Device</div>
        <div class="grid">
          <div class="label">my_user</div>
          <div class="value">{userStore.myUser || "(not logged in)"}</div>
          <div class="label">deviceId</div>
          <div class="value">{userStore.deviceId.slice(0, 32)}…</div>
          <div class="label">App-Version</div>
          <div class="value">{document.querySelector('meta[name="renex-version"]')?.content || "(unknown)"}</div>
          <div class="label">PWA-Modus</div>
          <div class="value {isStandalone() ? 'ok' : 'warn'}">{isStandalone() ? "PWA (standalone)" : "Browser-Tab"}</div>
          <div class="label">User-Agent</div>
          <div class="value ua">{navigator.userAgent}</div>
        </div>
      </div>

      <!-- E2E / v4-Ratchet -->
      <div class="section">
        <div class="section-title">E2E — v4-Ratchet</div>
        <div class="grid">
          <div class="label">renex_ratchet_send</div>
          <div class="value">{flagLabel(ratchetSendFlag)}</div>
          <div class="label">→ v4 senden effektiv</div>
          <div class="value {ratchetSendEff ? 'ok' : 'warn'}">{ratchetSendEff ? "AN" : "AUS"}</div>
          <div class="label">renex_pq_rekey</div>
          <div class="value">{flagLabel(pqRekeyFlag)}</div>
          <div class="label">→ PQ-Rekey effektiv</div>
          <div class="value {pqRekeyEff ? 'ok' : 'warn'}">{pqRekeyEff ? "AN" : "AUS"}</div>
          <div class="label">Rollout-Cache</div>
          <div class="value ua">{rolloutCacheJson}</div>
        </div>
        <div class="actions">
          <button class="btn" onclick={() => cycleFlag('renex_ratchet_send')}>
            🔁 v4-Send → {nextFlagLabel(ratchetSendFlag)}
          </button>
          <button class="btn" onclick={() => cycleFlag('renex_pq_rekey')}>
            🔁 PQ-Rekey → {nextFlagLabel(pqRekeyFlag)}
          </button>
        </div>
        <div class="output">{pqrkStatsJson || "(keine pqrk-Telemetrie)"}</div>
        <div class="hint">
          Explizit ('1'/'0') übersteuert den Server-Rollout, (nicht gesetzt) = Server
          entscheidet. Wirkt sofort ohne Reload — die 1. Nachricht pro Peer primt
          (Legacy), ab der 2. läuft v4.
        </div>
      </div>

      <!-- Re-Subscribe Result -->
      <div class="section">
        <div class="section-title">Re-Subscribe-Resultat</div>
        <div class="output">{resubLog || "(noch keine Daten)"}</div>
      </div>

      <!-- Test-Push Result -->
      <div class="section">
        <div class="section-title">Test-Push-Resultat</div>
        <div class="output">{testResultJson || "(noch keine Daten)"}</div>
      </div>

      <!-- Actions -->
      <div class="actions">
        <button class="btn" onclick={refreshAll}>🔄 Refresh</button>
        <button class="btn primary" onclick={forceResubscribe} disabled={isResubbing}>
          {isResubbing ? "⏳ …" : "🔁 Re-Subscribe Now"}
        </button>
        <button class="btn primary" onclick={sendTestPush} disabled={isTesting}>
          {isTesting ? "⏳ Sende…" : "🔔 Test-Push senden"}
        </button>
        <button class="btn" onclick={copySnapshot}>
          {copyState === "copied" ? "✅ Kopiert!" : "📋 Alles kopieren"}
        </button>
        <button class="btn" onclick={toggleVoiceDebug}>
          {voiceDebugOn ? "📞 Voice-Debug AUS" : "📞 Voice-Debug AN"}
        </button>
      </div>

      <div class="hint">
        💡 Tipp: Sperre dein Telefon nach &quot;Test-Push senden&quot; und warte 5-10 Sekunden.
        Wenn du eine Push-Notification siehst → Notifications funktionieren.
        Wenn nicht: Status oben prüfen + Resultat in Zwischenablage kopieren.
      </div>
    </div>
  </div>
{/if}

<style>
  .dbg-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    z-index: 1200;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 12px;
    animation: fadeIn 0.15s ease-out;
  }

  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .dbg-dialog {
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 14px;
    padding: 20px;
    width: 100%;
    max-width: 560px;
    max-height: calc(100vh - 24px);
    max-height: calc(100dvh - 24px);
    overflow-y: auto;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.7);
  }

  .dbg-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 14px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .dbg-header h3 {
    margin: 0;
    font-size: 16px;
    color: var(--text-primary);
  }

  .close-btn {
    background: none;
    border: none;
    font-size: 22px;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
    line-height: 1;
  }

  .close-btn:hover {
    color: var(--text-primary);
    background: var(--bg-panel-alt);
  }

  .section {
    margin-bottom: 14px;
  }

  .section-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent-voice);
    margin-bottom: 6px;
  }

  .grid {
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: 4px 10px;
    font-size: 12px;
    line-height: 1.5;
  }

  .label {
    color: var(--text-muted);
  }

  .value {
    color: var(--text-primary);
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 11px;
    word-break: break-all;
  }

  .value.ok    { color: var(--status-success); }
  .value.warn  { color: var(--status-warn); }
  .value.error { color: var(--status-error); }
  .value.ua    { font-size: 10px; opacity: 0.75; }

  .output {
    background: #0a0a0d;
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 10px 12px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 11px;
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 200px;
    overflow-y: auto;
  }

  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 14px;
  }

  .btn {
    flex: 1 1 calc(50% - 4px);
    min-width: 120px;
    padding: 10px 12px;
    background: var(--bg-panel-alt);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn:hover:not(:disabled) {
    background: rgba(56, 189, 248, 0.1);
    border-color: var(--accent-voice);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn.primary {
    background: var(--accent-voice);
    color: #07070a;
    border-color: var(--accent-voice);
  }

  .btn.primary:hover:not(:disabled) {
    background: #0ea5e9;
  }

  .hint {
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1.5;
    margin-top: 12px;
    padding: 8px 10px;
    background: rgba(56, 189, 248, 0.06);
    border-left: 2px solid var(--accent-voice);
    border-radius: 4px;
  }
</style>
