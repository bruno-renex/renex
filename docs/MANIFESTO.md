# The RENEX Manifesto

> **PASSKEY-ONLY. HUMAN-FIRST. OPEN-STANDARD.**

**Version:** 1.6
**Last updated:** 2026-06-02
**License:** CC BY 4.0 — you may quote this manifesto with attribution.
**Translations:** [Deutsch](./MANIFESTO_DE.md)

---

## Why now

RENEX is not "another messenger". RENEX is a philosophical response to an increasingly AI-generated internet.

We don't build *against* AI. We build *for* humans, in a time where the distinction between the two is blurring. When you talk to someone on RENEX five years from now, you should know: there's a human on the other side.

**We don't prove humanity — we make automation expensive.** That is the honest core of everything below. Not a guarantee that every account is human, but a platform engineered so that faking one rarely pays off. Read the rest with that frame: every claim here is a fight we wage, not a promise we pretend to have already won.

---

## What we're building

A messenger for humans. Humans only.

No bots. No AI companions. No foundation models reading along. No email as identity. No phone number. No password. No ads. Ever.

You are the key. **YOU ARE THE KEY.**

---

## Why

Because the internet we have in 2026 is broken.

- **Discord** is optimized for scale, integrations, and automation — legitimate, but not what we want.
- **WhatsApp** belongs to Meta. Enough said.
- **Signal** is solid. Signal requires a phone number.
- **Telegram** is not E2E by default and hosts half-public channels.
- **Threema** is honest, but nobody uses it.

And all of them together: they've accepted that AI-generated content, bot armies, and LLM spam are part of the product.

We haven't. Not today. Not in five years.

When you write on RENEX, you write to a human. We can't guarantee this — but we make automation technically and economically expensive enough that it rarely pays off.

---

## The 5 principles

### 1. Passkey-only

Authentication exclusively via WebAuthn / FIDO2. Your identity is your biometric key. Not an email address that a marketing system can scrape. Not a phone number that a state can triangulate.

Recovery? A 12-word phrase. On paper. In your hand. If you lose the phrase, your account is gone. That's by design — not a bug.

### 2. Human-first

**We don't prove humanity — we make automation uneconomical.**

No bot APIs. No webhooks. No "AI assistants" politely making suggestions. Instead: captcha, rate limits, hardware attestation as a roadmap item, explicit Terms of Service, immediate ban on violation.

If you run bots, you're out. If you use a tool like Grammarly to polish your own text, that's your business — we don't control user-side tools.

If your use case requires a bot, RENEX isn't the right tool — and that's a deliberate design choice, not a gap we'll fill later. We'd rather be the wrong fit for some use cases than the right fit for automation.

### 3. Open standard

The **RENEX Protocol v1** is public, fully documented ([`PROTOCOL.md`](./PROTOCOL.md), [`MULTI_DEVICE.md`](./MULTI_DEVICE.md), [`RECOVERY.md`](./RECOVERY.md), [`THREAT_MODEL.md`](./THREAT_MODEL.md)), and versioned.

Anyone may build a RENEX-compatible server. Anyone may build a client. Lock-in is the opposite of trust.

- **Spec & frontend:** MIT OR Apache-2.0 (dual) — maximum spread.
- **Reference server:** AGPL-3.0-only — protection against hyperscaler forks-and-hide.

### 4. Privacy by default

The server learns the absolute minimum.

- E2E encryption is not optional. Not in groups. Not in voice.
- Contacts are tied to your account, not to a phone number or email.
- No ads. No trackers. No "analytics because we need them".
- Swiss data-protection standard (DSG + GDPR).
- Logs are not retained beyond the technically necessary.

If law enforcement knocks: we can't hand over message or call content — it's E2E-encrypted. Metadata — who talks to whom, and when — is visible server-side today; we don't hide that (see [`THREAT_MODEL.md`](./THREAT_MODEL.md)), and we're working to minimize it.

### 5. Built for humans, not enterprise

