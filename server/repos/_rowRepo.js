const { notFound, conflict } = require('../lib/errors');
const { bumpRev } = require('./days');

/**
 * Общая фабрика репозитория «строк дня»: расписание, задачи, питание, спорт.
 *
 * Каждая операция трогает ровно одну строку и поднимает rev дня. Именно это
 * и убирает старую гонку, когда клиент присылал день целиком и затирал чужие правки.
 *
 * @param db          экземпляр better-sqlite3
 * @param table       имя таблицы
 * @param fieldMap    { camelCaseИмяВAPI: имя_колонки }
 * @param defaults    значения по умолчанию при создании (ключи из fieldMap)
 * @param orderBy     выражение ORDER BY для list()
 */
function makeRowRepo(db, table, fieldMap, defaults, orderBy = 'sort_order ASC, id ASC') {
  const BOOL_KEYS = new Set(['done']);

  const own = (userId, id) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`).get(id, userId);
    if (!row) throw notFound('Запись не найдена');
    return row;
  };

  const self = {
    table,

    list(userId, date) {
      return db.prepare(
        `SELECT * FROM ${table} WHERE user_id = ? AND date = ? ORDER BY ${orderBy}`
      ).all(userId, date);
    },

    getById(userId, id) {
      return own(userId, id);
    },

    create(userId, date, data) {
      const maxOrder = db.prepare(
        `SELECT COALESCE(MAX(sort_order), -1) AS m FROM ${table} WHERE user_id = ? AND date = ?`
      ).get(userId, date).m;

      const cols = ['user_id', 'date'];
      const vals = [userId, date];
      for (const [key, col] of Object.entries(fieldMap)) {
        let v = data[key] !== undefined ? data[key] : defaults[key];
        if (col === 'sort_order' && (v === undefined || v === null)) v = maxOrder + 1;
        if (v === undefined) v = null;
        if (BOOL_KEYS.has(key)) v = v ? 1 : 0;
        cols.push(col);
        vals.push(v);
      }

      const info = db.prepare(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      ).run(...vals);

      bumpRev(db, userId, date);
      return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(info.lastInsertRowid);
    },

    update(userId, id, data) {
      const row = own(userId, id);
      if (data.updatedAt && data.updatedAt !== row.updated_at) {
        throw conflict('STALE_ROW', 'Запись изменена в другом месте', { current: row });
      }
      const cols = [], vals = [];
      for (const [key, col] of Object.entries(fieldMap)) {
        if (data[key] === undefined) continue;
        cols.push(`${col} = ?`);
        vals.push(BOOL_KEYS.has(key) ? (data[key] ? 1 : 0) : data[key]);
      }
      if (cols.length) {
        cols.push("updated_at = datetime('now')");
        db.prepare(`UPDATE ${table} SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
      }
      bumpRev(db, userId, row.date);
      return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    },

    remove(userId, id) {
      const row = own(userId, id);
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      bumpRev(db, userId, row.date);
      return row;
    },

    reorder(userId, date, ids) {
      const tx = db.transaction(() => {
        ids.forEach((id, i) => {
          const r = db.prepare(
            `UPDATE ${table} SET sort_order = ?, updated_at = datetime('now')
              WHERE id = ? AND user_id = ? AND date = ?`
          ).run(i, id, userId, date);
          if (r.changes === 0) throw notFound(`Запись ${id} не найдена в этом дне`);
        });
      });
      tx();
      bumpRev(db, userId, date);
      return self.list(userId, date);
    },

    removeAllForDate(userId, date) {
      db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND date = ?`).run(userId, date);
    },
  };

  return self;
}

module.exports = { makeRowRepo };
