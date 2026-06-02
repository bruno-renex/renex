# RENEX — Pulse (Phase 6.5)

**Status:** Living document
**Version:** 0.1 (Draft für MVP-Scope)
**Letzte Aktualisierung:** 2026-06-02
**Autor:** Bruno Hochstrasser
**Phase:** 6.5 — Presence Layer (eingeschoben zwischen Phase 6 Brand-Prep und Phase 7 Beta-Launch)
**Vorbedingung:** Phase 3A.5 ✅, Phase 5-Light ✅, Phase 6 in Arbeit (Stripe + AGB + Manifesto)

---

## 1. Was ist Pulse?

Pulse ist eine **ambient sensorische Schicht** über dem 1:1-Chat in RENEX. Sie übersetzt Mikro-Bewegungen des Users (Maus, Touch, Acceleromter, Tippgeschwindigkeit) in eine abstrakte „Lebensenergie" (`pulse`, Skalar `0.0–1.0`), die als Partikel-Visualisierung im Chat-Fenster gerendert wird — sowohl beim Sender als auch beim Empfänger.

**In einem Satz:** „Wenn du mit jemandem chattest, siehst du dass er fühlt. Bots haben keinen Pulse."

Pulse ist **kein Captcha-Ersatz** (Anti-Bot-Gate). Pulse ist eine **Belief-Layer**: der User glaubt stärker daran, dass sein Gegenüber ein Mensch ist, weil er es spürt. Bots können Pulse zwar faken, aber der Akt des Fakens ist so spezialisiert (jeder Bot bräuchte ein realistisches Movement-Modell), dass Spam-Bot-Operationen wirtschaftlich aufgeben.

---

## 2. Goals & Non-Goals

### 2.1 Goals (was Pulse leisten soll)

- **Sensorische Präsenz:** Text-Chat fühlt sich nicht mehr emotional kalt an. Du siehst gegenüber atmen.
- **Brand-Defining Anti-AI-Erfahrung:** RENEX's „For Humans. By Humans." wird von Slogan zu fühlbarer Erfahrung. Niemand sonst macht das.
- **Marketing-fähig:** Visuals sind inherently shareable (TikTok, Twitter-Demo-Clips, HN-Launch-GIF).
- **Privacy-konform:** Keine Raw-Daten leaken. Keine biometrischen Streams cross-user. Vollständig E2E-kompatibel.
- **Beta-Launch-fähig:** MVP in 1 Woche shippbar.

### 2.2 Non-Goals (explizit, damit Scope nicht implodiert)

- **❌ Kein Anti-Bot-Captcha-Gate.** Pulse blockt keinen Pfad. Wer keinen Pulse hat, kann trotzdem chatten.
- **❌ Keine Bot-Detection-Klassifizierung.** „Niedriger Pulse = wahrscheinlich Bot" ist verboten (Accessibility, siehe §8.3).
- **❌ Keine Pulse-Historie.** Energie-Streams werden NIE persistiert (Privacy-Constraint §8.1).
- **❌ Keine Group-Channel-Pulse-Sync** im MVP. Nur 1:1-DMs. Group-Pulse kommt in Phase 8 zusammen mit Voice-Channel-Roll-Out.
- **❌ Keine Sound-Komponente** im MVP. Audio-Feedback ist evaluiert (siehe §8.5) und für Phase 8 deferred.
- **❌ Keine native App.** PWA-only.
- **❌ Keine ML-Modelle.** Pulse-Engine ist rein algorithmisch (Smoothing, Decay, Peak-Detection). Keine TensorFlow.js, kein Inference. Latenz + Privacy.

---

## 3. User-Story

