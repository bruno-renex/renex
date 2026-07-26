-- Migration: Empfänger-Authentisierung per Aktivierungscode (eGov 1.3)
-- Run: npx wrangler d1 execute renex-db --remote --file=schema-guest-authcode.sql
--
-- ADDITIV + run-once. Der Zweitfaktor gehört der ORG und dem PAPIER
-- (Entscheid 2026-07-15): KEINE SMS/Telefonnummer/E-Mail bei RENEX.
-- Die Org erzeugt den Code selbst und übergibt ihn out-of-band (zweiter Brief,
-- Praxis-SMS aus der eigenen Software, Telefonat, persönlich) — CH-Präzedenz:
-- PrivaSphere MUC, ZH-Steuer-Zugangscode, Banken-PIN-Brief.
--
-- ⚠️ RENEX sieht den Klartext-Code NIE: Hash wird an BEIDEN Enden client-seitig
-- gerechnet (Org-Browser beim Erstellen, Bürger-Browser beim Join). Der Server
-- speichert nur salt + hash und vergleicht constant-time.
-- code_salt ist über /invite/info öffentlich (der Bürger braucht es zum Rechnen)
-- — ohne den Hash ist es wertlos; die Sicherheit liegt im Online-Rate-Limit
-- (code_attempts + strict-DO-Limiter), NICHT im Offline-Widerstand.
--
-- auth_level ist das erweiterbare Enum für spätere Stufen ('eid' ab Phase 4.1).
--
-- ⚠️ Deploy-Reihenfolge: Migration VOR dem Worker-Deploy.

ALTER TABLE guest_sessions ADD COLUMN auth_level    TEXT    DEFAULT NULL;  -- NULL|'code' (später 'eid')
ALTER TABLE guest_sessions ADD COLUMN code_salt     TEXT    DEFAULT NULL;  -- b64, öffentlich via /invite/info
ALTER TABLE guest_sessions ADD COLUMN code_hash     TEXT    DEFAULT NULL;  -- b64 SHA-256(salt‖code), NIE ausgeliefert
ALTER TABLE guest_sessions ADD COLUMN code_attempts INTEGER NOT NULL DEFAULT 0;
