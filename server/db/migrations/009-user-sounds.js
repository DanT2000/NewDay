/**
 * Свои звуки будильника.
 *
 * Встроенных мелодий мало, и просыпаться годами под одну и ту же — тоскливо.
 * Человек приносит свой файл, и будильник звонит им — с любого устройства,
 * потому что звук лежит на сервере, а не в браузере, который может почистить
 * хранилище в любой момент.
 *
 * Здесь только метаданные: имя, тип, размер. Сам файл живёт на диске рядом
 * с базой — в sounds/<user_id>/<id>.<ext>. Класть звук в базу значило бы
 * раздувать её мегабайтными строками и таскать их через каждый бэкап
 * по нескольку раз.
 *
 * `ext` хранится отдельно от `mime`, чтобы путь к файлу собирался из строки
 * таблицы, а не вычислялся заново из типа: правило «mime → расширение»
 * однажды поменяется, а файлы на диске уже названы по-старому.
 */

module.exports = {
  version: 9,
  name: 'user-sounds',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_sounds (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT    NOT NULL,
        mime       TEXT    NOT NULL,
        ext        TEXT    NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS user_sounds_user ON user_sounds (user_id);
    `);
  },
};
