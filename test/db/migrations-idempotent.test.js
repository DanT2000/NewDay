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
