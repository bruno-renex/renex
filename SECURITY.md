# Security Policy

> ⚠️ **Pre-beta status — not externally audited.** RENEX has not undergone third-party security review. Until v1.0 audit completion (planned Year 2), do not rely on RENEX for high-risk threat scenarios. See [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) for the full threat model + acknowledged weaknesses.

---

**🇬🇧 English** · [🇩🇪 Deutsch ↓](#security-policy--deutsch)

RENEX is a crypto-messenger. We take security issues seriously.

## Where to report bugs

**Not** as a GitHub issue — not even "just a small suspicion". Public issues could be read by attackers before we can ship a fix.

**Instead:**

1. **GitHub Private Vulnerability Reporting (preferred):** [via the repo's Security tab](https://github.com/bruno-renex/renex/security/advisories/new) — encrypted by design, good for sensitive reports.
2. **Email:** `security@renex.id` — for researchers without a GitHub account. Plaintext mail; for sensitive details prefer GitHub Private VR.

## What we need

- **Description** of the issue, as concrete as possible
- **Reproduction steps** or proof-of-concept code
- **Impact assessment** from your perspective (e.g. "could exfiltrate a peer's CMK if …")
- **Affected component:** Frontend / Backend / Spec / Recovery / etc.
- **Optional:** your suggested fix

## What you can expect

- **Acknowledgement within 72h** (usually faster — but we're a small team)
- **Status updates** at least 1× per week until resolution
- **Coordinated Disclosure:** fix deploy + disclosure typically within 90 days, depending on severity and complexity
- **Credit** in the Changelog and (on request) in a Hall-of-Fame entry

## What we don't pay

No cash bug-bounty — we're not VC-funded. If you find a serious bug, we'll give you a **Lifetime Founder's Pass** (once Phase 6 ships, planned Q4 2026) plus public credit in the Changelog.

If Phase 6 is delayed or the Pro-tier concept changes, we guarantee an equivalent lifetime status — you get something of material value either way, not just a "thanks".

That's all we can promise in compensation.

## Scope

**In-Scope:**

- Crypto-implementation bugs (CMK, GSK, Recovery, Voice-Signaling)
- Authentication bypass (WebAuthn issues, session hijack)
- Server-side issues (permission-checks, KV reads without auth, etc.)
- Privacy leaks (metadata, side-channels)
- Spec weaknesses (wire-format ambiguities that lead to mis-implementations)

**Out-of-Scope:**

- Denial-of-Service via public endpoints (Cloudflare handles general DDoS)
- Social engineering against users or maintainers
- Physical attacks on user devices
- Issues in non-current browser versions (browser ≥ current stable − 2)
- Reports from automated tools (Burp/ZAP/etc.) without human verification

## Known trade-offs

Documented limitations — **not** (yet) bugs:

- **CMK + two-stage HKDF instead of Signal Protocol Double Ratchet:** deliberate Phase 1 choice. DMs derive per-message keys via `CMK → SessionKey → MessageKey` (hourly epoch); Groups via per-message `chainIndex` on the sender chain. Migration to Signal Protocol Double Ratchet planned for Phase 8 (post-beta). See [`docs/PROTOCOL.md`](./docs/PROTOCOL.md) §16 and [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) §4.
- **Voice channels (multi-party):** not yet implemented. Phase 8b adds self-hosted LiveKit SFU + E2E frame-encryption with GSK-derived per-frame keys. **Voice 1:1 is already E2E** (WebRTC DTLS-SRTP via self-hosted coturn on Hetzner DE).
- **`auth.fp` in voice-signaling:** remains plaintext in Phase 1 — see [`docs/CHANGELOG.md`](./docs/CHANGELOG.md) 2026-05-04.
- **Hardware-Attestation against bots:** Phase 9. For now we rely on WebAuthn + Cloudflare Turnstile + rate-limits.

If you want to "report" one of these — no need, we know them.

---

<a id="security-policy--deutsch"></a>

# Security Policy — Deutsch

[🇬🇧 English ↑](#security-policy)

RENEX ist ein Krypto-Messenger. Sicherheits-Issues nehmen wir ernst.

## Wo bugs melden

**Nicht** als GitHub-Issue — auch nicht „nur ein kleiner Verdacht". Öffentliche Issues könnten von Angreifern gelesen werden, bevor wir einen Fix ausrollen können.

**Stattdessen:**

1. **GitHub Private Vulnerability Reporting (bevorzugt):** [via Security-Tab des Repos](https://github.com/bruno-renex/renex/security/advisories/new) — verschlüsselt von Haus aus, gut für sensitive Reports.
2. **E-Mail:** `security@renex.id` — für Researcher ohne GitHub-Account. Klartext-Mail; für sensitive Details lieber GitHub-Reporting nutzen.

## Was wir brauchen

- **Beschreibung** des Issues, möglichst konkret
- **Reproduktionsschritte** oder Proof-of-Concept-Code
- **Impact-Einschätzung** aus deiner Sicht (z.B. „könnte CMK eines Peers exfiltrieren wenn …")
- **Affected component:** Frontend / Backend / Spec / Recovery / etc.
- **Optional:** dein Vorschlag für einen Fix

## Was du erwarten kannst

- **Acknowledgement innerhalb 72h** (in der Regel schneller, aber wir sind ein kleines Team)
- **Status-Updates** mindestens 1× pro Woche bis zur Resolution
- **Coordinated Disclosure:** Fix-Deploy + Disclosure typischerweise innerhalb 90 Tagen, abhängig von Schwere und Komplexität
- **Credit** im Changelog und (auf Wunsch) in einem Hall-of-Fame-Eintrag

## Was wir nicht zahlen

Kein Cash-Bug-Bounty — wir sind nicht VC-funded. Wenn du einen ernsthaften Bug findest, geben wir dir einen **Lifetime-Founder's-Pass** (sobald Phase 6 live ist, geplant Q4 2026) plus public Credit im Changelog.

Wenn Phase 6 sich verzögert oder das Pro-Tier-Konzept geändert wird, garantieren wir alternativ einen lifetime-äquivalenten Status — du bekommst in jedem Fall einen materiellen Gegenwert, nicht nur einen "Danke".

Das ist alles, was wir an Vergütung versprechen können.

## Scope

**In-Scope:**

- Crypto-Implementierungs-Bugs (CMK, GSK, Recovery, Voice-Signaling)
- Authentifikations-Bypass (WebAuthn-Issues, Session-Hijack)
- Server-Side-Issues (Permission-Checks, KV-Reads ohne Auth, etc.)
- Privacy-Leaks (Metadata, Side-Channels)
- Spec-Schwachstellen (Wire-Format-Ambiguitäten, die zu Mis-Implementations führen)

**Out-of-Scope:**

- Denial-of-Service via öffentliche Endpoints (Cloudflare schützt vor generellem DDoS)
- Social-Engineering von Anwendern oder Mitarbeitern
- Physische Angriffe auf User-Geräte
- Issues in nicht-aktuellen Browser-Versionen (Browser ≥ aktuelle stable − 2)
- Reports von automatisierten Tools (Burp/ZAP/etc.) ohne menschliche Verifikation

## Bekannte Trade-offs

Diese Limitations sind dokumentiert und (noch) keine Bugs:

- **CMK + zweistufiges HKDF statt Signal Protocol Double Ratchet:** bewusste Phase-1-Entscheidung. DMs leiten Per-Message-Keys via `CMK → SessionKey → MessageKey` (Stunden-Epoch) ab; Gruppen via Per-Message-`chainIndex` auf der Sender-Chain. Migration zu Signal Protocol Double Ratchet ist für Phase 8 geplant (post-Beta). Siehe [`docs/PROTOCOL.md`](./docs/PROTOCOL.md) §16 und [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) §4.
- **Voice-Channels (Multi-Party):** noch nicht implementiert. Phase 8b bringt self-hosted LiveKit SFU + E2E-Frame-Encryption mit GSK-derived Per-Frame-Keys. **Voice 1:1 ist bereits E2E** (WebRTC DTLS-SRTP via self-hosted coturn auf Hetzner DE).
- **`auth.fp` in Voice-Signaling:** bleibt Klartext in Phase 1 — siehe [`docs/CHANGELOG.md`](./docs/CHANGELOG.md) 2026-05-04.
- **Hardware-Attestation gegen Bots:** Phase 9. Aktuell verlassen wir uns auf WebAuthn + Cloudflare Turnstile + Rate-Limits.

Wenn du einen dieser Punkte „melden" willst — das ist nicht nötig, wir kennen sie.

---

**Last updated / Letzte Aktualisierung:** 2026-05-23
