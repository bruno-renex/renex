# RENEX — Voice Architecture Spec (Phase 8)

> **Phase 8 Architecture Sketch** (post-Beta, ~6-8 Wochen)
> Voice 1:1 + Voice-Channels als „v2.0-Update" gemeinsam mit Signal Protocol.
> Setzt auf bestehender Multi-Device-Krypto auf ([`MULTI_DEVICE.md`](./MULTI_DEVICE.md), [`GROUPS_MULTIDEVICE.md`](./GROUPS_MULTIDEVICE.md)).
> Decision-Begründung warum self-hosted statt CF Realtime: [`VISION.md`](./VISION.md) Decision Log 2026-05-15.

**Status:** Sketch v0.1 — Architektur-Skizze, NICHT implementation-ready
**Version:** 0.1
**Letzte Aktualisierung:** 2026-05-15
**Autor:** Bruno Hochstrasser

> ⚠️ Dieses Dokument ist ein **Architektur-Sketch**, kein implementation-ready Spec. Detail-Spec wird zu Phase-8-Start geschrieben mit dann aktuellem LiveKit-API-Stand + konkreten Endpoint-Schemas. Hier nur die strategischen Entscheidungen, Komponenten-Layout und Migration-Pfad — damit beim Start nicht bei Null begonnen wird.

---

## Inhaltsverzeichnis

