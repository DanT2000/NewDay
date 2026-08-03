require('dotenv').config();
const { loadConfig } = require('./config');
const { createDb } = require('./db');
const { runMigrations, currentVersion, MIGRATIONS } = require('./db/migrations');
const { runBackup, scheduleDailyBackup } = require('./lib/backup');
const { createApp } = require('./app');

const config = loadConfig();
const db = createDb(config.dbPath);

// Снимок перед миграцией: если что-то пойдёт не так, есть куда откатиться.
const pending = MIGRATIONS.some(m => m.version > currentVersion(db));
if (pending && config.dbPath !== ':memory:') {
  try {
    console.log(`NewDay backup before migration → ${runBackup(db, config.dbPath)}`);
  } catch (e) {
    console.error('[newday] не удалось снять бэкап перед миграцией:', e.message);
  }
}

const migrated = runMigrations(db);
console.log(
  `NewDay schema ${migrated.from} → ${migrated.to}` +
  (migrated.applied.length ? ` (${migrated.applied.join(', ')})` : ' (актуальна)')
);

if (config.dbPath !== ':memory:') scheduleDailyBackup(db, config.dbPath);

const app = createApp({ db, config });

app.listen(config.port, '0.0.0.0', () => {
  console.log(`NewDay listening on port ${config.port}`);
});
