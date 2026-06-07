# RENEX — Press Kit

> **Status: DRAFT v0.1 (2026-06-07).** Single source of truth für Presse-/Launch-Material.
> Diese Markdown-Datei ist bewusst die Quelle — die öffentliche `renex.id/press`-Seite + der
> ZIP-Download werden später daraus generiert (analog `MANIFESTO.md → build-manifesto.js`).
> ⚠️ Felder mit **TODO** brauchen noch deine Freigabe/Daten (Presse-Mail, Logo-Dateien,
> exakte Brand-Hex-Werte, Founder-Bio/-Foto). Voice/Positionierung bitte gegenlesen.

**Tagline:** *YOU ARE THE KEY.*
**One-liner:** Passkey-native, bot-resistant, human-first communication — end-to-end encrypted, open standard, no email · no phone · no password.

---

## 1. Boilerplate / Über RENEX

### 🇬🇧 English

**Short (1 sentence):**
RENEX is a passkey-only, human-first messenger and open protocol — end-to-end encrypted, with no email, phone number, or password, deliberately built without bot or AI integration layers.

**Medium (1 paragraph):**
RENEX is a messenger and open protocol for real-time communication, built on three non-negotiable promises: passkey-only identity (WebAuthn/FIDO2 — no email, phone, or password), human-first design (no bots, no AI agents, no integration APIs), and end-to-end encryption (the server never sees plaintext). Where modern platforms optimize for growth, engagement, and automation, RENEX optimizes for trustworthy human communication. It is open-source, bootstrap-built, and made in Switzerland.

**Long (3 paragraphs):**
RENEX is not "another messenger" — it is a deliberate response to an increasingly AI-generated internet. The premise is simple: when you talk to someone on RENEX, there should be a human on the other side. RENEX does not claim to *prove* humanity; instead it is engineered to make automation technically and economically expensive enough that faking a human rarely pays off.

Technically, RENEX rests on three pillars. Identity is **passkey-only** (WebAuthn/FIDO2): no email to scrape, no phone number to triangulate, no password to leak. Communication is **end-to-end encrypted** for DMs, groups, and voice signaling — the server can never read plaintext. And the platform is **human-first by design**: there are no bot APIs, no webhooks, and no public integration layer, because those are exactly the surfaces automation exploits.

RENEX is open-source under a tri-license (spec, docs, and frontend under MIT or Apache-2.0; the reference server under AGPL-3.0), runs on Cloudflare Workers with a Svelte 5 PWA front end, and is built solo and bootstrap-first by Bruno Hochstrasser in Switzerland. RENEX is currently **pre-beta and has not undergone third-party security audit**; a public beta is planned for 2026.

### 🇩🇪 Deutsch

**Kurz (1 Satz):**
RENEX ist ein Passkey-only, human-first Messenger und offenes Protokoll — Ende-zu-Ende-verschlüsselt, ohne E-Mail, Telefonnummer oder Passwort, bewusst ohne Bot- oder AI-Integrations-Layer gebaut.

**Mittel (1 Absatz):**
RENEX ist ein Messenger und offenes Protokoll für Echtzeit-Kommunikation, gebaut auf drei nicht-verhandelbaren Versprechen: Passkey-only-Identität (WebAuthn/FIDO2 — keine E-Mail, kein Telefon, kein Passwort), Human-first-Design (keine Bots, keine AI-Agents, keine Integrations-APIs) und Ende-zu-Ende-Verschlüsselung (der Server sieht nie Klartext). Wo moderne Plattformen auf Wachstum, Engagement und Automatisierung optimieren, optimiert RENEX auf vertrauenswürdige menschliche Kommunikation. Open Source, bootstrap-gebaut, made in Switzerland.

**Lang (3 Absätze):**
RENEX ist nicht „noch ein Messenger" — sondern eine bewusste Antwort auf ein zunehmend AI-generiertes Internet. Die Prämisse ist einfach: Wenn du auf RENEX mit jemandem schreibst, soll auf der anderen Seite ein Mensch sein. RENEX behauptet nicht, Menschlichkeit zu *beweisen*; stattdessen ist es so gebaut, dass Automatisierung technisch und ökonomisch teuer genug wird, dass sich das Fälschen eines Menschen selten lohnt.

