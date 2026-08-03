require('dotenv').config();
const { loadConfig } = require('./config');
const { createDb } = require('./db');
const { runMigrations, currentVersion, MIGRATIONS } = require('./db/migrations');
const { runBackup, scheduleDailyBackup } = require('./lib/backup');
const { createApp } = require('./app');

const config = loadConfig();
if (config.sessionSecret.includes('change') || config.sessionSecret.includes('please-change')
    || config.sessionSecret.length < 32) {
  console.warn(
    '[newday] ВНИМАНИЕ: SESSION_SECRET не задан или слишком короткий. '
    + 'Сессии можно подделать. Сгенерируйте свой и положите в .env: '
    + 'node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
  );
}

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

/**
 * Планировщик уведомлений.
 * Раз в 30 секунд отправляем всё, чему пришло время; раз в 5 минут
 * пересчитываем план на сегодня и завтра — на случай правок мимо API
 * и смены суток в разных таймзонах.
 */
const notify = app.locals.notify;
if (app.locals.push.enabled) {
  const deliver = setInterval(() => {
    notify.deliverDue().catch(e => console.error('[newday] отправка уведомлений:', e.message));
  }, 30 * 1000);
  const replan = setInterval(() => {
    try { notify.planAll(); } catch (e) { console.error('[newday] планирование:', e.message); }
  }, 5 * 60 * 1000);
  deliver.unref?.();
  replan.unref?.();
  try { notify.planAll(); } catch { /* при первом старте таблиц может не быть данных */ }
  console.log('NewDay push enabled');
} else {
  console.log('NewDay push disabled: не заданы VAPID_PUBLIC_KEY и VAPID_PRIVATE_KEY');
}

// Порт берём из фактически открытого сокета: при PORT=0 система выбирает его
// сама, и запись «порт 0» в логе бесполезна
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`NewDay listening on port ${server.address().port}`);
});
