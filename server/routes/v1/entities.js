const { entityRouter, pick } = require('./_entityRouter');
const { wrap, badRequest } = require('../../lib/errors');
const v = require('../../lib/validate');
const { parseTimeRange } = require('../../lib/dates');
const { scheduleRepo } = require('../../repos/schedule');
const { tasksRepo } = require('../../repos/tasks');
const { mealsRepo } = require('../../repos/meals');
const { sportRepo } = require('../../repos/sport');

const KINDS = ['normal', 'work', 'meal', 'sport', 'rest'];
const ALARM_MODES = ['none', 'notify', 'alarm'];
const ALARM_PROFILES = ['wakeup', 'gentle'];
const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack', 'other'];
const BUCKETS = ['work', 'home'];

/** Время можно прислать числом (startMin/endMin) или строкой time: «9:30-13». */
function sanitizeSchedule(body, { partial }) {
  const out = pick(body, {
    title:           x => v.str(x, { max: 200, field: 'название' }),
    note:            x => v.str(x, { max: 1000, field: 'заметка' }),
    done:            x => v.bool(x),
    kind:            x => v.oneOf(x, KINDS, { field: 'тип', fallback: 'normal' }),
    alarmMode:       x => v.oneOf(x, ALARM_MODES, { field: 'будильник', fallback: 'none' }),
    alarmProfile:    x => v.oneOf(x, ALARM_PROFILES, { field: 'профиль', fallback: 'gentle' }),
    remindBeforeMin: x => v.int(x, { min: 0, max: 1440, field: 'напомнить за', nullable: true }),
    sortOrder:       x => v.int(x, { min: 0, max: 100000, field: 'порядок', nullable: true }),
  }, partial);

  if (typeof body.time === 'string' && body.time.trim()) {
    const parsed = parseTimeRange(body.time);
    if (!parsed) throw badRequest('Не удалось разобрать время. Примеры: 9:30, 930, 9:30-13:00');
    out.startMin = parsed.startMin;
    out.endMin = parsed.endMin;
  } else {
    if (!partial || body.startMin !== undefined) {
      out.startMin = v.int(body.startMin ?? 0, { min: 0, max: 1439, field: 'начало' });
    }
    if (!partial || body.endMin !== undefined) {
      out.endMin = v.int(body.endMin, { min: 0, max: 1439, field: 'конец', nullable: true });
    }
  }
  return out;
}

const sanitizeTask = (body, { partial }) => pick(body, {
  bucket:      x => v.oneOf(x, BUCKETS, { field: 'раздел', fallback: 'work' }),
  text:        x => v.str(x, { max: 500, field: 'текст' }),
  done:        x => v.bool(x),
  carriedFrom: x => (x === undefined || x === null || x === '' ? null : v.date(x, { field: 'перенесено с' })),
  sortOrder:   x => v.int(x, { min: 0, max: 100000, field: 'порядок', nullable: true }),
}, partial);

const sanitizeMeal = (body, { partial }) => pick(body, {
  slot:      x => v.oneOf(x, SLOTS, { field: 'приём пищи', fallback: 'other' }),
  timeMin:   x => v.int(x, { min: 0, max: 1439, field: 'время', nullable: true }),
  title:     x => v.str(x, { max: 200, field: 'название' }),
  note:      x => v.str(x, { max: 1000, field: 'заметка' }),
  done:      x => v.bool(x),
  sortOrder: x => v.int(x, { min: 0, max: 100000, field: 'порядок', nullable: true }),
}, partial);

const sanitizeSport = (body, { partial }) => pick(body, {
  exercise:  x => v.str(x, { max: 200, field: 'упражнение' }),
  sets:      x => v.int(x, { min: 0, max: 999, field: 'подходы', nullable: true }),
  reps:      x => v.int(x, { min: 0, max: 999, field: 'повторы', nullable: true }),
  weight:    x => v.num(x, { min: 0, max: 999, field: 'вес', nullable: true }),
  done:      x => v.bool(x),
  sortOrder: x => v.int(x, { min: 0, max: 100000, field: 'порядок', nullable: true }),
}, partial);

/** Дополнительный эндпоинт расписания: сдвиг времени. */
function scheduleExtra(router, repo, { dateOf }) {
  router.post('/shift', wrap((req, res) => {
    const fromId = v.int(req.body.fromId, { min: 1, field: 'fromId' });
    const minutes = v.int(req.body.minutes, { min: -1439, max: 1439, field: 'minutes' });
    const cascade = req.body.cascade === undefined ? true : Boolean(req.body.cascade);
    res.json(repo.shift(req.user.id, dateOf(req), fromId, minutes, cascade));
  }));
}

const routers = db => ({
  schedule: entityRouter({ db, repoFor: scheduleRepo, sanitize: sanitizeSchedule, extra: scheduleExtra }),
  tasks:    entityRouter({ db, repoFor: tasksRepo,    sanitize: sanitizeTask }),
  meals:    entityRouter({ db, repoFor: mealsRepo,    sanitize: sanitizeMeal }),
  sport:    entityRouter({ db, repoFor: sportRepo,    sanitize: sanitizeSport }),
});

module.exports = { entityRouters: routers, sanitizeSchedule, sanitizeTask, sanitizeMeal, sanitizeSport };
