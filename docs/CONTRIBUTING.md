# Mitarbeiten an RENEX

> **Pragmatisch, direkt, Spec-First.**
> Diese Datei beschreibt, wie Code, Specs und Bug-Reports zu RENEX beitragen werden.

**Version:** 1.0
**Letzte Aktualisierung:** 2026-05-09
**Verbindlich ab:** Phase 2 (Open-Source-Launch)

---

## Inhaltsverzeichnis

1. [Bevor du anfängst](#1-bevor-du-anfängst)
2. [Quick-Start: Lokal entwickeln](#2-quick-start-lokal-entwickeln)
3. [Repo-Struktur](#3-repo-struktur)
4. [Lizenz & DCO](#4-lizenz--dco)
5. [Spec-First-Regel](#5-spec-first-regel)
6. [Coding-Konventionen](#6-coding-konventionen)
7. [Tests](#7-tests)
8. [Pull-Request-Prozess](#8-pull-request-prozess)
9. [Bug-Reports & Feature-Requests](#9-bug-reports--feature-requests)
10. [Security-Disclosure](#10-security-disclosure)
11. [Code of Conduct](#11-code-of-conduct)
12. [Was wir nicht akzeptieren](#12-was-wir-nicht-akzeptieren)

---

## 1. Bevor du anfängst

Lies diese drei Dokumente — in der Reihenfolge:

1. [`MANIFESTO.md`](./MANIFESTO.md) — Wofür wir bauen.
2. [`VISION.md`](./VISION.md) — Wie wir bauen (Strategie, Roadmap, Decision-Logs).
3. [`PROTOCOL.md`](./PROTOCOL.md) — Was wir bauen (Wire-Format, Protocol v1).

Wenn du nach dem Lesen denkst „dieses Projekt ist nichts für mich" — alles gut. Spar dir und uns die Zeit.

Wenn du denkst „yes, hier will ich mitbauen" — weiter unten.

---

## 2. Quick-Start: Lokal entwickeln

### 2.1 Voraussetzungen

| Tool | Min-Version | Wofür |
|---|---|---|
| **Node** | 20+ | Runtime für Tests + Build |
| **npm** | 10+ | Package-Manager |
| **wrangler** | 3.x | Cloudflare-Worker-Deploy |
| **Cloudflare Account** | — | für eigene Test-Infra (D1/KV/R2) |
| **Browser mit WebAuthn** | aktuell | Chrome/Safari/Firefox letzte 2 Major |

Du brauchst **keinen** Cloudflare-Account, wenn du nur Frontend-Komponenten oder
isolierte Backend-Logik (alles in `src/helpers/`, `src/utils/`) anfasst und gegen Vitest
testest.

### 2.2 Setup

```bash
git clone https://github.com/bruno-renex/renex.git
cd renex
npm install
npm test           # Vitest-Suite muss grün sein, bevor du etwas änderst
```

Wenn du Backend lokal/in eigener Cloudflare-Account betreiben willst,
brauchst du eine eigene `wrangler.toml` — siehe §2.4.

### 2.3 Frontend-Dev (Svelte)

```bash
npm run dev        # Vite-Dev-Server, Hot-Reload
```

### 2.4 Backend lokal

Backend läuft auf Cloudflare Workers — lokal via `wrangler dev`:

```bash
cp wrangler.toml.example wrangler.toml
# wrangler.toml ist gitignored — du editierst deine eigene Kopie

# Eigene Cloudflare-Resources erstellen (einmalig):
npx wrangler kv:namespace create RENEX_KV
npx wrangler d1 create renex-db
npx wrangler r2 bucket create renex-files

# IDs aus den Output-Logs in wrangler.toml einsetzen (ersetzt YOUR_*_ID).
# Dann Schema applizieren:
npx wrangler d1 execute renex-db --file=schema.sql
# (für alle weiteren schema-*.sql analog)

# Dev-Server starten:
npx wrangler dev
```

Externe Contributors: für PR-Tests reicht `npm test` — das Backend
muss nicht lokal laufen.

### 2.5 Deploy (nur für Maintainer)

```bash
bash deploy.sh     # Backend + Frontend in einem Schritt (Auto-Versioning)
```

Externe Contributors deployen nicht direkt auf die Production-Infra. PRs werden in
einer Preview-Umgebung getestet.

---

## 3. Repo-Struktur

```
app.renex/
├── docs/                      # Specs (verbindlich, siehe §5)
│   ├── VISION.md
│   ├── MANIFESTO.md
│   ├── PROTOCOL.md
│   ├── MULTI_DEVICE.md
│   ├── RECOVERY.md
│   └── CHANGELOG.md
├── src/                       # Backend (Cloudflare Workers, JS ESM)
│   ├── routes/                # Route-Handler
│   ├── helpers/               # Reusable handlers
│   ├── utils/                 # Stateless utils (rate-limit, json, csrf, …)
│   └── cron.js                # Scheduled jobs
├── frontend/                  # Svelte-App (PWA)
│   └── src/
├── tests/                     # Vitest-Suite (Backend + Crypto)
├── schema*.sql                # D1-Migrationen (numbered, idempotent)
├── deploy.sh                  # Deploy-Script
└── wrangler.toml.example     # Template — `cp` zu wrangler.toml + eigene IDs
```

**Faustregel:** wenn du Crypto, Auth, Multi-Device oder Recovery anfasst, schau zuerst in `docs/`. Wenn du UI-Polishing machst, kannst du direkt in `frontend/src/` starten.

---

## 4. Lizenz & DCO

### 4.1 Lizenz-Split

| Komponente | Lizenz | Begründung |
|---|---|---|
| **Specs** (`docs/PROTOCOL.md`, `MULTI_DEVICE.md`, `RECOVERY.md`) | MIT/Apache 2.0 Dual | maximale Standard-Verbreitung |
| **`MANIFESTO.md`** | CC BY 4.0 | zitierbar mit Attribution |
| **Frontend** (`frontend/`) | MIT/Apache 2.0 Dual | Forks willkommen |
| **Reference-Backend** (`src/`, `wrangler.toml.example`, schemas) | AGPL v3 | Schutz vor Big-Tech-Forks-und-Hide |
| **Tests** (`tests/`) | folgt der getesteten Komponente | — |

Mit deinem PR akzeptierst du, dass dein Beitrag unter der Lizenz der Datei steht, die du änderst.

### 4.2 DCO (Developer Certificate of Origin)

Wir nutzen **DCO**, nicht CLA. Jeder Commit muss signed-off-by sein:

```bash
git commit -s -m "fix: cmk rotation race when authority deletes account"
```

Das fügt eine Zeile `Signed-off-by: Dein Name <deine-email@…>` hinzu und bestätigt:
„Ich habe das Recht, diesen Beitrag unter der angegebenen Lizenz beizutragen." Volltext: <https://developercertificate.org>.

Ohne `Signed-off-by` wird der PR nicht gemerged. Kein workaround.

---

## 5. Spec-First-Regel

**Wire-Format-Änderungen, Crypto-Konstanten, Endpoint-Verträge, State-Machine-Transitions
ändern sich in der Spec — bevor sie sich im Code ändern.**

### 5.1 Wann Spec-First gilt

| Änderung | Spec-Update Pflicht? | Welche Spec |
|---|---|---|
| Neue HTTP-Endpoint-Felder | ✅ ja | [`PROTOCOL.md`](./PROTOCOL.md) §6/§8/§13 |
| Neuer Control-Message-Type | ✅ ja | [`PROTOCOL.md`](./PROTOCOL.md) §10.1 |
| Krypto-Konstante (PBKDF2-Iter, AES-Key-Size, IV-Size) | ✅ ja | [`PROTOCOL.md`](./PROTOCOL.md) §4 + [`RECOVERY.md`](./RECOVERY.md) §4.5 |
| Device-State-Transition | ✅ ja | [`MULTI_DEVICE.md`](./MULTI_DEVICE.md) §3 |
| Recovery-Bundle-Schema | ✅ ja | [`RECOVERY.md`](./RECOVERY.md) §3.1 |
| Rate-Limit-Wert | ✅ ja | jeweilige Spec §6 oder §8 |
| Bug-Fix ohne Verhaltens-Änderung | ❌ nein | — |
| UI-Text, CSS, Settings-Layout | ❌ nein | — |
| Internes Refactor ohne Wire-Impact | ❌ nein | — |

### 5.2 Wie Spec-Updates aussehen

1. **Decision-Log-Eintrag** in der relevanten Spec ergänzen (Datum, Optionen, Pick, Rationale).
2. **Body-Sektion** der Spec aktualisieren (Wire-Format, Tabelle, Mermaid-Diagram).
3. **`CHANGELOG.md`** updaten mit Spec-Version-Bump (semver-mäßig: minor für additive, major für breaking).
4. **Code-PR im selben Branch** wie Spec-Update — nicht zwei getrennte PRs.

Reviewer prüfen Spec-Update zuerst. Wenn die Spec unklar ist, gewinnt der Spec-Reviewer
gegen den Code-Reviewer.

### 5.3 Wenn die Spec falsch ist

Du darfst die Spec angreifen. Decision-Log-Eintrag mit der besseren Option,
PR mit Spec-Korrektur, dann Code. Wir verteidigen keine Specs aus Stolz —
wir verteidigen sie, weil sie sonst auseinanderdriften.

---

## 6. Coding-Konventionen

### 6.1 JavaScript (Backend + Frontend)

- **ESM only** (`type: "module"` im package.json). Keine CommonJS-Imports.
- **Vanilla JS** im Backend, **Svelte 5** im Frontend.
- **Keine Frameworks** im Backend. Kein Express, kein Hono, nichts. Workers laufen
  nativ; Routenhandler sind switch-statements (siehe `src/routes/*.js`).
- **TypeScript** ist optional. Wenn du TS schreibst: `.ts`-Datei, JSDoc-equivalent
  via `@ts-check`-Pragma im JS funktioniert auch.
- **Async/Await**, kein Callback-Hell.
- **Keine Lodash, Underscore, Ramda** — Vanilla reicht. Bundle-Size matters.

### 6.2 Naming

- Files: `camelCase.js` (`chatSend.js`, `e2eRoutes.js`).
- Functions: `camelCase`.
- Constants: `SCREAMING_SNAKE_CASE` für echte Konstanten, `camelCase` für lokale Werte.
- Routen-Cases: lowercase mit Slashes (`/e2e/inbox/upload`).

### 6.3 Kommentare

- **Default: keine.** Code soll lesbar sein, nicht kommentiert.
- Kommentar dann, wenn das **Warum** nicht offensichtlich ist (Sicherheits-Constraint, Workaround für Browser-Bug, subtile Race-Condition).
- **Niemals** „added X for the Y flow" — das gehört in die PR-Description.
- Kein `// TODO` ohne Issue-Referenz.

### 6.4 Performance

- Bundle-Size > Convenience.
- Frontend: jeder neue Top-Level-Import wird gefragt.
- Backend: Workers haben CPU-Limits; vermeide synchrone Loops über große Listen.

### 6.5 Sicherheit

- **Keine Plaintext-Logs** von Message-Bodies, CMKs, GSKs, Master-Keys, Phrases.
- **Keine** `eval()`, `new Function()`, `innerHTML` (use `textContent`).
- **Rate-Limits** auf jedem state-mutierenden Endpoint.
- **CSRF-Check** auf jedem POST/DELETE.
- **JWK-Validation** vor Persistierung (siehe [`e2eRoutes.js`](../src/routes/e2eRoutes.js) `_isValidEcdhPubJwk`).

### 6.6 Commits

- Eine logische Änderung pro Commit.
- Imperativ-Form im Subject: `add cmk rotation telemetry`, nicht `added` oder `adds`.
- Subject ≤ 72 Zeichen, Body bei Bedarf mit Begründung.
- Conventional-Commits-Prefix optional, aber konsistent: `fix:`, `feat:`, `spec:`, `chore:`, `test:`.
- **Pflicht:** `Signed-off-by:` (siehe §4.2).

---

## 7. Tests

> **„Crypto ohne Tests = Selbstmord."** ([`VISION.md`](./VISION.md) §12 Decision-Log, 2026-04-27)

### 7.1 Was Vitest abdeckt heute

```
tests/
├── chatCrypto.test.js           # CMK-Encrypt/Decrypt
├── chatSendControlTypes.test.js # Whitelist-Enforcement (PROTOCOL §10.1)
├── cmk.test.js, cmkRotation.test.js
├── cronAutoRevoke.test.js       # 30d-Sweep
├── groupCrypto.test.js          # GSK-Roundtrip
├── messageSig.test.js           # Sig-Verify (PROTOCOL §11)
├── multidevice.test.js          # State-Machine (MULTI_DEVICE §3)
├── recovery.test.js, recoveryConstants.test.js
├── replayRace.test.js           # CMK-Distribution-Race
├── session.test.js
└── …
```

### 7.2 Pflicht-Tests bei PRs

| PR-Typ | Tests Pflicht |
|---|---|
| Crypto-Code (alles unter `src/crypto/`, `src/utils/crypto*.js`, Recovery, CMK, GSK) | ✅ Vitest, neue Test-Cases für neue Branches |
| Wire-Format (`src/routes/*.js`, `src/helpers/chatSend.js`) | ✅ Round-Trip-Test |
| Cron-Logik (`src/cron.js`) | ✅ Mock-Time-Tests |
| State-Machine ([`MULTI_DEVICE.md`](./MULTI_DEVICE.md) §3 Transitions) | ✅ Test pro neuer Transition |
| Frontend-UI | ❌ Vitest nicht zwingend (Svelte-Component-Tests willkommen, aber nicht Pflicht) |
| Spec-only-Änderungen | ❌ keine Code-Tests |

### 7.3 Test-Run lokal

```bash
npm test                # einmaliger Run, CI-Form
npm run test:watch      # Watch-Mode für Dev
npm run test:ui         # Vitest-UI im Browser
```

PR wird nicht gemerged, wenn die Suite rot ist. Auch nicht wenn „nur ein Test, der eh flaky ist". Flaky-Tests werden **fixed**, nicht gemutet.

### 7.4 Manuelle Integration-Tests

Für Multi-Device + Recovery existieren Test-Matrizen in den Specs:
- [`MULTI_DEVICE.md`](./MULTI_DEVICE.md) §8.2 — 5×5-Konfiguration u.a.
- [`RECOVERY.md`](./RECOVERY.md) §11.2 — Recovery-Roundtrip auf 2. Browser.

Diese werden vor Phase-Cuts manuell durchlaufen — Maintainer-Verantwortung.

---

## 8. Pull-Request-Prozess

### 8.1 Bevor du einen PR aufmachst

- [ ] Issue verlinkt? (Bei nicht-trivialen Änderungen: ja, sonst Diskussion verloren.)
- [ ] Spec-Update parat? (Siehe §5.1 — wenn ja, im selben Branch.)
- [ ] `npm test` ist grün?
- [ ] Commits sind `Signed-off-by`?
- [ ] PR-Description erklärt das **Warum**, nicht das **Was**?

### 8.2 PR-Template

```markdown
## Summary
<1–3 Sätze: Was ändert sich, warum.>

## Spec-Änderung
<Falls ja: Link auf Decision-Log-Eintrag in der relevanten Spec. Falls nein: "n/a".>

## Test-Plan
- [ ] Vitest-Suite grün
- [ ] Manuell getestet: <konkret was, in welchem Browser>
- [ ] Telemetrie geprüft (falls relevant): <Sentry-Event-Name oder n/a>

## Risiko & Rollback
<Was passiert im Worst-Case? Wie machen wir das rückgängig?>
```

### 8.3 Review-Erwartung

- **Erste Antwort:** binnen 5 Werktagen (Solo-Maintainer, kann variieren).
- **Approvals:** mindestens 1 Maintainer-Approval. Bei Crypto/Wire-Format: 2 Approvals oder externe Audit-Notiz.
- **Blocker:** Spec-Lücken, fehlende Tests, Plaintext-Leaks, neue Dependencies ohne Begründung.

### 8.4 Squash vs. Merge

- Default: **Squash-Merge** (eine Commit-Zeile pro PR auf main).
- Ausnahme: Multi-Phase-Migrationen, wo die Historie selbst erklärend ist — dann Merge-Commit nach Absprache.

---

## 9. Bug-Reports & Feature-Requests

### 9.1 Bug-Reports

- Issue-Tracker: GitHub Issues (Repo `github.com/renex/renex`, ab Phase 2).
- **Sicherheits-Bugs gehören NICHT in den öffentlichen Issue-Tracker** — siehe §10.
- Template:

```markdown
**Was passiert?**
**Was sollte passieren?**
**Reproduktion (Schritte):**
**Browser/OS:**
**Console-Errors / Sentry-Event-ID (falls vorhanden):**
```

### 9.2 Feature-Requests

Bevor du eines aufmachst, frag dich:

- Verletzt es eines der 5 Prinzipien aus [`MANIFESTO.md`](./MANIFESTO.md)?
- Ist es schon im [`VISION.md`](./VISION.md) §10 Roadmap-Plan? Dann lieber dort kommentieren statt neuen Issue.
- Gibt es eine [`PROTOCOL.md`](./PROTOCOL.md) §17 / [`MULTI_DEVICE.md`](./MULTI_DEVICE.md) §13 / [`RECOVERY.md`](./RECOVERY.md) §13 Open-Item-Zeile dafür? Dann dort kommentieren.

Features, die ein Prinzip verletzen, werden **direkt geschlossen**. Wir streiten uns nicht.

---

## 10. Security-Disclosure

### 10.1 Wo melden

**Nicht** in GitHub-Issues. **Nicht** in Discord/Slack. **Nicht** auf Twitter.

Stattdessen: **<security@renex.id>** (PGP-Key in `SECURITY.md`, TBD).

### 10.2 Was wir versprechen

- **Acknowledgment:** binnen 72h.
- **Triage:** binnen 7 Tagen.
- **Fix-Plan:** binnen 14 Tagen, je nach Schweregrad.
- **Credit:** öffentliche Nennung im Advisory, nach deinem Einverständnis (oder anonym).

### 10.3 Was wir NICHT akzeptieren

- Public-Disclosure ohne 90-Tage-Embargo.
- „Security-Audits", die nichts gefunden haben, aber Advertising verlangen.
- Kreative Auslegungen unseres Bug-Bounty-Budgets (das es heute nicht gibt — siehe Year 2 in [`VISION.md`](./VISION.md) §10).

### 10.4 Was sicher ein Bug ist

- Plaintext-Leaks in Logs (Server oder Frontend).
- Auth-Bypass jeder Form.
- CSRF / XSS / SQLi.
- Brute-Force-Bypass auf `/e2e/recovery/*`.
- Decrypt-Pfade, die ohne korrekten Key Plaintext zurückgeben.
- State-Machine-Bypass (z.B. `revoked` → `active` ohne neuen Pubkey).

---

## 11. Code of Conduct

Kurz, weil Bullshit-Detector hoch.

**Erwartet:**
- Direkte, technische Argumentation.
- Disagreement vor Push-zu-Konsens.
- Begründungen statt Statusspiele („ich bin Senior, also …" zählt nicht).
- Geduld mit Newcomers — auch wir waren mal das.

**Nicht akzeptiert:**
- Persönliche Angriffe, Diskriminierung jeder Art.
- AI-generated Reviews oder Code-PRs ohne Disclosure (siehe §12).
- Moderations-Spielchen, Community-Drama, Off-Topic-Dauerbeschallung.
- „Whataboutism" gegen das Manifest.

Verstöße: einmalig Verwarnung, dann Bann. Keine drei-Strikes-Politik. Maintainer-Entscheidung ist final.

Vollständig (zukünftig): `CODE_OF_CONDUCT.md` (TBD, Phase 2).

---

## 12. Was wir nicht akzeptieren

| ❌ | Warum |
|---|---|
| **AI-generated Code ohne Disclosure** | Wir sind ein AI-freier Messenger. Wenn dein PR von Copilot/Cursor generiert ist, sag's in der PR-Description. AI-assisted ist ok mit Offenlegung; reine AI-PRs werden geprüft, aber strenger. |
| **Drive-by-Cleanup-PRs ohne Issue** | „Ich hab das Mal aufgeräumt" verbrennt Reviewer-Zeit ohne Plan. Frag erst, bevor du 200 Files anfasst. |
| **Dependencies-PRs ohne Begründung** | Jede neue npm-Package erweitert die Supply-Chain-Surface. Begründung im PR: warum, was kostet sie an Bundle-Size, gibt's Alternativen. |
| **Style-PRs (nur Formatting)** | Formatting wird per Pre-Commit-Hook gelöst, nicht per PR. |
| **Wire-Format-Änderungen ohne Spec-Update** | Siehe §5. |
| **Crypto-Änderungen ohne Tests** | Siehe §7. |
| **PRs gegen die 5 Prinzipien** | „Ich hab nur einen kleinen Bot-Webhook gebaut, ist optional" — nein. Closed. Siehe [`MANIFESTO.md`](./MANIFESTO.md). |

---

## Schluss

Wenn du bis hierher gelesen hast: gut.

Bau mit. Specs lesen, Code schreiben, Bugs melden, Streamen, Weitersagen.
Wir antworten auf jedes ehrliche PR / Issue / Mail.

Wenn etwas in dieser Datei unklar ist: PR. Auch dieses Dokument ist Spec.

— RENEX-Maintainer
