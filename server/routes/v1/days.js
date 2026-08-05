const express = require('express');
const { wrap, badRequest } = require('../../lib/errors');
const v = require('../../lib/validate');
const { daysRepo } = require('../../repos/days');
const { dayService, DAY_SECTIONS } = require('../../services/dayService');
const {
  entityRouters, sanitizeSchedule, sanitizeTask, sanitizeMeal, sanitizeSport,
} = require('./entities');

/**
 * Строки дня в массовой записи проходят те же проверки, что и по одной.
 *
 * Раньше `PUT /days/:date/full` отдавал тело репозиторию как есть, и любое
 * поле, которому в базе нужен другой вид, роняло запрос в «внутреннюю ошибку»:
 * список сроков предупреждения уходил массивом и упирался в драйвер базы.
 * Проверка входа — работа роутера, и она должна быть одна для обоих путей.
 */
function cleanBody(body, ownSeries) {
  const rows = (list, sanitize, keep) => (Array.isArray(list) ? list : [])
    .filter(r => r && typeof r === 'object')
    .map(r => {
      const out = sanitize(r, { partial: false });
      // строка time разбирается репозиторием, поэтому доезжает как есть
      const withTime = out.time === undefined ? out : { ...out, time: String(r.time) };
      const extra = keep ? keep(r) : {};
      // прежний номер строки нужен, чтобы перевести на него ссылки после пересоздания
      const wasId = Number(r.id);
      return { ...withTime, ...extra, ...(Number.isInteger(wasId) && wasId > 0 ? { wasId } : {}) };
    });

  /*
   * Принадлежность строки повтору и связь приёма пищи с блоком проходят
   * насквозь, хотя правки не принимают.
   *
   * Иначе получалась ловушка: клиент отправлял обратно то, что только что
   * прочитал, `series_id` терялся, а следующий же `getFull` видел, что серии
   * в дне нет, и материализовал её заново — в ответе того же запроса
   * появлялась вторая копия строки, при следующей записи третья.
   */
  const seriesOf = r => {
    const id = Number(r.series_id ?? r.seriesId);
    // только свои правила: id серии приходит от клиента, и чужой означал бы
    // строку, привязанную к чужому повтору
    return Number.isInteger(id) && ownSeries.has(id) ? { seriesId: id } : {};
  };
  /*
   * Связь приёма пищи с блоком приходит прежним номером — тем, который клиент
   * прочитал. Полная замена дня пересоздаёт строки заново, поэтому здесь мы
   * только запоминаем прежний номер, а на новый его переводит `replaceFull`.
   */
  const blockOf = r => {
    const id = Number(r.schedule_item_id ?? r.scheduleItemId);
    return Number.isInteger(id) && id > 0 ? { wasScheduleItemId: id } : {};
  };

  return {
    ...body,
    schedule: rows(body.schedule, sanitizeSchedule, seriesOf),
    tasks: {
      work: rows(body.tasks?.work, sanitizeTask),
      home: rows(body.tasks?.home, sanitizeTask),
    },
    meals: rows(body.meals, sanitizeMeal, blockOf),
    sport: rows(body.sport, sanitizeSport),
  };
}

module.exports = function daysRouter({ db }) {
  const router = express.Router();
  const days = daysRepo(db);
  const svc = dayService(db);
  const entities = entityRouters(db);

  const dateOf = req => v.date(req.params.date, { field: 'дата' });
  const withEtag = (res, day) => { res.set('ETag', `"${day.rev}"`); return res.json(day); };

  router.get('/', wrap((req, res) => {
    const from = req.query.from ? v.date(req.query.from, { field: 'from' }) : null;
    const to = req.query.to ? v.date(req.query.to, { field: 'to' }) : null;
    res.json(days.list(req.user.id, from, to));
  }));

  /**
   * Расписание за период — для сетки недели и месяца.
   *
   * Стоит до `/:date`, иначе «range» было бы разобрано как дата и ушло
   * в проверку формата. Порядок маршрутов здесь — часть работы, а не вкус.
   */
  router.get('/range', wrap((req, res) => {
    const from = v.date(req.query.from, { field: 'from' });
    const to = v.date(req.query.to, { field: 'to' });
    if (to < from) throw badRequest('Конец периода раньше начала');
    res.json(svc.getRange(req.user, from, to));
  }));

  router.get('/:date/full', wrap((req, res) => {
    withEtag(res, svc.getFull(req.user, dateOf(req)));
  }));

  router.put('/:date/full', wrap((req, res) => {
    const own = new Set(
      db.prepare('SELECT id FROM series WHERE user_id = ?').all(req.user.id).map(r => r.id),
    );
    const day = svc.replaceFull(req.user, dateOf(req), cleanBody(req.body || {}, own), req.get('if-match'));
    withEtag(res, day);
  }));

  router.get('/:date', wrap((req, res) => {
    const date = dateOf(req);
    const row = days.get(req.user.id, date);
    res.set('ETag', `"${row?.rev ?? 0}"`);
    res.json({
      date,
      rev: row?.rev ?? 0,
      title: row?.title ?? '',
      focus: row?.focus ?? '',
      weight: row?.weight ?? null,
      notes: row?.notes ?? '',
      updatedAt: row?.updated_at ?? null,
    });
  }));

  router.patch('/:date', wrap((req, res) => {
    const day = svc.patchDay(req.user, dateOf(req), req.body || {}, req.get('if-match'));
    withEtag(res, day);
  }));

  router.delete('/:date', wrap((req, res) => {
    days.remove(req.user.id, dateOf(req));
    res.status(204).end();
  }));

  router.post('/:date/copy-to', wrap((req, res) => {
    const target = v.date(req.body.targetDate, { field: 'targetDate' });
    const sections = Array.isArray(req.body.sections) && req.body.sections.length
      ? req.body.sections.filter(s => DAY_SECTIONS.includes(s))
      : DAY_SECTIONS;
    res.json(svc.copyTo(req.user, dateOf(req), target, sections));
  }));

  router.use('/:date/schedule', entities.schedule);
  router.use('/:date/tasks', entities.tasks);
  router.use('/:date/meals', entities.meals);
  router.use('/:date/sport', entities.sport);

  return router;
};
