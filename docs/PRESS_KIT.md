# RENEX — Press Kit

<!-- internal:start -->
> **Status: DRAFT v0.2 (2026-06-08).** Single source of truth für Presse-/Launch-Material.
> Diese Markdown-Datei ist bewusst die Quelle — die öffentliche `renex.id/press`-Seite + der
> ZIP-Download werden daraus generiert (`scripts/build-press-kit.js`, analog `build-manifesto.js`).
> Inhalt zwischen `<!-- internal:start/end -->` wird **nicht** auf die öffentliche Seite gerendert.
>
> **v0.2 — überarbeitet nach Brunos Feedback:** Gefühl vor Technik. Neuer „Why now"-Aufmacher;
> Pulse als emotionales Presence-Erlebnis statt Tech-Scalar; Integration-Layer (keine Bot-APIs)
> als eigene prominente Sektion; „Humans only" → „Built to resist automation"; „You have a pulse.
> Bots don't." aus den Presse-Key-Messages entfernt (bleibt Marketing-Slogan, im Press-Kit
> abgeschwächt + in §6 als bewusst poetisch eingeordnet).
>
> ⚠️ Offene TODOs (deine Daten): Presse-Mail-Routing bestätigen, Founder-Bio + optional Founder-Foto.
> (Logos, Brand-Hex, Typografie erledigt.) Voice ok? Gegenlesen.
<!-- internal:end -->

**Tagline:** *YOU ARE THE KEY.*
**One-liner:** Human-first communication, built to resist automation — passkey-only, end-to-end encrypted, no email · no phone · no password.

---

## 1. Why now

### 🇬🇧 English

RENEX was created in response to a simple observation: as AI-generated content, bots, and automated agents become commonplace online, **trustworthy human communication becomes more valuable, not less.**

RENEX is the messenger built for that world — not by bolting an AI filter on top, but by removing the surfaces automation needs in the first place. It reads less like a product spec and more like a position: a small group of people with a clear opinion about how the internet should *feel*, who happen to build software to prove it.

### 🇩🇪 Deutsch

RENEX entstand aus einer einfachen Beobachtung: Je alltäglicher KI-generierte Inhalte, Bots und automatisierte Agenten online werden, desto **wertvoller wird vertrauenswürdige menschliche Kommunikation — nicht unwichtiger.**

RENEX ist der Messenger für diese Welt — nicht durch einen KI-Filter obendrauf, sondern indem die Flächen entfernt werden, die Automatisierung überhaupt erst braucht. Es liest sich weniger wie ein Produkt-Datenblatt als wie eine Haltung: Menschen mit einer klaren Meinung, wie sich das Internet anfühlen sollte — und die zufällig auch Software dazu bauen.

---

## 2. Boilerplate / Über RENEX

### 🇬🇧 English

**Short (1 sentence):**
RENEX is a human-first messenger and open protocol — passkey-only, end-to-end encrypted, and deliberately built without the bot APIs, webhooks, or AI integrations that make automation easy.

**Medium (1 paragraph):**
RENEX is a messenger and open protocol for real-time communication, built on three non-negotiable promises: passkey-only identity (WebAuthn/FIDO2 — no email, phone, or password), human-first design (no bot APIs, no webhooks, no public integration layer), and end-to-end encryption (the server never sees plaintext). Where modern platforms compete to be the easiest to automate, RENEX is built to resist it — and to make trustworthy human communication feel that way again. It is open-source, bootstrap-built, and made in Switzerland.

**Long (3 paragraphs):**
RENEX is not "another messenger" — it is a deliberate response to an increasingly AI-generated internet. The premise is simple: when you talk to someone on RENEX, there should be a human on the other side. RENEX does not claim to *prove* this. Instead it removes the surfaces automation relies on, so that faking a human is expensive and unscalable rather than cheap and easy.

Three pillars hold it up. Identity is **passkey-only** (WebAuthn/FIDO2): no email to scrape, no phone number to triangulate, no password to leak. Communication is **end-to-end encrypted** across DMs, groups, and voice signaling — the server can never read plaintext. And the platform is **human-first by design**: no bot APIs, no webhooks, no public integration layer, because those are precisely the surfaces automation exploits.

