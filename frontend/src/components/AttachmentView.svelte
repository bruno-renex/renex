<!--
  AttachmentView — Rendert ein Attachment in einer Message-Bubble.

  - 'photo' → Inline-Thumbnail (lazy-decrypt), klick = Vollbild-Lightbox
  - 'file'  → Datei-Card mit Name, Größe, Download-Button

  Crypto-Flow läuft komplett über lib/downloadHelper.js (Cache pro r2Key).
  Server bekommt nur den verschlüsselten Body — keine OCR/Image-Analyse möglich.
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';
  import { toastStore } from '../stores/toast.svelte.js';
  import { getAttachmentBlobUrl, downloadAttachment } from '../lib/downloadHelper.js';
  import { captureException } from '../lib/sentry.js';

  let { attachment } = $props();

  let lang = $derived(i18nStore.lang);

  let blobUrl   = $state(null);
  let loadErr   = $state(null);
  let isLoading = $state(false);
  let lightbox  = $state(false);

  // Wenn Optimistic-Photo vorhanden (eigene gerade-gesendete Message): wir haben
  // die Bytes lokal — aber `attachment` enthält sie hier nicht direkt.
  // Falls fileKey/iv da sind → entschlüsseln. Wenn nur key (Plaintext-Server-
  // Daten ohne fileKey, z.B. legacy GIF-Records) → Direct-URL ist eh nicht möglich.
  let canDecrypt = $derived(
    !!(attachment?.key && attachment?.fileKey && attachment?.iv)
  );

  $effect(() => {
    // Beim ersten Render mit allen nötigen Feldern: decrypten + Blob-URL holen.
    if (attachment?.type === 'photo' && canDecrypt && !blobUrl && !loadErr && !isLoading) {
      void _load();
    }
  });

  async function _load() {
    isLoading = true;
    loadErr = null;
    try {
      const { url } = await getAttachmentBlobUrl({
        r2Key:    attachment.key,
        fileKey:  attachment.fileKey,
        iv:       attachment.iv,
        mimeType: attachment.mimeType,
      });
      blobUrl = url;
    } catch (e) {
      loadErr = e?.message || 'load_failed';
      // 404/403 sind „expected" (Auto-Delete oder Convo-Wechsel) — nicht zu Sentry.
      if (!['attachment_gone', 'attachment_forbidden'].includes(loadErr)) {
        captureException(e, { context: 'AttachmentView.load', type: attachment?.type });
      }
    } finally {
      isLoading = false;
    }
  }

  async function onDownload() {
    if (!canDecrypt) return;
    try {
      await downloadAttachment({
        r2Key:    attachment.key,
        fileKey:  attachment.fileKey,
        iv:       attachment.iv,
        mimeType: attachment.mimeType,
      }, attachment.fileName || 'download');
    } catch (e) {
      const code = e?.message;
      const msg =
        code === 'attachment_gone'      ? (lang.attachmentGone      || 'Datei nicht mehr verfügbar.')
      : code === 'attachment_forbidden' ? (lang.attachmentForbidden || 'Kein Zugriff.')
      :                                   (lang.downloadFailed      || 'Download fehlgeschlagen.');
      toastStore.push(msg, { kind: 'error' });
    }
  }

  function openLightbox() { if (blobUrl) lightbox = true; }
  function closeLightbox() { lightbox = false; }
  function onLightboxKey(e) { if (e.key === 'Escape') closeLightbox(); }

  function _formatSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
</script>

{#if attachment?.type === 'gif'}
  <!-- GIF: nicht E2E-encrypted; URL kommt direkt vom GIPHY-CDN.
       Privacy-Trade-off ist in der DSE Sektion 9 dokumentiert. -->
  {#if attachment.gifUrl}
    <div class="att-gif">
      <img src={attachment.gifUrl} alt="" loading="lazy" />
    </div>
  {/if}
{:else if attachment?.type === 'photo'}
  <div class="att-photo">
    {#if blobUrl}
      <button type="button" class="thumb-btn" onclick={openLightbox} aria-label={lang.openPhoto || 'Foto öffnen'}>
        <img src={blobUrl} alt={attachment.fileName || ''} loading="lazy" />
      </button>
    {:else if loadErr}
      <div class="att-error">
        ⚠️ {loadErr === 'attachment_gone'
          ? (lang.attachmentGone || 'Foto nicht mehr verfügbar')
          : (lang.attachmentLoadFailed || 'Foto-Download fehlgeschlagen')}
      </div>
    {:else}
      <div class="att-loading">
        <span class="spinner"></span>
        {lang.loadingPhoto || 'Lade Foto…'}
      </div>
    {/if}
  </div>
{:else if attachment?.type === 'file'}
  <button class="att-file" type="button" onclick={onDownload} disabled={!canDecrypt}>
    <span class="att-file-icon">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
    </span>
    <span class="att-file-info">
      <span class="att-file-name">{attachment.fileName || (lang.downloadBtn || 'Download')}</span>
      <span class="att-file-meta">
        {_formatSize(attachment.fileSize)}
        {#if !canDecrypt} · 🔐 {lang.attachmentLocked || 'wartet auf Schlüssel'}{/if}
      </span>
    </span>
    <span class="att-file-action">⬇</span>
  </button>
{/if}

{#if lightbox && blobUrl}
  <div
    class="lightbox"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    onclick={closeLightbox}
    onkeydown={onLightboxKey}
  >
    <img src={blobUrl} alt={attachment.fileName || ''} />
    <button class="lightbox-close" type="button" onclick={(e) => { e.stopPropagation(); closeLightbox(); }} aria-label="Close">×</button>
  </div>
{/if}

<style>
  .att-gif {
    margin: 4px 0;
    max-width: 280px;
  }
  .att-gif img {
    display: block;
    max-width: 280px;
    max-height: 280px;
    width: 100%;
    height: auto;
    border-radius: 10px;
    background: var(--bg-panel-alt);
  }

  .att-photo {
    margin: 4px 0;
    max-width: 280px;
  }
  .thumb-btn {
    display: block;
    border: none;
    background: transparent;
    padding: 0;
    cursor: zoom-in;
    border-radius: 10px;
    overflow: hidden;
    line-height: 0;
  }
  .thumb-btn img {
    display: block;
    max-width: 280px;
    max-height: 280px;
    width: 100%;
    height: auto;
    border-radius: 10px;
    background: var(--bg-panel-alt);
  }

  .att-loading,
  .att-error {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 16px 14px;
    background: var(--bg-panel-alt);
    border-radius: 10px;
    color: var(--text-muted);
    font-size: 12px;
    min-width: 180px;
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--border-subtle);
    border-top-color: var(--accent-voice);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .att-file {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    margin: 4px 0;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    color: var(--text-primary);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
    max-width: 320px;
    width: 100%;
  }
  .att-file:hover:not(:disabled) {
    background: var(--accent-voice-dim);
    border-color: var(--accent-voice);
  }
  .att-file:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .att-file-icon {
    color: var(--accent-voice);
    flex-shrink: 0;
  }
  .att-file-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .att-file-name {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .att-file-meta {
    font-size: 11px;
    color: var(--text-muted);
  }
  .att-file-action {
    color: var(--accent-voice);
    font-size: 16px;
    flex-shrink: 0;
  }

  .lightbox {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.92);
    z-index: 2000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    cursor: zoom-out;
  }
  .lightbox img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .lightbox-close {
    position: absolute;
    top: 16px;
    right: 18px;
    background: rgba(0, 0, 0, 0.4);
    color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.25);
    border-radius: 50%;
    width: 36px;
    height: 36px;
    font-size: 22px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }
</style>
