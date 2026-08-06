const { makeRowRepo } = require('./_rowRepo');
const { ApiError, notFound, badRequest } = require('../lib/errors');
const { bumpRev } = require('./days');
const { parseTimeRange } = require('../lib/dates');

const FIELD_MAP = {
  startMin: 'start_min', endMin: 'end_min', title: 'title', note: 'note',
  done: 'done', sortOrder: 'sort_order', kind: 'kind',
  alarmMode: 'alarm_mode', alarmProfile: 'alarm_profile',
  remindBeforeMin: 'remind_before_min', remindBefore: 'remind_before_json',
  seriesId: 'series_id', color: 'color',
};

const DEFAULTS = {
  startMin: 0, endMin: null, title: '', note: '', done: 0,
  kind: 'normal', alarmMode: 'none', alarmProfile: 'gentle',
  remindBeforeMin: null, remindBefore: null, seriesId: null, color: null,
};

/**
 * Строку можно задать как startMin/endMin числами, так и полем time: «9:30-13».
 * Разбор живёт здесь, а не в валидаторе роута, чтобы им пользовались все входы:
 * и POST одной строки, и PUT /days/:date/full.
 */
function normalizeTime(data) {
  if (typeof data.time !== 'string' || !data.time.trim()) return data;
  const parsed = parseTimeRange(data.time);
  if (!parsed) {
    throw badRequest('Не удалось разобрать время. Примеры: 9:30, 930, 9:30-13:00',
      { time: data.time });
  }
  const { time, ...rest } = data;
  return { ...rest, startMin: parsed.startMin, endMin: parsed.endMin };
}

function scheduleRepo(db) {
  // Порядок задаёт сервер и он же его отдаёт — клиент не может разойтись с базой.
  const base = makeRowRepo(db, 'schedule_items', FIELD_MAP, DEFAULTS,
    'start_min ASC, sort_order ASC, id ASC');

  /**
   * Строка, пришедшая из повтора, при правке или удалении «отцепляется»:
   * этот день получает переопределение, а сама серия остаётся нетронутой.
   */
  const markOverride = (userId, seriesId, date, action) => {
    if (!seriesId) return;
    db.prepare(`
      INSERT INTO series_overrides (user_id, series_id, date, action) VALUES (?,?,?,?)
      ON CONFLICT(series_id, date) DO UPDATE SET action = excluded.action
    `).run(userId, seriesId, date, action);
  };

  return {
    ...base,

    create(userId, date, data) {
      return base.create(userId, date, normalizeTime(data));
    },

    update(userId, id, data) {
      const before = db.prepare('SELECT series_id, date FROM schedule_items WHERE id = ? AND user_id = ?')
        .get(id, userId);
      const result = base.update(userId, id, normalizeTime(data));
      // отметка «выполнено» серию не меняет, а правка содержимого — меняет
      const contentChanged = Object.keys(data).some(k => k !== 'done' && k !== 'updatedAt');
      if (before && contentChanged) markOverride(userId, before.series_id, before.date, 'modified');
      return result;
    },

    remove(userId, id) {
      const before = db.prepare('SELECT series_id, date FROM schedule_items WHERE id = ? AND user_id = ?')
        .get(id, userId);
      const row = base.remove(userId, id);
      /*
       * Приём пищи, который занимал этот блок, отпускаем.
       *
       * Ссылка двусторонняя, и без этого она оставалась висячей: приём пищи
       * продолжал показывать «в расписании», а любая его правка и даже
       * удаление упирались в «строка не найдена» — запись нельзя было ни
       * сохранить, ни убрать.
       */
      db.prepare('UPDATE meals SET schedule_item_id = NULL WHERE user_id = ? AND schedule_item_id = ?')
        .run(userId, id);
      if (before) markOverride(userId, before.series_id, before.date, 'deleted');
      return row;
    },

    /**
     * Привязать строку к повтору или отвязать (`seriesId: null`).
     *
     * Нужно затем, что «повторять» и «не повторять» — это про строку, а не
     * только про правило. Без привязки сервер считал, что повтор в этом дне
     * ещё не материализован, и создавал вторую такую же строку. Без отвязки
     * удаление правила забирало строку с собой, хотя человек просил всего
     * лишь не повторять её дальше.
     *
     * Чужое правило не подходит: id приходит от клиента, и привязка к чужому
     * повтору означала бы правку чужих дней.
     */
    setSeries(userId, id, seriesId) {
      const row = db.prepare('SELECT id, date FROM schedule_items WHERE id = ? AND user_id = ?')
        .get(id, userId);
      if (!row) throw notFound('Строка расписания не найдена');
      if (seriesId !== null) {
        const rule = db.prepare('SELECT id FROM series WHERE id = ? AND user_id = ?').get(seriesId, userId);
        if (!rule) throw notFound('Правило повтора не найдено');
      }
      db.prepare("UPDATE schedule_items SET series_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(seriesId, id);
      bumpRev(db, userId, row.date);
      return db.prepare('SELECT * FROM schedule_items WHERE id = ?').get(id);
    },

    /**
     * Сдвигает строку на minutes. При cascade — вместе со всеми, что начинаются позже.
     * Сценарий «задержался на обеде на 15 минут».
     */
    shift(userId, date, fromId, minutes, cascade) {
      const from = db.prepare(
        'SELECT * FROM schedule_items WHERE id = ? AND user_id = ?'
      ).get(fromId, userId);
      if (!from) throw notFound('Строка расписания не найдена');
      if (from.date !== date) throw notFound('Строка не принадлежит этому дню');

      /*
       * Сдвигаем всё, что начинается не раньше, — включая блок, начинающийся
       * в ту же минуту. Раньше сравнение было строгим, и два дела, стоящие на
       * одно время, разъезжались: первое уходило, второе оставалось и
       * продолжало пересекаться — то есть сдвиг не решал ту задачу, ради
       * которой его и вызвали.
       *
       * Объемлющий блок (работа, внутри которой созвон) не двигается: он
       * начался раньше, и «сдвинуть следующие» его не касается.
       */
      const all = base.list(userId, date);
      const targets = cascade
        ? all.filter(r => r.start_min >= from.start_min)
        : [from];

      for (const r of targets) {
        const s = r.start_min + minutes;
        const e = r.end_min === null ? null : r.end_min + minutes;
        if (s < 0 || s > 1439 || (e !== null && (e < 0 || e > 1439))) {
          throw new ApiError(400, 'OUT_OF_RANGE',
            'Сдвиг выходит за границы суток', { id: r.id });
        }
      }

      const tx = db.transaction(() => {
        for (const r of targets) {
          db.prepare(
            "UPDATE schedule_items SET start_min = ?, end_min = ?, updated_at = datetime('now') WHERE id = ?"
          ).run(r.start_min + minutes, r.end_min === null ? null : r.end_min + minutes, r.id);
        }
      });
      tx();
      bumpRev(db, userId, date);
      return base.list(userId, date);
    },
  };
}

module.exports = { scheduleRepo, SCHEDULE_FIELD_MAP: FIELD_MAP };
