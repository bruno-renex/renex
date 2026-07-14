// ======================================================
// Unit-Tests: Globaler Retention-Cap (eGov Phase 0.3)
// ======================================================
// Gegen ECHTES SQLite (node:sqlite) statt Regex-Mock → testet die tatsächliche
// WHERE-/Exemption-Semantik des DELETE.
//
// Garantien:
//   - DMs + Gruppen älter als N Tage werden gelöscht.
//   - Channels (type='channel') EXEMPT (Forum-History = Feature).
//   - Convos mit aktivem Auto-Delete EXEMPT (respektiert auch längere Wünsche).
//   - Control-Rows (type IS NOT NULL, z.B. gsk) EXEMPT (Gast-Polling).
//   - Aktuelle Nachrichten (< cutoff) bleiben.
//   - R2-Attachment-Blobs gelöschter Nachrichten werden geräumt (GIFs nicht).
//   - MSG_RETENTION_DAYS=0 → deaktiviert.
// ======================================================
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runRetentionCap } from '../src/cron.js';

const DAY = 86400_000;

// Minimaler D1-Adapter über ein echtes In-Memory-SQLite.
function makeEnv({ days } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'dm');
    CREATE TABLE auto_delete_settings (convo_id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, convo_id TEXT, ts INTEGER, type TEXT,
      attachment_key TEXT, attachment_type TEXT
    );
  `);

  const deletedR2 = [];
  const RENEX_FILES = { delete: (k) => { deletedR2.push(k); return Promise.resolve(); } };

  const RENEX_DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() { return { meta: { changes: db.prepare(sql).run(...args).changes } }; },
            async all() { return { results: db.prepare(sql).all(...args) }; },
            async first() { return db.prepare(sql).get(...args) ?? null; },
          };
        },
      };
    },
  };

  const env = { RENEX_DB, RENEX_FILES };
  if (days !== undefined) env.MSG_RETENTION_DAYS = days;
  return { env, db, deletedR2 };
}

function seed(db, rows) {
  const ins = db.prepare(
    'INSERT INTO messages (id, convo_id, ts, type, attachment_key, attachment_type) VALUES (?,?,?,?,?,?)'
  );
  for (const r of rows) {
    ins.run(r.id, r.convo_id, r.ts, r.type ?? null, r.attachment_key ?? null, r.attachment_type ?? null);
  }
}

describe('runRetentionCap', () => {
  const now = Date.now();
  const OLD = now - 100 * DAY;   // > 90d
  const NEW = now - 10 * DAY;    // < 90d

  it('löscht alte DMs+Gruppen, exemptiert Channel / Auto-Delete / Control / aktuelle + räumt R2', async () => {
    const { env, db, deletedR2 } = makeEnv();
    db.exec(`
      INSERT INTO conversations (id, type) VALUES
        ('alice:bob','dm'), ('grp1','group'), ('chan1','channel'), ('dm_autodel','dm');
      INSERT INTO auto_delete_settings (convo_id, status) VALUES ('dm_autodel','active');
    `);
    seed(db, [
      { id: 'm1', convo_id: 'alice:bob',  ts: OLD },                                                   // alt DM → weg
      { id: 'm2', convo_id: 'grp1',       ts: OLD },                                                   // alt Gruppe → weg
      { id: 'm3', convo_id: 'chan1',      ts: OLD },                                                   // Channel → bleibt
      { id: 'm4', convo_id: 'dm_autodel', ts: OLD },                                                   // Auto-Delete → bleibt
      { id: 'm5', convo_id: 'alice:bob',  ts: OLD, type: 'gsk' },                                      // Control → bleibt
      { id: 'm6', convo_id: 'alice:bob',  ts: NEW },                                                   // aktuell → bleibt
      { id: 'm7', convo_id: 'grp1',       ts: OLD, attachment_key: 'r2/blob1', attachment_type: 'image' }, // weg + R2
      { id: 'm8', convo_id: 'grp1',       ts: OLD, attachment_key: 'gif/x',    attachment_type: 'gif' },   // weg, KEIN R2
    ]);

    const res = await runRetentionCap(env);

    const remaining = db.prepare('SELECT id FROM messages ORDER BY id').all().map(r => r.id);
    expect(remaining).toEqual(['m3', 'm4', 'm5', 'm6']);
    expect(res.deleted).toBe(4);
    expect(res.days).toBe(90);
    expect(deletedR2).toEqual(['r2/blob1']);   // nur echter Blob, nur von gelöschten Rows
  });

  it('MSG_RETENTION_DAYS=0 deaktiviert den Cap', async () => {
    const { env, db } = makeEnv({ days: 0 });
    db.exec(`INSERT INTO conversations (id, type) VALUES ('alice:bob','dm');`);
    seed(db, [{ id: 'm1', convo_id: 'alice:bob', ts: OLD }]);
    const res = await runRetentionCap(env);
    expect(res.deleted).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM messages').get().c).toBe(1);
  });

  it('respektiert benutzerdefinierte MSG_RETENTION_DAYS', async () => {
    const { env, db } = makeEnv({ days: 30 });
    db.exec(`INSERT INTO conversations (id, type) VALUES ('alice:bob','dm');`);
    seed(db, [
      { id: 'm_40d', convo_id: 'alice:bob', ts: now - 40 * DAY },   // > 30d → weg
      { id: 'm_20d', convo_id: 'alice:bob', ts: now - 20 * DAY },   // < 30d → bleibt
    ]);
    await runRetentionCap(env);
    expect(db.prepare('SELECT id FROM messages').all().map(r => r.id)).toEqual(['m_20d']);
  });
});
