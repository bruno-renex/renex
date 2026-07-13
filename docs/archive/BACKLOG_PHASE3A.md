# Phase 3A — Security/Perf Backlog (nach Audit)

Stand nach dem Security-Audit + Fix-Sprint **2026-06-10**. **Erledigt + live**
(`2026-06-10-1` … `-9`, siehe `git log`): C1 Invite-Escalation · C2 private Channels
(Send/History/Recipient/GSK) · H1 Channel-Forward-Secrecy · P1 Send-Fan-out
(`waitUntil`) · Device-Key-Fix für Nicht-Kontakte · M1 member-Override-Check ·
L2 DSGVO-Cleanup · L1 CSRF chatRoutes · L4 Sig-Soft-Fail-Doc · #6 H1-Debounce ·
P4-Cache (Channel-Sichtbarkeit) · Handler-Wiring-Tests (C1 + C2).

Die folgenden Items sind **bewusst vertagt** — mit empfohlener Phase + Auslöser.

---

## ⏸️ Vertagte Items

| Item | Was | Warum vertagt | **Phase / Trigger** |
|---|---|---|---|
| **A.3** | GSK-Redistribution nur an Channel-Viewer (statt alle Server-Member) | **≈0 Wert** — C2 verhindert bereits, dass Nicht-Viewer Ciphertext bekommen; ein zusätzlicher GSK nützt ihnen nichts. Reines defense-in-depth. Frontend-Krypto-Risiko. | **v2 / Signal-Migration (Q4 2026).** In die Sender-Key-Neugestaltung einbauen — das GSK-Modell wird durch Double-Ratchet ersetzt, eine Härtung am alten Modell wäre Wegwerf-Arbeit. |
| **A.2** | unread-Counter für private Channels viewer-filtern | Quick-Fix fügt dem Hot-Path eine Query hinzu, um eine *unsichtbare* verwaiste Zähler-Zeile zu vermeiden → netto-negativ. Korrekt: Overrides/Viewer-Wissen aus dem C2-Send-Gate wiederverwenden (kein Extra-Read). | **Opportunistisch** — beim nächsten Anfassen des `chatSend`-Send-Pfads (z. B. im Zuge von P5) mitnehmen. Kein eigener Slot nötig. |
| **P3** | Redundante D1-Reads memoizen (Send-Pfad Convo-Lookup; Kick `getServerMembership` 3×) | Marginaler Nutzen (billige indizierte Lookups; Kick selten), aber Hot-Path-/Shared-Helper-Refactor-Risiko. | **Server-Scale-Pass** (mit P4-Pagination + P5). Trigger: gemessene Send-Latenz oder D1-Kosten. |
| **P4-Pagination** | `serverDetail`/`listMembers` Member-Liste paginieren | Skalen-relevant (große Member-Listen), aber API-Shape-Änderung → Frontend-Lazy-Load nötig (Kopplung). | **Server-Scale-Pass.** Trigger: Server ≳ 200 Member oder gemessenes Payload-Problem. |
| **M2** | `rateLimit` atomar via Durable Object (statt KV read-then-write) | **Realer** Anti-Abuse-Wert, aber der KV-Limiter funktioniert; die Nicht-Atomarität erlaubt nur *geringe* Überschreitung unter Burst — nicht beta-kritisch. Kern-Primitive (jeder Endpoint) = höchste Blast-Radius. | **Post-Beta-Härtung.** Trigger: reale Traffic-/Abuse-Signale oder **vor** einem Wachstums-/Marketing-Push. Ggf. mit der Anti-Bot-Phase (Phase 9, Hardware-Attestation) bündeln. *Bounded* umsetzen: neuer DO-Limiter nur für sensible Buckets (Login/Register/Send), KV bleibt sonst. |
| **L3** | Turnstile auf `POST /servers/<id>/invites` | Braucht Frontend-Captcha-Widget + UX-Entscheidung; Aktion ist bereits auth- + ratelimit-gated (`MAX_INVITES_PER_SERVER=25`). | **Anti-Bot-Phase (Phase 9)** bzw. wenn ein Frontend-Captcha-Pass ohnehin ansteht. Niedrige Priorität. |
| **P5** | Fan-out-Architektur (Broadcast-DO / Cloudflare Queue) | O(M)-Fan-out aus der Sender-Request lösen. Mehrstündiges Architektur-Projekt; P1 (`waitUntil`) mildert die Latenz bereits. | **Server-Scale-Pass** (das große Item dort). Trigger: Channels mit vielen hundert Membern / Send-Subrequest-Last. Design-Entscheidung DO-Topologie vs. Queue zuerst. |

---

## 🗺️ Phasen-Übersicht (empfohlene Bündelung)

- **Post-Beta-Härtung** (Wochen nach Launch, sobald reale Traffic-Daten): **M2** (+ ggf. **L3** mit Anti-Bot Phase 9).
- **Server-Scale-Pass** (wenn erste große Server/Channels auftauchen, ~200+ Member): **P3 + P4-Pagination + P5** zusammen (alle „mach große Server schnell"); **A.2** opportunistisch mitnehmen (Send-Pfad wird eh angefasst).
- **v2 / Signal-Migration** (~Q4 2026, GSK → Double-Ratchet): **A.3** in das neue Sender-Key-Design integrieren.

**Begründung:** Keiner dieser Punkte ist beta-blockierend (Beta-Server sind klein). Sie nach **Auslöser** statt nach Kalender anzugehen vermeidet Spekulativ-Arbeit und hält das Regressions-Risiko niedrig — besonders A.3, das am bald-obsoleten GSK-Modell hängt und erst mit der Signal-Migration sinnvoll wird.