1. [Glossar & Topologie](#1-glossar--topologie)
2. [Voice 1:1 (coturn)](#2-voice-11-coturn)
3. [Voice-Channels (LiveKit SFU)](#3-voice-channels-livekit-sfu)
4. [E2E Frame-Encryption](#4-e2e-frame-encryption)
5. [LiveKit-Token-Flow](#5-livekit-token-flow)
6. [Self-Hosting (Hetzner Deploy-Script)](#6-self-hosting-hetzner-deploy-script)
7. [Migration-Pfad (Phase 8a–8d)](#7-migration-pfad-phase-8a8d)
8. [Kosten-Modell](#8-kosten-modell)
9. [Offene Punkte für Detail-Spec](#9-offene-punkte-für-detail-spec)
10. [Decision Log](#10-decision-log)

---

## 1. Glossar & Topologie

| Begriff | Bedeutung |
|---|---|
| **TURN** | Traversal Using Relays around NAT. Relay-Server der UDP/TCP weiterleitet wenn direkter Peer-Pfad blockiert ist. |
| **STUN** | Session Traversal Utilities for NAT. Reflektiert die öffentliche IP des Clients zurück, damit Peers sich finden. |
| **SFU** | Selective Forwarding Unit. Media-Server der Streams empfängt + an alle Teilnehmer einer Konferenz forwardet. |
| **Insertable Streams** | WebRTC-API die JavaScript erlaubt, jeden encodeten Audio/Video-Frame vor dem Versand zu transformieren (= Frame-Encryption-Hook). |
| **GSK** | Group Sender Key — 32-Byte AES-GCM-Key pro `(User, Group)`. Siehe [`GROUPS_MULTIDEVICE.md`](./GROUPS_MULTIDEVICE.md). |
| **Frame-Key** | Per-Frame-derived AES-GCM-Key (HKDF aus GSK). Wird für Voice-Channel-Frame-Encryption verwendet. |
| **DTLS-SRTP** | Standard-WebRTC-Encryption-Layer (point-to-point). Schützt Audio zwischen Peers, aber NICHT zwischen Peer↔SFU. |

### Topologie-Aufteilung

```
┌────────────────────────────────────────────────────────────────┐
│                      RENEX Voice-Stack                          │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1:1 Calls (Phase 8a)         Voice-Channels (Phase 8b/8c)     │
│  ─────────────────────        ───────────────────────────       │
│  Architektur: P2P             Architektur: SFU                  │
│  ↓                            ↓                                 │
│  WebRTC RTCPeerConnection     LiveKit-Client (Apache-2.0)       │
│  ↓                            ↓                                 │
│  DTLS-SRTP (browser-native)   DTLS-SRTP (Peer↔SFU)              │
│                               + Insertable Streams              │
│                               + Frame-Encryption (GSK-derived)  │
│  ↓                            ↓                                 │
│  coturn TURN-Relay            LiveKit-Server (Go-Binary)        │
│  Hetzner CH/DE                Hetzner CH/DE                     │
│                                                                 │
│  Auth: bestehender Voice-     Auth: JWT-Token vom Worker        │
│  Signaling-Pfad               (LIVEKIT_API_KEY + Secret)        │
│  (/voice/ring, /answer, ...)                                    │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
                              ↑
              CF Workers nur für Auth/Token-Issuing,
              KEIN Media-Routing über Cloudflare
```

### Warum diese Aufteilung?

- **1:1 hat keine Skalierungs-Frage** — P2P ist optimal: minimale Latenz, kein Server-Round-Trip, DTLS-SRTP ist seit 15 Jahren battle-tested. SFU wäre overkill.
- **Voice-Channels brauchen SFU** — N²-Mesh skaliert nicht über 4 Speaker (jeder sendet an alle anderen einzeln). SFU sendet jeden Stream einmal hoch, Server fan-out. Skaliert auf 50+ Speaker.
- **Eigene Krypto-Layer für SFU** — DTLS-SRTP endet beim SFU. Ohne Insertable-Streams-Frame-Encryption hätte LiveKit-Server Plaintext-Zugriff. Mit Frame-Encryption sieht der Server nur encrypted Opus-Pakete durchschleusen.

---

## 2. Voice 1:1 (coturn)

### Code-Änderung minimal

Bestehender Voice-Code in [`frontend/src/stores/voice.svelte.js`](../frontend/src/stores/voice.svelte.js) + [`frontend/src/lib/voiceRTC.js`](../frontend/src/lib/voiceRTC.js) bleibt unverändert. Einziger Backend-Switch in `/voice/turn-credentials` ([voiceRoutes.js:710](../src/routes/voiceRoutes.js:710)):

```js
case "/voice/turn-credentials": {
  // Statt CF Realtime TURN → eigener coturn-Server
  const ttl = 3600;
  const username = `${Math.floor(Date.now() / 1000) + ttl}:${session.handle}`;
  const credential = await hmacSha1(env.COTURN_SECRET, username);

  return json(request, {
    iceServers: [
      { urls: "stun:turn.renex.id:3478" },
      { urls: "turn:turn.renex.id:3478?transport=udp",  username, credential },
      { urls: "turn:turn.renex.id:3478?transport=tcp",  username, credential },
      { urls: "turns:turn.renex.id:443?transport=tcp",  username, credential },
    ],
    ttl,
  });
}
```

- `username` enthält Expiry-Timestamp → coturn akzeptiert nur während TTL
- `credential` ist HMAC-SHA1(static-auth-secret, username) — standardes coturn REST-API-Auth-Schema
- Drei URLs für Robustheit: UDP (best), TCP (Firewall-Fallback), TLS/443 (strict-Firewall-Fallback)

### Privacy-Eigenschaften

- coturn sieht nur encrypted SRTP-Bytes durchschleusen (DTLS-Keys werden zwischen den beiden Browsern direkt verhandelt, coturn ist NICHT DTLS-Endpoint)
- Bei direkter P2P-Verbindung (kein TURN-Relay nötig) sieht coturn gar nichts — nur STUN-Binding für NAT-Discovery
- Metadata: coturn kennt nur ephemere `username` (kein User-Handle ohne expliziten Logs-Setup), Source-IP, Allocation-Duration. Kein Beziehungs-Graph wenn wir keine Logs schreiben.

### Reliability-Vorteile

Aktueller CF Realtime TURN zeigte in Tests beidseitige Carrier-NAT-Probleme (siehe Decision Log 2026-05-15). Eigener coturn mit korrekten `external-ip` + `relay-ip` Settings + PERMISSIONS-Forwarding löst das.

---

## 3. Voice-Channels (LiveKit SFU)

### Architektur-Schichten

```
User-Device
  ↓ JWT-Token (vom RENEX-Worker)
  ↓ wss://livekit.renex.id
LiveKit-Client (Apache-2.0 SDK)
  ↓ Publish/Subscribe API
  ↓ Insertable Streams hook
Frame-Crypto Pipeline (eigener Code)
  ↓ AES-GCM encrypt mit Frame-Key
  ↓ Frame-Key = HKDF(GSK, info=channelId/sender/chainIdx>>8)
WebRTC RTCPeerConnection
  ↓ DTLS-SRTP zu LiveKit-Server
LiveKit-Server (Go-Binary, self-hosted)
  ↓ Forward encrypted Frames an alle Subscribers
Andere User-Devices
  ↓ Inverse Pipeline: DTLS-decrypt → Frame-decrypt → Opus-decode → Audio
```

### LiveKit-Features die wir aus der Box bekommen

- Multi-Speaker-Mixing (bis zu 50+ pro Room)
- Active-Speaker-Detection (Wer-spricht-gerade-API)
- Bandwidth-Adaptation (LiveKit Simulcast: reduzierte Quality bei schlechter Connection)
- Mute/Unmute-State-Sync
- Screen-Sharing als zusätzlicher Track-Type
- Reconnect bei Netzwechsel automatisch
- Push-to-Talk: einfach Mic-Track stumm-schalten/aktivieren via SDK

### Eigene Komponenten (was wir schreiben müssen)

- **Backend**: `POST /voice/livekit/token` Endpoint — JWT-Generierung mit channel-spezifischen Grants (siehe §5)
- **Frontend**: `voiceChannelStore.svelte.js` — Room-Lifecycle, Member-Liste, Mute-State, Frame-Crypto-Wiring
- **Frontend**: `voiceChannelCrypto.js` — HKDF-Derivation, AES-GCM Frame-Encrypt/Decrypt, Chain-Index-Management
- **UI**: `VoiceChannelView.svelte` — Member-Avatars, Speaking-Indicator, Mute/PTT-Controls, Leave-Button
- **Backend-Schema**: `conversations.kind = 'voice'` als neuer Channel-Type neben `text` (Schema bereits flexibel in [SERVERS.md](./SERVERS.md))

---

## 4. E2E Frame-Encryption

### Warum nötig

DTLS-SRTP schützt nur den Channel zwischen Peer und SFU. Der SFU-Operator hat technisch Zugriff aufs Plaintext-Audio. Damit der LiveKit-Server **zero-knowledge** bleibt (= selbst wenn von Behörden compelled, kann er kein Audio reconstruieren), brauchen wir eine Frame-Layer-Encryption oberhalb DTLS-SRTP.

WebRTC's Insertable-Streams-API erlaubt JavaScript-Transformer-Streams zwischen Encoder und RTP-Packetizer. Wir hängen dort Encrypt-Hooks rein.

### Frame-Format

```
Original RTP-Payload (raw encoded Opus frame, ~50-200 bytes)
                 ↓
        ┌────────────────────┐
        │ Encrypt mit AES-GCM │
        │ Key: Frame-Key      │
        │ IV: 12 random bytes │
        │ AAD: roomId|sender|chainIdx │
        └────────────────────┘
                 ↓
┌──────┬──────┬─────────────────┬──────────┐
│ idx  │ IV   │ Ciphertext      │ Auth-Tag │
│ (4B) │ (12B)│ (variable)      │ (16B)    │
└──────┴──────┴─────────────────┴──────────┘
                 ↓
       als RTP-Payload weitergereicht
                 ↓
       DTLS-SRTP (LiveKit-Layer) verschlüsselt nochmal für Transport
```

Overhead: **32 Bytes pro Frame**. Bei 50 Frames/s = 1.6 KB/s zusätzlich. Vernachlässigbar.

### Frame-Key-Derivation

```js
// frontend/src/lib/voiceChannelCrypto.js (NEU, ~100 Zeilen)

const FRAME_KEY_ROTATION_INTERVAL = 256;  // alle 256 Frames neue Key-Derivation

async function deriveFrameKey(gsk, channelId, senderHandle, chainIndex) {
  // HKDF-SHA256
  // ikm = gsk (32 bytes)
  // salt = leer
  // info = "voice-channel|{channelId}|{senderHandle}|{chainIndex >> 8}"
  // → 32 bytes AES-GCM key
  const epoch = chainIndex >>> 8;  // alle 256 frames rotieren
  const info = new TextEncoder().encode(
    `voice-channel|${channelId}|${senderHandle.toLowerCase()}|${epoch}`
  );
  const baseKey = await crypto.subtle.importKey('raw', gsk, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info },
    baseKey,
    256
  );
  return await crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function buildFrameAAD(channelId, senderHandle, chainIndex) {
  // Cross-Channel/Sender/Sequence Replay-Schutz
  return new TextEncoder().encode(
    `${channelId}|${senderHandle.toLowerCase()}|${chainIndex}`
  );
}
```

### Sender-Pipeline

```js
const sender = room.localParticipant.tracks.get(trackSid).sender;
const senderStreams = sender.createEncodedStreams();
let chainIndex = 0;
const transformer = new TransformStream({
  async transform(frame, controller) {
    const idx = chainIndex++;
    const frameKey = await deriveFrameKey(myGSK, channelId, me, idx);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = buildFrameAAD(channelId, me, idx);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      frameKey,
      frame.data
    );
    // Concat: chainIndex (4 bytes) + IV (12 bytes) + ciphertext + tag (16 bytes inkl.)
    const out = new Uint8Array(4 + 12 + ct.byteLength);
    new DataView(out.buffer).setUint32(0, idx);
    out.set(iv, 4);
    out.set(new Uint8Array(ct), 16);
    frame.data = out.buffer;
    controller.enqueue(frame);
  }
});
senderStreams.readable.pipeThrough(transformer).pipeTo(senderStreams.writable);
```

### Receiver-Pipeline

```js
room.on(RoomEvent.TrackSubscribed, async (track, publication, participant) => {
  const receiverStreams = track.receiver.createEncodedStreams();
  // Peer-GSK aus Storage holen (Cache + Lazy-Fetch via request_gsk wenn missing)
  const peerGSK = await getOrRequestPeerGSK(channelId, participant.identity);
  const transformer = new TransformStream({
    async transform(frame, controller) {
      const view = new DataView(frame.data);
      const idx = view.getUint32(0);
      const iv = new Uint8Array(frame.data, 4, 12);
      const ct = new Uint8Array(frame.data, 16);
      const frameKey = await deriveFrameKey(peerGSK, channelId, participant.identity, idx);
      const aad = buildFrameAAD(channelId, participant.identity, idx);
      try {
        const pt = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv, additionalData: aad },
          frameKey,
          ct
        );
        frame.data = pt;
        controller.enqueue(frame);
      } catch {
        // Drop frame silently — Decrypt-Fail kann temporär sein bei GSK-Rotation
      }
    }
  });
  receiverStreams.readable.pipeThrough(transformer).pipeTo(receiverStreams.writable);
});
```

### Member-Join / Leave-Verhalten

- **Member joined**: bekommt aktuellen GSK über bestehenden `request_gsk`-Flow ([App.svelte](../frontend/src/App.svelte)). Kann ab dem Moment alle Frames decrypten. **Kann historische Frames NICHT decrypten** weil Frame-Keys per-epoch derived sind und ohne dabei gewesen zu sein die `chainIndex >> 8` Epoch nicht erreichbar ist (effektiv Forward-Secrecy-ähnlich, obwohl GSK selbst nicht rotiert).
- **Member left/kicked**: GSK aller bleibender Members rotieren via bestehendem [`rotateMyGSK`](../frontend/src/lib/groupCrypto.js) → frische Frame-Keys ab nächstem `chainIndex` → ex-Member kann auch nicht mehr decrypten wenn er aufgezeichnete encrypted Frames mitschneidet.

---

## 5. LiveKit-Token-Flow

### Backend Token-Generation

```js
// src/routes/voiceRoutes.js — neuer Case (Phase 8b)

case "/voice/livekit/token": {
  const session = await requireSession(request, env);
  if (!session) return json(request, { error: "Not authenticated" }, 401);

  const body = await readJson(request);
  const channelId = String(body.channelId || "");
  if (!isUUID(channelId)) return json(request, { error: "Invalid channelId" }, 400);

  // Permission-Check: ist User Member des Channel-Servers + hat VIEW_CHANNEL?
  const allowed = await canJoinVoiceChannel(env, session.handle, channelId);
  if (!allowed) return json(request, { error: "forbidden" }, 403);

  // JWT signed mit LIVEKIT_API_SECRET (Cloudflare-Secret)
  const myDeviceId = await getCurrentDeviceId(env, session.handle, request);
  const token = await signLiveKitJWT({
    iss: env.LIVEKIT_API_KEY,
    sub: `${session.handle}#${myDeviceId.slice(0, 8)}`,
    exp: Math.floor(Date.now() / 1000) + 6 * 3600,  // 6h, refresh-fähig
    video: {
      room: `renex-channel-${channelId}`,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    },
    metadata: JSON.stringify({
      handle: session.handle,
      deviceId: myDeviceId,
      // Device-Pubkey für E2E-Key-Distribution
      // (andere Teilnehmer können daraus den GSK-Wrap-Empfänger ableiten)
    }),
  }, env.LIVEKIT_API_SECRET);

  return json(request, {
    token,
    serverUrl: "wss://livekit.renex.id",
    roomName: `renex-channel-${channelId}`,
  });
}
```

### Frontend Connect

```js
import { Room, RoomEvent } from 'livekit-client';

async function joinVoiceChannel(channelId) {
  const r = await apiFetch('/voice/livekit/token', {
    method: 'POST',
    body: { channelId },
  });
  if (!r.ok) throw new Error(r.error || 'token_failed');

  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    publishDefaults: {
      audioPreset: { maxBitrate: 32_000 },  // 32 kbps Mono Free / 64 kbps Stereo Pro
    },
  });

  // Frame-Encryption-Hooks (siehe §4)
  setupFrameEncryption(room, channelId);

  await room.connect(r.data.serverUrl, r.data.token);
  // Publish-Mic
  await room.localParticipant.setMicrophoneEnabled(true);
}
```

### Token-Refresh

LiveKit-JWT läuft nach 6h ab. Vor Ablauf: Frontend pollt `/voice/livekit/token` (mit gleicher channelId) und übergibt neuen Token via `room.updateAuthToken(newToken)`. Kein Reconnect nötig.

---

## 6. Self-Hosting (Hetzner Deploy-Script)

### Server-Sizing

| Phase | User-Scale | Hetzner-Spec | Monthly |
|---|---|---|---|
| Beta (Jul 2026) | <500 concurrent | 1× CX22 (2vCPU/4GB) | ~6€ |
| Year 1 | ~1k concurrent | 2× CX32 (4vCPU/8GB) + HAProxy | ~25€ |
| Year 2 | ~5k concurrent | 3× CX42 + HAProxy + Redis | ~120€ |
| Year 3+ | Multi-Region | Cluster CH/DE + US + APAC | ~600-1500€ |

CX22 in Falkenstein (DE/CH-Border): 20 TB Traffic inklusive — bei 32kbps × 2 Direktion × 500 concurrent = ~4 MB/s = ~10 TB/Monat. Reicht für Beta. Aufrüsten ist Online-Migration.

### Setup-Script

Siehe Architektur-Konversation 2026-05-15 (im Repo-Chat) für vollständiges Bash-Script. Komponenten:

- **coturn** (apt package): TURN-Server, listening auf 3478 (UDP/TCP) + 5349 (TLS) + 443 (TLS für strict-firewall fallback). Auth via `static-auth-secret` (REST-API-Pattern).
- **LiveKit** (Docker): Apache-2.0 Go-Binary, listening auf 7881 (signaling) + 50000-60000 (UDP media range). API-Key + Secret als ENV.
- **nginx** (reverse-proxy): WSS-Termination auf 443 für LiveKit-Signaling (manche Corporate-Firewalls blocken 7881, 443 geht überall durch).
- **certbot** (Let's Encrypt): Auto-renewal für beide Domains (`turn.renex.id`, `livekit.renex.id`).
- **ufw**: Firewall mit explicit-allow für relevante Ports.

DNS-Vorbereitung in Cloudflare:
- `turn.renex.id A <hetzner-ip>` (kein CF-Proxy, direkter Pass-Through für UDP)
- `livekit.renex.id A <hetzner-ip>` (kein CF-Proxy)
- TTL 60s während Setup, 3600s in Production

### Cloudflare-Worker-Secrets (zu setzen)

```bash
wrangler secret put COTURN_SECRET        # für HMAC-SHA1 in /voice/turn-credentials
wrangler secret put LIVEKIT_API_KEY      # für JWT-iss
wrangler secret put LIVEKIT_API_SECRET   # für JWT-Signing (HMAC-SHA256)
```

---

## 7. Migration-Pfad (Phase 8a–8d)

### Phase 8a — coturn-Switch (Woche 1-2)

**Goal**: 1:1-Voice zuverlässig auf eigenem TURN, löst aktuelles CF-Realtime-Carrier-NAT-Problem.

- Hetzner CX22 bestellen, Deploy-Script ausführen
- DNS für `turn.renex.id` setzen
- Worker-Secret `COTURN_SECRET`
- Backend `/voice/turn-credentials` umstellen
- Voice-Frontend-Code bleibt UNVERÄNDERT
- Smoke-Test: anna↔bertha cross-network sollte zuverlässig connecten
- Rollout: kein Risiko — bei Problem zurück auf CF Realtime mit einer Backend-Zeile

### Phase 8b — LiveKit-Setup + Frame-Crypto-Lib (Woche 3-4)

**Goal**: Infrastructure + Crypto-Bibliothek bereit, ohne UI.

- LiveKit-Docker im selben Hetzner-Server hochziehen
- DNS für `livekit.renex.id`
- Worker-Secrets `LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET`
- Backend `POST /voice/livekit/token` Endpoint
- `frontend/src/lib/voiceChannelCrypto.js` schreiben + Unit-Tests (HKDF-Derivation deterministisch, AES-GCM-Round-Trip mit echten Opus-Frames)
- Integration-Test: lokales Two-Browser-Setup mit Frame-Encryption über LiveKit lokal connecten

### Phase 8c — Voice-Channel-UI (Woche 5-6)

**Goal**: User-facing Voice-Channels in Server-Sidebar.

- DB-Schema: `conversations.kind = 'voice'` als neuer Channel-Type
- `voiceChannelStore.svelte.js` — Room-Lifecycle-State (joining/joined/leaving/idle)
- `VoiceChannelView.svelte` — Member-Liste mit Avatars, Speaking-Indicator, Mute-Toggle, Leave-Button
- Server-Settings: Voice-Channel-Erstellen-UI (analog Text-Channel)
- Frame-Encryption-Pipeline-Wiring in voiceChannelStore
- Multi-Speaker-Mixing testen (5×5: 5 Speaker × 5 Listener)

### Phase 8d — Polish + Edge-Cases (Woche 7-8)

**Goal**: Production-Ready für „v2.0-Launch".

- Push-to-Talk (Spacebar-Hold / Touch-Hold-Mobile)
- Screen-Sharing (LiveKit-Track-Type `screen_share`)
- Reconnect bei Netzwechsel (LiveKit hat das eingebaut, aber Frame-Crypto-State muss reset werden)
- Active-Speaker-API anbinden (LiveKit ParticipantInfo.isSpeaking)
- Quality-Indicator (LiveKit ConnectionQuality-Event)
- Settings: Audio-Device-Picker, Echo-Cancellation-Toggle
- Pro-Feature: Stereo + 64kbps für Pro-Subscriber (LiveKit publishOptions)
- Bandwidth-Pro: Simulcast-Layers für Screen-Share

---

## 8. Kosten-Modell

| Stufe | Concurrent Voice-Users | Self-hosted (Hetzner) | CF Realtime (Vergleich) |
|---|---|---|---|
| Beta (Jul 2026) | <500 | ~6€/Mo | ~$50-100/Mo |
| Year 1 (5k MAU) | ~1k | ~25€/Mo | ~$500-1000/Mo |
| Year 2 (30k MAU) | ~5k | ~120€/Mo | ~$3000-5000/Mo |
| Year 5 (300k MAU) | ~50k | ~800-1500€/Mo (multi-region) | ~$30k-50k/Mo |

**Faktor 10-100× günstiger** in allen Skalierungs-Phasen. Year-2-Pro-MRR-Ziel ($1500/Mo aus VISION) finanziert Infra mit grossem Sicherheits-Abstand.

---

## 9. Offene Punkte für Detail-Spec

Folgende Items werden zu Phase-8-Start in der finalen `VOICE.md`-Spec geklärt:

- **Concurrent-User-Pro-Channel-Limit**: Default vermutlich 50 (LiveKit-Default). Pro-Tier evtl. 100. Definitives Limit nach Load-Tests.
- **Recording**: bewusst NICHT geplant für v2.0 (Privacy-Pillar). User-Recording-Toggle pro Channel als Phase-9-Option?
- **Voice-Activity-Detection (VAD)**: clientseitig bei Push-to-Talk oder serverseitig? Trade-off: clientseitig braucht keinen Server-CPU, aber Mobile-Browser haben unterschiedliche VAD-Qualitäten.
- **TURN-Failover bei coturn-Outage**: Multi-Server-Setup mit GeoDNS? Backup-CF-TURN-Server-Konfig? Year-1-akzeptabel ohne, Year-2-Anforderung.
- **GSK-Distribution-Race bei Channel-Join**: User joint Voice-Channel BEVOR GSK-Distribution durchgelaufen ist → erste 1-2 Sekunden Frames können nicht decrypted werden. Akzeptabel oder UI-Warmup-Indicator?
- **Bandwidth-Adaptive für Mobile**: LiveKit-Simulcast-Layer-Configuration für 3G/4G/WLAN.
- **Echo-Cancellation auf iOS-PWA**: WebRTC-Default `googEchoCancellation` ist auf iOS Safari nicht zuverlässig — Web Audio API + manuelle Echo-Cancellation als Fallback?
- **Voice-Channel-Persistence**: bleibt Channel "offen" wenn alle gehen (Discord-Pattern) oder schliesst Room automatisch (LiveKit-Default)?
- **Mobile-PWA-Background-Audio**: iOS limitiert Background-Audio aggressive. Push-Notification-Flow bei eingehendem Voice-Channel-Activity?
- **Pro-Tier-Limits**: Audio-Bitrate (32 Free / 64 Pro Stereo), max concurrent Channels pro Server (Free/Pro)? Definitive Zahlen mit Pro-Launch.

---

## 10. Decision Log

| Datum | Entscheidung | Alt | Neu | Begründung |
|---|---|---|---|---|
| 2026-05-15 | **Voice-Provider** | CF Realtime SFU für alles | **Hybrid: coturn (1:1) + LiveKit (Channels), beides self-hosted** | Privacy (zero-knowledge Server möglich), Open-Standard (LiveKit Apache-2.0, nicht CF-Lock-in), Kosten (10-100× günstiger), Praxis (CF Realtime TURN failt in Mobile-Carrier-NAT-Setups). Full Rationale: [`VISION.md`](./VISION.md) Decision Log 2026-05-15. |
| 2026-05-15 | **Frame-Encryption-Key-Material** | neue Krypto-Schicht entwerfen | **HKDF-Derivation aus bestehendem GSK** | Wiederverwendung der etablierten Group-Sender-Key-Pipeline aus Phase 1C. Kein neues Key-Distribution-Problem, automatische Rotation bei Member-Leave über existierenden Pfad. |
| 2026-05-15 | **Phase-8a-Split** | komplettes Voice-Paket in Phase 8 | **8a (coturn-1:1) sofort, 8b-8d (LiveKit-Channels) später** | 8a löst akutes CF-TURN-Problem während Beta — kann unabhängig von Channels deployt werden, niedrigstes Risiko, klarer Win für Beta-User. |
| 2026-05-15 | **DTLS-SRTP-Verzicht für Channels?** | nur Frame-Encryption ohne DTLS | **Frame-Encryption ZUSÄTZLICH zu DTLS-SRTP** | DTLS-SRTP von LiveKit-Stack mitgegeben, Defense-in-Depth gegen Frame-Layer-Bugs, kostet nichts extra. |

---

## Anhang: Beziehung zu anderen Specs

- **[`VISION.md`](./VISION.md) §7 + §10 + Decision Log 2026-05-15**: strategische Entscheidung
- **[`SERVERS.md`](./SERVERS.md) §4**: Channel-Modell `conversations.kind` Erweiterung um `'voice'`
- **[`GROUPS_MULTIDEVICE.md`](./GROUPS_MULTIDEVICE.md)**: GSK-System als Frame-Key-Material-Quelle
- **[`PROTOCOL.md`](./PROTOCOL.md)**: Voice-Channel-Frame-Format wird als Wire-Spec Teil des RENEX Open Standards (Phase 2 Public)

---

**Status:** Architektur-Skizze, Phase-8-Start triggert Umwandlung in implementation-ready Spec mit dann aktuellem LiveKit-API-Stand.
