-- RENEX D1 Schema
-- Run: npx wrangler d1 execute renex-db --file=schema.sql

CREATE TABLE IF NOT EXISTS messages (
  id        TEXT    PRIMARY KEY,
  convo_id  TEXT    NOT NULL,     -- sorted pair: "alice:bob"
  from_user TEXT    NOT NULL,
  to_user   TEXT    NOT NULL,
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
  rotation_index  INTEGER DEFAULT 0     -- SK rotation epoch index
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
