const { notFound } = require('../lib/errors');

const FIELD_MAP = {
  target: 'target', freq: 'freq', interval: 'interval', byweekday: 'byweekday',
  startDate: 'start_date', endDate: 'end_date', payloadJson: 'payload_json', name: 'name',
};

function seriesRepo(db) {
  const own = (userId, id) => {
    const row = db.prepare('SELECT * FROM series WHERE id = ? AND user_id = ?').get(id, userId);
    if (!row) throw notFound('Повтор не найден');
    return row;
  };

  const self = {
    /** Правила без имени — это повторы; с именем — шаблоны, применяются вручную. */
    list(userId, { target = null, templates = null } = {}) {
      const where = ['user_id = ?'], args = [userId];
      if (target) { where.push('target = ?'); args.push(target); }
      if (templates === true) where.push('name IS NOT NULL');
      if (templates === false) where.push('name IS NULL');
      return db.prepare(`SELECT * FROM series WHERE ${where.join(' AND ')} ORDER BY id`).all(...args);
    },

    get: own,

    /** Активные повторы, которые могут попасть в указанную дату. */
    activeOn(userId, target, date) {
      return db.prepare(`
        SELECT * FROM series
         WHERE user_id = ? AND target = ? AND name IS NULL
           AND start_date IS NOT NULL AND start_date <= ?
           AND (end_date IS NULL OR end_date >= ?)
      `).all(userId, target, date, date);
    },

    create(userId, data) {
      const cols = ['user_id'], vals = [userId];
      for (const [key, col] of Object.entries(FIELD_MAP)) {
        if (data[key] === undefined) continue;
        cols.push(col);
        vals.push(data[key]);
      }
      const info = db.prepare(
        `INSERT INTO series (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      ).run(...vals);
      return db.prepare('SELECT * FROM series WHERE id = ?').get(info.lastInsertRowid);
    },

    update(userId, id, data) {
      own(userId, id);
      const cols = [], vals = [];
      for (const [key, col] of Object.entries(FIELD_MAP)) {
        if (data[key] === undefined) continue;
        cols.push(`${col} = ?`);
        vals.push(data[key]);
      }
      if (cols.length) {
        cols.push("updated_at = datetime('now')");
        db.prepare(`UPDATE series SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
      }
      return db.prepare('SELECT * FROM series WHERE id = ?').get(id);
    },

    remove(userId, id) {
      own(userId, id);
      // уже созданные строки остаются: они часть прожитых дней
      db.prepare('UPDATE schedule_items SET series_id = NULL WHERE series_id = ? AND user_id = ?').run(id, userId);
      db.prepare('DELETE FROM series WHERE id = ?').run(id);
    },

    /** Завершить серию с даты, не трогая прошлое. */
    endFrom(userId, id, date) {
      own(userId, id);
      const { addDays } = require('../lib/dates');
      db.prepare("UPDATE series SET end_date = ?, updated_at = datetime('now') WHERE id = ?")
        .run(addDays(date, -1), id);
      db.prepare('DELETE FROM schedule_items WHERE user_id = ? AND series_id = ? AND date >= ?')
        .run(userId, id, date);
      return db.prepare('SELECT * FROM series WHERE id = ?').get(id);
    },

    // ── Переопределения по дням ─────────────────────────────────
    overridesFor(userId, date) {
      return db.prepare('SELECT series_id, action FROM series_overrides WHERE user_id = ? AND date = ?')
        .all(userId, date);
    },

    setOverride(userId, seriesId, date, action) {
      db.prepare(`
        INSERT INTO series_overrides (user_id, series_id, date, action) VALUES (?,?,?,?)
        ON CONFLICT(series_id, date) DO UPDATE SET action = excluded.action
      `).run(userId, seriesId, date, action);
    },

    clearOverride(userId, seriesId, date) {
      db.prepare('DELETE FROM series_overrides WHERE user_id = ? AND series_id = ? AND date = ?')
        .run(userId, seriesId, date);
    },
  };
  return self;
}

module.exports = { seriesRepo, SERIES_FIELD_MAP: FIELD_MAP };
