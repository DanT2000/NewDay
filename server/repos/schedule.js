const { makeRowRepo } = require('./_rowRepo');
const { ApiError, notFound, badRequest } = require('../lib/errors');
const { bumpRev } = require('./days');
const { parseTimeRange } = require('../lib/dates');

const FIELD_MAP = {
  startMin: 'start_min', endMin: 'end_min', title: 'title', note: 'note',
  done: 'done', sortOrder: 'sort_order', kind: 'kind',
  alarmMode: 'alarm_mode', alarmProfile: 'alarm_profile',
  remindBeforeMin: 'remind_before_min', seriesId: 'series_id',
};

const DEFAULTS = {
  startMin: 0, endMin: null, title: '', note: '', done: 0,
  kind: 'normal', alarmMode: 'none', alarmProfile: 'gentle',
  remindBeforeMin: null, seriesId: null,
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

  return {
    ...base,

    create(userId, date, data) {
      return base.create(userId, date, normalizeTime(data));
    },

    update(userId, id, data) {
      return base.update(userId, id, normalizeTime(data));
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

      const all = base.list(userId, date);
      const targets = cascade
        ? all.filter(r => r.start_min > from.start_min || r.id === from.id)
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
