# Security Policy

RENEX ist ein Krypto-Messenger. Sicherheits-Issues nehmen wir ernst.

> ⚠️ **Pre-beta status — not externally audited.** RENEX has not undergone third-party security review. Until v1.0 audit completion (planned Year 2), do not rely on RENEX for high-risk threat scenarios. See [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) for the full threat model + acknowledged weaknesses.

---

## Wo bugs melden

**Nicht** als GitHub-Issue — auch nicht „nur ein kleiner Verdacht".
Öffentliche Issues könnten von Angreifern gelesen werden, bevor wir
einen Fix ausrollen können.

**Stattdessen:**

1. **GitHub Private Vulnerability Reporting (bevorzugt):** [via Security-Tab des Repos](https://github.com/bruno-renex/renex/security/advisories/new) — verschlüsselt von Haus aus, gut für sensitive Reports.
2. **E-Mail:** `security@renex.id` — für Researcher ohne GitHub-Account. Klartext-Mail; für sensitive Details lieber GitHub-Reporting nutzen.

## Was wir brauchen

- **Beschreibung** des Issues, möglichst konkret
- **Reproduktionsschritte** oder Proof-of-Concept-Code
- **Impact-Einschätzung** aus deiner Sicht (z.B. „könnte CMK eines Peers
  exfiltrieren wenn …")
- **Affected component**: Frontend / Backend / Spec / Recovery / etc.
- **Optional:** dein Vorschlag für einen Fix

## Was du erwarten kannst

- **Acknowledgement innerhalb 72h** (in der Regel schneller, aber wir sind
  ein kleines Team).
- **Status-Updates** mindestens 1× pro Woche bis zur Resolution.
- **Coordinated Disclosure**: Fix-Deploy + Disclosure typischerweise innerhalb
  90 Tagen, abhängig von Schwere und Komplexität.
- **Credit** im Changelog und (auf Wunsch) in einem Hall-of-Fame-Eintrag.

## Was wir nicht zahlen

Kein Cash-Bug-Bounty — wir sind nicht VC-funded. Wenn du einen ernsthaften
Bug findest, geben wir dir einen **Lifetime-Founder's-Pass** (sobald Phase 6
live ist, geplant Q4 2026) plus public Credit im Changelog.

Wenn Phase 6 sich verzögert oder das Pro-Tier-Konzept geändert wird,
garantieren wir alternativ einen lifetime-äquivalenten Status — du bekommst
in jedem Fall einen materiellen Gegenwert, nicht nur einen "Danke".

Das ist alles, was wir an Vergütung versprechen können.

## Scope

**In-Scope:**

- Crypto-Implementierungs-Bugs (CMK, GSK, Recovery, Voice-Signaling)
- Authentifikations-Bypass (WebAuthn-Issues, Session-Hijack)
- Server-Side-Issues (Permission-Checks, KV-Reads ohne Auth, etc.)
- Privacy-Leaks (Metadata, Side-Channels)
- Spec-Schwachstellen (Wire-Format-Ambiguitäten, die zu Mis-Implementations führen)

**Out-of-Scope:**

- Denial-of-Service via öffentliche Endpoints (Cloudflare schützt vor
  generellem DDoS)
- Social-Engineering von Anwendern oder Mitarbeitern
- Physische Angriffe auf User-Geräte
- Issues in nicht-aktuellen Browser-Versionen (Browser ≥ aktuelle stable - 2)
- Reports von automatisierten Tools (Burp/ZAP/etc.) ohne menschliche
  Verifikation

## Bekannte Trade-offs

Diese Limitations sind dokumentiert und (noch) keine Bugs:

- **CMK-Epochs statt Signal Protocol Double-Ratchet**: bewusste Entscheidung
  für Phase 1, Migration zu Signal Protocol in Phase 8 (post-Beta). Siehe
  [`docs/PROTOCOL.md`](./docs/PROTOCOL.md) §16.
- **Voice-Mesh-Calls (Voice-Rooms)**: Phase 1 noch ohne E2E (nur 1:1-Calls
  sind verschlüsselt). Phase 2 zieht Mesh nach.
- **`auth.fp` in Voice-Signaling**: bleibt Klartext in Phase 1 — siehe
  [`docs/CHANGELOG.md`](./docs/CHANGELOG.md) 2026-05-04.
- **Hardware-Attestation gegen Bots**: Phase 5. Aktuell verlassen wir uns
  auf WebAuthn + Cloudflare Turnstile.

Wenn du einen dieser Punkte „melden" willst — das ist nicht nötig, wir kennen sie.

---

**Letzte Aktualisierung:** 2026-05-10
