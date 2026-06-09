# RENEX — Launch Playbook (Public Beta)

> Internal. Launch-Comms + Pre-Flight-Checkliste + Ops-Runbook für den Beta-Launch.
> Ziel-Termin: **Sa 13.06.2026**. Voice = v2.0 (Q3 2026), siehe VISION §10.

---

## 1. Positionierung (überall gleich halten)

- **Lead:** *Human-first, gebaut um Automatisierung zu widerstehen.* — **NICHT** „AI-Free-Garantie" / „garantiert keine Bots". Over-Claims werden auf HN/Reddit sofort zerlegt; die ehrliche Linie ist deine Rüstung.
- **Der Differenziator, der Tech-Leute interessiert:** keine Bot-APIs, keine Webhooks, kein Public-Integration-Layer. Konkret und ungewöhnlich.
- **Der fühlbare Haken:** Pulse — „man merkt, dass da wirklich jemand ist".
- **Immer dazusagen:** pre-beta, **nicht extern auditiert** (Audit geplant). Das schafft Vertrauen statt es zu kosten.
- **Tagline:** YOU ARE THE KEY. · Voller Wortlaut + Boilerplate: [`PRESS_KIT.md`](./PRESS_KIT.md), Honest-Claim in §6.

---

## 2. Launch-Posts

### 2a. Show HN
**Titel:** `Show HN: RENEX – a passkey-only messenger with no bot APIs, by design`

> Hi HN — I'm Bruno, a solo dev (and musician) from Switzerland.
>
> RENEX is built on a simple bet: as more of the web becomes automated, talking to an actual human becomes more valuable, not less.
>
> What's different isn't a feature you can screenshot — it's what's deliberately missing. No bot APIs, no webhooks, no public integration layer. Most communication platforms compete to be the easiest to automate; RENEX is deliberately built to make automation expensive. I don't claim every account is human (I can't). The goal is simply to remove the tooling that makes large-scale automation cheap and scalable.
>
> The project is passkey-only (WebAuthn — no email, phone number, or password), end-to-end encrypted for DMs, groups, and voice signaling, built on Cloudflare Workers with a Svelte 5 PWA frontend, and fully open source (MIT/Apache for the protocol, docs and frontend; AGPL for the reference server).
>
> There's also an experimental feature called Pulse: an optional ambient presence layer that makes a chat feel less like exchanging messages and more like sharing a room.
>
> RENEX is currently pre-beta and has not undergone a third-party security audit yet. I'd especially appreciate feedback on the threat model, protocol design, passkey-only identity model, and the decision to exclude bot APIs entirely.
>
> Try it: https://renex.id · Code: https://github.com/bruno-renex/renex · Manifesto: https://renex.id/manifesto

**Timing-Hinweis:** Show HN performt werktags vormittags (PT) am besten. **Samstag ist eher schwach** — erwäge, die Beta am Sa zu öffnen, aber den Show-HN-Post auf **Di–Do vormittags PT** zu legen. Nach dem Posten die ersten 2–3 h dabeibleiben und auf JEDEN Kommentar sachlich antworten (HN belohnt anwesende, ehrliche Founder).

