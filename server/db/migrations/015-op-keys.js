/**
 * Ключи повторных запросов.
 *
 * Приложение больше не ждёт ответа сервера: правка ложится в очередь на
 * устройстве и уезжает сама. Значит, случится и такое — сервер записал, а
 * ответ не доехал. Очередь повторит запрос, и без ключа в дне появится
 * вторая такая же строка.
 *
 * Только для создания: PATCH с готовыми значениями и DELETE безопасны сами
 * по себе. Ключ хранится вместе с ответом, чтобы повтор получил ровно то
 * же, что и первый запрос, — включая номер созданной строки, без которого
 * очередь не заменит временный id настоящим.
 */

module.exports = {
  version: 15,
  name: 'op-keys',
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS op_keys (
      user_id    INTEGER NOT NULL,
      key        TEXT    NOT NULL,
      status     INTEGER NOT NULL,
      body       TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, key)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_op_keys_created ON op_keys(created_at)');
  },
};
