const { habitsRepo } = require('../repos/habits');
const { scheduleRepo } = require('../repos/schedule');
const { tasksRepo } = require('../repos/tasks');
const { mealsRepo } = require('../repos/meals');
const { sportRepo } = require('../repos/sport');
const { todayFor, addDays, rangeDates, weekdayInMask } = require('../lib/dates');

/**
 * Привычка «активна» в дату, если она не в архиве, дата не раньше создания,
 * не раньше старта челленджа и попадает в её маску дней недели.
 * Всё остальное — не считается ни выполнением, ни пропуском.
 */
function habitActiveOn(habit, date) {
  if (habit.archived_at) return false;
  if (habit.is_active !== 1) return false;
  const created = String(habit.created_at || '').slice(0, 10);
  if (created && date < created) return false;
  if (habit.challenge_start_date && date < habit.challenge_start_date) return false;
  return weekdayInMask(date, habit.schedule_mask);
}

function pct(done, possible) {
  return possible > 0 ? Math.round((done / possible) * 100) : null;
}

/**
 * @param opts.now — момент, от которого считается «сегодня». Нужен тестам,
 *                   чтобы граница «прошедший день / ещё не наступил» была детерминированной.
 */
function statsService(db, opts = {}) {
  const nowOf = () => opts.now ?? new Date();
  const habits = habitsRepo(db);
  const schedule = scheduleRepo(db);
  const tasks = tasksRepo(db);
  const meals = mealsRepo(db);
  const sport = sportRepo(db);

  /**
   * Текущий стрик: идём назад от `to`, пропуская неактивные дни и заморозки.
   * Отсутствие записи за сегодня стрик не рвёт — день ещё не закончился.
   */
  function currentStreak(habit, logsMap, to, today) {
    let streak = 0;
    let cursor = to;
    const floor = habit.challenge_start_date
      || String(habit.created_at || '').slice(0, 10)
      || addDays(to, -3650);

    while (cursor >= floor) {
      if (!habitActiveOn(habit, cursor)) { cursor = addDays(cursor, -1); continue; }
      const status = logsMap[cursor];
      if (status === 'skipped') { cursor = addDays(cursor, -1); continue; }
      if (status === 'done') { streak += 1; cursor = addDays(cursor, -1); continue; }
      if (status === 'missed') break;
      // записи нет: сегодня и будущее не считаем срывом, прошлое — считаем
      if (cursor >= today) { cursor = addDays(cursor, -1); continue; }
      break;
    }
    return streak;
  }

  function bestStreak(habit, logsMap, from, to) {
    let best = 0, run = 0;
    for (const d of rangeDates(from, to)) {
      if (!habitActiveOn(habit, d)) continue;
      const status = logsMap[d];
      if (status === 'skipped') continue;
      if (status === 'done') { run += 1; if (run > best) best = run; }
      else run = 0;
    }
    return best;
  }

  function habitStats(user, habitId, from, to) {
    const habit = habits.get(user.id, habitId);
    const today = todayFor(user.timezone, nowOf());
    const rangeTo = to || today;
    const rangeFrom = from
      || habit.challenge_start_date
      || String(habit.created_at || '').slice(0, 10)
      || addDays(rangeTo, -29);

    const logs = habits.logsInRange(user.id, habitId, null, rangeTo);
    const logsMap = {};
    for (const l of logs) logsMap[l.date] = l.status;

    let done = 0, missed = 0, skipped = 0;
    for (const d of rangeDates(rangeFrom, rangeTo)) {
      if (!habitActiveOn(habit, d)) continue;
      const status = logsMap[d];
      if (status === 'done') done += 1;
      else if (status === 'skipped') skipped += 1;
      else if (status === 'missed') missed += 1;
      else if (d < today) missed += 1; // прошедший активный день без отметки — пропуск
    }

    const streak = currentStreak(habit, logsMap, rangeTo, today);

    let challenge = null;
    if (habit.mode === 'challenge' && habit.challenge_target_days) {
      const start = habit.challenge_start_date || rangeFrom;
      if (habit.break_policy === 'keep') {
        // накопительно: считаем выполненные дни от старта, срывы показываем отдельно
        let cDone = 0, cBreaks = 0;
        for (const d of rangeDates(start, rangeTo)) {
          if (!habitActiveOn(habit, d)) continue;
          const status = logsMap[d];
          if (status === 'done') cDone += 1;
          else if (status === 'missed' || (status === undefined && d < today)) cBreaks += 1;
        }
        challenge = {
          day: Math.min(cDone, habit.challenge_target_days),
          target: habit.challenge_target_days,
          breaks: cBreaks,
          complete: cDone >= habit.challenge_target_days,
          startDate: start,
        };
      } else {
        // reset: счётчик равен текущей серии подряд
        challenge = {
          day: Math.min(streak, habit.challenge_target_days),
          target: habit.challenge_target_days,
          breaks: missed,
          complete: streak >= habit.challenge_target_days,
          startDate: start,
        };
      }
    }

    const last14 = rangeDates(addDays(rangeTo, -13), rangeTo).map(d => ({
      date: d,
      status: habitActiveOn(habit, d) ? (logsMap[d] ?? (d < today ? 'missed' : null)) : 'inactive',
    }));

    return {
      id: habit.id,
      title: habit.title,
      emoji: habit.emoji || '',
      color: habit.color,
      from: rangeFrom,
      to: rangeTo,
      currentStreak: streak,
      bestStreak: bestStreak(habit, logsMap, rangeFrom, rangeTo),
      done, missed, skipped,
      percent: pct(done, done + missed),
      challenge,
      last14,
    };
  }

  /** Привычки на конкретный день — то, что показывается в блоке «Привычки сегодня». */
  function habitsForDate(user, date) {
    const list = habits.list(user.id);
    const logs = habits.logsForDate(user.id, date);
    const byId = {};
    for (const l of logs) byId[l.habit_id] = l;

    return list.map(h => {
      const log = byId[h.id];
      const active = habitActiveOn(h, date);
      let challenge = null;
      if (h.mode === 'challenge' && h.challenge_target_days) {
        const s = habitStats(user, h.id, null, date);
        challenge = s.challenge;
      }
      return {
        id: h.id,
        title: h.title,
        emoji: h.emoji || '',
        color: h.color,
        type: h.type,
        unit: h.unit,
        targetPerDay: h.target_per_day,
        polarity: h.polarity,
        mode: h.mode,
        breakPolicy: h.break_policy,
        scheduleMask: h.schedule_mask,
        status: log?.status ?? null,
        value: log?.value ?? null,
        activeToday: active,
        challenge,
      };
    });
  }

  /** Прогресс дня: общий плюс шесть секций, без весов. */
  function dayProgress(user, date) {
    const section = rows => {
      const possible = rows.length;
      const done = rows.filter(r => r.done === 1).length;
      return { done, possible, percent: pct(done, possible) };
    };

    const allTasks = tasks.list(user.id, date);
    const habitRows = habitsForDate(user, date)
      .filter(h => h.activeToday && h.status !== 'skipped');

    const parts = {
      schedule: section(schedule.list(user.id, date)),
      work: section(allTasks.filter(t => t.bucket === 'work')),
      home: section(allTasks.filter(t => t.bucket === 'home')),
      food: section(meals.list(user.id, date)),
      sport: section(sport.list(user.id, date)),
      habits: {
        done: habitRows.filter(h => h.status === 'done').length,
        possible: habitRows.length,
        percent: pct(habitRows.filter(h => h.status === 'done').length, habitRows.length),
      },
    };

    const done = Object.values(parts).reduce((s, p) => s + p.done, 0);
    const possible = Object.values(parts).reduce((s, p) => s + p.possible, 0);

    return { total: { done, possible, percent: pct(done, possible) }, ...parts };
  }

  /** Сводка за период: прогресс по дням и статистика всех привычек. */
  function overview(user, from, to) {
    const today = todayFor(user.timezone, nowOf());
    const rangeTo = to || today;
    const rangeFrom = from || addDays(rangeTo, -29);

    const days = rangeDates(rangeFrom, rangeTo).map(d => ({
      date: d,
      progress: dayProgress(user, d).total,
    }));

    const habitList = habits.list(user.id).map(h => habitStats(user, h.id, rangeFrom, rangeTo));

    const withPercent = habitList.filter(h => h.percent !== null);
    const sorted = [...withPercent].sort((a, b) => b.percent - a.percent);

    return {
      from: rangeFrom,
      to: rangeTo,
      days,
      habits: habitList,
      summary: {
        bestHabit: sorted[0] ? { id: sorted[0].id, title: sorted[0].title, percent: sorted[0].percent } : null,
        weakestHabit: sorted.length > 1
          ? { id: sorted.at(-1).id, title: sorted.at(-1).title, percent: sorted.at(-1).percent }
          : null,
        habitsAbove70: withPercent.filter(h => h.percent >= 70).length,
        habitsBelow40: withPercent.filter(h => h.percent < 40).length,
      },
    };
  }

  return { habitStats, habitsForDate, dayProgress, overview, habitActiveOn };
}

module.exports = { statsService, habitActiveOn };