We don't build an enterprise compliance messenger. We build for communities of people who want to hang out, not file tickets.

That makes performance a feature, not a luxury: low latency, instant voice with drop-in, push-to-talk, screen sharing — the things real-time human communities actually live in. No bloated native app; a fast PWA respects your device and your time.

Performance > bells and whistles. Speed is how we respect the human on the other end.

---

## What we will never do

| ❌ Won't | ❌ Never |
|---|---|
| Run ads | Sell user data |
| Build backdoors for governments | Allow autonomous bots/agents |
| Open a public API for external bots | Paywall encryption |
| Allow phone/email as auth | Paywall privacy features |
| Tracking pixels | Build an algorithmic feed |
| Feed newsletter lists with user data | "Verified profile" for a fee |

This is not a marketing list. These are hard architectural decisions. If an investor demands one of these lines be softened: we don't take the investor. Bootstrap > sellout.

---

## How we resist (transparently)

We do not promise an AI-free service. We promise to fight for one.

Here is exactly what we do, today.

**At the gate (account creation):**

- **Passkey only.** No email. No phone. No password. The most common bot-onboarding vectors — leaked email lists, SIM farms, credential stuffing — don't apply to RENEX. You cannot bulk-register accounts from a script.
- **Cloudflare Turnstile** on every signup attempt. Privacy-respecting (no tracking cookies), a cryptographic challenge that requires browser-state proof-of-work.

**At the surface (joining communities):**

- **Turnstile again** on every server creation and every invite acceptance. Discord lets anyone with an HTTP client join 100 servers in 60 seconds. We don't.
- **Per-action rate limits** on every sensitive endpoint. A bot trying to brute-force invite tokens, mass-create channels, or flood role assignments hits the wall fast.

**In the structure (architecture decisions):**

- **No webhooks. No bot APIs. No "developer portal" for autonomous agents.** RENEX has no integration layer for AI systems to plug into. None. This is not "we haven't built it yet". This is "we will not build it".
- **No AI-driven server features.** No sentiment analysis. No conversation summarization. No automatic moderation by ML models. No nudges, no suggestions, no "Here's what people are talking about today" feeds.

**For the moderator (community defense):**

- **Server-level bans** with optional reasons. **Audit logs** for every kick, role change, permission edit, ban, and unban. Community moderators can see what happened and hold each other accountable.
- **Per-channel permission overrides.** A moderator can lock a channel down to specific roles or members in seconds. No bot army can spam a channel they cannot view.
- **No anonymous mass-reports.** RENEX will not let a coordinated AI swarm flag a human into oblivion. Reports are linked to accounts and reviewed individually.

**What we don't promise:**

We do not promise 100% AI-free communication. We can't. New jailbreaks appear weekly. Voice cloning is now a desktop application. We will lose some battles.

What we promise is that we keep fighting. Every layer we add — every captcha, every rate limit, every "we just won't build that" decision — is recorded in this manifesto, in our changelog, and in our code.

If you find a way humans can verify other humans without violating their privacy: **tell us**. We will ship it.

Until then: this is a forever arms race. We have chosen our side.

---

## What we admit

We don't lie. Four honest points:

### 1. Cloudflare lock-in (today)

The reference server runs on Cloudflare Workers, D1, KV, R2, Durable Objects. That's **lock-in for the reference implementation**, not for the protocol. Anyone can build a RENEX-compliant server on their own infra — the spec does not prescribe where it runs.

If Cloudflare drops us tomorrow: the protocol survives. User data is E2E-encrypted and portable.

### 2. WebAuthn coverage

Passkey-only is vision-consistent, but WebAuthn is not pain-free everywhere in 2026. Cross-device passkeys via Bluetooth/QR are sometimes flaky, some browsers have rough edges. We accept that, because the alternative (email auth) breaks the brand core entirely.

### 3. Anti-AI is best-effort

See "How we resist (transparently)" above for the active defenses we ship. This admission emphasizes the limitation: even with those defenses, we cannot guarantee zero AI on the platform. New techniques appear faster than we ship counter-mechanisms. We will not pretend otherwise.

