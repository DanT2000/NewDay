const MIGRATIONS = [
  require('./001-baseline'),
  require('./002-normalize'),
];

function currentVersion(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  return row?.v ?? 0;
}

function runMigrations(db) {
  const from = currentVersion(db);
  const pending = MIGRATIONS
    .filter(m => m.version > from)
    .sort((a, b) => a.version - b.version);
  const applied = [];

  for (const m of pending) {
    const tx = db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(m.version, m.name);
    });
    tx();
    applied.push(`${m.version}-${m.name}`);
  }

  return { from, to: currentVersion(db), applied };
}

module.exports = { runMigrations, MIGRATIONS, currentVersion };
