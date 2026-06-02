# Das RENEX-Manifest

> **PASSKEY-ONLY. HUMAN-FIRST. OPEN-STANDARD.**

**Version:** 1.6
**Letzte Aktualisierung:** 2026-06-02
**Lizenz:** CC BY 4.0 — du darfst dieses Manifest mit Quellenangabe zitieren.
**Übersetzungen:** [English](./MANIFESTO.md) (Original)

---

## Warum jetzt

RENEX ist nicht „noch ein Messenger". RENEX ist eine philosophische Antwort auf ein zunehmend KI-generiertes Internet.

Wir bauen nicht *gegen* KI. Wir bauen *für* Menschen, in einer Zeit, in der die Unterscheidung zwischen beiden verschwimmt. Wenn du in fünf Jahren mit jemandem auf RENEX sprichst, sollst du wissen: auf der anderen Seite sitzt ein Mensch.

**Wir beweisen Menschsein nicht — wir machen Automatisierung teuer.** Das ist der ehrliche Kern von allem, was folgt. Keine Garantie, dass jeder Account ein Mensch ist, sondern eine Plattform, die so gebaut ist, dass sich Fälschen selten lohnt. Lies den Rest mit diesem Rahmen: jede Aussage hier ist ein Kampf, den wir führen, kein Versprechen, das wir längst gewonnen hätten.

---

## Was wir bauen

Einen Messenger für Menschen. Nur für Menschen.

Keine Bots. Keine KI-Companions. Keine Foundation-Models, die mitlesen. Keine E-Mail als Identität. Keine Telefonnummer. Kein Passwort. Keine Werbung. Niemals.

Du bist der Schlüssel. **DU BIST DER SCHLÜSSEL.**

---

## Warum

Weil das Internet, das wir 2026 haben, kaputt ist.

- **Discord** ist optimiert für Skalierung, Integrationen, Automatisierung — legitim, aber nicht das, was wir wollen.
- **WhatsApp** gehört Meta. Mehr muss man nicht sagen.
- **Signal** ist solide. Signal verlangt eine Telefonnummer.
- **Telegram** ist nicht E2E by default und hostet halb-öffentliche Channels.
- **Threema** ist ehrlich, aber niemand benutzt es.

Und alle zusammen: sie haben akzeptiert, dass KI-generierte Inhalte, Bot-Armeen und LLM-Spam Teil des Produkts sind.

Wir nicht. Nicht heute. Nicht in fünf Jahren.

Wenn du auf RENEX schreibst, schreibst du an einen Menschen. Wir können das nicht garantieren — aber wir machen Automatisierung technisch und ökonomisch teuer genug, dass sie sich selten lohnt.

---

## Die 5 Prinzipien

### 1. Passkey-only

Authentifizierung ausschliesslich via WebAuthn / FIDO2. Deine Identität ist dein biometrischer Schlüssel. Keine E-Mail-Adresse, die ein Marketing-System scrapen kann. Keine Telefonnummer, die ein Staat triangulieren kann.

Recovery? Eine 12-Wort-Phrase. Auf Papier. In deiner Hand. Verlierst du die Phrase, ist dein Konto weg. Das ist Design — kein Bug.

### 2. Human-first

**Wir beweisen Menschsein nicht — wir machen Automatisierung unwirtschaftlich.**

Keine Bot-APIs. Keine Webhooks. Keine „KI-Assistenten", die höflich Vorschläge machen. Stattdessen: Captcha, Rate-Limits, Hardware-Attestation als Roadmap-Item, explizite Nutzungsbedingungen, sofortige Sperre bei Verstoss.

Wenn du Bots betreibst, fliegst du raus. Wenn du ein Tool wie Grammarly nutzt, um deinen eigenen Text zu polieren, ist das deine Sache — wir kontrollieren keine User-side-Tools.

Wenn dein Use-Case einen Bot verlangt, ist RENEX nicht das richtige Werkzeug — und das ist eine bewusste Design-Entscheidung, keine Lücke, die wir später füllen. Wir sind lieber der falsche Fit für manche Use-Cases als der richtige für Automatisierung.

### 3. Offener Standard

