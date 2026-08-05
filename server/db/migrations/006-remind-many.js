function addColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

module.exports = {
  version: 6,
  name: 'remind-many',
  up(db) {
    /*
     * Несколько сроков предупреждения у одной строки: «за день» и «за час»
     * одновременно — обычная просьба, а не редкость. Раньше хранилось одно
     * число, и второе некуда было положить.
     *
     * Список лежит рядом с прежним полем, а не вместо него: `remind_before_min`
     * остаётся первым (самым ранним) сроком, поэтому старые клиенты и
     * выгрузки продолжают работать, ничего не зная о списке.
     */
    addColumn(db, 'schedule_items', 'remind_before_json', 'remind_before_json TEXT');
  },
};