The Terms are explicit. Whoever runs AI on RENEX anyway is banned — without prior warning. That is policy, not detection. We catch the ones we catch. We don't catch all.

### 4. Metadata is visible server-side today

Content is safe: messages and calls are E2E-encrypted, the server cannot read them. But the *metadata* — who talks to whom, when, group memberships, the contact graph — is visible server-side in D1 today. Our own [`THREAT_MODEL.md`](./THREAT_MODEL.md) rates this honestly; we will not pretend otherwise, and we are weaker here than Signal's sealed-sender model.

This is the next frontier, not a solved problem. On the roadmap: **sealed-sender** (the server stops learning who sent what), **delete-after-delivery** for message envelopes, and **client-side-encrypted contact lists**. Until those ship, assume the server can correlate metadata. We'd rather tell you that than market a guarantee we can't keep.

---

## What RENEX is, what it is not

| RENEX **is**… | RENEX is **not**… |
|---|---|
| A messenger | A social network with a feed |
| Open source | A Crypto/Web3 wallet |
| Swiss-hosted | An anonymous platform |
| Community-funded (today) | VC-funded |
| Brand-aligned with privacy-first | A Discord clone |
| A counter-movement | A compliance suite |

---

## To allies

We're looking for people who:

- **Contribute code** — Frontend (Svelte), backend (Workers/JS), spec reviews. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).
- **Read and challenge specs** — if our decision logs are wrong, say so.
- **Stream, write, spread the word** — RENEX grows through word-of-mouth, not ad spend.
- **Host on your own infra** — federation spec is roadmap, but standalone servers are possible today.
- **Give money** — GitHub Sponsors, Founder's Pass ($25 lifetime Pro, capped at first 1000), later Pro subscription.

Not for:

- Anyone who wants to build a bot. Save your time.
- Anyone who thinks "fast growth via dark patterns" is fine.
- Anyone who thinks AI companions are the next big thing and messengers must follow.
- Anyone who sees Discord as a role model.

---

## To the other side

To the bot operators, AI spam networks, growth hackers who will sooner or later try to subvert RENEX:

We see you. We build the platform so you don't get in. If you still manage to: we ban you immediately, without hearing, without appeal. There is no "it was a mistake". There is no "we don't really know you".

We draw clear lines — against bot operators and spam networks, not against humans. This is not hate, this is hygiene.

---

## To the future

In five years the question won't be whether a messenger is E2E-encrypted — that will be standard. The question will be whether it is **human**. Whether you can be sure that on the other side there is no model.

RENEX is the answer to that.

We build this because no one else does. If what we do here is taken for granted in five years: good. Then we've won.

---

**Made in Switzerland. Made for humans. Made to last.**

> If you agree with this: [`CONTRIBUTING.md`](./CONTRIBUTING.md). Build with us.
> If you disagree: write to us, with arguments. We read.
> If you're indifferent to this: then RENEX is maybe not for you. Also fine.

---

## Appendix A: Skeptic FAQ

Ten questions that reliably come — from skeptical investors, Hacker News commenters, Redditors, journalists. We answer them here once in writing. When you get asked: link here.

These answers are deliberately honest, not marketing-glossy. We name the limits of our own promises, because otherwise someone else will — less fairly.

### 1. Why not just Discord + passkeys?

Discord has passkeys — as a second factor, not as primary auth. Email and phone remain mandatory. They can't give that up: email is their recovery, marketing, and compliance anchor.

More seriously: Discord **is** a bot platform. A significant part of their developer ecosystem are bots. An "AI-Free Discord" would kill their own business model. Even if they announced a passkey-only mode tomorrow — nobody would believe them. And DMs are still not E2E-encrypted.

We can keep the promise because we have nothing to protect except the promise.

### 2. How do you prevent Sybil attacks?

Not fully. Nobody can. We raise the **cost per fake identity**:

