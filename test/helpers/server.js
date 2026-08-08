const path = require('node:path');
const tmp = require('../../tools/lib/tmp');
const { createDb } = require('../../server/db');
const { runMigrations } = require('../../server/db/migrations');
const { createApp } = require('../../server/app');
const { loadConfig } = require('../../server/config');

/**
 * Поднимает изолированный экземпляр приложения на временной базе
 * и случайном порту. Всегда закрывать через `close()` в finally.
 */
async function startTestServer({ env = {}, fetchImpl } = {}) {
  const dir = tmp.tempDir('test-server');
  const dbPath = path.join(dir, 'test.db');

  const vars = {
    NODE_ENV: 'test',
    PORT: '0',
    DB_PATH: dbPath,
    SESSION_SECRET: 'test-secret-not-used-in-production-000',
    APP_URL: 'http://127.0.0.1',
    TRUST_PROXY: '0',
    ...env,
  };
  const config = loadConfig(vars);

  const db = createDb(dbPath);
  runMigrations(db);
  // Тот же набор переменных получает и приложение: подключение помощника
  // читается из окружения, а не из config
  const app = createApp({ db, config, fetchImpl, env: vars });

  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url, db, config, app, dir,
    async close() {
      await new Promise(r => server.close(r));
      try { db.close(); } catch { /* уже закрыта */ }
      tmp.releaseSync(dir);
    },
  };
}

/** Временная база без HTTP-сервера — для тестов миграций и репозиториев. */
function tmpDatabase() {
  const dir = tmp.tempDir('test-db');
  const file = path.join(dir, 'test.db');
  return { file, dir, cleanup: () => tmp.releaseSync(dir) };
}

module.exports = { startTestServer, tmpDatabase };
