-- RENEX Voice (Phase 1)
-- Run: npx wrangler d1 execute renex-db --file=schema-voice.sql

-- ======================================================
-- call_log — eine Zeile pro Call (initiiert → beendet)
-- Kein Audio persistiert, nur Metadaten für Anrufliste.
-- status: 'ringing' | 'connected' | 'ended' | 'missed' | 'declined' | 'busy' | 'failed'
-- ======================================================
CREATE TABLE IF NOT EXISTS call_log (
  id          TEXT    PRIMARY KEY,          -- callId (UUID vom Initiator generiert)
  caller      TEXT    NOT NULL,              -- Handle des Anrufers
  callee      TEXT    NOT NULL,              -- Handle des Angerufenen
  convo_id    TEXT,                          -- "alice:bob" (alphabetisch) oder group-id (V2)
  kind        TEXT    NOT NULL DEFAULT 'voice', -- 'voice' | 'video' (video = V2)
  started_at  INTEGER NOT NULL,              -- Zeitpunkt Ring initiiert (ms)
  answered_at INTEGER,                       -- NULL wenn nicht angenommen
  ended_at    INTEGER,                       -- NULL wenn noch aktiv
  duration_s  INTEGER,                       -- Sekunden; NULL bis ended_at gesetzt
  status      TEXT    NOT NULL DEFAULT 'ringing',
  end_reason  TEXT                           -- 'hangup' | 'decline' | 'timeout' | 'busy' | 'error'
);

CREATE INDEX IF NOT EXISTS idx_call_log_caller
  ON call_log(caller, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_log_callee
  ON call_log(callee, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_log_convo
  ON call_log(convo_id, started_at DESC);
