function addColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

module.exports = {
  version: 3,
  name: 'meal-calories',
  up(db) {
    // Калории — необязательное поле: кто считает, тот заполняет,
    // остальные его просто не видят.
    addColumn(db, 'meals', 'calories', 'calories INTEGER');
  },
};
