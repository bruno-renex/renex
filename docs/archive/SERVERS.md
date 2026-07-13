# RENEX — Servers & Channels Spec (Phase 3A)

> **Phase 3A Architecture** (Text-First, ~4 Wochen)
> Server- und Channel-Modell als „Discord-Killer"-Layer.
> Setzt auf bestehender Multi-Device-Krypto-Pipeline auf ([`MULTI_DEVICE.md`](./MULTI_DEVICE.md), [`GROUPS_MULTIDEVICE.md`](./GROUPS_MULTIDEVICE.md)).
> Voice/Video-Channels: **deferred zu Phase 8** (post-Beta, gemeinsam mit Signal Protocol als v2.0). Separate Spec [`VOICE.md`](./VOICE.md) *(TBD post-Beta)*.

**Status:** Draft v1.0 — alle Decisions geklärt 2026-05-13, ready for Implementation
**Version:** 1.0
**Letzte Aktualisierung:** 2026-05-13
**Autor:** Bruno Hochstrasser

---

## Inhaltsverzeichnis

1. [Glossar & Recap](#1-glossar--recap)
2. [Datenmodell](#2-datenmodell)
3. [Server-Lifecycle](#3-server-lifecycle)
4. [Channel-Modell](#4-channel-modell)
5. [Roles & Permissions](#5-roles--permissions)
6. [API-Surface](#6-api-surface)
7. [Multi-Device-Implikationen](#7-multi-device-implikationen)
8. [Limits & Pro-Tier](#8-limits--pro-tier)
9. [Migration-Pfad](#9-migration-pfad)
10. [Decision Log](#10-decision-log)
11. [Offene Items](#11-offene-items)

---

## 1. Glossar & Recap

| Begriff | Bedeutung |
|---|---|
| **Server** | Workspace/Hub mit eigenem Namen, Icon, eigener Member-Liste und mehreren Channels. Analogon: Discord-„Server" / Slack-„Workspace". |
| **Channel** | Konversations-Sub-Space innerhalb eines Servers. Hat einen `kind` (`text` / `voice`), eine eigene Message-History und optional eingeschränkte Sichtbarkeit. |
| **Server-Member** | User mit Eintrag in `server_members`. Sieht den Server in seiner Sidebar. Hat 0..n Roles. |
| **Channel-Member** | Bei `kind='text'` mit Public-Channels: implizit = alle Server-Members. Bei Private-Channels: explizit via `conversation_members`. |
| **Role** | Benannte Gruppe von Permissions + Farbe + Position. Wird Members zugewiesen. Multi-Role-fähig (Discord-Pattern). |
| **Permission** | Atomare Berechtigung im Bitfield (z.B. `SEND_MESSAGES`, `MANAGE_CHANNELS`). |
| **Owner** | User mit `role = 'owner'` in `server_members`. Genau **einer** pro Server, bypassed alle Permissions. |
| **Standalone-Group** | Eine `conversation` mit `type='group'` und `server_id IS NULL` — das alte Phase-1-Konzept, bleibt erhalten. |

**Abgrenzung zu Phase-1-Groups:** Bestehende Standalone-Groups (`conversation.type='group'`) bleiben funktional. Server sind ein **zusätzliches** Konstrukt, keine Ablösung. Siehe §9 für Koexistenz.

---

## 2. Datenmodell

### 2.1 Neue Tabellen

```sql
-- Server = Workspace mit eigener Member-Liste + N Channels
CREATE TABLE IF NOT EXISTS servers (
  id            TEXT    PRIMARY KEY,         -- UUID v4
  name          TEXT    NOT NULL,
  description   TEXT,
  icon_r2_key   TEXT,                        -- R2-Key, Pro-Feature
  visibility    TEXT    NOT NULL DEFAULT 'invite', -- 'invite' | 'private' (Phase 4: 'public')
  custom_slug   TEXT    UNIQUE,              -- renex.id/<slug>, Pro-Feature
  created_at    INTEGER NOT NULL,
  created_by    TEXT    NOT NULL,            -- Owner-Handle (initial; transferable)
  member_limit  INTEGER NOT NULL DEFAULT 500 -- Free=500, Pro=5000 (Tier-abhängig)
);

CREATE INDEX IF NOT EXISTS idx_servers_owner ON servers(created_by);
CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_slug ON servers(custom_slug)
  WHERE custom_slug IS NOT NULL;

-- Membership: ein User pro Server, mit Server-spezifischem Nickname
CREATE TABLE IF NOT EXISTS server_members (
  server_id    TEXT    NOT NULL,
  user_handle  TEXT    NOT NULL,
  nickname     TEXT,                          -- NULL = User-Handle anzeigen
  joined_at    INTEGER NOT NULL,
  is_owner     INTEGER NOT NULL DEFAULT 0,    -- 1 = Owner (genau einer pro Server)
  PRIMARY KEY (server_id, user_handle),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_server_members_user
  ON server_members(user_handle);

-- Roles pro Server (Discord-style, Multi-Role)
CREATE TABLE IF NOT EXISTS server_roles (
  id            TEXT    PRIMARY KEY,         -- UUID v4
  server_id     TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  color         TEXT,                         -- Hex '#ef4444', NULL = default
  permissions   INTEGER NOT NULL DEFAULT 0,   -- Bitfield (siehe §5.2)
  position      INTEGER NOT NULL DEFAULT 0,   -- Sortierung (höher = mächtiger)
  is_default    INTEGER NOT NULL DEFAULT 0,   -- 1 = auto-assign beim Join (genau eine pro Server)
  is_mentionable INTEGER NOT NULL DEFAULT 0,  -- 1 = @rolename funktioniert
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_server_roles_server
  ON server_roles(server_id, position DESC);

-- M:N — welcher User hat welche Roles
CREATE TABLE IF NOT EXISTS role_assignments (
  server_id    TEXT    NOT NULL,
  user_handle  TEXT    NOT NULL,
  role_id      TEXT    NOT NULL,
  assigned_at  INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_handle, role_id),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES server_roles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_role_assignments_user
  ON role_assignments(server_id, user_handle);

-- Channel-spezifische Permission-Overrides (pro Channel pro Role/Member)
-- Discord-Pattern: erlaubt private Channels und feingranulare Kontrolle
CREATE TABLE IF NOT EXISTS channel_permission_overrides (
  channel_id   TEXT    NOT NULL,             -- = conversations.id
  target_kind  TEXT    NOT NULL,             -- 'role' | 'member'
  target_id    TEXT    NOT NULL,             -- role_id ODER user_handle
  allow_bits   INTEGER NOT NULL DEFAULT 0,   -- erzwungene Erlaubnis (bitwise)
  deny_bits    INTEGER NOT NULL DEFAULT 0,   -- erzwungenes Verbot (bitwise, gewinnt)
  PRIMARY KEY (channel_id, target_kind, target_id)
);

CREATE INDEX IF NOT EXISTS idx_chan_perm_overrides_channel
  ON channel_permission_overrides(channel_id);

-- Audit-Log für Moderations-Aktionen (Kick, Ban, Role-Change, Channel-Delete).
-- Bewusst NICHT pro Message (zu viel Volumen). Aufbewahrungszeit: 90 Tage,
-- Cron räumt auf. Schweizer Datenschutz: User hat Auskunftsrecht auf
-- Einträge wo er actor oder target ist.
CREATE TABLE IF NOT EXISTS server_audit_log (
  id           TEXT    PRIMARY KEY,         -- UUID v4
  server_id    TEXT    NOT NULL,
  actor        TEXT    NOT NULL,            -- wer hat es gemacht
  action       TEXT    NOT NULL,            -- 'member_kick' | 'member_ban' | 'role_assign' | 'role_revoke' | 'role_create' | 'role_delete' | 'channel_create' | 'channel_delete' | 'permissions_update' | 'server_transfer'
  target       TEXT,                         -- target user_handle ODER channel_id ODER role_id
  details_json TEXT,                         -- frei strukturiertes JSON (z.B. {oldRole:..., newRole:...})
  ts           INTEGER NOT NULL,
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audit_server_ts
  ON server_audit_log(server_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_audit_actor
  ON server_audit_log(server_id, actor, ts DESC);

CREATE INDEX IF NOT EXISTS idx_audit_target
  ON server_audit_log(server_id, target, ts DESC);
```

### 2.2 Erweiterungen an bestehenden Tabellen

```sql
-- conversations: zusätzliche Spalten für Channel-Kontext
-- D1 unterstützt ALTER TABLE ADD COLUMN, daher kein Rebuild nötig.
ALTER TABLE conversations ADD COLUMN server_id     TEXT;    -- NULL für DM/Standalone-Group
ALTER TABLE conversations ADD COLUMN channel_kind  TEXT;    -- 'text' | 'voice' | NULL
ALTER TABLE conversations ADD COLUMN position      INTEGER DEFAULT 0; -- Sidebar-Sortierung
ALTER TABLE conversations ADD COLUMN topic         TEXT;    -- Channel-Topic
ALTER TABLE conversations ADD COLUMN parent_id     TEXT;    -- Phase 4: Channel-Categories

-- conversations.type wird erweitert um neuen Wert:
--   'dm' (bestehend) | 'group' (bestehend, Standalone) | 'channel' (NEU)
-- 'channel' impliziert server_id IS NOT NULL und channel_kind IS NOT NULL.

CREATE INDEX IF NOT EXISTS idx_conv_server
  ON conversations(server_id, position ASC)
  WHERE server_id IS NOT NULL;
```

### 2.3 Invarianten

| Invariante | Enforcement |
|---|---|
| Genau ein Owner pro Server | App-Layer: bei Create-Server INSERT mit `is_owner=1`. Bei Transfer: Transaktion mit UPDATE 0 → 1 + 1 → 0. |
| `channel_kind` ist genau dann gesetzt, wenn `type='channel'` | App-Layer-Check in Create-Channel-Endpoint. |
| `server_id` ist genau dann gesetzt, wenn `type='channel'` | dito. |
| Default-Role genau einmal pro Server | UNIQUE-Constraint via Partial Index (siehe Migration). |
| Permissions-Bitfield nutzt nur definierte Bits | App-Layer-Mask vor INSERT. |

```sql
-- Partial-UNIQUE-Index für Default-Role
CREATE UNIQUE INDEX IF NOT EXISTS idx_server_roles_default
  ON server_roles(server_id) WHERE is_default = 1;
```

---

## 3. Server-Lifecycle

### 3.1 States

```
CREATED       → frisch erstellt, hat Owner + Default-Role + General-Channel
ACTIVE        → mind. 1 Member online in letzten 30d
DORMANT       → keine Aktivität > 30d (nur Marker, kein Daten-Verlust)
DELETED       → CASCADE-Delete via servers.id (entfernt server_members, server_roles,
                 role_assignments, channel_permission_overrides, conversations
                 mit server_id, deren conversation_members, messages)
```

State ist derived (kein Spalten-Feld), berechnet aus `MAX(last_seen)` der Members.

### 3.2 Create-Server-Flow

1. User `bertha004` ruft `POST /servers/create { name, description? }`.
2. Backend:
   - INSERT `servers` row (UUID-id, created_by=bertha004).
   - INSERT `server_members` (bertha004, is_owner=1).
   - INSERT `server_roles` Default („everyone") mit `permissions = VIEW_CHANNEL | SEND_MESSAGES | VOICE_CONNECT | VOICE_SPEAK`.
   - INSERT `role_assignments` (bertha004 → everyone).
   - INSERT `conversations` Default-Channel (id=UUID, type='channel', server_id=..., channel_kind='text', name='general', position=0).
   - Antwort: `{ ok:true, serverId, defaultChannelId, defaultRoleId }`.
3. WS-Push `server_created` an alle bertha004-Devices.

**Atomicity:** D1-Transaktion über alle 5 INSERTs. Bei Fehler: kompletter Rollback.

### 3.3 Join-Flow

Member-Joins erfolgen ausschliesslich via **Invite-Link** (Phase 3) oder direktes Add durch Member mit `MANAGE_SERVER` (Phase 3.5).

```
1. Owner bertha004: POST /servers/<id>/invites/create
   → { token: "srv_inv_<32hex>", expiresAt, maxUses, role_id? }
2. Owner teilt Link: https://app.renex.id/i/srv_inv_<token>
3. Empfänger anna18 klickt Link → Frontend liest Token → POST /servers/<id>/join { token }
4. Backend validiert Token (TTL, Use-Count), INSERT server_members + role_assignments
   (default-role oder vom Owner gesetzte Initial-Role).
5. WS-Push server_member_joined an alle Server-Members.
```

Invite-Token sind in derselben `server_invites`-Tabelle wie bestehende Group-Invites (Wiederverwendung der Cron-Cleanup-Logik, siehe [`inviteRoutes.js`](../src/routes/inviteRoutes.js)).

### 3.4 Leave-Flow

```
1. Member: POST /servers/<id>/leave
2. Backend:
   - DELETE FROM server_members WHERE server_id=? AND user_handle=?
   - DELETE FROM role_assignments WHERE server_id=? AND user_handle=?
   - DELETE FROM conversation_members für alle Private-Channels in server_id
   - System-Message in #general: "anna18 hat den Server verlassen"
3. WS-Push server_member_left an alle verbleibenden Members.
```

**Owner-Leave-Edge-Case:**
- Falls Owner verlässt UND andere Members existieren → Transfer-Modal vorher erzwingen.
- Falls Owner verlässt UND keine anderen Members → Server wird DELETED (CASCADE).

**Account-Delete-Pre-Check** (Decision 2026-05-13):
Wenn ein User seinen RENEX-Account komplett löscht (`DELETE /auth/me`), erzwingt das
Backend einen Pre-Check: jeder Server in dem der User `is_owner=1` ist UND mindestens
einen weiteren Member hat blockiert die Account-Löschung mit Error `owner_transfer_required`.
Der User muss diese Server **zuerst transferieren oder verlassen** (Auto-Delete bei
Solo-Server ist OK). Konsistent mit RENEX-Privacy-Werten — User entscheidet bewusst
was mit seinen Daten passiert. Alternative (Auto-Transfer an oldest Member, Discord-Pattern)
verworfen wegen Überraschungs-Effekt.

### 3.5 Kick/Ban-Flow

- **Kick** (`KICK_MEMBERS`): `DELETE FROM server_members` + System-Message + kann wieder rein via neuem Invite.
- **Ban** (`BAN_MEMBERS`): zusätzlich INSERT in `server_bans` (TBD-Tabelle) → Re-Join blockiert.

Detail-Spec für Ban-System: deferred zu Phase 3.5.

---

## 4. Channel-Modell

### 4.1 Channel-Typen

| `channel_kind` | Beschreibung | Spec |
|---|---|---|
| `text` | Klassischer Text-Channel mit Message-History | diese Spec |
| `voice` | Drop-in-Voice-Channel, WebRTC SFU | [`VOICE.md`](./VOICE.md) *(TBD)* |
| `announcement` *(Phase 4)* | Read-only für Members, Write nur für `MANAGE_MESSAGES` | deferred |
| `forum` *(Phase 5)* | Thread-basiert, Discord-Forum-Style | deferred |

### 4.2 Channel-Sichtbarkeit

**Public-Channel (Default):**
- Alle Server-Members können den Channel sehen + posten.
- Keine Einträge in `channel_permission_overrides`.
- Keine Einträge in `conversation_members` (Membership ist derived = alle Server-Members).

**Private-Channel:**
- Sichtbar nur für explizite Members ODER Members mit Role, die `VIEW_CHANNEL` für diesen Channel hat.
- Einträge in `channel_permission_overrides` mit `target_kind='role'` ODER `target_kind='member'`.
- Optional: Einträge in `conversation_members` für individuelle Member-Adds.

### 4.3 Crypto-Modell

Pro Channel ein eigener **GSK-Pool** (wie bestehende Groups). Wiederverwendung von [`GROUPS_MULTIDEVICE.md`](./GROUPS_MULTIDEVICE.md) Pattern:

- Pro `(User, Channel)` ein My-GSK.
- Pro `(Me, Channel, Peer)` ein Peer-GSK lokal gecacht.
- GSK-Distribution bei Channel-Join via `request_gsk` Control-Message (existiert bereits).

**Wichtig — Recipient-Set:**
- Bei **Public-Channel**: Empfänger = alle `server_members` mit `VIEW_CHANNEL`-Permission (über Role-Aggregation).
- Bei **Private-Channel**: Empfänger = derived aus `channel_permission_overrides` + `conversation_members`.

**Recipient-Set-Cache (KV)** — kritisch für Send-Latency bei grossen Servern:
- KV-Key: `server_recipients:<channelId>` → JSON `{handles:[...], computedAt: <ms>}`
- TTL: 300s
- **Invalidation-Trigger** (Backend `DELETE` auf KV-Key):
  - `server_members` INSERT/DELETE (Member-Join/Leave/Kick/Ban)
  - `role_assignments` INSERT/DELETE
  - `server_roles` UPDATE auf `permissions`
  - `channel_permission_overrides` INSERT/UPDATE/DELETE
  - `conversations` UPDATE auf Channel (z.B. private → public)
- **Hit-Path** bei `/chat/send`:
  1. KV-Read `server_recipients:<channelId>`
  2. Wenn Hit → handles direkt nutzen für `pushToUserDO`-Fanout
  3. Wenn Miss → D1-Query `SELECT ... FROM server_members JOIN role_assignments ...` + KV-Write
- **Datenschutz:** Cache enthält nur Handles, keine Identifying-Info. Kein Konflikt mit Privacy-Werten.

Ohne diesen Cache: bei 500-Member-Server-Send würde jeder Message-Push eine 3-Way-JOIN-Query gegen D1 auslösen → 50-200ms Latency. Mit Cache: < 5ms.

### 4.4 Channel-Lifecycle-Events

| Event | Trigger | Side-Effects |
|---|---|---|
| `channel_created` | POST /servers/<sid>/channels | WS an alle Server-Members (Sidebar-Update) + Cache-Invalidation |
| `channel_renamed` | PATCH /servers/<sid>/channels/<cid> | WS, kein GSK-Rotation |
| `channel_deleted` | DELETE /servers/<sid>/channels/<cid> | CASCADE messages, GSK-Cleanup Frontend, Audit-Log |
| `channel_member_added` | POST /servers/<sid>/channels/<cid>/members | WS, neue Member → request_gsk, Cache-Invalidation |
| `channel_member_removed` | DELETE /servers/<sid>/channels/<cid>/members/<u> | WS, GSK-Rotation (Forward Secrecy), Cache-Invalidation |
| `channel_permissions_updated` | POST /servers/<sid>/channels/<cid>/permissions | WS an betroffene Members, Cache-Invalidation, Audit-Log |
| `server_member_joined` | POST /servers/<sid>/join | WS an alle Server-Members |
| `server_member_left` | POST /servers/<sid>/leave | WS, GSK-Rotation in Private-Channels wo Member war |
| `server_member_kicked` | POST /servers/<sid>/members/<u>/kick | WS, GSK-Rotation, Audit-Log |
| `server_member_banned` | POST /servers/<sid>/members/<u>/ban | dito + Ban-Eintrag |
| `member_role_assigned` | POST /servers/<sid>/members/<u>/roles | WS, Cache-Invalidation für betroffene Channels, Audit-Log |
| `member_role_revoked` | DELETE /servers/<sid>/members/<u>/roles/<rid> | dito, falls Permission-Loss → GSK-Rotation in Private-Channels |
| `role_created` | POST /servers/<sid>/roles | WS, Audit-Log |
| `role_updated` | PATCH /servers/<sid>/roles/<rid> | WS, Cache-Invalidation aller Channels wenn `permissions` geändert |
| `role_deleted` | DELETE /servers/<sid>/roles/<rid> | WS, Re-Assign betroffener Members zur Default-Role, Audit-Log |
| `server_renamed` / `server_icon_updated` | PATCH /servers/<sid> | WS, kein Crypto-Effekt |
| `server_transferred` | POST /servers/<sid>/transfer | WS, Audit-Log |

GSK-Rotation-Trigger sind **identisch** zu Phase-1C-Groups. Keine neuen Multi-Device-Code-Pfade nötig (siehe §7).

**Frontend-Reaktion auf WS-Events:** Sidebar-Liste, Channel-Liste, Member-Liste, Role-Editor alle reaktiv via Svelte-Stores. Kein Reload nötig.

---

## 5. Roles & Permissions

### 5.1 Default-Roles bei Server-Create

| Role | Position | Permissions (Hex) | Auto-Assign |
|---|---|---|---|
| `everyone` | 0 | `0x303` (VIEW + SEND + VOICE_CONNECT + VOICE_SPEAK) | ja |
| `moderator` | 50 | `0x303 + KICK + MANAGE_MESSAGES` = `0x317` | nein |
| `admin` | 100 | `ALL except ADMINISTRATOR-shortcut` | nein |

Owner ist über `server_members.is_owner=1` markiert und **bypassed alle Permissions** (= virtueller `ADMINISTRATOR`-Bit). Es gibt keine `owner`-Role-Row.

### 5.2 Permission-Bitfield

Discord-inspired, aber reduziert auf Beta-relevante Bits. Erweiterbar.

```js
// frontend/src/lib/permissions.js + src/lib/permissions.js (shared)
export const Permissions = {
  VIEW_CHANNEL:       0x0001,
  SEND_MESSAGES:      0x0002,
  MANAGE_MESSAGES:    0x0004,  // pin, delete others
  MANAGE_CHANNELS:    0x0008,  // create/delete channels
  KICK_MEMBERS:       0x0010,
  BAN_MEMBERS:        0x0020,
  MANAGE_SERVER:      0x0040,  // name, icon, description, invites
  MANAGE_ROLES:       0x0080,
  INVITE_MEMBERS:     0x0100,
  VOICE_CONNECT:      0x0200,
  VOICE_SPEAK:        0x0400,
  MENTION_EVERYONE:   0x0800,
  ADMINISTRATOR:      0x1000,  // bypass all checks (= Owner-Bit)
};
```

### 5.3 Permission-Resolution-Algorithmus

Gegeben: User `bertha004`, Channel `chan_xyz`, gewünschte Permission `SEND_MESSAGES`.

```
1. Wenn server_members.is_owner=1 → ALLOW (Owner bypass)
2. Sammle alle Roles des Users in role_assignments → Role-Set R
3. base_perms = OR(role.permissions ∀ role in R)
4. Wenn (base_perms & ADMINISTRATOR) → ALLOW
5. Lade channel_permission_overrides für chan_xyz:
   a. role_overrides = OR aller overrides mit target_kind='role' AND target_id in R
   b. member_override = override mit target_kind='member' AND target_id=bertha004 (max 1)
6. Apply-Order (Discord-Spec):
   final = base_perms
   final &= ~role_overrides.deny_bits
   final |= role_overrides.allow_bits
   final &= ~member_override.deny_bits  // member-deny gewinnt über role-allow
   final |= member_override.allow_bits  // member-allow gewinnt über role-deny
7. Return (final & wanted_bit) === wanted_bit
```

**Implementation:** Pure-Function in [`src/lib/permissions.js`](../src/lib/permissions.js) (Backend) + [`frontend/src/lib/permissions.js`](../frontend/src/lib/permissions.js) (Frontend für UI-Hiding). Backend ist die **autoritative Quelle** — Frontend-Check ist nur UX-Optimierung.

### 5.4 Role-Editierung

| Aktion | Endpoint | Permission |
|---|---|---|
| Role create | `POST /servers/<id>/roles` | `MANAGE_ROLES` + Position des Erstellers > Position der erstellten Role |
| Role update | `PATCH /servers/<id>/roles/<rid>` | dito |
| Role delete | `DELETE /servers/<id>/roles/<rid>` | dito |
| Assign role | `POST /servers/<id>/members/<u>/roles` | dito |
| Revoke role | `DELETE /servers/<id>/members/<u>/roles/<rid>` | dito |

**Anti-Privilege-Escalation (Backend-Enforced):** Ein Member mit `MANAGE_ROLES` darf KEINE Role erstellen, ändern oder zuweisen, deren `position` ≥ seine eigene höchste Role-Position. Standard-Discord-Pattern.

**Constraint im Backend** (in `serverRoutes.js`-Handlern für Role-Endpoints):
```js
const actorMaxPosition = await getMaxRolePosition(serverId, actor);
if (targetRole.position >= actorMaxPosition && !isOwner(actor, serverId)) {
  return json({ error: 'forbidden_role_position' }, 403);
}
```
Owner (`is_owner=1`) bypassed diesen Check immer — sonst kann ein Owner nach eigenem Role-Assign sich selbst aussperren.

**Test-Vorschrift:** `tests/serverPermissions.test.js` muss mindestens diese Cases abdecken:
1. Member mit MANAGE_ROLES Position=50 versucht Role Position=100 → 403
2. dito versucht Role Position=50 → 403 (gleich, nicht erlaubt)
3. dito versucht Role Position=49 → 200
4. Owner bypassed alle Checks → 200 für Position=999
5. Permissions-Overrides kombiniert: role-deny gewinnt über role-allow, member-deny gewinnt über role-deny, member-allow gewinnt über alles

---

## 6. API-Surface

### 6.1 Server-Endpoints

| Method | Path | Body | Permission | Returns |
|---|---|---|---|---|
| POST | `/servers/create` | `{ name, description? }` | logged-in | `{ ok, serverId, defaultChannelId, defaultRoleId }` |
| GET | `/servers/list` | — | logged-in | `{ servers: [{ id, name, icon, memberCount }] }` |
| GET | `/servers/<id>` | — | server member | `{ server, channels[], roles[], members[] }` |
| PATCH | `/servers/<id>` | `{ name?, description?, icon? }` | `MANAGE_SERVER` | `{ ok }` |
| DELETE | `/servers/<id>` | — | Owner only | `{ ok }` (CASCADE) |
| POST | `/servers/<id>/transfer` | `{ toHandle }` | Owner only | `{ ok }` |

### 6.2 Channel-Endpoints

Pattern: alle Channel-Routes sind **server-scoped** (`/servers/<sid>/channels/...`) — konsistent mit bestehendem `/groups/...`-Pattern + macht Server-Membership-Check zentral im Middleware-Layer möglich.

| Method | Path | Body | Permission | Returns |
|---|---|---|---|---|
| POST | `/servers/<sid>/channels` | `{ name, kind, topic?, private? }` | `MANAGE_CHANNELS` | `{ ok, channelId }` |
| GET | `/servers/<sid>/channels` | — | server member | `{ channels: [...] }` |
| PATCH | `/servers/<sid>/channels/<cid>` | `{ name?, topic?, position? }` | `MANAGE_CHANNELS` | `{ ok }` |
| DELETE | `/servers/<sid>/channels/<cid>` | — | `MANAGE_CHANNELS` | `{ ok }` (CASCADE messages) |
| POST | `/servers/<sid>/channels/<cid>/permissions` | `{ targetKind, targetId, allow, deny }` | `MANAGE_ROLES` | `{ ok }` |
| POST | `/servers/<sid>/channels/<cid>/members` | `{ handle }` | `MANAGE_CHANNELS` (für private channels) | `{ ok }` |
| DELETE | `/servers/<sid>/channels/<cid>/members/<u>` | — | `MANAGE_CHANNELS` | `{ ok }` |

**Message-Send/Receive** läuft weiter über `/chat/send` (unverändert) — Backend leitet aus `convoId.type='channel'` ab, dass `payloads`-Fanout an Server-Member-Devices ablaufen muss. Recipient-Set kommt aus dem KV-Cache (§4.3).

### 6.3 Role-Endpoints

| Method | Path | Body | Permission |
|---|---|---|---|
| POST | `/servers/<id>/roles` | `{ name, color?, permissions, position }` | `MANAGE_ROLES` |
| PATCH | `/servers/<id>/roles/<rid>` | partial role | `MANAGE_ROLES` |
| DELETE | `/servers/<id>/roles/<rid>` | — | `MANAGE_ROLES` |
| POST | `/servers/<id>/members/<u>/roles` | `{ roleId }` | `MANAGE_ROLES` |
| DELETE | `/servers/<id>/members/<u>/roles/<rid>` | — | `MANAGE_ROLES` |

### 6.4 Member-Endpoints

| Method | Path | Permission |
|---|---|---|
| GET | `/servers/<id>/members` | server member |
| POST | `/servers/<id>/members/<u>/kick` | `KICK_MEMBERS` |
| POST | `/servers/<id>/members/<u>/ban` | `BAN_MEMBERS` |
| POST | `/servers/<id>/leave` | server member |
| PATCH | `/servers/<id>/members/me` | `{ nickname }` server member |

### 6.5 Invite-Endpoints (erweitert bestehende `/invites/*`)

| Method | Path | Body | Permission |
|---|---|---|---|
| POST | `/servers/<id>/invites` | `{ maxUses?, ttlMin?, initialRoleId? }` | `INVITE_MEMBERS` |
| GET | `/servers/<id>/invites` | — | `INVITE_MEMBERS` |
| DELETE | `/servers/<id>/invites/<token>` | — | `INVITE_MEMBERS` |

### 6.6 Audit-Log-Endpoints

| Method | Path | Query | Permission |
|---|---|---|---|
| GET | `/servers/<id>/audit-log` | `?action=&actor=&target=&before=&limit=` | `MANAGE_SERVER` |
| GET | `/servers/<id>/audit-log/me` | (eigene Einträge als actor oder target) | server member |

Aufbewahrungszeit: 90 Tage (Cron räumt täglich auf). `audit-log/me`-Endpoint ist Schweizer-DSG-Auskunftsrecht-tauglich.

---

## 7. Multi-Device-Implikationen

**Wesentliche Aussage:** Phase 1B/1C-Multi-Device-Krypto ist **channel-agnostisch**. Channels sind aus Krypto-Sicht identisch zu Groups (Sender-Keys-Pattern, GSK pro `(User, Convo)`).

| Code-Pfad | Änderung nötig? |
|---|---|
| `chatPipeline.js` (Send/Receive) | Nein — `convoId` ist generisch |
| `groupCrypto.js` (GSK-Layer) | Nein — operiert auf `groupId` = jeder Convo-Id |
| `cmkBundleSync.js` (Recovery) | Nein — Bundle umfasst alle Convo-IDs |
| `chatSend.js` Backend (Control-Whitelist) | Nein — `gsk`/`request_gsk` funktionieren auf jeder Convo |
| Recipient-Set bei `/chat/send` | **Ja** — neue Logik bei `type='channel'`: Backend leitet Member-Liste aus `server_members` + Channel-Permissions ab (statt aus `conversation_members`) |
| `device_added`-Hook (App.svelte) | **Ja** — `redistributeGSKsForPeerDeviceAdded` muss auch Channel-Memberships abdecken (nicht nur Standalone-Groups) |

**Konkret:** Die Frontend-Funktion `redistributeGSKsForPeerDeviceAdded` (siehe [`GROUPS_MULTIDEVICE.md` §3.3](./GROUPS_MULTIDEVICE.md)) muss um Server-Channels erweitert werden. Liste der „gemeinsamen Convos" mit Peer ist dann:

```
shared_convos(me, peer) =
  Standalone-Groups WHERE me AND peer beide in conversation_members
  ∪
  Server-Channels WHERE me UND peer beide in server_members
                  UND beide haben VIEW_CHANNEL-Permission im jeweiligen Channel
```

API-seitig: ein neuer Endpoint `GET /channels/shared-with?peer=<h>` der diese Liste effizient liefert (vermeidet N+1-Pattern client-side).

---

## 8. Limits & Pro-Tier

| Limit | Free | Pro | Begründung |
|---|---|---|---|
| Server pro User (als Owner) | 3 | 25 | Verhindert Spam-Server-Creation. |
| Mitglieder pro Server | **1000** | **10'000** | Free reicht für mittelgrosse Gamer-Clans; Pro für Esports-Communities/Studios. Anti-AI-Prinzip verlangt Obergrenze (Discord: 250k = unrealistisch ohne Bot-Tolerant-Design). |
| Channels pro Server | 50 | 500 | Discord-Vergleichswert: 500. |
| Roles pro Server | 25 | 250 | Discord: 250. |
| Custom-Server-Slug | ❌ | ✅ | Branding-Pro-Feature (VISION §8). |
| Custom-Server-Icon | ❌ | ✅ | dito. |
| Message-File-Limit | 50 MB | 500 MB | VISION §8. |
| Custom-Emoji pro Server | 25 | 100 | VISION §8. |

**Voice-Limits** (Bitrate, Concurrent-Listener pro Channel etc.) sind ausgeklammert: Voice ist Phase 8 (post-Beta), Details in `VOICE.md` *(TBD)*.

Tier-Check via `users.tier`-Spalte (TBD, siehe Phase 3 in [MULTI_DEVICE.md §13](./MULTI_DEVICE.md) Open Items). Bei Server-Create und Channel-Create: Backend verifiziert Tier + aktuelle Counts.

---

## 9. Migration-Pfad

### 9.1 Koexistenz von Groups und Servers

**Keine Auto-Migration.** Bestehende Standalone-Groups (`type='group'`, `server_id IS NULL`) bleiben unverändert funktional. User können neue Server **zusätzlich** erstellen.

**UI-Konsequenz:** Sidebar zeigt drei Sections:
1. **Server-Liste** (oben, mit Icons als Stack)
2. **DMs** (mittig)
3. **Standalone-Groups** (unten, Legacy-Section, optional einklappbar)

### 9.2 Optionaler Promote-To-Server-Flow (Phase 3.5)

Owner einer Standalone-Group kann sie zu einem Server promovieren:
1. Click „Zu Server umwandeln" in Group-Settings.
2. Backend: `INSERT servers` + `INSERT server_members` (alle Group-Members übernehmen) + UPDATE `conversations SET server_id=?, type='channel', channel_kind='text'` für die Group-Convo.
3. Frontend: Sidebar-Repaint — Group verschwindet aus „Groups"-Section, taucht als #general-Channel im neuen Server auf.
4. Members bekommen WS `server_created` + Toast „bertha004 hat ‚Devs' zu einem Server gemacht".

**Sicherheit:** Keine GSK-Rotation nötig (Recipient-Set bleibt identisch). Permissions: alle Member bekommen Default-Role, Group-Admins werden Server-Admins.

### 9.3 Backwards-Compat-API

Bestehende `/groups/*`-Endpoints bleiben funktional, operieren NUR auf Standalone-Groups (`server_id IS NULL`). Server-Channels werden NIE über `/groups/*` exposed.

`/chat/send` ist unverändert: Backend routet anhand `conversations.type` (`dm` / `group` / `channel`).

---

## 10. Decision Log

| Datum | Entscheidung | Optionen | Pick | Rationale |
|---|---|---|---|---|
| 2026-05-13 | **Datenmodell** | (A) Neue `servers/channels`-Tables / (B) `conversations`-Erweiterung um `server_id`+`channel_kind` | **B** | Multi-Device-Krypto-Pipeline (1B/1C) ist convo-agnostisch. Wiederverwendung spart 2-3 Wochen Code-Duplikation. |
| 2026-05-13 | **Crypto-Pro-Channel** | (A) Ein GSK pro Server (alle Channels teilen sich) / (B) Ein GSK pro Channel | **B** | Forward Secrecy bei Channel-Permission-Changes. Mehrkosten: minimal (GSK = 32 Byte). |
| 2026-05-13 | **Role-System** | (A) Single-Role pro Member / (B) Multi-Role (Discord-Style) | **B** | Standard, Permission-Overrides werden so einfach via Bitwise-OR. |
| 2026-05-13 | **Owner-Modell** | (A) Owner-Role mit `ADMINISTRATOR`-Bit / (B) `server_members.is_owner`-Flag + Bypass | **B** | Verhindert versehentliches Löschen der Owner-Role. Transfer = Single-UPDATE-Statement. |
| 2026-05-13 | **Sichtbarkeit** | (A) Public-Discovery in Beta / (B) Invite-only-Start | **B** | Anti-AI-Hardening (VISION §2 Punkt 2) konfliktiert mit offenen Servern. Public deferred zu Phase 4+. |
| 2026-05-13 | **Group-Migration** | (A) Auto-Convert aller Groups / (B) Koexistenz, optional manuelle Promotion | **B** | Niedrige Migration-Last für bestehende User. Promote-Flow ist Phase 3.5. |
| 2026-05-13 | **Channel-Categories (Discord-Folder)** | (A) Phase 3 / (B) Phase 4+ | **B** | Visuell-Nice-to-have, blockiert keinen Beta-Launch. `parent_id`-Spalte schon vorbereitet. |
| 2026-05-13 | **Voice-Channel-Spec** | (A) Hier inline / (B) Eigene `VOICE.md` | **B** | WebRTC-SFU-Topic eigenständig, ~500 Zeilen weitere Spec. Trennung erleichtert Review. |
| 2026-05-13 | **Permission-Resolution Owner-Check** | (A) Owner als virtuelle Role / (B) is_owner-Short-Circuit am Anfang | **B** | Konsistent mit (B) oben. Ein einziger Check statt Role-Join. |
| 2026-05-13 | **Account-Delete bei Owner** | (A) Auto-Transfer an oldest Member (Discord) / (B) Pre-Check erzwingt manuellen Transfer (Slack) / (C) Cascade-Delete | **B** | Konsistent mit RENEX-Privacy-Werten — User entscheidet bewusst. Auto-Transfer (A) überrascht andere Members; Cascade (C) ist datenfeindlich. |
| 2026-05-13 | **API-Pfad-Konvention für Channels** | (A) flach `/channels/<id>` / (B) server-scoped `/servers/<sid>/channels/<cid>` | **B** | Konsistent mit bestehendem `/groups/...`-Pattern. Server-Membership-Check zentral in Middleware. |
| 2026-05-13 | **Member-Limits Free / Pro** | (A) 500 / 5000 / (B) 1000 / 10'000 / (C) Discord-like 250k | **B** | (A) zu klein für Gamer-Clans, (C) bricht Anti-AI-Prinzip (zu gross für Mensch-zu-Mensch-Garantie). (B) ist Sweet-Spot. |
| 2026-05-13 | **Audit-Log Zeitpunkt** | (A) Phase 3.5 deferred / (B) Phase 3 must-have | **B** | Schweizer DSG (VISION §2 Punkt 4) verlangt Auskunftsrecht — minimal-Schema `server_audit_log` ist additiv und billig. Moderations-Rechtssicherheit für Beta wichtig. |
| 2026-05-13 | **Voice-Channels Scope für Phase 3** | (A) Phase 3 (mit Beta) / (B) deferred zu Phase 8 (post-Beta) | **B** | WebRTC SFU + UI ist 3-4 Wochen Solo-Arbeit. Markenkern „AI-Free + Passkey-Only + Text-Discord-Killer" ist auch ohne Voice valid. Voice in v2.0 = bewusste Marketing-Story. |

---

## 11. Offene Items

Decisions, die noch User-Input brauchen oder bewusst in Folge-Specs verschoben:

| Item | Status | Owner-Spec |
|---|---|---|
| `users.tier`-Feld + Server-Enforcement | offen, blockiert §8 | `MONETIZATION.md` *(TBD)* |
| `server_bans`-Tabelle + Ban-Workflow | deferred Phase 3.5 | dieser Doc, Sektion-Erweiterung |
| Channel-Categories (`parent_id`) UI/UX | deferred Phase 4 | dieser Doc |
| Public-Server-Discovery + Anti-AI-Schutz | deferred Phase 4+ | `DISCOVERY.md` *(TBD)* |
| **Voice-Channels** (WebRTC SFU, Cloudflare Realtime) | **deferred zu Phase 8 (post-Beta)** | `VOICE.md` *(TBD post-Beta)* |
| **Push-to-Talk + Screen-Sharing** | **deferred zu Phase 8** | `VOICE.md` *(TBD)* |
| **Voice-Mute/Deaf-States** | **deferred zu Phase 8** | `VOICE.md` *(TBD)* |
| Custom-Emojis pro Server (R2-Upload, Limits) | deferred Phase 4 | dieser Doc, Sektion-Erweiterung |
| Promote-Group-to-Server-Flow Details | deferred Phase 3.5 | §9.2 erweitern |
| Audit-Log: vollständiges Action-Vokabular | ✅ in §2.1 spezifiziert | dieser Doc |
| `@everyone` / `@rolename` Mentions-Engine | offen | dieser Doc + `MENTIONS.md` *(TBD)* |
| Server-Icon-Upload + R2-Quota | offen | erweitert `ATTACHMENTS.md` |

---

**Diese Spec ist Draft v0.1 für Phase 3.**
**Vor Code-Änderungen an Server/Channel-Logik: hier reinschauen.**
**Bei Decision-Konflikt mit MULTI_DEVICE.md: MULTI_DEVICE.md gewinnt für Multi-Device-Themen, diese Spec für Server/Channel-Themen.**
**Wenn die Spec falsch ist: Decision Log erweitern, dann Code anpassen — nicht umgekehrt.**
