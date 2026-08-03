const { makeRowRepo } = require('./_rowRepo');

const FIELD_MAP = {
  slot: 'slot', timeMin: 'time_min', title: 'title', note: 'note',
  done: 'done', sortOrder: 'sort_order',
};

const DEFAULTS = { slot: 'other', timeMin: null, title: '', note: '', done: 0 };

/**
 * Питание хранится одинаково в обоих режимах интерфейса (checklist и timed):
 * режим влияет только на то, показывается ли time_min и попадают ли записи
 * в расписание дня. Переключение режима данные не теряет.
 */
const mealsRepo = db => makeRowRepo(db, 'meals', FIELD_MAP, DEFAULTS,
  'CASE WHEN time_min IS NULL THEN 1 ELSE 0 END, time_min ASC, sort_order ASC, id ASC');

module.exports = { mealsRepo, MEALS_FIELD_MAP: FIELD_MAP };
