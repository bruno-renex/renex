# Contributing to RENEX

> **Pragmatic, direct, spec-first.**
> This file describes how code, specs, and bug reports are contributed to RENEX.

**Version:** 1.1
**Last updated:** 2026-05-23
**Effective:** Phase 2 (Open-Source Launch, 2026-05-27)

---

## Table of Contents

1. [Before you start](#1-before-you-start)
2. [Quick start: local development](#2-quick-start-local-development)
3. [Repo structure](#3-repo-structure)
4. [License & DCO](#4-license--dco)
5. [Spec-first rule](#5-spec-first-rule)
6. [Coding conventions](#6-coding-conventions)
7. [Tests](#7-tests)
8. [Pull request process](#8-pull-request-process)
9. [Bug reports & feature requests](#9-bug-reports--feature-requests)
10. [Security disclosure](#10-security-disclosure)
11. [Code of Conduct](#11-code-of-conduct)
12. [What we don't accept](#12-what-we-dont-accept)

---

## 1. Before you start

Read these three documents — in this order:

1. [`MANIFESTO.md`](./MANIFESTO.md) — what we're building for.
2. [`VISION.md`](./VISION.md) — how we're building (strategy, roadmap, decision logs).
3. [`PROTOCOL.md`](./PROTOCOL.md) — what we're building (wire format, Protocol v1).

If after reading you think "this project is not for me" — fair. Save yourself and us the time.

If you think "yes, I want to build this with you" — continue below.

---

## 2. Quick start: local development

### 2.1 Prerequisites

| Tool | Min version | Purpose |
|---|---|---|
| **Node** | 20+ | Runtime for tests + build |
| **npm** | 10+ | Package manager |
| **wrangler** | 3.x | Cloudflare Worker deploy |
| **Cloudflare Account** | — | for your own test infra (D1/KV/R2) |
| **Browser with WebAuthn** | current | Chrome / Safari / Firefox last 2 major versions |

You do **not** need a Cloudflare account if you only touch frontend components or isolated backend logic (anything in `src/helpers/`, `src/utils/`) and test against Vitest.

### 2.2 Setup

```bash
git clone https://github.com/bruno-renex/renex.git
cd renex
npm install
npm test           # Vitest suite must be green before you change anything
```

If you want to run the backend locally / in your own Cloudflare account, you need your own `wrangler.toml` — see §2.4.

### 2.3 Frontend dev (Svelte)

```bash
npm run dev        # Vite dev server, hot reload
```

### 2.4 Backend locally

The backend runs on Cloudflare Workers — locally via `wrangler dev`:

```bash
cp wrangler.toml.example wrangler.toml
# wrangler.toml is gitignored — you edit your own copy

# Create your own Cloudflare resources (once):
npx wrangler kv:namespace create RENEX_KV
npx wrangler d1 create renex-db
npx wrangler r2 bucket create renex-files

# Put the IDs from the output logs into wrangler.toml (replaces YOUR_*_ID).
# Then apply schemas:
npx wrangler d1 execute renex-db --file=schema.sql
# (analogously for all other schema-*.sql files)

# Start dev server:
npx wrangler dev
```

External contributors: for PR tests, `npm test` is enough — the backend does not need to run locally.

### 2.5 Deploy (maintainers only)

```bash
bash deploy.sh     # Backend + frontend in one step (auto-versioning)
```

External contributors do not deploy directly to production infra. PRs are tested in a preview environment.

---

## 3. Repo structure

```
app.renex/
├── docs/                      # Specs (normative, see §5)
│   ├── VISION.md
│   ├── MANIFESTO.md
│   ├── PROTOCOL.md
│   ├── MULTI_DEVICE.md
│   ├── RECOVERY.md
│   ├── THREAT_MODEL.md
│   └── CHANGELOG.md
├── src/                       # Backend (Cloudflare Workers, JS ESM)
│   ├── routes/                # Route handlers
│   ├── helpers/               # Reusable handlers
│   ├── utils/                 # Stateless utils (rate-limit, json, csrf, …)
│   └── cron.js                # Scheduled jobs
├── frontend/                  # Svelte app (PWA)
│   └── src/
├── tests/                     # Vitest suite (backend + crypto)
├── schema*.sql                # D1 migrations (numbered, idempotent)
├── backend.js                 # Cloudflare Worker entry point
├── deploy.sh                  # Deploy script
└── wrangler.toml.example      # Template — `cp` to wrangler.toml + your own IDs
```

**Rule of thumb:** if you touch crypto, auth, multi-device, or recovery — read `docs/` first. If you're polishing UI, you can start directly in `frontend/src/`.

---

## 4. License & DCO

### 4.1 License split

| Component | License | Rationale |
|---|---|---|
| **Specs** (`docs/PROTOCOL.md`, `MULTI_DEVICE.md`, `RECOVERY.md`, `THREAT_MODEL.md`) | MIT OR Apache-2.0 (dual) | maximum standard spread |
| **`MANIFESTO.md`** | CC BY 4.0 | quotable with attribution |
| **Frontend** (`frontend/`) | MIT OR Apache-2.0 (dual) | forks welcome |
| **Reference backend** (`src/`, `wrangler.toml.example`, schemas) | AGPL-3.0-only | anti-fork-and-hide for hyperscalers |
| **Tests** (`tests/`) | follows the tested component | — |

By submitting a PR, you accept that your contribution falls under the license of the file you modify. Full overview: [`LICENSE`](../LICENSE).

### 4.2 DCO (Developer Certificate of Origin)

We use **DCO**, not a CLA. Every commit must be signed-off:

```bash
git commit -s -m "fix: cmk rotation race when authority deletes account"
```

This adds a `Signed-off-by: Your Name <your-email@…>` line and confirms: "I have the right to contribute this under the stated license." Full text: <https://developercertificate.org>.

Without `Signed-off-by`, the PR will not be merged. No workaround.

---

## 5. Spec-first rule

**Wire-format changes, crypto constants, endpoint contracts, state-machine transitions change in the spec — before they change in code.**

### 5.1 When spec-first applies

| Change | Spec update required? | Which spec |
|---|---|---|
| New HTTP endpoint fields | ✅ yes | [`PROTOCOL.md`](./PROTOCOL.md) §6 / §8 / §13 |
| New control-message type | ✅ yes | [`PROTOCOL.md`](./PROTOCOL.md) §10.1 |
| Crypto constant (PBKDF2 iters, AES key size, IV size) | ✅ yes | [`PROTOCOL.md`](./PROTOCOL.md) §4 + [`RECOVERY.md`](./RECOVERY.md) §4.5 |
| Device state transition | ✅ yes | [`MULTI_DEVICE.md`](./MULTI_DEVICE.md) §3 |
| Recovery bundle schema | ✅ yes | [`RECOVERY.md`](./RECOVERY.md) §3.1 |
| Rate-limit value | ✅ yes | relevant spec §6 or §8 |
| New threat model adversary or weakness | ✅ yes | [`THREAT_MODEL.md`](./THREAT_MODEL.md) §3 / §4 |
| Bug fix without behavior change | ❌ no | — |
| UI text, CSS, settings layout | ❌ no | — |
| Internal refactor without wire impact | ❌ no | — |

### 5.2 How spec updates look

1. **Decision log entry** in the relevant spec (date, options considered, pick, rationale).
2. **Body section** of the spec updated (wire format, table, Mermaid diagram).
3. **`CHANGELOG.md`** updated with spec-version bump (semver: minor for additive, major for breaking).
4. **Code PR in the same branch** as the spec update — not two separate PRs.

Reviewers check the spec update first. If the spec is unclear, the spec reviewer wins against the code reviewer.

### 5.3 When the spec is wrong

You may challenge the spec. Decision-log entry with the better option, PR with the spec correction, then code. We don't defend specs out of pride — we defend them because otherwise implementations drift apart.

---

## 6. Coding conventions

### 6.1 JavaScript (backend + frontend)

- **ESM only** (`type: "module"` in package.json). No CommonJS imports.
- **Vanilla JS** in the backend, **Svelte 5** in the frontend.
- **No frameworks** in the backend. No Express, no Hono, nothing. Workers run natively; route handlers are switch statements (see `src/routes/*.js`).
- **TypeScript** is optional. If you write TS: `.ts` file. JSDoc-equivalent via `@ts-check` pragma in JS also works.
- **Async/await**, no callback hell.
- **No Lodash, Underscore, Ramda** — vanilla is enough. Bundle size matters.

### 6.2 Naming

- Files: `camelCase.js` (`chatSend.js`, `e2eRoutes.js`).
- Functions: `camelCase`.
- Constants: `SCREAMING_SNAKE_CASE` for real constants, `camelCase` for local values.
- Route paths: lowercase with slashes (`/e2e/inbox/upload`).

### 6.3 Comments

- **Default: none.** Code should be readable, not commented.
- Comment when the **why** is non-obvious (security constraint, browser-bug workaround, subtle race condition).
- **Never** "added X for the Y flow" — that belongs in the PR description.
- No `// TODO` without an issue reference.

### 6.4 Performance

- Bundle size > convenience.
- Frontend: every new top-level import gets challenged.
- Backend: Workers have CPU limits; avoid synchronous loops over large lists.

### 6.5 Security

- **No plaintext logs** of message bodies, CMKs, GSKs, master keys, phrases.
- **No** `eval()`, `new Function()`, `innerHTML` (use `textContent`).
- **Rate limits** on every state-mutating endpoint.
- **CSRF check** on every POST/DELETE.
- **JWK validation** before persistence (see [`e2eRoutes.js`](../src/routes/e2eRoutes.js) `_isValidEcdhPubJwk`).

### 6.6 Commits

- One logical change per commit.
- Imperative form in subject: `add cmk rotation telemetry`, not `added` or `adds`.
- Subject ≤ 72 chars, body with rationale when useful.
- Conventional-commits prefix optional but consistent: `fix:`, `feat:`, `spec:`, `chore:`, `test:`.
- **Required:** `Signed-off-by:` (see §4.2).

---

## 7. Tests

> **"Crypto without tests = suicide."** ([`VISION.md`](./VISION.md) §12 decision log, 2026-04-27)

### 7.1 What Vitest covers today

```
tests/
├── chatCrypto.test.js           # CMK encrypt/decrypt
├── chatSendControlTypes.test.js # whitelist enforcement (PROTOCOL §10.1)
├── cmk.test.js, cmkRotation.test.js
├── cronAutoRevoke.test.js       # 30d sweep
├── groupCrypto.test.js          # GSK roundtrip
├── messageSig.test.js           # sig-verify (PROTOCOL §11)
├── multidevice.test.js          # state machine (MULTI_DEVICE §3)
├── recovery.test.js, recoveryConstants.test.js
├── replayRace.test.js           # CMK distribution race
├── session.test.js
└── …
```

Current count: 460 tests, ~17 seconds.

### 7.2 Tests required for PRs

| PR type | Tests required |
|---|---|
| Crypto code (anything under `src/crypto/`, `src/utils/crypto*.js`, Recovery, CMK, GSK) | ✅ Vitest, new test cases for new branches |
| Wire format (`src/routes/*.js`, `src/helpers/chatSend.js`) | ✅ round-trip test |
| Cron logic (`src/cron.js`) | ✅ mock-time tests |
| State machine ([`MULTI_DEVICE.md`](./MULTI_DEVICE.md) §3 transitions) | ✅ test per new transition |
| Frontend UI | ❌ Vitest not mandatory (Svelte component tests welcome but optional) |
| Spec-only changes | ❌ no code tests |

### 7.3 Local test run

```bash
npm test                # one-shot run, CI form
npm run test:watch      # watch mode for dev
npm run test:ui         # Vitest UI in browser
```

A PR will not be merged if the suite is red. Not even "just one test that's flaky anyway". Flaky tests are **fixed**, not muted.

### 7.4 Manual integration tests

For multi-device + recovery, test matrices exist in the specs:
- [`MULTI_DEVICE.md`](./MULTI_DEVICE.md) §8.2 — 5×5 configuration etc.
- [`RECOVERY.md`](./RECOVERY.md) §11.2 — recovery roundtrip on a 2nd browser.

These are run manually before phase cuts — maintainer responsibility.

---

## 8. Pull request process

### 8.1 Before you open a PR

- [ ] Linked issue? (For non-trivial changes: yes, otherwise discussion is lost.)
- [ ] Spec update prepared? (See §5.1 — if yes, in the same branch.)
- [ ] `npm test` is green?
- [ ] Commits are `Signed-off-by`?
- [ ] PR description explains the **why**, not the **what**?

### 8.2 PR template

```markdown
## Summary
<1–3 sentences: what changes, why.>

## Spec change
<If yes: link to decision-log entry in the relevant spec. If no: "n/a".>

## Test plan
- [ ] Vitest suite green
- [ ] Manually tested: <what exactly, in which browser>
- [ ] Telemetry checked (if relevant): <Sentry event name or n/a>

## Risk & rollback
<What happens in the worst case? How do we revert?>
```

### 8.3 Review expectations

- **First response:** within 5 working days (solo maintainer, may vary).
- **Approvals:** at least 1 maintainer approval. For crypto / wire format: 2 approvals or external audit note.
- **Blockers:** spec gaps, missing tests, plaintext leaks, new dependencies without justification.

### 8.4 Squash vs. merge

- Default: **Squash merge** (one commit line per PR on main).
- Exception: multi-phase migrations where the history itself is self-explanatory — then merge commit by agreement.

---

## 9. Bug reports & feature requests

### 9.1 Bug reports

- Issue tracker: GitHub Issues (repo `github.com/bruno-renex/renex`).
- **Security bugs do NOT go into the public issue tracker** — see §10.
- Template (also available in the repo as `.github/ISSUE_TEMPLATE/bug_report.md`):

```markdown
**What happens?**
**What should happen?**
**Reproduction (steps):**
**Browser/OS:**
**Console errors / Sentry event ID (if available):**
```

### 9.2 Feature requests

Before opening one, ask yourself:

- Does it violate one of the 5 principles from [`MANIFESTO.md`](./MANIFESTO.md)?
- Is it already in [`VISION.md`](./VISION.md) §10 roadmap? Then comment there instead of opening a new issue.
- Is there a [`PROTOCOL.md`](./PROTOCOL.md) §17 / [`MULTI_DEVICE.md`](./MULTI_DEVICE.md) §13 / [`RECOVERY.md`](./RECOVERY.md) §13 open-item line for it? Then comment there.

Features that violate a principle are **closed directly**. We don't argue.

---

## 10. Security disclosure

### 10.1 Where to report

**Not** in GitHub Issues. **Not** in Discord/Slack. **Not** on Twitter.

Instead — see [`SECURITY.md`](../SECURITY.md):

1. **GitHub Private Vulnerability Reporting (preferred):** [via the repo's Security tab](https://github.com/bruno-renex/renex/security/advisories/new) — encrypted by design.
2. **Email:** `security@renex.id` — for researchers without a GitHub account.

### 10.2 What we promise

- **Acknowledgement:** within 72h.
- **Triage:** within 7 days.
- **Fix plan:** within 14 days, depending on severity.
- **Credit:** public mention in the advisory with your consent (or anonymous).

### 10.3 What we do NOT accept

- Public disclosure without a 90-day embargo.
- "Security audits" that found nothing but demand advertising.
- Creative interpretations of our bug-bounty budget (which doesn't exist today — see Year 2 in [`VISION.md`](./VISION.md) §10).

### 10.4 What's definitely a bug

- Plaintext leaks in logs (server or frontend).
- Auth bypass of any form.
- CSRF / XSS / SQLi.
- Brute-force bypass on `/e2e/recovery/*`.
- Decrypt paths that return plaintext without the correct key.
- State-machine bypass (e.g. `revoked` → `active` without a new pubkey).

---

## 11. Code of Conduct

Short, because the bullshit detector is high.

**Expected:**
- Direct, technical argumentation.
- Disagreement before push-to-consensus.
- Reasoning instead of status games ("I'm senior, so …" doesn't count).
- Patience with newcomers — we were once too.

**Not accepted:**
- Personal attacks, discrimination of any kind.
- AI-generated reviews or code PRs without disclosure (see §12).
- Moderation games, community drama, off-topic noise.
- "Whataboutism" against the manifesto.

Violations: one warning, then ban. No three-strikes policy. Maintainer decision is final.

Full document (future): `CODE_OF_CONDUCT.md` (planned post-launch).

---

## 12. What we don't accept

| ❌ | Why |
|---|---|
| **AI-generated code without disclosure** | We're an AI-free messenger. If your PR is generated by Copilot / Cursor, say so in the PR description. AI-assisted is ok with disclosure; pure-AI PRs get reviewed but more strictly. |
| **Drive-by cleanup PRs without an issue** | "I just cleaned up" burns reviewer time without a plan. Ask first before touching 200 files. |
| **Dependency PRs without justification** | Every new npm package extends the supply-chain surface. Justify in the PR: why, what bundle-size cost, are there alternatives. |
| **Style PRs (formatting only)** | Formatting is solved via pre-commit hook, not via PR. |
| **Wire-format changes without spec update** | See §5. |
| **Crypto changes without tests** | See §7. |
| **PRs against the 5 principles** | "I only built a small bot webhook, it's optional" — no. Closed. See [`MANIFESTO.md`](./MANIFESTO.md). |

---

## Closing

If you've read this far: good.

Build with us. Read specs, write code, report bugs, stream, spread the word. We respond to every honest PR / issue / mail.

If something in this file is unclear: PR. This document is also a spec.

— RENEX maintainers
