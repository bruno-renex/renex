# Das RENEX-Manifest

> **AI-FREE FOREVER. PASSKEY-ONLY. HUMANS ONLY.**

**Version:** 1.0
**Letzte Aktualisierung:** 2026-05-09
**Lizenz:** CC BY 4.0 — du darfst dieses Manifest zitieren, mit Attribution.

---

## Was wir bauen

Einen Messenger für Menschen. Nur für Menschen.

Keine Bots. Keine AI-Companions. Keine Foundation-Models, die mitlesen.
Keine Email als Identität. Keine Telefonnummer. Kein Passwort.
Keine Werbung. Niemals.

Du bist der Schlüssel. **YOU ARE THE KEY.**

---

## Warum

Weil das Internet, das wir 2026 haben, kaputt ist.

- **Discord** ist eine Datenkrake mit Bot-Spam.
- **WhatsApp** ist Meta. Reicht.
- **Signal** ist gut. Signal verlangt eine Telefonnummer.
- **Telegram** ist nicht E2E by default und hostet halb-öffentliche Channels für alles.
- **Threema** ist ehrlich, aber niemand benutzt es.

Und alle gemeinsam: sie haben sich der Realität ergeben, dass AI-generated-Content,
Bot-Armeen und LLM-Spam Teil des Produkts sind.

Wir nicht. Nicht heute. Nicht in fünf Jahren.

Wenn du auf RENEX schreibst, schreibst du an einen Menschen. Punkt.

---

## Die 5 Prinzipien

### 1. Passkey-Only

Authentifizierung ausschließlich über WebAuthn / FIDO2.
Deine Identität ist dein biometrischer Schlüssel. Nicht eine Email-Adresse, die ein
Marketing-System scrapen kann. Nicht eine Telefonnummer, die ein Staat triangulieren kann.

Recovery? Eine 12-Wort-Phrase. Auf Papier. In deiner Hand.
Wenn du die Phrase verlierst, ist dein Account weg. Das ist Absicht — nicht ein Bug.

### 2. AI-Free

Keine Bots. Keine API für Bots. Keine Webhooks, in die ein Bot pushen könnte.
Keine "AI-Assistants", die freundlich Vorschläge machen.

Wir erzwingen es **technisch** (Captcha, Rate-Limits, Hardware-Attestation, kein Public-API)
und **sozial** (AGB explizit, sofortiger Bann bei Verstoß).

Wenn dein Use-Case einen Bot erfordert: such dir einen anderen Messenger.
Wir streiten uns nicht. Wir sagen einfach nein.

### 3. Open Standard

Das **RENEX Protocol v1** ist öffentlich, vollständig dokumentiert
([`PROTOCOL.md`](./PROTOCOL.md), [`MULTI_DEVICE.md`](./MULTI_DEVICE.md), [`RECOVERY.md`](./RECOVERY.md)),
versioniert.

Jeder Mensch darf einen RENEX-kompatiblen Server bauen. Jeder Mensch darf einen
Client bauen. Lock-in ist das Gegenteil von Vertrauen.

- **Spec & Frontend:** MIT/Apache 2.0 Dual — maximale Verbreitung.
- **Reference-Server:** AGPL v3 — Schutz vor Big-Tech-Forks-und-Hide.

### 4. Privacy by Default

Der Server lernt das absolute Minimum.

- E2E-Verschlüsselung ist nicht optional. Auch nicht in Gruppen. Auch nicht in Voice.
- Kontaktlisten leben auf deinem Gerät, nicht im Cloud-Index.
- Keine Werbung. Keine Tracker. Kein "Analytics, weil wir's brauchen".
- Schweizer Datenschutz-Standard (DSG + DSGVO).
- Logs werden nicht über das technisch Nötige hinaus aufbewahrt.

Wenn die Polizei klingelt: wir haben nichts, was sie haben wollen.
Das ist Architektur, nicht Politik.

### 5. Gamer-First UX

Wir bauen keinen Enterprise-Compliance-Messenger. Wir bauen für Communities.

- Niedrige Latency.
- Voice-Channels mit Drop-in.
- Push-to-Talk.
- Screen-Sharing.
- Steam Rich Presence.
- Keine Native App, weil PWA reicht und schneller ist.

Performance > Schnickschnack. Bundle-Size matters.

---

## Was wir nie machen werden

| ❌ Nicht | ❌ Niemals |
|---|---|
| Werbung schalten | User-Daten verkaufen |
| Backdoors für Behörden einbauen | AI-Generated-Content erlauben |
| Public-API für externe Bots öffnen | Verschlüsselung paywallen |
| Phone/Email als Auth zulassen | Privacy-Features paywallen |
| Tracking-Pixel | Algorithmischen Feed bauen |
| Newsletter-Liste mit User-Daten füttern | "Verified Profile" gegen Aufpreis |