RENEX is open-source under a tri-license (spec, docs, and frontend under MIT or Apache-2.0; the reference server under AGPL-3.0), runs on Cloudflare Workers with a Svelte 5 PWA front end, and is built solo and bootstrap-first by Bruno Hochstrasser in Switzerland. RENEX is currently **pre-beta and has not undergone third-party security audit**; a public beta is planned for 2026.

### 🇩🇪 Deutsch

**Kurz (1 Satz):**
RENEX ist ein Human-first-Messenger und offenes Protokoll — Passkey-only, Ende-zu-Ende-verschlüsselt, und bewusst ohne die Bot-APIs, Webhooks oder KI-Integrationen gebaut, die Automatisierung leicht machen.

**Mittel (1 Absatz):**
RENEX ist ein Messenger und offenes Protokoll für Echtzeit-Kommunikation, gebaut auf drei nicht-verhandelbaren Versprechen: Passkey-only-Identität (WebAuthn/FIDO2 — keine E-Mail, kein Telefon, kein Passwort), Human-first-Design (keine Bot-APIs, keine Webhooks, kein Public-Integration-Layer) und Ende-zu-Ende-Verschlüsselung (der Server sieht nie Klartext). Wo moderne Plattformen darum konkurrieren, möglichst leicht automatisierbar zu sein, ist RENEX gebaut, um Automatisierung zu widerstehen — und vertrauenswürdige menschliche Kommunikation wieder so anfühlen zu lassen. Open Source, bootstrap-gebaut, made in Switzerland.

**Lang (3 Absätze):**
RENEX ist nicht „noch ein Messenger" — sondern eine bewusste Antwort auf ein zunehmend KI-generiertes Internet. Die Prämisse ist einfach: Wenn du auf RENEX mit jemandem schreibst, soll auf der anderen Seite ein Mensch sein. RENEX behauptet nicht, das zu *beweisen*. Stattdessen entfernt es die Flächen, auf die Automatisierung angewiesen ist, sodass das Fälschen eines Menschen teuer und nicht skalierbar wird statt billig und einfach.

Drei Säulen tragen es. Die Identität ist **Passkey-only** (WebAuthn/FIDO2): keine E-Mail zum Abgreifen, keine Telefonnummer zum Triangulieren, kein Passwort zum Leaken. Die Kommunikation ist **Ende-zu-Ende-verschlüsselt** über DMs, Gruppen und Voice-Signaling — der Server kann nie Klartext lesen. Und die Plattform ist **human-first by design**: keine Bot-APIs, keine Webhooks, kein Public-Integration-Layer, weil genau das die Flächen sind, die Automatisierung ausnutzt.

RENEX ist Open Source unter einer Tri-Lizenz (Spec, Docs und Frontend unter MIT oder Apache-2.0; der Reference-Server unter AGPL-3.0), läuft auf Cloudflare Workers mit einem Svelte-5-PWA-Frontend und wird solo und bootstrap-first von Bruno Hochstrasser in der Schweiz gebaut. RENEX ist aktuell **Pre-Beta und ohne externes Security-Audit**; eine Public Beta ist für 2026 geplant.

---

## 3. What RENEX does differently

The most unusual thing about RENEX isn't a feature you can screenshot — it's what's **deliberately missing.**

RENEX has **no bot APIs, no webhooks, and no public integration layer.** Most platforms compete to be the *easiest* thing to automate; RENEX is built to be hard to automate. There is no sanctioned way to plug a bot, an LLM, or an autoposter into a conversation — because every such surface is one a human would otherwise have to share the room with.

This is the honest core of "human-first": RENEX doesn't claim every account is human. It removes the standard tooling that makes faking one cheap and scalable — and treats the *absence* of automation hooks as a feature, not a gap.

> 🇩🇪 Das Ungewöhnlichste an RENEX ist nicht ein Feature, sondern das bewusst **Fehlende**: keine Bot-APIs, keine Webhooks, kein Public-Integration-Layer. Die meisten Plattformen wollen möglichst leicht automatisierbar sein — RENEX ist gebaut, schwer automatisierbar zu sein.

---

## 4. Pulse — the signature feature

**Pulse is a new kind of presence indicator.** Instead of showing "online", "offline", or "typing…", RENEX visualizes human activity as a living, ambient signal. The result feels less like a status light and more like **sharing a room with someone** — you can tell a person is really there, the way you sense someone in the same space without either of you saying a word.

