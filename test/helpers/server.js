const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createDb } = require('../../server/db');
const { runMigrations } = require('../../server/db/migrations');
const { createApp } = require('../../server/app');
const { loadConfig } = require('../../server/config');

/**
 * Поднимает изолированный экземпляр приложения на временной базе
 * и случайном порту. Всегда закрывать через `close()` в finally.
 */
async function startTestServer({ env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newday-test-'));
  const dbPath = path.join(dir, 'test.db');

  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: '0',
    DB_PATH: dbPath,
    SESSION_SECRET: 'test-secret-not-used-in-production-000',
    APP_URL: 'http://127.0.0.1',
    TRUST_PROXY: '0',
    ...env,
  });

  const db = createDb(dbPath);
  runMigrations(db);
  const app = createApp({ db, config });

  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url, db, config, app, dir,
    async close() {
      await new Promise(r => server.close(r));
      try { db.close(); } catch { /* уже закрыта */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Временная база без HTTP-сервера — для тестов миграций и репозиториев. */
function tmpDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newday-db-'));
  const file = path.join(dir, 'test.db');
  return { file, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { startTestServer, tmpDatabase };