> Anna öffnet RENEX am iPhone, geht in den Chat mit Bruno. Sie sieht im Hintergrund der Conversation-View **subtile graue Partikel** die langsam driften (Bruno's aktuelle Pulse — ruhig, er liest gerade ihre letzte Nachricht). Anna tippt eine Antwort, schnell und mit ein paar Backspaces — links unten **wachsen warme Partikel** in ihrem eigenen Bereich (ihr eigener Pulse, etwas erhöht). Sie sendet die Message ab, bewegt das iPhone in Vorfreude, **Schaum-Mode** dauert eine halbe Sekunde an.
>
> Am Desktop sieht Bruno wie Annas Partikel-Stream sich verändert — kurz vor ihrer Message-Send-Aktion gab es einen Energy-Peak. Er weiß: sie ist da, sie schreibt, sie ist gerade engaged. Das ist kein „Tipping…" Indikator von 2008. Das ist ein 2026er Presence-Layer.
>
> Wenn Anna 30 Sekunden inaktiv ist, fadet ihr Stream langsam aus (Decay). Wenn Bruno die App in den Hintergrund legt, pausiert seine Pulse-Capture (Battery-Save). Beide haben einen unsichtbaren Opt-In-Toggle, beide haben die Permission-Frage für DeviceMotion einmal beim Onboarding gesehen.

---

## 4. Datenmodell

### 4.1 Energy Engine (Client-side State)

Die Engine ist eine **pure Function** + lokaler State, kein Backend-Aufruf:

```typescript
type PulseState = {
  energy:      number;        // 0.0–1.0, der aktuelle Pulse-Wert
  velocity:    number;        // Änderungsrate (für Smoothing)
  lastUpdate:  number;        // ts (ms)
  mode:        'calm' | 'active' | 'excited' | 'foam';
};

type PulseInput = {
  type:   'mouse_velocity' | 'touch_velocity' | 'accel_magnitude' | 'typing_rate' | 'scroll_speed';
  value:  number;             // Roh-Wert, gerätspezifisch
  ts:     number;             // ms
};
```

### 4.2 Energy Signal (was über die Leitung geht)

**KRITISCH:** Über das WebSocket geht NUR der abstrahierte Skalar, NIEMALS Roh-Inputs.

```typescript
// Was rüber geht (über existierenden WS-Channel, E2E-encrypted via Session-CMK):
{
  type:     'pulse',
  to:       '<peer_handle>',
  energy:   0.73,             // gerundet auf 2 Dezimalstellen
  mode:     'active',
  ts:       1717398400123
}
```

Frequenz: **max 10 Frames/Sekunde** (alle 100ms). Default 5/Sekunde wenn `energy` stabil. Adaptive Throttling.

**NICHT übertragen werden:**
- Keystroke-Timing-Arrays
- Mouse-Coordinate-Streams
- Accelerometer-Raw-Werte
- Touch-Pressure-Daten

Begründung in §8.

### 4.3 Visualization Layer (Rendering)

Engine steuert ein Canvas-2D-Partikel-System (kein WebGL-Overkill für MVP):

```typescript
type ParticleConfig = {
  count:        number;       // 5–80 abhängig vom Mode
  baseRadius:   number;       // 2–8 px
  velocityCap:  number;       // px/frame
  color:        string;       // HSL: hue=temperature, lightness=energy
  opacity:      number;       // 0.1–0.7
  turbulence:   number;       // perlin-noise-Amplitude
  decayRate:    number;       // Wie schnell alte Partikel fade-outen
};
```

**Visualisierung pro Mode:**

| Mode | Range | Particles | Vibe |
|---|---|---|---|
| **calm** | 0.0–0.25 | 5–15, langsam, niedrige Sättigung | „Person liest" |
| **active** | 0.25–0.6 | 15–35, mittlere Bewegung | „Person tippt entspannt" |
| **excited** | 0.6–0.85 | 35–60, schnelle Bewegung, leichte Verfärbung | „Person ist engaged" |
| **foam** | 0.85–1.0 | 60–80, chaotisch, Cluster-Bildung, kurzlebig | „Person schüttelt Handy / explosive Reaktion" |

Foam-Mode hat Auto-Decay innerhalb 800ms (Schaum bleibt nicht).

---

## 5. Input Sources

### 5.1 Desktop-Inputs

Alle als passive Event-Listener auf `window`, gedrosselt via `requestAnimationFrame`:

| Source | Detail | Energy-Contribution |
|---|---|---|
| `mousemove` | Δx/Δy pro Frame | √(Δx² + Δy²) / 100 |
| `wheel` | scroll-velocity | |deltaY| / 200 |
| `keydown` auf Chat-Input | typing-rate (Events/Sekunde, Sliding-Window 500ms) | rate / 10 |
| Backspace-Frequency | als emotional-marker | +0.05 pro Backspace, decay 200ms |
| `drag` über Chat | (drag&drop von Bildern) | drag-Δ pro Frame |

### 5.2 Mobile-Inputs (iOS PWA + Android PWA)

Hier muss man iOS-Permission-Realität ernst nehmen:

| Source | API | iOS-Permission? |
|---|---|---|
| `touchmove` (auf Chat-Surface) | Native TouchEvent | Nein |
| Acceleromter | `DeviceMotionEvent.acceleration` | **JA** (iOS 13+ `DeviceMotionEvent.requestPermission()`) |
| Orientation | `DeviceOrientationEvent` | **JA** (iOS 13+, gleicher Call) |
| Typing-Rate | `input` events | Nein |

**iOS-Permission-UX:**
- Permission wird **per Chat opt-in** angefordert, nicht beim ersten App-Start
- Frage: „Pulse für diesen Chat aktivieren? RENEX nutzt Bewegung, um deine Anwesenheit zu signalisieren — vollständig auf deinem Gerät, nichts wird gespeichert."
- Wenn User ablehnt: Pulse-Feature ist disabled für diesen Chat, aber Chat funktioniert normal. Kein Nag.
- Persisted in `localStorage` per `peer:<handle>:pulse_optin`, kein KV-Sync.

### 5.3 Normalization Layer

Inputs sind gerätspezifisch. Engine normalisiert via:

```
1. Raw-Input → Float
2. Exponential Moving Average (EMA), α=0.15
3. Peak-Detection (für Acceleromter-Schütteln → Foam)
4. Saturation (clamp auf 0–1)
5. Auto-Decay (0.05/Sekunde) wenn keine neuen Inputs
```

**Result:** ein Stream `{ energy: 0.0–1.0, mode: string }` der gerätagnostic ist.

---

## 6. State Machine — Emotion States

Mode-Transitions sind hystereseartig (kein Flickering):

```
calm    → active   wenn energy > 0.30 für mindestens 200ms
active  → excited  wenn energy > 0.65 für mindestens 150ms
excited → foam     wenn peak-energy > 0.90 (Spike)
foam    → excited  nach 800ms Cooldown
excited → active   wenn energy < 0.55 für 500ms
active  → calm     wenn energy < 0.20 für 1000ms
```

Foam ist **bewusst kurzlebig**. Niemand will dauerhaft Schaum sehen.

---

## 7. Cross-Device Sync (1:1 only im MVP)

### 7.1 Transport

Über existierende WebSocket-Verbindung. Neue Message-Type `pulse`:

```json
{
  "type": "pulse",
  "to":   "anna21",
  "energy": 0.73,
  "mode": "active",
  "ts":   1717398400123
}
```

Frequenz: 10Hz max, default 5Hz, adaptive Throttling.

### 7.2 E2E-Encryption

Pulse-Messages durchlaufen die **gleiche E2E-Pipeline wie Chat-Messages**:

- 1:1-DM: encrypted via Session-CMK (existing infrastructure)
- Backend (Worker + DO) sieht NUR `{ to, ciphertext }`, nicht den Pulse-Wert
- Frame-Format identisch zu existing `/chat/send` payload

**Spec-Compliance:** Pulse fügt KEINE neuen unverschlüsselten WS-Frame-Types hinzu. PROTOCOL.md §3.4 bleibt valid.

### 7.3 Receiver-Side Smoothing

Da der Stream Drops verkraften muss:

```typescript
// Receiver interpoliert zwischen Updates
const targetEnergy = msg.energy;
const interpolated = lerp(currentEnergy, targetEnergy, deltaTime / 100);
```

Bei Stream-Drop > 2s: Receiver fadet Peer-Pulse aus (Decay-Rate 0.1/s).

### 7.4 Rate-Limiting

Backend-WS-Layer enforces:
- Max 15 Pulse-Frames pro Sekunde pro Sender-Peer (anti-DoS)
- Bei Überschreitung: Throttle silent, kein Disconnect

Existing RL-Buckets in `serverRoutes.js` haben kein passendes Pattern. Neues Bucket: `pulseSync: { window: 1_000, max: 15 }` in `chatRoutes.js` (wo Pulse-Frames durch das normale send-Pipeline laufen).

---

## 8. Privacy & Threat Model

### 8.1 Privacy Constraints (HARD)

| Constraint | Mitigation |
|---|---|
| Kein Raw-Input über die Leitung | NUR `{ energy: float, mode: enum }` |
| Keine Persistenz auf Server | Pulse-Messages NIE in messages-D1-Tabelle eingefügt; transient WS-only |
| Keine Persistenz im Client | LocalStorage nur Opt-In-Flag + EMA-State (auch das wird beim Logout gewiped) |
| Keine Analytics | Sentry-Capture: nur Errors aus Pulse-Engine, NIE Energy-Werte |
| E2E-encrypted im Transit | Via Session-CMK pipeline |
| Battery-DoS-Resistant | Sender-side rate-cap (max 10Hz output), Receiver-side rate-cap (max 15Hz accept) |

### 8.2 Threat Model — neue Adversaries

Ergänzung zu THREAT_MODEL.md v0.1:

| Adversary | Capability | Risk | Defense |
|---|---|---|---|
| **Pulse-Keystroke-Profiler** | Versucht aus Pulse-Streams Keystroke-Dynamics zu rekonstruieren | LOW | Pulse-Stream ist nur Skalar-Aggregat, EMA-geglättet, keine Timing-Auflösung |
| **Pulse-Battery-DoS** | Peer schickt 1000 Pulse-Frames/s um Receiver-Akku zu drainen | LOW | Receiver-side Rate-Cap auf 15Hz, Backend-Throttle |
| **Replay-Adversary** | Re-sendet abgefangene Pulse-Frames um „Anwesenheit" zu faken | NEGLIGIBLE | Pulse hat keinen Authority-Status (kein Login, keine Aktion) — Replay nutzlos |
| **Pulse-Fingerprinting** | Versucht User über Pulse-Patterns zu re-identifizieren cross-session | MEDIUM | Mitigation: Per-Session-Reset des EMA-State, niemand kann long-term-pattern aufbauen |
| **Bot-Pulse-Fake** | Bot generiert plausible Pulse-Patterns um „Mensch" vorzutäuschen | EXPECTED | Pulse ist NIE Authority. Existing Anti-Bot (Turnstile, Rate-Limits, Passkey) ist Authority. Pulse ist Belief-Layer, kein Gate. |

### 8.3 Accessibility — kritisches Constraint

Pulse darf NIE als Authority für „ist da ein Mensch?" interpretiert werden.

**Why:** Users mit motor-eingeschränkten Eingaben (Parkinson, ALS, Switch-Control, Voice-Input) haben naturgemäß niedrige oder atypische Pulse-Patterns. Sie als „weniger menschlich" zu markieren wäre discriminatory UX und juristisch problematisch (EU-Accessibility-Act, ADA).

**Hard rules:**
- Pulse-Abwesenheit ⇒ neutral Status („Pulse not shared"), niemals „verdächtig"
- Kein „Verified Human"-Badge basierend auf Pulse-Intensität
- Bei Pulse-Disabled bleibt UI identisch funktional, nur ohne Partikel

### 8.4 Battery-Reality

Für mobile Users der größte Schmerzpunkt:

**Worst-Case-Szenario (Voll-Aktiv, Pulse an, Chat 1h offen):**
- Acceleromter @ 10Hz = ~0.3% Akku/h
- WebSocket-Frames 10Hz = ~3KB/s = 10MB/h
- Canvas-Rendering 30fps = ~2% Akku/h
- **Total: ~2.5% Akku/h aktive Nutzung**

**Mitigations (alle Default-On):**
- `document.hidden` ⇒ Pulse-Capture pausiert sofort
- App im Background (PWA `visibilitychange`) ⇒ Sync gestoppt
- `prefers-reduced-motion` ⇒ Particle-Count automatisch /3, fallback auf statisches Mood-Indicator
- Battery-Status-API: wenn Akku < 20% ⇒ Pulse Frame-Rate auf 2Hz reduziert + Warning-Toast

### 8.5 Sound — explizit deferred zu Phase 8

Sound-Feedback wäre brutal differenziell, aber:
- Permission-Dialog (NotificationsAPI bzw. AudioContext.resume()) ist UX-Reibung
- Mobile-Browser haben restrictive AutoPlay-Policies
- Accessibility: sounds müssen muted-by-default sein
- Scope-Explosion: braucht eigenes Audio-Asset-System

**Decision:** Sound ist Phase 8, nicht MVP. Spec-Stub bleibt in §15 Decision Log.

---

## 9. UX-Constraints

### 9.1 Opt-In Flow

Per-Chat-Toggle in Conversation-Header:

```
[ Anna21 ]                          [⚙] [📞] [✨ Pulse]
                                              ↑ Toggle
```

State-Persistence: `localStorage[`peer:anna21:pulse_optin`] = "true" | "false"`. Niemals KV-Sync.

Default für 1:1 mit accepted-Contacts: **OFF**. User muss bewusst einschalten. Begründung: Permission-Friction soll nicht jeden Chat-Start verlangsamen.

Default für 1:1 mit neuem Kontakt: **OFF**. Auch hier opt-in.

### 9.2 First-Time-iOS-Permission-Modal

Beim ersten Pulse-Aktivieren auf iOS:

```
┌──────────────────────────────────────────┐
│ ✨ Pulse aktivieren                      │
│                                          │
│ RENEX nutzt subtile Bewegung deines      │
│ Geräts, um deine Anwesenheit für         │
│ Anna21 sichtbar zu machen.               │
│                                          │
│ ✓ Vollständig auf deinem Gerät           │
│ ✓ Nichts wird gespeichert                │
│ ✓ Nur du und Anna21 sehen es             │
│                                          │
│ iOS fragt im nächsten Schritt nach       │
│ Bewegungs-Berechtigung.                  │
│                                          │
│ [Abbrechen]              [Erlauben →]    │
└──────────────────────────────────────────┘
```

Nach Click „Erlauben": iOS-Native-Permission-Dialog wird via `DeviceMotionEvent.requestPermission()` getriggert.

### 9.3 Battery-Warning-Toast

Bei Akku < 20% UND Pulse aktiv:

```
🔋 Akku niedrig — Pulse-Frequenz reduziert
```

Nicht-blockierend, eine Sekunde sichtbar.

### 9.4 Rendering-Stile

Default-Theme: Bubbles in Akzent-Farbe (RENEX accent-voice = `#22d3ee` cyan), Opacity 30-60%.

Per-User-Customization (in Phase 8): Color-Theme-Selection (Cyan/Warm/Mint/Rose).

`prefers-reduced-motion` Fallback: statischer „Mood Indicator" — ein kleiner Kreis links/rechts der mit Energy-Level pulsiert (langsame Skala-Animation), keine Partikel.

---

## 10. API Surface

### 10.1 Neues WS-Message-Type

**Sender → Server (existing `/chat/send` payload, neue type):**

```json
{
  "type":   "pulse",
  "to":     "anna21",
  "ciphertext": "<E2E-encrypted base64>",
  "ts":     1717398400123
}
```

`ciphertext` enthält JSON-encrypted: `{ "energy": 0.73, "mode": "active" }`. Encryption via Session-CMK wie alle Chat-Messages.

**Server → Receiver (existing WS push):**

Identisches Format, durchgereicht.

### 10.2 KEINE neuen HTTP-Endpoints

Pulse ist **vollständig WS-only**. Kein REST-Surface. Kein Persistence-Tier. Begründung: transient, no value in REST-querying past Pulse-States.

### 10.3 Rate-Limit-Bucket (neu)

In `chatRoutes.js` send-pipeline:

```js
const RL = {
  ...,
  pulseSync: { window: 1_000, max: 15 },  // Phase 6.5
};
```

Bei Überschreitung: silent throttle, Backend dropt Frame ohne Error-Response (Pulse-Drop ist akzeptabel, Chat-Drop nicht).

### 10.4 Backend-Routing

Bestehender `pushToUserDO` für 1:1-DM. Pulse-Frame ist nur ein weiterer Message-Type, durch die existierende Pipeline.

**Critical:** `pushToUserDO` MUSS awaited werden (siehe feedback_cf_workers_await_subrequest.md).

---

## 11. Rendering — Implementation Notes

### 11.1 Canvas 2D vs WebGL

**Decision: Canvas 2D.**

- Pulse hat max 80 Partikel — Canvas 2D handhabt das easy auf jedem Device
- WebGL bringt Komplexität + Shader-Code + GPU-Tearing-Probleme
- Battery: Canvas 2D mit `requestAnimationFrame` ist effizienter für Sub-100-Partikel
- Falls Phase 8 group-channel-pulse mit 500+ Partikeln: dann WebGL evaluieren

### 11.2 Particle-System-Library

**Decision: kein Library, custom 200-line Particle-System.**

- p5.js (~800kb) ist Overkill
- particles.js ist veraltet (kein TS, alte API)
- Three.js ist 600kb für 2D Particles absurd
- Custom-Code ist verständlich, optimierbar, kein Lock-In

### 11.3 Performance-Targets

- 60fps auf Desktop (Chrome, Safari, Firefox)
- 30fps auf Mobile (iPhone 11+, Android 2020+)
- < 16ms pro Frame Worst-Case
- Frame-Skip wenn rAF > 33ms

### 11.4 File-Layout (vorgeschlagen)

```
frontend/src/lib/pulse/
├── engine.js           // Energy-Engine (smoothing, decay, mode-fsm)
├── inputs.js           // Event-Listener (mouse, touch, motion, typing)
├── particles.js        // Canvas-2D-Renderer
├── permission.js       // iOS DeviceMotionEvent.requestPermission flow
└── store.svelte.js     // Reaktive pulseStore (Svelte 5 runes)

frontend/src/components/
├── PulseToggle.svelte  // Toggle-Button im Chat-Header
├── PulseCanvas.svelte  // Canvas-Layer im Conversation-View
└── PulsePermissionModal.svelte  // First-Time-iOS-Permission

src/routes/chatRoutes.js (extension):
- pulse-type-handling in /chat/send (forward via pushToUserDO, no D1 write)
- RL bucket pulseSync
```

---

## 12. MVP Scope (Phase 6.5)

### 12.1 Was MVP shippt (1 Woche, ~5 Tage focused work)

**Backend (~1 Tag):**
- Neuer `pulse` message-type in `/chat/send` pipeline (no D1 persist, just WS forward)
- RL-bucket `pulseSync` 15/s
- Verschlüsselung über existing Session-CMK (kein neuer Crypto-Pfad)

**Frontend Engine (~1 Tag):**
- `lib/pulse/engine.js` — EMA, Decay, Mode-FSM
- `lib/pulse/inputs.js` — Desktop (mouse, wheel, keyboard) + Mobile (touch, motion)
- `lib/pulse/permission.js` — iOS-Permission-Flow
- `pulseStore.svelte.js`

**Frontend Rendering (~1 Tag):**
- `PulseCanvas.svelte` — Canvas-2D-Layer im Conversation-View
- 4 Modes (calm/active/excited/foam) mit Particle-Config-Presets
- `prefers-reduced-motion` fallback

**Frontend Integration (~1 Tag):**
- `PulseToggle` im Chat-Header
- `PulsePermissionModal` (iOS first-time)
- Per-Chat opt-in persistence in localStorage

**i18n + Polish + Smoke-Test (~1 Tag):**
- 12 neue Strings × 3 Sprachen
- Battery-Warning Integration
- Live-Test renex ↔ anna21 + iOS-Permission-Flow

### 12.2 Was deferred ist (NICHT im MVP)

- Group-Channel-Pulse (Phase 8)
- Voice-Channel-Pulse-Sync (Phase 8)
- Sound-Komponente (Phase 8)
- Pulse-Color-Theming (Phase 8)
- WebGL-Render-Path (eval Phase 9)
- Mood-Memory-Layer (explizit nie — Privacy)
- Pulse-Verified-Badge (verboten — Accessibility, siehe §8.3)

---

## 13. Marketing-Story (für Beta-Launch + TikTok)

### 13.1 One-Liner-Pitches

- „Wenn du mit jemandem chattest, siehst du dass er atmet."
- „Discord hat Tipp-Indikatoren von 2008. RENEX hat 2026er Presence."
- „Niemand sonst zeigt dir, dass dein Gegenüber ein Mensch ist. Wir tun es."
- „Pulse — der Anti-AI-Feature, der keinen Bot ausgrenzt, aber jeden Menschen sichtbar macht."

### 13.2 Demo-Clip-Konzepte (15s TikTok)

**Clip 1: „Sieh den Pulse"**
- Split-Screen: Person A tippt eine Nachricht slowly + traurig auf Telefon
- Andere Seite: Person B sieht subtile blaue Partikel langsam pulsieren
- Cut: Person A wird excited, tippt schnell, schüttelt Phone
- Andere Seite: Foam-Mode explodiert
- Caption: „Sieh den Pulse deines Gegenübers. Nur auf @renex_app"

**Clip 2: „Bot vs Human"**
- Split: Konsole zeigt RENEX-Chat-View
- Links: Bot-Account — flatline Pulse (statischer kleiner Kreis)
- Rechts: Human — natürliche unregelmäßige Spikes
- Caption: „RENEX zeigt dir wer atmet."

**Clip 3: „Foam Mode"**
- Person dreht Phone schnell hin und her
- Volle Foam-Explosion auf dem Bildschirm
- Caption: „Schüttel dein Phone. Dein Chat-Partner sieht's."

### 13.3 Press-Headlines

- „RENEX adds 'Pulse' — a presence layer that makes text chat feel alive"
- „The privacy messenger that lets you see your conversation partner breathing"
- „Anti-AI by design: how RENEX uses motion to prove human presence"

### 13.4 Anti-AI-Story präzise

Im Manifesto-Update (Phase 6 Deliverable):

> „We don't ask if you're human. We give you a way to show that you are.
> Pulse is RENEX's quiet refusal to let machines mediate human connection.
> Your movement, your typing, your micro-energy — translates to ambient presence on your friend's screen.
> Bots can fake words. They can't fake the way humans breathe."

---

## 14. Phase-Plan

### 14.1 Phase 6.5 — Pulse MVP

**Zeitfenster:** 2026-06-16 → 2026-06-22 (Wo 6 per accelerierter Roadmap)
**Vorbedingung:** Phase 6 (Brand-Prep + Stripe + AGB + Manifesto + Landing) durchgezogen
**Risk-Trade-off:** Falls Phase 6 länger braucht → Phase 7 Beta-Launch um 1 Woche schieben (Ende Juni → Anfang Juli)

**Deliverables:**
- 1:1-DM Pulse (siehe §12.1)
- TikTok-Demo-Clip #1 produced by Bruno

### 14.2 Phase 8 — Pulse-Erweiterung (Aug-Okt 2026)

- Group-Channel-Pulse (Aggregate-Mode)
- Voice-Channel-Pulse-Sync (Audio-Amplitude als Input-Source)
- Sound-Komponente (audio cues, opt-in)
- Color-Theming
- Multi-Device-Pulse-Sync (eigene Devices senden ein gemeinsames Signal)

### 14.3 Phase 9 — Pulse-Evolution (Year 1)

- WebGL-Renderer (für 500+ Partikel in Group-Channels)
- Optional: „Pulse Compatibility" — zwei Users haben oft synchrone Energie-Patterns → Soft-UI-Hint
- Mood-Aggregat über Tage (ohne Persistenz von individual events — k-anonymity per Channel)

### 14.4 Explizit nie

- **Pulse-History pro User** (Privacy)
- **Pulse-basierter Bot-Filter im Auth-Pfad** (Accessibility)
- **Pulse-Verified-Human-Badge** (Accessibility + Discrimination-Risk)
- **Cross-User Pulse-Matching für Dating-/Friend-Suggestions** (Privacy + Brand-Konflikt)

---

## 15. Decision Log

| Datum | Entscheidung | Alt | Neu | Begründung |
|---|---|---|---|---|
| 2026-06-02 | Naming | „Energy" / „Vibe" / „Aura" | **„Pulse"** | Kurz, herzschlag-konnotiert, Hashtag-fähig (#pulse). Bruno-Decision. |
| 2026-06-02 | Group-Chat-Scope im MVP | A: Per-User-Bubbles / B: Collective Vibe / C: Hybrid | **Group nicht im MVP** | 1:1 ist emotionaler Killer-Moment. Group verzehnfacht Aufwand (Sync, Color-Management). Phase 8 mit Voice. |
| 2026-06-02 | Sound-Komponente im MVP | Inkl. Audio-Cues / Stumm | **Stumm, Phase 8 deferred** | Permission-Friction + Mobile-Autoplay-Restrictions + Accessibility. Sound ist eigenes Sub-Projekt. |
| 2026-06-02 | Device-Target | PWA-only / Native Apps / Beides | **PWA-only** | Konsistent mit Phase-7-Beta-Scope. Native ist Phase 9 (Capacitor/Tauri). |
| 2026-06-02 | Anti-Bot-Authority-Status | Pulse als Captcha-Replacement / Pulse als Belief-Layer | **Belief-Layer, nicht Gate** | Pulse kann gefakt werden. Existing Anti-Bot (Turnstile + Rate-Limits + Passkey) bleibt Authority. Pulse macht Brand-Story stark, nicht Auth-Pfad. |
| 2026-06-02 | Persistence | Server-side Pulse-History für Replay / Nur transient WS | **Nur transient, kein DB-Write** | Privacy-Brand-Konsistenz. Pulse hat keinen Replay-Wert. |
| 2026-06-02 | Cross-User Sync Frequenz | 60Hz Sender-Side / 10Hz Sender, 15Hz Receiver-Cap | **10Hz default, 15Hz Receiver-Cap** | Battery + Bandbreite. Receiver interpoliert lokal. |
| 2026-06-02 | E2E-Encryption | Eigenes Pulse-Crypto / Existing Session-CMK | **Existing Session-CMK Pipeline** | Spec-konsistent, kein neuer Crypto-Pfad, kein PROTOCOL.md-Bruch. |
| 2026-06-02 | Render-Tech | WebGL / Canvas 2D | **Canvas 2D** | < 100 Partikel im MVP, Canvas 2D ausreichend + portabler. WebGL eval Phase 9 für Groups. |
| 2026-06-02 | iOS-Permission-Flow | Global beim App-Start / Per-Chat-Opt-In | **Per-Chat-Opt-In** | Reduziert First-Time-Friction, lässt User entscheiden pro Beziehung. |
| 2026-06-02 | Accessibility-Hardrule | Pulse-Abwesenheit als Bot-Indikator / Strikt neutral | **Strikt neutral, niemals Bot-Marker** | EU-Accessibility-Act + ADA + Brand-Integrität. Discrimination-Risk vermeiden. |
| 2026-06-02 | MVP-Timeline | 1 Woche fixiert / Phase 7 verschieben falls nötig | **1 Woche Ziel, 1 Woche Buffer für Phase 7** | Realistische Solo-Dev-Pace; Beta-Launch-Story braucht Pulse, lieber 1 Woche später als ohne |
| 2026-06-02 | Marketing-Strategie | Creator-Outreach upfront / Self-Posts-First | **Self-Posts erst, Creator-Outreach Phase 7** | Bruno hat keine TikTok-Erfahrung. Erst eigenen Channel etablieren, dann Creators mit Social-Proof ansprechen. |

---

## 16. Open Questions (für Bruno's Next-Brainstorm)

1. **Pulse-Theming-Default:** Cyan (matched accent-voice) oder warm-yellow (matched friendliness)? Wirkt subtil aber signifikant für Brand-Mood.
2. **Foam-Trigger-Sensitivity:** Wie schnell muss man's Phone schütteln um Foam-Mode zu triggern? Zu sensitiv = unintentional, zu rigid = niemand entdeckt's. Calibration via Beta-User-Feedback nötig.
3. **Pulse-Self-View:** Soll User SEINE EIGENE Pulse-Visualisierung im Chat sehen? Pro: Awareness, Spielerei. Con: Visueller Lärm. Default-Vorschlag: nur Peer-Pulse sichtbar, eigene als Mini-Indicator im Header.
4. **Cold-Start vs Warm-Open:** Wenn Anna den Chat öffnet, sieht sie Bruno's Pulse von „jetzt" oder ein „Wake-Up"-Animation („connecting...")? UX-Frage.
5. **Multi-Device Self-Sync (deferred Phase 8):** Wenn Bruno an iPhone tippt aber auch am Desktop logged-in ist — soll der Desktop seinen Pulse mitsehen? Privacy: eigene Geräte schon, andere Identitäten nie.

---

## 17. Glossary

- **Pulse:** Der abstrahierte Skalar `0.0–1.0` der die aktuelle Bewegungs-Energie eines Users repräsentiert.
- **Energy Engine:** Client-side Code in `lib/pulse/engine.js`, der Inputs → Pulse normalisiert.
- **Mode:** Diskreter State (`calm | active | excited | foam`) abgeleitet aus Energy-Level + Hysterese.
- **Foam:** Spike-State bei sehr hoher kurzlebiger Energie (Phone-Shake, schnelles Tippen + sofortiges Senden). Visuell explosive Partikel-Cluster.
- **Belief-Layer:** Architektur-Begriff. UI-Schicht, die User-Belief in Eigenschaften (z.B. „Gegenüber ist Mensch") verstärkt, ohne sie technisch zu verifizieren. Komplementär zu Gate-Layer (Auth, RL).
- **Session-CMK:** Existing RENEX-Crypto-Pipeline für 1:1-DM E2E-Encryption. Pulse-Frames durchlaufen denselben Pfad.

---

## 18. Verweise

- [`PROTOCOL.md`](./PROTOCOL.md) §3.4 (Message-Types, Pulse fügt neuen Type hinzu ohne Bruch)
- [`MANIFESTO.md`](./MANIFESTO.md) — Anti-AI-Brand-Story wird in Phase 6 mit Pulse-Pitch erweitert
- [`THREAT_MODEL.md`](./THREAT_MODEL.md) v0.1 — Threat-Model wird mit §8.2 Pulse-Adversaries ergänzt
- [`VISION.md`](./VISION.md) Roadmap — Phase 6.5 Spec konkretisiert
- [Memory: feedback-cf-workers-await-subrequest](../...memory/feedback_cf_workers_await_subrequest.md) — Backend-Forward von Pulse-Frames muss awaited werden

---

**Dieses Dokument ist die Bibel für Pulse.**
**Vor jedem Pulse-Implementation-Schritt: hier reinschauen.**
**Wenn das Dokument falsch ist: korrigiere es bewusst, nicht beiläufig.**