Technisch ruht RENEX auf drei Säulen. Die Identität ist **Passkey-only** (WebAuthn/FIDO2): keine E-Mail zum Abgreifen, keine Telefonnummer zum Triangulieren, kein Passwort zum Leaken. Die Kommunikation ist **Ende-zu-Ende-verschlüsselt** für DMs, Gruppen und Voice-Signaling — der Server kann nie Klartext lesen. Und die Plattform ist **human-first by design**: keine Bot-APIs, keine Webhooks, kein Public-Integration-Layer, weil genau das die Flächen sind, die Automatisierung ausnutzt.

RENEX ist Open Source unter einer Tri-Lizenz (Spec, Docs und Frontend unter MIT oder Apache-2.0; der Reference-Server unter AGPL-3.0), läuft auf Cloudflare Workers mit einem Svelte-5-PWA-Frontend und wird solo und bootstrap-first von Bruno Hochstrasser in der Schweiz gebaut. RENEX ist aktuell **Pre-Beta und ohne externes Security-Audit**; eine Public Beta ist für 2026 geplant.

---

## 2. Key Messages / Taglines

| | 🇬🇧 English | 🇩🇪 Deutsch |
|---|---|---|
| Primary | **YOU ARE THE KEY.** | **DU BIST DER SCHLÜSSEL.** |
| Anti-AI | You have a pulse. Bots don't. | Du hast einen Puls. Bots nicht. |
| Promise | Passkey-only. Human-first. Open-standard. | Passkey-only. Human-first. Open-Standard. |
| Category | A messenger for humans. Humans only. | Ein Messenger für Menschen. Nur Menschen. |
| Privacy | No email. No phone. No password. No ads. Ever. | Keine E-Mail. Kein Telefon. Kein Passwort. Keine Werbung. Nie. |

---

## 3. The honest claim (please quote accurately)

RENEX deliberately **does not over-claim**. Accurate descriptions protect both the project and the journalist:

- ✅ **Say:** "RENEX makes automation expensive" · "engineered so faking a human rarely pays off" · "no bot APIs by design" · "pre-beta, not yet audited".
- ❌ **Avoid:** "guarantees every user is human" · "impossible to bot" · "unhackable" · "proven secure".

The project's own framing: *"We don't prove humanity — we make automation expensive."* RENEX Protocol v1 has **not** undergone third-party security review (planned for the v1.0 audit, Year 2). See [`THREAT_MODEL.md`](./THREAT_MODEL.md) for the full security assumptions and acknowledged weaknesses.

---

## 4. Fact Sheet

| | |
|---|---|
| **Name** | RENEX |
| **Category** | Messenger + open protocol for human-first, E2E communication |
| **Tagline** | YOU ARE THE KEY. |
| **Status** | Pre-beta (not externally audited). Public beta planned 2026. |
| **Identity** | Passkey-only (WebAuthn / FIDO2) — no email, phone, or password |
| **Encryption** | E2E for DMs, groups (sender-keys), and voice signaling (encrypted SDP/ICE) |
| **Platform** | PWA — iOS / Android / Desktop, no app-store dependency |
| **Frontend** | Svelte 5 (Runes) + WebCrypto (AES-GCM, ECDH P-256, ECDSA), IndexedDB |
| **Backend** | Cloudflare Workers + D1 / KV / R2 / Durable Objects |
| **Voice** | WebRTC 1:1, self-hosted coturn relay (Hetzner DE) — relay sees only encrypted SRTP |
| **Recovery** | BIP39 12-word phrase, encrypted R2 backup |
| **Signature feature** | **Pulse** — ambient, E2E human-presence layer (see §5) |
| **License** | Tri-license: Spec/Docs/Frontend = MIT OR Apache-2.0 · Reference server = AGPL-3.0 |
| **Source** | https://github.com/bruno-renex/renex |
| **Open standard** | Wire-format spec published ([`PROTOCOL.md`](./PROTOCOL.md)) |
| **Founder** | Bruno Hochstrasser (solo, bootstrap) |
| **Origin** | Made in Switzerland 🇨🇭 |
| **Press contact** | TODO — press@renex.id (bestätigen) |

---

## 5. Pulse — the signature feature (press hook)

**Pulse is RENEX's brand-defining, demo-ready feature** — the thing testers remember. It turns micro-movement (mouse, touch, typing, motion sensor) into an abstract, end-to-end-encrypted "energy" scalar that the other person sees as an ambient layer of living **fireflies** ("Leuchtkäfer"). Per-chat, opt-in, off by default.

