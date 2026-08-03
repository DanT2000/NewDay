require('dotenv').config();
const { loadConfig } = require('./config');
const { createDb } = require('./db');
const { runMigrations } = require('./db/migrations');
const { createApp } = require('./app');

const config = loadConfig();
const db = createDb(config.dbPath);

const migrated = runMigrations(db);
console.log(
  `NewDay schema ${migrated.from} → ${migrated.to}` +
  (migrated.applied.length ? ` (${migrated.applied.join(', ')})` : ' (актуальна)')
);

const app = createApp({ db, config });

app.listen(config.port, '0.0.0.0', () => {
  console.log(`NewDay listening on port ${config.port}`);
});
