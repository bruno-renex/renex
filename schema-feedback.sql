-- Feedback-Tabelle für Launch-Tester
-- Ausführen: npx wrangler d1 execute RENEX_DB --remote --file=schema-feedback.sql
CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL DEFAULT 'Anonym',
  category   TEXT    NOT NULL DEFAULT 'allgemein',
  message    TEXT    NOT NULL,
  ip_hash    TEXT,
  created_at INTEGER NOT NULL
);