Das **RENEX-Protokoll v1** ist öffentlich, vollständig dokumentiert ([`PROTOCOL.md`](./PROTOCOL.md), [`MULTI_DEVICE.md`](./MULTI_DEVICE.md), [`RECOVERY.md`](./RECOVERY.md), [`THREAT_MODEL.md`](./THREAT_MODEL.md)) und versioniert.

Jeder darf einen RENEX-kompatiblen Server bauen. Jeder darf einen Client bauen. Lock-in ist das Gegenteil von Vertrauen.

- **Spec & Frontend:** MIT ODER Apache-2.0 (dual) — maximale Verbreitung.
- **Reference-Server:** AGPL-3.0-only — Schutz vor Hyperscaler-fork-and-hide.

### 4. Datenschutz by default

Der Server erfährt das absolute Minimum.

- E2E-Verschlüsselung ist nicht optional. Nicht in Gruppen. Nicht im Voice.
- Kontakte sind an deinen Account gebunden, nicht an Telefonnummer oder E-Mail.
- Keine Werbung. Keine Tracker. Keine „Analytics, weil wir sie brauchen".
- Schweizer Datenschutzstandard (DSG + DSGVO).
- Logs werden nicht über das technisch Notwendige hinaus aufbewahrt.

Wenn die Strafverfolgung anklopft: Nachrichten- und Anrufinhalte können wir nicht herausgeben — sie sind E2E-verschlüsselt. Metadaten — wer wann mit wem — sind heute server-seitig sichtbar; wir verstecken das nicht (siehe [`THREAT_MODEL.md`](./THREAT_MODEL.md)) und arbeiten daran, sie zu minimieren.

### 5. Für Menschen gebaut, nicht für Enterprise

Wir bauen keinen Enterprise-Compliance-Messenger. Wir bauen für Communities aus Menschen, die abhängen wollen, nicht Tickets abarbeiten.

Das macht Performance zum Feature, nicht zum Luxus: niedrige Latenz, Voice mit Drop-in, Push-to-Talk, Screen-Sharing — das, worin Echtzeit-Communities tatsächlich leben. Keine aufgeblähte native App; eine schnelle PWA respektiert dein Gerät und deine Zeit.

Performance > Schnickschnack. Geschwindigkeit ist, wie wir den Menschen auf der anderen Seite respektieren.

---

## Was wir niemals tun werden

| ❌ Werden nicht | ❌ Niemals |
|---|---|
| Werbung schalten | User-Daten verkaufen |
| Backdoors für Regierungen bauen | Autonome Bots/Agenten erlauben |
| Öffentliche API für externe Bots öffnen | Verschlüsselung paywallen |
| Telefon/E-Mail als Auth zulassen | Privacy-Features paywallen |
| Tracking-Pixel | Algorithmischen Feed bauen |
| Newsletter-Listen mit User-Daten füttern | „Verified Profile" gegen Bezahlung |

Das ist keine Marketing-Liste. Das sind harte Architektur-Entscheidungen. Wenn ein Investor verlangt, dass eine dieser Linien aufgeweicht wird: dann nehmen wir den Investor nicht. Bootstrap > Sellout.

---

## Wie wir uns wehren (transparent)

Wir versprechen keinen KI-freien Dienst. Wir versprechen, dafür zu kämpfen.

Hier ist genau das, was wir heute tun.

**Am Tor (Account-Erstellung):**

- **Passkey only.** Keine E-Mail. Kein Telefon. Kein Passwort. Die häufigsten Bot-Onboarding-Vektoren — geleakte E-Mail-Listen, SIM-Farmen, Credential-Stuffing — funktionieren auf RENEX nicht. Du kannst keine Accounts en masse per Skript registrieren.
- **Cloudflare Turnstile** auf jeden Signup-Versuch. Datenschutzkonform (keine Tracking-Cookies), eine kryptographische Challenge, die Browser-State-Proof-of-Work verlangt.

**An der Oberfläche (Community-Beitritt):**

- **Turnstile erneut** bei jeder Server-Erstellung und jedem Invite-Beitritt. Discord lässt jeden mit einem HTTP-Client 100 Server in 60 Sekunden beitreten. Wir nicht.
- **Per-Action-Rate-Limits** auf jedem sensiblen Endpunkt. Ein Bot, der Invite-Tokens brute-forced, Channels massenhaft erstellt oder Rollen-Zuweisungen flutet, läuft schnell gegen die Wand.

