# RENEX — Changelog

Format: [Keep a Changelog](https://keepachangelog.com/de/1.1.0/) ⋅ Daten in `YYYY-MM-DD`.

---

## 2026-05-10 — Phase 1C: Group-Multi-Device Re-Distribution

GSK-Layer nachgezogen für vollwertiges Multi-Device. DM-Multi-Device war
seit 2026-04-30 fertig, Group-Sender-Keys (GSK) hatten zwei Lücken:
Peer-Device-Add löste keine GSK-Re-Wrap aus, und Self-Device-Add hatte
keinen Race-Schutz gegen KV-Eventual-Consistency.

### ✨ Added

**`redistributeGSKsForPeerDeviceAdded`** (`frontend/src/lib/groupCrypto.js`)
- Neue Funktion. Wird vom `device_added(peer)`-Handler in `App.svelte`
  gerufen wenn ein Kontakt ein neues Device hinzufügt.
- Iteriert über alle eigenen Gruppen, prüft per `/groups/members` ob
  Peer Member ist, und re-sendet die eigene GSK an alle Peer-Devices
  (inkl. das neue) via `sendMyGSKToMember`.
- Konsequenz: Neues Peer-Device kann meine zukünftigen Group-Messages
  sofort decrypten — ohne auf nächste Rotation oder manuellen
  `request_gsk` warten zu müssen.

**`_fetchUserDevicesEnsuring`** (private, `frontend/src/lib/groupCrypto.js`)
- Backoff-Retry-Variante von `_fetchUserDevices`: prüft ob ein
  erwartetes Device im KV-Index ist, retried mit
  400ms → 800ms → 1500ms → 3000ms-Backoff, fällt auf Push-Info
  (`expectedJwk`) zurück wenn KV nie propagiert.
- Identisches Pattern wie `fetchPeerDevicesEnsuring` in chatPipeline.js
  (DM-Pendant).

### 🐛 Fixed

**Race in `storeMyGSKForOwnDevices`**: bei `device_added(self)` wurde
`_fetchUserDevices(me)` direkt aufgerufen — wenn KV-Index am Empfänger-
Edge noch nicht propagiert war, fehlte das gerade hinzugekommene Device
in der Wrap-Liste, was beim Boot des neuen Devices zu fehlender GSK
führte. Funktion akzeptiert jetzt optionalen `newDeviceInfo`-Parameter
für Retry-Logik.

**Race in `sendMyGSKToMember`**: analog für Peer-Side. Bei
Peer-Device-Add konnte das gerade hinzugekommene Device fehlen.
`newDeviceInfo`-Parameter dürchgereicht, retry bis es im Index ist.

### 🔒 Security / Architecture

- **Backend zero-knowledge bleibt**: Re-Distribution läuft komplett
  client-seitig via bestehender `/chat/send` (gsk-Control) und
  `/e2e/group-gsk/store`-Endpoints. Keine Backend-API-Änderung.
- **Forward Secrecy intakt**: Wenn ein neues Device sofort sendet
  bevor die Re-Distribution ankommt, generiert es eine eigene frische
  GSK statt die alte zu verwenden — keine Schlüssel-Wiederverwendung
  zwischen Devices ausserhalb der KV-Restore-Pfads.
- **Recovery-Bundle**: Eigene GSKs sind seit 2026-04-30 im
  R2-Recovery-Bundle (`collectMyGSKs` / `restoreMyGSKsFromBundle`),
  Peer-GSKs nicht — die kommen via `request_gsk` neu (Bundle-Bloat-
  Vermeidung). Dokumentiert in [`GROUPS_MULTIDEVICE.md`](./GROUPS_MULTIDEVICE.md) §5.

### 🧪 Tests (alle ✅)

8 neue Vitest-Tests in `tests/groupCrypto.test.js`:

| # | Test | Was wird abgedeckt |
|---|---|---|
| 1 | `storeMyGSKForOwnDevices ohne newDeviceInfo` | Backwards-compat — kein retry-Pfad |
| 2 | `storeMyGSKForOwnDevices mit newDeviceInfo retried` | Self-Device-Add Race-Schutz, Mock simuliert KV-Eventual-Consistency |
| 3 | `storeMyGSKForOwnDevices Push-Fallback` | KV propagiert nie → Push-Info wird in Cache gemerged |
| 4 | `redistributeGSKsForPeerDeviceAdded noop` | Empty groups list |
| 5 | `redistributeGSKsForPeerDeviceAdded me === peer` | Defensive guard |
| 6 | `redistributeGSKsForPeerDeviceAdded skipt ohne lokale GSK` | 0 chat/send Calls wenn kein eigener GSK |
| 7 | `redistributeGSKsForPeerDeviceAdded skipt ohne Peer-Membership` | Members-API filtert |
| 8 | `redistributeGSKsForPeerDeviceAdded sendet pro gemeinsamer Gruppe` | 2 gemeinsame Gruppen → 2 chat/send |
| 9 | **5×5 Stress** | 5 Members × 5 Devices, 6. Peer-Device → wrap-Count = 6 |

Total Test-Suite: 73 Tests in `groupCrypto.test.js`, alle grün.

### Geänderte Dateien

- `frontend/src/lib/groupCrypto.js` — `_fetchUserDevicesEnsuring`,
  `storeMyGSKForOwnDevices(..., newDeviceInfo)`,
  `sendMyGSKToMember(..., newDeviceInfo)`,
  `redistributeGSKsForPeerDeviceAdded`
- `frontend/src/App.svelte` — Self-Hook reicht `newDeviceInfo` durch,
  Peer-Hook ruft `redistributeGSKsForPeerDeviceAdded`
- `tests/groupCrypto.test.js` — neuer Multi-Device-describe-Block
- `docs/GROUPS_MULTIDEVICE.md` — neu (Phase 1C-Spec)
- `docs/MULTI_DEVICE.md` §13 — Open Items aktualisiert
- `docs/VISION.md` Anhang B — Decision-Log-Eintrag 2026-05-10

---

## 2026-05-02 — Security Defense-in-Depth (L1, L2, L3)

Drei kosmetische Härtungen am Krypto-Layer. Keine bekannten Exploits — die
Änderungen sind defense-in-depth, falls Implementierungen in anderen Layern
mal Bugs haben sollten.

### 🔒 Hardened

**L1 — HKDF info per-peer für DeviceStorageKey** (`frontend/src/lib/cmk.js`)
- Vorher: `info = "renex:storage:<me>"` — alle CMKs eines Users wurden mit
  demselben Storage-Key verschlüsselt.
- Nachher: `info = "renex:storage:<me>:<peer>"` — jede CMK hat einen
  eigenen, peer-gebundenen Storage-Key.
- Falls ein Storage-Key irgendwie geleakt wird: nur die zugehörige
  Peer-Konversation ist exponiert, nicht alle anderen.
- Migration: 3-Layer-Fallback (per-peer → legacy per-user → legacy global)
  beim Read. Re-Encrypt mit per-peer Key on-the-fly.

**L2 — AAD in Bundle-Encryption** (`frontend/src/lib/recovery.js`)
- AES-GCM-Bundles sind jetzt mit AAD = `"renex:bundle:<handle>"` gebunden.
- Verhindert, dass ein Bundle z.B. unter dem masterKey eines anderen Users
  decryptet werden könnte (auch bei RNG-Salt-Kollision).
- `bundle.v` Field signalisiert Format: v=2 mit AAD, v=1 ohne (legacy).
- Bei Decrypt: zuerst v=2 + AAD versucht, fallback v=1 ohne AAD.
- Auto-Sync upgraded Legacy-Bundles bei nächstem CMK-Change automatisch zu v=2.

**L3 — Documentation + Comments**
- `cmk.js`: Comment über IV-Birthday-Bound (2^48 Encryptions) und
  Rotations-Erwartung. Bei realistischem Volume nicht erreichbar.
- Auto-Rotate-Mechanismus deferred zu Phase 1C (z.B. nach 2^32 Encryptions
  pro Key). Aktuell kein Risk.

### Geänderte Dateien

- `frontend/src/lib/cmk.js` — getDeviceStorageKey nimmt peerHandle, 3-Layer-Migration
- `frontend/src/lib/recovery.js` — encryptBundle/decryptBundle mit optional handle/AAD
- `frontend/src/lib/cmkBundleSync.js` — handle-AAD bei encrypt + decrypt
- `frontend/src/components/RecoveryOnboardingModal.svelte` — handle-AAD bei encryptBundle
- `frontend/src/components/RecoveryVerifyModal.svelte` — handle-AAD bei decryptBundle
- `frontend/src/components/RecoveryLoginModal.svelte` — handle-AAD bei decryptBundle

---

## 2026-04-30 — E2E-Recovery & Multi-Device Hardening

Vollständige Härtung des E2E-Recovery-Flows: vom CMK-Verteilungspfad über Bundle-Backup
in R2 bis zum Phrase-Restore in IndexedDB. End-to-end getestet mit Multi-Device-Setup
(Mac × 2 Tabs + iPhone) inkl. Doomsday-Szenario (beidseitiger Storage-Verlust).

### 🐛 Fixed

- **CMK-Verteilung**: `redistributeCMKToPeer` lieferte stillschweigend `ok:true` selbst
  wenn die lokale CMK fehlte. Empfänger eines `cmk_req` retried daher endlos.
  Jetzt: explizites `cmk_unavailable`-Signal an den Peer + Frontend zeigt klar
  „🔓✗ Nicht entschlüsselbar (Schlüssel verloren)" mit roter Bubble.
- **Decrypt-Retry-Loops** ohne Backoff verursachten 429-Bursts bei Cloudflare.
  Neu: Exponential Backoff (3s → 8s → 25s → 60s, max 4 Versuche), Pause-on-pending
  und Skip-on-unavailable.
- **18 parallele KV-Fetches** beim Öffnen eines Chats mit n Messages → 429.
  Single-Flight-Coalescing für `tryFetchAndUnwrapCMK` und `fetchPeerDevices`:
  18 gleichzeitige Aufrufer teilen sich jetzt **einen** Netzwerk-Call.
- **Endlos-Loop in RecoveryOnboardingModal** wenn `cacheMasterKey` für brand-neue
  User scheiterte (`device_secret` noch nicht in IDB) — caused 4× 409 → 429-Storm.
  Fix: `getOrInitDeviceSecret` initialisiert lazy + Stop-Condition gegen Re-Trigger
  + nicht-fataler try/catch um den Cache-Step.
- **RecoveryLoginModal unmountete** nach erfolgreicher Passkey-Auth (war innerhalb
  LoginModal verschachtelt → LoginModal verschwand sobald `myUser` gesetzt → Step 2
  nie sichtbar). Modal jetzt auf App-Level + `onRecoveryClick`-Callback aus LoginModal.
- **Black-Screen nach Phrase-Recovery**: `sessionStore.check()` fehlte nach Step-1-Auth,
  daher blieb State auf `anonymous` → `showApp` false → leerer Bildschirm bis Reload.
- **Stale `cmk_unavailable` markierte fertig recoverte Sessions als unrecoverable**:
  verzögerte Race-Messages konnten nach Bundle-Restore ankommen und den Flag setzen.
  Jetzt ignoriert wenn lokale CMK existiert + Auto-Cleanup bei jedem `decrypt OK`.
- **`recovery_master_key` IDB-Key war nicht per-User-skoped**: User A's MasterKey wurde
  von User B's Login überschrieben (selber Browser, mehrere User). Jetzt unter
  `recovery_master_key:<handle>` mit Legacy-Migration beim ersten Zugriff.
- **Sig-Verify Coverage**: vorher nur Peer-Messages verifiziert. Jetzt auch eigene
  Multi-Device-Messages (skip nur eigenes current Device). Cache-Miss → Fallback-fetch
  von peer-devices. Tampering wird in der UI (rote Bubble + Warnbanner) sichtbar.
- **Verified-State im Decrypt-Cache**: Cache speicherte nur `text` → bei Re-Decrypt
  (z.B. nach `device_added`) wurde `verified=null` ans Message-Objekt gepatcht und
  überschrieb vorhandene `true`/`false`-Werte. Cache hält jetzt `{text, verified}`.

### ✨ Added

- **CMK Auto-Sync nach R2** (`cmkBundleSync.js`): bei jedem `createAndStoreCMK` /
  `importAndStoreCMKFromPeer` läuft ein debounced (5s) Bundle-Push.
  Encryption mit cached MasterKey (PBKDF2 aus BIP39-Phrase). Logs:
  `☁️ Bundle synced (N CMKs)`.
- **CMK-Restore aus Bundle** (`restoreCmksFromBundle`): in RecoveryLoginModal Step 3
  und RecoveryVerifyModal werden alle CMKs aus dem Bundle in die lokale IndexedDB
  importiert. Plus `bootstrapBundleRestore` beim App-Start für Auto-Recovery wenn
  MasterKey gecached aber CMKs lokal fehlen.
- **Proactive `cmk_req` beim Chat-Open** (`_kickCmkAcquisitionIfNeeded`): wenn beim
  Öffnen eines Chats keine lokale CMK existiert + Messages sind 🔒, schickt das
  Frontend nach 1.5s aktiv einen `cmk_req`. Reduziert Wartezeit von ~36s auf ~3s
  bevor History via Peer-Redistribute lesbar wird.
- **MasterKey-Cache** (`masterKey.js`): Cached der aus der Phrase abgeleitete
  MasterKey unter Device-Storage-Key in IndexedDB → Bundle-Auto-Sync läuft ohne
  erneute Phrase-Eingabe. Per-handle-skoped, in-memory `Map<handle, Bytes>`.
- **`cmk_unavailable` als Backend-Control-Type**: in `chatSend.js` als gültiger
  Type whitelisted (kein D1-Insert, kein Self-Push, eigener Rate-Limit-Bucket).
- **Tampering-UI** in `MessageBubble.svelte`: bei `verified === false` rote Border
  + Warnbanner ⚠️ „Signatur ungültig — Manipulation möglich" mit Hover-Tooltip.

### 🔒 Security / Architecture

- **Gleiche Krypto-Garantien wie Signal**: ein User kann ALLE Geräte verlieren und
  mit BIP39-Phrase + Passkey wiederherstellen. Server kann zu keinem Zeitpunkt
  Klartext-Messages lesen — Bundle ist client-side encrypted bevor R2-Upload.
- **Divergenz-Schutz bleibt erhalten**: `ensureSecureDmSession` erstellt KEINE
  neue CMK wenn Chat-Historie existiert aber CMK fehlt — würde sonst die existierende
  CMK von der Gegenseite konkurrenzieren.
- **2-Faktor-Recovery**: Passkey allein reicht nicht (kein E2E-Schlüssel-Material),
  Phrase allein reicht nicht (kein Account-Auth). Beides nötig.

### 🧪 Test-Matrix (alle ✅)

| # | Szenario | Status |
|---|----------|--------|
| 1 | Tab 1 (christa) → Tab 2 + anna sehen lesbar | ✅ |
| 2 | Tab 2 → Tab 1 + anna lesbar | ✅ |
| 3 | anna → Tab 1 + Tab 2 lesbar | ✅ |
| 4 | Reload aller 3 Tabs → komplette History dekryptet | ✅ |
| 5 | Drittes Device (Tab 3) joint → kann komplette History lesen + senden | ✅ |
| 6 | Beidseitiger Storage-Verlust → `cmk_unavailable` + UI-Indikator | ✅ |
| 6.3 | Phrase-Recovery in Inkognito → CMKs aus R2-Bundle in IDB → History lesbar | ✅ |
| 7 | Frische Konversation ohne Race-Condition beim ersten Send | ✅ |
| 8 | Race-Condition: beide Seiten senden simultan ohne CMK | ✅ |
| 9 | Sig-Verify Coverage (eigene Multi-Device + Tampering-Detection) | ✅ |

### Geänderte Dateien

**Frontend (`frontend/src/`):**
- `App.svelte` — RecoveryLoginModal lift, bootstrapBundleRestore-Hook, cmk_unavailable-Handler-Guard
- `lib/chatPipeline.js` — Single-Flight, sendCmkUnavailable, Sig-Verify-Coverage, verified-im-Cache
- `lib/cmkBundleSync.js` — **neu** — Auto-Sync + Restore + Bootstrap-Hook
- `lib/cmkRequestState.js` — **neu** — geteilte Pause-/Unavailable-Flags (vermeidet circular import)
- `lib/masterKey.js` — **neu** — per-User MasterKey-Cache mit Migration
- `lib/cmk.js` — Hook in `importAndStoreCMKFromPeer` für scheduleBundleSync
- `lib/idb.js` — `idbListKeys(prefix)` für CMK-Iteration
- `lib/recovery.js` — `deriveMasterKeyRaw` + 409-Status durchreichen
- `stores/chat.svelte.js` — Backoff, Pause-on-pending, _kickCmkAcquisitionIfNeeded, markCmkUnavailable
- `components/RecoveryLoginModal.svelte` — sessionStore.check, restoreCmksFromBundle in Step 3
- `components/RecoveryVerifyModal.svelte` — cacheMasterKey + restoreCmksFromBundle
- `components/RecoveryOnboardingModal.svelte` — non-fatal cacheMasterKey + Stop-Condition + 409-Match
- `components/LoginModal.svelte` — `onRecoveryClick` Prop, RecoveryLoginModal raus
- `components/MessageBubble.svelte` — Tampering-UI

**Backend (`src/`):**
- `helpers/chatSend.js` — `cmk_unavailable` Control-Type whitelisted
