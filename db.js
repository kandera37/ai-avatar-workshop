const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function openDatabase(filename = process.env.DB_PATH || path.join(__dirname, '.runtime', 'avatars.db')) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      participant_id TEXT,
      is_developer INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS generations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      user_prompt TEXT,
      final_prompt TEXT,
      image_data TEXT NOT NULL,
      provider TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS works (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      generation_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
      nickname TEXT NOT NULL,
      prompt TEXT NOT NULL,
      user_prompt TEXT,
      final_prompt TEXT,
      image_data TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published', 'hidden')),
      likes_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      published_at TEXT
    );
    CREATE TABLE IF NOT EXISTS likes (
      work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      participant_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (work_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS works_status_created_idx ON works(status, created_at DESC);
  `);
  const generationColumns = db.prepare('PRAGMA table_info(generations)').all();
  const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all();
  if (!sessionColumns.some((column) => column.name === 'participant_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN participant_id TEXT');
  }
  if (!sessionColumns.some((column) => column.name === 'is_developer')) {
    db.exec('ALTER TABLE sessions ADD COLUMN is_developer INTEGER NOT NULL DEFAULT 0');
  }
  // Legacy sessions had no stable browser identity. Treat each such session
  // as its own participant so existing likes remain valid after migration.
  db.prepare('UPDATE sessions SET participant_id = id WHERE participant_id IS NULL OR participant_id = \'\'').run();
  const likeColumns = db.prepare('PRAGMA table_info(likes)').all();
  if (!likeColumns.some((column) => column.name === 'participant_id')) {
    db.exec('ALTER TABLE likes ADD COLUMN participant_id TEXT');
  }
  // Backfill the identity for likes already stored by session id. The unique
  // index below is the new source of truth for one vote per participant.
  db.prepare(`UPDATE likes
    SET participant_id = (SELECT participant_id FROM sessions WHERE sessions.id = likes.session_id)
    WHERE participant_id IS NULL OR participant_id = ''`).run();
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS likes_work_participant_idx ON likes(work_id, participant_id)');
  if (!generationColumns.some((column) => column.name === 'duration_ms')) {
    db.exec('ALTER TABLE generations ADD COLUMN duration_ms INTEGER');
  }
  if (!generationColumns.some((column) => column.name === 'provider')) {
    db.exec('ALTER TABLE generations ADD COLUMN provider TEXT');
  }
  if (!generationColumns.some((column) => column.name === 'user_prompt')) {
    db.exec('ALTER TABLE generations ADD COLUMN user_prompt TEXT');
  }
  if (!generationColumns.some((column) => column.name === 'final_prompt')) {
    db.exec('ALTER TABLE generations ADD COLUMN final_prompt TEXT');
  }
  // Existing databases stored the participant text in `prompt`. Keep that
  // value as the canonical user prompt after the additive migration.
  db.prepare('UPDATE generations SET user_prompt = prompt WHERE user_prompt IS NULL').run();
  const workColumns = db.prepare('PRAGMA table_info(works)').all();
  if (!workColumns.some((column) => column.name === 'user_prompt')) {
    db.exec('ALTER TABLE works ADD COLUMN user_prompt TEXT');
  }
  if (!workColumns.some((column) => column.name === 'final_prompt')) {
    db.exec('ALTER TABLE works ADD COLUMN final_prompt TEXT');
  }
  db.prepare('UPDATE works SET user_prompt = prompt WHERE user_prompt IS NULL').run();
  if (!workColumns.some((column) => column.name === 'published_at')) {
    db.exec('ALTER TABLE works ADD COLUMN published_at TEXT');
  }
  return db;
}

module.exports = { openDatabase };
