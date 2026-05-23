# RENEX

> **Passkey-native, bot-resistant, human-first communication.**
> End-to-end encrypted. Open standard. No email, no phone, no password.

[![License: MIT/Apache](https://img.shields.io/badge/Spec%20%26%20Frontend-MIT%20OR%20Apache--2.0-blue)](./LICENSE)
[![License: AGPL](https://img.shields.io/badge/Reference%20Server-AGPL--3.0-blue)](./LICENSE-AGPL)
[![Status](https://img.shields.io/badge/status-pre--beta-orange)]()

---

> ⚠️ **Pre-beta, not externally audited.** RENEX Protocol v1 has not undergone third-party security review. Do not use for high-risk scenarios (whistleblowing, activist coordination in hostile jurisdictions, persistent journalism sources) until v1.0 audit is complete (planned Year 2). See [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) for the full security assumptions and acknowledged weaknesses.

---

**🇬🇧 English** · [🇩🇪 Deutsch ↓](#renex--deutsch)

## What is RENEX?

RENEX is a messenger and an **open protocol** for real-time communication, built on three non-negotiable promises:

1. **Passkey-only** — no email, no password, no phone number. Your identity is a passkey on your devices (WebAuthn / FIDO2), unlocked via biometrics or PIN.
2. **Human-first** — no bots, no AI agents, no auto-generated messages. RENEX deliberately has no bot APIs, no webhooks, no public integration layer.
3. **End-to-end encrypted** — DMs and group messages leave your device only encrypted. The server can never read plaintext.

Modern communication platforms optimize for growth, engagement, and automation. RENEX optimizes for **trustworthy human communication**.

**Tagline:** *YOU ARE THE KEY.*

## Status

Pre-beta. Currently stable:

- ✅ Passkey auth (WebAuthn) on all modern browsers
- ✅ E2E DMs (multi-device, up to 5 devices per user)
- ✅ E2E groups (sender-keys pattern, multi-device since 2026-05-10)
- ✅ E2E voice signaling (1:1 calls, WebRTC with encrypted SDP/ICE, self-hosted coturn on Hetzner DE)
- ✅ BIP39 recovery (12-word phrase, R2 backup)
- ✅ PWA (iOS / Android / Desktop, no app-store dependency)

In progress: Discord-style servers/channels (**Phase 3A**), voice channels + Signal Protocol migration (**Phase 8**, Q4 2026), Steam Rich Presence + Hardware-Attestation (**Phase 9**). Full roadmap: [`docs/VISION.md`](./docs/VISION.md) §10.

## Quick Start

### Read the spec

If you want to build a RENEX-compatible implementation:

1. [`docs/MANIFESTO.md`](./docs/MANIFESTO.md) — what we're building for
2. [`docs/VISION.md`](./docs/VISION.md) — how we're building
3. [`docs/PROTOCOL.md`](./docs/PROTOCOL.md) — what we're building (Wire-Format v1)
4. [`docs/MULTI_DEVICE.md`](./docs/MULTI_DEVICE.md), [`docs/RECOVERY.md`](./docs/RECOVERY.md), [`docs/GROUPS_MULTIDEVICE.md`](./docs/GROUPS_MULTIDEVICE.md) — sub-specs
5. [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) — security assumptions + acknowledged weaknesses

### Run the reference implementation locally

```bash
# Prereqs: Node 20+, npm 10+, wrangler 3+, Cloudflare account
git clone https://github.com/bruno-renex/renex.git
cd renex
npm install
npm test                  # Vitest, ~17s, 460 tests
npm run dev               # Frontend dev server
```

Full guide: [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) §2.

## Architecture (brief)

```
Frontend (Svelte 5 + PWA)  ──WebSocket──▶  Cloudflare Workers
   │                                             │
   ├─ WebAuthn (Passkey)                         ├─ D1 (Messages, Users, Devices)
   ├─ WebCrypto (AES-GCM, ECDH P-256, ECDSA)     ├─ KV (Pubkeys, CMKs hot-cache)
   ├─ IndexedDB (encrypted local cache)          ├─ R2 (Recovery bundles)
   └─ WebRTC (Voice, encrypted SDP)              └─ Durable Objects (User sessions)
```

Voice 1:1 uses a self-hosted **coturn** relay on Hetzner DE — separate from Cloudflare. The TURN relay only sees encrypted SRTP packets; server never sees decrypted media.

## License

Tri-license setup:

- **Spec, Docs, Frontend** (`docs/`, `frontend/`): [MIT](./LICENSE-MIT) OR [Apache-2.0](./LICENSE-APACHE) — your choice
- **Reference Server** (`src/`): [AGPL-3.0-only](./LICENSE-AGPL)

Why: spec and frontend should spread as widely as possible. AGPL on the server prevents hyperscalers from running proprietary forks without contributing back. Full rationale: [`LICENSE`](./LICENSE).

## Contributing

PRs welcome — please read [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) first. Spec-first rule: for wire-format changes, spec before code.

Contributions require `Signed-off-by` (Developer Certificate of Origin, kernel-style).

Bug reports: GitHub Issues. Security vulnerabilities: **NOT** as issues — see [`SECURITY.md`](./SECURITY.md).

## What RENEX is NOT

- Not a Discord clone (we curate, not 1:1 copy)
- Not a Crypto/Web3 wallet (no tokens, no NFTs)
- Not a social network (no feed, no algorithm)
- Not a VC-funded startup (bootstrap-capable)
- **Not an AI tool** (explicitly excluded by design)

Full list: [`docs/VISION.md`](./docs/VISION.md) §12.

---

**Made in Switzerland 🇨🇭** — by Bruno Hochstrasser and contributors.

---

<a id="renex--deutsch"></a>

# RENEX — Deutsch

> **Passkey-native, bot-resistant, human-first.**
> Ende-zu-Ende-verschlüsselt. Offener Standard. Keine E-Mail, kein Telefon, kein Passwort.

[🇬🇧 English ↑](#renex)

## Was ist RENEX?

RENEX ist ein Messenger und ein **offenes Protokoll** für Echtzeit-Kommunikation, gebaut auf drei nicht-verhandelbaren Versprechen:

1. **Passkey-only** — keine E-Mail, kein Passwort, keine Telefonnummer. Deine Identität ist ein Passkey auf deinen Geräten (WebAuthn / FIDO2), entsperrt per Biometrie oder PIN.
2. **Human-first** — keine Bots, keine AI-Agents, keine auto-generierten Messages. RENEX hat bewusst keine Bot-APIs, keine Webhooks, keine Public-Integration-Layer.
3. **End-to-end encrypted** — DMs und Gruppen-Messages verlassen dein Gerät nur verschlüsselt. Server kann zu keinem Zeitpunkt Klartext lesen.

Moderne Kommunikations-Plattformen optimieren auf Wachstum, Engagement und Automatisierung. RENEX optimiert auf **vertrauenswürdige menschliche Kommunikation**.

**Tagline:** *YOU ARE THE KEY.*

## Status

Pre-Beta. Aktuell stable:

- ✅ Passkey-Auth (WebAuthn) auf allen modernen Browsern
- ✅ E2E-DMs (Multi-Device, bis zu 5 Geräte pro User)
- ✅ E2E-Gruppen (Sender-Keys-Pattern, Multi-Device seit 2026-05-10)
- ✅ E2E-Voice-Signaling (1:1-Calls, WebRTC mit verschlüsseltem SDP/ICE, self-hosted coturn auf Hetzner DE)
- ✅ BIP39-Recovery (12-Wort-Phrase, R2-Backup)
- ✅ PWA (iOS / Android / Desktop, keine App-Store-Abhängigkeit)

In Arbeit: Discord-Style Server/Channels (**Phase 3A**), Voice-Channels + Signal-Protocol-Migration (**Phase 8**, Q4 2026), Steam Rich Presence + Hardware-Attestation (**Phase 9**). Vollständige Roadmap: [`docs/VISION.md`](./docs/VISION.md) §10.

## Quick Start

### Spec lesen

Wenn du eine RENEX-kompatible Implementierung bauen willst:

1. [`docs/MANIFESTO.md`](./docs/MANIFESTO.md) — wofür wir bauen
2. [`docs/VISION.md`](./docs/VISION.md) — wie wir bauen
3. [`docs/PROTOCOL.md`](./docs/PROTOCOL.md) — was wir bauen (Wire-Format v1)
4. [`docs/MULTI_DEVICE.md`](./docs/MULTI_DEVICE.md), [`docs/RECOVERY.md`](./docs/RECOVERY.md), [`docs/GROUPS_MULTIDEVICE.md`](./docs/GROUPS_MULTIDEVICE.md) — Sub-Specs
5. [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) — Threat-Model + acknowledged weaknesses

### Reference-Implementation lokal entwickeln

```bash
# Voraussetzungen: Node 20+, npm 10+, wrangler 3+, Cloudflare Account
git clone https://github.com/bruno-renex/renex.git
cd renex
npm install
npm test                  # Vitest, ~17s, 460 Tests
npm run dev               # Frontend Dev-Server
```

Volle Anleitung: [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) §2.

## Architektur (kurz)

```
Frontend (Svelte 5 + PWA)  ──WebSocket──▶  Cloudflare Workers
   │                                             │
   ├─ WebAuthn (Passkey)                         ├─ D1 (Messages, Users, Devices)
   ├─ WebCrypto (AES-GCM, ECDH P-256, ECDSA)     ├─ KV (Pubkeys, CMKs hot-cache)
   ├─ IndexedDB (encrypted local cache)          ├─ R2 (Recovery-Bundles)
   └─ WebRTC (Voice, encrypted SDP)              └─ Durable Objects (User-Sessions)
```

Voice 1:1 nutzt einen self-hosted **coturn**-Relay auf Hetzner DE — getrennt von Cloudflare. Der TURN-Relay sieht nur verschlüsselte SRTP-Pakete; Server sieht zu keinem Zeitpunkt entschlüsseltes Medien-Material.

## Lizenz

Tri-License-Setup:

- **Spec, Docs, Frontend** (`docs/`, `frontend/`): [MIT](./LICENSE-MIT) ODER [Apache-2.0](./LICENSE-APACHE) — deine Wahl
- **Reference Server** (`src/`): [AGPL-3.0-only](./LICENSE-AGPL)

Warum: Spec und Frontend sollen sich maximal verbreiten. AGPL beim Server verhindert, dass Hyperscaler eigene SaaS-Forks ohne Code-Beitrag betreiben. Vollständige Erklärung: [`LICENSE`](./LICENSE).

## Beitragen

PRs willkommen — bitte zuerst [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) lesen. Spec-First-Regel: bei Wire-Format-Änderungen erst die Spec, dann der Code.

Contributions benötigen `Signed-off-by` (Developer Certificate of Origin, Linux-Kernel-Style).

Bug-Reports: GitHub Issues. Security-Vulnerabilities: **NICHT** als Issue — siehe [`SECURITY.md`](./SECURITY.md).

## Was RENEX nicht ist

- Kein Discord-Klon (wir kuratieren, statt 1:1 zu kopieren)
- Kein Crypto/Web3-Wallet (kein Token, keine NFTs)
- Kein Social-Network (kein Feed, kein Algorithmus)
- Kein VC-funded Startup (bootstrap-fähig)
- **Kein AI-Tool** (explizit ausgeschlossen by design)

Vollständige Liste: [`docs/VISION.md`](./docs/VISION.md) §12.

---

**Made in Switzerland 🇨🇭** — von Bruno Hochstrasser und Contributors.
