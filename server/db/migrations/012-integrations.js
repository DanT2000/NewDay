/**
 * Добавить колонку, если её ещё нет.
 *
 * Тот же помощник, что в ранних миграциях. Сырой `ALTER TABLE ADD COLUMN`
 * при повторном проходе падает с «duplicate column name», и сервер не
 * поднимается вовсе — а повторный проход случается ровно тогда, когда он
 * нужнее всего: при восстановлении из резервной копии, снятой между шагом
 * миграции и записью её номера.
 */
function addColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

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
    addColumn(db, 'schedule_items', 'source', 'source TEXT');
    addColumn(db, 'schedule_items', 'external_id', 'external_id TEXT');
    addColumn(db, 'schedule_items', 'last_modified_by', "last_modified_by TEXT NOT NULL DEFAULT 'user'");
    addColumn(db, 'tasks', 'source', 'source TEXT');
    addColumn(db, 'tasks', 'external_id', 'external_id TEXT');
    addColumn(db, 'tasks', 'last_modified_by', "last_modified_by TEXT NOT NULL DEFAULT 'user'");
    addColumn(db, 'meals', 'source', 'source TEXT');
    addColumn(db, 'meals', 'external_id', 'external_id TEXT');
    addColumn(db, 'meals', 'last_modified_by', "last_modified_by TEXT NOT NULL DEFAULT 'user'");
    addColumn(db, 'sport_sets', 'source', 'source TEXT');
    addColumn(db, 'sport_sets', 'external_id', 'external_id TEXT');
    addColumn(db, 'sport_sets', 'last_modified_by', "last_modified_by TEXT NOT NULL DEFAULT 'user'");
    addColumn(db, 'habits', 'source', 'source TEXT');
    addColumn(db, 'habits', 'external_id', 'external_id TEXT');
    addColumn(db, 'habits', 'last_modified_by', "last_modified_by TEXT NOT NULL DEFAULT 'user'");
    addColumn(db, 'series', 'source', 'source TEXT');
    addColumn(db, 'series', 'external_id', 'external_id TEXT');
    addColumn(db, 'series', 'last_modified_by', "last_modified_by TEXT NOT NULL DEFAULT 'user'");
    db.exec(`

      CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_ext ON schedule_items (user_id, date, source, external_id) WHERE source IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_ext    ON tasks          (user_id, date, source, external_id) WHERE source IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_meals_ext    ON meals          (user_id, date, source, external_id) WHERE source IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sport_ext    ON sport_sets     (user_id, date, source, external_id) WHERE source IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_habits_ext   ON habits         (user_id, source, external_id) WHERE source IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_series_ext   ON series         (user_id, source, external_id) WHERE source IS NOT NULL;

      CREATE TABLE IF NOT EXISTS integration_tombstones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        entity TEXT NOT NULL,
        date TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tombstones_key
        ON integration_tombstones (user_id, entity, date, source, external_id);
    `);
  },
};
