-- Migration: origin_token für Re-Entry per QR-Karte (eGov 1.4-light)
-- Run: npx wrangler d1 execute renex-db --remote --file=schema-guest-origin.sql
--
-- ADDITIV + run-once. Verknüpft Gast-Session-Rows mit ihrem Invite-Template
-- (dem Karten-Token). Nötig für: (1) Re-Entry — verbrauchte LANGLEBIGE
-- Org-Karten dürfen neu aktiviert werden (neue Session, alte stirbt sofort =
-- Karten-Besitz bleibt der Auth-Anker, Missbrauch wird sichtbar statt still);
-- (2) Konvertierungs-Sperre — hat der Karteninhaber ein Konto erstellt, ist
-- die Karte tot. Wird nur für Org-Invites (>24h) geschrieben; Consumer-Rows
-- bleiben spaltenfrei.
--
-- ⚠️ Deploy-Reihenfolge: Migration VOR dem Worker-Deploy (wie schema-guest-label.sql).

ALTER TABLE guest_sessions ADD COLUMN origin_token TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_guest_sessions_origin
  ON guest_sessions(origin_token)
  WHERE origin_token IS NOT NULL;
