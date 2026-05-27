-- ======================================================
-- RENEX — Phase 3A Schema: Servers + Text-Channels + Roles
-- ======================================================
-- Spec: docs/SERVERS.md §2
-- Apply:
--   Local dev: npx wrangler d1 execute renex-db --local --file=schema-servers.sql
--   Prod:      npx wrangler d1 execute renex-db --remote --file=schema-servers.sql
--
-- Idempotent: alle CREATE statements nutzen IF NOT EXISTS.
-- ALTER TABLE ADD COLUMN ist NICHT idempotent — der unten verwendete
-- Trick: separates ALTER pro Spalte, das fail-safe ist gegen partial state
-- (D1 ignoriert ein bereits existierendes Column nicht, daher müssen wir die
-- ALTERs nur einmal pro Environment ausführen — Cron/CI darf das NICHT wiederholen).
-- ======================================================

-- ── Servers — Workspace mit eigener Member-Liste + N Channels ──
CREATE TABLE IF NOT EXISTS servers (
  id            TEXT    PRIMARY KEY,         -- UUID v4
  name          TEXT    NOT NULL,
  description   TEXT,
  icon_r2_key   TEXT,                        -- R2-Key (optional, Pro-Feature)
  visibility    TEXT    NOT NULL DEFAULT 'invite', -- 'invite' | 'private' (Phase 4+: 'public')
  custom_slug   TEXT    UNIQUE,              -- renex.id/<slug> (Pro-Feature)
  created_at    INTEGER NOT NULL,
  created_by    TEXT    NOT NULL,            -- Owner-Handle (initial; transferable via is_owner-Flag)
  member_limit  INTEGER NOT NULL DEFAULT 1000 -- Free=1000, Pro=10000 (siehe SERVERS.md §8)
);

CREATE INDEX IF NOT EXISTS idx_servers_owner ON servers(created_by);

CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_slug ON servers(custom_slug)
  WHERE custom_slug IS NOT NULL;

