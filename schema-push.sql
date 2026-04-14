-- RENEX Push Notifications Schema
-- Run: npx wrangler d1 execute renex-db --file=schema-push.sql

-- ======================================================
-- Push Subscriptions — pro User, pro Device/Browser
-- transport_type ermöglicht spätere Erweiterung
-- (unified_push, native_app, etc.)
-- ======================================================
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint        TEXT    PRIMARY KEY,          -- Web Push endpoint URL (unique per browser)
  user_handle     TEXT    NOT NULL,
  p256dh          TEXT    NOT NULL,             -- Client public key (base64url)
  auth_key        TEXT    NOT NULL,             -- Auth secret (base64url)
  transport_type  TEXT    NOT NULL DEFAULT 'web_push',  -- 'web_push' | 'unified_push' | future
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_subs_user
  ON push_subscriptions(user_handle);

-- ======================================================
-- Erweiterte Notification Mutes — granulare Kontrolle
-- level: 'all' (alles stumm), 'mentions_only' (@mention),
--        'nothing' (alles an, Standard wenn kein Eintrag)
-- expires_at: temporäres Mute (NULL = permanent)
-- ======================================================
ALTER TABLE notification_mutes ADD COLUMN level TEXT NOT NULL DEFAULT 'all';
ALTER TABLE notification_mutes ADD COLUMN expires_at INTEGER;