- **The pitch:** *"When you chat with someone, you see that they're breathing. Bots don't have a pulse."*
- **Social moments (all client-side, E2E):** a synchronized pink **Handshake** when two people are active at once; **Tap = Nod** ("digital eye contact") sending a single golden mote; **Silent Together** presence; a **Thinking Pulse** while someone is composing.
- **Privacy:** only an abstract scalar crosses the wire — never raw inputs. No history, ever; every session starts from zero. Absence of a pulse is **never** a bot indicator (accessibility).
- **Why it matters for press:** it makes "for humans, by humans" a *felt* experience, not a slogan — and it is the visual differentiator for demo clips.

Full spec: [`PULSE.md`](./PULSE.md). Live demo loop: see §7 media (`landing-pulse.mp4`).

---

## 6. Feature status (current, pre-beta)

- ✅ Passkey auth (WebAuthn) on all modern browsers
- ✅ E2E DMs (multi-device, up to 5 devices per user)
- ✅ E2E groups (sender-keys pattern, multi-device)
- ✅ E2E voice signaling (1:1 calls, WebRTC, self-hosted coturn)
- ✅ BIP39 recovery (12-word phrase, R2 backup)
- ✅ PWA (iOS / Android / Desktop)
- ✅ **Pulse** ambient presence layer (1:1 DMs)
- 🚧 Discord-style servers/channels (Phase 3A) · voice channels + Signal-Protocol migration (Phase 8) · hardware-attestation (Phase 9)

**What RENEX is NOT:** not a Discord clone · not a Crypto/Web3 wallet · not a social network (no feed, no algorithm) · not VC-funded · **not an AI tool** (excluded by design).

---

## 7. Media assets

> Sources live in [`/assets`](../assets); web-ready files in [`/frontend/public`](../frontend/public).
> All videos are H.264 / muted / loop, with `prefers-reduced-motion` still-image fallbacks.

| Asset | File | Notes |
|---|---|---|
| Landing showcase loop | `frontend/public/landing-pulse.mp4` (+ `app-preview-pulse.png` poster) | 1:1 chat with active Pulse — the signature visual |
| iOS install demo loop | `frontend/public/install-ios.mp4` (+ `install-ios-poster.png`) | "Add to Home Screen" flow, iPhone portrait |
| App preview still | `frontend/public/app-preview-pulse.png` | Phone-framed screenshot |
| Android install demo | TODO | Chrome + Brave clips pending (recording) |
| Desktop install demo | TODO | Chrome/Edge clip pending (recording) |
| Logo (SVG/PNG, light/dark) | TODO | `renex-logo.svg` referenced in VISION; export press variants |
| Founder photo | TODO | optional |

---

## 8. Brand

**Pulse color system** (semantic palette of the signature feature):

| Role | Color | Hex |
|---|---|---|
| Präsenz / Presence | Cyan | TODO |
| Foam (high energy) | Gold | TODO |
| Handshake | Rosa / Pink | TODO |
| Nicken / Nod | Gold | TODO |

> TODO: exakte Hex-Werte aus dem Frontend-Theme (`--accent-*` Tokens) ziehen, sobald die
> Palette für den Launch eingefroren ist.

- **Typography:** TODO (system stack / specific face).
- **Logo usage:** TODO — clear-space + min-size rules once press logo variants exist.
- **Manifesto** quoting: [`MANIFESTO.md`](./MANIFESTO.md) is **CC BY 4.0** — quotable with attribution.

---

## 9. Founder

**Bruno Hochstrasser** — solo founder and developer of RENEX. Builds RENEX bootstrap-first from Switzerland, spec-first and open-source. *(TODO: 2–3 sentence bio + preferred contact for interviews.)*

---

## 10. Links

- **Website:** https://renex.id · App: https://app.renex.id
- **Source:** https://github.com/bruno-renex/renex
- **Manifesto:** https://renex.id/manifesto (EN) · https://renex.id/manifest-de (DE)
- **Specs:** [`PROTOCOL.md`](./PROTOCOL.md) · [`VISION.md`](./VISION.md) · [`THREAT_MODEL.md`](./THREAT_MODEL.md)
- **Security policy:** [`SECURITY.md`](../SECURITY.md) (vulnerabilities **not** via public issues)

---

### Maintainer note (not for publication)

This document is the **source of truth**. Next steps toward a public press kit:
1. Fill the **TODO** fields (press email, logo exports, exact brand hex, founder bio).
2. Add the pending **Android (Chrome + Brave)** and **Desktop** install clips + final screenshots.
3. Build the generator (`scripts/build-press-kit.js`) → `renex.id/press` static page + downloadable ZIP, mirroring the manifesto pipeline. *(needs deploy — gated on Bruno's review of this copy.)*
