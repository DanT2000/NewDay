const { entityRouter, pick } = require('./_entityRouter');
const { wrap } = require('../../lib/errors');
const v = require('../../lib/validate');

const { scheduleRepo } = require('../../repos/schedule');
const { tasksRepo } = require('../../repos/tasks');
const { mealsRepo } = require('../../repos/meals');
const { sportRepo } = require('../../repos/sport');

const KINDS = ['normal', 'work', 'meal', 'sport', 'rest'];
const ALARM_MODES = ['none', 'notify', 'alarm'];
const ALARM_PROFILES = ['wakeup', 'gentle'];
const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack', 'other'];
const BUCKETS = ['work', 'home'];

/** Неделя в минутах: «за неделю» — самый дальний срок, который есть в макете. */
const REMIND_MAX = 7 * 24 * 60;

/**
 * Сроки предупреждения списком. Отсортированы по убыванию — первым идёт
 * самый ранний: именно его видит всё, что умеет только одно число.
 */
function normalizeLeads(raw) {
  if (raw === null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const nums = arr
    .map(x => v.int(x, { min: 0, max: REMIND_MAX, field: 'напомнить за' }))
    .filter(x => x !== null && x !== undefined);
  return [...new Set(nums)].sort((a, b) => b - a).slice(0, 6);
}

/** Время можно прислать числом (startMin/endMin) или строкой time: «9:30-13». */
function sanitizeSchedule(body, { partial }) {
  const out = pick(body, {
    title:           x => v.str(x, { max: 200, field: 'название' }),
    note:            x => v.str(x, { max: 1000, field: 'заметка' }),
    done:            x => v.bool(x),
    kind:            x => v.oneOf(x, KINDS, { field: 'тип', fallback: 'normal' }),
    alarmMode:       x => v.oneOf(x, ALARM_MODES, { field: 'будильник', fallback: 'none' }),
    alarmProfile:    x => v.oneOf(x, ALARM_PROFILES, { field: 'профиль', fallback: 'gentle' }),
    remindBeforeMin: x => v.int(x, { min: 0, max: REMIND_MAX, field: 'напомнить за', nullable: true }),
    sortOrder:       x => v.int(x, { min: 0, max: 100000, field: 'порядок', nullable: true }),
  }, partial);

  /*
   * Сроков предупреждения может быть несколько: «за день» и «за час» вместе —
   * обычная просьба. Первый (самый ранний) дублируется в remindBeforeMin,
   * чтобы всё, что знает только про одно число, продолжало работать.
   */
  if (body.remindBefore !== undefined) {
    const list = normalizeLeads(body.remindBefore);
    // в базе это строка: колонка одна, а разбирают её и клиент, и планировщик
    out.remindBefore = list.length ? JSON.stringify(list) : null;
    out.remindBeforeMin = list.length ? list[0] : null;
  }

  // Строку time разбирает сам репозиторий — так это работает и для PUT /days/:date/full
  if (typeof body.time === 'string' && body.time.trim()) {
    out.time = body.time;
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
  calories:  x => v.int(x, { min: 0, max: 20000, field: 'калории', nullable: true }),
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
