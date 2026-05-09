# RENEX Attachment-Spec

E2E-verschlüsselte Photo- + File-Anhänge.

Status: **Phase 1 (Photo + File Basics)**, ausgerollt 2026-05-08.

## Strategische Leitlinien

| Prinzip | Wie eingehalten |
|---|---|
| **1. Passkey-Only** | Upload-Endpoint nutzt `requireSession` (Passkey-Cookie). Keine zusätzlichen Credentials. |
| **2. AI-Free** | Server speichert nur opaque encrypted bytes. Keine Server-Side OCR, Image-Recognition oder Content-Moderation. EXIF-Strip + Resize geschehen client-side **vor** Encrypt — kein AI-trainables Material erreicht den Server. |
| **3. Open Standard** | Dieses Dokument. AES-GCM-256, HKDF nur dort wo nötig (Storage-Key), sonst Random-Per-File-Key. WebCrypto-only, kein proprietäres Crypto. |
| **4. Privacy by Default** | Filename, MIME, fileKey, IV gehen **encrypted** im Message-Body durch die normale E2E-Pipeline. Server sieht nur: `attachment_key` (R2-Pfad) + `attachment_type` (`photo`/`file`/`gif`). MIME-Type geht als HTTP-Header **nur zur Validierung** und wird nach Save nicht persistiert. |
| **5. Gamer-First UX** | Inline-Photo-Thumbnail in Bubble + Vollbild-Lightbox, Blob-URL-Cache pro `r2Key` (kein doppelter Decrypt), Photo-Resize auf 2048 px / 2 MB für niedrige Latenz. |

## Datenfluss — Send

```
1. User picks file → File-Picker im ChatInput
2. Wenn Photo + (>2 MB ODER >2048 px):
   2a. createImageBitmap → Canvas-Resize → JPEG q=0.86
   2b. Re-Encode entfernt EXIF (Geo, Device-ID) automatisch
3. Generate per-file Random:
   - fileKey: 32 Bytes (AES-GCM-256)
   - iv:      12 Bytes
4. encrypted = AES-GCM-256(fileKey, iv, plaintextBytes)
5. POST /upload/file
   Headers: X-Mime-Type, X-File-Name, X-File-Size, X-Attachment-Type, X-Convo-Id
   Body:    encrypted bytes
   Server:  validiert MIME-Whitelist, Größe, Membership → R2.put → returnt r2Key
6. message_plaintext = "__rx_a1__\n" + JSON.stringify({
     t: caption,
     a: { type, r2Key, fileKey: b64, iv: b64, fileName, mimeType, fileSize }
   })
7. Normale E2E-Pipeline encryptet message_plaintext → /chat/send
8. Body zusätzlich: { attachmentKey: r2Key, attachmentType: 'photo'|'file' }
   → DB für Cleanup-Cron + Display ohne Decrypt
```

## Datenfluss — Receive

```
1. /chat/list liefert Message inkl. attachment_key + attachment_type
2. _normalizeMessage → m.attachment = { type, key }  (Plaintext-Stub)
3. _decryptOne entschlüsselt Message-Body
4. unwrapAttachmentPlaintext(decryptedText) →
   - Magic-Prefix erkannt → caption + attachmentMeta extracted
   - sonst: bare String (alte Messages, kein Attachment)
5. m.attachment angereichert mit fileKey, iv, fileName, mimeType, fileSize
6. AttachmentView rendert:
   - 'photo' → getAttachmentBlobUrl(meta) → <img src="blob:...">
   - 'file'  → Card mit downloadAttachment(meta) Button
```

## Crypto-Primitive

- **Cipher**: AES-GCM-256
- **IV**: 12 Bytes random pro Datei (NIST SP 800-38D §8.2.2)
- **Tag**: 16 Bytes (default WebCrypto AES-GCM)
- **Key-Source**: `crypto.getRandomValues(new Uint8Array(32))` — pro Datei einmalig, nicht abgeleitet
- **Birthday-Bound**: ein Random-Key wird nur einmal benutzt → kein IV-Kollisions-Risiko

## R2-Layout

```
files/{convoId}/{uuid}
```

