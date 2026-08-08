const { ApiError, notFound } = require('../lib/errors');
/*
 * Сдвиг и разность дат берём из lib/dates, а не считаем здесь своей копией.
 *
 * Копия жила прямо в этом файле и собирала результат через toISOString():
 * на 9999-12-31 + 1 день это давало «+010000-01» вместо даты, следующий же
 * разбор такой строки заканчивался «внутренней ошибкой», и запрос периода
 * у края календаря отвечал пятисоткой.
 */
const { todayFor, addDays, diffDays } = require('../lib/dates');
const { daysRepo, bumpRev } = require('../repos/days');
const { scheduleRepo } = require('../repos/schedule');
const { tasksRepo } = require('../repos/tasks');
const { mealsRepo } = require('../repos/meals');
const { sportRepo } = require('../repos/sport');
const { statsService } = require('./statsService');
const { seriesService } = require('./seriesService');

const SECTIONS = ['schedule', 'tasks', 'meals', 'sport'];

function dayService(db, opts = {}) {
  const days = daysRepo(db);
  const schedule = scheduleRepo(db);
  const tasks = tasksRepo(db);
  const meals = mealsRepo(db);
  const sport = sportRepo(db);
  const stats = statsService(db, opts);
  const series = seriesService(db);

  /**
   * Читает день. Если записи нет — отдаёт валидный пустой день с rev: 0
   * и НЕ создаёт его в базе. Именно поэтому клиенту больше не нужен
   * «пустой фолбэк», из-за которого раньше день затирался при обрыве связи.
   */
  function getFull(user, date) {
    // Повторы достраиваются при открытии дня: человек, открывший завтра,
    // ожидает увидеть своё расписание, а не пустоту.
    series.materializeDay(user.id, date, { today: todayFor(user.timezone) });
    const day = days.get(user.id, date);
    const allTasks = tasks.list(user.id, date);
    return {
      date,
      rev: day?.rev ?? 0,
      title: day?.title ?? '',
      focus: day?.focus ?? '',
      weight: day?.weight ?? null,
      notes: day?.notes ?? '',
      foodPlan: day?.food_plan ?? '',
      schedule: schedule.list(user.id, date),
      tasks: {
        work: allTasks.filter(t => t.bucket === 'work'),
        home: allTasks.filter(t => t.bucket === 'home'),
      },
      meals: meals.list(user.id, date),
      sport: sport.list(user.id, date),
      habits: stats.habitsForDate(user, date),
      progress: stats.dayProgress(user, date),
    };
  }

  /**
   * Несколько дней сразу — для сетки недели и месяца.
   *
   * Отдаём только то, что рисует сетка: расписание и счётчики. Тянуть
   * тридцать полных дней с задачами, едой, привычками и прогрессом ради
   * тридцати клеток месяца — это тридцать лишних расчётов статистики.
   *
   * Повторы достраиваются по каждому дню, как и при открытии одного дня:
   * иначе в сетке зияли бы пустые дни, у которых расписание есть.
   */
  function getRange(user, from, to, { limit = 62 } = {}) {
    const today = todayFor(user.timezone);
    const days = [];
    /*
     * Сколько дней считаем, решаем разностью дат, а не сравнением строк на
     * каждом шаге. Строковое `cur <= to` доверяло виду даты: стоило шагу
     * выйти за 9999 год, и «10000-01-01» оказывалось меньше конца периода —
     * цикл продолжался и наливал в ответ дни, которых в календаре нет.
     */
    const total = Math.min(limit, diffDays(from, to) + 1);
    let cur = from;
    for (let i = 0; i < total; i++) {
      series.materializeDay(user.id, cur, { today });
      const rows = schedule.list(user.id, cur);
      days.push({
        date: cur,
        schedule: rows,
        counts: {
          schedule: rows.length,
          done: rows.filter(r => r.done === 1).length,
        },
      });
      if (i + 1 < total) cur = addDays(cur, 1);
    }
    /*
     * `to` в ответе — конец того, что действительно посчитано, а не то, что
     * попросили. Раньше при периоде длиннее предела возвращались первые 62 дня,
     * но подтверждался запрошенный конец: снаружи это выглядело как «в ноябре
     * ничего не запланировано», хотя данные просто не доехали.
     */
    const last = days.length ? days[days.length - 1].date : to;
    return { from, to: last, requestedTo: to, truncated: last < to, days };
  }

  function checkIfMatch(ifMatch, user, date) {
    const day = days.get(user.id, date);
    const currentRev = day?.rev ?? 0;
    if (ifMatch === undefined || ifMatch === null || ifMatch === '') {
      throw new ApiError(428, 'IF_MATCH_REQUIRED',
        'Требуется заголовок If-Match с текущей версией дня');
    }
    const want = Number(String(ifMatch).replace(/^W\//, '').replace(/"/g, '').trim());
    if (!Number.isInteger(want) || want !== currentRev) {
      throw new ApiError(409, 'REV_MISMATCH', 'День изменён в другом месте',
        { current: getFull(user, date) });
    }
    return currentRev;
  }

  /** Полная замена дня. Единственная операция, переписывающая день целиком. */
  function replaceFull(user, date, body, ifMatch) {
    checkIfMatch(ifMatch, user, date);

    const tx = db.transaction(() => {
      days.ensure(user.id, date);
      for (const repo of [schedule, tasks, meals, sport]) {
        repo.removeAllForDate(user.id, date);
      }
      days.patch(user.id, date, {
        title: String(body.title ?? ''),
        focus: String(body.focus ?? ''),
        weight: body.weight === undefined || body.weight === null ? null : Number(body.weight),
        notes: String(body.notes ?? ''),
        foodPlan: String(body.foodPlan ?? ''),
      });

      /*
       * Строки пересоздаются, а значит получают новые номера. Прежние номера
       * запоминаем: по ним приём пищи находит свой блок. Без этого связь
       * рвалась при каждой полной записи дня, и в расписании оставался блок,
       * которому больше нечего означать.
       */
      const newIdOf = new Map();
      (body.schedule || []).forEach((row, i) => {
        const { wasId, ...rest } = row;
        const created = schedule.create(user.id, date, { ...rest, sortOrder: i });
        if (wasId) newIdOf.set(wasId, created.id);
      });

      const work = body.tasks?.work || [];
      const home = body.tasks?.home || [];
      work.forEach((row, i) => tasks.create(user.id, date, { ...row, bucket: 'work', sortOrder: i }));
      home.forEach((row, i) => tasks.create(user.id, date, { ...row, bucket: 'home', sortOrder: i }));

      (body.meals || []).forEach((row, i) => {
        const { wasScheduleItemId, wasId, ...rest } = row;
        meals.create(user.id, date, {
          ...rest, sortOrder: i,
          ...(wasScheduleItemId ? { scheduleItemId: newIdOf.get(wasScheduleItemId) ?? null } : {}),
        });
      });
      (body.sport || []).forEach((row, i) => {
        const { wasId, ...rest } = row;
        sport.create(user.id, date, { ...rest, sortOrder: i });
      });
    });
    tx();

    return getFull(user, date);
  }

  /** Правит только поля самого дня, вложенные сущности не трогает. */
  function patchDay(user, date, body, ifMatch, { requireIfMatch = true } = {}) {
    if (requireIfMatch) checkIfMatch(ifMatch, user, date);
    const fields = {};
    if (body.title !== undefined) fields.title = String(body.title);
    if (body.focus !== undefined) fields.focus = String(body.focus);
    if (body.notes !== undefined) fields.notes = String(body.notes);
    if (body.foodPlan !== undefined) fields.foodPlan = String(body.foodPlan).slice(0, 500);
    if (body.weight !== undefined) {
      fields.weight = body.weight === null || body.weight === '' ? null : Number(body.weight);
    }
    days.patch(user.id, date, fields);
    return getFull(user, date);
  }

  /** Копирование дня в другую дату. Отметки выполнения не переносятся — это план, а не факт. */
  function copyTo(user, date, targetDate, sections = SECTIONS) {
    const src = getFull(user, date);
    if (src.rev === 0) throw notFound('Исходный день пуст');
    const want = new Set(sections);

    /*
     * Прежний номер строки → новый. По нему приём пищи находит в копии свой
     * блок: без этого связь рвалась, и на один обед приходило два уведомления —
     * одно от блока, второе от приёма пищи, который считал себя ничьим.
     */
    const newIdOf = new Map();

    const tx = db.transaction(() => {
      days.ensure(user.id, targetDate);
      if (want.has('schedule')) {
        schedule.removeAllForDate(user.id, targetDate);
        src.schedule.forEach((r, i) => {
          const created = schedule.create(user.id, targetDate, {
            startMin: r.start_min, endMin: r.end_min, title: r.title, note: r.note,
            kind: r.kind, alarmMode: r.alarm_mode, alarmProfile: r.alarm_profile,
            // список сроков и цвет — часть плана; без них копия дня выходила
            // блёкло-сиреневой и с одним напоминанием вместо трёх
            remindBeforeMin: r.remind_before_min, remindBefore: r.remind_before_json,
            color: r.color, done: 0, sortOrder: i,
          });
          newIdOf.set(r.id, created.id);
        });
      }
      if (want.has('tasks')) {
        tasks.removeAllForDate(user.id, targetDate);
        [...src.tasks.work, ...src.tasks.home].forEach((r, i) => tasks.create(user.id, targetDate, {
          bucket: r.bucket, text: r.text, done: 0, sortOrder: i,
        }));
      }
      if (want.has('meals')) {
        meals.removeAllForDate(user.id, targetDate);
        src.meals.forEach((r, i) => meals.create(user.id, targetDate, {
          slot: r.slot, timeMin: r.time_min, endMin: r.end_min, title: r.title, note: r.note,
          calories: r.calories, remindBefore: r.remind_before_json, done: 0, sortOrder: i,
          /*
           * Связь переводим на блок-копию, а не отбрасываем. Без неё приём
           * пищи в копии считал себя ничьим, и на один обед приходило два
           * уведомления: одно от блока, второе от него самого. Если
           * расписание не копировали, связывать не с чем — тогда пусто.
           */
          scheduleItemId: r.schedule_item_id ? (newIdOf.get(r.schedule_item_id) ?? null) : null,
        }));
      }
      if (want.has('sport')) {
        sport.removeAllForDate(user.id, targetDate);
        src.sport.forEach((r, i) => sport.create(user.id, targetDate, {
          exercise: r.exercise, sets: r.sets, reps: r.reps, weight: r.weight, done: 0, sortOrder: i,
        }));
      }
      bumpRev(db, user.id, targetDate);
    });
    tx();

    return getFull(user, targetDate);
  }

  return { getFull, getRange, replaceFull, patchDay, copyTo, checkIfMatch, SECTIONS };
}

module.exports = { dayService, DAY_SECTIONS: SECTIONS };
