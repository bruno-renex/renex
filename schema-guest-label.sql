-- Migration: Label für Org-Invites (eGov 1.2, Bulk-Issuance)
-- Run: npx wrangler d1 execute renex-db --remote --file=schema-guest-label.sql
--
-- ADDITIV + run-once. Personalisierte Referenz pro Invite („Mitglied Müller",
-- „Patient 0042") — die Brücke zwischen Serienbrief und guest_-Handle:
-- beim Join wandert das Label vom Template auf die Session-Row, GET /invite/list
-- zeigt der Org „Label X = guest_ab12, aktiv". Org-gated (nur verifizierte Orgs
-- können Labels setzen); Consumer-Invites bleiben label-los.
--
-- ⚠️ Deploy-Reihenfolge: Migration VOR dem Worker-Deploy anwenden — der
-- Label-INSERT-Pfad ist dynamisch (Consumer-Pfad berührt die Spalte nie),
-- aber Org-Bulk mit Labels braucht die Spalte.

ALTER TABLE guest_sessions ADD COLUMN label TEXT DEFAULT NULL;