- **Turnstile captcha on every signup, every server creation, every invite acceptance.** Live as of 2026-06-01. ~$0.001/solve as a baseline, but compounding across three gates a bot must cross.
- **Passkey registration** → real device + biometric setup, ~5 min of human work per account. Cannot be batch-automated without thousands of physical devices.
- **Per-endpoint rate limits + audit logs** → bot farms cannot scale operations silently. Every mass action leaves a trace.
- **Hardware attestation (roadmap Phase 9)** → bypass costs ~$200/device, brings account cost to roughly the same as a Discord Nitro yearly subscription. At that point, why bot us?

Realistically: account cost goes from ~$0 (email signup elsewhere) to ~$5–50 today, with Phase 9 toward ~$200. That makes spam economically unattractive. Enough for a community platform.

"Sybil-resistant" would be a lie. "Sybil-expensive" is the truth.

### 3. How do you prove "human"?

We don't. We make automation expensive.

- **Architecturally:** no public API, no webhooks, no bot tokens. RENEX is not scriptable without reverse engineering plus a captcha farm.
- **Technically:** passkey + hardware attestation (Phase 9) + Turnstile on three gates + rate limits → high setup cost per fake.
- **Socially:** explicit Terms, immediate ban, audit-log accountability for moderators.
- **Experientially (Phase 6.5 onwards):** Pulse. An ambient presence layer that makes the human on the other side visible — through micro-motion, typing energy, device shake. Not authentication. A *belief layer*. Bots have no pulse. See [`PULSE.md`](./PULSE.md).

We don't prove humanity — we make automation uneconomical and human presence sensorially apparent. That's intellectually honest. Any stronger statement would be marketing, and marketing promises break in court and on Reddit.

### 4. Why would communities switch from Discord?

Most won't. That's the truth about network effects.

What we sell is not "switch", but **"second home"**:

- Privacy-aware inner circles inside larger Discord communities
- Indie-dev communities tired of bot spam
- Clans wanting a clean restart after a data leak or Discord policy drama

Users stay on Discord for their main community and use RENEX for the core group next to it. We don't replace Discord — we replace the WhatsApp group that runs alongside it anyway.

Niche-first. Plan six to twelve months of network effects. Anyone who grows faster in this market usually grows with bots.

### 5. What's your unfair advantage?

Two real moats, two smaller levers:

1. **"AI-Free" as a brand moat.** Discord, Slack, Telegram cannot imitate this without killing their bot and developer business. An "AI-Free mode" at any incumbent would be unbelievable. Credibility is not imitable when you have too much to lose.
2. **Swiss jurisdiction, backed by E2E.** Swiss DSG covers the little metadata we hold — a real legal edge over US-based platforms, not just location marketing. We don't oversell it: the reference server still runs on Cloudflare (US-domiciled, so the CLOUD Act can reach it), which means jurisdiction alone is no shield. The real protection is that there's nothing useful to surrender — contacts, messages, and keys are E2E-encrypted and never reach us in clear.
3. Open standard + AGPL server → protects against hyperscaler forks-and-hide.
4. Solo dev + bootstrap → fast iteration, no investor pressure, principled rather than sellout.

The heavy moat is #1.

### 6. How do you onboard users without friction?

Not friction-free. Friction-low.

- **No app download** — PWA, one click to "Add to Home Screen".
- **No email, no SMS, no verification** — handle-only identity.
- **Sign-in via passkey** — 1 click on a known device, QR scan on a new one.
- **Recovery phrase is step 2, not step 1.** Offered at first login, not enforced.
- **Aggressive install tutorial with GIF/video**, because iOS-PWA push needs a manual step.

Where it breaks: Safari/iOS passkey UX is still not perfect in 2026. Users without Touch-ID/Face-ID devices we lose — that's the price of the promise.

30 seconds of passkey setup against zero spam and zero data leak: fair trade.

### 7. How do you prevent growth death by too-strong security?

We accept that security-first is a growth filter. We compensate in four places:

