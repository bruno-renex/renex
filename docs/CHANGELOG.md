# RENEX — Changelog

Format: [Keep a Changelog](https://keepachangelog.com/de/1.1.0/) ⋅ Daten in `YYYY-MM-DD`.

---

## 2026-05-13 — Phase 4b: Channel-Send/Receive live

Channels sind ab jetzt funktional. End-to-End in Production verifiziert:
Server → `#general` → Nachricht senden → erscheint + persistiert + E2E-verschlüsselt.

### ✨ Added

**Backend Type-Aware Helpers** (`src/auth.js`):
- `getConvoMemberHandles(db, convoId)` — gibt Member-Handles zurück, schaltet je
  nach `conversations.type` zwischen `conversation_members` (group) und
  `server_members` (channel) um.
- `isConvoMember(db, convoId, handle)` — Boolean-Check, type-aware. Exists-only
  Query (effizienter als getConvoMemberHandles().includes()).

**Frontend Helper** (`frontend/src/lib/convoType.js`):
- `isGroupLike(chat)` — boolean für `type === 'group' || type === 'channel'`.
  Aktuell wenig genutzt; vorbereitet für späteren Refactor der 20+ `=== 'group'`-Checks.

### 🔄 Changed

**Backend `/chat/send`** (`src/helpers/chatSend.js`):
- Sender-Membership-Check + Recipient-Membership-Check nutzen `isConvoMember`.
  GSK-Sender-Check ebenfalls type-aware.
- Unread-Counter INSERT-FROM-SELECT: zwei separate Statements je nach Type
  (UNION-Variante mit ON CONFLICT war SQLite-Syntax-inkompatibel — Lesson
  Learned, lokal mit sqlite3 reproduziert vor Deploy).
- Web-Push-Member-Lookup nutzt `getConvoMemberHandles`.
- `pushToGroupMembers` (`src/auth.js`) ist transparent type-aware via
  `getConvoMemberHandles` — alle Caller (chatRoutes, e2e, voice, etc.)
  bekommen Channel-Support free.

**Backend `/chat/list` + `/chat/react`** (`src/routes/chatRoutes.js`):
- Membership-Checks via `isConvoMember` statt direkter
  `conversation_members`-Query.

**Backend `/groups/members?groupId=<channelId>`** (`src/routes/groupRoutes.js`):
- Type-aware: bei `type='channel'` SELECT aus `server_members`
  (alle Server-Member, `is_owner=1` → `role='admin'`).
- Guest-Cleanup skipt für Channels (Gäste leben nicht in `server_members`).

**Frontend ChatStore** (`frontend/src/stores/chat.svelte.js`):
- 5 Stellen `type === 'group'` erweitert um `|| type === 'channel'`:
  loadChatHistory, refreshSelected, sendMessage (isGroup-Flag),
  receiveMessage (isForCurrentChat + decrypt-Routing),
  appendLocalSystemMessage.

**Frontend ChatInput**: `convoId`-Herleitung für Attachments type-aware.
**Frontend notificationsStore**: `chatToConvoId` type-aware.
**Frontend ServersView**: Channel-Klick → `chatStore.selectChat({type:'channel', ...})`
statt Info-Toast.

### 🧪 Tests

- `tests/chatSendControlTypes.test.js` Mock erweitert um `isConvoMember` +
  `getConvoMemberHandles`.
- Bestehende 390 Tests bleiben grün.
- Neue serverPermissions-Suite (27) bleibt grün.
- **Total 417/417** Tests grün vor Deploy.

### 🚧 Bekannte „rough edges" (Phase 4c-Polish, nicht blockierend für MVP)

- ChatHeader rendert Channels noch wie DM-Optik (Avatar-Initialen statt `#`,
  Voice-Call-Buttons werden korrekt unterdrückt via `type === 'dm'`-Check)
- Channel-Members-Modal: lädt jetzt `server_members` korrekt, aber UI-Polish
  (#-Prefix im Titel, Server-Context-Anzeige) fehlt
- Multi-Device-GSK-Distribution: bei Peer-Device-Add wird GSK noch nicht
  für Channel-Members re-distributed (App.svelte device_added Hook)
- Edit-Message für Channels: 2 Stellen in chat.svelte.js (Z.99, 237)
  brauchen group-like-Logik
- Recipient-Set-KV-Cache (`server_recipients:<channelId>`, Spec §4.3):
  bisher fällt jeder Channel-Send auf direkte DB-Query zurück (60s
  KV-Cache aus `pushToGroupMembers` greift teilweise)

### Geänderte Dateien

- `src/auth.js` — `getConvoMemberHandles`, `isConvoMember`, `pushToGroupMembers` umgestellt
- `src/helpers/chatSend.js` — 4 Stellen type-aware
- `src/routes/chatRoutes.js` — 2 Stellen type-aware
- `src/routes/groupRoutes.js` — `/groups/members`-Endpoint type-aware
- `frontend/src/stores/chat.svelte.js` — 5 Stellen group→group/channel
- `frontend/src/stores/notifications.svelte.js` — chatToConvoId
- `frontend/src/components/ChatInput.svelte` — attachment convoId
- `frontend/src/components/ServersView.svelte` — Channel-Klick → selectChat
- `frontend/src/lib/convoType.js` — neu (Helper für späteren Refactor)
- `tests/chatSendControlTypes.test.js` — Mock erweitert
- `docs/CHANGELOG.md` — dieser Eintrag

---

## 2026-05-13 — Phase 3A Sidebar + Routes (Backend + UI live)

Server/Channels sind als Foundation in Production verifügbar.
Backend produktionsverifiziert: 4 End-to-End-Calls (create, list, detail,
channel-add) liefen grün im Browser-DevTools-Test.

### ✨ Added

**Datenbank** (D1 production):
- 6 neue Tables: `servers`, `server_members`, `server_roles`,
  `role_assignments`, `channel_permission_overrides`, `server_audit_log`
- 5 neue Spalten auf `conversations`: `server_id`, `channel_kind`, `position`,
  `topic`, `parent_id` (via ALTER TABLE, einmalig)
- Index `idx_conv_server` für Sidebar-Liste

**Backend**:
- `src/lib/permissions.js` — Pure-Function Permission-Bitfield +
  `resolvePermissions()` mit Discord-Override-Order (role-deny < role-allow
  < member-deny < member-allow). 13 Permission-Bits, ALL_PERMISSIONS-Helper,
  DEFAULT_EVERYONE/MODERATOR-Konstanten, sanitizeBits-Forward-Compat.
- `src/routes/serverRoutes.js` — neuer Router mit 6 implementierten Endpoints
  + 14 Stubs. Path-Routing via RegEx-Liste. Audit-Log-Helper, Recipient-Cache-
  Invalidation, type-aware Member-Lookup.
- Backend dispatched `/servers/*` → `handleServerRoutes` in `backend.js`.

**Frontend**:
- `frontend/src/lib/permissions.js` — byte-identical zu Backend, Test prüft
  Sync.
- `frontend/src/stores/serverStore.svelte.js` — Reactive Store mit
  loadServers, selectServer, createServer, leaveServer, reset.
- `frontend/src/components/ServersView.svelte` — Liste/Detail-Modi mit
  Channels + Members.
- `frontend/src/components/CreateServerModal.svelte` — Server-Erstellung.
- `frontend/src/components/IconStrip.svelte` — +4. Server-Icon.
- `frontend/src/components/InboxList.svelte` — `activeSection === 'servers'`
  Branch.
- `frontend/src/stores/inbox.svelte.js` — `'servers'` in SECTIONS-Whitelist.
- i18n: 28 neue Keys × 3 Sprachen (de/en/es).

### 🧪 Tests

- `tests/serverPermissions.test.js` — 27 neue Tests:
  - Spec §5.4 Test-Vorschriften #1-5 (Position-Check + Override-Order)
  - Bitfield-Konsistenz, Owner-Bypass, ADMINISTRATOR-Bit
  - Private-Channel-Szenarien
  - Byte-Identität Backend ↔ Frontend (readFileSync)
  - Forward-Compat-Sanitization

### 🔒 Security / Architecture

- **Atomic D1 batch** für 5-Step-Server-Create
- **Anti-Privilege-Escalation enforced**: canManageRoleAtPosition gibt nur
  strictly-niedrigere Position frei; Owner bypassed.
- **Permission-Resolution channel-agnostisch**: dieselbe Pure-Function für
  Server-Ebene und Channel-spezifische Overrides.
- **Owner-Pre-Check bei Leave**: 409 `owner_transfer_required` wenn andere
  Members existieren; sonst Server-CASCADE-Delete.

### Geänderte Dateien

- `schema-servers.sql` — neu (155 LOC)
- `src/lib/permissions.js` — neu
- `src/routes/serverRoutes.js` — neu (~520 LOC, 6 impl + 14 stubs)
- `backend.js` — Route-Dispatch
- `frontend/src/lib/permissions.js` — neu (identical zu Backend)
- `frontend/src/stores/serverStore.svelte.js` — neu
- `frontend/src/components/ServersView.svelte` — neu
- `frontend/src/components/CreateServerModal.svelte` — neu
- `frontend/src/components/IconStrip.svelte` — Server-Icon
- `frontend/src/components/InboxList.svelte` — Section-Branch
- `frontend/src/stores/inbox.svelte.js` — SECTIONS-Whitelist
- `frontend/src/stores/lang/{de,en,es}.js` — 28 Keys × 3 Sprachen
- `tests/serverPermissions.test.js` — neu (27 Tests)

---

## 2026-05-13 — Phase 3A Spec + Roadmap-Pivot (Beta 3 Monate früher)

Strategischer Pivot nach Phase-1B/1C-Abschluss: Beta-Launch von Okt/Nov 2026
auf **Mitte/Ende Juli 2026** vorgezogen. Begründung: Phase 1 ist exzellente
Foundation, Voice ist eigener Tech-Stack (3-4 Wo Solo-Arbeit), Markenkern
funktioniert auch ohne Voice in Tag 1.

### ✨ Added

**`docs/SERVERS.md`** — Phase-3A-Spec (Servers + Text-Channels + Roles), Draft v0.1
- 11 Sections (Glossar, Datenmodell, Lifecycle, Channels, Roles, API, Multi-Device,
  Limits, Migration, Decision Log, Open Items)
- 13 Decisions im Decision Log dokumentiert (alle 2026-05-13)
- Datenmodell wiederverwendet `conversations`-Tabelle via `server_id` + `channel_kind`
  (statt neuer Tables) — spart 2-3 Wochen Multi-Device-Code-Duplikation
- GSK pro Channel (Phase-1C-Pattern) für Defense-in-Depth + Forward Secrecy
- Owner via `is_owner`-Flag (Industry-Standard: Discord/Slack/Telegram)
- Audit-Log als Phase-3 must-have (Schweizer DSG)
- Recipient-Set-KV-Cache für Send-Latency bei grossen Servern
- Server-scoped API-Pfad-Konvention: `/servers/<sid>/channels/...`
- Limits: Free=1000 Members, Pro=10'000 (Sweet-Spot zwischen Anti-AI und Gamer-Clans)

### 🔄 Changed

**Roadmap-Pivot in `docs/VISION.md`:**
- Beta-Launch-Ziel: Okt/Nov 2026 → **Mitte/Ende Juli 2026**
- Phase 3 → Phase 3A (Voice/PTT/Screen-Sharing deferred zu Phase 8)
- Phase 4 (Gamer-Features) → Phase 9 (Year 1 Q4)
- Phase 5 → Phase 5-Light (nur Captcha + Rate-Limits, Hardware-Attestation deferred)
- Phase 2 (Open Standard) parallelisiert zu Phase 3A
- Phase 8 (post-Beta) bündelt Voice + Signal Protocol als v2.0-Update
- 2 neue Decision-Log-Einträge in VISION.md Anhang B

**Marketing-Pitch angepasst:** „Text-First Discord-Killer mit AI-Free-Garantie.
Voice kommt in v2.0 (Q4 2026)."

### Geänderte Dateien

- `docs/SERVERS.md` — neu, Phase 3A Spec (~600 Zeilen)
- `docs/VISION.md` — §10 Roadmap-Übersicht komplett restrukturiert, §11 Metriken-Daten
  verschoben, Anhang B um 3 Decision-Log-Einträge erweitert
- `docs/CHANGELOG.md` — dieser Eintrag

---

## 2026-05-13 — Add-Device-Modal (Phase 1B/1C Loose-End)

Letztes offenes UX-Stück aus der Multi-Device-Spec geschlossen. Bisher fehlte
der in [`MULTI_DEVICE.md` §12.1](./MULTI_DEVICE.md) versprochene
`+ Neues Gerät hinzufügen`-Button. Cross-Device-Passkey funktionierte
trotzdem (WebAuthn-Hybrid-Transport ist OS-Standard), aber der User hatte
keinen Onboarding-Helper „Wo geh ich auf dem neuen Gerät hin?".

### ✨ Added

**`AddDeviceModal.svelte`** (`frontend/src/components/AddDeviceModal.svelte`)
- Neue Komponente mit QR-Code (`https://app.renex.id`) + 3-Schritt-Anleitung.
- QR ist NICHT der WebAuthn-Hybrid-QR (den erzeugt das OS auf dem neuen
  Gerät), sondern ein Onboarding-Sprung „App auf neuem Gerät öffnen".
- Cyan-on-Dark-Farbschema (`#38bdf8` auf `#0f0f12`) passt zum App-Theme.
- Fallback bei QR-Render-Fehler: Plain-URL-Anzeige + Sentry-Capture.

**Button in `SettingsDevicesPanel.svelte`**
- `+ Neues Gerät hinzufügen` am Ende der Liste, dashed Border in Akzentfarbe.
- Disabled-State wenn `limitReached` (5 Free / 10 Pro), Tooltip mit
  Upgrade-Hinweis.

**i18n-Keys** in `de.js`, `en.js`, `es.js` (11 Keys: `addDeviceBtn`,
`addDeviceLimitTooltip`, `addDeviceTitle`, `addDeviceIntro`,
`addDeviceStep1-3`, `addDeviceHint`, `addDeviceQrError`, `addDeviceCloseBtn`).

### 📦 Dependencies

- `qrcode@^1.5.4` (npm). Pure-JS, returns SVG-String, ~13KB gzipped Bundle-
  Footprint. Wiederverwendbar für Group-Invite-Link-QRs (Phase 3).

### 🔒 Security / Architecture

- **Kein Backend-Call.** Modal ist reine UX. Geräte-Registrierung passiert
  weiterhin auf dem neuen Gerät via WebAuthn → `POST /e2e/inbox/upload`
  (siehe [`MULTI_DEVICE.md` §4.1](./MULTI_DEVICE.md#41-add-device-flow)).
- **Bestätigung implizit via Cross-Device-Passkey** — Decision Log
  2026-04-28: Passkey IST die Bestätigung, kein zusätzlicher Confirm.

### Geänderte Dateien

- `frontend/src/components/AddDeviceModal.svelte` — neu
- `frontend/src/components/SettingsDevicesPanel.svelte` — Add-Button + Modal-Wiring
- `frontend/src/stores/lang/{de,en,es}.js` — 11 neue Keys
- `package.json` + `package-lock.json` — `qrcode` dependency
- `docs/MULTI_DEVICE.md` §13 — Open Item geschlossen
- `docs/CHANGELOG.md` — dieser Eintrag

### 🔄 Nachtrag (gleicher Tag) — Layout-Refactor: Reverse-Flow primär

Nach echtem End-to-End-Test mit Mac (Monterey 12.7.6) + iPhone Safari kam
heraus, dass der ursprünglich primär kommunizierte Apple-Auto-Banner-Flow
(„neues Gerät zeigt QR + BLE-Companion → altes Gerät zeigt Notification")
auf älteren macOS-Versionen **nicht zuverlässig funktioniert**, weil
iCloud-Keychain-Passkey-Sync erst ab Ventura 13 / iOS 16 verfügbar ist und
auf Monterey Passkeys nur lokal gespeichert werden.

**Universeller Standard-Flow** (auf jedem OS / Browser):
1. Auf dem **neuen** Gerät app.renex.id öffnen (Convenience-QR bleibt als
   Helper).
2. Handle eingeben + einloggen → Browser dort zeigt den
   WebAuthn-Hybrid-QR.
3. QR mit Kamera-App des **alten** (eingeloggten) Geräts scannen.
4. Auf dem alten Gerät: Touch-ID / Face-ID bestätigen — fertig.

Live verifiziert auf Monterey + iPhone Safari: 2 Devices in der Liste,
keine Apple-Notification nötig.

**Modal-Layout** umgebaut:
- **Steps primär oben** (4 nummerierte Punkte, Reverse-Flow).
- **Convenience-QR sekundär** in eigener Box (130px statt 220px) mit
  Tipp-Text links + QR rechts.
- **Hint-Box** (Passkey-Sicherheit) separat.
- **Apple-Auto-Notice** als optional-italic-Box mit dashed Border — für
  User mit Ventura+/iOS 17 die den Banner-Flow nutzen können.

**i18n** auf 13 Keys gewachsen (+`addDeviceStep4`, `addDeviceConvenienceTip`,
`addDeviceAppleNotice`). Alle 3 Sprachen synchron, per Runtime-Import in
Browser-Preview validiert.

---

## 2026-05-10 — Phase 1C: Group-Multi-Device Re-Distribution

GSK-Layer nachgezogen für vollwertiges Multi-Device. DM-Multi-Device war
seit 2026-04-30 fertig, Group-Sender-Keys (GSK) hatten zwei Lücken:
Peer-Device-Add löste keine GSK-Re-Wrap aus, und Self-Device-Add hatte
keinen Race-Schutz gegen KV-Eventual-Consistency.

### ✨ Added

**`redistributeGSKsForPeerDeviceAdded`** (`frontend/src/lib/groupCrypto.js`)
- Neue Funktion. Wird vom `device_added(peer)`-Handler in `App.svelte`
  gerufen wenn ein Kontakt ein neues Device hinzufügt.
- Iteriert über alle eigenen Gruppen, prüft per `/groups/members` ob
  Peer Member ist, und re-sendet die eigene GSK an alle Peer-Devices
  (inkl. das neue) via `sendMyGSKToMember`.
- Konsequenz: Neues Peer-Device kann meine zukünftigen Group-Messages
  sofort decrypten — ohne auf nächste Rotation oder manuellen
  `request_gsk` warten zu müssen.

**`_fetchUserDevicesEnsuring`** (private, `frontend/src/lib/groupCrypto.js`)
- Backoff-Retry-Variante von `_fetchUserDevices`: prüft ob ein
  erwartetes Device im KV-Index ist, retried mit
  400ms → 800ms → 1500ms → 3000ms-Backoff, fällt auf Push-Info
  (`expectedJwk`) zurück wenn KV nie propagiert.
- Identisches Pattern wie `fetchPeerDevicesEnsuring` in chatPipeline.js
  (DM-Pendant).

### 🐛 Fixed

**Race in `storeMyGSKForOwnDevices`**: bei `device_added(self)` wurde
`_fetchUserDevices(me)` direkt aufgerufen — wenn KV-Index am Empfänger-
Edge noch nicht propagiert war, fehlte das gerade hinzugekommene Device
in der Wrap-Liste, was beim Boot des neuen Devices zu fehlender GSK
führte. Funktion akzeptiert jetzt optionalen `newDeviceInfo`-Parameter
für Retry-Logik.

**Race in `sendMyGSKToMember`**: analog für Peer-Side. Bei
Peer-Device-Add konnte das gerade hinzugekommene Device fehlen.
`newDeviceInfo`-Parameter dürchgereicht, retry bis es im Index ist.

### 🔒 Security / Architecture

- **Backend zero-knowledge bleibt**: Re-Distribution läuft komplett
  client-seitig via bestehender `/chat/send` (gsk-Control) und
  `/e2e/group-gsk/store`-Endpoints. Keine Backend-API-Änderung.
- **Forward Secrecy intakt**: Wenn ein neues Device sofort sendet
  bevor die Re-Distribution ankommt, generiert es eine eigene frische
  GSK statt die alte zu verwenden — keine Schlüssel-Wiederverwendung
  zwischen Devices ausserhalb der KV-Restore-Pfads.
- **Recovery-Bundle**: Eigene GSKs sind seit 2026-04-30 im
  R2-Recovery-Bundle (`collectMyGSKs` / `restoreMyGSKsFromBundle`),
  Peer-GSKs nicht — die kommen via `request_gsk` neu (Bundle-Bloat-
  Vermeidung). Dokumentiert in [`GROUPS_MULTIDEVICE.md`](./GROUPS_MULTIDEVICE.md) §5.

### 🧪 Tests (alle ✅)

8 neue Vitest-Tests in `tests/groupCrypto.test.js`:

| # | Test | Was wird abgedeckt |
|---|---|---|
| 1 | `storeMyGSKForOwnDevices ohne newDeviceInfo` | Backwards-compat — kein retry-Pfad |
| 2 | `storeMyGSKForOwnDevices mit newDeviceInfo retried` | Self-Device-Add Race-Schutz, Mock simuliert KV-Eventual-Consistency |
| 3 | `storeMyGSKForOwnDevices Push-Fallback` | KV propagiert nie → Push-Info wird in Cache gemerged |
| 4 | `redistributeGSKsForPeerDeviceAdded noop` | Empty groups list |
| 5 | `redistributeGSKsForPeerDeviceAdded me === peer` | Defensive guard |
| 6 | `redistributeGSKsForPeerDeviceAdded skipt ohne lokale GSK` | 0 chat/send Calls wenn kein eigener GSK |
| 7 | `redistributeGSKsForPeerDeviceAdded skipt ohne Peer-Membership` | Members-API filtert |
| 8 | `redistributeGSKsForPeerDeviceAdded sendet pro gemeinsamer Gruppe` | 2 gemeinsame Gruppen → 2 chat/send |
| 9 | **5×5 Stress** | 5 Members × 5 Devices, 6. Peer-Device → wrap-Count = 6 |

Total Test-Suite: 73 Tests in `groupCrypto.test.js`, alle grün.

### Geänderte Dateien

- `frontend/src/lib/groupCrypto.js` — `_fetchUserDevicesEnsuring`,
  `storeMyGSKForOwnDevices(..., newDeviceInfo)`,
  `sendMyGSKToMember(..., newDeviceInfo)`,
  `redistributeGSKsForPeerDeviceAdded`
- `frontend/src/App.svelte` — Self-Hook reicht `newDeviceInfo` durch,
  Peer-Hook ruft `redistributeGSKsForPeerDeviceAdded`
- `tests/groupCrypto.test.js` — neuer Multi-Device-describe-Block
- `docs/GROUPS_MULTIDEVICE.md` — neu (Phase 1C-Spec)
- `docs/MULTI_DEVICE.md` §13 — Open Items aktualisiert
- `docs/VISION.md` Anhang B — Decision-Log-Eintrag 2026-05-10

---

## 2026-05-02 — Security Defense-in-Depth (L1, L2, L3)

Drei kosmetische Härtungen am Krypto-Layer. Keine bekannten Exploits — die
Änderungen sind defense-in-depth, falls Implementierungen in anderen Layern
mal Bugs haben sollten.

### 🔒 Hardened

**L1 — HKDF info per-peer für DeviceStorageKey** (`frontend/src/lib/cmk.js`)
- Vorher: `info = "renex:storage:<me>"` — alle CMKs eines Users wurden mit
  demselben Storage-Key verschlüsselt.
- Nachher: `info = "renex:storage:<me>:<peer>"` — jede CMK hat einen
  eigenen, peer-gebundenen Storage-Key.
- Falls ein Storage-Key irgendwie geleakt wird: nur die zugehörige
  Peer-Konversation ist exponiert, nicht alle anderen.
- Migration: 3-Layer-Fallback (per-peer → legacy per-user → legacy global)
  beim Read. Re-Encrypt mit per-peer Key on-the-fly.

**L2 — AAD in Bundle-Encryption** (`frontend/src/lib/recovery.js`)
- AES-GCM-Bundles sind jetzt mit AAD = `"renex:bundle:<handle>"` gebunden.
- Verhindert, dass ein Bundle z.B. unter dem masterKey eines anderen Users
  decryptet werden könnte (auch bei RNG-Salt-Kollision).
- `bundle.v` Field signalisiert Format: v=2 mit AAD, v=1 ohne (legacy).
- Bei Decrypt: zuerst v=2 + AAD versucht, fallback v=1 ohne AAD.
- Auto-Sync upgraded Legacy-Bundles bei nächstem CMK-Change automatisch zu v=2.

**L3 — Documentation + Comments**
- `cmk.js`: Comment über IV-Birthday-Bound (2^48 Encryptions) und
  Rotations-Erwartung. Bei realistischem Volume nicht erreichbar.
- Auto-Rotate-Mechanismus deferred zu Phase 1C (z.B. nach 2^32 Encryptions
  pro Key). Aktuell kein Risk.

### Geänderte Dateien

- `frontend/src/lib/cmk.js` — getDeviceStorageKey nimmt peerHandle, 3-Layer-Migration
- `frontend/src/lib/recovery.js` — encryptBundle/decryptBundle mit optional handle/AAD
- `frontend/src/lib/cmkBundleSync.js` — handle-AAD bei encrypt + decrypt
- `frontend/src/components/RecoveryOnboardingModal.svelte` — handle-AAD bei encryptBundle
- `frontend/src/components/RecoveryVerifyModal.svelte` — handle-AAD bei decryptBundle
- `frontend/src/components/RecoveryLoginModal.svelte` — handle-AAD bei decryptBundle

---

## 2026-04-30 — E2E-Recovery & Multi-Device Hardening

Vollständige Härtung des E2E-Recovery-Flows: vom CMK-Verteilungspfad über Bundle-Backup
in R2 bis zum Phrase-Restore in IndexedDB. End-to-end getestet mit Multi-Device-Setup
(Mac × 2 Tabs + iPhone) inkl. Doomsday-Szenario (beidseitiger Storage-Verlust).

### 🐛 Fixed

- **CMK-Verteilung**: `redistributeCMKToPeer` lieferte stillschweigend `ok:true` selbst
  wenn die lokale CMK fehlte. Empfänger eines `cmk_req` retried daher endlos.
  Jetzt: explizites `cmk_unavailable`-Signal an den Peer + Frontend zeigt klar
  „🔓✗ Nicht entschlüsselbar (Schlüssel verloren)" mit roter Bubble.
- **Decrypt-Retry-Loops** ohne Backoff verursachten 429-Bursts bei Cloudflare.
  Neu: Exponential Backoff (3s → 8s → 25s → 60s, max 4 Versuche), Pause-on-pending
  und Skip-on-unavailable.
- **18 parallele KV-Fetches** beim Öffnen eines Chats mit n Messages → 429.
  Single-Flight-Coalescing für `tryFetchAndUnwrapCMK` und `fetchPeerDevices`:
  18 gleichzeitige Aufrufer teilen sich jetzt **einen** Netzwerk-Call.
- **Endlos-Loop in RecoveryOnboardingModal** wenn `cacheMasterKey` für brand-neue
  User scheiterte (`device_secret` noch nicht in IDB) — caused 4× 409 → 429-Storm.
  Fix: `getOrInitDeviceSecret` initialisiert lazy + Stop-Condition gegen Re-Trigger
  + nicht-fataler try/catch um den Cache-Step.
- **RecoveryLoginModal unmountete** nach erfolgreicher Passkey-Auth (war innerhalb
  LoginModal verschachtelt → LoginModal verschwand sobald `myUser` gesetzt → Step 2
  nie sichtbar). Modal jetzt auf App-Level + `onRecoveryClick`-Callback aus LoginModal.
- **Black-Screen nach Phrase-Recovery**: `sessionStore.check()` fehlte nach Step-1-Auth,
  daher blieb State auf `anonymous` → `showApp` false → leerer Bildschirm bis Reload.
- **Stale `cmk_unavailable` markierte fertig recoverte Sessions als unrecoverable**:
  verzögerte Race-Messages konnten nach Bundle-Restore ankommen und den Flag setzen.
  Jetzt ignoriert wenn lokale CMK existiert + Auto-Cleanup bei jedem `decrypt OK`.
- **`recovery_master_key` IDB-Key war nicht per-User-skoped**: User A's MasterKey wurde
  von User B's Login überschrieben (selber Browser, mehrere User). Jetzt unter
  `recovery_master_key:<handle>` mit Legacy-Migration beim ersten Zugriff.
- **Sig-Verify Coverage**: vorher nur Peer-Messages verifiziert. Jetzt auch eigene
  Multi-Device-Messages (skip nur eigenes current Device). Cache-Miss → Fallback-fetch
  von peer-devices. Tampering wird in der UI (rote Bubble + Warnbanner) sichtbar.
- **Verified-State im Decrypt-Cache**: Cache speicherte nur `text` → bei Re-Decrypt
  (z.B. nach `device_added`) wurde `verified=null` ans Message-Objekt gepatcht und
  überschrieb vorhandene `true`/`false`-Werte. Cache hält jetzt `{text, verified}`.

### ✨ Added

- **CMK Auto-Sync nach R2** (`cmkBundleSync.js`): bei jedem `createAndStoreCMK` /
  `importAndStoreCMKFromPeer` läuft ein debounced (5s) Bundle-Push.
  Encryption mit cached MasterKey (PBKDF2 aus BIP39-Phrase). Logs:
  `☁️ Bundle synced (N CMKs)`.
- **CMK-Restore aus Bundle** (`restoreCmksFromBundle`): in RecoveryLoginModal Step 3
  und RecoveryVerifyModal werden alle CMKs aus dem Bundle in die lokale IndexedDB
  importiert. Plus `bootstrapBundleRestore` beim App-Start für Auto-Recovery wenn
  MasterKey gecached aber CMKs lokal fehlen.
- **Proactive `cmk_req` beim Chat-Open** (`_kickCmkAcquisitionIfNeeded`): wenn beim
  Öffnen eines Chats keine lokale CMK existiert + Messages sind 🔒, schickt das
  Frontend nach 1.5s aktiv einen `cmk_req`. Reduziert Wartezeit von ~36s auf ~3s
  bevor History via Peer-Redistribute lesbar wird.
- **MasterKey-Cache** (`masterKey.js`): Cached der aus der Phrase abgeleitete
  MasterKey unter Device-Storage-Key in IndexedDB → Bundle-Auto-Sync läuft ohne
  erneute Phrase-Eingabe. Per-handle-skoped, in-memory `Map<handle, Bytes>`.
- **`cmk_unavailable` als Backend-Control-Type**: in `chatSend.js` als gültiger
  Type whitelisted (kein D1-Insert, kein Self-Push, eigener Rate-Limit-Bucket).
- **Tampering-UI** in `MessageBubble.svelte`: bei `verified === false` rote Border
  + Warnbanner ⚠️ „Signatur ungültig — Manipulation möglich" mit Hover-Tooltip.

### 🔒 Security / Architecture

- **Gleiche Krypto-Garantien wie Signal**: ein User kann ALLE Geräte verlieren und
  mit BIP39-Phrase + Passkey wiederherstellen. Server kann zu keinem Zeitpunkt
  Klartext-Messages lesen — Bundle ist client-side encrypted bevor R2-Upload.
- **Divergenz-Schutz bleibt erhalten**: `ensureSecureDmSession` erstellt KEINE
  neue CMK wenn Chat-Historie existiert aber CMK fehlt — würde sonst die existierende
  CMK von der Gegenseite konkurrenzieren.
- **2-Faktor-Recovery**: Passkey allein reicht nicht (kein E2E-Schlüssel-Material),
  Phrase allein reicht nicht (kein Account-Auth). Beides nötig.

### 🧪 Test-Matrix (alle ✅)

| # | Szenario | Status |
|---|----------|--------|
| 1 | Tab 1 (christa) → Tab 2 + anna sehen lesbar | ✅ |
| 2 | Tab 2 → Tab 1 + anna lesbar | ✅ |
| 3 | anna → Tab 1 + Tab 2 lesbar | ✅ |
| 4 | Reload aller 3 Tabs → komplette History dekryptet | ✅ |
| 5 | Drittes Device (Tab 3) joint → kann komplette History lesen + senden | ✅ |
| 6 | Beidseitiger Storage-Verlust → `cmk_unavailable` + UI-Indikator | ✅ |
| 6.3 | Phrase-Recovery in Inkognito → CMKs aus R2-Bundle in IDB → History lesbar | ✅ |
| 7 | Frische Konversation ohne Race-Condition beim ersten Send | ✅ |
| 8 | Race-Condition: beide Seiten senden simultan ohne CMK | ✅ |
| 9 | Sig-Verify Coverage (eigene Multi-Device + Tampering-Detection) | ✅ |

### Geänderte Dateien

**Frontend (`frontend/src/`):**
- `App.svelte` — RecoveryLoginModal lift, bootstrapBundleRestore-Hook, cmk_unavailable-Handler-Guard
- `lib/chatPipeline.js` — Single-Flight, sendCmkUnavailable, Sig-Verify-Coverage, verified-im-Cache
- `lib/cmkBundleSync.js` — **neu** — Auto-Sync + Restore + Bootstrap-Hook
- `lib/cmkRequestState.js` — **neu** — geteilte Pause-/Unavailable-Flags (vermeidet circular import)
- `lib/masterKey.js` — **neu** — per-User MasterKey-Cache mit Migration
- `lib/cmk.js` — Hook in `importAndStoreCMKFromPeer` für scheduleBundleSync
- `lib/idb.js` — `idbListKeys(prefix)` für CMK-Iteration
- `lib/recovery.js` — `deriveMasterKeyRaw` + 409-Status durchreichen
- `stores/chat.svelte.js` — Backoff, Pause-on-pending, _kickCmkAcquisitionIfNeeded, markCmkUnavailable
- `components/RecoveryLoginModal.svelte` — sessionStore.check, restoreCmksFromBundle in Step 3
- `components/RecoveryVerifyModal.svelte` — cacheMasterKey + restoreCmksFromBundle
- `components/RecoveryOnboardingModal.svelte` — non-fatal cacheMasterKey + Stop-Condition + 409-Match
- `components/LoginModal.svelte` — `onRecoveryClick` Prop, RecoveryLoginModal raus
- `components/MessageBubble.svelte` — Tampering-UI

**Backend (`src/`):**
- `helpers/chatSend.js` — `cmk_unavailable` Control-Type whitelisted
