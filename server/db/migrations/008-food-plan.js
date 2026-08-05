function addColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

module.exports = {
  version: 8,
  name: 'food-plan',
  up(db) {
    /*
     * План питания на день — свободный текст: «курица, рис, овощи, творог».
     *
     * Главное в питании — список того, что нужно съесть, а время и калории
     * необязательны. Раньше этот текст был вписан в разметку постоянной
     * строкой: экран показывал одно и то же всем и во все дни.
     *
     * Цель по калориям живёт в настройках человека, а не здесь: она общая для
     * всех дней, и держать её копию в каждом дне значило бы менять их все.
     */
    addColumn(db, 'days', 'food_plan', "food_plan TEXT NOT NULL DEFAULT ''");
  },
};
