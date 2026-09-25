const { notFound } = require('../lib/errors');
const { tombstonesRepo } = require('../repos/tombstones');
const { bumpRev } = require('./days');

const FIELD_MAP = {
  title: 'title', description: 'description', emoji: 'emoji', color: 'color',
  type: 'type', targetPerDay: 'target_per_day', unit: 'unit',
  scheduleMask: 'schedule_mask', polarity: 'polarity', mode: 'mode',
  challengeTargetDays: 'challenge_target_days', challengeStartDate: 'challenge_start_date',
  breakPolicy: 'break_policy', allowedSkipsPerWeek: 'allowed_skips_per_week',
  isActive: 'is_active', sortOrder: 'sort_order', timesPerWeek: 'times_per_week',
  source: 'source', externalId: 'external_id', lastModifiedBy: 'last_modified_by',
};

function habitsRepo(db) {
  const own = (userId, id) => {
    const row = db.prepare('SELECT * FROM habits WHERE id = ? AND user_id = ?').get(id, userId);
    if (!row) throw notFound('Привычка не найдена');
    return row;
  };

  const tombs = tombstonesRepo(db);

  const self = {
    list(userId, { includeArchived = false } = {}) {
      const where = includeArchived ? '' : 'AND archived_at IS NULL';
      return db.prepare(
        `SELECT * FROM habits WHERE user_id = ? ${where} ORDER BY sort_order ASC, created_at ASC, id ASC`
      ).all(userId);
    },

    get: own,

    create(userId, data) {
      const maxOrder = db.prepare(
        'SELECT COALESCE(MAX(sort_order), -1) AS m FROM habits WHERE user_id = ?'
      ).get(userId).m;

      const cols = ['user_id'], vals = [userId];
      for (const [key, col] of Object.entries(FIELD_MAP)) {
        let val = data[key];
        if (col === 'sort_order' && (val === undefined || val === null)) val = maxOrder + 1;
        if (val === undefined) continue;
        if (key === 'isActive') val = val ? 1 : 0;
        cols.push(col);
        vals.push(val);
      }
      const info = db.prepare(
        `INSERT INTO habits (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      ).run(...vals);
      return db.prepare('SELECT * FROM habits WHERE id = ?').get(info.lastInsertRowid);
    },

    update(userId, id, data) {
      own(userId, id);
      const cols = [], vals = [];
      for (const [key, col] of Object.entries(FIELD_MAP)) {
        if (data[key] === undefined) continue;
        cols.push(`${col} = ?`);
        vals.push(key === 'isActive' ? (data[key] ? 1 : 0) : data[key]);
      }
      // обычная правка — правка человека; apply присылает source сам
      if (cols.length && data.lastModifiedBy === undefined) {
        cols.push('last_modified_by = ?');
        vals.push('user');
      }
      if (cols.length) {
        cols.push("updated_at = datetime('now')");
        db.prepare(`UPDATE habits SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
      }
      return db.prepare('SELECT * FROM habits WHERE id = ?').get(id);
    },

    /** Мягкое удаление: логи остаются, статистика прошлого не рушится. */
    archive(userId, id, opts = {}) {
      const row = own(userId, id);
      // архив руками человека — надгробие: интеграция не воскресит привычку
      if (row.source && !opts.fromIntegration) {
        tombs.put(userId, 'habit', '', row.source, row.external_id);
      }
      db.prepare(
        "UPDATE habits SET archived_at = datetime('now'), is_active = 0, updated_at = datetime('now') WHERE id = ?"
      ).run(id);
      return db.prepare('SELECT * FROM habits WHERE id = ?').get(id);
    },

    restore(userId, id) {
      const row = own(userId, id);
      // возвращение из архива снимает надгробие, если оно было
      if (row.source) tombs.clear(userId, 'habit', '', row.source, row.external_id);
      db.prepare(
        "UPDATE habits SET archived_at = NULL, is_active = 1, updated_at = datetime('now') WHERE id = ?"
      ).run(id);
      return db.prepare('SELECT * FROM habits WHERE id = ?').get(id);
    },

    remove(userId, id, opts = {}) {
      const row = own(userId, id);
      if (row.source && !opts.fromIntegration) {
        tombs.put(userId, 'habit', '', row.source, row.external_id);
      }
      db.prepare('DELETE FROM habits WHERE id = ?').run(id); // логи уходят каскадом
    },

    reorder(userId, ids) {
      const tx = db.transaction(() => {
        ids.forEach((id, i) => {
          const r = db.prepare(
            "UPDATE habits SET sort_order = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
          ).run(i, id, userId);
          if (r.changes === 0) throw notFound(`Привычка ${id} не найдена`);
        });
      });
      tx();
      return self.list(userId);
    },

    // ── логи ────────────────────────────────────────────────────────
    logsInRange(userId, habitId, from, to) {
      const where = ['user_id = ?', 'habit_id = ?'], args = [userId, habitId];
      if (from) { where.push('date >= ?'); args.push(from); }
      if (to)   { where.push('date <= ?'); args.push(to); }
      return db.prepare(
        `SELECT date, status, value FROM habit_logs WHERE ${where.join(' AND ')} ORDER BY date ASC`
      ).all(...args);
    },

    logsForDate(userId, date) {
      return db.prepare(
        'SELECT habit_id, status, value FROM habit_logs WHERE user_id = ? AND date = ?'
      ).all(userId, date);
    },

    /*
     * Отметка привычки поднимает версию дня.
     *
     * День отдаёт привычки и прогресс, а его ETag — это `rev`. Пока отметка
     *версию не трогала, телефон ставил галочку, а браузер продолжал считать свою
     * копию дня свежей: тот же ETag, тот же `If-Match` — и следующая правка
     * из браузера затирала отметку, не заметив чужого изменения.
     */
    /**
     * Отметка дня.
     *
     * `value` без значения (undefined) — «не трогать», а не «стереть».
     * Раньше умолчанием был null, и любая отметка без числа обнуляла счёт: у
     * привычки «вода» стояло 8 стаканов, палец по галочке — и число исчезло.
     * Отдельно приходит явный `null` — это «убрать число», и он работает.
     */
    setLog(userId, habitId, date, { status, value }) {
      own(userId, habitId);
      const было = db.prepare(
        'SELECT value FROM habit_logs WHERE user_id = ? AND habit_id = ? AND date = ?'
      ).get(userId, habitId, date);
      const итог = value === undefined ? (было?.value ?? null) : value;
      db.prepare(`
        INSERT INTO habit_logs (user_id, habit_id, date, status, value)
        VALUES (?,?,?,?,?)
        ON CONFLICT(user_id, habit_id, date)
        DO UPDATE SET status = excluded.status, value = excluded.value, updated_at = datetime('now')
      `).run(userId, habitId, date, status, итог);
      bumpRev(db, userId, date);
      return db.prepare(
        'SELECT date, status, value FROM habit_logs WHERE user_id = ? AND habit_id = ? AND date = ?'
      ).get(userId, habitId, date);
    },

    clearLog(userId, habitId, date) {
      own(userId, habitId);
      db.prepare('DELETE FROM habit_logs WHERE user_id = ? AND habit_id = ? AND date = ?')
        .run(userId, habitId, date);
      bumpRev(db, userId, date);
    },
  };
  return self;
}

module.exports = { habitsRepo, HABIT_FIELD_MAP: FIELD_MAP };
