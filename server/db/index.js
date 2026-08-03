const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

function createDb(dbPath) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

module.exports = { createDb };