Das ist keine Marketing-Liste. Das sind harte Architektur-Entscheidungen.
Wenn ein Investor verlangt, dass eine dieser Zeilen weicht: dann nehmen wir den
Investor nicht. Bootstrap > Ausverkauf.

---

## Was wir zugeben

Wir lügen nicht. Drei ehrliche Punkte:

### 1. Cloudflare-Lock-in (heute)

Der Reference-Server läuft auf Cloudflare Workers, D1, KV, R2, Durable Objects.
Das ist **Lock-in für die Reference-Implementation**, nicht für das Protokoll.
Jeder kann einen RENEX-konformen Server auf eigener Infra bauen — die Spec
schreibt nicht vor, wo er läuft.

Wenn Cloudflare uns morgen rauswirft: das Protokoll überlebt. Die Daten der User
sind E2E-encrypted und transportabel.

### 2. WebAuthn-Coverage

Passkey-only ist Vision-konsequent, aber WebAuthn ist 2026 noch nicht überall
schmerzfrei. Cross-Device-Passkeys per Bluetooth/QR sind teils flaky, manche
Browser haben rough Edges. Wir tragen das, weil die Alternative (Email-Auth) den
ganzen Markenkern bricht.

### 3. Anti-AI ist Best-Effort

Wir können nicht garantieren, dass nie ein Bot durchschlüpft. Wir können
garantieren, dass wir alles dafür tun: Hardware-Attestation, Behavioral-Analysis,
Captcha-Hardening, sofortiger Bann bei Verstoß. Die AGB sind explizit. Wer
trotzdem AI auf RENEX laufen lässt, fliegt — ohne Vorwarnung.

---

## Was wir sind, was wir nicht sind

| RENEX **ist**… | RENEX ist **nicht**… |
|---|---|
| Ein Messenger | Ein Social-Network mit Feed |
| Open Source | Ein Crypto/Web3-Wallet |
| Schweizer-gehostet | Eine Anonymous-Plattform |
| Community-finanziert (heute) | VC-funded |
| Brand-konform mit Privacy-First | Ein Discord-Klon |
| Eine Gegenbewegung | Eine Compliance-Suite |

---

## An die Mitstreiter

Wir suchen Menschen, die:

- **Code beitragen** — Frontend (Svelte), Backend (Workers/JS), Spec-Reviews. Siehe [`CONTRIBUTING.md`](./CONTRIBUTING.md).
- **Specs lesen und challengen** — wenn unsere Decision-Logs falsch sind, sag's.
- **Streamen, schreiben, weitersagen** — RENEX wächst durch Word-of-Mouth, nicht durch Ad-Spend.
- **Auf eigener Infra hosten** — Federations-Spec ist Roadmap, aber alleinstehende Server sind heute schon möglich.
- **Geld geben** — GitHub Sponsors, Founder's Pass ($25 Lifetime Pro, limitiert auf erste 1000), später Pro-Subscription.

Wer es nicht tun soll:

- Wer einen Bot bauen will. Spar dir die Zeit.
- Wer "schnelles Wachstum durch dunkle Patterns" gut findet.
- Wer denkt, AI-Companions seien das nächste große Ding und Messenger müssen mitziehen.
- Wer Discord als Vorbild sieht.

---

## An die Gegenseite

An die Bot-Operatoren, AI-Spam-Networks, Growth-Hacker, die früher oder später
versuchen werden, RENEX zu unterwandern:

Wir sehen euch. Wir bauen die Plattform so, dass ihr nicht reinkommt.
Wenn ihr es trotzdem schafft: wir bannen euch sofort, ohne Anhörung, ohne
Berufung. Es gibt kein "das war ein Versehen". Es gibt kein "wir kennen euch
nicht so genau". Wir sind hier explizit, nicht inklusiv.

Das ist nicht Hass. Das ist Hygiene.

---

## An die Zukunft

In fünf Jahren wird die Frage nicht sein, ob ein Messenger E2E-verschlüsselt ist —
das wird Standard sein. Die Frage wird sein, ob er **menschlich** ist. Ob du sicher
sein kannst, dass auf der anderen Seite kein Modell sitzt.

RENEX ist die Antwort darauf.

Wir bauen das, weil es sonst niemand baut. Wenn das, was wir hier machen, in fünf
Jahren als selbstverständlich gilt: gut. Dann haben wir gewonnen.

---

**Made in Switzerland. Made for humans. Made to last.**

> Wenn du dem hier zustimmst: [`CONTRIBUTING.md`](./CONTRIBUTING.md). Mach mit.
> Wenn du dem hier widersprichst: schreib uns, mit Argumenten. Wir lesen.
> Wenn du dem hier gleichgültig gegenüberstehst: dann ist RENEX vielleicht nicht für dich. Auch ok.
