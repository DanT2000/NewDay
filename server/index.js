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
  /*
   * Следующий тик не начинается, пока идёт предыдущий.
   *
   * Отправка ждёт ответа push-сервиса, а тик — каждые тридцать секунд.
   * Медленный сервис (или просто длинная очередь) означал, что второй тик
   * брал те же записи: человек получал одно и то же уведомление дважды, а
   * при зависании — лавиной.
   */
  let идёт = false;
  const deliver = setInterval(() => {
    if (идёт) return;
    идёт = true;
    notify.deliverDue()
      .catch(e => console.error('[newday] отправка уведомлений:', e.message))
      .finally(() => { идёт = false; });
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
  /*
   * Уборка очереди нужна и без push.
   *
   * Очередь наполняется при каждой правке дня, а чистилась только внутри
   * отправки — то есть на сервере без ключей push таблица росла вечно и
   * замедляла собственные запросы. Раз в час достаточно.
   */
  const убрать = setInterval(() => {
    try { notify.purgeOld(); }
    catch (e) { console.error('[newday] уборка очереди уведомлений:', e.message); }
  }, 60 * 60 * 1000);
  убрать.unref?.();
}

/**
 * Автоочистка заблокированных. Вторая ступень удаления аккаунта: тех, кому
 * администратор закрыл доступ дольше 60 дней назад (BLOCKED_RETENTION_DAYS
 * в services/userCleanup), стираем насовсем. Раз в сутки достаточно — срок
 * меряется днями, и лишний день никому ничего не меняет.
 */
const purgeBlocked = () => {
  try {
    const n = app.locals.userCleanup.purgeExpired();
    if (n) console.log(`NewDay: автоочистка удалила заблокированных: ${n}`);
  } catch (e) {
    console.error('[newday] автоочистка заблокированных:', e.message);
  }
};
purgeBlocked();   // и сразу при старте: сервер мог проспать не один «раз в сутки»
const purgeTimer = setInterval(purgeBlocked, 24 * 60 * 60 * 1000);
purgeTimer.unref?.();

/**
 * Ключи повторных запросов живут сутки: дольше повтор не приходит, а
 * таблица без уборки растёт с каждой созданной строкой.
 */
const { opKeys } = require('./lib/idempotency');
const purgeOpKeys = () => {
  try { opKeys(app.locals.db).убратьСтарые(); }
  catch (e) { console.error('[newday] уборка ключей повторов:', e.message); }
};
purgeOpKeys();
const opKeysTimer = setInterval(purgeOpKeys, 60 * 60 * 1000);
opKeysTimer.unref?.();

// Порт берём из фактически открытого сокета: при PORT=0 система выбирает его
// сама, и запись «порт 0» в логе бесполезна
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`NewDay listening on port ${server.address().port}`);
});

/*
 * Понятная смерть вместо непонятной.
 *
 * Обработчиков не было вовсе: любое событие `error` у потока или промах с
 * промисом вне запроса убивали процесс без объяснений, а занятый порт
 * печатал стек вместо строки «порт занят». Необработанный промис больше не
 * повод умирать — сервер продолжает работать; настоящее исключение
 * записываем и выходим по-честному, чтобы надзор перезапустил чистый
 * процесс, а не работал с полуживым.
 */
server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[newday] порт ${config.port} уже занят — сервер не запущен`);
    process.exit(1);
  }
  console.error('[newday] ошибка сетевого сокета:', e.message);
});

process.on('unhandledRejection', e => {
  console.error('[newday] необработанный промис:', e?.stack || e);
});

process.on('uncaughtException', e => {
  console.error('[newday] необработанное исключение:', e?.stack || e);
  try { server.close(); } catch { /* уже закрыт */ }
  setTimeout(() => process.exit(1), 100).unref();
});

/*
 * Остановка по сигналу: `docker stop` присылает SIGTERM. Без обработки
 * соединения рвались на полуслове, а база закрывалась как придётся.
 */
for (const сигнал of ['SIGTERM', 'SIGINT']) {
  process.on(сигнал, () => {
    console.log(`NewDay: получен ${сигнал}, останавливаюсь`);
    server.close(() => {
      try { db.close(); } catch { /* уже закрыта */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
