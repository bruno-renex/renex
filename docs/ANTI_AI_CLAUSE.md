# RENEX — Anti-AI / Anti-Bot-Best-Effort Klausel

**Status:** Canonical reference for legal docs
**Version:** 1.0 (initial)
**In Kraft:** 2026-06-02
**Sprachen:** DE + EN

---

## Zweck dieses Dokuments

Diese Datei ist die **einzige Quelle der Wahrheit** für RENEX' Anti-AI-Best-Effort-Klausel.
Sie wird wörtlich in folgende Dokumente eingebettet:

- `frontend/public/agb/index.html` als §3a (DE)
- `frontend/public/terms/index.html` als §3a (EN)
- `docs/MANIFESTO.md` als ausführliche "Anti-AI Transparency"-Sektion (Phase 6 Update)
- `renex.id/manifesto` Static-Site (Phase 6 Manifesto-Public-Page)

Bei Änderungen: **immer hier zuerst editieren**, dann alle Embeds synchronisieren.
Versionierung folgt SemVer-ähnlich: Major = legal-meaningful change, Minor = additional protections,
Patch = wording fixes.

---

## §3a (DE) — Anti-AI / Anti-Bot-Best-Effort

> RENEX positioniert sich bewusst als bot- und KI-resistenter Messaging-Dienst.
> Wir setzen folgende Schutzmechanismen ein:
>
> - **Passkey-only-Authentifizierung** ohne E-Mail oder Telefonnummer — verhindert
>   Bulk-Account-Erstellung durch geleakte oder gekaufte Adress-Listen.
> - **Cloudflare Turnstile** auf Registrierung, Server-Erstellung und Invite-Beitritt
>   als Anti-Bot-Challenge ohne Tracking-Cookies.
> - **Rate-Limits** auf allen sensitiven API-Endpunkten.
> - **Server-Audit-Logs** für Moderations-Aktionen (Bans, Kicks, Rollen-Änderungen)
>   zur Nachverfolgbarkeit von Missbrauch.
> - **Keine Webhooks, keine Bot-APIs, keine 3rd-Party-Integration-Layer** — RENEX
>   bietet keinen Mechanismus für automatisierte Systeme, Nachrichten programmatisch
>   zu senden.
> - **Keine AI-gestützte Inhalts-Verarbeitung** durch den Anbieter (kein
>   Sentiment-Tracking, kein automatisches Zusammenfassen, kein Behavioral-Profiling).
>
> **Best-Effort-Limitierung:** Der Anbieter gibt KEINE Garantie für vollständige Bot-
> oder AI-Freiheit. Neue AI-Techniken können bestehende Detektions-Mechanismen
> umgehen. Der Nutzer akzeptiert, dass trotz dieser Maßnahmen vereinzelt
> AI-generierte oder automatisierte Inhalte erscheinen können.
>
> **Gemeldete Verstöße** prüft der Anbieter und sperrt entsprechende Konten gemäß §7
> dieser AGB.
>
> Hardware-Attestation und Behavioral-Analyse als zusätzliche Anti-Bot-Layer sind für
> zukünftige Versionen geplant und werden hier ergänzt, sobald implementiert.

---

## §3a (EN) — Anti-AI / Anti-Bot Best Effort

> RENEX is deliberately positioned as a bot- and AI-resistant messaging service.
> We employ the following protection mechanisms:
>
> - **Passkey-only authentication** without email or phone number — prevents bulk
>   account creation via leaked or purchased address lists.
> - **Cloudflare Turnstile** on registration, server creation, and invite acceptance
>   as an anti-bot challenge without tracking cookies.
> - **Rate limits** on all sensitive API endpoints.
> - **Server audit logs** for moderation actions (bans, kicks, role changes) for
>   abuse traceability.
> - **No webhooks, no bot APIs, no third-party integration layer** — RENEX provides
>   no mechanism for automated systems to send messages programmatically.
> - **No AI-driven content processing** by the provider (no sentiment tracking, no
>   automatic summarization, no behavioral profiling).
>
> **Best-effort limitation:** The provider does NOT guarantee complete freedom from
> bots or AI. New AI techniques may circumvent existing detection mechanisms. The
> user accepts that, despite these measures, isolated AI-generated or automated
> content may appear.
>
> **Reported violations** will be reviewed by the provider, and corresponding
> accounts will be suspended in accordance with §7 of these Terms.
>
> Hardware attestation and behavioral analysis as additional anti-bot layers are
> planned for future versions and will be added here once implemented.

