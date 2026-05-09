# Landing-Page Roadmap

Marketing-Section unter dem LoginModal-Hero. Wird nur anonymen Besuchern angezeigt — eingeloggte User sehen sie nie.

## Status

| Phase | Status | Was |
|---|---|---|
| **Phase 1** | ✅ ausgerollt | Hero (Login-Card zentriert) + Features (6 Cards) + Footer (Legal-Links + ©) |
| **Phase 1.5** | ✅ ausgerollt | Particles-Canvas im Hero-Hintergrund (subtle Network-Animation) |
| **Phase 2** | 📋 **Backlog — als separates Feature später** | E2E-Demo-Animation + Tech-Terminal + Demo-/Terminal-i18n |

## Komponenten heute

| Datei | Zweck |
|---|---|
| `components/LoginModal.svelte` | Hero-Wrapper. `flex-direction: column`, scrollbarer Container |
| `components/LandingParticles.svelte` | Canvas mit ~30 driftenden Particles + Verbindungslinien. `prefers-reduced-motion`-aware, pausiert bei `document.hidden`, weniger Particles auf Mobile |
| `components/LandingFeatures.svelte` | 6 Feature-Cards (Passkey-Only highlight, E2E, Voice, Guest, Auto-Delete, Zero-Tracking) |
| `components/LandingFooter.svelte` | Impressum / Datenschutz / AGB / Feedback Links + © |

## Phase 2 — Backlog (TODO als separates Feature)

### a) Animierte E2E-Demo-Section

**Ziel**: Visuell erklären wie E2E-Verschlüsselung funktioniert — für non-Tech-User die's wissen wollen.

**Geplanter Aufbau**:
- Bubble-Flow-Animation:
  1. "Du tippst" — Text-Bubble erscheint
  2. 🔐 Lock-Icon springt drauf (verschlüsselt)
  3. Verschlüsselter Block (random-bytes-Look) wandert zur Cloud
  4. Cloud zeigt nur den Block — keinen Klartext
  5. 🔓 Unlock beim Empfänger
  6. Klartext wieder lesbar in Empfänger-Bubble
- Loop-Timeline mit CSS-Animationen oder JS-driven `requestAnimationFrame`
- IntersectionObserver: nur abspielen wenn Section sichtbar
- `prefers-reduced-motion`: zeigt statisches "Vorher/Nachher"-Bild ohne Animation

**Aufwand-Schätzung**: ~60-90 Min (viel Animation-Logic)

**Datei (geplant)**: `components/LandingE2eDemo.svelte`

### b) Tech-Terminal-Section

**Ziel**: Tech-Credibility, Power-User-/Gamer-Ästhetik.

**Geplanter Aufbau**:
- Terminal-Look: monospace, grün/cyan auf schwarzem Hintergrund, Cursor blink
- Type-Effect (Zeichen für Zeichen):
  ```
  $ renex --version
  RENEX v2026.05 (build a8f3c1)

  $ renex crypto --check
  ✓ AES-256-GCM ready
  ✓ X25519 ECDH established
  ✓ HKDF-SHA-256 derivation OK
  ✓ WebAuthn / Passkey support: native
  ✓ Recovery: 12-word phrase, PBKDF2 600k iter

  $ renex privacy --report
  → 0 trackers
  → 0 analytics scripts
  → 0 third-party cookies
  → server stores: encrypted bytes only
  ```
- Auto-restart-Loop nach 8 s Pause
- IntersectionObserver: startet erst wenn sichtbar
- `prefers-reduced-motion`: zeigt komplettes Terminal ohne Type-Effect

**Aufwand-Schätzung**: ~30-45 Min

**Datei (geplant)**: `components/LandingTechTerminal.svelte`

### c) i18n DE/EN/ES für Demo-Steps + Terminal-Lines

**Ziel**: Demo-Bubble-Texte ("Du tippst…", "Verschlüsselt…", "Empfänger sieht…") + Terminal-Output-Lines mehrsprachig.

**Geplanter Aufbau**:
- Neue Strings in `stores/lang/de.js`, `en.js`, `es.js`:
  - `demoStepType`, `demoStepEncrypt`, `demoStepCloud`, `demoStepDecrypt`, `demoStepRead`
  - `terminalCheckCrypto`, `terminalReportPrivacy`, `terminalLine1`…`terminalLineN`

**Aufwand-Schätzung**: ~15 Min (nur Strings, keine Logic)

## Warum split in Phase 2 = später

- **E2E-Demo** ist viel Animation-Logic mit vielen Edge-Cases (Loop-Timing, IntersectionObserver, Reduced-Motion-Fallback) — gehört eigene PR
- **Tech-Terminal** ist Marketing-Bonbon, kein Mission-Critical-Feature
- Iterativ Feedback einholen ob Phase 1.5 schon reicht, bevor wir mehr investieren

## Trigger zum Reaktivieren

- User Feedback "die Landing wirkt zu nüchtern"
- A/B-Test (wenn jemals): Conversion zu Login mit/ohne Demo
- Sales-Pitch-Bedarf: "Wir brauchen das für eine Demo"

Bei Reaktivierung: Phase 2a + 2b + 2c als ein Feature-Branch zusammen ausrollen.
