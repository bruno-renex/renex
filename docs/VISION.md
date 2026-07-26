# RENEX — Vision & Strategy

> ⚠️ **VERALTET (Stand 2026-07).** Dieses Dokument beschreibt die ursprüngliche
> Ausrichtung („Gamer-First", Discord-Alternative) von Anfang 2026. Der aktuelle
> Fokus ist der **Organisation-→-Bürger-Kanal** (verschlüsselter, dauerhafter
> Chat per QR-Code, ohne Konto für die Empfänger:innen) — siehe
> [`../README.md`](../README.md). Server/Channels sind eingefroren.
> Die Überarbeitung dieses Dokuments steht aus; bis dahin ist der README die
> verbindliche Quelle.

> **BUILT TO RESIST AUTOMATION. PASSKEY-ONLY. HUMAN-FIRST.**

**Status:** Living document
**Version:** 1.0
**Letzte Aktualisierung:** 2026-06-02
**Autor:** Bruno Hochstrasser

---

## Inhaltsverzeichnis

1. [Mission & Vision](#1-mission--vision)
2. [Die 5 Grundprinzipien](#2-die-5-grundprinzipien)
3. [Zielgruppe](#3-zielgruppe)
4. [Differenzierung](#4-differenzierung)
5. [Strategische Entscheidungen](#5-strategische-entscheidungen)
6. [Multi-Device-Architektur](#6-multi-device-architektur)
7. [Technologie-Stack](#7-technologie-stack)
8. [Monetarisierung](#8-monetarisierung)
9. [Brand & Marketing](#9-brand--marketing)
10. [Roadmap-Übersicht](#10-roadmap-übersicht)
11. [Erfolgs-Metriken](#11-erfolgs-metriken)
12. [Was RENEX NICHT ist](#12-was-renex-nicht-ist)

---

## 1. Mission & Vision

### Mission
Wir bauen den ersten Messenger der Welt mit konsequenter **Passkey-Only-Authentifizierung** und garantiert **AI-freier Kommunikation** — ein digitaler Raum, in dem nur Menschen miteinander reden.

### Vision (5 Jahre)
RENEX ist 2031 der bevorzugte Messenger für jede Community, die echte menschliche Kommunikation schätzt:
- **Gamer-Communities** als Discord-Alternative
- **Privacy-bewusste User** als Signal/WhatsApp-Alternative
- **Aktivisten und Journalisten** als sicherer Kanal
- **Kleine Teams und Vereine** als Slack-Alternative

Das **RENEX Protocol** ist der globale Standard für AI-resistente, biometrisch-authentifizierte Echtzeit-Kommunikation.

### Tagline
> **"YOU ARE THE KEY."**

---

## 2. Die 5 Grundprinzipien

Jede technische und produktstrategische Entscheidung wird gegen diese 5 Prinzipien geprüft. Wenn ein Feature mindestens eines verletzt → Feature wird verworfen.

### 1️⃣ Passkey-Only
- **Keine Email**, keine Telefonnummer, keine Passwörter — niemals.
- Authentifizierung ausschließlich via WebAuthn / FIDO2.
- Die Identität des Users IST sein biometrischer Schlüssel.
- Recovery via 12-Wort-Phrase (BIP39).

### 2️⃣ Anti-AI (best-effort, kein Versprechen)
- Ziel: keine Bots, keine AI-Agents, keine automatisierten Accounts — gebaut um Automatisierung *teuer* zu machen, nicht um „keine AI" zu garantieren.
- Technisch erschwert: keine Bot-API, keine Webhooks, kein Integration-Layer, Captcha-Hardening, Rate-Limits.
- Sozial flankiert: AGB explizit, Bann bei Verstoß.
- Ehrlich: 100% AI-frei ist nicht garantierbar (siehe Manifesto + Honest-Claim). Wir kämpfen dafür — versprechen es aber nicht.
- "Pure Human Verified"-Badge im Profil (Signal, kein Beweis).

### 3️⃣ Open Standard
- Vollständig dokumentiertes Protokoll (RENEX Protocol v1).
- Open Source unter MIT/Apache 2.0 Dual-License.
- Jeder kann eigene RENEX-kompatible Server und Clients bauen.
- Conformance-Test-Suite öffentlich.

### 4️⃣ Privacy by Default
- Server lernt minimal über User.
- Kontaktlisten nicht zentral abgespeichert.
- Keine Werbung. Niemals.
- Keine Analytics-Tracker (Cloudflare-eigene Privacy-Analytics ok).
- Schweizer Datenschutz-Standard (DSG + DSGVO).

### 5️⃣ Gamer-First UX
- Optimiert für Latency, Voice, Communities.
- Niedrige Cost-of-Entry (PWA, kein Native-App-Download).
- Performance > Schnickschnack.
- Push-to-Talk, Screen-Sharing, niedrige Latency Voice.

---

## 3. Zielgruppe

### Primary Persona: "Mark der Gamer"
- Alter: 18-35
- Spielt täglich 2-4h (CS2, Valorant, Dota 2, LoL, MMO)
- Nutzt aktuell Discord für Clan-Kommunikation
- Frustriert von:
  - Discord-DMs sind nicht E2E-verschlüsselt
  - AI-Bots fluten Discord-Server
  - Discord-Nitro-Paywall
  - Datenschutz-Skandale (Polizei-Anfragen, Logs-Leaks)
- Motivation: Echte Privatsphäre + bessere UX + AI-freier Raum

### Secondary Persona: "Anna die Aktivistin"
- Alter: 25-45
- Privacy-bewusst (nutzt schon Signal)
- Sucht Alternative für Gruppenkommunikation
- Schätzt Schweizer Hosting + Open Source

### Tertiary Persona: "Daniel der Indie-Studio-Owner"
- Alter: 30-50
- Betreibt kleines Game-Studio oder Indie-Community
- Will eigene Community-Hub ohne Discord-Abhängigkeit
- Bereit zu zahlen für Custom-Branding (B2B-Zielgruppe)

---

## 4. Differenzierung

### Wettbewerbsmatrix

| Feature | Discord | Signal | WhatsApp | Telegram | Threema | **RENEX** |
|---|---|---|---|---|---|---|
| Passkey-only Auth | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ **Erster** |
| AI/Bot-Verbot | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ **Erster** |
| E2E-DMs | ❌ | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| E2E-Gruppen | ❌ | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| E2E-Voice | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Voice-Channels (Drop-in) | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Server/Channels | ✅ | ❌ | ❌ | ⚠️ | ❌ | ✅ |
| Open Source | ❌ | ✅ | ❌ | ⚠️ | ❌ | ✅ |
| Open Standard | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ **Erster** |
| Schweizer Hosting | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Kein Phone/Email | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Multi-Device | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Rich Presence (Steam) | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |

### Unique Selling Propositions

1. **"Erster Passkey-only Messenger der Welt"** — technische Pionier-Position
2. **"Built to resist automation"** — sozial-technisches Prinzip (bewusst KEIN „AI-Free"-Versprechen, siehe Honest-Claim)
3. **"Discord-Quality, Signal-Privacy"** — Best-of-both-worlds
4. **"Schweizer Standard, weltweit verfügbar"** — Trust durch Herkunft

---

## 5. Strategische Entscheidungen

Diese Entscheidungen wurden bewusst getroffen und sind **NICHT verhandelbar** ohne explizite Strategie-Review:

### Plattform & Distribution
| Entscheidung | Wert | Begründung |
|---|---|---|
| Domain | `renex.id` | Bereits vorhanden, günstig |
| Default-Sprache | Englisch | Gamer-Markt = global = English |
| Weitere Sprachen | DE, ES | Schweizer Markt + Spanischer Markt |
| Native Apps | Nein, PWA only | Kosten-Optimierung, später Community-Forks |
| Hosting | Cloudflare (Schweiz/EU/Global) | Pay-per-use, keine Fixkosten |

### Architektur
| Entscheidung | Wert | Begründung |
|---|---|---|
| Authentifizierung | WebAuthn/Passkey only | Markenkern |
| E2E-Crypto | WebCrypto (Phase 1), Signal Protocol (Phase 8) | Schritt für Schritt |
| Voice 1:1 | WebRTC P2P + self-hosted coturn (Hetzner CH/DE) | Privacy-Max (TURN sieht nur encrypted SRTP), 10× günstiger als CF Realtime |
| Voice-Channels (Gruppen) | self-hosted LiveKit SFU (Apache-2.0) mit E2E Frame-Encryption über bestehendes GSK-System | Open-Standard-konform (Apache-2.0), Hetzner-self-hostbar, keine US-Jurisdiktion (FISA/NSL/CLOUD Act), Frame-Encryption hält Server zero-knowledge |
| Backend | Cloudflare Workers + D1 + KV + R2 + DO | Bereits vorhanden, edge-native |
| Frontend | Vanilla JS, ES Modules, kein Framework | Performance, Kontrolle, kleine Bundle-Size |

### Multi-Device (Plan B - "Vollständig")
| Entscheidung | Wert |
|---|---|
| Max Devices pro User | 5 |
| Device-Naming | Auto aus User-Agent (User-bearbeitbar) |
| Auto-Revoke | Nach 30 Tagen Inaktivität |
| Group-Chats Multi-Device | Ja, ab Phase 1 |
| Verifikation | TOFU + Auto-Verify-Toast (Apple-Style) |
| Add-Berechtigung | Implizit via Cross-Device-Passkey + Bestätigungs-Toast |
| Revoke-Rotation | Hybrid: Rotation bei User-Revoke, keine bei Auto-Revoke |
| Historie auf neuem Device | Fresh start + 7-Tage-Recent-CMK-Share |

### Gaming-Integration
| Entscheidung | Wert | Begründung |
|---|---|---|
| Steam Rich Presence | Ja | 80% PC-Gamer-Coverage, kostenlos |
| Twitch | Phase 3+ | Kleinere Zielgruppe, später |
| Discord-RPC | Nein | Anti-Discord-Konflikt |
| Manueller Status | Ja | Konsolen-Fallback, alle Plattformen |

### Open Source
| Entscheidung | Wert |
|---|---|
| Frontend | Open Source (MIT/Apache 2.0) |
| Backend | Open Source (MIT/Apache 2.0) |
| Spec | Public, versioniert |
| Repository | `github.com/bruno-renex/renex` (öffentlich ab 2026-05-27) |
| Contributor-Lizenz | DCO (Developer Certificate of Origin) |

---

## 6. Multi-Device-Architektur

### Konzept
Jedes Device des Users hat ein **eigenes Keypair** + **eigenen Sync-State**. Alle Devices empfangen alle Nachrichten, jedes verschlüsselt für sich.

### Device-Lifecycle
```
NEW          → frisch registriert, hat noch keine CMKs
SYNCING      → wartet auf CMK-Distribution von Peers
ACTIVE       → hat alle CMKs, kann lesen+senden
REVOKED      → vom User entfernt, Pubkey gelöscht
```

### Add-Device-Flow
1. User auf neuem Gerät → Login via Cross-Device-Passkey (Bluetooth/QR)
2. Neues Device generiert Keypair, lädt Pubkey hoch
3. Existierende Devices empfangen `device_added` Event
4. Existierende Devices re-encrypten CMKs aller laufenden Konversationen mit neuem Pubkey
5. Toast auf existierendem Device: "Neues Gerät 'Mac (Safari)' wurde hinzugefügt — [Das war ich] [Sofort entfernen]"

### Send-Flow (Multi-Device)
```
Sender (bertha004 von iPhone) sendet Nachricht an christa4:
  ↓
Backend liefert: alle Pubkeys von christa4 (3 Devices) + alle anderen Pubkeys von bertha004 (1 Device: Mac)
  ↓
Sender encryptet 4 Payloads:
  - [christa4-iphone, christa4-mac, christa4-tablet, bertha004-mac]
  ↓
Server speichert message mit payloads[]
  ↓
WebSocket pusht an alle 4 Empfänger-Devices
  ↓
Jedes Device entschlüsselt nur seinen eigenen Payload
```

### Revoke-Flow
- **User-Revoke** (Sicherheits-Aktion): CMK-Rotation für alle Konversationen
- **Auto-Revoke nach 30 Tagen**: keine Rotation, nur Pubkey-Löschung

### Recovery
- BIP39 12-Wort-Phrase beim ersten Login angezeigt
- Phrase verschlüsselt einen Master-Key
- Master-Key verschlüsselt alle CMKs in R2-Bucket
- Auf neuem Gerät: Phrase eingeben → alle Konversationen wiederherstellbar

> **📐 Detail-Spec:** Vollständige Spec inkl. Sequence-Diagrams, State-Machine,
> API-Surface, Edge-Cases siehe [`MULTI_DEVICE.md`](./MULTI_DEVICE.md).
> Bei Widerspruch zwischen diesem Dokument und MULTI_DEVICE.md gewinnt MULTI_DEVICE.md.

---

## 7. Technologie-Stack

### Frontend
- **Svelte** (ab Phase 1A.6 — Migration von Vanilla JS)
- **Vite** (Build-Tool)
- **PWA** (Service Worker, Web Push, Manifest)
- **WebAuthn API** (Passkey-Auth)
- **WebCrypto API** (E2E-Verschlüsselung)
- **WebRTC** (Voice/Video, Datachannel)
- **IndexedDB** (lokaler Message-Cache, E2E-Keys)
- **CSS Custom Properties** (Theming)
- **i18n** via JS-Module (de.js, en.js, es.js)
- **Sentry** (Frontend Error-Tracking, ab Phase 1A.5)
- **Vitest** (Unit-Tests, ab Phase 1A.5)

### Backend (Cloudflare-only)
- **Workers** (TypeScript optional, derzeit JS)
- **D1** (SQLite global) — Messages, Conversations, Users
- **KV** (Key-Value) — Sessions, Cache, Pubkeys, CMKs
- **R2** (S3-kompatibel) — Files, Backups, Custom-Emojis
- **Durable Objects** — User-Sessions, WebSocket-Verbindungen
- **Realtime** — WebRTC TURN/SFU
- **Turnstile** — Captcha (Anti-Bot)
- **Email Routing** — nur für Marketing-Liste, NICHT für User-Auth

### DevOps
- **wrangler** — Deployment
- **GitHub Actions** — CI (Lint, Tests, Conformance)
- **deploy.sh** — Auto-Versionierung + Cache-Buster
- **Cloudflare Logpush** — Production-Logs

### Open Standards
- **WebAuthn / FIDO2** (Passkey-Auth)
- **Web Push (RFC 8030)** (Notifications)
- **WebRTC (RFC 8825+)** (Voice/Video)
- **BIP39** (Recovery Phrase)
- **Signal Protocol** (E2E, **Phase 4-Migration nach Beta** — aktuelles CMK-System bleibt für Beta)
- **RENEX Protocol v1** (eigener Open Standard)

### Lizenz-Strategie
- **Spec & Frontend:** MIT/Apache 2.0 Dual (max. Verbreitung als Standard)
- **Reference Backend:** AGPL v3 (verhindert Big-Tech-Forks-und-Hide)

---

## 8. Monetarisierung

### Phase 1: Komplett kostenlos (Monat 0-6)
- Fokus: User-Wachstum
- Spenden via GitHub Sponsors / Open Collective
- Ziel: 1'000 aktive User

### Phase 2: Founder's Pass (Monat 6-12)
- $25 einmalig, Lifetime Pro
- Limitiert auf erste 1'000 User
- Schafft Hype + initialen Cashflow ($25k einmal)

### Phase 3: RENEX Pro Subscription (ab 5'000+ Usern)
- **$5/Monat** oder **$50/Jahr**
- **Pro-Features:**
  - Custom-Emoji-Slots: 100 statt 25
  - Custom-Server-URL: `renex.id/clan-name`
  - Höhere File-Limits: 500 MB statt 50 MB
  - Custom-Themes: Server-Branding
  - Priority-Voice-Quality: 64kbps Stereo statt 32kbps Mono
  - Mehr Devices: 10 statt 5
  - Pro-Badge im Profil
  - Profile-Effekte: animierte Avatare
  - Priority-Support
- **Conversion-Ziel:** 1-3% der aktiven User

### Phase 4: B2B Server-Hosting (Jahr 2)
| Tier | Preis | Members | Features |
|---|---|---|---|
| Community | Free | 500 | Standard |
| Pro Server | $20/Mo | 5'000 | Custom Brand, mehr Storage |
| Esports Server | $99/Mo | 25'000 | SLA, Tournaments-Tools |
| Studio Server | $499/Mo | 100'000 | Custom-Domain, Dedicated Support |

### Phase 5: B2B SaaS für Privacy-bewusste Firmen (Jahr 2-3)
- $5/User/Monat
- Zielgruppe: Anwaltskanzleien, Arztpraxen, NGOs, Schweizer Banken
- Compliance-Pakete (DSG, HIPAA, GDPR)

### Phase 6: Anti-AI Verification API (Jahr 3-5, Moonshot)
- "Verified Human via RENEX" als Service für andere Plattformen
- $0.01-0.10 pro Verifikation
- Potenzielles Hauptgeschäft langfristig

### Was wir NIE machen:
- ❌ Werbung
- ❌ Daten verkaufen
- ❌ Verschlüsselung paywallen
- ❌ Privacy-Features paywallen
- ❌ Tracking-Pixel

---

## 9. Brand & Marketing

### Brand-Identität
- **Name:** RENEX
- **Etymologie:** Frei wählbar — "Renaissance + Connection" oder "Real Network Exchange"
- **Tagline:** "YOU ARE THE KEY."
- **Sub-Taglines:**
  - "BUILT TO RESIST AUTOMATION."
  - "PASSKEY-ONLY."
  - "HUMAN-FIRST."
  - "Made in Switzerland 🇨🇭"

### Visual Identity
- **Farben:** Dark theme (Cyberpunk-meets-Swiss-Precision)
  - Primär: `#38bdf8` (cyan/sky-blue) — bereits etabliert
  - Hintergrund: `#0f0f12` (fast-schwarz)
  - Akzent-Warn: `#ef4444` (red)
  - Akzent-Erfolg: `#10b981` (green)
- **Typografie:** System-Fonts (Performance) + Monospace für Code/Keys
- **Logo:** Existierendes RENEX-Logo (siehe `renex-logo.svg`) — evtl. Modernisierung Phase 6

### Voice & Tone
- Direkt, ehrlich, ohne Marketing-Bullshit
- Technisch fundiert, nicht condescending
- Gamer-Slang ok, aber nicht aufgesetzt
- Privacy-Leidenschaft sichtbar
- AGGRESSIV gegen AI-Hype: "Wir sind die Gegenbewegung."

### Marketing-Channels
1. **Reddit** — r/gaming, r/cs2, r/dota2, r/leagueoflegends, r/privacy, r/selfhosted
2. **Hacker News** — Launch-Posts, technische Tiefe
3. **Twitter/X** — Daily Updates, Streamer-Engagement
4. **YouTube/Twitch** — Streamer-Outreach für Reviews
5. **GitHub** — Open-Source-Community, Stars als Social-Proof
6. **Schweizer Tech-Medien** — netzwoche, inside-it.ch, Privacy-fokussierte Outlets

### Launch-Slogan-Optionen
- "The Messenger Built to Resist Automation"
- "For Humans. By Humans. About Humans."
- "Discord Without the BS"
- "Your Voice. Your Key. Your Privacy."

---

## 10. Roadmap-Übersicht

**Ziel: Beta-Launch Ende Juni 2026** *(~7 Wochen ab 2026-05-13, ~3 Wochen vor ursprünglichem Plan)*

> **Roadmap-Pivot 2026-05-13:** Beta-Launch um ~3 Monate nach vorne gezogen.
> Wesentliche Änderungen: Phase 3 → Phase 3A (Voice deferred), Phase 4 deferred,
> Phase 5 → Phase 5-Light, Phase 2 parallelisiert zu Phase 3A. Begründung: Phase 1
> ist exzellente Foundation (Multi-Device-Krypto stable), Voice ist eigener Tech-Stack
> (3-4 Wochen), Markenkern „Anti-AI + Passkey-Only + Text-Discord-Killer" ist auch ohne
> Voice valid. Voice + Signal Protocol gemeinsam in Phase 8 als v2.0-Sicherheits-Update.

> **Roadmap-Acceleration 2026-05-28:** Phase 3A 3 Wochen vor Plan fertig (2026-05-27),
> Phase 2 (Open Standard) parallel mitgeshipped, Phase 3A.5 Teil-Ship am Folgetag
> (3 von 7 Items). Damit komplette Beta-Roadmap um weitere ~3 Wochen vorgezogen:
> Phase 5-Light Wo 5 → Wo 2, Phase 6 Wo 7 → Wo 4, Phase 7 Beta-Launch Mitte/Ende Juli
> → Ende Juni, Phase 8 (Voice + Signal) Aug-Nov → Juli-Okt. Risiko: Phase 5-Light
> Captcha hat externe Dependency (Cloudflare-Turnstile-Dashboard-Setup) — async-Block
> möglich. Siehe Decision Log Eintrag 2026-05-28.

**Strategie-Wahl: Option B (Pragmatisch)** — Svelte jetzt, Signal Protocol nach Beta.

### Phase 0 — Vision-Foundation ✅ *(Woche 1)*
Master-Docs geschrieben (`VISION.md`).

### Phase 1A — Notifications ✅ *(Woche 1)*
- Push-Banner für alle Geräte
- iPhone PWA-Push funktioniert
- Debug-Tool dauerhaft eingebaut

### Phase 1A.5 — Tests + Monitoring *(Woche 2: Anfang Mai)*
- Sentry einbauen (Frontend + Backend)
- Vitest setup
- Erste Unit-Tests für Crypto-Code

### Phase 1A.6 — Svelte-Migration *(Woche 2-4: Mai)*
- Vite + Svelte parallel zur Vanilla-Codebase
- Bestehende Features 1:1 portieren
- Vanilla-Code deprecaten

### Phase 1B — Multi-Device DM *(Woche 5-6: Juni)*
**Mit aktuellem CMK-System** (Signal Protocol Phase 4):
- Device-Backend-API (5 Devices max, 30d Auto-Revoke)
- Multi-Send (alle Devices encrypten)
- CMK-Redistribution via cmk_req-Flow
- Recovery-Phrase (BIP39) + iCloud-Sync optional
- Device-Management-UI

### Phase 1C — Multi-Device Groups ✅ *(2026-05-10)*
- GSK-Multi-Device
- Group-Member-Device-Tracking
- Tests mit 5×5 Konfiguration

### Phase 1B/1C Loose-End ✅ *(2026-05-13)*
- AddDeviceModal mit QR-Onboarding-Helper (siehe `MULTI_DEVICE.md` §12.1)

### Phase 3A — Text-Server & Channels ✅ *(fertig 2026-05-27 — ~3 Wochen vor Plan, live getestet)*
**Voice ausgeklammert** — siehe [`SERVERS.md`](./SERVERS.md) Decision Log 2026-05-13.
- ✅ Server/Channel-Konzept (Datenmodell, Roles, Permissions, Audit-Log)
- ✅ Sidebar-Refactor (Server-Stack + DMs + Standalone-Groups)
- ✅ Server-Settings-UI (Roles, Members, Channels-Auto-Delete, Invites-Verwaltung)
- ✅ Permission-Resolution-Algorithmus (Frontend-Hide + Backend-Enforce)
- ✅ Multi-Device-Code-Erweiterung: `redistributeGSKsForPeerDeviceAdded` umfasst Channel-Memberships
- ✅ Channel Send/Receive end-to-end (Absendernamen, Unread-Badge, Live-Rename, Reaction-Toasts)
- ✅ Channel-Auto-Delete (admin-gated via MANAGE_CHANNELS)
- ✅ Server-Invites (Token-Link erstellen/beitreten/verwalten/widerrufen, `server_invites`-Tabelle)
- ✅ WS-Live-Updates (server_member_joined/left, channel_*, role_*, member_role_*)
- ✅ i18n de/en/es für alle neuen Strings

**Deferred zu Phase 3A.5** (nicht beta-blockierend): Ban-System (`server_bans`),
Owner-Transfer, Account-Delete-Pre-Check für Server-Owner, Private Channels
(channel_permission_overrides-UI), Tier-Limits (Free/Pro), Server-Name/Icon/Beschreibung-Edit.

### Phase 3A.5 — Server-Mutation & Moderation ✅ *(fertig 2026-06-01 — komplettes deferred-Set aus Phase 3A in ~5 Tagen geschlossen)*
**7 von 7 Items live nach 2026-06-01** (Frontend `2026-06-01-2`, Schema-Migration `server_bans` deployed, `channel_permission_overrides` schon seit Phase 3A vorhanden, KV-basiertes `user:tier:<handle>`):
- ✅ `POST /servers/<id>/transfer` — Owner-Transfer, atomar via D1-batch, audit + WS `server_owner_changed`. RL 3/min.
- ✅ `PATCH /servers/<id>` — Name + Beschreibung partial-update, gated by `MANAGE_SERVER`. Audit `server_update` mit diff, WS `server_updated`. RL 30/min.
- ✅ `DELETE /account` Pre-Check — 409 `owner_transfer_required` mit Blocking-Server-Liste wenn User Owner eines Servers mit anderen Members ist. Auto-Owner-Succession entfernt (explicit transfer schlägt silent promotion).
- ✅ Server-Icon-Edit — POST/GET/DELETE `/servers/<id>/icon`, MIME-Allowlist (PNG/JPEG/WebP), ≤1 MB, R2-Key `server-icons/<sid>/<uuid>`, alter Icon-Key best-effort cleanup. Frontend: neuer "Allgemein"-Tab in `ServerSettingsModal` (gated MANAGE_SERVER, Default beim Open für admins), fetch+blobURL für Cross-Origin-credentials-Anzeige, Sidebar + Detail-Header mit Initial-Fallback. WS-Pipeline (`server_updated`) erweitert um Sidebar-relevante Events (Live-Update ohne Reload).
- ✅ Ban-System — neue Tabelle `server_bans` (PK composite, FK CASCADE), `POST /servers/<id>/members/<u>/ban` (BAN_MEMBERS gated, position-check strikt-höher, Owner nicht bannbar, Self-ban blockt, optional `{reason}` ≤500 chars, D1-batch ban-row + CASCADE delete aus members/role_assignments/channel_overrides/conversation_members). `GET /servers/<id>/bans` + `DELETE /servers/<id>/bans/<u>` für list + unban. `joinByTokenHandler` checkt Bans → 403 `user_banned` auf GET + POST. Frontend: Ban-Button per Member im Settings-Modal + neuer "Gebannt"-Tab mit Live-Counter via `serverStore.banEventVersion`, Self-Ban-Toast + auto-deselect im App.svelte WS-Handler. **Wichtiger fix:** `pushToUserDO` muss awaited werden (sonst kann CF Workers den fire-and-forget-Call terminieren, bevor das DO-fetch zur Zustellung kommt — Empfänger sieht nichts).
- ✅ Private Channels — GET/POST/DELETE `/servers/<id>/channels/<cid>/permissions` (Override-CRUD, MANAGE_ROLES gated, Position-Check für role-targets, Sentinel allow=0+deny=0 ⇒ row löschen). Server-seitige Filtering via `getVisibleChannelIds(env, sid, me)`: single-Query LEFT JOIN aller Channels + Overrides, in-memory `resolvePermissions()`, Owner + ADMINISTRATOR-Bit short-circuit (sehen IMMER alle). Zweite Pfade `serverDetail` und `channelsHandler` GET filtern Channels durch dieses Set — User sehen private Channels gar nicht erst in Sidebar. Frontend: neuer `ChannelEditModal.svelte` (Allgemein-Tab name/topic + Berechtigungen-Tab privacy-toggle + access-list mit role/member-add via dropdown), klickbarer Channel-Name in ServerSettingsModal's Channels-Tab öffnet das Modal, `serverStore` helpers `updateChannel`/`listChannelPermissions`/`setChannelPermission`/`deleteChannelPermission`. WS `channel_permissions_updated` registriert in App.svelte → triggers detail re-fetch + sidebar update. i18n DE/EN/ES für 16 neue Strings. MVP-Scope: Privacy-Toggle + VIEW_CHANNEL allow-list — volle Discord-Matrix (12 bits × N targets als Tri-State-Grid) ist Phase-2-Polish.
- ✅ Tier-Limits Free=3 / Pro=25 — neuer `getUserTier(env, handle)` Helper in `auth.js` (KV `user:tier:<handle>`, default 'free', Whitelist-Validation). `createServer` ersetzt hartes Limit durch tier-aware Lookup. Response bei 403 enthält jetzt `{error, limit, tier, upgradeAvailable: {proLimit} | null}` — Frontend rendert Free-User "Upgrade auf Pro für 25"-Message, Pro-User sehen Pro-Limit (kein weiterer Upgrade-Pfad). GET `/users/me` ergänzt um `tier`. DELETE `/account` cleanupt zusätzlich `user:tier:` KV-Key (DSGVO). i18n DE/EN/ES für 2 neue Strings. Tier-Set: `wrangler kv key put --binding=RENEX_KV "user:tier:<handle>" "pro" --remote`. Foundation für Phase 6 (Founder's Pass + Stripe-Webhook setzt KV-Eintrag).

**Komplett — alle 7 deferred-Items aus Phase 3A.**

**Follow-up Bug (aus Smoke-Test 2026-05-28) — ✅ behoben 2026-06-03:** `/servers/list` reportete für einen non-Owner kurzzeitig `is_owner=true`, später konsistent `false`. Root-Cause war **kein** Backend-Bug (Query/Schema/Daten korrekt), sondern ein **Cross-Account-State-Leak im Frontend**: `logout()` rief nur `userStore.clear()` ohne Page-Reload, die Per-Account-Stores (serverStore u.a.) leben im Modul-Scope und überlebten Logout→Login — die Server-Liste (inkl. `isOwner`) des Vor-Accounts blitzte kurz auf, bis `loadServers()` überschrieb. Fix: `window.location.reload()` in `logout()` (struktureller RAM-State-Wipe, IndexedDB/CMKs bleiben für Re-Login); ungenutztes `serverStore.reset()` als toter Code entfernt. Commit `1dfd528`, live `2026-06-03-3`.

### Phase 5-Light — Anti-AI Minimum ✅ *(fertig 2026-06-01, on-time per Roadmap)*
- ✅ **Captcha-Verschärfung an Server-Create + Invite-Accept** — Cloudflare Turnstile auf POST `/servers/create` + POST `/servers/join/<token>` (Backend `verifyTurnstile` Check via `TURNSTILE_SECRET`, Skip+Warn wenn nicht konfiguriert für Dev). Frontend: Turnstile-Widget in `CreateServerModal` + neuer **`ServerJoinModal`** der den vorherigen native `confirm()`-Dialog für `?join-server=...` Deep-Links ersetzt (Server-Card mit Name/Beschreibung/Member-Count/Inviter + Widget + Join/Cancel-Buttons). i18n DE/EN/ES für 9 neue Strings. Pattern aus Phase-1A-Register-Flow (LoginModal + authRoutes) wiederverwendet — keine neue Infra, keine Dashboard-Änderung. Anti-AI-Brand-Story: "Cloudflare Turnstile auf allen Community-Joining-Pfaden" ist jetzt unter app.renex.id live demonstrierbar.
- ✅ Rate-Limits für Server/Channel/Role-Endpoints (bereits mit Phase 3A geliefert — RL-Buckets in `serverRoutes.js`, inkl. inviteCreate/serverJoin)
- ❌ Hardware-Attestation: deferred zu Phase 9 (Year 1)
- ❌ Behavioral-Analysis: deferred zu Phase 9

### Phase 2 — Open Standard veröffentlichen 🚀 *(2026-05-27, vorgezogen von Wo 5-6)*
- GitHub-Repo `github.com/bruno-renex/renex` öffentlich am 2026-05-27
- Spec finalisiert ✅ ([`PROTOCOL.md`](./PROTOCOL.md) Stable v1.0 seit 2026-05-20)
- AGPL Backend / MIT+Apache Frontend ✅ ([`LICENSE`](../LICENSE) Triple-Setup)
- CI eingerichtet (GitHub Actions) — Tag-3 vor Launch

### Phase 6 — Brand & Launch-Prep *(Wo 4-5: 2026-06-09 → 2026-06-15, vorgezogen von Wo 7)*

> Hinweis: zwischen Phase 6 und Phase 7 ist [Phase 6.5 Pulse](#phase-65--pulse-presence-layer) eingeschoben.
> Falls Phase 6 länger braucht: Phase 7 um 1 Woche schieben, Pulse darf nicht skippen.

- ✅ **Landing-Page Redesign** *(erledigt 2026-06-03, live `2026-06-03-11`)* — Statement-first Hero (Option B): Kategorie-Kicker „Menschliche Kommunikation" + Brand-Statement „Du hast einen Puls. Bots nicht." statt sofortigem Login-Formular (Login klappt per CTA auf, Guest-Convert springt weiter direkt zur Card). Das statische Partikel-Netzwerk (`LandingParticles`, **entfernt**) ist durch `PulseLandingCanvas` ersetzt: interaktive, cursor-/touch-getriebene Pulse-Demo (Cyan-anchored + Gold-Foam-Spike, `prefers-reduced-motion`-Fallback, Battery-aware, autonomer „Heartbeat" auf Touch-Geräten) — RENEX' Signature-Feature schon **vor** dem Login erlebbar. Renderer bewusst nach `lib/pulse/particles.js` extrahierbar (Phase-6.5-Bootstrap). **KEIN DeviceMotion auf der Landing** (iOS-Permission-Prompt = Conversion-/Vertrauens-Killer; Sensor bleibt fürs In-App-Pulse-Feature). Feature-Copy ergebnis-orientiert geschärft (Guest↔Passkey-Widerspruch aufgelöst, Twilio/CF-Realtime/Sentry-Jargon raus). Erstes Social-Proof-Signal: Open-Source-Badge + GitHub-Link. Neue `LandingShowcase`-Section mit **provisorischem** App-Screenshot (wird nach Pulse-Ship gegen Shot mit sichtbarer Pulse-Visualisierung getauscht). i18n de/en/es.
- Demo-Video + GIF für PWA-Install-Onboarding (Product-Demo Screen-Recording, kein on-camera)
- Press-Kit
- ✅ **AGB-Update** *(erledigt 2026-06-03, live `2026-06-03-5`)* — Anti-AI/Anti-Bot-Best-Effort-Klausel (§3a in `/agb` + `/terms`, war bereits da) + vollständige DSG/DSGVO-Auftragsverarbeiter-Liste §9 in `/datenschutz` + `/privacy` (Cloudflare, Turnstile, GIPHY, Hetzner, Sentry, Web-Push). Web-Push-Eintrag um expliziten USA-Drittlandtransfer (Apple APNS / Google FCM, EU/UK/Swiss-U.S. Data Privacy Framework) + RFC-8291-E2E der Payloads ergänzt; Stand-Datum 3. Juni 2026.
- ✅ **Manifesto öffentlich machen** *(erledigt 2026-06-03, live `2026-06-03-4`)* — Static-Site live auf `renex.id/manifesto` (EN) + `renex.id/manifest-de` (DE), aus EN/DE-Markdown gebaut (`scripts/build-manifesto.js`, shared OG-Image). Erreichbar aus der App: neue `LandingManifesto`-Call-out-Section auf der Landing (zwischen Features und Footer) + Footer-Link + In-App-Link "📜 Manifest" im ProfileDropdown. Sprach-abhängige URL (DE → `/manifest-de/`, sonst `/manifesto/`), i18n de/en/es. **Offen/Follow-up:** zusätzliche "Why Pulse" + "Anti-AI Best-Effort Transparency" Sections im Manifest-Content selbst (Markdown-Erweiterung, separater Schritt).

**Bewusst NICHT in Phase 6:** Founder's Pass / Stripe-Integration. Per Monetization-Plan §6 ist **Phase 1 (Monat 0-6 nach Beta-Launch) komplett kostenlos**. Founder's Pass startet in **Phase 2 Monetization-Tier (~Dezember 2026 / Januar 2027)**, separates Build-Window, eigener Sprint. Vorteil: kein Schweizer Business-Stripe-Konto-Setup als Phase-7-Blocker, Tier-Limits-KV-Foundation (Phase 3A.5) ist eh schon ready, der Webhook-Bau ist in 2 Tagen machbar wenn Zeit reif.

### Phase 6.5 — Pulse (Presence Layer) ✅ ✨ *(Wo 6 geplant: 2026-06-16 → 2026-06-22 — MVP + vNext geshipped 2026-06-06, ~2 Wochen vor Plan)*
> ✅ **MVP geshipped 2026-06-03, live `2026-06-03-13` — ~2 Wochen vor Plan.** Smoke-Test grün (renex ↔ Peer, beide Seiten, E2E). Engine (11 Unit-Tests), Inputs (Maus/Wheel/Tippen/Backspace + Touch/Motion), iOS-Permission-Flow, PulseCanvas (Peer-Puls, Cyan + Gold-Foam, reduced-motion-Fallback, Battery-pause), Backend `type:"pulse"` Short-Circuit (kein D1, eigenes RL-Bucket 15/s, awaited Forward), Send/Receive über die bestehende Session-CMK-Pipeline (E2E, keine Signatur — Belief-Layer), Per-Chat-Opt-in (default OFF) + Toggle mit Mini-Self-Indicator (✨ pulsiert mit eigener Energie), Logout-Wipe. i18n de/en/es. **Bewusst deferred (MVP):** First-Use-Onboarding-Animation (§9.5), Battery-API <20%-Drosselung (§8.4, Tab-Pause ist drin), Sound (Phase 8). **Follow-up offen:** „Why Pulse" in MANIFESTO.md publizieren (Trigger jetzt erfüllt, PULSE.md §19); Landing-Showcase-Screenshot gegen einen mit sichtbarem Pulse tauschen (✅ erledigt 2026-06-06 → Loop-Video, siehe vNext).
>
> ✅ **vNext geshipped 2026-06-06, live `2026-06-04-2 … 2026-06-06-14`.** Look-Rebuild auf **Leuchtkäfer** (weiche Glühpunkte, blinkend, gleichmäßig verteilt via Rand-Abstoßung statt Mitten-Kohäsion, kollektives Atem-Pulsieren — in-App `PulseCanvas` **und** Landing `PulseLandingCanvas`; keine Sterne/Ambient-Linien mehr). **Farb-System:** Cyan = Präsenz · Gold = Foam · Rosa = Handshake · Gold = Nicken. Soziale Gesten: **Handshake** (synchrones rosa Blinken, rein client-seitig, `SYNC_DURATION_MS=2900`), **Tap = Nicken** (goldene Wellen-Mote, `NOD_MS=2000`, via `sendNod`), **Silent Together** (Presence-Dot „● gerade da") + **Thinking Pulse** (`THINK_FLOOR=0.30`). **Reload-Sende-Bug gefixt** (`getCMKIfExists` statt `ensureSecureDmSession` → keine CMK pro Frame). **Landing-Showcase = Loop-Video** (`landing-pulse.mp4`, H.264, `<video autoplay loop muted playsinline>` + Poster `app-preview-pulse.png` + reduced-motion-Fallback). Bewusste Abweichungen vom Backlog + Details: [`PULSE.md`](./PULSE.md) §20. Damit ist Phase 6.5 (MVP + vNext) **komplett live**.

**Brand-defining ambient sensorische Schicht über 1:1-DM.** Mikro-Bewegungen (Maus, Touch, Acceleromter, Tippgeschwindigkeit) → abstrakte „Pulse"-Energie `0.0–1.0` → Canvas-2D-Partikel-Visualisierung. Sender + Empfänger sehen visualisiertes Lebenszeichen des Gegenübers.

**Strategische Positionierung:**
- KEIN Captcha-Replacement, KEIN Anti-Bot-Gate — sondern **Belief-Layer**. „Wenn du mit jemandem chattest, siehst du dass er atmet. Bots haben keinen Pulse."
- Macht RENEX's „For Humans. By Humans." von Slogan zu fühlbarer Erfahrung.
- TikTok-viral-ready (3 Demo-Clip-Konzepte geplant).
- Anti-AI-Story bekommt visceral Demo-Material — niemand sonst hat das.

**MVP-Scope (Wo 6, 1 Woche):**
- 1:1-DM only (Group-Pulse + Voice-Sync deferred Phase 8)
- PWA-only (PC + iOS-PWA + Android-PWA)
- Desktop-Inputs (Maus, Wheel, Tippen) + Mobile-Inputs (Touch, Acceleromter mit iOS-Permission-Flow)
- 4 Emotion-States (calm/active/excited/foam) mit Hysterese-FSM
- Cross-Device-Sync via existing Session-CMK Pipeline (kein neues Crypto, E2E intakt)
- Per-Chat Opt-In (`localStorage` per Peer, niemals KV-Sync)
- Battery-Mitigations (pause auf `document.hidden`, auto-reduce <20% Akku, `prefers-reduced-motion` Fallback)

**Hardrules (im Spec festgenagelt):**
- Pulse-Abwesenheit ist NIE Bot-Indikator (Accessibility — EU-Accessibility-Act, ADA)
- Kein DB-Write (transient WS-only)
- NUR `{ energy: float, mode: enum }` über die Leitung — niemals Raw-Inputs (Privacy)
- Pulse hat KEINEN Authority-Status für Auth-Pfade

**Trade-off mit Phase 7:** Wenn Phase 6 nicht in 2 Wo fertig wird → Phase 7 um 1 Wo schieben (Ende Juni → Anfang Juli). Pulse darf nicht skippen, weil:
1. Beta-Launch-Marketing-Story (HN/Reddit/TikTok) braucht visuellen Differenziator
2. Phase 8 erweitert es eh (Voice-Sync, Group), MVP muss vorher live sein
3. Anti-AI-Brand-Pitch ohne Pulse ist nur „wir haben Captcha", was Discord/Slack auch haben

**Detail-Spec:** [`PULSE.md`](./PULSE.md) Stable v0.1, mit Decision-Log + Threat-Model-Update + 5 Open Questions für nächste Brainstorm-Runde.

### Phase 7 — Public Beta-Launch 🚀 *(Ende Juni 2026, vorgezogen von Mitte/Ende Juli)*
- Erste 50-1000 Beta-User
- Reddit/HN/Twitter-Posts (realistisch: 1-2 viral)
- 5 Streamer-Outreach mit Demo-Video
- **Marketing-Story:** „Human-first Messenger, gebaut um Automatisierung zu widerstehen — Passkey-only, E2E, ohne Bot-APIs. Voice kommt in v2.0 (Q3 2026)." — **NICHT** „AI-Free-Garantie" (Over-Claim; siehe [`PRESS_KIT.md`](./PRESS_KIT.md) §6 Honest Claim + [`LAUNCH.md`](./LAUNCH.md) §1).
- Geduld: 6-12 Monate Network-Effects

### Post-Beta: Phase 8 — Voice + Signal Protocol *(Juli 2026 - Okt 2026, vorgezogen von Aug-Nov)*
**Doppel-Pack als v2.0. Voice-Stack split nach Topologie:**
- **1:1-Calls**: WebRTC P2P + self-hosted **coturn** (Hetzner CH/DE) → ersetzt CF TURN. Frame-Crypto via DTLS-SRTP wie bisher. Marketing-Pitch: „Direkter P2P-Pfad, Server sieht nie Plaintext."
- **Voice-Channels (Gruppen)**: self-hosted **LiveKit SFU** (Apache-2.0) auf Hetzner CH/DE. E2E via Insertable Streams + Frame-Encryption mit Keys aus bestehendem **GSK-System** (HKDF-Derivation pro Sender+chainIndex). Push-to-Talk + Screen-Sharing nativ über LiveKit-API.
- **NICHT mehr**: Cloudflare Realtime SFU (siehe Decision Log 2026-05-15 — Privacy + Open-Standard-Bruch).
- → Detail-Spec: `VOICE.md` *(TBD, Phase-8-Start)*
- libsignal-rust → WASM (E2E-Layer für Text-Chat)
- Double Ratchet ablöst CMK-Epochs
- Migration-Path mit Lessons-Learned von echten Usern
- Marketing-Spin: „v2.0 Sicherheits- + Voice-Update — Self-Hosted, Schweizer Datenschutz, Open Standard."

### Post-Beta: Phase 9 — Gamer-Features + Anti-AI Stark *(Year 1 Q3 2026 - Q4 2026, vorgezogen von Q4 2026 - Q1 2027)*
- Steam Rich Presence
- Custom Emojis (Pro-Limit)
- Soundboard
- Custom Status
- Hardware-Attestation
- Behavioral-Analysis
- „Pure Human Verified"-Badge
- Channel-Categories (`parent_id`)

### Post-Beta: Year 2
- B2B-Sales starten
- Sicherheits-Audit (Cure53/Trail of Bits, ~50k CHF)
- Native Apps via Community (Capacitor/Tauri-Wrapper)
- Pro-Tier launch ($5/Monat)

---

## 11. Erfolgs-Metriken

### Phase 0-1 (April - Mai)
- ✅ Vision-Doc geschrieben
- ✅ Notifications funktionieren auf iPhone PWA
- ✅ 0 `[E2E:DECRYPT] permanent_fail` mehr in Logs
- ✅ Multi-Device-Test mit 3 Geräten erfolgreich

### Phase 2-3 (Mai - Juni)
- ✅ GitHub-Repo public, ≥10 Stars in Woche 1
- ✅ Server/Channel funktioniert mit 5 Test-Servern
- ✅ Voice-Channel mit 5 gleichzeitigen Sprechern getestet

### Phase 4-6 (Juni - Juli)
- ✅ Steam-Integration mit eigenem Account demonstriert
- ✅ Anti-AI-Manifest-Page öffentlich
- ✅ Demo-Video produziert

### Phase 7 — Beta (Ende Juni - Juli) *(Roadmap-Acceleration 2026-05-28)*
- 🎯 **50 Beta-User** (Woche 1 nach Launch)
- 🎯 **500 aktive User** (Monat 1, Ende Juli)
- 🎯 **5 Founder's Passes verkauft** (Monat 1) → $125
- 🎯 **2'000 aktive User** bis Ende August

### Year 1 (April 2026 - April 2027)
- 🎯 **5'000 aktive User**
- 🎯 **100 Founder's Passes** verkauft → $2'500
- 🎯 **First Pro-Subscriptions launched**
- 🎯 **GitHub Stars ≥500**
- 🎯 **Erste B2B-Anfrage**

### Year 2 (April 2027 - April 2028)
- 🎯 **30'000 aktive User**
- 🎯 **300 Pro-Subscriber** ($1'500/Monat MRR)
- 🎯 **5 B2B-Server** ($300/Monat)
- 🎯 **Erste Sicherheits-Audit** abgeschlossen
- 🎯 **Signal Protocol Migration** abgeschlossen

---

## 12. Was RENEX NICHT ist

Klarheit über Nicht-Ziele ist genauso wichtig wie Ziele:

### RENEX ist KEIN…
- ❌ **Allgemeiner Discord-Klon** — wir kopieren nicht features, wir wählen kuratiert
- ❌ **AI-Companion-App** — wir verbieten AI explizit
- ❌ **Crypto/Web3-Wallet** — kein Token, keine NFTs, keine Speculation
- ❌ **Social-Network** — kein Feed, kein Algorithmus, kein Doomscrolling
- ❌ **Enterprise-Tool** — wir bleiben Community-fokussiert (B2B nur sekundär)
- ❌ **Monetarisierung-First** — kostenlos für alle Core-Features, immer
- ❌ **VC-Funded-Startup** — bootstrap-fähig, Wachstum ohne Investor-Druck
- ❌ **AI-Tools-Integration** — explizit ausgeschlossen
- ❌ **Anonymous-Network** — User haben echte Identität (via Passkey), aber datenschutzfreundlich

### RENEX wird nie…
- ❌ Werbung schalten
- ❌ User-Daten verkaufen
- ❌ Backdoors für Behörden einbauen
- ❌ AI-Generated-Content erlauben
- ❌ Public-API für externe Bots öffnen
- ❌ Verschlüsselung optional machen
- ❌ Phone/Email als Auth zulassen

---

## Anhang A: Glossar

| Begriff | Bedeutung |
|---|---|
| **CMK** | Conversation Master Key — symmetrischer Schlüssel pro Konversation |
| **DM** | Direct Message — 1:1-Chat |
| **Device** | Ein konkretes Gerät eines Users (iPhone, Mac, Browser-Tab) |
| **DO** | Durable Object (Cloudflare-Konzept) |
| **E2E** | End-to-End-Verschlüsselung |
| **GSK** | Group Sender Key — Schlüssel für Gruppen-Nachrichten |
| **Handle** | Eindeutiger User-Identifier (z.B. `bertha004`) |
| **PWA** | Progressive Web App |
| **TOFU** | Trust on First Use |
| **VAPID** | Voluntary Application Server Identification (Push-Notifications) |
| **WebAuthn** | Web Authentication (FIDO2-Standard) |

---

## Anhang B: Entscheidungs-Log

Wenn eine strategische Entscheidung geändert wird, hier dokumentieren:

| Datum | Entscheidung | Alt | Neu | Begründung |
|---|---|---|---|---|
| 2026-04-27 | Initial Vision | — | siehe oben | Strategie-Session mit Bruno |
| 2026-04-27 | Frontend-Framework | Vanilla JS | **Svelte** (ab Phase 1A.6) | Skalierbarkeit für Discord-Features, Open-Source-Contributors |
| 2026-04-27 | Signal Protocol Timing | Phase 1B | **Phase 8 (nach Beta)** | Time-to-Beta wichtiger als perfekte Crypto. CMK reicht für Beta. Lessons-Learned von Usern für Migration. |
| 2026-04-27 | Group-Multi-Device | Phase 1B | **Phase 1C (deferred)** | Risiko-Reduktion: DM-Multi-Device first stable, dann Groups |
| 2026-04-27 | Recovery-Strategie | Nur Phrase | **Phrase + iCloud-Sync (User-Wahl)** | Beste UX: Apple-User bekommen Auto-Sync, paranoid-User nur Phrase |
| 2026-04-27 | Lizenz | MIT/Apache | **AGPL Backend + MIT Spec/Frontend** | Schutz vor Big-Tech-Forks bei max. Spec-Verbreitung |
| 2026-04-27 | Bus-Faktor-Plan | — | Co-Founder ab 5k User; Recovery-Codes im Tresor | Realistisch für Solo-Dev-Phase |
| 2026-04-27 | Testing | Keine Tests | **Vitest für Crypto-Code** | Crypto ohne Tests = Selbstmord |
| 2026-04-27 | Monitoring | — | **Sentry vor Phase 1B** | Production-Errors sichtbar machen |
| 2026-04-27 | Cloudflare-Lock-in | — | Ehrlich kommunizieren: "Reference Server uses Cloudflare" | Open-Standard-Versprechen integer halten |
| 2026-04-27 | Sprachen | DE/EN/ES | DE/EN/ES (Französisch später) | Reicht für Phase 1; FR Phase Year 2 wenn CH-Markt-Push |
| 2026-04-27 | PWA-Onboarding | — | **Aggressives Install-Tutorial** mit Video/GIF | iOS-Push-Limitation umgehen |
| 2026-04-27 | AI-Kompromisse | — | **NULL Kompromisse** — keine Webhooks, keine Bot-APIs | Markenkern bewahren |
| 2026-04-27 | Marketing-Plan | "Reddit-Posts" | Realistisch: 50 Beta + 5 Streamer + 1 HN-Launch + 6-12 Mo Geduld | Echte Erwartungshaltung |
| 2026-04-27 | Pro-Features | — | **Nur Grundfunktionen gratis**, Pro-Features paywalled | Standard-Freemium für Sustainability |
| 2026-04-27 | AI-Klage-Schutz | — | **AGB-Klausel "Best Effort, keine Garantie"** | Rechtssicherheit ohne Substanz-Verlust |
| 2026-04-27 | Beta-Launch-Datum | Oktober 2026 | **Oktober/November 2026** (Option B) | Svelte-Migration verzögert leicht, Signal Protocol verschoben hält Termin |
| 2026-04-28 | Multi-Device-Limit | "5 Devices" pauschal | **5 Free / 10 Pro** | Pro-Tier braucht Verkaufsargumente; 5 reicht für 95% der User. Detail: [`MULTI_DEVICE.md`](./MULTI_DEVICE.md) §6 |
| 2026-04-28 | Revoke-Pfade | Code rotierte immer | **`revoked_by`-Feld trennt User/Self/Auto** — Rotation nur bei `user` | Cron-Storm vermeiden (1000× CMK-Rotation täglich), Forward Secrecy nur bei echtem Security-Event. Detail: [`MULTI_DEVICE.md`](./MULTI_DEVICE.md) §3.2 |
| 2026-04-28 | Recovery-Cutoff | unspezifiziert | **7 Tage Recent-CMK-Share** beim Add-Device | iMessage-Standard, Privacy-Brand-konform. Detail: [`MULTI_DEVICE.md`](./MULTI_DEVICE.md) §4.4.3 |
| 2026-04-28 | Device-State-Storage | nur KV-Index | **D1-Tabelle `devices` + KV als Hot-Cache** | Send-Path bleibt schnell (KV), Cron+Settings-UI sauber (D1). Detail: [`MULTI_DEVICE.md`](./MULTI_DEVICE.md) §2 |
| 2026-04-28 | Add-Device-Bestätigung | unspezifiziert | **Cross-Device-Passkey IST die Bestätigung**, Toast nur als Notbremse | Passkey ist Trust-Anchor; zusätzlicher Confirm wäre UX-Friktion. Detail: [`MULTI_DEVICE.md`](./MULTI_DEVICE.md) §4.1 |
| 2026-05-10 | Group-Multi-Device-Distribution | unspezifiziert | **Frontend-Re-Distribution bei device_added (self + peer)** mit Backoff-Retry-Race-Schutz | Konsistent mit DM-Pattern (CMK-Redistribute), Backend bleibt zero-knowledge. Detail: [`GROUPS_MULTIDEVICE.md`](./GROUPS_MULTIDEVICE.md) §4 |
| 2026-05-13 | Phase-3-Datenmodell für Server/Channel | (A) neue `servers`+`channels`-Tables / (B) `conversations`-Erweiterung mit `server_id`+`channel_kind` | **B** | Multi-Device-Krypto-Pipeline ist convo-agnostisch — Wiederverwendung spart 2-3 Wochen Duplikation. Standalone-Groups koexistieren (keine Auto-Migration). Detail: [`SERVERS.md`](./SERVERS.md) §2 + §10 |
| 2026-05-13 | **Beta-Launch-Termin** | Okt/Nov 2026 (16 Wo) | **Mitte/Ende Juli 2026** (~10 Wo) | Phase 1 ist stable Foundation, Phase 3 → 3A (Voice deferred), Phase 4 deferred, Phase 5-Light, Phase 2 parallel. ~3 Monate früher live = früheres User-Feedback, momentum maintained. Trade-off: „Text-First Discord-Killer" Marketing-Pitch statt Voice am Tag 1. |
| 2026-05-13 | **Voice/PTT/Screen-Sharing Phase** | Phase 3 (mit Beta) | **Phase 8 (post-Beta, gemeinsam mit Signal Protocol)** | 3-4 Wochen Solo-Arbeit für WebRTC SFU + UI. Voice + Signal Protocol als „v2.0-Update" gebündelt vermarktet. Detail: [`SERVERS.md`](./SERVERS.md) Decision Log 2026-05-13. |
| 2026-05-15 | **Voice-Infrastruktur** | „WebRTC mit Cloudflare TURN/SFU" (CF Realtime für Channels) | **Self-hosted: coturn für 1:1, LiveKit (Apache-2.0) für Voice-Channels — beide auf Hetzner CH/DE** | (1) **Privacy-Bruch CF**: CF Realtime SFU im Plaintext-Modus wäre DTLS-Endpoint, hätte technisch Zugriff auf Audio. Im Frame-Encrypted-Modus immerhin Metadata + US-Jurisdiktion (FISA 702 / NSL / CLOUD Act) — direkter Widerspruch zur „You Are The Key"-Brand-Position. Schweizer Hetzner-Hosting unterliegt nur DE-Justiz mit Transparenz-Pflicht. (2) **Open-Standard-Bruch**: CF-Lock-in im wichtigsten Layer (Voice = Discord-Killer-USP) würde verhindern dass Dritte RENEX-kompatible Server deployen können — bricht Pillar #3. LiveKit ist Apache-2.0, self-hostbar von jedem. (3) **Kosten**: bei 30k MAU Faktor 10-100× günstiger (~80€/Mo vs ~$3'000+/Mo CF). (4) **Praxis-Bestätigung 2026-05-15**: CF Realtime TURN-Allocations zeigten in Tests beidseitige Carrier-NAT-Probleme (alle relay↔relay-Pairs blieben in-progress, kein STUN-Throughput). Self-hosted coturn löst das mit eigener PERMISSIONS-Forwarding-Config. (5) **GSK-Wiederverwendung**: existierendes Group-Sender-Key-System aus Phase 1C wird via HKDF-Derivation für Frame-Encryption nachgenutzt — keine neue Krypto-Schicht. (6) **Reliability-Tradeoff**: single-Server-Setup ist Year-1-akzeptabel (99.5% Uptime), Multi-Region-Cluster ab Year 3 wenn Pro-MRR die Infra finanziert. Phase-8-Architektur-Skizze von 2026-05-15-Session (LiveKit-Token-Flow, Frame-Crypto, Hetzner-Deploy-Script) verfügbar — VOICE.md-Detail-Spec folgt zu Phase-8-Start. |
| 2026-05-20 | **Phase 2 vorziehen** (Open-Source-Launch) | (A) Original-Plan Wo 5-6 (2026-06-16+) / (B) sofort, parallel zu Phase 3A | **B** | Phase 1 ist stabil deployed, PROTOCOL.md ist Stable v1.0, Voice 1:1 (Phase 8a) ist live. Open-Source-Repo schon vor Beta-Launch zu öffnen schafft Reddit/HN-Visibility, GitHub-Stars als Social-Proof + zieht erste Contributors an. Trade-off: Phase 3A (Server/Channels-Polish) wird public sichtbar während Work-in-Progress — akzeptabel mit „Pre-Beta"-Status-Disclaimer. 8-Tage-Sprint 2026-05-20 → 2026-05-27. |
| 2026-05-28 | **Roadmap-Acceleration nach Phase 3A** | Beta Mitte/Ende Juli 2026 (Pivot 2026-05-13) | **Ende Juni 2026** (~3 Wo weiter vorgezogen) | Phase 3A 3 Wo vor Plan fertig (2026-05-27), Phase 2 (Open Standard) parallel mitgeshipped statt Wo 5-6, Phase 3A.5 in 1 Tag teil-shipped (3 von 7 Items: transfer, PATCH name/desc, account-delete pre-check). Tempo hält, Foundation ist solid (461/461 vitest grün, 0 vulnerabilities nach grouped Dependabot bump). Phase 5-Light Wo 5 → Wo 2, Phase 6 Wo 7 → Wo 4, Phase 7 Mitte/Ende Juli → Ende Juni, Phase 8 Aug-Nov → Juli-Okt, Phase 9 Q4 2026-Q1 2027 → Q3-Q4 2026. Trade-off: Phase 5-Light Captcha (Turnstile) hat Async-Dependency (CF-Dashboard-Setup Sitekey/Secret), könnte temporär blocken. Foundation-Lessons im Memory festgehalten: kein git in iCloud, push vor deploy, wrangler.toml braucht fresh-clones manuell. |
| 2026-06-01 | **Phase 3A.5 COMPLETE — 7/7** | Phase 3A.5 5/7 (nach Ban-System 2026-05-29) | **7/7 — komplettes deferred-Set aus Phase 3A geschlossen** | Sechstes Item Private Channels in 1 Session shipped (backend permission-override CRUD + getVisibleChannelIds server-side filter + ChannelEditModal frontend), siebtes Item Tier-Limits in 30min shipped (KV `user:tier:<handle>`, getUserTier helper, tier-aware createServer limit). Codebase-weiter pushToUserDO-Audit fixierte 7 weitere fire-and-forget Bugs (Multi-Device-Sync). 461/461 vitest stable, vite build clean nach jeder Deploy. ~5 Kalendertage von 3/7 (2026-05-28) bis 7/7 (2026-06-01). Roadmap-Status: Phase 3A.5 vollständig abgehakt — nächstes: Phase 5-Light Captcha (geplant Wo 2-3 = 2026-05-26 → 2026-06-01, also DEUTLICH overdue per Roadmap, sollte als nächstes geschoben werden) ODER Phase 6 Prep (Brand & Launch). Phase 3A.5 hat 4 dauerhafte CF-Workers-Memory-Lessons hinzugefügt: iCloud + git, push-vor-deploy, wrangler.toml not in repo, pushToUserDO await sub-requests. |
| 2026-06-01 | **Phase 5-Light Captcha LIVE** | Phase 5-Light geplant Wo 2-3 (overdue) | **Shipped on-time per pivot, Roadmap on-track** | Cloudflare Turnstile auf POST `/servers/create` + POST `/servers/join/<token>`. Wiederverwendung der existing verifyTurnstile-Infrastruktur aus Phase 1A (Register-Flow) — keine CF-Dashboard-Änderung nötig. Neuer ServerJoinModal ersetzt nativen `confirm()`-Dialog (UX-Win plus Captcha-Ready in einem Schritt). 9 i18n Strings DE/EN/ES. Hardware-Attestation + Behavioral-Analysis bleiben weiterhin Phase 9 per ursprünglichem Decision. |
| 2026-06-02 | **Phase 6.5 Pulse eingeschoben** | Phase 6 → Phase 7 direkt | **Phase 6 → Phase 6.5 Pulse → Phase 7** | Brand-Brainstorm mit Bruno: ambient sensorische Visualisierungs-Schicht über 1:1-DM (Pulse-Energy aus Maus/Touch/Acceleromter/Tippen → Canvas-2D-Partikel). Brand-defining für „For Humans. By Humans." Anti-AI-Story bekommt visuelles Demo-Material für TikTok/HN-Launch. KEIN Captcha-Replacement (Belief-Layer, kein Auth-Gate). MVP 1 Wo (Wo 6 = 2026-06-16 → 2026-06-22) zwischen Phase 6 Brand-Prep und Phase 7 Beta-Launch. Trade-off: falls Phase 6 nicht in 2 Wo fertig → Phase 7 um 1 Wo schieben (Ende Juni → Anfang Juli), Pulse darf nicht skippen weil ohne ihn Beta-Launch-Story ohne visuellen Differenziator. Detail-Spec: [`PULSE.md`](./PULSE.md) v0.1 mit 13 Decisions + 5 Open Questions. |
| 2026-06-02 | **Founder's Pass / Stripe aus Phase 6 entfernt** | Phase 6 enthielt "Founder's Pass-System (Stripe)" als Deliverable | **Stripe + Founder's Pass deferred zu Phase 2 Monetization-Start (~Dez 2026)** | Inkonsistenz zwischen §6 Monetization-Plan ("Phase 1 Monat 0-6 = komplett kostenlos") und §10 Phase 6 ("Founder's Pass-System (Stripe)") aufgelöst. Beta-Launch Ende Juni 2026 = Monat 0 vom Free-Tier. Founder's Pass startet erst Monat 6 (~Dez 2026). Vorteile der Defer: (1) kein Schweizer Business-Stripe-Konto-Setup als Phase-7-Blocker (Bruno hat nur Privat-Stripe), (2) Tier-Limits-KV-Foundation (Phase 3A.5) ist schon live + Pro-Webhook-Bau in 2 Tagen machbar wenn Zeit reif, (3) Phase 6 wird kürzer (1.5 Wo statt 2), schafft Puffer für Phase 6.5 Pulse. Phase 6 Scope jetzt: Landing-Redesign + Demo-Video + Install-GIF + AGB-Update + Manifesto öffentlich. |
| 2026-06-02 | **Manifesto als öffentliche Static-Site** | MANIFESTO.md nur im GitHub-Repo lesbar | **`renex.id/manifesto` (EN) + `renex.id/manifest-de` (DE) — gerenderte Static-Site** | Phase-6-Brand-Item: das Manifesto braucht eine markenbildende, indexierbare Public-URL statt nur GitHub-Blob. Architektur: Build-Script `scripts/build-manifesto.js` (token-walking marked-Renderer → HTML, in `deploy.sh` vor `vite build`), gerendert in `frontend/public/{manifesto,manifest-de}/index.html`. Design-Direction B „Statement" (full-width Hero „PASSKEY-ONLY. HUMAN-FIRST. OPEN-STANDARD.", Partikel-Background aus LandingParticles.svelte vanilla-portiert). Mini-Decisions: (1) **system-ui Font-Stack** statt Web-Font — CSP `font-src 'self'` verbietet CDN + <100kb Page-Budget; system-ui = 0 Bytes. (2) **`robots: index,follow`** (anders als Legal-Pages) — Manifesto SOLL ranken, voller OG/Twitter/hreflang/canonical + JSON-LD Article-Schema. (3) **`marked@18` als devDependency** — nur Build-Time, kein Runtime-Bundle-Impact. OG-Image-PNG (Figma) + DNS bleiben out-of-scope dieser Session. |
| 2026-06-02 | **Metadaten-Minimierung als ehrliches Roadmap-Item** | Manifesto behauptete „Kontaktlisten leben auf deinem Gerät" + „wir haben nichts, was sie wollen" — beide widersprechen Code/THREAT_MODEL.md (Kontakte server-seitig in D1, voller Metadaten-Graph sichtbar) | **Manifesto v1.6 Privacy-Honesty-Pass: Wording auf Threat-Model-Wahrheit korrigiert + neuer Admit-Punkt #4 „Metadaten sind heute server-seitig sichtbar" mit Roadmap-Framing** | Datenschutz-Audit (Bruno-Anfrage) deckte zwei echte Manifesto↔Code-Widersprüche auf: (1) Kontakte werden server-seitig gespeichert (`contacts`-Tabelle: `user_handle`/`contact_handle`/`display_handle`), nicht nur on-device; (2) D1 hält den vollen sozialen Graph plaintext (sender/recipient handles, timestamps, conversation membership, contacts, call logs). Inhalte SIND E2E (CMK/GSK, nur `ct_b64`/`iv_b64` in D1), aber Metadaten nicht — RENEX ist hier heute schwächer als Signals Sealed-Sender. Entscheidung **A (Wording jetzt)**: ehrliche Formulierung statt Marketing-Garantie, Verweis auf THREAT_MODEL.md. Entscheidung **B (Architektur später)** als Roadmap dokumentiert, damit die Privacy-Vision nicht stirbt sondern als „daran arbeiten wir" framed wird (passt zum „Wie wir uns wehren"-Stil): **Sealed-Sender** (Server erfährt nicht mehr wer-was), **Delete-after-Delivery** für Nachrichten-Envelopes, **client-seitig verschlüsselte Kontaktlisten**. Bis dahin: Annahme, dass Server Metadaten korrelieren kann. EN+DE gespiegelt. |
| 2026-06-02 | **WebAuthn RP-ID auf Apex `renex.id` migriert** | RP-ID + Origin hart auf `app.renex.id` verdrahtet → Passkeys nur auf `app.renex.id` gültig, Login auf dem neuen Brand-Apex `renex.id` unmöglich | **RP-ID = `renex.id` (registrierbarer Apex, deckt `renex.id` UND `app.renex.id` ab); Origin-Checks als Allowlist beider Hosts** | Beim Einrichten der Pages-Custom-Domain `renex.id` (Brand-Apex) aufgefallen: die Landing **ist** die Login-Seite (Hero mit inline `LoginModal`), aber Passkeys waren via RP-ID `app.renex.id` host-gebunden → Login auf `renex.id` hätte fehlgeschlagen. Entscheidung **Weg B** (statt App-Routen-Redirect): RP-ID auf den eTLD+1 `renex.id` heben, der als Suffix `app.renex.id` mit-abdeckt. **Timing-Begründung:** Pre-Beta (Launch Ende Juni) = quasi keine echten User-Passkeys → Migration jetzt billig, nach Launch brutal teuer (jeder müsste neu registrieren). 8 Code-Stellen: RP-ID (`authRoutes.js` rp.id + assertion rpId, `e2eRoutes.js` re-auth rpId, `webauthnVerify.js` RP_ID, `loginFinish.js` rpIdHash-Digest), Origin-Allowlist (`webauthnVerify.js`, `loginFinish.js`, `authRoutes.js`) + CORS-Allowlist (`utils.js` `https://renex.id`). Frontend unverändert (gibt server-gelieferte rp/rpId durch). **Breaking:** bestehende `app.renex.id`-Passkeys verifizieren nicht mehr → eingeloggt bleiben + neuen Passkey via „Add passkey" registrieren, alter wird tot. **Deferred (kosmetisch, weiter funktional):** Invite/Join-Deep-Links (`inviteRoutes.js`, `serverRoutes.js`, `chatSend.js`) zeigen noch auf `app.renex.id`. *(✅ erledigt 2026-06-03, siehe nächste Zeile)* |
| 2026-06-03 | **Brand-Apex `renex.id` Konsolidierung (Abschluss)** | Nach der RP-ID-Migration zeigten User-facing-URLs + Onboarding-Texte noch auf `app.renex.id`; `www.renex.id` unerreichbar; beide Hosts indexierbar (Duplicate-Content-Risiko) | **Alle User-facing-Pfade + SEO-Signale auf `renex.id` konsolidiert; `app.renex.id` bleibt funktionaler App-Host, aber `noindex`** | Schließt die `Deferred`-Punkte der Vortags-Migration. **(A) Deep-Links** → `renex.id`: Guest-Invite (`inviteRoutes.js`), Server-Invite (`serverRoutes.js` + Frontend-Spiegel `ServerSettingsModal.svelte`), Convert-URL (`chatSend.js`). **Onboarding** → `renex.id`: QR-Ziel + Texte in `AddDeviceModal.svelte`, `stores/lang/{de,en,es}` + Captcha-Block-Hilfe `join/lib/lang/{de,en,es}`. **(B) `www` → 301 → Apex**: proxied CNAME `www → renex.id` + Single-Redirect-Rule (`https://www.*` → `https://${1}`, Query erhalten). **(C) `app.renex.id` `noindex`**: Transform Rule setzt `X-Robots-Tag: noindex, nofollow` (Apex bleibt indexierbar → SEO auf Canonical-Ziel konsolidiert). **Cleanup:** gemeinsames OG-Bild EN+DE, CORS-Allowlist `renex-svelte` entfernt + Preview-Regex auf `renex-static`, 3 ungenutzte CF-Projekte gelöscht (`renex-svelte`, `fancy-hill-6bf2`, `renex-app`). Versionen v2026-06-02-7 bis v2026-06-03-1. **Bewusst belassen:** `app.renex.id` in Origin-/CORS-Allowlists (App läuft weiter dort) + erklärenden Code-Kommentaren. |

---

**Dieses Dokument ist die Bibel für RENEX.**
**Vor jeder strategischen Entscheidung: hier reinschauen.**
**Wenn das Dokument falsch ist: korrigiere es bewusst, nicht beiläufig.**