- `convoId`: UUID (Group) ODER `handle:handle` (DM, alphabetisch sortiert)
- `uuid`: `crypto.randomUUID()` server-seitig generiert
- Path-Traversal blockiert (`..`, `//`)
- Storage-Class: Standard, Auto-Delete via Cron (siehe `cron.js`)

## Server-Seite — was bekannt / unbekannt

**Backend kennt** (D1 + R2):
- `messages.attachment_key` — R2-Pfad
- `messages.attachment_type` — `photo` / `file` / `gif`
- R2-Object-Size implizit
- Beim Upload temporär: MIME-Type (für Whitelist), File-Name (für Blocked-Extension-Check), File-Size — nichts davon wird persistiert

**Backend kennt NICHT**:
- File-Inhalt (encrypted)
- File-Key
- File-Name beim Receiver
- Original-MIME nach dem Upload
- Caption / Reply-Text (encrypted im Message-Body)

## MIME-Whitelist

Photo: `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif`

File: `application/pdf`, MS-Office (doc/docx/xls/xlsx/ppt/pptx), `application/zip`, `text/calendar`, `image/gif`, `text/plain`

Blocked Extensions (zusätzlich): `.exe`, `.dmg`, `.sh`, `.bat`, `.apk`, `.msi`, `.cmd`, `.ps1`, `.vbs`, `.jar`, `.com`, `.scr`, `.pif`, `.reg`, `.dll`

## Limits

| Was | Wert |
|---|---|
| File-Size | 10 MB |
| Photo-Resize Trigger | >2 MB ODER >2048 px |
| Photo-Resize Output | JPEG q=0.86, max 2048 px lange Seite |
| Upload-Rate-Limit | 20 / Min / User |
| Auto-Delete | wie für Text-Messages — entfernt R2-Object via Cron |

## GIFs (GIPHY-Privacy-Proxy)

GIFs sind ein Sonderfall — sie werden **nicht** in R2 gespeichert und **nicht** verschlüsselt. Stattdessen wird die GIPHY-CDN-URL E2E-encrypted im Message-Body übertragen, der Empfänger lädt das GIF direkt vom GIPHY-CDN beim Anzeigen.

### Warum nicht E2E?

GIFs sind öffentliche Inhalte aus einem öffentlichen Katalog. Sie zu encrypten würde nichts schützen (jeder kann das gleiche GIF auch direkt suchen) und 5-10 MB extra Bandbreite + R2-Cost pro GIF kosten.

### Privacy-Trade-off

| Server kennt | GIPHY-CDN kennt |
|---|---|
| dass die Message ein GIF enthält (`attachment_type='gif'`) | IP-Adresse + UA des Anzeigenden (beim Image-Load) |
| **nicht** welches GIF (URL ist E2E-encrypted) | nicht den Handle, nicht den Suchbegriff |

Der Suchbegriff geht über unseren Worker-Proxy (`/gif/search`) — GIPHY sieht **nicht** die IP des Suchenden, da der Worker als Origin fungiert. Suchbegriffe werden im Worker **nicht geloggt**.

### Datenfluss — GIF-Send

```
1. User klickt GIF-Button → GifPickerModal öffnet
2. Trending-GIFs laden via apiFetch('/gif/search')
3. User tippt → debounced Search (300 ms)
4. User wählt GIF → onPick(gif) → ChatInput
5. message_plaintext = "__rx_a1__\n" + JSON.stringify({
     t: caption,
     a: { type: 'gif', gifUrl, gifPreview, gifId }
   })
6. /chat/send body: { ..., attachmentType: 'gif' }  (kein attachmentKey)
7. Cron-Cleanup skipt R2-Delete für attachment_type='gif'
```

### MIME-Whitelist Override

Bei `attachmentType='gif'` greift die normale MIME/R2-Logik nicht. Es ist eine reine Plaintext-URL-Referenz im Message-Body.

## Backwards-Compat

Plaintext-Messages **ohne** Magic-Prefix bleiben als bare Text erkannt. `unwrapAttachmentPlaintext` returnt `{ caption: <text>, attachmentMeta: null }` für legacy Messages.
