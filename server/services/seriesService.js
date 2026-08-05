/**
 * Повторяющиеся строки расписания.
 *
 * Правило живёт в `series`, а конкретный день получает настоящую строку —
 * её можно править и отмечать, как любую другую. Удаление или правка
 * отдельного дня записывается в `series_overrides` и не ломает всю серию.
 *
 * Материализация происходит при открытии дня. Это осознанный выбор: человек,
 * открывший завтрашний день, ожидает увидеть там своё расписание, а не пустоту.
 */

const { seriesRepo } = require('../repos/series');
const { scheduleRepo } = require('../repos/schedule');
const { weekdayInMask, diffDays } = require('../lib/dates');

/** Попадает ли дата в правило повтора. */
function matchesDate(rule, date) {
  if (!rule.start_date || date < rule.start_date) return false;
  if (rule.end_date && date > rule.end_date) return false;

  const interval = Math.max(1, rule.interval || 1);

  if (rule.freq === 'daily') {
    return diffDays(rule.start_date, date) % interval === 0;
  }
  if (rule.freq === 'weekly') {
    if (!weekdayInMask(date, rule.byweekday)) return false;
    // недели считаем от понедельника недели, в которую попадает старт
    const weeks = Math.floor(diffDays(startOfWeek(rule.start_date), date) / 7);
    return weeks >= 0 && weeks % interval === 0;
  }
  if (rule.freq === 'monthly') {
    return date.slice(8, 10) === rule.start_date.slice(8, 10);
  }
  // Ежегодно — то же число того же месяца. Без него не выразить ни день
  // рождения, ни годовщину, а в напоминаниях это половина случаев
  if (rule.freq === 'yearly') {
    return date.slice(5) === rule.start_date.slice(5);
  }
  return false;
}

function startOfWeek(dateStr) {
  const { addDays, weekdayOf } = require('../lib/dates');
  return addDays(dateStr, -(weekdayOf(dateStr) - 1));
}

function seriesService(db) {
  const series = seriesRepo(db);
  const schedule = scheduleRepo(db);

  /**
   * Достраивает день строками из активных повторов.
   * Идемпотентна: строка, уже созданная для этой серии и даты, не дублируется.
   */
  function materializeDay(userId, date, { today = null } = {}) {
    const rules = series.activeOn(userId, 'schedule', date);
    if (!rules.length) return fillFromTemplate(userId, date, today);

    const overrides = new Map(series.overridesFor(userId, date).map(o => [o.series_id, o.action]));
    const existing = new Set(
      schedule.list(userId, date).map(r => r.series_id).filter(Boolean)
    );

    let created = 0;
    for (const rule of rules) {
      if (overrides.get(rule.id) === 'deleted') continue;   // удалено именно в этот день
      if (existing.has(rule.id)) continue;                  // уже материализовано
      if (!matchesDate(rule, date)) continue;

      let payload;
      try { payload = JSON.parse(rule.payload_json); } catch { continue; }

      schedule.create(userId, date, {
        startMin: payload.startMin ?? 0,
        endMin: payload.endMin ?? null,
        title: payload.title ?? '',
        note: payload.note ?? '',
        kind: payload.kind ?? 'normal',
        alarmMode: payload.alarmMode ?? 'none',
        alarmProfile: payload.alarmProfile ?? 'gentle',
        remindBeforeMin: payload.remindBeforeMin ?? null,
        /*
         * Список сроков и цвет переносим тоже. Без этого повтор терял их при
         * достраивании дня: «за день» становилось «вовремя», а цветной блок
         * приезжал цветом приложения.
         */
        remindBefore: Array.isArray(payload.remindBefore) && payload.remindBefore.length
          ? JSON.stringify(payload.remindBefore) : null,
        color: payload.color ?? null,
        seriesId: rule.id,
        done: 0,
      });
      created += 1;
    }
    return created + fillFromTemplate(userId, date, today);
  }

  /**
   * Пустой день заполняется шаблоном — это то, что обещает подпись под
   * шаблоном. Три ограничения, без которых обещание превращается в беду:
   *
   * — только сегодня и вперёд: дописывать прошлое значит переписывать то,
   *   что человек уже прожил;
   * — только в пустой день: если в дне хоть что-то есть, план уже свой;
   * — только один раз на дату. Отметка кладётся в `series_overrides`,
   *   поэтому день, из которого всё удалили, не заполняется снова.
   */
  function fillFromTemplate(userId, date, today) {
    if (!today || date < today) return 0;

    const tpl = series.list(userId, { target: 'schedule', templates: true })[0];
    if (!tpl) return 0;

    const marks = series.overridesFor(userId, date);
    if (marks.some(o => o.series_id === tpl.id)) return 0;
    if (schedule.list(userId, date).length) return 0;

    const created = applyTemplate(userId, date, tpl.id);
    series.setOverride(userId, tpl.id, date, 'applied');
    return created;
  }

  /** Применяет именованный шаблон к дню — вручную, а не по расписанию. */
  function applyTemplate(userId, date, seriesId) {
    const rule = series.get(userId, seriesId);
    let payload;
    try { payload = JSON.parse(rule.payload_json); } catch { payload = {}; }
    const rows = Array.isArray(payload.rows) ? payload.rows : [payload];

    const tx = db.transaction(() => {
      rows.forEach((r, i) => schedule.create(userId, date, {
        startMin: r.startMin ?? 0, endMin: r.endMin ?? null,
        title: r.title ?? '', note: r.note ?? '',
        kind: r.kind ?? 'normal', alarmMode: r.alarmMode ?? 'none',
        alarmProfile: r.alarmProfile ?? 'gentle',
        remindBeforeMin: r.remindBeforeMin ?? null,
        sortOrder: i, done: 0,
      }));
    });
    tx();
    return rows.length;
  }

  return { materializeDay, applyTemplate, matchesDate };
}

module.exports = { seriesService, matchesDate };
