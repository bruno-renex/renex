-- ======================================================
-- Multi-Device Migration (Phase 1B.1)
-- Spec: docs/MULTI_DEVICE.md §2.1, §7.1
-- Run:  npx wrangler d1 execute renex-db --file=schema-devices.sql
-- ======================================================

CREATE TABLE IF NOT EXISTS devices (
  device_id    TEXT    PRIMARY KEY,
  user_handle  TEXT    NOT NULL,
  state        TEXT    NOT NULL DEFAULT 'new',  -- new|syncing|active|revoked
  name         TEXT,
  user_agent   TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at   INTEGER,
  revoked_by   TEXT                              -- user|auto|self
);

CREATE INDEX IF NOT EXISTS idx_devices_user_state
  ON devices(user_handle, state);

CREATE INDEX IF NOT EXISTS idx_devices_lastseen_active
  ON devices(last_seen_at)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS idx_devices_revoked
  ON devices(revoked_at)
  WHERE state = 'revoked';
