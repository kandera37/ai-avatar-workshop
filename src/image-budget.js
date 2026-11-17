const fs = require('node:fs');
const path = require('node:path');
const { AiAdapterError } = require('../ai-adapter');

function openImageBudget(db, directory, legacyLedger) {
  if (!directory) return null;

  db.pragma('synchronous = FULL');
  db.exec(`CREATE TABLE IF NOT EXISTS image_call_budget (
    scope TEXT PRIMARY KEY CHECK (scope IN ('public', 'developer')),
    used INTEGER NOT NULL CHECK (used >= 0)
  )`);
  const usage = db.prepare('SELECT used FROM image_call_budget WHERE scope = ?');
  const initialize = db.prepare('INSERT OR IGNORE INTO image_call_budget (scope, used) VALUES (?, ?)');
  db.transaction(() => {
    if (!usage.get('public')) {
      const entries = legacyLedger ? fs.readFileSync(legacyLedger, 'utf8') : '';
      if (entries && !entries.endsWith('\n')) throw new Error('Incomplete legacy image call ledger');
      initialize.run('public', entries.split('\n').length - 1);
    }
    initialize.run('developer', 0);
  }).immediate();

  return bindBudget(db, directory, { public: 'image-limit', developer: 'developer-image-limit' });
}

function openQuestImageBudget(db, directory) {
  db.pragma('synchronous = FULL');
  db.exec(`CREATE TABLE IF NOT EXISTS image_call_budget (
    scope TEXT PRIMARY KEY CHECK (scope = 'quest'),
    used INTEGER NOT NULL CHECK (used >= 0)
  );
  INSERT OR IGNORE INTO image_call_budget VALUES ('quest', 0)`);
  return bindBudget(db, directory, { quest: 'quest-image-limit' });
}

function bindBudget(db, directory, files) {
  const usage = db.prepare('SELECT used FROM image_call_budget WHERE scope = ?');
  const increment = db.prepare('UPDATE image_call_budget SET used = used + 1 WHERE scope = ? AND used < ?');
  function limitFor(scope) {
    const value = fs.readFileSync(path.join(directory, files[scope]), 'utf8').trim();
    const limit = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(limit)) throw new Error('Invalid image call limit');
    return limit;
  }
  function unavailable() {
    console.error('[ai-avatar] Image call budget unavailable');
    return new AiAdapterError('Image call budget unavailable', {
      code: 'DEMO_QUOTA_UNAVAILABLE', status: 503, source: 'local_quota',
    });
  }
  function exhausted() {
    return new AiAdapterError('Image call budget exhausted', {
      code: 'DEMO_QUOTA_EXHAUSTED', status: 402, source: 'local_quota',
    });
  }
  function snapshot(scope) {
    try {
      const total = limitFor(scope);
      const { used } = usage.get(scope);
      return { total, used, remaining: Math.max(0, total - used) };
    } catch {
      throw unavailable();
    }
  }
  function reserve(scope) {
    let changes;
    try {
      // One committed conditional write protects the last call across connections.
      changes = increment.run(scope, limitFor(scope)).changes;
    } catch {
      throw unavailable();
    }
    if (!changes) throw exhausted();
  }
  return { snapshot, reserve, exhausted };
}

module.exports = { openImageBudget, openQuestImageBudget };
