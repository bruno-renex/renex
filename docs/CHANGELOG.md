# RENEX — Changelog

Format: [Keep a Changelog](https://keepachangelog.com/de/1.1.0/) ⋅ Daten in `YYYY-MM-DD`.

---

## 2026-05-29 — Phase 3A.5 Ban-System 🚫

Fünftes Phase-3A.5-Item geshippt. Server-Admins mit `BAN_MEMBERS` (Owner via
Bypass) können jetzt Members permanent bannen mit optionalem Reason,
Banned-Liste anzeigen und Unbans aussprechen. Gebannte User können nicht
mehr via Invite re-joinen.

### ✨ Added
- **Schema (`schema-servers.sql`)**: Tabelle `server_bans` (`server_id`,
  `user_handle`, `banned_by`, `reason`, `ts`; PK composite, FK CASCADE zu
  `servers`). Index `idx_server_bans_handle` für cross-server lookups.
- **`POST /servers/<id>/members/<u>/ban`** — Permission `BAN_MEMBERS`,
  Position-Check strikt-höher (Owner bypassed), Owner nicht bannbar
  (Transfer first), Self-Ban blockt. Body: `{reason?: string}` ≤500 chars.
  D1-Batch: ban-row INSERT + CASCADE-Delete aus `server_members`,
  `role_assignments`, `channel_permission_overrides` (member), `conversation_members`
  (private Channels). Audit `member_ban`. WS-Broadcast `server_member_banned`
  an verbleibende Members + direkt an gebannten User. RL 10/min.
- **`GET /servers/<id>/bans`** — listet Bans sortiert nach `ts DESC`.
- **`DELETE /servers/<id>/bans/<u>`** — Unban (Re-Join danach möglich, aber
  nicht automatisch). WS `server_member_unbanned`. RL 10/min.
- **`joinByTokenHandler` Ban-Check**: 403 `user_banned` mit Reason auf GET
  + POST. Gebannte User sehen keine Invite-Landing.
- **Frontend `ServerSettingsModal`**: 🚫 Ban-Button per Member (gated
  `BAN_MEMBERS`, hidden für self + Owner), neuer "Gebannt"-Tab mit
  Handle/Banner/Timestamp/Reason + Unban-Button.
- **`serverStore`** helpers `banMember`, `listBans`, `unbanMember`.
- **`App.svelte`** WS-Dispatcher kennt `server_member_banned/unbanned`
  (sidebar reload). Self-Ban Special-Handler — wenn ich der gebannte User
  bin, deselect Server + Toast.
- **i18n DE/EN/ES**: 17 neue Strings.

### 🐛 Fixed (Polish nach Smoke-Test)
- **`pushToUserDO` jetzt awaited** in `banMemberHandler` + `kickMemberHandler`.
  Vorher Fire-and-Forget — Cloudflare Workers konnte den Promise terminieren
  bevor das DO-fetch zur Zustellung kam. Gebannte/gekickte User sahen weder
  Toast noch Sidebar-Update bis manuellem Reload. Klassischer CF-Workers-Bug
  beim Pattern `pushToUserDO(...).catch(...)`.
- **Banned-Tab Counter live**: `bans` wurde nur beim Tab-Click geladen, also
  zeigte der Tab-Badge stale `(0)` nach einem Ban. Jetzt: `serverStore.banEventVersion`
  zählt bei jedem WS-Event hoch, Modal-Effect tracked das + lädt immer wenn
  Modal offen + `canBanMembers` (entkoppelt vom aktiven Tab).

### 🚧 Phase 3A.5 — Stand 5 von 7 nach 2026-05-29
Verbleibend: Private Channels (`channel_permission_overrides`-UI), Tier-Limits
Free=3 / Pro=25.

---

## 2026-05-28 — Phase 3A.5 Server-Icon-Edit + WS-Polish 🖼

Viertes Phase-3A.5-Item geshippt am selben Tag (Abend-Sprint nach den ersten
drei Endpoints). Server-Owner können jetzt Icon hochladen/entfernen + Name
und Beschreibung im neuen "Allgemein"-Tab editieren. Plus zwei Polish-Fixes
nach Live-Smoke-Test.

### ✨ Added
- **`POST /servers/<id>/icon`** — Owner/MANAGE_SERVER-only Upload, MIME-Allowlist
  (PNG/JPEG/WebP), ≤1 MB, R2-Key `server-icons/<sid>/<uuid>`, alter Icon-Key
  best-effort cleanup. Audit `server_icon_set`, WS-Broadcast `server_updated`
  mit `iconR2Key`-Diff. RL 10/min.
- **`GET /servers/<id>/icon`** — Member-only, streamt R2-Object mit gespeichertem
  Content-Type, `Cache-Control: private, max-age=300`.
- **`DELETE /servers/<id>/icon`** — MANAGE_SERVER-gated, NULLt die Spalte +
  best-effort R2-Cleanup, audit `server_icon_removed`, WS-Broadcast.
- **"Allgemein"-Tab in ServerSettingsModal** (gated MANAGE_SERVER, erstes Tab
  beim Open für Server-Admins) — Icon-Upload mit Auto-Upload-on-Select, Preview,
  Remove-Button + Name/Beschreibung-Editor mit Dirty-Check.
- **Sidebar + Detail-Header zeigen Server-Icons** — fetch+blobURL-Pattern
  (Cross-Origin-credentials), Initials-Fallback wenn kein Icon, re-fetch wenn
  `iconR2Key` sich via WS ändert.
- **i18n DE/EN/ES** — 17 neue Strings für den Allgemein-Tab.

### 🐛 Fixed (Polish nach Smoke-Test)
- **WS `server_updated` + `server_owner_changed` jetzt im Frontend gehandelt** —
  `App.svelte` ignorierte sie bisher, andere Members mussten manuell reloaden um
  Name/Icon/Owner-Wechsel zu sehen. Sidebar-relevante Events triggern jetzt
  `/servers/list` zusätzlich zu `/servers/<id>`.
- **ServerSettingsModal default-Tab** — landete bisher immer auf "Roles", auch
  wenn User die Settings öffnete um Name oder Icon zu ändern. Jetzt: erstes
  Tab "Allgemein" wenn `MANAGE_SERVER`, sonst weiterhin "Roles".

### 🚧 Phase 3A.5 — Stand 4 von 7 nach 2026-05-28
Verbleibend: Ban-System, Private Channels, Tier-Limits (Free=3 / Pro=25).

---

## 2026-05-28 — Phase 3A.5 (Tag 1) + Dependabot-Nachsorge + Roadmap-Acceleration 🛠

Drei Server-Mutation-Stubs gefüllt, alle 7 Dependabot-PRs der Launch-Week aufgeräumt,
komplette Beta-Roadmap um weitere ~3 Wochen vorgezogen (Beta jetzt Ende Juni 2026).

### ✨ Added (Phase 3A.5 — 3 von 7 Items)
- **`POST /servers/<id>/transfer`** — Owner-Transfer eines Servers an einen anderen
  Member. Owner-only (ADMINISTRATOR bypassed nicht, per Spec §5), atomar via
  D1-Batch, Audit-Aktion `server_transfer`, WS-Broadcast `server_owner_changed`.
  RL 3/min/User. Error-Pfade: `cannot_transfer_to_self`, `target_not_member`,
  `missing_target`, `not_owner`.
- **`PATCH /servers/<id>`** — Name + Beschreibung partial-update, gated by
  `MANAGE_SERVER`. Spiegelt `channelDetailHandler`-Pattern (dynamische
  UPDATE-Klausel + auditDetails-Diff). WS-Broadcast `server_updated`. RL 30/min.
- **`DELETE /account` Pre-Check** — returnt `409 owner_transfer_required` mit
  Liste blockierender Server (`{id, name, otherMemberCount}`) wenn User Owner
  eines Servers mit anderen Members ist. Solo-owned Servers fallen unverändert
  durch zu existing CASCADE-Delete.

### 🔄 Changed
- **`DELETE /account` Auto-Owner-Succession entfernt** — Pre-Check ist ab jetzt
  der einzige Pfad. Bewusste UX-Entscheidung: explicit Transfer schlägt silent
  Promotion an einen Member, der das vielleicht nie wollte.
- **`deploy.sh` APP_DIR-Auflösung**: hardcoded iCloud-Pfad ersetzt durch
  `$(cd $(dirname $0) && pwd)`. Deploy funktioniert jetzt aus jedem Working-Tree
  und ist nicht mehr an einen Mac/iCloud-Pfad gebunden.

### 🐛 Fixed
- **2 moderate Dependabot Security-Advisories** durch grouped major bump (PR #7)
  automatisch aufgelöst:
  - `esbuild` dev-server-vulnerability (Browser konnte Requests an Dev-Server
    senden + Response lesen) → behoben mit esbuild ≥0.25.0.
  - `vite` Path-Traversal in optimized-deps `.map`-Handling → behoben mit
    vite ≥6.4.2 (jetzt 8.0.14).

### 🔄 Dependency-Bumps (PR #7 grouped, CI grün)
- `vite` 5.4.21 → 8.0.14
- `vitest` 1.6.1 → 4.1.7
- `@vitest/ui` 1.6.1 → 4.1.7
- `@sveltejs/vite-plugin-svelte` 4.0.4 → 7.1.2
- `esbuild` → ≥0.25.0
- Plus: GitHub Actions `actions/setup-node` 5 → 6 (PR #1), `actions/checkout`
  5 → 6 (PR #2). PRs #3–#6 als obsolete geschlossen nach #7-Merge.

### 🚀 Roadmap-Acceleration
- **Beta-Launch von Mitte/Ende Juli 2026 auf Ende Juni 2026 vorgezogen.** Begründung:
  Phase 3A 3 Wo vor Plan, Phase 2 (Open Standard) parallel mitgeshipped, Phase
  3A.5 in 1 Tag teil-shipped, Tempo hält. Phase 5-Light Wo 5 → Wo 2, Phase 6
  Wo 7 → Wo 4, Phase 8 Aug-Nov → Juli-Okt, Phase 9 Q4-Q1 → Q3-Q4. Detail:
  [`VISION.md`](./VISION.md) Decision Log 2026-05-28.

### 🚧 Phase 3A.5 — noch offen (Tag 2+)
Server-Icon-Edit (`icon_r2_key` PATCH), Ban-System (`server_bans`-Tabelle +
`banMember`-Endpoint), Private Channels (`channel_permission_overrides`-UI),
Tier-Limits (Free=3 / Pro=25 owned Servers — aktuell hartes 3-Server-Limit
für alle).

### 🐞 Follow-up
- `/servers/list` reportete während Smoke-Tests für einen non-Owner kurzzeitig
  `is_owner=true`, später konsistent `false`. Root-Cause unbekannt — kein
  3A.5-Code-Pfad berührt `server_members.is_owner`. Bei Gelegenheit hinterfragen.

---

## 2026-05-27 — Phase 3A: Server & Channels (live) 🧩

Discord-artige Text-Server am Launch-Tag fertiggestellt + deployed (~3 Wochen vor Plan).

### ✨ Added
- **Server & Text-Channels** mit Roles, Multi-Role-Permissions (Bitfield), Audit-Log.
- **Channel Send/Receive** end-to-end: Absendernamen, Unread-Badge, Live-Rename,
  Reaction-Toasts, channel-agnostische GSK-Pipeline (Multi-Device via `request_gsk`).
- **Channel-Auto-Delete** (admin-gated via `MANAGE_CHANNELS`) — type-aware Backend.
- **Server-Invites**: Token-Link erstellen/beitreten/verwalten/widerrufen
  (`server_invites`-Tabelle, `INVITE_MEMBERS`-gated, Cron-Cleanup abgelaufener Invites).
- **WS-Live-Updates** für Member-/Channel-/Role-Änderungen am offenen Server.
- i18n de/en/es für alle neuen Strings.

### 🐛 Fixed
- `/chat/list`, `/groups/auto-delete` + Membership-Checks **type-aware** (Channels in
  `server_members`, nicht `conversation_members`) — behob 403/leere History + „0 Mitglieder".
- Invite-Link-Kopieren via Modal mit Copy-Button (Safari/iOS-Clipboard-Geste).

---

## 2026-05-27 — v1.0.0: Public Open-Source-Release 🚀

RENEX-Repository öffentlich verfügbar: [`github.com/bruno-renex/renex`](https://github.com/bruno-renex/renex).

### ✨ Added

**Spec & Standard:**
- [`PROTOCOL.md`](./PROTOCOL.md) als **Stable v1.0** veröffentlicht — Open Standard
  `renex/1` für Passkey-only, AI-freie, E2E-verschlüsselte Echtzeit-Kommunikation.
- Sub-Specs: [`MULTI_DEVICE.md`](./MULTI_DEVICE.md), [`RECOVERY.md`](./RECOVERY.md),
  [`GROUPS_MULTIDEVICE.md`](./GROUPS_MULTIDEVICE.md), [`VOICE.md`](./VOICE.md).
- [`THREAT_MODEL.md`](./THREAT_MODEL.md) v0.1 (pre-beta): 10 adversaries
  (4 defended / 2 partial / 4 not-defended), 8 acknowledged weaknesses with
  v2 migration plan, crypto-primitives summary.
- [`MANIFESTO.md`](./MANIFESTO.md) v1.2 — human-first tone-shift; FAQ erweitert
  §8 (Matrix/Element/Session/SimpleX), §9 (Apple/Google-Lock-in via Passkeys),
  §10 (PWA-Trust + reproducible builds).

**Lizenz-Setup:**
- Spec, Docs, Frontend: MIT ODER Apache-2.0 (max. Verbreitung).
- Reference-Server: AGPL-3.0-only (Schutz vor Big-Tech-Forks-ohne-Beitrag).
- LICENSE-File ins Englische übersetzt für internationale Audience.
- DCO (Developer Certificate of Origin) als Contributor-License-Modell.

**GitHub-Setup:**
- CI via GitHub Actions: `ci.yml` mit Node 20+22 Matrix, Frontend-Build,
  Spec-Sanity-Check (validiert dass alle required docs + LICENSE-Files
  existieren, inkl. THREAT_MODEL.md).
- Issue-Templates: `bug_report.md`, `feature_request.md`, `spec_question.md`,
  `config.yml` (blank-issues disabled, Security-Advisories + Discussions
  als contact_links).
- `PULL_REQUEST_TEMPLATE.md` mit Spec-Compatibility-Checklist +
  Tri-License-Confirmation.
- `dependabot.yml`: wöchentlich Mo 06:00 Europe/Zurich, npm + github-actions.
- `CODEOWNERS`: `@bruno-renex` als Default-Owner, explizit für Spec-,
  Security- und Licensing-Files.
- Security-Policy ([`SECURITY.md`](../SECURITY.md)), Bug-Bounty-Lifetime-Pass.

### 🔄 Changed

- `wrangler.toml` aus repo entfernt; `wrangler.toml.example` mit Placeholder-IDs
  für Forks.
- README-Wording entschärft für Reddit/HN-Survivability (siehe Commit
  `d9dc841`): „first passkey-only" → „passkey-native", „Zero bots" →
  „bot-resistant", technisch ungenaues „biometrischer Schlüssel" → korrekte
  WebAuthn-Erklärung.
- VISION.md: Phase 2 (Open-Source-Launch) als **LIVE** statt KW5-6 markiert;
  Decision-Log-Eintrag für Public-Release-Date 2026-05-27.
- Landing-Page (app.renex.id): tone-shift + technische Korrekturen + visuelle
  Gleichwertigkeit (Commit `8fd3ff8`).
- SECURITY.md: GitHub Private Vulnerability Reporting als primary channel
  (PGP-Erwähnung entfernt).
- CONTRIBUTING.md: align mit pre-public repo-refactor (PR-from-fork-Workflow).
- `backend.js`: Comment-Header klärt Rolle als Cloudflare-Worker-Entry-Point
  (wrangler `main = "backend.js"`).

### 🗑️ Removed

- `deploy.sh.legacy` (pre-Phase-1A.6.6-Cutover backup, nicht mehr referenziert).
- `deploy-svelte.sh` (Phase-1A.6 transitional Svelte-parallel-Deploy; Cutover
  abgeschlossen, `deploy.sh` deployt jetzt Svelte).
- Backup-SQL-Files (`backup-*.sql`, `backup-pre-multidevice-*.sql`) aus
  voller git history entfernt via `git filter-repo` — `.git`-Größe 14 MB → 2.2 MB.

### 🔒 Security

- **Pre-beta NOT AUDITED warnings** prominent in README + SECURITY.md
  mit Link zu THREAT_MODEL.md.
- gitleaks-Scan über volle history: 0 echte Secrets (3 false positives:
  `PRIV_JWK_KEY` ist localStorage-Key-Name).
- Voice 1:1 Security-Audit + Härtung abgeschlossen (Phase 8a):
  `/voice/hangup`/`/voice/cancel` Participant-Check, `/voice/room/*`
  deaktiviert (war Klartext-SDP-Pfad), `auth`-Feld REQUIRED auf
  `/voice/ring` + `/voice/answer`. Server-Härtung: fail2ban, SSH-Lockdown,
  COTURN_SECRET rotiert, denied-peer-ip + Quotas.
- npm audit: `devalue` 5.7.1 → 5.8.1 (HIGH: DoS via sparse-array
  deserialization), `svelte` 5.55.5 → 5.55.9 (4× moderate: XSS spread-attr,
  SSR Promise, DOM clobbering, ReDoS in `svelte:element`). 7 verbleibende
  moderate sind dev-only (esbuild/vite dev-server CORS), acceptable for
  pre-beta — `vite 5→8` breaking update deferred post-launch.

### 🐛 Fixed

- **Multi-Device CMK Race after Guest-Convert** (Commit `b3317ce`):
  Backend persistent `cmk_req` via DO-backlog + sender-side device-add
  re-subscription; Frontend `migratePeerHandle` returns `migratedDmPeers`
  → caller triggers `republishCMKForPeer` per peer so wrap lands under new
  cid. UI-Banner in ChatView („🔐 Some messages are still encrypted — @peer
  needs to come online briefly") + i18n DE/EN/ES. Documented as
  `THREAT_MODEL.md` §4.1. Real-world-impact niedrig (Standard-Flow trifft
  Race nicht), aber strict-E2E-konformer truly-lost-Pfad jetzt sauber.
- `docs/RECOVERY.md` L607: stale Referenz `bash deploy-svelte.sh` →
  `bash deploy.sh`.

### 📝 Notes

Status: **Pre-Beta**. Erste Public Beta-User erwartet Juli 2026 (Phase 7).
Voice-Channels (Multi-Party, LiveKit) + Signal-Protocol-Migration kommen
in Phase 8b–8d (Aug-Nov 2026) als „v2.0-Update".

External audit geplant Year 2 (vor v1.0.0-Stable nach Audit-Completion).

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
