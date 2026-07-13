# RENEX — Group Multi-Device Spec (Phase 1C)

> **Phase 1C Architecture**
> Multi-Device-Erweiterung des GSK-Layers (Group Sender Keys).
> Setzt auf der DM-Multi-Device-Infrastruktur aus [`MULTI_DEVICE.md`](./MULTI_DEVICE.md) auf.

**Status:** Verbindlich
**Version:** 1.0
**Letzte Aktualisierung:** 2026-05-10
**Autor:** Bruno Hochstrasser

---

## Inhaltsverzeichnis

1. [Glossar & Recap](#1-glossar--recap)
2. [Status quo vor Phase 1C](#2-status-quo-vor-phase-1c)
3. [Phase-1C-Lieferung](#3-phase-1c-lieferung)
4. [Sequence-Diagrams](#4-sequence-diagrams)
5. [Edge-Cases](#5-edge-cases)
6. [Test-Matrix](#6-test-matrix)
7. [Decision Log](#7-decision-log)
8. [API-Surface (Delta)](#8-api-surface-delta)

---

## 1. Glossar & Recap

| Begriff | Bedeutung |
|---|---|
| **GSK** | Group Sender Key — 32-Byte AES-GCM-Key pro `(User, Group)`. Sender-Keys-Pattern. |
| **My-GSK** | Eigene GSK in einer Gruppe (`gsk:my:<me>:<groupId>` in IDB). |
| **Peer-GSK** | GSK eines Members, lokal gecached (`gsk:peer:<me>:<groupId>:<peer>`). |
| **GSK-Wrap** | ECDH(myPriv × deviceJwk) → AES-GCM-Wrap der GSK pro Empfänger-Device. |
| **gsk-Control** | `chatSend({type:"gsk", ...})` — broadcast an alle Member-Devices. |
| **request_gsk** | `chatSend({type:"request_gsk", requestedFrom})` — Pull-Pattern, fragt Peer aktiv nach seiner GSK. |
| **Peer-Device-Add** | WS-Event `device_added` mit `from !== me`. |
| **Self-Device-Add** | WS-Event `device_added` mit `from === me`. |

**Konzept-Recap:** Im Sender-Keys-Pattern hat jeder User pro Gruppe **einen** symmetrischen Schlüssel, mit dem ALLE seine eigenen Group-Sends encrypted werden. Empfänger müssen den GSK *jedes* Senders kennen, mit dem sie kommunizieren. Multi-Device bedeutet: jedes Device jedes Members muss den GSK kennen — und zwar individuell gewrapped (da das Wrapping per Device-Pubkey passiert, nicht per User).

---

## 2. Status quo vor Phase 1C

### 2.1 Bereits implementiert (Phase 1A.6 / 1B Side-Effects)

✅ **Storage-Layer** (`frontend/src/lib/groupCrypto.js`):
- IDB: `gsk:my:<me>:<groupId>`, `gsk:peer:<me>:<groupId>:<peer>` mit per-Group HKDF-Storage-Key.
- KV (Backend): `e2e:gsk:<groupId>:<me>:<deviceId>` für eigene Multi-Device-Distribution.

✅ **Distribution an andere Members**:
- `sendMyGSKToMember(groupId, gsk, peer)` — wrapped GSK pro Peer-Device, sendet via `type:"gsk"`.
- `distributeMyGSKToMembers(groupId, gsk, members)` — fan-out an alle Members.
- GSK-Sig (`signGskPayload`) als Auth-Layer zusätzlich zu ECDH.

✅ **Distribution an eigene Devices**:
- `storeMyGSKForOwnDevices(groupId, gsk)` — wrapped für alle eigenen Devices ausser sender, ablegt in KV via `POST /e2e/group-gsk/store`.
- `fetchMyGSKFromKV(groupId)` — neues Device holt eigene GSK aus KV beim ersten Send-Versuch.

✅ **Pull-Pattern**:
- `sendRequestGSK(groupId, requestedFrom)` — Member fragt aktiv nach Peer-GSK wenn lokal nicht vorhanden.
- `handleIncomingRequestGSK(msg)` — Antwort-Handler: re-sendet eigene GSK an Anfrager.

✅ **Self-Device-Add Hook** ([`App.svelte:637-651`](../frontend/src/App.svelte:637)):
- WS `device_added(self)` → für jede Gruppe in `inboxStore.groups` → `storeMyGSKForOwnDevices(groupId, gsk)`.

✅ **Rotation**:
- `rotateMyGSK(groupId, members)` bei `member_left` / `member_removed` ([`App.svelte:582-605`](../frontend/src/App.svelte:582)).
- Auto-Rotate bei `ENCRYPT_ROTATE_THRESHOLD` (NIST SP 800-38D §8.3).

✅ **Backend-Whitelist** (`src/helpers/chatSend.js`):
- `gsk` und `request_gsk` als Control-Types whitelisted, eigene Rate-Limit-Buckets, kein D1-Storage-Bypass nötig.

### 2.2 Lücken vor Phase 1C

❌ **Peer-Device-Add → GSK-Re-Wrap fehlt**
- WS `device_added(peer)` triggert in [`App.svelte:652-659`](../frontend/src/App.svelte:652) **nur** `redistributeCMKToPeer` (DM-Pfad).
- Für Gruppen, in denen `me` und `peer` beide Member sind, wird die eigene GSK **nicht** für das neue Peer-Device gewrapped.
- Konsequenz: Neues Peer-Device kann meine zukünftigen Group-Messages nicht decrypten — bis zur nächsten Rotation oder bis es manuell `request_gsk` schickt.

❌ **Race: `storeMyGSKForOwnDevices` ohne KV-Eventual-Consistency-Schutz**
- `_fetchUserDevices(me)` liest KV-Index direkt nach `device_added(self)`-Event.
- Wenn der KV-Index am Empfänger-Edge noch nicht propagiert ist, fehlt das **gerade hinzugekommene** Device in der Liste → KEIN Wrap → neues Device hat keine GSK in KV.
- DM-Pfad löst das via `fetchPeerDevicesEnsuring(handle, expectedDeviceId, expectedJwk)` mit Backoff-Retry ([`chatPipeline.js:720`](../frontend/src/lib/chatPipeline.js:720)). GSK-Pfad nicht.

❌ **`GROUPS_MULTIDEVICE.md` als Owner-Spec fehlt** (heute erledigt).

❌ **Multi-Device-Tests in `tests/groupCrypto.test.js`** — bestehende Tests covern Single-Device + Distribution-APIs, aber nicht das neue-Device-Add-Szenario.

---

## 3. Phase-1C-Lieferung

### 3.1 Code-Änderungen

| # | Datei | Änderung |
|---|---|---|
| 1 | `frontend/src/lib/groupCrypto.js` | `_fetchUserDevicesEnsuring(handle, expectedDeviceId, expectedJwk)` — Backoff-Retry analog `fetchPeerDevicesEnsuring`. |
| 2 | `frontend/src/lib/groupCrypto.js` | `storeMyGSKForOwnDevices(groupId, gsk, newDeviceInfo)` — optional. Bei gesetztem `newDeviceInfo` retry bis Device in KV-Index. |
| 3 | `frontend/src/lib/groupCrypto.js` | `redistributeGSKsForPeerDeviceAdded(me, peer, newDeviceInfo)` — neu. Iteriert über alle Gruppen, in denen me+peer Member sind, und re-sendet GSK an alle Peer-Devices (inkl. neues). |
| 4 | `frontend/src/App.svelte:652+` | Peer-Branch im `device_added`-Handler erweitern: zusätzlich `redistributeGSKsForPeerDeviceAdded(me, msg.from, newDeviceInfo)` aufrufen. |
| 5 | `frontend/src/App.svelte:641+` | Self-Branch: `storeMyGSKForOwnDevices(g.id, gsk, newDeviceInfo)` mit Race-Schutz. |

### 3.2 Keine Breaking Changes

- Backend-API unverändert — alle Änderungen sind Frontend-Wiring + Retry-Logic.
- Bestehende Single-Device-Setups verhalten sich identisch (`newDeviceInfo` ist optional, default `null`).
- IDB- und KV-Layouts unverändert.

### 3.3 Welche Gruppen sind „gemeinsam"?

`redistributeGSKsForPeerDeviceAdded` braucht eine Liste aller Gruppen, in denen `me` und `peer` beide Member sind. Source: `inboxStore.groups` (eigene Membership) + Backend-Endpoint `/group/members?groupId=...` für Mitgliederliste pro Gruppe.

**Optimization:** Wir filtern client-side: für jede meiner Gruppen lade Members → enthält Peer? → re-distribuieren. Bei N Gruppen × M Members pro Gruppe ist das `O(N)` Backend-Calls. Akzeptabel solange `N` klein ist (User in ≤ 50 Gruppen, MULTI_DEVICE.md §6).

**Alternative (deferred):** Backend-Endpoint `/group/list?member=<peer>&intersect=me` der direkt die gemeinsamen Gruppen liefert. Phase 1D wenn Performance-Issue auftaucht.

---

## 4. Sequence-Diagrams

### 4.1 Self-Device-Add (existiert, mit Race-Schutz erweitert)

```
User Bertha hat Devices A, B aktiv. Fügt C hinzu.

C → Backend                : POST /e2e/inbox/upload (eigener Pubkey + sigPub)
Backend → all bertha-devs  : WS device_added {from:'bertha', deviceId:C, jwk}
                              (broadcast inkl. A, B, C selbst)

A receives device_added(self):
  newDeviceInfo = {deviceId:C, jwk}
  for each group g in inbox.groups:
    gsk = getMyGSK(g.id)
    if gsk:
      storeMyGSKForOwnDevices(g.id, gsk, newDeviceInfo)
        → _fetchUserDevicesEnsuring('bertha', C, jwk)  ← Retry bis C in KV-Index
        → wrapGskForDevices([B, C], gsk)               ← A filtert sich selbst raus
        → POST /e2e/group-gsk/store {groupId, payloads:[B-wrap, C-wrap]}

C boots:
  for each group: ensureMyGSK(g.id, members)
    → getMyGSK(g.id) → null
    → fetchMyGSKFromKV(g.id) → KV: e2e:gsk:<groupId>:bertha:C → unwrap → GSK
    → setMyGSK(g.id, gsk)  ✅
```

### 4.2 Peer-Device-Add (NEU in Phase 1C)

```
Anna (Member von Group "Devs") fügt neues Device A2 hinzu.
Bertha ist auch Member von "Devs" (mit Devices B1, B2).

A2 → Backend             : POST /e2e/inbox/upload
Backend → anna-contacts  : WS device_added {from:'anna', deviceId:A2, jwk}
                            (an Bertha-DOs gepusht)

B1 receives device_added(peer='anna'):
  → redistributeCMKToPeer('bertha', 'anna', {deviceId:A2, jwk})    ← bestehend (DM)
  → redistributeGSKsForPeerDeviceAdded('bertha', 'anna', {...})    ← NEU
       for each group g where bertha and anna both members:
         gsk = getMyGSK(g.id)
         if gsk:
           devices = _fetchUserDevicesEnsuring('anna', A2, jwk)   ← Retry
           sendMyGSKToMember(g.id, gsk, 'anna')
             → wrap für A1, A2 → chatSend({type:'gsk', payloads:[...]})

A2 receives gsk control:
  → handleIncomingGSKMessage(msg)
  → setPeerGSK(g.id, 'bertha', gsk)
  → kann jetzt zukünftige Bertha-Messages decrypten ✅
```

### 4.3 Race: A2 sendet bevor B1 GSK pushen konnte

```
A2 will sofort senden (z.B. User tippt sofort nach Add-Device):
  ensureMyGSK(g.id, members) → getMyGSK → null
  → fetchMyGSKFromKV(g.id) → null (kein anderes A-Device hat GSK gepusht)
  → createMyGSK(g.id) → frische GSK G_A2 generiert
  → distributeMyGSKToMembers(g.id, G_A2, [bertha, charlie, ...])
  → storeMyGSKForOwnDevices(g.id, G_A2)

→ Im Endeffekt: A2 nutzt eine eigene frische GSK statt der von A1.
  Ist OK — Sender-Keys-Pattern erlaubt jedem Device eine eigene GSK,
  solange alle Empfänger sie kennen. distributeMyGSKToMembers stellt
  das sicher.

Open Question: Soll A2 lieber WARTEN bis Re-Distribution von A1
ankommt? → Nein. Forward Secrecy ist besser, wenn neue Devices
eine eigene GSK haben. Trade-off: minimal mehr Bandwidth bei
distribution, aber strikt sicherer (kompromittiertes A1-GSK
gefährdet A2-Sends nicht).
```

### 4.4 Member-Add (bestehend, hier zur Vollständigkeit)

```
Daniel wird zur Gruppe "Devs" hinzugefügt:
Backend → all members    : WS group_member_joined {member:'daniel'}

Bertha receives group_member_joined:
  → KEIN expliziter GSK-Push (current behavior)
  → Daniel triggert beim ersten Decrypt-Versuch sendRequestGSK('bertha')
  → Bertha antwortet via handleIncomingRequestGSK
       → sendMyGSKToMember('Devs', myGsk, 'daniel')

Note: Forward Secrecy NICHT erforderlich beim Add (der neue Member
darf historische Encryption nicht lesen — Sender-Keys liefern das
automatisch, da Daniel pre-Add keinen GSK hatte und encrypteten
KV-Cache nicht entschlüsseln kann).
```

### 4.5 Member-Leave (bestehend, mit Multi-Device-Detail)

```
Charlie verlässt die Gruppe.
Backend → all members    : WS group_member_left {member:'charlie'}

Bertha receives group_member_left:
  → rotateMyGSK('Devs', updated_members)
       → createMyGSK('Devs')              ← neue GSK G_new
       → distributeMyGSKToMembers          ← an alle verbleibenden Members ALLE Devices
       → storeMyGSKForOwnDevices           ← für eigene B2, B3 ...

Charlie's lokal-cached G_old läuft ins Leere — zukünftige Messages
sind mit G_new encrypted, die Charlie nie sieht. Forward Secrecy ✅.
```

---

## 5. Edge-Cases

| # | Szenario | Behavior |
|---|---|---|
| E1 | Neues Peer-Device, ich habe keine eigene GSK in der Gruppe | Skip (keine GSK = kein Push nötig). Wenn ich später eine erstelle, läuft `distributeMyGSKToMembers` und erreicht alle Devices inkl. neues. |
| E2 | Neues Peer-Device, Peer ist NICHT in einer meiner Gruppen | `redistributeGSKsForPeerDeviceAdded` iteriert nur über meine Gruppen → wenn Peer kein Member ist, nichts passiert. |
| E3 | Self-Device-Add während Sync | KV-Eventual-Consistency: `_fetchUserDevicesEnsuring` retry mit Backoff (400ms → 800 → 1500 → 3000ms, dann Push-Fallback). Identisch zu DM-Pattern. |
| E4 | Device verloren + Recovery via Phrase | Recovery-Bundle (R2) enthält **eigene** GSKs via `collectMyGSKs` / `restoreMyGSKsFromBundle` ([`recovery.js:13`](../frontend/src/lib/recovery.js:13), [`cmkBundleSync.js:118`](../frontend/src/lib/cmkBundleSync.js:118)). Nach Phrase-Decrypt landet die historische My-GSK wieder in IDB → eigene Send-History bleibt entschlüsselbar. **Peer-GSKs sind NICHT im Bundle** — Empfangene Group-Messages werden via `request_gsk` re-fetched. Wenn auch KV leer (alle Devices verloren) und Bundle nicht restored: Device generiert frische GSK on-first-send → `distributeMyGSKToMembers`. |
| E5 | 2 Devices joinen gleichzeitig (z.B. Mac + iPhone in derselben Sekunde) | Beide bekommen device_added für den jeweils anderen. Beide rufen `storeMyGSKForOwnDevices` parallel. Idempotent: KV-Schreiben überschreiben sich nicht (separate Keys per deviceId). |
| E6 | Peer fügt Device hinzu UND verlässt Gruppe gleichzeitig | Race: device_added evtl. vor group_member_left. Entweder: meine GSK wird gewrapped für Peer-Device (das die Gruppe gleich verlässt) → harmlos (Peer-Device cached GSK kurz, rotateMyGSK gleich danach). Oder: rotateMyGSK läuft zuerst → Peer-Device bekommt nur die neue GSK, die es eh nicht mehr verwenden darf. Ex post sicher. |
| E7 | ENCRYPT_ROTATE_THRESHOLD erreicht während Peer-Device-Add | Beide Pfade laufen parallel: `sendEncryptedGroup` triggert `rotateMyGSK`, `device_added`-Handler triggert `redistributeGSKsForPeerDeviceAdded`. `rotateMyGSK` ruft intern `distributeMyGSKToMembers` für ALLE Members → das neue Peer-Device wird inkludiert via `_fetchUserDevices` (idempotent). Doppel-Send ist akzeptabel. |
| E8 | request_gsk von neuer eigener Device (Recovery-Pfad) | `handleIncomingRequestGSK` checkt `requestedFrom !== me` → würde abbrechen. Korrektes Verhalten: neue eigene Device ruft stattdessen `fetchMyGSKFromKV(groupId)` direkt. Kein expliziter request_gsk-Pfad für own-device nötig. |

---

## 6. Test-Matrix

### 6.1 Vitest Unit-Tests (Phase 1C, neu)

| Test | Datei | Was wird getestet |
|---|---|---|
| `_fetchUserDevicesEnsuring retry` | `tests/groupCrypto.test.js` | Bei expectedDeviceId nicht in KV → retry → eventually contains; nach max-retries Fallback mit jwk |
| `redistributeGSKsForPeerDeviceAdded skips empty groups` | `tests/groupCrypto.test.js` | Wenn keine GSK lokal: skip ohne Fehler |
| `redistributeGSKsForPeerDeviceAdded calls sendMyGSKToMember per shared group` | `tests/groupCrypto.test.js` | Mit 3 gemeinsamen Gruppen → 3× `sendMyGSKToMember` mit korrekten groupIds |
| `storeMyGSKForOwnDevices with newDeviceInfo retries` | `tests/groupCrypto.test.js` | Mock _fetchUserDevices: 1. Call ohne neuen Device, 2. Call mit → wrap enthält neues Device |
| **5×5 Stress** | `tests/groupCrypto.test.js` | 5 Members × 5 Devices → 1 Member fügt 6. Device hinzu → resultierender wrap-Count = 5×5 + 4 (Sender-Side) |

### 6.2 Manuell-Integration (Phase 1C-Abschluss)

| Szenario | Steps | Expected |
|---|---|---|
| Anna fügt 2. Device hinzu | Anna A1, Bertha B1 in Group "Devs". Anna joinst mit A2. Bertha sendet "hello" in Group. | A1, A2 sehen "hello" lesbar. Anna sendet von A2 → A1 + Bertha lesbar. |
| 5-Member, 1 fügt 5. Device hinzu | 5 Members × ø 1 Device, Anna fügt A2-A5 hinzu. Jeder sendet 1 Msg. | 5×5=25 Decrypts, alle ✅. |
| Self-Device-Add mit GSK | Bertha B1 hat GSK in 3 Gruppen. Joinst mit B2 (Inkognito). | B2 fetched 3 GSKs aus KV, kann in allen 3 Gruppen sofort Decrypts machen. |
| Peer-Device-Add während Bertha senden ist | Anna joinst A2 während Bertha message sendet. | A2 erhält Bertha's GSK via redistribute, kann nachfolgende Messages lesen. |

### 6.3 Akzeptanzkriterien

- ✅ Vitest 5×5-Test grün
- ✅ Manuelle Multi-Device-Tests in 4 Szenarios (siehe 6.2) grün
- ✅ 0 `[E2E:DECRYPT] permanent_fail` in Sentry über 7 Tage Dogfooding
- ✅ `redistributeGSKsForPeerDeviceAdded` Latenz < 2s bei 5 gemeinsamen Gruppen

---

## 7. Decision Log

| Datum | Entscheidung | Optionen | Pick | Rationale |
|---|---|---|---|---|
| 2026-05-10 | Wer triggert GSK-Re-Wrap bei Peer-Device-Add | (A) Frontend pro Member | (B) Backend broadcast / (C) On-demand request_gsk | **A** | Konsistent mit DM-Pattern (CMK-Redistribute), Backend bleibt zero-knowledge. |
| 2026-05-10 | Race-Schutz: Wait-or-Retry-or-Fork | (A) Wait für Sync / (B) Retry mit Backoff / (C) Fork eigene GSK | **B** | Deterministisch, getestet bei DM. Fork (C) wäre OK für neue Devices, aber unnötig wenn KV propagiert. |
| 2026-05-10 | Backend-Endpoint für „gemeinsame Gruppen" | (A) Client-side filter / (B) Neuer Endpoint | **A** | Vermeidet Backend-Schema-Änderung. Skaliert bis ~50 Gruppen × 50 Members. Phase 1D wenn Performance-Issue. |
| 2026-05-10 | GSK in Recovery-Bundle? | (A) Eigene GSKs ja, Peer-GSKs nein / (B) Beide / (C) Keine | **A** *(bestehend, dokumentiert)* | Eigene GSK = own Send-History bleibt nach Recovery lesbar. Peer-GSK NICHT — die kommt via `request_gsk` neu, vermeidet Bundle-Bloat bei großen Gruppen. Implementiert in `cmkBundleSync.js:118`+. |
| 2026-05-10 | request_gsk auch für own-devices? | (A) Ja, mit me-allow / (B) Nein, nur fetchMyGSKFromKV | **B** | Saubere Trennung: own-devices via KV (low-latency, keine Fan-Out-Last), peer-devices via chatSend control. |

---

## 8. API-Surface (Delta)

Keine Backend-API-Änderungen. Frontend-Modul-Surface:

| Funktion | Datei | Status |
|---|---|---|
| `_fetchUserDevicesEnsuring(handle, expectedDeviceId?, expectedJwk?)` | `frontend/src/lib/groupCrypto.js` | **neu (private)** |
| `storeMyGSKForOwnDevices(groupId, gsk, newDeviceInfo?)` | `frontend/src/lib/groupCrypto.js` | **erweitert** — optionaler 3. Parameter |
| `redistributeGSKsForPeerDeviceAdded(myHandle, peerHandle, newDeviceInfo)` | `frontend/src/lib/groupCrypto.js` | **neu (export)** |

**Konvention:** `newDeviceInfo` ist `{fromHandle, deviceId, jwk}` — exakt das Shape, das auch `redistributeCMKToPeer` benutzt. Beide Pfade (DM + Group) teilen sich Format und Retry-Semantik.

---

**Diese Spec ist verbindlich für Phase 1C.**
**Bei Code-Änderungen am GSK-Layer: hier reinschauen.**
**Bei Spec-Konflikt mit MULTI_DEVICE.md: GROUPS_MULTIDEVICE.md gewinnt für Group-Themen, MULTI_DEVICE.md für DM-Themen.**
