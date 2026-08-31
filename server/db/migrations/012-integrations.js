/**
 * Идентичность записей для внешних интеграций.
 *
 * `source` + `external_id` — кто создал запись и как она зовётся на его
 * стороне: по этой паре /integrations/apply отличает «свою» запись от чужой
 * и от ручной, поэтому повторный запуск интеграции не плодит дубли.
 * NULL в source — запись человека, их подавляющее большинство.
 *
 * `last_modified_by` — кто менял последним: 'user' либо имя source. По нему
 * apply понимает, что запись правил человек, и не смеет её перетирать.
 *
 * `integration_tombstones` — надгробия: человек удалил запись интеграции, и
 * она не вправе её воскресить. `date` пустой строкой, а не NULL: NULL в
 * UNIQUE-индексе SQLite не равен сам себе, и надгробия дублировались бы.
 *
 * Частичные уникальные индексы (WHERE source IS NOT NULL) не трогают обычные
 * записи: у них ключа идентичности нет и уникальность им не нужна.
 */

module.exports = {
  version: 12,
  name: 'integrations',
  up(db) {
    db.exec(`
      ALTER TABLE schedule_items ADD COLUMN source TEXT;
      ALTER TABLE schedule_items ADD COLUMN external_id TEXT;
      ALTER TABLE schedule_items ADD COLUMN last_modified_by TEXT NOT NULL DEFAULT 'user';

      ALTER TABLE tasks ADD COLUMN source TEXT;
      ALTER TABLE tasks ADD COLUMN external_id TEXT;
      ALTER TABLE tasks ADD COLUMN last_modified_by TEXT NOT NULL DEFAULT 'user';

      ALTER TABLE meals ADD COLUMN source TEXT;
      ALTER TABLE meals ADD COLUMN external_id TEXT;
      ALTER TABLE meals ADD COLUMN last_modified_by TEXT NOT NULL DEFAULT 'user';

      ALTER TABLE sport_sets ADD COLUMN source TEXT;
      ALTER TABLE sport_sets ADD COLUMN external_id TEXT;
      ALTER TABLE sport_sets ADD COLUMN last_modified_by TEXT NOT NULL DEFAULT 'user';

      ALTER TABLE habits ADD COLUMN source TEXT;
      ALTER TABLE habits ADD COLUMN external_id TEXT;
      ALTER TABLE habits ADD COLUMN last_modified_by TEXT NOT NULL DEFAULT 'user';

      ALTER TABLE series ADD COLUMN source TEXT;
      ALTER TABLE series ADD COLUMN external_id TEXT;
      ALTER TABLE series ADD COLUMN last_modified_by TEXT NOT NULL DEFAULT 'user';

      CREATE UNIQUE INDEX idx_schedule_ext ON schedule_items (user_id, date, source, external_id) WHERE source IS NOT NULL;
      CREATE UNIQUE INDEX idx_tasks_ext    ON tasks          (user_id, date, source, external_id) WHERE source IS NOT NULL;
      CREATE UNIQUE INDEX idx_meals_ext    ON meals          (user_id, date, source, external_id) WHERE source IS NOT NULL;
      CREATE UNIQUE INDEX idx_sport_ext    ON sport_sets     (user_id, date, source, external_id) WHERE source IS NOT NULL;
      CREATE UNIQUE INDEX idx_habits_ext   ON habits         (user_id, source, external_id) WHERE source IS NOT NULL;
      CREATE UNIQUE INDEX idx_series_ext   ON series         (user_id, source, external_id) WHERE source IS NOT NULL;

      CREATE TABLE integration_tombstones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        entity TEXT NOT NULL,
        date TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX idx_tombstones_key
        ON integration_tombstones (user_id, entity, date, source, external_id);
    `);
  },
};
