# RENEX

> **Secure org → citizen messaging. Passkey-native, human-first, end-to-end encrypted.**
> No email, no phone number, no password — and citizens need no account at all.

[![License: MIT/Apache](https://img.shields.io/badge/Spec%20%26%20Frontend-MIT%20OR%20Apache--2.0-blue)](./LICENSE)
[![License: AGPL](https://img.shields.io/badge/Reference%20Server-AGPL--3.0-blue)](./LICENSE-AGPL)
[![Status](https://img.shields.io/badge/status-pre--beta-orange)]()

---

> ⚠️ **Pre-beta, not externally audited.** RENEX Protocol v1 has not undergone third-party security review. Do not use for high-risk scenarios (whistleblowing, activist coordination in hostile jurisdictions, persistent journalism sources) until the v1.0 audit is complete. See [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) for the full security assumptions and acknowledged weaknesses.

---

**🇬🇧 English** · [🇩🇪 Deutsch ↓](#renex--deutsch)

## What is RENEX?

RENEX is a messenger and an **open protocol** built around one concrete use case:

> **An organization writes to a citizen — encrypted, persistent, two-way — and the citizen needs no account.**

A practice, association, or municipality hands out (or mails) a QR code. The recipient scans it and is in a real, end-to-end encrypted conversation: no app store, no registration, no email address, no phone number. The organization pays; citizens use it for free.

Three non-negotiable promises underneath:

1. **No identifiers we don't need** — accounts are passkeys (WebAuthn/FIDO2), unlocked by biometrics or PIN. No email, no password, no phone number. Guests need no account at all, and the second factor for sensitive channels is an activation code the *organization* hands over — RENEX never sees a phone number.
2. **Human-first** — no bots, no AI agents, no auto-generated messages. Deliberately no bot APIs, no webhooks, no public integration layer.
3. **End-to-end encrypted** — messages leave the device encrypted. The server never sees plaintext.

**Tagline:** *YOU ARE THE KEY.*

## Status

Pre-beta, in production use with a small number of accounts.

**Core (live):**
- ✅ Passkey auth (WebAuthn) on all modern browsers
- ✅ E2E DMs, multi-device (up to 5 devices per user)
- ✅ **Post-quantum E2E** — ML-KEM-768 hybrid Double Ratchet ("v4"), GA since 2026-07-11
- ✅ E2E groups (sender-keys pattern)
- ✅ E2E attachments (photos, documents — guests can send them too)
- ✅ BIP39 recovery (12-word phrase, encrypted backup)
- ✅ PWA (iOS / Android / Desktop, no app-store dependency)

**Org → citizen channel (live):**
- ✅ Verified sender — organizations are verified against official registries; the landing page shows the registered name plus *"identity verified on DATE via METHOD"*
- ✅ Long-lived invitations (up to 365 days) — a letter can travel by post and still work on arrival
- ✅ Bulk issuance with per-recipient labels + CSV export for mail merge
- ✅ **Recipient authentication** — optional activation code, generated and handed over out-of-band by the organization (second letter, phone call, in person). Hashed in the browser at both ends; RENEX stores only salt and hash and never sees the code
- ✅ Re-entry via the same QR card if a device loses its session, expiry warnings, and immediate session revocation

**Honest limitations:**
- Guest sessions currently use the **v2 E2E scheme, not the post-quantum ratchet** — encrypted, but without the forward secrecy of registered accounts.
- Link possession alone authenticates nobody. Without an activation code (or handing the card over in person), anyone holding the link is the recipient. Voluntary forwarding cannot be solved technically — see [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md).
- Metadata: the server stores who exchanges messages with whom and when. Content is unreadable to it; the social graph is not yet.
- Discord-style servers/channels and 1:1 voice exist in the codebase but are **frozen** — no further development.

## Quick Start

### Read the spec

If you want to build a RENEX-compatible implementation:

1. [`docs/MANIFESTO.md`](./docs/MANIFESTO.md) — what we're building for
2. [`docs/PROTOCOL.md`](./docs/PROTOCOL.md) — what we're building (wire format v1)
3. [`docs/RECOVERY.md`](./docs/RECOVERY.md), [`docs/ATTACHMENTS.md`](./docs/ATTACHMENTS.md) — sub-specs
4. [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) — security assumptions + acknowledged weaknesses
5. [`docs/CHANGELOG.md`](./docs/CHANGELOG.md) — what actually shipped, when

### Run the reference implementation locally

```bash
# Prereqs: Node 22+, npm 10+, wrangler 4+, Cloudflare account
git clone https://github.com/bruno-renex/renex.git
cd renex
npm install
npm test                  # Vitest, ~13s, 888 tests
npm run dev               # Frontend dev server
```

Full guide: [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) §2.

## Architecture (brief)

```
Frontend (Svelte 5 + PWA)  ──WebSocket──▶  Cloudflare Workers
   │                                             │
   ├─ WebAuthn (Passkey)                         ├─ D1 (messages, users, devices)
   ├─ WebCrypto (AES-GCM, ML-KEM-768, X25519)    ├─ KV (pubkeys, prekey bundles)
   ├─ IndexedDB (encrypted local cache)          ├─ R2 (attachments, recovery bundles)
   └─ WebRTC (voice, encrypted SDP)              └─ Durable Objects (sessions, rate limits)
```

Voice 1:1 uses a self-hosted **coturn** relay in Germany — separate from Cloudflare. The relay only sees encrypted SRTP; the server never sees decrypted media.

## License

Tri-license setup:

- **Spec, docs, frontend** (`docs/`, `frontend/`): [MIT](./LICENSE-MIT) OR [Apache-2.0](./LICENSE-APACHE) — your choice
- **Reference server** (`src/`): [AGPL-3.0-only](./LICENSE-AGPL)

Why: spec and frontend should spread as widely as possible. AGPL on the server prevents hyperscalers from running proprietary forks without contributing back. Full rationale: [`LICENSE`](./LICENSE).

## Contributing

PRs welcome — please read [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) first. Spec-first rule: for wire-format changes, spec before code.

Contributions require `Signed-off-by` (Developer Certificate of Origin, kernel-style).

Bug reports: GitHub Issues. Security vulnerabilities: **NOT** as issues — see [`SECURITY.md`](./SECURITY.md).

## What RENEX is NOT

- Not a Discord competitor (server/channel code exists but is frozen)
- Not a crypto/Web3 wallet (no tokens, no NFTs)
- Not a social network (no feed, no algorithm)
- Not a VC-funded startup (bootstrapped)
- **Not an AI tool** (excluded by design)

---

**Made in Switzerland 🇨🇭** — by Bruno Hochstrasser and contributors.

---

<a id="renex--deutsch"></a>

# RENEX — Deutsch

> **Sichere Organisation-→-Bürger-Kommunikation. Passkey-nativ, human-first, Ende-zu-Ende-verschlüsselt.**
> Keine E-Mail, keine Telefonnummer, kein Passwort — und Bürger:innen brauchen gar kein Konto.

[🇬🇧 English ↑](#renex)

## Was ist RENEX?

RENEX ist ein Messenger und ein **offenes Protokoll**, gebaut um einen konkreten Anwendungsfall:

> **Eine Organisation schreibt einer Person — verschlüsselt, dauerhaft, in beide Richtungen — und die Person braucht kein Konto.**

Eine Praxis, ein Verein oder eine Gemeinde übergibt (oder verschickt) einen QR-Code. Wer ihn scannt, ist in einem echten, Ende-zu-Ende-verschlüsselten Gespräch: kein App Store, keine Registrierung, keine E-Mail-Adresse, keine Telefonnummer. Die Organisation zahlt, für Bürger:innen ist es gratis.

Drei nicht-verhandelbare Versprechen darunter:

1. **Keine Kennungen, die wir nicht brauchen** — Konten sind Passkeys (WebAuthn/FIDO2), entsperrt per Biometrie oder PIN. Keine E-Mail, kein Passwort, keine Telefonnummer. Gäste brauchen gar kein Konto, und der Zweitfaktor für sensible Kanäle ist ein Aktivierungscode, den die *Organisation* übergibt — RENEX sieht nie eine Telefonnummer.
2. **Human-first** — keine Bots, keine KI-Agenten, keine auto-generierten Nachrichten. Bewusst keine Bot-APIs, keine Webhooks, keine öffentliche Integrations-Schicht.
3. **Ende-zu-Ende-verschlüsselt** — Nachrichten verlassen das Gerät nur verschlüsselt. Der Server sieht nie Klartext.

**Tagline:** *YOU ARE THE KEY.*

## Status

Pre-Beta, im produktiven Einsatz mit wenigen Konten.

**Kern (live):**
- ✅ Passkey-Auth (WebAuthn) auf allen modernen Browsern
- ✅ E2E-DMs, Multi-Device (bis 5 Geräte pro Konto)
- ✅ **Post-Quantum-E2E** — ML-KEM-768 Hybrid Double Ratchet („v4"), GA seit 2026-07-11
- ✅ E2E-Gruppen (Sender-Keys-Muster)
- ✅ E2E-Anhänge (Fotos, Dokumente — auch von Gästen sendbar)
- ✅ BIP39-Recovery (12-Wort-Phrase, verschlüsseltes Backup)
- ✅ PWA (iOS / Android / Desktop, keine App-Store-Abhängigkeit)

**Organisation-→-Bürger-Kanal (live):**
- ✅ Verifizierter Absender — Organisationen werden gegen amtliche Register geprüft; die Landing-Page zeigt den Registernamen und *„Identität geprüft am DATUM via METHODE"*
- ✅ Langlebige Einladungen (bis 365 Tage) — ein Brief darf mit der Post reisen und funktioniert bei Ankunft noch
- ✅ Serien-Ausstellung mit Empfänger-Referenzen + CSV-Export für den Serienbrief
- ✅ **Empfänger-Authentisierung** — optionaler Aktivierungscode, von der Organisation erzeugt und out-of-band übergeben (zweiter Brief, Telefonat, persönlich). An beiden Enden im Browser gehasht; RENEX speichert nur Salt und Hash und sieht den Code nie
- ✅ Wiedereinstieg über dieselbe QR-Karte, wenn ein Gerät seine Sitzung verliert; Ablauf-Vorwarnungen; sofortiger Widerruf

**Ehrliche Grenzen:**
- Gast-Sitzungen nutzen derzeit das **v2-E2E-Verfahren, nicht den Post-Quantum-Ratchet** — verschlüsselt, aber ohne die Forward Secrecy registrierter Konten.
- Der Link-Besitz allein authentisiert niemanden. Ohne Aktivierungscode (oder persönliche Übergabe der Karte) ist, wer den Link hat, der Empfänger. Freiwillige Weitergabe ist technisch nicht lösbar — siehe [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md).
- Metadaten: Der Server speichert, wer wann mit wem schreibt. Die Inhalte sind für ihn unlesbar, der Kommunikationsgraph noch nicht.
- Discord-artige Server/Channels und 1:1-Voice existieren im Code, sind aber **eingefroren** — keine Weiterentwicklung.

## Quick Start

### Spec lesen

Wenn du eine RENEX-kompatible Implementierung bauen willst:

1. [`docs/MANIFESTO_DE.md`](./docs/MANIFESTO_DE.md) — wofür wir bauen
2. [`docs/PROTOCOL.md`](./docs/PROTOCOL.md) — was wir bauen (Wire-Format v1)
3. [`docs/RECOVERY.md`](./docs/RECOVERY.md), [`docs/ATTACHMENTS.md`](./docs/ATTACHMENTS.md) — Sub-Specs
4. [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) — Threat-Model + bekannte Schwächen
5. [`docs/CHANGELOG.md`](./docs/CHANGELOG.md) — was wann tatsächlich ausgeliefert wurde

### Reference-Implementation lokal entwickeln

```bash
# Voraussetzungen: Node 22+, npm 10+, wrangler 4+, Cloudflare-Account
git clone https://github.com/bruno-renex/renex.git
cd renex
npm install
npm test                  # Vitest, ~13s, 888 Tests
npm run dev               # Frontend-Dev-Server
```

Volle Anleitung: [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) §2.

## Architektur (kurz)

```
Frontend (Svelte 5 + PWA)  ──WebSocket──▶  Cloudflare Workers
   │                                             │
   ├─ WebAuthn (Passkey)                         ├─ D1 (Nachrichten, Konten, Geräte)
   ├─ WebCrypto (AES-GCM, ML-KEM-768, X25519)    ├─ KV (Pubkeys, Prekey-Bundles)
   ├─ IndexedDB (verschlüsselter lokaler Cache)  ├─ R2 (Anhänge, Recovery-Bundles)
   └─ WebRTC (Voice, verschlüsseltes SDP)        └─ Durable Objects (Sessions, Rate-Limits)
```

Voice 1:1 nutzt einen self-hosted **coturn**-Relay in Deutschland — getrennt von Cloudflare. Der Relay sieht nur verschlüsselte SRTP-Pakete; der Server sieht nie entschlüsseltes Medienmaterial.

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

- Kein Discord-Konkurrent (Server-/Channel-Code existiert, ist aber eingefroren)
- Kein Crypto/Web3-Wallet (keine Token, keine NFTs)
- Kein Social-Network (kein Feed, kein Algorithmus)
- Kein VC-finanziertes Startup (bootstrapped)
- **Kein KI-Tool** (by design ausgeschlossen)

---

**Made in Switzerland 🇨🇭** — von Bruno Hochstrasser und Contributors.
