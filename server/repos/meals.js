const { makeRowRepo } = require('./_rowRepo');
const { notFound } = require('../lib/errors');

const FIELD_MAP = {
  slot: 'slot', timeMin: 'time_min', title: 'title', note: 'note',
  calories: 'calories', done: 'done', sortOrder: 'sort_order',
  endMin: 'end_min', scheduleItemId: 'schedule_item_id',
  remindBefore: 'remind_before_json',
};

const DEFAULTS = {
  slot: 'other', timeMin: null, title: '', note: '', calories: null, done: 0,
  endMin: null, scheduleItemId: null, remindBefore: null,
};

/**
 * Питание хранится одинаково в обоих режимах интерфейса (checklist и timed):
 * режим влияет только на то, показывается ли time_min и попадают ли записи
 * в расписание дня. Переключение режима данные не теряет.
 */
function mealsRepo(db) {
  const base = makeRowRepo(db, 'meals', FIELD_MAP, DEFAULTS,
    'CASE WHEN time_min IS NULL THEN 1 ELSE 0 END, time_min ASC, sort_order ASC, id ASC');

  /**
   * Блок расписания, за который цепляется приём пищи, обязан быть своим.
   *
   * Номер приходит от клиента, и его никто не сверял. А планировщик по этой
   * ссылке решает «за него напомнит блок» и сам молчит — поэтому чужой или
   * несуществующий номер выключал напоминание насовсем: колокольчик горит,
   * срок задан, уведомления нет. Проверка та же по смыслу, что у привязки
   * строки к повтору (repos/schedule.setSeries): чужое не подходит.
   */
  const checkLink = (userId, data) => {
    if (data.scheduleItemId === undefined || data.scheduleItemId === null) return;
    const own = db.prepare('SELECT id FROM schedule_items WHERE id = ? AND user_id = ?')
      .get(data.scheduleItemId, userId);
    if (!own) throw notFound('Строка расписания не найдена');
  };

  return {
    ...base,
    create(userId, date, data) {
      checkLink(userId, data);
      return base.create(userId, date, data);
    },
    update(userId, id, data) {
      checkLink(userId, data);
      return base.update(userId, id, data);
    },
  };
}

module.exports = { mealsRepo, MEALS_FIELD_MAP: FIELD_MAP };
