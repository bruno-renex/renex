# RENEX — Vision & Strategy

> **AI-FREE FOREVER. PASSKEY-ONLY. HUMANS ONLY.**

**Status:** Living document
**Version:** 1.0
**Letzte Aktualisierung:** 2026-04-27
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

### 2️⃣ AI-Free
- Keine Bots, keine AI-Agents, keine automatisierten Accounts.
- Technisch erzwungen: kein Public-API, Captcha-Hardening, Rate-Limits, Hardware-Attestation.
- Sozial erzwungen: AGB explizit, sofortiger Bann bei Verstoß.
- "Pure Human Verified"-Badge im Profil.

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
2. **"AI-Free Forever"** — sozial-technisches Versprechen
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
| E2E-Crypto | WebCrypto (Phase 1), Signal Protocol (Phase 2) | Schritt für Schritt |
| Voice/Video | WebRTC mit Cloudflare TURN/SFU | Skaliert mit Pay-per-Use |
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
| Repository | `github.com/renex/renex` (öffentlich ab Phase 2) |
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
  - "AI-FREE FOREVER."
  - "PASSKEY-ONLY."
  - "HUMANS ONLY."
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
- "The Messenger That AI Can't Touch"
- "For Humans. By Humans. About Humans."
- "Discord Without the BS"
- "Your Voice. Your Key. Your Privacy."

---

## 10. Roadmap-Übersicht

**Ziel: Beta-Launch Oktober/November 2026** *(6-7 Monate ab 27.04.2026)*

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

### Phase 1C — Multi-Device Groups *(Woche 7: Juli)*
- GSK-Multi-Device
- Group-Member-Device-Tracking
- Tests mit 5×5 Konfiguration

### Phase 2 — Open Standard veröffentlichen *(Woche 8: Juli)*
- GitHub-Repo öffentlich
- Spec finalisiert (`PROTOCOL.md`)
- AGPL Backend / MIT Frontend
- CI eingerichtet (GitHub Actions)

### Phase 3 — Discord-Killer Architecture *(Woche 9-12: Juli-August)*
- Server/Channel-Konzept
- Voice-Channels (drop-in)
- Roles & Permissions
- Push-to-Talk
- Screen-Sharing

### Phase 4 — Gamer-Features *(Woche 13-14: September)*
- Steam Rich Presence
- Custom Emojis (Pro-Limit)
- Soundboard
- Custom Status

### Phase 5 — Anti-AI-Hardening *(Woche 15: September)*
- Captcha-Verschärfung
- Hardware-Attestation
- Behavioral-Analysis
- "Pure Human Verified"-Badge
- Manifesto öffentlich

### Phase 6 — Brand & Launch-Prep *(Woche 16: Oktober)*
- Landing-Page Redesign
- Demo-Video + GIF für PWA-Install-Onboarding
- Press-Kit
- Founder's Pass-System (Stripe)
- AGB rechtssicher (Anti-AI Best-Effort-Klausel)

### Phase 7 — Public Beta-Launch *(Oktober-November 2026)*
- Erste 50-1000 Beta-User
- Reddit/HN/Twitter-Posts (realistisch: 1-2 viral)
- 5 Streamer-Outreach mit Demo-Video
- Geduld: 6-12 Monate Network-Effects

### Post-Beta: Phase 8 — Signal Protocol Migration *(Nov 2026 - Jan 2027)*
- libsignal-rust → WASM
- Double Ratchet ablöst CMK-Epochs
- Migration-Path mit Lessons-Learned von echten Usern
- Marketing-Spin: "v2.0 Sicherheits-Update"

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

### Phase 4-6 (Juli - August)
- ✅ Steam-Integration mit eigenem Account demonstriert
- ✅ Anti-AI-Manifest-Page öffentlich
- ✅ Demo-Video produziert

### Phase 7 — Beta (September - Oktober)
- 🎯 **50 Beta-User** (Woche 1 nach Launch)
- 🎯 **500 aktive User** (Monat 1)
- 🎯 **5 Founder's Passes verkauft** (Monat 1) → $125
- 🎯 **2'000 aktive User** bis Ende Oktober

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

---

**Dieses Dokument ist die Bibel für RENEX.**
**Vor jeder strategischen Entscheidung: hier reinschauen.**
**Wenn das Dokument falsch ist: korrigiere es bewusst, nicht beiläufig.**
