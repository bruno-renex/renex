-- ======================================================
-- Multi-Device: Sesame-Core / PQ-Capability (Migration M1)
-- Spec: docs/CRYPTO_PQ_SIGNAL_BUILDPLAN.md §4.2
-- Run (GEGATET — Live-D1-Infra-Änderung, erst nach Freigabe):
--   npx wrangler d1 execute renex-db --remote --file=schema-devices-m1.sql
-- ======================================================
-- ADDITIV + run-once. SQLite kennt kein "ADD COLUMN IF NOT EXISTS" → nicht
-- mehrfach ausführen. Alle Spalten nullable oder mit konstantem DEFAULT
-- (bestehende Rows bleiben gültig; Legacy-Devices = kem_ek_b64 NULL, device_gen 1,
-- pq_capable 0).

-- ML-KEM-768 Encapsulation-Key (public, ~1184B base64). NULL = v1-only Device.
ALTER TABLE devices ADD COLUMN kem_ek_b64 TEXT;

-- Signatur-Algorithmus der Identität. Default = heutiges ECDSA-P256.
ALTER TABLE devices ADD COLUMN sig_algo TEXT DEFAULT 'ecdsa-p256';

-- Generation der Device-Key-Menge — bumpt bei Key-Change (kemEk/sigPub) für die
-- Sesame-Recipient-Set-Konsistenz (Client cached devset per gen).
ALTER TABLE devices ADD COLUMN device_gen INTEGER NOT NULL DEFAULT 1;

-- Capabilities (JSON): {"hybrid":bool,"ratchet":bool}. NULL = keine (Legacy).
ALTER TABLE devices ADD COLUMN caps TEXT;

-- Abgeleiteter Marker fürs Enforcement-Reporting (P5): hat ein valides kemEk.
ALTER TABLE devices ADD COLUMN pq_capable INTEGER NOT NULL DEFAULT 0;

-- Index für devset-Abfragen + Enforcement-Coverage-Reporting.
CREATE INDEX IF NOT EXISTS idx_devices_user_gen
  ON devices(user_handle, device_gen);
