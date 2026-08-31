/**
 * Применение батча от внешней интеграции: /integrations/apply.
 *
 * Идентичность записи — пара source + externalId (у строк дня ещё и дата).
 * По ней один и тот же запрос можно слать сколько угодно раз: дублей не
 * будет, изменится только то, что реально отличается.
 *
 * Три железных правила:
 *  - запись, которую правил человек (last_modified_by = 'user') или другая
 *    интеграция, не трогается — в ответ уходит conflict с причиной и текущим
 *    состоянием;
 *  - запись, удалённую человеком, не воскрешаем — надгробие держит
 *    conflict / removed_by_user, пока его явно не снимут;
 *  - data — это PATCH: применяются только переданные поля. Интеграция, не
 *    приславшая color, не сотрёт его.
 *
 * Поля данных проходят те же санитайзеры, что и обычные пути API, — у
 * интеграций нет ни одного поля «в обход».
 */

const { badRequest } = require('../lib/errors');
const { parseTimeRange, todayFor } = require('../lib/dates');
const { scheduleRepo } = require('../repos/schedule');
const { tasksRepo } = require('../repos/tasks');
const { mealsRepo } = require('../repos/meals');
const { sportRepo } = require('../repos/sport');
const { habitsRepo } = require('../repos/habits');
const { seriesRepo } = require('../repos/series');
const { tombstonesRepo } = require('../repos/tombstones');
const { sanitizeSchedule, sanitizeTask, sanitizeMeal, sanitizeSport } = require('../routes/v1/entities');
const { sanitizeHabit } = require('../routes/v1/habits');
const { sanitizeSeries } = require('../routes/v1/series');

const SOURCE_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const MAX_ITEMS = 100;

/** camelCase → имя колонки; исключение одно: список сроков лежит в *_json. */
const COL_OVERRIDES = { remindBefore: 'remind_before_json' };
const colOf = key => COL_OVERRIDES[key] ?? key.replace(/[A-Z]/g, c => '_' + c.toLowerCase());

/** Совпадает ли значение поля с тем, что уже в строке. */
function sameValue(next, current) {
  let a = next === undefined ? null : next;
  if (typeof a === 'boolean') a = a ? 1 : 0;
  const b = current === undefined ? null : current;
  if (a === null || b === null) return a === null && b === null;
  return String(a) === String(b);
}

/** Тело не меняет ни одного переданного поля? Тогда исход — unchanged. */
const isUnchanged = (sanitized, row) =>
  Object.keys(sanitized).every(k => sameValue(sanitized[k], row[colOf(k)]));

