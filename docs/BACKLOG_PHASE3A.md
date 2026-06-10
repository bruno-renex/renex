# Phase 3A — Security/Perf Backlog (nach Audit)

Stand nach dem Security-Audit + Fix-Sprint **2026-06-10**. Die erledigten Findings
(C1 Invite-Escalation, C2 private Channels, H1 Channel-FS, P1 Send-Fan-out,
Device-Key-Fix für Nicht-Kontakte, M1 member-Override-Check, L2 DSGVO-Cleanup,
L1 CSRF chatRoutes, L4 Doc + Handler-Tests) sind **live** (`2026-06-10-1` … `-7`)
und hier nicht gelistet — siehe `git log`.

## ⏸️ Bewusst vertagt — später umsetzen
| Item | Was | Warum vertagt / wie korrekt umsetzen |
|---|---|---|
| **L3** | Turnstile auf `POST /servers/<id>/invites` | Braucht ein Frontend-Captcha-Widget + UX-Entscheidung; geringer Wert (die Aktion ist bereits auth- **und** ratelimit-gated, `MAX_INVITES_PER_SERVER=25`). Erst zusammen mit dem Frontend-Flow umsetzen — ein reiner Backend-Zwang würde die aktuelle Invite-UI brechen (sendet keinen Token). |
| **A.2** | unread-Counter für private Channels viewer-filtern (`chatSend.js`) | Ein Quick-Fix fügt dem **Hot-Path** (jeder Channel-Send) eine Query hinzu, nur um eine für den Nicht-Viewer **unsichtbare** verwaiste `unread_counters`-Zeile zu vermeiden → netto-negativ. Sauber: das bereits im C2-Send-Gate (`resolveChannelPerms`) ermittelte Overrides-/Viewer-Wissen wiederverwenden statt eines Extra-Reads. |
| **P5** | Fan-out-Architektur (Broadcast-DO / Cloudflare Queue) | Mehrstündiges Architektur-Projekt: den O(M)-Fan-out aus der Sender-Request lösen. Braucht eine Design-Entscheidung (DO-Topologie vs. Queue, Delivery-Semantik) — separat, **nicht** im Sprint. P1 (`ctx.waitUntil`) mildert die Latenz bereits. |

## 🔧 Im Sprint 2026-06-10 (Performance/Härtung, restliche Items)
#6 Thundering-Herd (H1-Debounce) · P4-Cache (`getVisibleChannelIds`) · P3 (redundante D1-Reads) · A.3 (GSK-Redistribution → nur Channel-Viewer) · M2 (`rateLimit` → Durable Object, bounded). Fortschritt: siehe `git log` + Session-Task-Liste.