**In der Struktur (Architektur-Entscheidungen):**

- **Keine Webhooks. Keine Bot-APIs. Kein „Developer-Portal" für autonome Agenten.** RENEX hat keine Integration-Layer, in die KI-Systeme andocken könnten. Null. Das ist nicht „wir haben's noch nicht gebaut". Das ist „wir werden's nicht bauen".
- **Keine KI-gestützten Server-Features.** Keine Sentiment-Analyse. Keine Konversations-Zusammenfassungen. Keine automatische ML-Moderation. Keine Nudges, keine Vorschläge, keine „Hier ist, worüber Leute heute reden"-Feeds.

**Für die Moderation (Community-Verteidigung):**

- **Server-Level-Bans** mit optionalen Gründen. **Audit-Logs** für jeden Kick, jede Rollen-Änderung, jede Permission-Anpassung, jeden Ban, jeden Unban. Community-Mods sehen, was passiert ist, und können sich gegenseitig zur Verantwortung ziehen.
- **Per-Channel-Permission-Overrides.** Ein Mod kann einen Channel in Sekunden auf bestimmte Rollen oder Mitglieder einschränken. Keine Bot-Armee kann einen Channel spammen, den sie nicht sehen kann.
- **Keine anonymen Massen-Reports.** RENEX wird einen koordinierten KI-Schwarm nicht erlauben, einen Menschen ins Vergessen zu melden. Reports sind an Accounts gebunden und werden einzeln geprüft.

**Was wir nicht versprechen:**

Wir versprechen keine 100% KI-freie Kommunikation. Können wir nicht. Neue Jailbreaks erscheinen wöchentlich. Voice-Cloning ist mittlerweile eine Desktop-Anwendung. Wir werden einige Schlachten verlieren.

Was wir versprechen, ist: wir kämpfen weiter. Jede zusätzliche Schicht — jedes Captcha, jedes Rate-Limit, jede „Das bauen wir einfach nicht"-Entscheidung — wird in diesem Manifest, in unserem Changelog und in unserem Code dokumentiert.

Wenn du einen Weg findest, mit dem Menschen andere Menschen verifizieren können, ohne deren Privatsphäre zu verletzen: **sag's uns**. Wir shippen es.

Bis dahin: das ist ein ewiger Wettkampf. Wir haben unsere Seite gewählt.

---

## Was wir zugeben

Wir lügen nicht. Vier ehrliche Punkte:

### 1. Cloudflare-Lock-in (heute)

Der Reference-Server läuft auf Cloudflare Workers, D1, KV, R2, Durable Objects. Das ist **Lock-in für die Reference-Implementierung**, nicht für das Protokoll. Jeder kann einen RENEX-kompatiblen Server auf eigener Infra bauen — die Spec schreibt nicht vor, wo sie läuft.

Wenn Cloudflare uns morgen droppt: das Protokoll überlebt. User-Daten sind E2E-verschlüsselt und portierbar.

### 2. WebAuthn-Coverage

Passkey-only ist vision-konsistent, aber WebAuthn ist 2026 nicht überall schmerzfrei. Cross-Device-Passkeys via Bluetooth/QR sind manchmal wackelig, manche Browser haben raue Kanten. Wir akzeptieren das, weil die Alternative (E-Mail-Auth) den Brand-Kern komplett bricht.

### 3. Anti-KI ist Best-Effort

Siehe „Wie wir uns wehren (transparent)" oben für die aktiven Verteidigungen, die wir shippen. Diese Admission betont die Limitierung: selbst mit diesen Verteidigungen können wir nicht Null-KI auf der Plattform garantieren. Neue Techniken erscheinen schneller, als wir Counter-Mechanismen shippen. Wir tun nicht so.

Die AGB sind explizit. Wer trotzdem KI auf RENEX laufen lässt, wird gesperrt — ohne Vorwarnung. Das ist Policy, keine Detektion. Wir kriegen die, die wir kriegen. Wir kriegen nicht alle.

### 4. Metadaten sind heute server-seitig sichtbar

