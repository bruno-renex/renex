<!--
  GuestBanner — Info-Banner über dem ChatView wenn User ein Gast ist.

  Zeigt:
    - Countdown bis zur Session-Expiry (re-rendert jede Minute)
    - Verbleibende Nachrichten (msgsLeft) — pollt /invite/ping alle 60s
    - Button "Account erstellen" → setzt pendingGuestConvert + öffnet LoginModal
      via URL-Param ?registerGuest=1

  Backend-Endpoint: POST /invite/ping liefert msgCount/msgLimit/remainingMs.

  Wird in App.svelte nur für userStore.isGuest gerendert.
-->
<script>
  import { onMount, onDestroy } from 'svelte';
  import { apiFetch } from '../lib/api.js';
  import { i18nStore } from '../stores/i18n.svelte.js';

  let lang = $derived(i18nStore.lang);

  // Initial-State aus localStorage.guestSession (gesetzt von /join/...)
  function _readGuestSession() {
    try {
      const raw = localStorage.getItem('guestSession');
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : null;
    } catch { return null; }
  }

  const _initial = _readGuestSession();
  let expiresAt = $state(_initial?.expiresAt || null);
  let msgLimit  = $state(_initial?.msgLimit ?? null);
  let msgCount  = $state(_initial?.msgCount ?? 0);

  // Live-Tick für Countdown (jede 30s rerendert)
  let _now = $state(Date.now());
  let _tickInterval = null;
  let _pingInterval = null;

  // Polling für aktuelle Werte vom Backend
  async function _ping() {
    try {
      const r = await apiFetch('/invite/ping', { method: 'POST' });
      if (r.ok && r.data) {
        if (typeof r.data.msgCount === 'number') msgCount = r.data.msgCount;
        if (typeof r.data.msgLimit === 'number') msgLimit = r.data.msgLimit;
        if (typeof r.data.expiresAt === 'number') expiresAt = r.data.expiresAt;
      }
    } catch { /* silent — Banner zeigt cached values */ }
  }

  // Live-Update bei eigenem Send: chatStore.sendMessage dispatched
  // 'renex:guest-message-sent' nach erfolgreichem /chat/send. Wir
  // inkrementieren msgCount optimistic + triggern einen frischen Ping
  // mit kleiner Verzögerung (gibt dem Backend Zeit das D1-INSERT zu
  // commiten). Vorher: User sah den Counter erst nach dem nächsten
  // 60s-Ping aktualisiert — fühlte sich kaputt an.
  function _onMessageSent() {
    msgCount = msgCount + 1;
    setTimeout(_ping, 1500);
  }

  onMount(() => {
    _tickInterval = setInterval(() => { _now = Date.now(); }, 30_000);
    // Polling auf 30s reduziert (vorher 60s) — schneller Sync mit
    // Backend bei eingehenden Messages anderer Devices/Members,
    // bei denen das CustomEvent nicht greift.
    _pingInterval = setInterval(_ping, 30_000);
    // Initial ping um aktuelle Werte zu holen (Backend ist source of truth)
    void _ping();
    window.addEventListener('renex:guest-message-sent', _onMessageSent);
  });

  onDestroy(() => {
    if (_tickInterval) clearInterval(_tickInterval);
    if (_pingInterval) clearInterval(_pingInterval);
    window.removeEventListener('renex:guest-message-sent', _onMessageSent);
  });

  // ── Derived UI-Strings ──────────────────────────────────────
  let remainingMs = $derived(expiresAt ? Math.max(0, expiresAt - _now) : null);
  let isExpired = $derived(remainingMs !== null && remainingMs === 0);
  let msgsLeft = $derived(msgLimit !== null ? Math.max(0, msgLimit - msgCount) : null);
  let isMsgLimitReached = $derived(msgsLeft === 0);

  // Format remaining time: "1h 23min" / "45min" / "30s"
  let remainingText = $derived.by(() => {
    if (remainingMs === null) return '';
    if (isExpired) return lang.guestSessionExpired || 'abgelaufen';
    const totalSec = Math.floor(remainingMs / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}min`;
    if (m > 0) return `${m}min`;
    return `${s}s`;
  });

  // ── "Account erstellen"-Flow ────────────────────────────────
  // Setzt pendingGuestConvert (für post-register migration) und redirected
  // zur Login-Page mit ?registerGuest=1 — dort öffnet App.svelte den Passkey-
  // Register-Flow. Nach erfolgreicher Registrierung läuft performGuestConvert().
  function onCreateAccount() {
    const sess = _readGuestSession();
    if (!sess?.token) return;
    try {
      sessionStorage.setItem('pendingGuestConvert', JSON.stringify({
        token:           sess.token,
        convoId:         sess.convoId,
        convoType:       sess.convoType,
        inviterHandle:   sess.inviterHandle,
        // Wichtig: oldGuestHandle (z.B. 'guest_d1f75096') brauchen wir nach dem
        // Convert um IDB-Keys von cmk:guest_xxx:peer → cmk:realHandle:peer
        // umzubenennen + Storage-Key (per-pair Handle-abhängig) zu re-encrypten.
        // Wird in App.svelte $effect an migrateMyHandle() übergeben.
        oldGuestHandle:  sess.guestHandle,
      }));
    } catch {}
    window.location.href = '/?registerGuest=1';
  }
</script>

<div class="guest-banner" class:expired={isExpired || isMsgLimitReached}>
  <div class="info">
    {#if isExpired}
      <span class="warn">⚠️ {lang.guestSessionExpired || 'Gast-Session abgelaufen'}</span>
    {:else if isMsgLimitReached}
      <span class="warn">⚠️ {lang.guestMsgLimitReached || 'Nachrichten-Limit erreicht'}</span>
    {:else}
      {#if remainingText}
        <span class="chip" title={lang.guestSessionExpiresIn || 'Session läuft ab in'}>
          ⏱ {remainingText}
        </span>
      {/if}
      {#if msgsLeft !== null}
        <span class="chip" title={lang.guestMessagesLeft || 'Verbleibende Nachrichten'}>
          ✉️ {msgsLeft}{msgLimit !== null ? '/' + msgLimit : ''}
        </span>
      {/if}
    {/if}
  </div>
  <button class="cta" onclick={onCreateAccount} type="button">
    🔑 {lang.guestCreateAccount || 'Account erstellen'}
  </button>
</div>

<style>
  .guest-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 14px;
    background: linear-gradient(90deg, rgba(0, 195, 255, 0.08), rgba(0, 195, 255, 0.02));
    border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
    font-size: 13px;
    flex-shrink: 0;
  }

  .guest-banner.expired {
    background: linear-gradient(90deg, rgba(239, 68, 68, 0.14), rgba(239, 68, 68, 0.04));
  }

  .info {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    min-width: 0;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.06);
    color: var(--text-muted, #aaa);
    white-space: nowrap;
  }

  .warn {
    color: var(--status-error, #ef4444);
    font-weight: 600;
  }

  .cta {
    flex-shrink: 0;
    padding: 6px 12px;
    border-radius: 8px;
    border: 1px solid var(--accent, #00c3ff);
    background: transparent;
    color: var(--accent, #00c3ff);
    font-weight: 600;
    cursor: pointer;
    font-size: 13px;
    transition: background 0.15s, color 0.15s;
  }

  .cta:hover {
    background: var(--accent, #00c3ff);
    color: #07070a;
  }

  /* Mobile: kompakter */
  @media (max-width: 480px) {
    .guest-banner {
      padding: 6px 10px;
      font-size: 12px;
    }
    .cta {
      padding: 5px 9px;
      font-size: 12px;
    }
  }
</style>
