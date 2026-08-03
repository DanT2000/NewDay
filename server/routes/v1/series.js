const express = require('express');
const { wrap, badRequest } = require('../../lib/errors');
const v = require('../../lib/validate');
const { seriesRepo } = require('../../repos/series');
const { seriesService } = require('../../services/seriesService');
const { parseTimeRange } = require('../../lib/dates');

const TARGETS = ['schedule'];          // задачи и питание получат повторы на следующем этапе
const FREQS = ['daily', 'weekly', 'monthly'];

/** Одна строка шаблона: те же поля, что у строки расписания. */
function normalizeRow(row) {
  const out = {
    title: v.str(row.title, { max: 200, field: 'название' }),
    note: v.str(row.note, { max: 1000, field: 'заметка' }),
    kind: v.oneOf(row.kind, ['normal', 'work', 'meal', 'sport', 'rest'], { field: 'тип', fallback: 'normal' }),
    alarmMode: v.oneOf(row.alarmMode, ['none', 'notify', 'alarm'], { field: 'будильник', fallback: 'none' }),
    alarmProfile: v.oneOf(row.alarmProfile, ['wakeup', 'gentle'], { field: 'профиль', fallback: 'gentle' }),
    remindBeforeMin: v.int(row.remindBeforeMin, { min: 0, max: 1440, field: 'напомнить за', nullable: true }),
  };
  if (typeof row.time === 'string' && row.time.trim()) {
    const parsed = parseTimeRange(row.time);
    if (!parsed) throw badRequest('Не удалось разобрать время повтора');
    out.startMin = parsed.startMin;
    out.endMin = parsed.endMin;
  } else {
    out.startMin = v.int(row.startMin ?? 0, { min: 0, max: 1439, field: 'начало' });
    out.endMin = v.int(row.endMin, { min: 0, max: 1439, field: 'конец', nullable: true });
  }
  return out;
}

function sanitize(body, { partial }) {
  const out = {};
  const has = k => body[k] !== undefined;

  if (!partial || has('target')) {
    out.target = v.oneOf(body.target ?? 'schedule', TARGETS, { field: 'target', fallback: 'schedule' });
  }
  if (!partial || has('freq')) {
    out.freq = v.oneOf(body.freq ?? 'daily', FREQS, { field: 'повтор', fallback: 'daily' });
  }
  if (has('interval')) out.interval = v.int(body.interval, { min: 1, max: 52, field: 'интервал' });
  if (has('byweekday')) out.byweekday = v.int(body.byweekday, { min: 1, max: 127, field: 'дни недели' });
  if (has('startDate')) out.startDate = body.startDate ? v.date(body.startDate, { field: 'начало' }) : null;
  if (has('endDate')) out.endDate = body.endDate ? v.date(body.endDate, { field: 'окончание' }) : null;
  if (has('name')) out.name = v.str(body.name, { max: 80, field: 'название' }) || null;

  if (has('rows') || has('payload')) {
    const rows = Array.isArray(body.rows) ? body.rows : [body.payload || {}];
    if (!rows.length) throw badRequest('Нужна хотя бы одна строка');
    if (rows.length > 50) throw badRequest('Слишком много строк в шаблоне');
    const normalized = rows.map(normalizeRow);
    out.payloadJson = JSON.stringify(
      // повтор — это одна строка, шаблон — набор строк
      normalized.length === 1 && !body.forceRows ? normalized[0] : { rows: normalized }
    );
  }
  return out;
}

module.exports = function seriesRouter({ db }) {
  const router = express.Router();
  const repo = seriesRepo(db);
  const svc = seriesService(db);
  const idOf = req => v.int(req.params.id, { min: 1, field: 'id' });

  router.get('/', wrap((req, res) => {
    const templates = req.query.templates === '1' ? true
      : req.query.templates === '0' ? false : null;
    res.json(repo.list(req.user.id, { templates }));
  }));

  router.post('/', wrap((req, res) => {
    const data = sanitize(req.body || {}, { partial: false });
    if (!data.payloadJson) throw badRequest('Нужно передать rows или payload');
    // повтор без даты начала бессмыслен; шаблон, наоборот, дат не имеет
    if (!data.name && !data.startDate) throw badRequest('Укажите дату начала повтора');
    res.status(201).json(repo.create(req.user.id, data));
  }));

  router.patch('/:id', wrap((req, res) => {
    res.json(repo.update(req.user.id, idOf(req), sanitize(req.body || {}, { partial: true })));
  }));

  /** ?from=YYYY-MM-DD — завершить серию с этой даты, не трогая прошлое. */
  router.delete('/:id', wrap((req, res) => {
    if (req.query.from) {
      return res.json(repo.endFrom(req.user.id, idOf(req), v.date(req.query.from, { field: 'from' })));
    }
    repo.remove(req.user.id, idOf(req));
    res.status(204).end();
  }));

  router.post('/:id/apply', wrap((req, res) => {
    const date = v.date(req.body.date, { field: 'дата' });
    const count = svc.applyTemplate(req.user.id, date, idOf(req));
    res.json({ success: true, created: count });
  }));

  return router;
};