Der Inhalt ist sicher: Nachrichten und Anrufe sind E2E-verschlüsselt, der Server kann sie nicht lesen. Aber die *Metadaten* — wer wann mit wem, Gruppen-Mitgliedschaften, der Kontaktgraph — sind heute server-seitig in D1 sichtbar. Unser eigenes [`THREAT_MODEL.md`](./THREAT_MODEL.md) bewertet das ehrlich; wir tun nicht so, als wäre es anders, und wir sind hier schwächer als Signals Sealed-Sender-Modell.

Das ist die nächste Front, kein gelöstes Problem. Auf der Roadmap: **Sealed-Sender** (der Server erfährt nicht mehr, wer was gesendet hat), **Delete-after-Delivery** für Nachrichten-Envelopes und **client-seitig verschlüsselte Kontaktlisten**. Bis das ausgeliefert ist: nimm an, dass der Server Metadaten korrelieren kann. Das sagen wir dir lieber, als eine Garantie zu vermarkten, die wir nicht halten können.

---

## Was RENEX ist, was es nicht ist

| RENEX **ist**… | RENEX ist **nicht**… |
|---|---|
| Ein Messenger | Ein Social Network mit Feed |
| Open Source | Eine Krypto/Web3-Wallet |
| Schweizer Hosting | Eine anonyme Plattform |
| Community-finanziert (heute) | VC-finanziert |
| Brand-aligned mit Privacy-first | Ein Discord-Clone |
| Eine Gegenbewegung | Eine Compliance-Suite |

---

## An Verbündete

Wir suchen Menschen, die:

- **Code beitragen** — Frontend (Svelte), Backend (Workers/JS), Spec-Reviews. Siehe [`CONTRIBUTING.md`](./CONTRIBUTING.md).
- **Specs lesen und hinterfragen** — wenn unsere Decision-Logs falsch sind, sagt's.
- **Streamen, schreiben, das Wort verbreiten** — RENEX wächst durch Mundpropaganda, nicht Ad-Spend.
- **Auf eigener Infra hosten** — Federation-Spec ist Roadmap, aber Standalone-Server sind heute möglich.
- **Geld geben** — GitHub Sponsors, Founder's Pass ($25 Lifetime Pro, gedeckelt auf die ersten 1000), später Pro-Subscription.

Nicht für:

- Wer einen Bot bauen will. Spar dir die Zeit.
- Wer denkt „schnelles Wachstum via Dark Patterns" ist okay.
- Wer denkt, KI-Companions sind die nächste grosse Sache und Messenger müssen folgen.
- Wer Discord als Vorbild sieht.

---

## An die andere Seite

An die Bot-Operatoren, KI-Spam-Netzwerke, Growth-Hacker, die früher oder später versuchen werden, RENEX zu unterwandern:

Wir sehen euch. Wir bauen die Plattform so, dass ihr nicht reinkommt. Wenn ihr's doch schafft: wir sperren euch sofort, ohne Anhörung, ohne Einspruch. Es gibt kein „war ein Versehen". Es gibt kein „wir kennen euch ja gar nicht".

Wir ziehen klare Linien — gegen Bot-Operatoren und Spam-Netzwerke, nicht gegen Menschen. Das ist kein Hass, das ist Hygiene.

---

## An die Zukunft

In fünf Jahren wird die Frage nicht mehr sein, ob ein Messenger E2E-verschlüsselt ist — das wird Standard sein. Die Frage wird sein, ob er **menschlich** ist. Ob du sicher sein kannst, dass auf der anderen Seite kein Modell sitzt.

RENEX ist die Antwort darauf.

Wir bauen das, weil sonst niemand. Wenn in fünf Jahren als selbstverständlich gilt, was wir hier machen: gut. Dann haben wir gewonnen.

---

**Made in Switzerland. Made for humans. Made to last.**

> Wenn du dem zustimmst: [`CONTRIBUTING.md`](./CONTRIBUTING.md). Bau mit uns.
> Wenn du widersprichst: schreib uns, mit Argumenten. Wir lesen.
> Wenn dir das egal ist: dann ist RENEX vielleicht nichts für dich. Auch okay.

---

## Anhang A: Skeptiker-FAQ

Zehn Fragen, die zuverlässig kommen — von skeptischen Investoren, Hacker-News-Kommentatoren, Redditern, Journalisten. Wir beantworten sie hier einmal schriftlich. Wenn man dich fragt: verlink hierhin.

