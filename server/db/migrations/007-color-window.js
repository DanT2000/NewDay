function addColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

module.exports = {
  version: 7,
  name: 'color-window',
  up(db) {
    /*
     * Цвет блока расписания. Пустой цвет — цвет приложения: так день,
     * заполненный до появления выбора, остаётся ровно таким, каким был,
     * и смена цвета приложения по-прежнему перекрашивает его целиком.
     */
    addColumn(db, 'schedule_items', 'color', 'color TEXT');

    /*
     * Приём пищи бывает окном: «обед с 12:00 до 14:00» — это не точное
     * время, а мягкая рамка. Раньше было только одно поле time_min, и окно
     * приходилось бы врать точным временем начала.
     *
     * end_min пустой у точного времени и у пункта без времени; заполнен
     * только у окна. Отдельного признака режима нет намеренно: режим
     * однозначно читается из пары полей, а два источника правды разошлись бы.
     */
    addColumn(db, 'meals', 'end_min', 'end_min INTEGER');

    /*
     * Приём пищи со временем может занять блок в расписании. Ссылка нужна
     * в обе стороны: без неё правка времени приёма оставляла бы в расписании
     * блок-сироту, а удаление приёма — блок, которому больше нечего означать.
     */
    addColumn(db, 'meals', 'schedule_item_id', 'schedule_item_id INTEGER');
    addColumn(db, 'meals', 'remind_before_json', 'remind_before_json TEXT');

    /*
     * Свободный график привычки: «три раза в неделю», без привязки к дням.
     * Маска дней недели этого не выражает — она отвечает на вопрос «в какие
     * дни», а здесь важно только сколько раз. Пусто значит прежнее поведение:
     * график задан днями недели.
     */
    addColumn(db, 'habits', 'times_per_week', 'times_per_week INTEGER');

    /*
     * Заметки без даты.
     *
     * Заметка с датой — это заметка дня, и она живёт полем дня: так её видят
     * и печать, и выгрузка, и сам день. А заметке «книги на осень» дата не
     * нужна вовсе, и в день её положить некуда — для них эта таблица.
     *
     * Хранилище выбирается однозначно по наличию даты, поэтому двух правд не
     * возникает: одна и та же заметка не может лежать в обоих местах.
     */
    db.exec(`CREATE TABLE IF NOT EXISTS free_notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title      TEXT NOT NULL DEFAULT '',
      text       TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_free_notes_user ON free_notes(user_id, updated_at DESC)');
  },
};