### 2b. Reddit
**Subs (tailored, nicht copy-paste-spammen):** r/privacy · r/selfhosted · r/degoogle · r/SideProject · r/webdev (als „I built…"). Jeweils Sub-Regeln lesen (manche verlangen Flair / kein Self-Promo am Wochenende).

> **Titel:** I built a passkey-only messenger with no bot APIs — open-source, E2E, made in Switzerland
>
> No email, no phone, no password — your identity is a passkey. E2E for DMs/groups/voice-signaling. The deliberate part: no bot APIs, no webhooks, no integration layer — it's built to resist automation, not to "guarantee" anything. There's an optional ambient "presence" layer (Pulse) that makes a chat feel less like exchanging messages and more like sharing a room.
>
> It's **pre-beta and not audited yet** — feedback (especially on the threat model) very welcome. renex.id · Code: github.com/bruno-renex/renex

### 2c. X / @renex_app (Thread)
> **1/** As more of the web becomes automated, talking to an actual human gets more valuable, not less. So I built RENEX — a messenger where there's a human on the other side. Passkey-only, E2E, open-source. 🧵
>
> **2/** What's different is what's *missing*: no bot APIs, no webhooks, no integration layer. Most apps want to be easy to automate. RENEX is built to be hard to automate.
>
> **3/** No email. No phone. No password. Your identity is a passkey on your device. The server never sees your plaintext.
>
> **4/** And Pulse: an optional ambient layer that makes a chat feel less like exchanging messages and more like sharing a room. [landing-pulse video]
>
> **5/** Honest: it's pre-beta, not audited yet. But it's open and it has a point of view. Try it → renex.id · Code → github.com/bruno-renex/renex
>
> *(Media: `landing-pulse.mp4` an Tweet 4; ggf. iOS-Install-Clip.)*

---

## 3. Pre-Launch-Smoke-Test (auf Prod `renex.id`, ~20–30 Min)

**Vorbereitung**
- **Geräte:** iPhone (Safari) + Mac (Brave/Chrome). Android-Gerät optional, nur für den Install-Check.
- **Zwei Identitäten** (für DM/Gruppe nötig): **A** = Konto auf dem iPhone · **B** = Test-Konto auf dem Mac in **eigenem Browser-Profil / privatem Fenster** (eigene Passkey-Identität). **B** auch für Recovery nutzen — nicht das Hauptkonto riskieren.
- Reihenfolge 1→14. **Kritische Stopper: #7 (Reload-Entschlüsselung) + #11 (Recovery)** — sind die grün, steht das Fundament.

**Teil 1 — Landing & Register** *(Mac, frisches Profil)*
1. `renex.id` → Landing lädt, Pulse bewegt sich, Sprachwechsel DE/EN/ES. ✅ Footer-Links (Manifesto/Press/Impressum/Datenschutz/AGB) öffnen je eine Seite (kein 404).
2. Konto **B** registrieren (Passkey via Touch ID/PIN). ✅ Turnstile erscheint bei Neu-Registrierung; Konto angelegt, eingeloggt.

**Teil 2 — Login-Robustheit**
3. B ausloggen → wieder einloggen (bestehender Passkey). ✅ **ohne** Turnstile, sofort drin *(06-04-Fix)*.

**Teil 3 — 2-Parteien-DM (A ↔ B)**
4. iPhone: als **A** einloggen (oder installierte PWA).
5. A + B als **Kontakt** verbinden (Invite/Handle adden + akzeptieren).
6. **DM:** A→B schreiben, B→A antworten — kommt beidseitig an. ✅ beide Richtungen E2E.
7. **Reload-Test:** beide Seiten neu laden → History bleibt lesbar. ⚠️ „kann nicht entschlüsseln" = **kritisch**, melden.

**Teil 4 — Pulse**
8. Im A↔B-DM bei **beiden** Pulse einschalten (Header-Toggle). ✅ Peer-Puls sichtbar (Leuchtkäfer); beide gleichzeitig aktiv → **Handshake** (rosa Synchron-Blinken); Tap auf „● gerade da" → **goldene Nick-Mote**.

**Teil 5 — Gruppe**
9. Als A **Gruppe** erstellen, B hinzufügen, Nachricht senden. ✅ B empfängt (E2E, Sender-Keys).

**Teil 6 — Recovery** *(mit Konto B!)*
10. Bei B **12-Wort-Phrase** generieren + notieren.
11. In frischem Profil (oder nach Logout) Recovery starten → 12 Wörter eingeben. ✅ Zugriff auf B zurück + bestehende DMs lesbar. ⚠️ Fehlschlag = **kritisch** (User würden ausgesperrt), unbedingt melden.

**Teil 7 — PWA-Install**
12. **iOS Safari:** Profil → „Als App installieren" → Modal mit Clip + Schritten.
13. **Android (Brave/Chrome):** ⋮ → „App installieren" → Icon landet am Home-Screen.
14. **Desktop:** Install-Icon (⊕) in der Adressleiste → eigenes Fenster.

**Optional:** Account-Löschen mit Wegwerf-Konto → Konto weg, KV/D1 sauber (DSGVO).

**Bei Fehler:** Rollback `cd ~/dev/renex && npx wrangler rollback` (Panik-Knopf) · Live-Logs `npx wrangler tail` · Sentry-Dashboard · Schritt + Screenshot + Browser-Konsole notieren → an Claude.

---

## 4. Ops-Readiness

| Bereich | Stand |
|---|---|
| **Rate-Limits** (KV-bucketed `rateLimit()` in `auth.js`) | ✅ register 5/min/IP · login · recovery (5×) · profile 10/h · voice_join 30/min · **pulse_send 15/s** · server-create (tier-aware + RL) |
| **Bot-Schutz (Turnstile)** | ✅ Register + Invite-Accept + Server-Create (`verifyTurnstile`) |
| **Sentry (Frontend)** | ✅ `captureException` durchgängig (session/chat/voice/…); DSN `SENTRY_DSN_FRONTEND` ist in Prod gesetzt (im Deploy-Log gesehen) |
| **Sentry (Backend)** | ⚠️ **bestätigen:** empfängt der Worker Fehler? (toucan-js); sonst Launch-Tag via `wrangler tail` live mitlesen |
| **Rollback** | ✅ `npx wrangler rollback` |
| **Kapazität** | ✅ CF Workers + D1 skalieren locker für 50–1000 Beta-User |
| **Recovery** | ✅ BIP39 + R2-Backup (im Smoke-Test prüfen) |
| **Support-Kanal** | ✅ `renex.id/feedback/` + `press@renex.id` |

**Vor dem Launch von dir zu bestätigen:** (1) Backend-Fehler sichtbar (Sentry-Backend ODER `wrangler tail` offen halten), (2) Smoke-Test grün, (3) Posts terminiert.

---

## 5. Launch-Tag-Runbook

1. **Final-Smoke-Test** (§3) auf Prod — grün?
2. **Posts raus** (HN zur richtigen Zeit, §2a-Hinweis) — Reihenfolge: Show HN → X-Thread → Reddit (gestaffelt, nicht alles gleichzeitig).
3. **`wrangler tail` offen** + Sentry-Tab offen — erste 2–3 h aktiv mitlesen.
4. **Auf jeden Kommentar antworten** — sachlich, ehrlich, kein Marketing-Sprech. Bei „können die das beweisen?" → die Honest-Claim-Linie (§1).
5. **Bei Incident:** `npx wrangler rollback`, dann ruhig kommunizieren („known issue, rolling back").
6. **Nach 24 h:** Feedback sammeln (`/feedback/`), Top-3-Themen notieren → nächste Iteration.

---

## 6. Noch offen bis Launch (Stand 2026-06-09)

- [x] **Install-Clips** — iOS (in-App-Modal) · Android Brave + Desktop (Press-Kit-ZIP) live. *(Android Chrome bewusst weggelassen ≈ Brave.)*
- [x] **Posts geschrieben** — Show-HN von Bruno final, Reddit/X angeglichen.
- [ ] **Smoke-Test** (§3) einmal komplett grün durchziehen. → *Bruno*
- [ ] **Backend-Error-Sichtbarkeit** am Launch-Tag (`npx wrangler tail` / Sentry-Backend). → *Bruno*
- [ ] **Posts terminieren** — HN **Di–Do** vormittags PT (nicht Sa). → *Bruno*
- [x] Legal-Seiten · Press-Kit live · Messaging entschärft · Rate-Limits + Turnstile aktiv.
