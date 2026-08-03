const { notFound } = require('../lib/errors');

const DAY_FIELDS = ['title', 'focus', 'weight', 'notes'];

/**
 * Создаёт день, если его ещё нет, и увеличивает его версию.
 * INSERT OR IGNORE вместо «проверить и вставить» — защита от гонки
 * двух параллельных запросов, каждый из которых решил, что дня нет.
 */
function bumpRev(db, userId, date) {
  db.prepare('INSERT OR IGNORE INTO days (user_id, date) VALUES (?, ?)').run(userId, date);
  db.prepare("UPDATE days SET rev = rev + 1, updated_at = datetime('now') WHERE user_id = ? AND date = ?")
    .run(userId, date);
  return db.prepare('SELECT rev FROM days WHERE user_id = ? AND date = ?').get(userId, date).rev;
}

function daysRepo(db) {
  const self = {
    get(userId, date) {
      return db.prepare('SELECT * FROM days WHERE user_id = ? AND date = ?').get(userId, date) || null;
    },

    ensure(userId, date) {
      db.prepare('INSERT OR IGNORE INTO days (user_id, date) VALUES (?, ?)').run(userId, date);
      return self.get(userId, date);
    },

    patch(userId, date, fields) {
      self.ensure(userId, date);
      const cols = [], vals = [];
      for (const key of DAY_FIELDS) {
        if (fields[key] === undefined) continue;
        cols.push(`${key} = ?`);
        vals.push(fields[key]);
      }
      if (cols.length) {
        db.prepare(`UPDATE days SET ${cols.join(', ')} WHERE user_id = ? AND date = ?`)
          .run(...vals, userId, date);
      }
      bumpRev(db, userId, date);
      return self.get(userId, date);
    },

    remove(userId, date) {
      const tx = db.transaction(() => {
        for (const t of ['schedule_items', 'tasks', 'meals', 'sport_sets']) {
          db.prepare(`DELETE FROM ${t} WHERE user_id = ? AND date = ?`).run(userId, date);
        }
        const r = db.prepare('DELETE FROM days WHERE user_id = ? AND date = ?').run(userId, date);
        if (r.changes === 0) throw notFound('День не найден');
      });
      tx();
    },

    list(userId, from, to) {
      const where = ['user_id = ?'], args = [userId];
      if (from) { where.push('date >= ?'); args.push(from); }
      if (to)   { where.push('date <= ?'); args.push(to); }
      return db.prepare(
        `SELECT date, title, focus, weight, rev, updated_at
           FROM days WHERE ${where.join(' AND ')} ORDER BY date DESC`
      ).all(...args);
    },
  };
  return self;
}

module.exports = { daysRepo, bumpRev, DAY_FIELDS };