It's per-chat, opt-in, and off by default — and it's the thing testers remember. It's also where "for humans, by humans" stops being a slogan and becomes something you *feel*.

- **Shared moments (all client-side, end-to-end encrypted):** when two people are active at once, their pulses fall into a synchronized rhythm — a brief, shared *handshake*. A tap sends a single warm signal across, like a nod. None of it is a metric, a score, or a notification.
- **Kept deliberately quiet (under the hood):** only an abstract activity signal ever crosses the wire — never your raw movements or keystrokes. Nothing is stored; every session starts from zero. And the absence of a pulse is **never** read as "bot" — accessibility and quiet users come first.

> **Ready-to-quote:** *Pulse lets people feel each other's presence through a subtle, living visual — not a status you read, but a sign that a human is on the other end.*

Full spec: [`PULSE.md`](./PULSE.md). Live demo loop: see §9 media (`landing-pulse.mp4`).

---

## 5. Key Messages

| | 🇬🇧 English | 🇩🇪 Deutsch |
|---|---|---|
| Primary | **YOU ARE THE KEY.** | **DU BIST DER SCHLÜSSEL.** |
| Category | A messenger for humans. Built to resist automation. | Ein Messenger für Menschen. Gebaut, um Automatisierung zu widerstehen. |
| Presence | Presence you can feel, not a status you read. | Präsenz, die man spürt — kein Status, den man abliest. |
| Promise | Passkey-only. Human-first. Open-standard. | Passkey-only. Human-first. Open-Standard. |
| Privacy | No email. No phone. No password. No ads. Ever. | Keine E-Mail. Kein Telefon. Kein Passwort. Keine Werbung. Nie. |

---

## 6. The honest claim (please quote accurately)

RENEX deliberately **does not over-claim.** Accurate descriptions protect both the project and the journalist:

- ✅ **Say:** "RENEX makes automation expensive" · "built to resist automation" · "no bot APIs by design" · "human-first" · "pre-beta, not yet audited".
- ❌ **Avoid:** "guarantees every user is human" · "humans only" (as a literal claim) · "impossible to bot" · "unhackable" · "proven secure".

The project's own framing: *"We don't prove humanity — we make automation expensive."* The marketing line **"You have a pulse. Bots don't."** is a statement of intent, not a technical guarantee — please treat it as the slogan it is, not a claim of detection.

RENEX Protocol v1 has **not** undergone third-party security review (planned for the v1.0 audit, Year 2). See [`THREAT_MODEL.md`](./THREAT_MODEL.md) for the full security assumptions and acknowledged weaknesses.

---

## 7. Fact Sheet

| | |
|---|---|
| **Name** | RENEX |
| **Category** | Messenger + open protocol for human-first, E2E communication |
| **Tagline** | YOU ARE THE KEY. |
| **Status** | Pre-beta (not externally audited). Public beta planned 2026. |
| **Identity** | Passkey-only (WebAuthn / FIDO2) — no email, phone, or password |
| **Encryption** | E2E for DMs, groups (sender-keys), and voice signaling (encrypted SDP/ICE) |
| **Human-first** | No bot APIs, no webhooks, no public integration layer (by design) |
| **Platform** | PWA — iOS / Android / Desktop, no app-store dependency |
| **Frontend** | Svelte 5 (Runes) + WebCrypto (AES-GCM, ECDH P-256, ECDSA), IndexedDB |
| **Backend** | Cloudflare Workers + D1 / KV / R2 / Durable Objects |
| **Voice** | WebRTC 1:1, self-hosted coturn relay (Hetzner DE) — relay sees only encrypted SRTP |
| **Recovery** | BIP39 12-word phrase, encrypted R2 backup |
| **Signature feature** | **Pulse** — ambient, E2E human-presence layer (see §4) |
| **License** | Tri-license: Spec/Docs/Frontend = MIT OR Apache-2.0 · Reference server = AGPL-3.0 |
| **Source** | https://github.com/bruno-renex/renex |
| **Open standard** | Wire-format spec published ([`PROTOCOL.md`](./PROTOCOL.md)) |
| **Founder** | Bruno Hochstrasser (solo, bootstrap) |
| **Origin** | Made in Switzerland 🇨🇭 |
| **Press contact** | press@renex.id |

