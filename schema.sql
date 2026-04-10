-- RENEX D1 Schema
-- Run: npx wrangler d1 execute renex-db --file=schema.sql

-- ======================================================
-- Conversations — generisches Modell für DM + Gruppen
-- DMs:    id = "alice:bob" (alphabetisch, kein Prefix)
-- Gruppen: id = UUID (zukünftig, via GroupChatDO erstellt)
-- ======================================================
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT    PRIMARY KEY,          -- "alice:bob" | UUID
  type       TEXT    NOT NULL DEFAULT 'dm', -- 'dm' | 'group'
  name       TEXT,                          -- Gruppenname (NULL für DMs)
  created_at INTEGER NOT NULL,
  created_by TEXT    NOT NULL
);

-- Mitglieder einer Konversation (DM: 2 Einträge, Gruppe: N Einträge)
CREATE TABLE IF NOT EXISTS conversation_members (
  convo_id      TEXT    NOT NULL,
  member_handle TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'member', -- 'member' | 'admin'
  joined_at     INTEGER NOT NULL,
  PRIMARY KEY (convo_id, member_handle)
);

CREATE INDEX IF NOT EXISTS idx_conv_members_handle
  ON conversation_members(member_handle);

CREATE INDEX IF NOT EXISTS idx_conv_members_handle_convo
  ON conversation_members(member_handle, convo_id);

-- ======================================================
-- Messages
-- convo_id → references conversations.id
-- to_user:  DM = Empfänger-Handle, Gruppe = NULL
--           (Gruppen-Empfänger werden über conversation_members bestimmt)
-- ======================================================
CREATE TABLE IF NOT EXISTS messages (
  id        TEXT    PRIMARY KEY,
  convo_id  TEXT    NOT NULL,
  from_user TEXT    NOT NULL,
  to_user   TEXT,                -- NULL für Gruppen-Nachrichten
  ts        INTEGER NOT NULL,
  status    TEXT    DEFAULT 'sent',
  type      TEXT,                 -- NULL for regular messages
  v         INTEGER,
  e2e       INTEGER DEFAULT 0,
  sid       TEXT,
  epoch     INTEGER,
  message   TEXT,                 -- NULL for E2E messages
  iv_b64    TEXT,
  ct_b64    TEXT,
  payloads        TEXT,                 -- JSON string for multi-device payloads
  rotation_index  INTEGER DEFAULT 0,    -- SK rotation epoch index
  sig             TEXT,                 -- ECDSA-P256 Nachrichtensignatur (base64)
  device_id       TEXT                  -- Sender-Device-ID für sig-Verifikation
);

CREATE INDEX IF NOT EXISTS idx_messages_convo_ts
  ON messages(convo_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_messages_delivered
  ON messages(convo_id, to_user, from_user, status);

-- Contacts
CREATE TABLE IF NOT EXISTS contacts (
  user_handle    TEXT    NOT NULL,
  contact_handle TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'pending',  -- pending, accepted, removed
  direction      TEXT,                                -- in, out, NULL once accepted
  display_handle TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (user_handle, contact_handle)
);

CREATE INDEX IF NOT EXISTS idx_contacts_user_status
  ON contacts(user_handle, status);

-- Auto-Delete Settings (pro Conversation, beide müssen zustimmen)
CREATE TABLE IF NOT EXISTS auto_delete_settings (
  convo_id     TEXT PRIMARY KEY,
  days         INTEGER NOT NULL,
  proposed_by  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending, active
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ads_status
  ON auto_delete_settings(status);

-- Migration: last_read_ts pro User pro Gruppe (für Unread-Count)
-- ALTER TABLE conversation_members ADD COLUMN last_read_ts INTEGER DEFAULT 0;

-- Notification Mutes (pro User, pro Konversation)
CREATE TABLE IF NOT EXISTS notification_mutes (
  user_handle TEXT NOT NULL,
  convo_id    TEXT NOT NULL,
  muted_at    INTEGER NOT NULL,
  PRIMARY KEY (user_handle, convo_id)
);

-- Unread DM Counters — atomar via D1 (ersetzt KV unread:* + unread_index:*)
CREATE TABLE IF NOT EXISTS unread_counters (
  owner  TEXT NOT NULL,   -- Empfänger
  sender TEXT NOT NULL,   -- Absender
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, sender)
);

-- ======================================================
-- Guest Sessions — Gastzugang ohne Passkey
-- Token-Format:        guest_[32 hex chars]
-- Guest-Handle-Format: guest_[8 hex chars]
-- Ablauf: 48h | Nachrichtenlimit: 50
-- Conversion: guest_handle → echter Account via Passkey
-- ======================================================
CREATE TABLE IF NOT EXISTS guest_sessions (
  token        TEXT    PRIMARY KEY,            -- "guest_[32 hex]" — URL-sicherer Einladungstoken
  convo_id     TEXT    NOT NULL,               -- Welche Konversation der Gast betreten darf
  convo_type   TEXT    NOT NULL DEFAULT 'dm',  -- 'dm' | 'group'
  created_by   TEXT    NOT NULL,               -- Handle des Einladenden
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,               -- Unix-Timestamp ms
  msg_limit    INTEGER NOT NULL DEFAULT 50,    -- Max. sendbare Nachrichten
  msg_count    INTEGER NOT NULL DEFAULT 0,     -- Bisher gesendete Nachrichten
  guest_handle TEXT    NOT NULL DEFAULT '',    -- "guest_[8 hex]" — wird beim ersten Join vergeben
  converted_to TEXT    DEFAULT NULL            -- Echter Handle nach Passkey-Registrierung
);

CREATE INDEX IF NOT EXISTS idx_guest_sessions_convo
  ON guest_sessions(convo_id);

CREATE INDEX IF NOT EXISTS idx_guest_sessions_handle
  ON guest_sessions(guest_handle)
  WHERE guest_handle != '';

-- Migration: conversation_members role darf 'guest' sein
-- (kein ALTER nötig — TEXT-Feld nimmt beliebige Werte an)