function integrationService(db) {
  const tombs = tombstonesRepo(db);
  const repos = {
    schedule: scheduleRepo(db),
    task: tasksRepo(db),
    meal: mealsRepo(db),
    sport: sportRepo(db),
  };
  const habits = habitsRepo(db);
  const series = seriesRepo(db);

  const DAY_TABLES = { schedule: 'schedule_items', task: 'tasks', meal: 'meals', sport: 'sport_sets' };
  const DAY_SANITIZE = { schedule: sanitizeSchedule, task: sanitizeTask, meal: sanitizeMeal, sport: sanitizeSport };
  const ENTITIES = new Set([...Object.keys(DAY_TABLES), 'habit', 'series']);

  const findDayRow = (userId, entity, date, source, externalId) =>
    db.prepare(`
      SELECT * FROM ${DAY_TABLES[entity]}
       WHERE user_id = ? AND date = ? AND source = ? AND external_id = ?
    `).get(userId, date, source, externalId);

  const findByExt = (table, userId, source, externalId) =>
    db.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND source = ? AND external_id = ?`)
      .get(userId, source, externalId);

  /** Строка расписания со временем строкой сравнима только в минутах. */
  function normalizeScheduleTime(sanitized) {
    if (typeof sanitized.time !== 'string' || !sanitized.time.trim()) return sanitized;
    const parsed = parseTimeRange(sanitized.time);
    if (!parsed) throw badRequest('Не удалось разобрать время. Примеры: 9:30, 930, 9:30-13:00');
    const { time, ...rest } = sanitized;
    return { ...rest, startMin: parsed.startMin, endMin: parsed.endMin };
  }

  function validate(body) {
    const source = String(body.source ?? '');
    if (!SOURCE_RE.test(source)) {
      throw badRequest('Поле «source» обязательно: до 64 символов, только буквы, цифры, точка, дефис и подчёркивание');
    }
    const items = body.items;
    if (!Array.isArray(items) || !items.length) throw badRequest('Нужен непустой массив items');
    if (items.length > MAX_ITEMS) throw badRequest(`Слишком много элементов: максимум ${MAX_ITEMS} за запрос`);
    return { source, items, dryRun: Boolean(body.dryRun) };
  }

  function itemKey(item, i) {
    const entity = String(item?.entity ?? '');
    if (!ENTITIES.has(entity)) {
      throw badRequest(`items[${i}]: неизвестная сущность «${entity}». Допустимо: schedule, task, meal, sport, habit, series`);
    }
    const externalId = String(item?.externalId ?? '').trim();
    if (!externalId || externalId.length > 128) {
      throw badRequest(`items[${i}]: externalId обязателен, до 128 символов`);
    }
    let date = null;
    if (DAY_TABLES[entity]) {
      date = String(item?.date ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest(`items[${i}]: строке дня обязательна дата YYYY-MM-DD`);
    }
    if (!item.delete && (item.data === undefined || item.data === null || typeof item.data !== 'object')) {
      throw badRequest(`items[${i}]: нужен объект data (или delete: true)`);
    }
    return { entity, externalId, date };
  }

  /**
   * Один элемент батча → { status, reason?, id?, current? }.
   * write=false (dryRun) считает исход, не трогая базу.
   */
  function applyItem(user, source, item, key, write) {
    const { entity, externalId, date } = key;
    const userId = user.id;

    const row = DAY_TABLES[entity]
      ? findDayRow(userId, entity, date, source, externalId)
      : findByExt(entity === 'habit' ? 'habits' : 'series', userId, source, externalId);

    // ── Удаление ──
    if (item.delete) {
      if (!row) return { status: 'unchanged' };
      if (row.last_modified_by !== source) {
        return { status: 'conflict', reason: 'modified_by_user', current: row };
      }
      if (write) {
        if (DAY_TABLES[entity]) repos[entity].remove(userId, row.id, { fromIntegration: true });
        else if (entity === 'habit') habits.archive(userId, row.id, { fromIntegration: true });
        else series.remove(userId, row.id, { today: todayFor(user.timezone), fromIntegration: true });
      }
      return { status: 'deleted', id: row.id };
    }

    // ── Создание или обновление ──
    const tombDate = DAY_TABLES[entity] ? date : '';
    if (!row && tombs.has(userId, entity, tombDate, source, externalId)) {
      // человек удалил такую запись — воскрешать её без явного снятия надгробия нельзя
      return { status: 'conflict', reason: 'removed_by_user' };
    }
    if (row && row.last_modified_by !== source) {
      return { status: 'conflict', reason: 'modified_by_user', current: row };
    }

    const partial = Boolean(row);
    let sanitized;
    if (DAY_TABLES[entity]) {
      sanitized = DAY_SANITIZE[entity](item.data, { partial });
      if (entity === 'schedule') sanitized = normalizeScheduleTime(sanitized);
    } else if (entity === 'habit') {
      sanitized = sanitizeHabit(item.data, { partial });
      if (!partial && sanitized.mode === 'challenge' && !sanitized.challengeStartDate) {
        sanitized.challengeStartDate = todayFor(user.timezone);
      }
    } else {
      sanitized = sanitizeSeries(item.data, { partial });
      if (!partial && !sanitized.payloadJson) throw badRequest('series: нужно передать rows');
      if (!partial && !sanitized.name && !sanitized.startDate) {
        throw badRequest('series: повтору обязательна дата начала (startDate), шаблону — имя (name)');
      }
    }
    // идентичность неизменяема: сменить source или externalId нельзя никаким полем
    delete sanitized.source;
    delete sanitized.externalId;

    if (!row) {
      if (!write) return { status: 'created' };
      const stamp = { source, externalId, lastModifiedBy: source };
      const created = DAY_TABLES[entity]
        ? repos[entity].create(userId, date, { ...sanitized, ...stamp })
        : entity === 'habit'
          ? habits.create(userId, { ...sanitized, ...stamp })
          : series.create(userId, { ...sanitized, ...stamp });
      return { status: 'created', id: created.id };
    }

    // привычка, которую интеграция сама архивировала delete-ом, возвращается из архива
    const needsRestore = entity === 'habit' && row.archived_at;
    if (!needsRestore && isUnchanged(sanitized, row)) return { status: 'unchanged', id: row.id };

    if (write) {
      if (needsRestore) habits.restore(userId, row.id);
      if (DAY_TABLES[entity]) repos[entity].update(userId, row.id, { ...sanitized, lastModifiedBy: source });
      else if (entity === 'habit') habits.update(userId, row.id, { ...sanitized, lastModifiedBy: source });
      else series.update(userId, row.id, { ...sanitized, lastModifiedBy: source });
    }
    return { status: 'updated', id: row.id };
  }

  /** Весь батч. Возвращает результаты, счётчики и признак «уведомления пересчитать». */
  function apply(user, body) {
    const { source, items, dryRun } = validate(body);
    const keys = items.map((item, i) => itemKey(item, i));

    const results = [];
    const counts = { created: 0, updated: 0, unchanged: 0, deleted: 0, conflict: 0 };
    let touchedNotify = false;

    const run = () => {
      items.forEach((item, i) => {
        const key = keys[i];
        const r = applyItem(user, source, item, key, !dryRun);
        counts[r.status] += 1;
        if (!dryRun && ['created', 'updated', 'deleted'].includes(r.status)
          && ['schedule', 'meal', 'series'].includes(key.entity)) {
          touchedNotify = true;
        }
        results.push({
          entity: key.entity, externalId: key.externalId,
          ...(key.date ? { date: key.date } : {}),
          ...r,
        });
      });
    };
    // батч атомарен: ошибка валидации в середине откатывает всё, а не половину
    if (dryRun) run(); else db.transaction(run)();

    return { dryRun, results, counts, touchedNotify };
  }

  /** Явное снятие надгробия: человек передумал, запись можно вернуть. */
  function clearTombstone(userId, body) {
    const entity = String(body.entity ?? '');
    if (!ENTITIES.has(entity)) throw badRequest('Неизвестная сущность');
    const source = String(body.source ?? '');
    if (!SOURCE_RE.test(source)) throw badRequest('Не похоже на source');
    const externalId = String(body.externalId ?? '').trim();
    if (!externalId) throw badRequest('externalId обязателен');
    const date = DAY_TABLES[entity] ? String(body.date ?? '') : '';
    return tombs.clear(userId, entity, date, source, externalId);
  }

  return { apply, clearTombstone };
}

module.exports = { integrationService };
