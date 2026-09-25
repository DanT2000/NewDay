const { notFound } = require('../lib/errors');
const { tombstonesRepo } = require('./tombstones');
const { bumpRev } = require('./days');

const FIELD_MAP = {
  target: 'target', freq: 'freq', interval: 'interval', byweekday: 'byweekday',
  startDate: 'start_date', endDate: 'end_date', payloadJson: 'payload_json', name: 'name',
  source: 'source', externalId: 'external_id', lastModifiedBy: 'last_modified_by',
};

function seriesRepo(db) {
  const own = (userId, id) => {
    const row = db.prepare('SELECT * FROM series WHERE id = ? AND user_id = ?').get(id, userId);
    if (!row) throw notFound('Повтор не найден');
    return row;
  };

  const tombs = tombstonesRepo(db);

  /**
   * Дни, из которых сейчас уйдут строки повтора, — их версия должна вырасти.
   *
   * Версия дня (`rev`) — то, чем два устройства договариваются, кто правит
   * свежее. Удаление строк повтора меняло день, не двигая версию: телефон,
   * державший день в памяти, отправлял его целиком со старой версией, сервер
   * считал правку свежей — и удалённые строки возвращались. Собираем даты до
   * удаления, потому что после него их взять уже негде.
   */
  const датыПовтора = (userId, id, from = null) => db.prepare(`
    SELECT DISTINCT date FROM schedule_items
     WHERE user_id = ? AND series_id = ? AND (? IS NULL OR date >= ?)
  `).all(userId, id, from, from).map(r => r.date);

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
      // обычная правка — правка человека; apply присылает source сам
      if (cols.length && data.lastModifiedBy === undefined) {
        cols.push('last_modified_by = ?');
        vals.push('user');
      }
      if (cols.length) {
        cols.push("updated_at = datetime('now')");
        db.prepare(`UPDATE series SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
      }
      return db.prepare('SELECT * FROM series WHERE id = ?').get(id);
    },

    /**
     * Удалить правило.
     *
     * Прошлые строки остаются — они часть прожитых дней, и стирать их значит
     * переписывать прошлое. А будущие уходят: раньше оставались и они, и
     * «убрать повтор целиком» выглядело как кнопка, которая ничего не делает —
     * при том что более мягкое «не напоминать с этого дня» работало.
     *
     * @param today дата, с которой строки считаются будущими; без неё
     *              поведение прежнее — только отцепить.
     */
    remove(userId, id, { today = null, fromIntegration = false } = {}) {
      db.transaction(() => {
        const row = own(userId, id);
        // правило интеграции, удалённое человеком, не должно вернуться от apply
        if (row.source && !fromIntegration) {
          tombs.put(userId, 'series', '', row.source, row.external_id);
        }
        if (today) {
          const дни = датыПовтора(userId, id, today);
          db.prepare('DELETE FROM schedule_items WHERE user_id = ? AND series_id = ? AND date >= ?')
            .run(userId, id, today);
          for (const d of дни) bumpRev(db, userId, d);
        }
        db.prepare('UPDATE schedule_items SET series_id = NULL WHERE series_id = ? AND user_id = ?').run(id, userId);
        db.prepare('DELETE FROM series WHERE id = ?').run(id);
      })();
    },

    /** Завершить серию с даты, не трогая прошлое. */
    endFrom(userId, id, date) {
      return db.transaction(() => {
        own(userId, id);
        const { addDays } = require('../lib/dates');
        db.prepare("UPDATE series SET end_date = ?, last_modified_by = 'user', updated_at = datetime('now') WHERE id = ?")
          .run(addDays(date, -1), id);
        const дни = датыПовтора(userId, id, date);
        db.prepare('DELETE FROM schedule_items WHERE user_id = ? AND series_id = ? AND date >= ?')
          .run(userId, id, date);
        for (const d of дни) bumpRev(db, userId, d);
        return db.prepare('SELECT * FROM series WHERE id = ?').get(id);
      })();
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