---

## 8. Feature status (current, pre-beta)

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

## 9. Media assets

> Sources live in [`/assets`](../assets); web-ready files in [`/frontend/public`](../frontend/public).
> All videos are H.264 / muted / loop, with `prefers-reduced-motion` still-image fallbacks.

| Asset | File | Notes |
|---|---|---|
| Landing showcase loop | `frontend/public/landing-pulse.mp4` (+ `app-preview-pulse.png` poster) | 1:1 chat with active Pulse — the signature visual |
| iOS install demo loop | `frontend/public/install-ios.mp4` (+ `install-ios-poster.png`) | "Add to Home Screen" flow, iPhone portrait |
| App preview still | `frontend/public/app-preview-pulse.png` | Phone-framed screenshot |
| Android install demo | TODO | Chrome + Brave clips pending (recording) |
| Desktop install demo | TODO | Chrome/Edge clip pending (recording) |
| Logo — app icon | `assets/press/renex-icon-1024.png` · `-512.png` | Rounded tile, transparent corners (dark bg baked in) |
| Logo — wordmark | `assets/press/renex-wordmark-light.{svg,png}` (dark bg) · `-dark.{svg,png}` (light bg) | RENEX, transparent; X in cyan |
| Founder photo | TODO | optional — Bruno provides |

---

## 10. Brand

**Pulse color system** (semantic palette of the signature feature):

| Role | Color | RGB | Hex |
|---|---|---|---|
| Präsenz / Presence | Cyan | `rgb(150, 225, 255)` | `#96E1FF` |
| Foam (high energy) | Gold | `rgb(255, 205, 110)` | `#FFCD6E` |
| Handshake | Rosa / Pink | `rgb(255, 120, 200)` | `#FF78C8` |
| Nicken / Nod | Gold | `rgb(255, 205, 110)` | `#FFCD6E` |

Heller Partikel-Kern (bright core accents): Cyan `#DFFAFF` · Gold `#FFE6B0` · Pink `#FFD0EC`.
Werte = aktuelle Live-Glow-Basis der Pulse-Canvas (`PulseCanvas.svelte`) auf dunklem Grund; für den Launch ggf. einfrieren.

- **Typography:** System-UI-Stack (system-ui / SF Pro / Segoe UI), Bold–Black für Wortmarke & Headlines. Keine Web-Font-Abhängigkeit (CSP-safe).
- **Logo:** App-Icon (`renex-icon-1024/512.png`, transparente Kachel) + RENEX-Wortmarke — `renex-wordmark-light.png` für dunkle, `renex-wordmark-dark.png` für helle Flächen (SVG-Quellen daneben). Regel: das **X bleibt cyan `#38BDF8`**, „RENE" in Text-/Kontrastfarbe; Clear-Space ≥ Höhe des „X".
- **Manifesto** quoting: [`MANIFESTO.md`](./MANIFESTO.md) is **CC BY 4.0** — quotable with attribution.

---

## 11. Founder

**Bruno Hochstrasser** — solo founder and developer of RENEX. Builds RENEX bootstrap-first from Switzerland, spec-first and open-source. *(TODO: 2–3 sentence bio + preferred contact for interviews.)*

---

## 12. Links

- **Website:** https://renex.id · App: https://app.renex.id
- **Source:** https://github.com/bruno-renex/renex
- **Manifesto:** https://renex.id/manifesto (EN) · https://renex.id/manifest-de (DE)
- **Specs:** [`PROTOCOL.md`](./PROTOCOL.md) · [`VISION.md`](./VISION.md) · [`THREAT_MODEL.md`](./THREAT_MODEL.md)
- **Security policy:** [`SECURITY.md`](../SECURITY.md) (vulnerabilities **not** via public issues)

<!-- internal:start -->
### Maintainer note (not for publication)

This document is the **source of truth**. Next steps toward a public press kit:
1. Fill the **TODO** fields (press email, logo exports, founder bio).
2. Add the pending **Android (Chrome + Brave)** and **Desktop** install clips + final screenshots.
3. Build the generator (`scripts/build-press-kit.js`) → `renex.id/press` static page + downloadable ZIP, mirroring the manifesto pipeline. *(generator done; wiring into deploy.sh + footer link gated on copy review.)*
<!-- internal:end -->