-- ── Server-Membership (ein User pro Server, mit Server-spezifischem Nickname) ──
CREATE TABLE IF NOT EXISTS server_members (
  server_id    TEXT    NOT NULL,
  user_handle  TEXT    NOT NULL,
  nickname     TEXT,                         -- NULL = User-Handle anzeigen
  joined_at    INTEGER NOT NULL,
  is_owner     INTEGER NOT NULL DEFAULT 0,   -- 1 = Owner (genau einer pro Server, bypassed alle Permissions)
  PRIMARY KEY (server_id, user_handle),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_server_members_user
  ON server_members(user_handle);

-- ── Roles pro Server (Discord-style, Multi-Role) ──
CREATE TABLE IF NOT EXISTS server_roles (
  id             TEXT    PRIMARY KEY,        -- UUID v4
  server_id      TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  color          TEXT,                       -- Hex (z.B. '#ef4444'), NULL = default
  permissions    INTEGER NOT NULL DEFAULT 0, -- Bitfield (siehe src/lib/permissions.js)
  position       INTEGER NOT NULL DEFAULT 0, -- Sortierung (höher = mächtiger)
  is_default     INTEGER NOT NULL DEFAULT 0, -- 1 = auto-assign beim Join (genau eine pro Server)
  is_mentionable INTEGER NOT NULL DEFAULT 0, -- 1 = @rolename funktioniert
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_server_roles_server
  ON server_roles(server_id, position DESC);

-- Genau eine Default-Role pro Server
CREATE UNIQUE INDEX IF NOT EXISTS idx_server_roles_default
  ON server_roles(server_id) WHERE is_default = 1;

-- ── M:N — welcher User hat welche Roles ──
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

-- ── Channel-spezifische Permission-Overrides ──
-- Discord-Pattern: erlaubt private Channels und feingranulare Kontrolle
CREATE TABLE IF NOT EXISTS channel_permission_overrides (
  channel_id   TEXT    NOT NULL,             -- = conversations.id
  target_kind  TEXT    NOT NULL,             -- 'role' | 'member'
  target_id    TEXT    NOT NULL,             -- role_id ODER user_handle
  allow_bits   INTEGER NOT NULL DEFAULT 0,   -- erzwungene Erlaubnis (bitwise)
  deny_bits    INTEGER NOT NULL DEFAULT 0,   -- erzwungenes Verbot (bitwise, gewinnt über allow)
  PRIMARY KEY (channel_id, target_kind, target_id)
);

CREATE INDEX IF NOT EXISTS idx_chan_perm_overrides_channel
  ON channel_permission_overrides(channel_id);

-- ── Audit-Log für Moderations-Aktionen ──
-- Nur Kick, Ban, Role-Change, Channel-Delete (NICHT pro Message).
-- Aufbewahrungszeit: 90 Tage (Cron). DSG-Auskunftsrecht via /servers/<id>/audit-log/me.
CREATE TABLE IF NOT EXISTS server_audit_log (
  id           TEXT    PRIMARY KEY,         -- UUID v4
  server_id    TEXT    NOT NULL,
  actor        TEXT    NOT NULL,            -- wer hat es gemacht
  action       TEXT    NOT NULL,            -- siehe SERVERS.md §2.1 Audit-Vokabular
  target       TEXT,                         -- target user_handle / channel_id / role_id
  details_json TEXT,                         -- frei strukturiertes JSON
  ts           INTEGER NOT NULL,
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audit_server_ts
  ON server_audit_log(server_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_audit_actor
  ON server_audit_log(server_id, actor, ts DESC);

CREATE INDEX IF NOT EXISTS idx_audit_target
  ON server_audit_log(server_id, target, ts DESC);

-- ======================================================
-- ALTER TABLE conversations — Channel-Kontext (NICHT idempotent!)
-- ======================================================
-- D1 hat KEIN "ADD COLUMN IF NOT EXISTS" — diese Statements müssen
-- pro Environment EXAKT EINMAL ausgeführt werden. CI/Cron darf sie NICHT wiederholen.
--
-- Migrations-Audit:
--   SELECT sql FROM sqlite_master WHERE type='table' AND name='conversations';
-- Wenn 'server_id' bereits in der Tabellen-Definition steht → diese Statements skippen.
--
-- Anwendung manuell:
--   ALTER TABLE conversations ADD COLUMN server_id     TEXT;
--   ALTER TABLE conversations ADD COLUMN channel_kind  TEXT;
--   ALTER TABLE conversations ADD COLUMN position      INTEGER DEFAULT 0;
--   ALTER TABLE conversations ADD COLUMN topic         TEXT;
--   ALTER TABLE conversations ADD COLUMN parent_id     TEXT;
--
-- conversations.type wird logisch erweitert: 'dm' | 'group' | 'channel'
-- 'channel' impliziert: server_id IS NOT NULL AND channel_kind IS NOT NULL
-- (Constraint im App-Layer enforced).
--
-- Nach den ALTERs MUSS dieser Index manuell erstellt werden (sonst Send-Path
-- langsam beim Server-Fanout):
--
--   CREATE INDEX IF NOT EXISTS idx_conv_server
--     ON conversations(server_id, position ASC)
--     WHERE server_id IS NOT NULL;
--
-- (Hier nicht inline, weil sonst der erste Apply gegen eine frische DB ohne
-- die ALTER-Spalten failed.)
-- ======================================================

-- ── Server-Invites (Token-basierter Join-Link, Spec SERVERS.md §3.3 + §6.5) ──
-- Eigene Tabelle (NICHT guest_sessions — Server-Joins sind registrierte User,
-- keine Gäste). Cleanup abgelaufener Invites via Cron (cron.js).
CREATE TABLE IF NOT EXISTS server_invites (
  token           TEXT    PRIMARY KEY,         -- 'srv_inv_<32hex>'
  server_id       TEXT    NOT NULL,
  created_by      TEXT    NOT NULL,            -- Inviter-Handle
  initial_role_id TEXT,                         -- optional: zusätzliche Role beim Join (sonst nur default)
  max_uses        INTEGER NOT NULL DEFAULT 0,  -- 0 = unbegrenzt
  uses            INTEGER NOT NULL DEFAULT 0,
  expires_at      INTEGER,                      -- NULL = nie ablaufend
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_server_invites_server
  ON server_invites(server_id);
