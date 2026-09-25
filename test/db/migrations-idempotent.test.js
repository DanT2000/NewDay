/**
 * Миграции при восстановлении из копии.
 *
 * Обычно они защищены таблицей версий, и повторно не запускаются. Но
 * восстановление из резервной копии — это ровно тот случай, когда версия в
 * базе может отставать от того, что в ней уже создано: копия снимается
 * между шагами, файл правят руками, базу собирают из двух. Если миграция
 * при повторном проходе падает, сервер не поднимется вообще — а это тот
 * самый момент, когда он нужнее всего.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../../server/db');
const { runMigrations, MIGRATIONS, currentVersion } = require('../../server/db/migrations');
const { tmpDatabase } = require('../helpers/server');

test('каждая миграция переживает повторный запуск', () => {
  const { file, cleanup } = tmpDatabase();
  const db = createDb(file);
  try {
    runMigrations(db);
    const версия = currentVersion(db);
    assert.strictEqual(версия, MIGRATIONS.at(-1).version, 'схема накатана до последней');

    /*
     * Откатываем только запись о версиях — как будто копию сняли до того,
     * как она была записана. Содержимое базы при этом уже новое.
     */
    db.prepare('DELETE FROM schema_version').run();
    const повтор = runMigrations(db);
    assert.strictEqual(повтор.to, версия, 'повторный проход дошёл до той же версии');
    assert.strictEqual(currentVersion(db), версия);

    // база по-прежнему рабочая
    const колонки = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
    assert.ok(колонки.includes('carried_from'), 'колонки на месте');
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM reports').get().n === 0, 'таблица сообщений цела');
  } finally {
    db.close();
    cleanup();
  }
});

test('повторный проход не теряет данные', () => {
  const { file, cleanup } = tmpDatabase();
  const db = createDb(file);
  try {
    runMigrations(db);
    db.prepare("INSERT INTO users (email, username, password_hash, timezone) VALUES ('a@b.c', 'a@b.c', 'x', 'UTC')").run();
    db.prepare("INSERT INTO days (user_id, date, title) VALUES (1, '2026-09-18', 'проба')").run();

    db.prepare('DELETE FROM schema_version').run();
    runMigrations(db);

    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1, 'пользователь на месте');
    assert.strictEqual(db.prepare("SELECT title FROM days WHERE date = '2026-09-18'").get().title, 'проба');
  } finally {
    db.close();
    cleanup();
  }
});

test('повторный проход миграций не трогает живые данные', () => {
  const { file, cleanup } = tmpDatabase();
  const db = createDb(file);
  try {
    runMigrations(db);
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (1, ?, ?)').run('a', 'x');
    db.prepare('INSERT INTO habits (id, user_id, title) VALUES (1, 1, ?)').run('Вода');
    for (const [d, s] of [['2026-09-01', 'done'], ['2026-09-02', 'skipped'], ['2026-09-03', 'missed']]) {
      db.prepare('INSERT INTO habit_logs (user_id, habit_id, date, status) VALUES (1,1,?,?)').run(d, s);
    }
    db.prepare('INSERT INTO days (user_id, date, title, notes) VALUES (1, ?, ?, ?)')
      .run('2026-09-01', 'Мой день', 'моя заметка');
    db.prepare(`INSERT INTO schedule_items (user_id, date, title, start_min, end_min)
                VALUES (1, '2026-09-01', 'Подъём', 540, 600)`).run();

    /*
     * Теряем номер версии — ровно то, что случается при восстановлении из
     * копии, снятой между шагом миграции и записью её номера. Ради этого
     * случая миграции и писались устойчивыми к повтору; проверять его
     * нужно на живых данных, а не на пустой базе.
     */
    db.exec('DELETE FROM schema_version');
    runMigrations(db);

    const отметки = db.prepare('SELECT date, status FROM habit_logs ORDER BY date').all();
    assert.deepStrictEqual(отметки.map(r => r.status), ['done', 'skipped', 'missed'],
      'журнал привычек пережил повтор');
    const день = db.prepare("SELECT title, notes FROM days WHERE date = '2026-09-01'").get();
    assert.strictEqual(день.title, 'Мой день', 'заголовок дня не переписан');
    assert.strictEqual(день.notes, 'моя заметка', 'заметка дня не переписана');
    const строк = db.prepare('SELECT COUNT(*) AS n FROM schedule_items').get().n;
    assert.strictEqual(строк, 1, 'строки дня не задвоились');
  } finally {
    db.close();
    try { cleanup(); } catch { /* каталог занят — уберётся при следующем запуске */ }
  }
});

test('старые отметки done 0/1 всё ещё переносятся в статусы', () => {
  const { file, cleanup } = tmpDatabase();
  const db = createDb(file);
  try {
    /*
     * База времён первой версии: у отметки только «сделал или нет». Ради
     * переноса этих записей миграция 002 и написана — проверяем, что
     * защита от повторного прохода его не отменила.
     */
    require('../../server/db/migrations/001-baseline').up(db);
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (1, ?, ?)').run('a', 'x');
    db.prepare('INSERT INTO habits (id, user_id, title) VALUES (1, 1, ?)').run('Вода');
    db.prepare('INSERT INTO habit_logs (user_id, habit_id, date, done) VALUES (1,1,?,1)').run('2026-09-01');
    db.prepare('INSERT INTO habit_logs (user_id, habit_id, date, done) VALUES (1,1,?,0)').run('2026-09-02');

    require('../../server/db/migrations/002-normalize').up(db);
    const отметки = db.prepare('SELECT date, status FROM habit_logs ORDER BY date').all();
    assert.deepStrictEqual(отметки.map(r => r.status), ['done', 'missed'],
      'старые единицы и нули стали статусами');
  } finally {
    db.close();
    try { cleanup(); } catch { /* каталог занят — уберётся при следующем запуске */ }
  }
});
