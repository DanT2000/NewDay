const { ApiError, notFound } = require('../lib/errors');
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
    series.materializeDay(user.id, date);
    const day = days.get(user.id, date);
    const allTasks = tasks.list(user.id, date);
    return {
      date,
      rev: day?.rev ?? 0,
      title: day?.title ?? '',
      focus: day?.focus ?? '',
      weight: day?.weight ?? null,
      notes: day?.notes ?? '',
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
      });

      (body.schedule || []).forEach((row, i) => schedule.create(user.id, date, { ...row, sortOrder: i }));
      const work = body.tasks?.work || [];
      const home = body.tasks?.home || [];
      work.forEach((row, i) => tasks.create(user.id, date, { ...row, bucket: 'work', sortOrder: i }));
      home.forEach((row, i) => tasks.create(user.id, date, { ...row, bucket: 'home', sortOrder: i }));
      (body.meals || []).forEach((row, i) => meals.create(user.id, date, { ...row, sortOrder: i }));
      (body.sport || []).forEach((row, i) => sport.create(user.id, date, { ...row, sortOrder: i }));
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

    const tx = db.transaction(() => {
      days.ensure(user.id, targetDate);
      if (want.has('schedule')) {
        schedule.removeAllForDate(user.id, targetDate);
        src.schedule.forEach((r, i) => schedule.create(user.id, targetDate, {
          startMin: r.start_min, endMin: r.end_min, title: r.title, note: r.note,
          kind: r.kind, alarmMode: r.alarm_mode, alarmProfile: r.alarm_profile,
          remindBeforeMin: r.remind_before_min, done: 0, sortOrder: i,
        }));
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
          slot: r.slot, timeMin: r.time_min, title: r.title, note: r.note,
          calories: r.calories, done: 0, sortOrder: i,
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

  return { getFull, replaceFull, patchDay, copyTo, checkIfMatch, SECTIONS };
}

module.exports = { dayService, DAY_SECTIONS: SECTIONS };
