-- RENEX D1 Schema — Orgs / Verified-Sender (eGov Phase 1.1)
-- Run: npx wrangler d1 execute renex-db --file=schema-orgs.sql
--
-- ADDITIV + run-once. Eine Org ist ein bestehender Passkey-Account, dessen
-- Handle hier als verifizierte Organisation eingetragen ist. Verifikation
-- erfolgt registergestützt-manuell durch den Betreiber (Bauplan §1.1):
-- amtlicher Registerabgleich + Vertrag/Rechnung an die Registeradresse.
--
-- Badge-Semantik ist UNVERÄNDERLICH: „Identität geprüft am <verified_at>
-- via <verification_method>" — nie „vertrauenswürdig".
--
-- Onboarding (manuell via CLI, KEIN Admin-UI):
--   npx wrangler d1 execute renex-db --remote --command "INSERT INTO orgs
--     (org_handle, display_name, verification_method, verification_evidence, verified_at, created_at)
--     VALUES ('praxis_muster', 'Praxis Muster GmbH', 'medreg_psyreg_refdata',
--             'PsyReg-Nr. 12345, https://www.psyreg.admin.ch/..., geprüft 2026-07-20 durch Bruno',
--             1752566400000, 1752566400000)"
-- Sperren:  UPDATE orgs SET status = 'suspended' WHERE org_handle = '...'

CREATE TABLE IF NOT EXISTS orgs (
  org_handle            TEXT    PRIMARY KEY,          -- = users-Handle (KV webauthn:<handle>)
  display_name          TEXT    NOT NULL,             -- Rechtsname laut Register (fürs Badge/Landing)
  verification_method   TEXT    NOT NULL,             -- Enum, siehe src/lib/orgs.js ORG_VERIFICATION_METHODS
  verification_evidence TEXT,                          -- Register-URL, Register-Nr., Prüfdatum, Prüfer
  verified_at           INTEGER NOT NULL,             -- Unix-ms des abgeschlossenen Prüfprozesses
  verified_by           TEXT    NOT NULL DEFAULT 'bruno',
  status                TEXT    NOT NULL DEFAULT 'active',  -- 'active' | 'suspended'
  org_did               TEXT    DEFAULT NULL,         -- swiyu/did:webvh ab 2027 (Vertrauensregister)
  created_at            INTEGER NOT NULL
);