Diese Antworten sind bewusst ehrlich, nicht marketing-poliert. Wir benennen die Grenzen unserer eigenen Versprechen, weil sonst jemand anderes das tut — weniger fair.

### 1. Warum nicht einfach Discord + Passkeys?

Discord hat Passkeys — als zweiten Faktor, nicht als primäre Auth. E-Mail und Telefon bleiben Pflicht. Sie können das nicht aufgeben: E-Mail ist ihr Recovery-, Marketing- und Compliance-Anker.

Ernsthafter: Discord **ist** eine Bot-Plattform. Ein erheblicher Teil ihres Developer-Ökosystems sind Bots. Ein „AI-Free Discord" würde ihr eigenes Geschäftsmodell killen. Selbst wenn sie morgen einen Passkey-only-Modus ankündigten — niemand würde es glauben. Und DMs sind weiterhin nicht E2E-verschlüsselt.

Wir können das Versprechen halten, weil wir nichts zu schützen haben außer dem Versprechen.

### 2. Wie verhindert ihr Sybil-Attacken?

Nicht vollständig. Niemand kann das. Wir erhöhen die **Kosten pro Fake-Identität**:

- **Turnstile-Captcha bei jedem Signup, jeder Server-Erstellung, jedem Invite-Beitritt.** Seit 2026-06-01 live. ~$0.001/solve als Baseline, aber kompoundierend über drei Gates, die ein Bot überwinden muss.
- **Passkey-Registrierung** → echtes Gerät + biometrisches Setup, ~5 Min menschliche Arbeit pro Account. Lässt sich nicht ohne tausende physische Geräte batch-automatisieren.
- **Per-Endpoint-Rate-Limits + Audit-Logs** → Bot-Farmen können Operationen nicht leise skalieren. Jede Massen-Aktion hinterlässt Spuren.
- **Hardware-Attestation (Roadmap Phase 9)** → Bypass kostet ~$200/Gerät, bringt Account-Kosten in etwa auf das Niveau einer Discord-Nitro-Jahres-Subscription. Ab dem Punkt: warum uns bot-spammen?

Realistisch: Account-Kosten gehen von ~$0 (E-Mail-Signup anderswo) auf ~$5–50 heute, mit Phase 9 in Richtung ~$200. Das macht Spam ökonomisch unattraktiv. Genug für eine Community-Plattform.

„Sybil-resistant" wäre eine Lüge. „Sybil-teuer" ist die Wahrheit.

### 3. Wie beweist ihr „menschlich"?

Wir nicht. Wir machen Automatisierung teuer.

- **Architektonisch:** keine öffentliche API, keine Webhooks, keine Bot-Tokens. RENEX ist nicht skriptbar ohne Reverse-Engineering plus Captcha-Farm.
- **Technisch:** Passkey + Hardware-Attestation (Phase 9) + Turnstile auf drei Gates + Rate-Limits → hohe Setup-Kosten pro Fake.
- **Sozial:** explizite AGB, sofortige Sperre, Audit-Log-Accountability für Moderatoren.
- **Erlebnis (ab Phase 6.5):** Pulse. Eine ambient Presence-Layer, die den Menschen auf der anderen Seite sichtbar macht — durch Mikro-Bewegung, Tipp-Energie, Device-Shake. Keine Authentifizierung. Eine *Belief-Layer*. Bots haben keinen Pulse. Siehe [`PULSE.md`](./PULSE.md).

Wir beweisen Menschsein nicht — wir machen Automatisierung unwirtschaftlich und menschliche Präsenz sensorisch wahrnehmbar. Das ist intellektuell ehrlich. Jede stärkere Aussage wäre Marketing, und Marketing-Versprechen brechen vor Gericht und auf Reddit.

### 4. Warum würden Communities von Discord wechseln?

Die meisten werden's nicht. Das ist die Wahrheit über Netzwerk-Effekte.

Was wir verkaufen, ist nicht „wechseln", sondern **„zweites Zuhause"**:

- Privacy-bewusste Inner-Circles innerhalb grösserer Discord-Communities
- Indie-Dev-Communities, die Bot-Spam satthaben
- Clans, die einen sauberen Neustart nach einem Datenleck oder Discord-Policy-Drama wollen

User bleiben auf Discord für ihre Hauptcommunity und nutzen RENEX für die Kerngruppe daneben. Wir ersetzen Discord nicht — wir ersetzen die WhatsApp-Gruppe, die sowieso parallel läuft.

