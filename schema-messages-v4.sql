-- ======================================================
-- Double-Ratchet v4-Nachrichten (Migration P3.1)
-- Spec: docs/CRYPTO_PQ_SIGNAL_BUILDPLAN.md §4.4 (PHASE 3 — Double-Ratchet)
-- Run (GEGATET — Live-D1-Infra-Änderung, erst nach Freigabe):
--   npx wrangler d1 execute renex-db --remote --file=schema-messages-v4.sql
-- ======================================================
-- ADDITIV + run-once. Zwei nullable Spalten auf `messages`; bestehende Rows
-- (Legacy v2/v1) bleiben gültig (header_b64/init_hdr = NULL). Routing im Code
-- via header_b64-Präsenz: gesetzt → v4-Ratchet, NULL → Legacy-CMK-Pfad.

-- Ratchet-Message-Header (base64 von {v:4, dh, pn, n, kemEpoch}). ~120 B.
ALTER TABLE messages ADD COLUMN header_b64 TEXT;

-- PQXDH-InitHdr (JSON) — NUR auf der/den ersten Nachricht(en) einer neuen
-- Session (PreKeyMessage), bis der Peer geantwortet hat. Nötig, damit auch ein
-- offline gewesener Empfänger die Session aus /chat/list aufbauen kann. ~1.6 KB.
ALTER TABLE messages ADD COLUMN init_hdr TEXT;
