-- ======================================================
-- PQXDH-Prekeys: One-Time-Prekey-Pool (Migration M2)
-- Spec: docs/CRYPTO_PQ_SIGNAL_BUILDPLAN.md §4.3 (PHASE 2 — PQXDH-Handshake)
-- Run (GEGATET — Live-D1-Infra-Änderung, erst nach Freigabe):
--   npx wrangler d1 execute renex-db --remote --file=schema-pqxdh.sql
-- ======================================================
-- ADDITIV + run-once. Legt NUR neue Tabellen an (CREATE TABLE IF NOT EXISTS →
-- idempotent). Berührt keine bestehende Tabelle → Legacy-Clients unberührt.
--
-- Datenmodell (§4.3): IK/SPK/PQSPK eines Geräts liegen in KV (klein, überschreib-
-- bar); die One-Time-Prekey-PUBS liegen hier in D1, weil sie einzeln + atomar
-- konsumiert werden (PrekeyDO: DELETE…RETURNING via rowid, serialisiert). Nur
-- öffentliches Material — die Privs bleiben client-seitig (deviceStore, versiegelt).

-- One-Time-Prekeys (X25519) — der pop-bare Pool pro (user_handle, device_id).
--   opk_pub = Standard-base64 eines 32-Byte X25519-Pubs (44 Zeichen).
-- UNIQUE(user_handle, device_id, opk_id) macht Re-Upload idempotent
-- (INSERT … ON CONFLICT DO NOTHING) und liefert zugleich den Prefix-Index für
-- die Consume-/Count-Abfragen (WHERE user_handle=? AND device_id=?).
-- Impliziter rowid (KEIN "WITHOUT ROWID") — der PrekeyDO pop't via rowid-Subquery.
CREATE TABLE IF NOT EXISTS pqxdh_opk (
  user_handle TEXT    NOT NULL,
  device_id   TEXT    NOT NULL,
  opk_id      TEXT    NOT NULL,
  opk_pub     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(user_handle, device_id, opk_id)
);

-- Forward-Compat (RESERVIERT, noch NICHT befüllt): optionaler PQ-One-Time-Prekey-
-- Pool (ML-KEM-768 ek + IK-Ed-Sig). Der M2-Handshake nutzt ausschließlich den
-- signierten PQSPK (kein PQ-OTP-Pfad in pqxdh.js / im InitHdr). Die Tabelle wird
-- jetzt mit-angelegt, damit die gegatete Migration nicht später ein zweites Mal
-- laufen muss; Upload/Consume-Code folgt erst mit einer späteren Phase.
--   pq_opk_ek  = base64 eines 1184-Byte ML-KEM-768-ek
--   pq_opk_sig = base64 einer 64-Byte Ed25519-Signatur (IK-Ed über den ek)
CREATE TABLE IF NOT EXISTS pqxdh_pq_opk (
  user_handle TEXT    NOT NULL,
  device_id   TEXT    NOT NULL,
  pq_opk_id   TEXT    NOT NULL,
  pq_opk_ek   TEXT    NOT NULL,
  pq_opk_sig  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(user_handle, device_id, pq_opk_id)
);