Niche-first. Plane sechs bis zwölf Monate Netzwerk-Effekte ein. Wer in diesem Markt schneller wächst, wächst meist mit Bots.

### 5. Was ist euer unfairer Vorteil?

Zwei echte Moats, zwei kleinere Hebel:

1. **„AI-Free" als Brand-Moat.** Discord, Slack, Telegram können das nicht imitieren, ohne ihr Bot- und Developer-Geschäft zu killen. Ein „AI-Free-Modus" bei jedem Incumbent wäre unglaubwürdig. Glaubwürdigkeit ist nicht imitierbar, wenn man zu viel zu verlieren hat.
2. **Schweizer Jurisdiktion, abgesichert durch E2E.** Der Schweizer DSG-Standard deckt die wenigen Metadaten, die wir halten — ein echter rechtlicher Vorteil gegenüber US-Plattformen, nicht nur Standort-Marketing. Wir verkaufen es nicht zu hoch: Der Reference-Server läuft heute auf Cloudflare (US-Unternehmen, vom CLOUD Act erreichbar), Jurisdiktion allein ist also kein Schutzschild. Der echte Schutz: wir haben nichts Brauchbares herauszugeben — Kontakte, Nachrichten und Schlüssel sind E2E-verschlüsselt und erreichen uns nie im Klartext.
3. Offener Standard + AGPL-Server → schützt vor Hyperscaler-fork-and-hide.
4. Solo-Dev + Bootstrap → schnelle Iteration, kein Investor-Druck, prinzipientreu statt Sellout.

Der schwere Moat ist #1.

### 6. Wie onboardet ihr User ohne Friction?

Nicht friction-frei. Friction-arm.

- **Kein App-Download** — PWA, ein Klick „zum Homebildschirm hinzufügen".
- **Keine E-Mail, kein SMS, keine Verifizierung** — Handle-only Identität.
- **Login via Passkey** — 1 Klick auf bekanntem Gerät, QR-Scan auf neuem.
- **Recovery-Phrase ist Schritt 2, nicht Schritt 1.** Angeboten beim ersten Login, nicht erzwungen.
- **Aggressives Install-Tutorial mit GIF/Video**, weil iOS-PWA-Push einen manuellen Schritt braucht.

Wo's bricht: Safari/iOS Passkey-UX ist 2026 noch nicht perfekt. User ohne Touch-ID/Face-ID-Geräte verlieren wir — das ist der Preis des Versprechens.

30 Sekunden Passkey-Setup gegen Null Spam und Null Datenleck: fairer Tausch.

### 7. Wie verhindert ihr den Wachstums-Tod durch zu starke Security?

Wir akzeptieren, dass Security-first ein Wachstums-Filter ist. Wir kompensieren an vier Stellen:

1. **Security als Empowerment, nicht Last.** „DU BIST DER SCHLÜSSEL" verkauft Kontrolle, nicht Paranoia.
2. **Friction nur wo nötig.** Login ist 1 Klick. E2E läuft unsichtbar. Verify-Contact ist TOFU + Auto-Toast (Apple-Style), nicht Modal-Hölle.
3. **UX-Qualität > Security-Theater.** Performance, Latenz, Voice später — Gamer-first. Wer RENEX startet, soll merken, dass es schneller ist, nicht paranoider.
4. **Realistische Wachstums-Erwartung.** Jahr-1-Ziel: 5'000 aktive User. Nicht 5 Millionen. Wir planen für Slow-Path und Scarcity-Hype (Founder's Pass), nicht für Mass-Push.

Der ehrlich harte Fall: wenn ein User Recovery-Phrase **und** alle Geräte verliert, ist das Konto weg. Steht in den AGB. Wird im UI gewarnt. Das ist Architektur, kein Bug. Wer das nicht akzeptiert, ist nicht unsere Zielgruppe.

### 8. Warum nicht Matrix/Element, Session oder SimpleX?

Drei gute Projekte mit ähnlichem Ethos, drei verschiedene Trade-offs:

