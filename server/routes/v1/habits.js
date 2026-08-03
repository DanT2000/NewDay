const express = require('express');
const { wrap, badRequest } = require('../../lib/errors');
const v = require('../../lib/validate');
const { todayFor } = require('../../lib/dates');
const { habitsRepo } = require('../../repos/habits');
const { statsService } = require('../../services/statsService');

const TYPES = ['binary', 'quant'];
const POLARITIES = ['do', 'avoid'];
const MODES = ['ongoing', 'challenge'];
const BREAK_POLICIES = ['reset', 'keep'];
const STATUSES = ['done', 'missed', 'skipped'];
const COLORS = ['blue', 'green', 'orange', 'red', 'purple', 'teal', 'pink', 'gray'];

/**
 * Пресеты разворачиваются в три независимые оси: цель, поведение при срыве, полярность.
 * Явно переданные поля перекрывают пресет.
 */
const PRESETS = {
  simple:      { mode: 'ongoing',   polarity: 'do',    breakPolicy: 'reset', challengeTargetDays: null },
  challenge30: { mode: 'challenge', polarity: 'do',    breakPolicy: 'reset', challengeTargetDays: 30 },
  marathon300: { mode: 'challenge', polarity: 'do',    breakPolicy: 'keep',  challengeTargetDays: 300 },
  quit:        { mode: 'challenge', polarity: 'avoid', breakPolicy: 'reset', challengeTargetDays: 300 },
};

function sanitize(body, { partial }) {
  const out = {};
  const set = (key, value) => { if (value !== undefined) out[key] = value; };

  if (!partial) {
    const preset = body.preset ?? 'simple';
    if (!PRESETS[preset]) {
      throw badRequest(`Неизвестный пресет. Допустимо: ${Object.keys(PRESETS).join(', ')}`);
    }
    Object.assign(out, PRESETS[preset]);
  }

  const has = key => body[key] !== undefined;

  if (!partial || has('title')) {
    const title = v.str(body.title, { max: 120, field: 'название' });
    if (!title) throw badRequest('Название привычки обязательно');
    out.title = title;
  }
  if (has('description')) set('description', v.str(body.description, { max: 500, field: 'описание' }));
  if (has('emoji')) set('emoji', v.str(body.emoji, { max: 16, field: 'эмодзи' }));
  if (has('color')) set('color', v.oneOf(body.color, COLORS, { field: 'цвет', fallback: 'blue' }));
  if (has('type')) set('type', v.oneOf(body.type, TYPES, { field: 'тип', fallback: 'binary' }));
  if (has('targetPerDay')) set('targetPerDay', v.int(body.targetPerDay, { min: 1, max: 10000, field: 'цель за день', nullable: true }));
  if (has('unit')) set('unit', v.str(body.unit, { max: 20, field: 'единица' }) || null);
  if (has('scheduleMask')) set('scheduleMask', v.int(body.scheduleMask, { min: 1, max: 127, field: 'дни недели' }));
  if (has('polarity')) set('polarity', v.oneOf(body.polarity, POLARITIES, { field: 'полярность' }));
  if (has('mode')) set('mode', v.oneOf(body.mode, MODES, { field: 'режим' }));
  if (has('breakPolicy')) set('breakPolicy', v.oneOf(body.breakPolicy, BREAK_POLICIES, { field: 'при срыве' }));
  if (has('challengeTargetDays')) set('challengeTargetDays', v.int(body.challengeTargetDays, { min: 1, max: 3650, field: 'дней в челлендже', nullable: true }));
  if (has('challengeStartDate')) set('challengeStartDate', body.challengeStartDate ? v.date(body.challengeStartDate, { field: 'старт челленджа' }) : null);
  if (has('allowedSkipsPerWeek')) set('allowedSkipsPerWeek', v.int(body.allowedSkipsPerWeek, { min: 0, max: 7, field: 'заморозок в неделю' }));
  if (has('isActive')) set('isActive', v.bool(body.isActive));
  if (has('sortOrder')) set('sortOrder', v.int(body.sortOrder, { min: 0, max: 100000, field: 'порядок' }));

  return out;
}

module.exports = function habitsRouter({ db }) {
  const router = express.Router();
  const habits = habitsRepo(db);
  const stats = statsService(db);

  const idOf = req => v.int(req.params.id, { min: 1, field: 'id' });

  router.get('/', wrap((req, res) => {
    res.json(habits.list(req.user.id, { includeArchived: req.query.archived === '1' }));
  }));

  router.post('/', wrap((req, res) => {
    const data = sanitize(req.body || {}, { partial: false });
    // Челлендж без явной даты старта начинается сегодня — в таймзоне пользователя.
    if (data.mode === 'challenge' && !data.challengeStartDate) {
      data.challengeStartDate = todayFor(req.user.timezone);
    }
    res.status(201).json(habits.create(req.user.id, data));
  }));

  router.post('/reorder', wrap((req, res) => {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : [])
      .map(id => v.int(id, { min: 1, field: 'id' }));
    res.json(habits.reorder(req.user.id, ids));
  }));

  router.get('/:id/logs', wrap((req, res) => {
    const from = req.query.from ? v.date(req.query.from, { field: 'from' }) : null;
    const to = req.query.to ? v.date(req.query.to, { field: 'to' }) : null;
    habits.get(req.user.id, idOf(req));
    res.json(habits.logsInRange(req.user.id, idOf(req), from, to));
  }));

  router.get('/:id/stats', wrap((req, res) => {
    const from = req.query.from ? v.date(req.query.from, { field: 'from' }) : null;
    const to = req.query.to ? v.date(req.query.to, { field: 'to' }) : null;
    res.json(stats.habitStats(req.user, idOf(req), from, to));
  }));

  router.put('/:id/log/:date', wrap((req, res) => {
    const date = v.date(req.params.date, { field: 'дата' });
    const status = v.oneOf(req.body.status, STATUSES, { field: 'статус' });
    const value = v.int(req.body.value, { min: 0, max: 100000, field: 'значение', nullable: true });
    res.json(habits.setLog(req.user.id, idOf(req), date, { status, value }));
  }));

  router.delete('/:id/log/:date', wrap((req, res) => {
    habits.clearLog(req.user.id, idOf(req), v.date(req.params.date, { field: 'дата' }));
    res.status(204).end();
  }));

  router.post('/:id/restore', wrap((req, res) => {
    res.json(habits.restore(req.user.id, idOf(req)));
  }));

  router.patch('/:id', wrap((req, res) => {
    res.json(habits.update(req.user.id, idOf(req), sanitize(req.body || {}, { partial: true })));
  }));

  // По умолчанию — в архив: логи и статистика прошлого сохраняются.
  router.delete('/:id', wrap((req, res) => {
    if (req.query.hard === '1') {
      habits.remove(req.user.id, idOf(req));
      return res.status(204).end();
    }
    res.json(habits.archive(req.user.id, idOf(req)));
  }));

  return router;
};

module.exports.HABIT_PRESETS = PRESETS;
