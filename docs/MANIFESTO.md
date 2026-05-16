# Das RENEX-Manifest

> **AI-FREE FOREVER. PASSKEY-ONLY. HUMANS ONLY.**

**Version:** 1.1
**Letzte Aktualisierung:** 2026-05-14
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

---

## Anhang A: Skeptic FAQ

Sieben Fragen, die zuverlässig kommen — von skeptischen Investoren, von Hacker-News-Kommentatoren, von Redditors, von Journalisten. Wir beantworten sie hier einmal schriftlich. Wenn du gefragt wirst: hierhin verlinken.

Diese Antworten sind bewusst ehrlich, nicht marketing-glatt. Wir nennen die Grenzen unserer eigenen Versprechen, weil sonst jemand anders das tut — und weniger fair.

### 1. Warum nicht einfach Discord + Passkeys?

Discord hat Passkeys — als zweiten Faktor, nicht als primäres Auth. Email und Phone bleiben Pflicht. Sie können das nicht aufgeben: Email ist ihr Recovery-, Marketing- und Compliance-Anker.

Schwerwiegender: Discord **ist** eine Bot-Plattform. Ein nennenswerter Teil ihres Developer-Ökosystems sind Bots. Ein "AI-Free Discord" würde das eigene Geschäftsmodell killen. Selbst wenn sie morgen einen Passkey-only-Modus ankündigen — niemand glaubt ihnen. Und die DMs sind weiterhin nicht E2E-verschlüsselt.

Wir können das Versprechen halten, weil wir nichts zu schützen haben außer das Versprechen.

### 2. Wie verhindert ihr Sybil-Angriffe?

Nicht vollständig. Niemand kann das. Wir erhöhen die **Kosten pro Fake-Identität**:

- Turnstile-Captcha → ~$0.001/Solve (niedrige Hürde)
- Passkey-Registration → echtes Gerät + Biometrie-Setup, ~5 Min Mensch-Arbeit pro Account
- Rate-Limits + Behavioral-Signale → skaliert nicht für Farmen
- Hardware-Attestation (Roadmap Phase 9) → Bypass kostet ~$200/Gerät

Realistisch: Wir drücken die Account-Kosten von ~$0 (Email-Signup anderswo) auf ~$5–50 heute, mit Phase 9 auf ~$200. Damit wird Spam ökonomisch unattraktiv. Das reicht für eine Community-Plattform.

"Sybil-resistant" wäre eine Lüge. "Sybil-teuer" ist die Wahrheit.

### 3. Wie beweist ihr „human"?

Wir beweisen es nicht. Wir machen Automatisierung teuer.

- **Architektonisch:** Kein Public API, keine Webhooks, keine Bot-Tokens. RENEX ist nicht skriptbar ohne Reverse-Engineering plus Captcha-Farm.
- **Technisch:** Passkey + Hardware-Attestation + Captcha + Rate-Limits → hohe Setup-Kosten pro Fake.
- **Sozial:** AGB explizit, sofortiger Bann, "Pure Human Verified"-Badge als Community-Signal.

We don't prove humanity — we make automation uneconomical. Das ist intellektuell ehrlich. Jede stärkere Aussage wäre Marketing, und Marketing-Versprechen brechen vor Gericht und auf Reddit.

### 4. Warum wechseln Communities von Discord?

Die meisten wechseln nicht. Das ist die Wahrheit über Network-Effects.

Was wir verkaufen, ist nicht "Switch", sondern **"Second Home"**:

- Privacy-bewusste Inner-Circles innerhalb größerer Discord-Communities
- Indie-Dev-Communities, die Bot-Spam satthaben
- Clans, die nach Datenleak oder Discord-Policy-Drama einen sauberen Restart wollen

User bleiben auf Discord für ihre Hauptcommunity und nutzen RENEX für die Kerngruppe daneben. Wir ersetzen nicht Discord — wir ersetzen die WhatsApp-Gruppe, die ohnehin daneben läuft.

Niche-First. Sechs bis zwölf Monate Network-Effects einplanen. Wer in diesem Markt schneller wächst, wächst meistens mit Bots.

### 5. Was ist euer unfairer Vorteil?

Zwei echte Moats, zwei kleinere Hebel:

1. **„AI-Free" als Brand-Moat.** Discord, Slack, Telegram können das nicht imitieren, ohne ihr Bot- und Developer-Business zu killen. Ein "AI-Free Mode" wäre bei jedem Incumbent unglaubwürdig. Glaubwürdigkeit ist nicht imitierbar, wenn man zu viel zu verlieren hat.
2. **Schweizer Jurisdiction.** DSG-Standard, kein CLOUD-Act, kein FISA. Rechtlicher Vorteil, nicht bloß Standort-Marketing.
3. Open Standard + AGPL-Server → schützt vor Big-Tech-Forks-und-Hide.
4. Solo-Dev + Bootstrap → schnelle Iteration, kein Investor-Druck, principled statt ausverkaufen.

Der schwere Moat ist Punkt 1.

### 6. Wie onboardet ihr Nutzer ohne Friction?

Nicht friction-frei. Friction-low.

- **Kein App-Download** — PWA, ein Klick zu "Add to Home Screen".
- **Keine Email, keine SMS, keine Verifikation** — Handle-only-Identity.
- **Sign-In via Passkey** — 1-Klick auf bekanntem Gerät, QR-Scan auf neuem.
- **Recovery-Phrase ist Schritt 2, nicht Schritt 1.** Wird beim ersten Login angeboten, nicht erzwungen.
- **Aggressives Install-Tutorial mit GIF/Video**, weil iOS-PWA-Push einen manuellen Schritt braucht.

Wo es bricht: Safari/iOS-Passkey-UX ist 2026 immer noch nicht perfekt. User ohne Touch-ID/Face-ID-Gerät verlieren wir — das ist der Preis fürs Versprechen.

30 Sekunden Passkey-Setup gegen null Spam und null Datenleak: fairer Trade.

### 7. Wie verhindert ihr Growth-Death durch zu starke Security?

Wir akzeptieren, dass Security-First ein Wachstumsfilter ist. Wir kompensieren an vier Stellen:

1. **Security als Empowerment, nicht als Last.** "YOU ARE THE KEY" verkauft Kontrolle, nicht Paranoia.
2. **Friction nur dort, wo nötig.** Login ist 1 Klick. E2E läuft unsichtbar. Verify-Contact ist TOFU + Auto-Toast (Apple-Style), nicht Modal-Hölle.
3. **UX-Quality > Security-Theatre.** Performance, Latency, später Voice — Gamer-First. Wer RENEX startet, soll merken, dass es schneller ist, nicht dass es paranoider ist.
4. **Realistische Wachstumserwartung.** Year-1-Ziel sind 5'000 aktive User. Nicht 5 Millionen. Wir planen für Slow-Path und Knappheits-Hype (Founder's Pass), nicht für Massen-Push.

Der ehrliche harte Fall: Wenn ein User Recovery-Phrase **und** alle Devices verliert, ist der Account weg. Das steht in der AGB. Das wird in der UI gewarnt. Das ist Architektur, kein Bug. Wer das nicht akzeptiert, ist nicht unsere Zielgruppe.

---

> Diese FAQ ist Living Document. Wenn eine Frage hier nicht ehrlich beantwortet ist: schreib uns, mit Argumenten. Wir aktualisieren.