1. **Security as empowerment, not burden.** "YOU ARE THE KEY" sells control, not paranoia.
2. **Friction only where necessary.** Login is 1 click. E2E runs invisibly. Verify-contact is TOFU + auto-toast (Apple-style), not modal hell.
3. **UX quality > security theatre.** Performance, latency, voice later — gamer-first. Anyone starting RENEX should notice it's faster, not more paranoid.
4. **Realistic growth expectations.** Year 1 target: 5,000 active users. Not 5 million. We plan for slow-path and scarcity hype (Founder's Pass), not for mass push.

The honest hard case: if a user loses recovery phrase **and** all devices, the account is gone. It's in the Terms. It's warned in the UI. That's architecture, not a bug. Whoever doesn't accept that is not our target audience.

### 8. Why not Matrix/Element, Session, or SimpleX?

Three good projects with similar ethos, three different trade-offs:

- **Matrix/Element:** Federation is strength and burden at once. Onboarding is hard for non-techies ("choose a homeserver" is not what 95% of users want). E2E has improved, but is not active by default everywhere. We chose a single-server model with an open-standard spec — one less onboarding step, federation as a roadmap option for v3+.

- **Session:** Anonymous by design (no account, no identifier except onion ID). Strong for whistleblowers, weak for persistent communities. We build for stable identities + clans + re-recognition — passkey instead of anonymity.

- **SimpleX:** Per-contact queues, no user identifier — very strong privacy model. Trade-off: discovery is hard (you must exchange links/QR codes for every contact). We chose handle-based identity with E2E — slightly less paranoid, dramatically better UX for groups.

We respect all three. RENEX is not for whistleblowers (take Session), not for federation enthusiasts (take Matrix), not for maximum-paranoid actors (take SimpleX). RENEX is for the gap between: **communities that want WhatsApp/Discord convenience but without bots, without email coercion, without Meta reading along.**

### 9. Isn't passkey-only Apple/Google lock-in?

This is the most common concern — and it's half justified.

**What's true:** passkeys on many devices sync via iCloud Keychain or Google Password Manager. Anyone using exclusively Apple or Android devices is indirectly tied to those providers' cloud sync.

**What we do about it:**

- **Hardware security keys are fully supported.** YubiKey, SoloKey, Nitrokey — no cloud, no vendor sync.
- **Bitwarden / 1Password / KeePassXC** now support passkey storage out of the box. Anyone running a self-hosted password manager stays independent.
- **Recovery phrase is the master override.** If all devices are gone and you have no Apple/Google sync: a 12-word BIP39 phrase reactivates the account. You are never tied to a single vendor.

In practice: RENEX works without an Apple ID, without a Google account, without a vendor cloud. But we don't lie — the easiest path uses platform sync because that's the UX users know. Anyone who doesn't want that has all alternatives open.

### 10. How can I trust web distribution? Reproducible builds?

Honest answer: with a PWA from the browser, you cannot **fully** trust the server. Cloudflare Pages ships the frontend bundle — theoretically a compromised deployment could send you a modified client with a backdoor that weakens the crypto locally.

**What we do about it:**

- **Open-source frontend** (MIT/Apache-2.0). Bundle is reproducible from the repo via `npm install && npm run build` — output hash can be compared against the live bundle.
- **CI build with hash publication** (planned post-launch). Each release tag produces a deterministic bundle whose SHA-256 we publish. Externally auditable.
- **Server can't decrypt anything.** Even with a frontend backdoor: CMKs, GSKs, recovery phrase never leave the device unencrypted. A backdoor would have to exfiltrate local IndexedDB — harder and visible in the browser network tab.
- **Roadmap:** Native apps (Capacitor/Tauri) for users who want to verify reproducible binaries against a hash list.

Whoever wants maximum crypto purity: wait for native builds or build yourself from the repo. The PWA path is the convenience trade-off, not the security maximum.

---

> This FAQ is a living document. If a question is not honestly answered here: write to us, with arguments. We update.
