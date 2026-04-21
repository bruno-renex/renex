-- ======================================================
-- Migration: Terms Acceptance (AGB + Datenschutz)
-- Fügt Nachweis-Spalten zur guest_sessions Tabelle hinzu.
-- Für User-Accounts erfolgt der Nachweis in KV (user:terms:{handle}).
--
-- Anwenden (Produktion):
--   npx wrangler d1 execute <DB_NAME> --remote --file=./schema-terms.sql
-- Lokal:
--   npx wrangler d1 execute <DB_NAME> --local  --file=./schema-terms.sql
-- ======================================================

ALTER TABLE guest_sessions ADD COLUMN terms_accepted_at INTEGER DEFAULT NULL;
ALTER TABLE guest_sessions ADD COLUMN terms_version     TEXT    DEFAULT NULL;
