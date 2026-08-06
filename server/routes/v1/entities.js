const { entityRouter, pick } = require('./_entityRouter');
const { wrap } = require('../../lib/errors');
const v = require('../../lib/validate');

const { scheduleRepo } = require('../../repos/schedule');
const { tasksRepo } = require('../../repos/tasks');
const { mealsRepo } = require('../../repos/meals');
const { sportRepo } = require('../../repos/sport');

/*
 * `reminder` — момент, а не отрезок: «забрать документы в 15:00». В расписании
 * он занимает не блок, а точку, и в месяце красится иначе, чтобы отличался от
 * блока времени. Отдельной сущностью его не делаем: дата, время, повтор и
 * предупреждения у него ровно те же, что у строки, — вторая таблица завела бы
 * второй набор тех же правил.
 */
const KINDS = ['normal', 'work', 'meal', 'sport', 'rest', 'reminder'];

/** Цвета — те же четыре акцента, что и у приложения; пусто значит «цвет приложения». */
const COLORS = ['violet', 'orange', 'green', 'red'];
const ALARM_MODES = ['none', 'notify', 'alarm'];
const ALARM_PROFILES = ['wakeup', 'gentle'];
const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack', 'other'];
const BUCKETS = ['work', 'home'];

/** Неделя в минутах: «за неделю» — самый дальний срок, который есть в макете. */
const REMIND_MAX = 7 * 24 * 60;

/**
 * «К концу окна» — не число минут, а отметка.
 *
 * У окна «обед с 12:00 до 14:00» напомнить к концу значит в 14:00, и в минутах
 * «до начала» это минус ширина окна. Хранить такое число нельзя: стоит поменять
 * окно, и напоминание уедет. Поэтому храним отметку, а момент считает
 * планировщик — по концу окна, каким он на тот момент будет.
 */
const AT_END = -1;

/**
 * Сроки предупреждения списком. Отсортированы по убыванию — первым идёт
 * самый ранний: именно его видит всё, что умеет только одно число.
 */
function normalizeLeads(raw, { allowEnd = false } = {}) {
  if (raw === null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const nums = arr
    .map(x => (allowEnd && Number(x) === AT_END
      ? AT_END
      : v.int(x, { min: 0, max: REMIND_MAX, field: 'напомнить за' })))
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
    // пусто — «цвет приложения», и это законное значение, а не пропуск поля
    color:           x => (x === undefined || x === null || x === '' ? null : v.oneOf(x, COLORS, { field: 'цвет' })),
  }, partial);

  /*
   * Сроков предупреждения может быть несколько: «за день» и «за час» вместе —
   * обычная просьба. Первый (самый ранний) дублируется в remindBeforeMin,
   * чтобы всё, что знает только про одно число, продолжало работать.
   *
   * «К концу» (−1) принимает и строка расписания: приём пищи окном ставит в
   * расписание блок с теми же сроками, и раньше «к концу окна» вместе с
   * «Добавить в расписание» упиралось в проверку — приём пищи записывался, а
   * блок к нему нет.
   */
  if (body.remindBefore !== undefined) {
    const list = normalizeLeads(body.remindBefore, { allowEnd: true });
    // в базе это строка: колонка одна, а разбирают её и клиент, и планировщик
    out.remindBefore = list.length ? JSON.stringify(list) : null;
    /*
     * В одиночное число попадает только настоящий срок. «К концу» — отметка, а
     * не минуты, и старый клиент прочитал бы −1 как «через минуту после
     * начала»: уведомление пришло бы не тогда, когда просили.
     */
    const plain = list.filter(x => x >= 0);
    out.remindBeforeMin = plain.length ? plain[0] : null;
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

/*
 * Режим времени у приёма пищи не хранится отдельным полем — он однозначно
 * читается из пары времён: пусто и пусто — пункт плана без времени, оба
 * заполнены — окно («обед с 12:00 до 14:00»), только начало — точное время.
 * Отдельный признак режима был бы вторым источником правды и однажды разошёлся
 * бы с самими временами.
 */
function sanitizeMeal(body, { partial }) {
  const out = pick(body, {
    slot:            x => v.oneOf(x, SLOTS, { field: 'приём пищи', fallback: 'other' }),
    timeMin:         x => v.int(x, { min: 0, max: 1439, field: 'время', nullable: true }),
    endMin:          x => v.int(x, { min: 0, max: 1439, field: 'конец окна', nullable: true }),
    calories:        x => v.int(x, { min: 0, max: 20000, field: 'калории', nullable: true }),
    title:           x => v.str(x, { max: 200, field: 'название' }),
    note:            x => v.str(x, { max: 1000, field: 'заметка' }),
    done:            x => v.bool(x),
    sortOrder:       x => v.int(x, { min: 0, max: 100000, field: 'порядок', nullable: true }),
    scheduleItemId:  x => v.int(x, { min: 1, field: 'блок расписания', nullable: true }),
  }, partial);

  if (body.remindBefore !== undefined) {
    // у приёма пищи есть окно, поэтому ему разрешена отметка «к концу окна»
    const list = normalizeLeads(body.remindBefore, { allowEnd: true });
    out.remindBefore = list.length ? JSON.stringify(list) : null;
  }
  return out;
}

const sanitizeSport = (body, { partial }) => pick(body, {
  exercise:  x => v.str(x, { max: 200, field: 'упражнение' }),
  sets:      x => v.int(x, { min: 0, max: 999, field: 'подходы', nullable: true }),
  reps:      x => v.int(x, { min: 0, max: 999, field: 'повторы', nullable: true }),
  weight:    x => v.num(x, { min: 0, max: 999, field: 'вес', nullable: true }),
  done:      x => v.bool(x),
  sortOrder: x => v.int(x, { min: 0, max: 100000, field: 'порядок', nullable: true }),
}, partial);

/** Дополнительные эндпоинты расписания: сдвиг времени и привязка к повтору. */
function scheduleExtra(router, repo, { dateOf, idOf }) {
  router.post('/shift', wrap((req, res) => {
    const fromId = v.int(req.body.fromId, { min: 1, field: 'fromId' });
    const minutes = v.int(req.body.minutes, { min: -1439, max: 1439, field: 'minutes' });
    const cascade = req.body.cascade === undefined ? true : Boolean(req.body.cascade);
    res.json(repo.shift(req.user.id, dateOf(req), fromId, minutes, cascade));
  }));

  /*
   * Привязка строки к повтору отдельным путём, а не полем в PATCH: id правила
   * приходит от клиента, и его нужно сверить с владельцем. Обычная правка
   * строки проверок владельца правила не делает и делать не должна.
   */
  router.post('/:id/series', wrap((req, res) => {
    const raw = req.body.seriesId;
    const seriesId = raw === null || raw === undefined || raw === ''
      ? null
      : v.int(raw, { min: 1, field: 'повтор' });
    res.json(repo.setSeries(req.user.id, idOf(req), seriesId));
  }));
}

const routers = db => ({
  schedule: entityRouter({ db, repoFor: scheduleRepo, sanitize: sanitizeSchedule, extra: scheduleExtra }),
  tasks:    entityRouter({ db, repoFor: tasksRepo,    sanitize: sanitizeTask }),
  meals:    entityRouter({ db, repoFor: mealsRepo,    sanitize: sanitizeMeal }),
  sport:    entityRouter({ db, repoFor: sportRepo,    sanitize: sanitizeSport }),
});

module.exports = { entityRouters: routers, sanitizeSchedule, sanitizeTask, sanitizeMeal, sanitizeSport };
