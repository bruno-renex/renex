# RENEX

> **The first passkey-only messenger without AI.**
> End-to-end encrypted. Zero bots. Open standard.

[![License: MIT/Apache](https://img.shields.io/badge/Spec%20%26%20Frontend-MIT%20OR%20Apache--2.0-blue)](./LICENSE)
[![License: AGPL](https://img.shields.io/badge/Reference%20Server-AGPL--3.0-blue)](./LICENSE-AGPL)
[![Status](https://img.shields.io/badge/status-pre--beta-orange)]()

---

## Was ist RENEX?

RENEX ist ein Messenger und ein **offenes Protokoll** für Echtzeit-Kommunikation,
gebaut auf drei nicht-verhandelbaren Versprechen:

1. **Passkey-only** — keine E-Mail, kein Passwort, keine Telefonnummer. Deine
   Identität ist dein biometrischer Schlüssel (WebAuthn / FIDO2).
2. **AI-free** — keine Bots, keine Webhook-APIs, keine Auto-Responder.
   Technisch und sozial erzwungen.
3. **End-to-end encrypted** — DMs und Gruppen-Messages verlassen dein Gerät
   nur verschlüsselt. Server kann zu keinem Zeitpunkt Klartext lesen.

**Tagline:** *YOU ARE THE KEY.*

## Status

Pre-Beta. Aktuell stable:

- ✅ Passkey-Auth (WebAuthn) auf allen modernen Browsern
- ✅ E2E-DMs (Multi-Device, bis zu 5 Geräte)
- ✅ E2E-Gruppen (Sender-Keys-Pattern, Multi-Device seit 2026-05-10)
- ✅ E2E-Voice-Signaling (1:1-Calls, WebRTC mit verschlüsseltem SDP/ICE)
- ✅ BIP39-Recovery (12-Wort-Phrase, R2-Backup)
- ✅ PWA (iOS/Android/Desktop)

In Arbeit: Discord-Style Server/Channels (Phase 3), Steam Rich Presence (Phase 4),
Hardware-Attestation (Phase 5). Vollständige Roadmap: [`docs/VISION.md`](./docs/VISION.md) §10.

## Quick Start

### Spec lesen

Wenn du eine RENEX-kompatible Implementierung bauen willst:

1. [`docs/MANIFESTO.md`](./docs/MANIFESTO.md) — wofür wir bauen
2. [`docs/VISION.md`](./docs/VISION.md) — wie wir bauen
3. [`docs/PROTOCOL.md`](./docs/PROTOCOL.md) — was wir bauen (Wire-Format v1)
4. [`docs/MULTI_DEVICE.md`](./docs/MULTI_DEVICE.md), [`docs/RECOVERY.md`](./docs/RECOVERY.md), [`docs/GROUPS_MULTIDEVICE.md`](./docs/GROUPS_MULTIDEVICE.md) — Sub-Specs

### Reference-Implementation lokal entwickeln

```bash
# Voraussetzungen: Node 20+, npm 10+, wrangler 3+, Cloudflare Account
git clone https://github.com/bruno-renex/renex.git
cd renex
npm install
npm test                  # Vitest, ~12s, 460 Tests
npm run dev               # Frontend dev server
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

## Lizenz

Dual-License-Setup:

- **Spec, Docs, Frontend** (`docs/`, `frontend/`): [MIT](./LICENSE-MIT) ODER [Apache-2.0](./LICENSE-APACHE) — deine Wahl
- **Reference Server** (`src/`): [AGPL-3.0-only](./LICENSE-AGPL)

Warum: Spec und Frontend sollen sich maximal verbreiten. AGPL beim Server
verhindert, dass Big-Tech eigene SaaS-Forks ohne Code-Beitrag betreibt.
Vollständige Erklärung: [`LICENSE`](./LICENSE).

## Beitragen

PRs willkommen — aber lies zuerst [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md).
Spec-First-Regel: bei Wire-Format-Änderungen erst die Spec, dann der Code.

Bug-Reports: GitHub Issues. Security-Vulnerabilities: NICHT als Issue —
siehe [`SECURITY.md`](./SECURITY.md).

## Was RENEX nicht ist

- Kein Discord-Klon (wir kuratieren, statt 1:1 zu kopieren)
- Kein Crypto/Web3-Wallet (kein Token, keine NFTs)
- Kein Social-Network (kein Feed, kein Algorithmus)
- Kein VC-funded Startup (bootstrap-fähig)
- **Kein AI-Tool** (explizit ausgeschlossen, für immer)

Vollständige Liste: [`docs/VISION.md`](./docs/VISION.md) §12.

---

**Made in Switzerland 🇨🇭** — by Bruno Hochstrasser and contributors.