---

## §6 Enhancement — neuer verbotene-Nutzung-Listenpunkt

### DE (für AGB §6)

> die Massenerstellung von Konten oder automatisiertes Posten von Nachrichten
> mittels AI-/KI-Systemen oder Bots in einem Umfang, der die Bot-Erkennung
> systematisch zu umgehen versucht

### EN (für Terms §6)

> mass creation of accounts or automated posting of messages using AI systems or
> bots at a scale that systematically attempts to circumvent bot detection

**Einsatzpunkt:** Nach dem existing Punkt zu „automatisierten Anfragen / automated requests"
in der `<ul>` der jeweiligen §6.

---

## Embedding-Pfade (für copy-paste-ready HTML)

Falls die Klausel manuell aus diesem Doc in HTML überführt werden muss, hier die
finalen Einbettungs-Hinweise:

### AGB.html (DE)

- **Position:** zwischen §3 (Leistungsbeschreibung) und §4 (Registrierung und Nutzerkonto)
- **Section-Number:** `3a` (keine Renumberung der bestehenden §4–§12)
- **HTML-Pattern:** `<div class="section-title">3a. Anti-AI / Anti-Bot-Best-Effort</div>`
  gefolgt von `<div class="text">...</div>`
- **Listenpunkte mit `<strong>`-tag** für die Mechanismen-Bullets
- **`<br><br>`** zwischen den Block-Paragrafen (Best-Effort-Limitation, Reported Violations, Future-Layers)

### Terms.html (EN)

- **Position:** zwischen §3 (Service Description) und §4 (Registration and User Account)
- Gleiche Pattern wie DE-Version

---

## Versions-Historie

| Version | Datum | Änderung |
|---|---|---|
| **1.0** | 2026-06-02 | Initial — alle 6 Schutzmechanismen + Best-Effort-Limitation + Phase-9-Roadmap-Hinweis (HW-Attestation, Behavioral-Analysis). DE+EN parallel publiziert. §6 Enhancement für „AI-Mass-Posting" als verbotenes Verhalten. |

## Geplante zukünftige Versionen

| Version | Trigger | Voraussichtliche Änderung |
|---|---|---|
| **1.1** | Pulse Phase 6.5 ship (~Ende Juni 2026) | Punkt hinzu: „Pulse als Belief-Layer (Anti-AI-Authenticity-Signal, nicht Auth-Gate)" |
| **1.2** | Phase 9 Hardware-Attestation (Q3 2026) | Roadmap-Hinweis am Ende durch echten Mechanismus ersetzen |
| **1.3** | Phase 9 Behavioral-Analysis (Q3-Q4 2026) | dito |
| **2.0** | Wenn rechtliche Anforderung sich ändert (z.B. EU AI Act compliance) | Major Re-Wording, Anwalt-Review-Pflicht |

---

## Verweise

- [`MANIFESTO.md`](./MANIFESTO.md) — Anti-AI Brand-Statement, ausführlicher und passion-getriebener Version
- [`THREAT_MODEL.md`](./THREAT_MODEL.md) — technische Adversary-Liste
- Roadmap + Monetarisierung: siehe [`../README.md`](../README.md) (Detail-Planung intern)
- [`PULSE.md`](./PULSE.md) §8 — Pulse als zusätzlicher Belief-Layer (nicht Auth-Authority)