- **Matrix/Element:** Federation ist Stärke und Last zugleich. Onboarding ist hart für Non-Techies („wähle einen Homeserver" ist nicht, was 95% der User wollen). E2E hat sich verbessert, ist aber nicht überall by-default aktiv. Wir haben uns für ein Single-Server-Modell mit offener Spec entschieden — ein Onboarding-Schritt weniger, Federation als Roadmap-Option für v3+.

- **Session:** Anonym by-design (kein Account, kein Identifier außer Onion-ID). Stark für Whistleblower, schwach für persistente Communities. Wir bauen für stabile Identitäten + Clans + Wiedererkennung — Passkey statt Anonymität.

- **SimpleX:** Per-Kontakt-Queues, kein User-Identifier — sehr starkes Privacy-Modell. Trade-off: Discovery ist schwer (man muss für jeden Kontakt Links/QR-Codes austauschen). Wir haben Handle-basierte Identität mit E2E gewählt — etwas weniger paranoid, dramatisch bessere UX für Gruppen.

Wir respektieren alle drei. RENEX ist nicht für Whistleblower (nimm Session), nicht für Federation-Enthusiasten (nimm Matrix), nicht für Maximum-paranoide Akteure (nimm SimpleX). RENEX ist für die Lücke dazwischen: **Communities, die WhatsApp/Discord-Convenience wollen, aber ohne Bots, ohne E-Mail-Zwang, ohne Meta, das mitliest.**

### 9. Ist Passkey-only nicht Apple/Google-Lock-in?

Das ist die häufigste Sorge — und sie ist halb berechtigt.

**Was stimmt:** Passkeys auf vielen Geräten syncen via iCloud Keychain oder Google Password Manager. Wer ausschliesslich Apple- oder Android-Geräte nutzt, ist indirekt an deren Cloud-Sync gebunden.

**Was wir dagegen tun:**

- **Hardware Security Keys werden voll unterstützt.** YubiKey, SoloKey, Nitrokey — keine Cloud, kein Vendor-Sync.
- **Bitwarden / 1Password / KeePassXC** unterstützen jetzt Passkey-Storage out-of-the-box. Wer einen self-hosted Password-Manager betreibt, bleibt unabhängig.
- **Recovery-Phrase ist das Master-Override.** Sind alle Geräte weg und du hast keinen Apple/Google-Sync: eine 12-Wort-BIP39-Phrase reaktiviert das Konto. Du bist nie an einen einzelnen Vendor gebunden.

In der Praxis: RENEX funktioniert ohne Apple-ID, ohne Google-Account, ohne Vendor-Cloud. Aber wir lügen nicht — der einfachste Pfad nutzt Platform-Sync, weil das die UX ist, die User kennen. Wer das nicht will, hat alle Alternativen offen.

### 10. Wie kann ich Web-Distribution trauen? Reproducible Builds?

Ehrliche Antwort: mit einer PWA vom Browser kannst du dem Server **nicht vollständig** trauen. Cloudflare Pages liefert das Frontend-Bundle aus — theoretisch könnte ein kompromittiertes Deployment dir einen modifizierten Client mit Backdoor schicken, der die Crypto lokal schwächt.

**Was wir dagegen tun:**

- **Open-Source-Frontend** (MIT/Apache-2.0). Bundle ist reproduzierbar aus dem Repo via `npm install && npm run build` — Output-Hash kann mit Live-Bundle verglichen werden.
- **CI-Build mit Hash-Publikation** (geplant post-Launch). Jedes Release-Tag erzeugt ein deterministisches Bundle, dessen SHA-256 wir publizieren. Extern auditierbar.
- **Server kann nichts entschlüsseln.** Selbst mit Frontend-Backdoor: CMKs, GSKs, Recovery-Phrase verlassen das Gerät niemals unverschlüsselt. Eine Backdoor müsste lokale IndexedDB exfiltrieren — schwerer und im Browser-Network-Tab sichtbar.
- **Roadmap:** Native Apps (Capacitor/Tauri) für User, die reproducible Binaries gegen eine Hash-Liste verifizieren wollen.

Wer maximale Crypto-Purität will: warte auf native Builds oder bau selbst aus dem Repo. Der PWA-Pfad ist der Convenience-Trade-off, nicht das Security-Maximum.

---

> Diese FAQ ist ein Living Document. Wenn eine Frage hier nicht ehrlich beantwortet ist: schreib uns, mit Argumenten. Wir updaten.
