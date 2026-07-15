<!--
  InviteLinkModal — Generiert + zeigt Einladungslink an
  Backend: POST /invite/create (mit oder ohne convoId)
   - Ohne convoId: 1:1-Einladung (Gast wird in einer neuen DM mit Einlader geguestet)
   - Mit convoId (group): Group-Einladung (Gast joint die Gruppe)

  Features:
   - Copy-to-Clipboard mit visueller Bestätigung
   - Ablauf-Datum + Message-Limit anzeigen
   - Web-Share-API auf Mobile (falls verfügbar)
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { toastStore } from '../stores/toast.svelte.js';
  import { apiFetch } from '../lib/api.js';
  import { captureException } from '../lib/sentry.js';

  /** @type {{ isOpen: boolean, convoId?: string|null, groupName?: string|null }} */
  let { isOpen = $bindable(false), convoId = null, groupName = null } = $props();

  let lang = $derived(i18nStore.lang);

  let isLoading = $state(false);
  let inviteUrl = $state(null);
  let inviteToken = $state(null);  // wird für /invite/revoke benötigt
  let expiresAt = $state(null);
  let msgLimit  = $state(null);
  let errorMsg = $state(null);
  let copied = $state(false);
  let revoking = $state(false);

  // ── Org-Modus (eGov 1.2): verifizierte Orgs sehen statt Auto-Create ein
  // Formular (Laufzeit, Anzahl/Labels) + Bulk-Ergebnis mit CSV + Invite-Liste.
  // Erkennung: GET /invite/list antwortet 200 nur für verifizierte Orgs.
  let orgMode     = $state(false);
  let orgInvites  = $state([]);      // bestehende Invites (Label↔Gast-Brücke)
  let orgDays     = $state(90);
  let orgCount    = $state(1);
  let orgLabels   = $state('');      // eine Zeile pro Empfänger (optional)
  let orgCreating = $state(false);
  let orgResults  = $state(null);    // frisch erstellte Invites (Bulk-Antwort)
  let orgCopiedIdx = $state(-1);

  $effect(() => {
    if (isOpen) {
      // Reset
      inviteUrl = null;
      inviteToken = null;
      expiresAt = null;
      msgLimit  = null;
      errorMsg = null;
      copied = false;
      revoking = false;
      orgMode = false;
      orgResults = null;
      orgCopiedIdx = -1;
      void init();
    }
  });

  async function init() {
    // Org-Modus nur für 1:1-Invites (Brief-/Serienbrief-Fall);
    // Gruppen-Invites behalten den bisherigen Consumer-Flow.
    if (!convoId) {
      isLoading = true;
      try {
        const probe = await apiFetch('/invite/list');
        if (probe.ok) {
          orgMode = true;
          orgInvites = probe.data?.invites || [];
          isLoading = false;
          return;   // Org: Formular zeigen statt sofort erstellen
        }
      } catch { /* kein Org / offline → Consumer-Flow */ }
    }
    void create();
  }

  const _labelLines = () => orgLabels.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  let orgEffectiveCount = $derived(_labelLines().length || orgCount);

  async function orgCreate() {
    if (orgCreating) return;
    orgCreating = true;
    errorMsg = null;
    try {
      const labels = _labelLines();
      const body = { expiresInDays: orgDays, ...(labels.length ? { labels } : { count: orgCount }) };
      const r = await apiFetch('/invite/bulk', { method: 'POST', body });
      if (r.ok && Array.isArray(r.data?.invites)) {
        orgResults = r.data.invites;
        // Liste auffrischen (neue Templates erscheinen als "open")
        const list = await apiFetch('/invite/list');
        if (list.ok) orgInvites = list.data?.invites || [];
      } else if (r.status === 429) {
        errorMsg = lang.inviteRateLimit || 'Zu viele Einladungen — bitte später erneut versuchen.';
      } else {
        errorMsg = r.data?.error || lang.inviteCreateFailed || 'Einladungen konnten nicht erstellt werden';
      }
    } catch (e) {
      captureException(e, { context: 'invite.bulk' });
      errorMsg = lang.inviteCreateFailed || 'Einladungen konnten nicht erstellt werden';
    } finally {
      orgCreating = false;
    }
  }

  async function orgCopy(url, idx) {
    try {
      await navigator.clipboard.writeText(url);
      orgCopiedIdx = idx;
      setTimeout(() => { orgCopiedIdx = -1; }, 1500);
    } catch { /* still */ }
  }

  // CSV für die Serienbrief-Software: Semikolon (Excel-CH), BOM für Umlaute.
  function orgDownloadCsv() {
    if (!orgResults?.length) return;
    const esc = (c) => '"' + String(c ?? '').replace(/"/g, '""') + '"';
    const rows = [
      ['label', 'inviteUrl', 'gueltig_bis'],
      ...orgResults.map((i) => [i.label || '', i.inviteUrl, new Date(i.expiresAt).toISOString().slice(0, 10)]),
    ];
    const csv = '\uFEFF' + rows.map((r) => r.map(esc).join(';')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'renex-einladungen.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const orgStatusLabel = (s) => ({
    open:      lang.orgStatusOpen      || 'offen',
    consumed:  lang.orgStatusConsumed  || 'eingelöst',
    active:    lang.orgStatusActive    || 'aktiv',
    expired:   lang.orgStatusExpired   || 'abgelaufen',
    converted: lang.orgStatusConverted || 'Konto erstellt',
  }[s] || s);

  async function create() {
    isLoading = true;
    errorMsg = null;
    try {
      const body = convoId ? { convoId } : {};
      const r = await apiFetch('/invite/create', { method: 'POST', body });
      if (r.ok && r.data?.inviteUrl) {
        inviteUrl = r.data.inviteUrl;
        inviteToken = r.data.token || null;
        expiresAt = r.data.expiresAt || null;
        msgLimit  = r.data.msgLimit || null;
      } else if (r.status === 429) {
        errorMsg = lang.inviteRateLimit || 'Zu viele Einladungen — bitte später erneut versuchen.';
      } else {
        errorMsg = r.data?.error || lang.inviteCreateFailed || 'Einladungslink konnte nicht erstellt werden';
      }
    } catch (e) {
      captureException(e, { context: 'invite.create' });
      errorMsg = lang.inviteCreateFailed || 'Einladungslink konnte nicht erstellt werden';
    } finally {
      isLoading = false;
    }
  }

  async function copyLink() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      copied = true;
      setTimeout(() => { copied = false; }, 2000);
    } catch (e) {
      // Fallback: select+execCommand wäre Legacy — bei Clipboard-API-Fail einfach Fehler zeigen
      errorMsg = lang.copyFailed || 'Kopieren nicht möglich — Link manuell auswählen';
    }
  }

  async function revoke() {
    if (!inviteToken || revoking) return;
    const msg = lang.inviteRevokeConfirm || 'Diesen Einladungslink widerrufen? Er wird sofort ungültig.';
    if (!confirm(msg)) return;
    revoking = true;
    try {
      const r = await apiFetch('/invite/revoke', {
        method: 'POST',
        body: { token: inviteToken },
      });
      if (r.ok) {
        toastStore.push(lang.inviteRevokeSuccess || 'Einladungslink widerrufen', { kind: 'success' });
        close();
      } else {
        toastStore.push(lang.inviteRevokeFailed || 'Widerruf fehlgeschlagen', { kind: 'error' });
      }
    } catch (e) {
      captureException(e, { context: 'invite.revoke' });
      toastStore.push(lang.inviteRevokeFailed || 'Widerruf fehlgeschlagen', { kind: 'error' });
    } finally {
      revoking = false;
    }
  }

  async function shareLink() {
    if (!inviteUrl) return;
    if (!navigator.share) return;
    try {
      await navigator.share({
        title: 'RENEX',
        text: lang.inviteShareText || 'Hi! Schreib mir auf RENEX — ohne Account.',
        url: inviteUrl,
      });
    } catch {
      // User-Cancel ist kein Fehler
    }
  }

  function close() {
    isOpen = false;
  }

  function onBackdrop(e) {
    if (e.target.classList.contains('inv-overlay')) close();
  }

  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }

  // Format expiresAt
  let expiresDisplay = $derived.by(() => {
    if (!expiresAt) return null;
    const d = new Date(expiresAt);
    return d.toLocaleString(lang.locale || 'de-DE', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  });

  // Title je nach Kontext
  let titleText = $derived(
    convoId
      ? (lang.inviteToGroupTitle || 'In Gruppe einladen').replace('{name}', groupName || '')
      : orgMode
        ? (lang.orgInviteTitle || 'Bürger-Einladungen (Organisation)')
        : (lang.invite1to1Title || 'Person einladen (1:1)')
  );

  let canShare = $derived(
    inviteUrl && typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  );
</script>

{#if isOpen}
  <div class="inv-overlay" role="presentation" onclick={onBackdrop}>
    <div
      class="inv-dialog"
      role="dialog"
      aria-labelledby="inv-title"
      aria-modal="true"
      tabindex="-1"
      onkeydown={onKeydown}
    >
      <div class="inv-header">
        <h3 id="inv-title">{titleText}</h3>
        <button class="close-btn" onclick={close} aria-label="Close">×</button>
      </div>

      {#if isLoading}
        <div class="inv-loading">
          <span class="spinner"></span>
          {lang.creatingInvite || 'Einladungslink wird erstellt…'}
        </div>
      {:else if orgMode}
        <!-- ── Org-Modus (eGov 1.2): Bulk-Issuance + Label/CSV + Invite-Liste ── -->
        <p class="inv-hint">
          {lang.orgInviteHint || 'Langlebige Einladungen für Bürger — per QR-Karte übergeben oder als Brief verschicken. Eine Einladung = eine Person.'}
        </p>

        {#if errorMsg}
          <div class="inv-error">{errorMsg}</div>
        {/if}

        <div class="org-form">
          <label class="org-field">
            <span>{lang.orgDaysLabel || 'Gültigkeit (Tage)'}</span>
            <input type="number" min="1" max="365" bind:value={orgDays} />
          </label>
          <label class="org-field">
            <span>{lang.orgCountLabel || 'Anzahl'}</span>
            <input type="number" min="1" max="500" bind:value={orgCount} disabled={_labelLines().length > 0} />
          </label>
          <label class="org-field org-field-wide">
            <span>{lang.orgLabelsLabel || 'Empfänger-Referenzen (optional, eine pro Zeile — bestimmt die Anzahl)'}</span>
            <textarea rows="3" bind:value={orgLabels}
              placeholder={lang.orgLabelsPlaceholder || 'Mitglied Müller\nPatientin 0042\n…'}></textarea>
          </label>
          <button class="share-btn" onclick={orgCreate} disabled={orgCreating} type="button">
            {orgCreating ? '…' : '✉️'} {(lang.orgCreateBtn || '{n} Einladung(en) erstellen').replace('{n}', String(orgEffectiveCount))}
          </button>
        </div>

        {#if orgResults?.length}
          <div class="org-results">
            <div class="org-section-title">
              {lang.orgResultsTitle || 'Neu erstellt'} ({orgResults.length})
              <button class="copy-btn" onclick={orgDownloadCsv} type="button">⬇ {lang.orgCsvBtn || 'CSV'}</button>
            </div>
            <div class="org-list">
              {#each orgResults as inv, idx}
                <div class="org-row">
                  <span class="org-label">{inv.label || '—'}</span>
                  <button class="copy-btn" class:copied={orgCopiedIdx === idx} onclick={() => orgCopy(inv.inviteUrl, idx)} type="button">
                    {orgCopiedIdx === idx ? '✓' : '📋'} {lang.copy || 'Kopieren'}
                  </button>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <div class="org-section-title">{lang.orgExistingTitle || 'Bestehende Einladungen'}</div>
        {#if orgInvites.length === 0}
          <p class="inv-hint">{lang.orgNoInvites || 'Noch keine Einladungen.'}</p>
        {:else}
          <div class="org-list">
            {#each orgInvites as inv}
              <div class="org-row">
                <span class="org-label">{inv.label || (inv.guestHandle || '—')}</span>
                <span class="org-status org-status-{inv.status}">{orgStatusLabel(inv.status)}</span>
                {#if inv.status === 'active' && inv.msgCount !== null}
                  <span class="org-meta">✉ {inv.msgCount}</span>
                {/if}
                {#if inv.inviteUrl}
                  <button class="copy-btn" onclick={() => orgCopy(inv.inviteUrl, -2)} type="button" title={lang.copy || 'Kopieren'}>📋</button>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      {:else if errorMsg}
        <div class="inv-error">{errorMsg}</div>
      {:else if inviteUrl}
        <p class="inv-hint">
          {convoId
            ? (lang.inviteGroupHint || 'Sende diesen Link an Personen die deiner Gruppe beitreten sollen — sie chatten als Gast (kein Account nötig).')
            : (lang.invite1to1Hint || 'Sende diesen Link an die Person mit der du chatten willst — sie chattet als Gast (kein Account nötig).')}
        </p>

        <div class="link-row">
          <input
            type="text"
            class="link-input"
            value={inviteUrl}
            readonly
            onclick={(e) => e.target.select()}
          />
          <button
            class="copy-btn"
            class:copied
            onclick={copyLink}
            aria-label="Copy link"
          >
            {#if copied}
              ✓ {lang.copied || 'Kopiert'}
            {:else}
              📋 {lang.copy || 'Kopieren'}
            {/if}
          </button>
        </div>

        {#if canShare}
          <button class="share-btn" onclick={shareLink}>
            ↗ {lang.shareBtn || 'Teilen'}
          </button>
        {/if}

        <div class="meta-grid">
          {#if expiresDisplay}
            <div class="meta">
              <div class="meta-label">{lang.expiresAt || 'Gültig bis'}</div>
              <div class="meta-value">{expiresDisplay}</div>
            </div>
          {/if}
          {#if msgLimit}
            <div class="meta">
              <div class="meta-label">{lang.guestMsgLimit || 'Gast-Nachrichten'}</div>
              <div class="meta-value">{msgLimit}</div>
            </div>
          {/if}
        </div>

        {#if inviteToken}
          <button
            class="revoke-btn"
            onclick={revoke}
            disabled={revoking}
            type="button"
          >
            {revoking ? '…' : '🗑️'} {lang.inviteRevokeBtn || 'Widerrufen'}
          </button>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .inv-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    z-index: 1100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    animation: fadeIn 0.15s ease-out;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .inv-dialog {
    background: var(--bg-panel);
    border: 1px solid var(--border-panel);
    border-radius: 14px;
    padding: 22px;
    width: 100%;
    max-width: 440px;
    max-height: calc(100vh - 32px);
    max-height: calc(100dvh - 32px);
    overflow-y: auto;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
  }

  .inv-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 14px;
  }
  .inv-header h3 { margin: 0; font-size: 16px; color: var(--text-primary); }

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
  .close-btn:hover { color: var(--text-primary); background: var(--bg-panel-alt); }

  .inv-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 28px;
    color: var(--text-muted);
    font-size: 13px;
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--border-subtle);
    border-top-color: var(--accent-voice);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .inv-error {
    padding: 10px 12px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid var(--status-error);
    border-radius: 8px;
    color: var(--status-error);
    font-size: 12px;
  }

  .inv-hint {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0 0 14px 0;
  }

  .link-row {
    display: flex;
    gap: 6px;
    margin-bottom: 10px;
  }

  .link-input {
    flex: 1;
    padding: 10px 12px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    color: var(--text-primary);
    font-size: 12px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    min-width: 0;
  }
  .link-input:focus { border-color: var(--accent-voice); outline: none; }

  .copy-btn {
    padding: 8px 14px;
    background: var(--accent-voice);
    color: #07070a;
    border: none;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .copy-btn:hover { background: #0ea5e9; }
  .copy-btn.copied { background: var(--status-success); }

  .share-btn {
    width: 100%;
    padding: 10px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    color: var(--text-primary);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    margin-bottom: 14px;
  }
  .share-btn:hover {
    background: var(--accent-voice-dim);
    border-color: var(--accent-voice);
    color: var(--accent-voice);
  }

  .meta-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border-subtle);
  }

  .meta { font-size: 11px; }
  .meta-label {
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 700;
    margin-bottom: 4px;
  }
  .meta-value {
    color: var(--text-primary);
    font-size: 13px;
    font-weight: 600;
  }

  .revoke-btn {
    display: block;
    width: 100%;
    margin-top: 14px;
    padding: 8px;
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .revoke-btn:hover:not(:disabled) {
    color: var(--status-error);
    border-color: var(--status-error);
    background: rgba(239, 68, 68, 0.06);
  }
  .revoke-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ── Org-Modus (eGov 1.2) ─────────────────────────── */
  .org-form {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 14px;
  }
  .org-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--text-muted);
    flex: 1 1 45%;
  }
  .org-field-wide { flex: 1 1 100%; }
  .org-field input, .org-field textarea {
    background: var(--bg-input, rgba(255,255,255,0.04));
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    color: var(--text-primary);
    padding: 8px;
    font-size: 13px;
    font-family: inherit;
  }
  .org-section-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 14px 0 6px;
  }
  .org-list {
    max-height: 180px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .org-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    font-size: 12.5px;
  }
  .org-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .org-status {
    flex-shrink: 0;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    background: rgba(255,255,255,0.06);
    color: var(--text-muted);
  }
  .org-status-active   { background: rgba(60,228,122,0.12);  color: var(--status-speaking, #3CE47A); }
  .org-status-open     { background: rgba(56,189,248,0.12);  color: var(--accent-voice, #38BDF8); }
  .org-status-expired,
  .org-status-consumed { opacity: 0.7; }
  .org-meta { flex-shrink: 0; color: var(--text-muted); font-size: 11px; }
</style>
