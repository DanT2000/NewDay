/**
 * Сообщения о проблемах: человек нажал одну кнопку и рассказал, что не так.
 *
 * Задумано под живое пользование, а не под переписку: человек наговаривает
 * голосом («бац, записал»), приложение само прикладывает версию, экран,
 * размеры и последние события — и возвращает человека к его делам.
 *
 * Почему запись хранится, даже когда расшифровка не вышла: расшифровка
 * зависит от чужого сервиса, который может лежать, а сказанное человеком
 * повторить некому. Поэтому `voice_error` — не отказ, а пометка: текст
 * прочитать не удалось, файл на месте, слушайте.
 *
 * `context` и `log` — JSON строкой: это снимок обстоятельств, по которому
 * никогда не ищут запросами, а читают целиком вместе с самим сообщением.
 * Раскладывать его по колонкам значило бы закрепить состав, который будет
 * меняться с каждой версией приложения.
 *
 * Файлы лежат на диске (data/reports/<id>/), а не в базе: запись голоса и
 * снимок экрана — мегабайты, и блобы в SQLite раздувают файл, который
 * целиком читается при каждом запуске.
 */

module.exports = {
  version: 13,
  name: 'reports',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        text         TEXT    NOT NULL DEFAULT '',
        typed        INTEGER NOT NULL DEFAULT 0,
        voice_error  TEXT,
        audio_ext    TEXT,
        audio_bytes  INTEGER,
        shot_ext     TEXT,
        shot_bytes   INTEGER,
        context      TEXT    NOT NULL DEFAULT '{}',
        log          TEXT    NOT NULL DEFAULT '[]',
        status       TEXT    NOT NULL DEFAULT 'new',
        created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS reports_fresh ON reports(created_at DESC);
      CREATE INDEX IF NOT EXISTS reports_status ON reports(status, created_at DESC);
    `);
  },
};
