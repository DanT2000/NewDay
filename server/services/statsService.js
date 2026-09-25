const { habitsRepo } = require('../repos/habits');
const { scheduleRepo } = require('../repos/schedule');
const { tasksRepo } = require('../repos/tasks');
const { mealsRepo } = require('../repos/meals');
const { sportRepo } = require('../repos/sport');
const { todayFor, localDateOf, addDays, rangeDates, weekdayInMask } = require('../lib/dates');

/**
 * Привычка «активна» в дату, если она не в архиве, дата не раньше создания,
 * не раньше старта челленджа и попадает в её маску дней недели.
 * Всё остальное — не считается ни выполнением, ни пропуском.
 */
function habitActiveOn(habit, date) {
  if (habit.is_active !== 1) return false;
  // архив считается с даты архивации, а не задним числом: в днях, когда
  // привычка ещё жила, её история остаётся правдой
  if (!habitExistsOn(habit, date)) return false;
  return weekdayInMask(date, habit.schedule_mask);
}

/**
 * Существовала ли привычка в эту дату вообще.
 *
 * Отличается от «активна»: неактивная в конкретный день привычка — это
 * законный выходной по маске дней недели, и её видно с подписью «сегодня
 * выходной». А привычка, созданная 1 августа, в июльских днях не должна
 * появляться вовсе: она там не отдыхала, её там не было.
 */
function habitExistsOn(habit, date) {
  const created = String(habit.created_at || '').slice(0, 10);
  if (created && date < created) return false;
  const archived = String(habit.archived_at || '').slice(0, 10);
  if (archived && date >= archived) return false;
  // до начала челленджа отмечать нечего
  if (habit.challenge_start_date && date < habit.challenge_start_date) return false;
  return true;
}

/**
 * Свободный график: «три раза в неделю», без привязки к дням.
 *
 * У такой привычки неотмеченный день — не пропуск: человек ничего не обещал
 * именно на него. Обещание считается за неделю, поэтому пропуском может быть
 * только явная отметка «не сделал».
 */
const freeSchedule = habit => Number(habit.times_per_week) > 0;

/**
 * Вид привычки: серия или цель.
 *
 * Серия — сколько раз подряд: пропуск обещанного дня обнуляет счёт. Цель —
 * сколько раз всего: пропуск не в зачёт, но счёт не сбрасывает. Правило одно
 * и живёт здесь, чтобы клиенту не пришлось повторять его у себя.
 *
 * Свободный график («N раз в неделю») — всегда цель: конкретных дней он не
 * обещает, и «подряд» для него ничего не значит.
 */
const kindOf = habit => (habit.break_policy === 'keep' || freeSchedule(habit) ? 'goal' : 'series');

function pct(done, possible) {
  return possible > 0 ? Math.round((done / possible) * 100) : null;
}

/**
 * @param opts.now — момент, от которого считается «сегодня». Нужен тестам,
 *                   чтобы граница «прошедший день / ещё не наступил» была детерминированной.
 */
function statsService(db, opts = {}) {
  const nowOf = () => opts.now ?? new Date();

  /**
   * Даты жизни привычки — в поясе человека, а не в UTC.
   *
   * В базе они лежат моментами по UTC, а дни человека считаются в его поясе.
   * Пока даты совпадают, разницы не видно; в те часы, когда не совпадают,
   * привычка, созданная минуту назад, выглядела существовавшей вчера — и
   * вчерашний день считал её пропущенной.
   */
  const localized = (habit, timeZone) => ({
    ...habit,
    created_at: localDateOf(habit.created_at, timeZone),
    archived_at: habit.archived_at ? localDateOf(habit.archived_at, timeZone) : null,
  });

  const habits = habitsRepo(db);
  const schedule = scheduleRepo(db);
  const tasks = tasksRepo(db);
  const meals = mealsRepo(db);
  const sport = sportRepo(db);

  /**
   * Текущий стрик: идём назад от `to`, пропуская неактивные дни и заморозки.
   * Отсутствие записи за сегодня стрик не рвёт — день ещё не закончился.
   *
   * У свободного графика серии нет вовсе: «три раза в неделю» не про дни
   * подряд, и число «подряд 15 дней» для такой привычки означало бы просто
   * количество отметок. Считаем её норму недели, а серию не считаем.
   */
  function currentStreak(habit, logsMap, to, today) {
    // у цели серии нет вовсе: её счёт — число отметок, а не дни подряд
    if (kindOf(habit) === 'goal') return 0;
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
      // у свободного графика день без отметки ничего не нарушает
      if (freeSchedule(habit)) { cursor = addDays(cursor, -1); continue; }
      break;
    }
    return streak;
  }

  function bestStreak(habit, logsMap, from, to) {
    // у цели серии нет — см. currentStreak
    if (kindOf(habit) === 'goal') return 0;
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
    const habit = localized(habits.get(user.id, habitId), user.timezone);
    const today = todayFor(user.timezone, nowOf());
    const rangeTo = to || today;
    const rangeFrom = from
      || habit.challenge_start_date
      || String(habit.created_at || '').slice(0, 10)
      || addDays(rangeTo, -29);

    const logs = habits.logsInRange(user.id, habitId, null, rangeTo);
    const logsMap = {};
    for (const l of logs) logsMap[l.date] = l.status;

    const kind = kindOf(habit);
    let done = 0, missed = 0, skipped = 0;
    for (const d of rangeDates(rangeFrom, rangeTo)) {
      if (!habitActiveOn(habit, d)) continue;
      const status = logsMap[d];
      if (status === 'done') done += 1;
      else if (status === 'skipped') skipped += 1;
      else if (status === 'missed') missed += 1;
      /*
       * Прошедший активный день без отметки — пропуск, но только у серии:
       * цель ничего на конкретный день не обещала, и наказывать за него не
       * за что.
       */
      else if (d < today && kind === 'series') missed += 1;
    }
    // у цели и явная отметка «не сделал» не срыв: рвать там нечего
    if (kind === 'goal') missed = 0;

    const streak = currentStreak(habit, logsMap, rangeTo, today);

    /** Всего отметок «сделано» за всю жизнь привычки — это и есть счёт цели. */
    const total = Object.values(logsMap).filter(s => s === 'done').length;
    const target = habit.challenge_target_days ?? null;

    /*
     * Цель живёт числом, а не режимом: «сделать 30 раз» — это цель, а
     * счётчик без числа — та же цель, просто без финиша.
     */
    let challenge = null;
    if (target) {
      const start = habit.challenge_start_date || rangeFrom;
      let сделано = 0;
      let срывов = 0;
      for (const d of rangeDates(start, rangeTo)) {
        if (!habitActiveOn(habit, d)) continue;
        const status = logsMap[d];
        if (status === 'done') сделано += 1;
        else if (kind === 'series' && (status === 'missed' || (status === undefined && d < today))) срывов += 1;
      }
      /*
       * У серии счёт — это текущая серия подряд: сорвался, и счётчик снова
       * с нуля. У цели — накопленное число отметок, оно не убывает.
       */
      const счёт = kind === 'series' ? streak : сделано;
      challenge = {
        day: Math.min(счёт, target),
        target,
        breaks: срывов,
        complete: счёт >= target,
        startDate: start,
      };
    }

    /*
     * Полоска за 14 дней. У серии пропущенный день красный — он и правда
     * сорвал счёт. У цели пустой: там нечего было срывать.
     */
    const gap = kind === 'series' ? 'missed' : null;
    const last14 = rangeDates(addDays(rangeTo, -13), rangeTo).map(d => ({
      date: d,
      status: habitActiveOn(habit, d) ? (logsMap[d] ?? (d < today ? gap : null)) : 'inactive',
    }));

    /*
     * Норма недели у свободного графика: сколько сделано за последние семь
     * дней против обещанного. Без этого «3 раза в неделю» нечем измерить —
     * серия подряд для такой привычки ничего не значит.
     */
    const week = freeSchedule(habit)
      ? {
        target: habit.times_per_week,
        done: rangeDates(addDays(rangeTo, -6), rangeTo)
          .filter(d => logsMap[d] === 'done').length,
      }
      : null;

    /*
     * Проценты: у серии — доля сделанного из обещанного, у цели —
     * насколько она набрана. Считаем от того же числа, что и счётчик
     * «X из N», то есть от даты постановки цели: иначе у привычки, которую
     * вели давно, рядом оказывались «0 из 30» и «100 %» — оба про неё же.
     * Перевыполнение — это «цель взята», а не 137 %. У цели без числа
     * процентам не от чего считаться.
     */
    const percent = kind === 'series'
      ? pct(done, done + missed)
      : (challenge ? Math.min(100, Math.round((challenge.day / challenge.target) * 100)) : null);

    return {
      id: habit.id,
      title: habit.title,
      emoji: habit.emoji || '',
      color: habit.color,
      from: rangeFrom,
      to: rangeTo,
      kind,
      target,
      total,
      currentStreak: streak,
      bestStreak: bestStreak(habit, logsMap, rangeFrom, rangeTo),
      done, missed, skipped,
      percent,
      challenge,
      timesPerWeek: habit.times_per_week ?? null,
      week,
      last14,
    };
  }

  /** Привычки на конкретный день — то, что показывается в блоке «Привычки сегодня». */
  function habitsForDate(user, date) {
    const list = habits.list(user.id, { includeArchived: true })
      .map(h => localized(h, user.timezone))
      .filter(h => habitExistsOn(h, date));
    const logs = habits.logsForDate(user.id, date);
    const byId = {};
    for (const l of logs) byId[l.habit_id] = l;

    /*
     * К каждой привычке добавляем неделю истории и текущую серию.
     * «Отмечено сегодня» само по себе ничего не говорит: смысл привычки
     * в том, как идёт подряд, а для этого нужно видеть предыдущие дни.
     * Неделя — потому что она укладывается в блок и совпадает с тем, как
     * человек про привычки и думает.
     */
    const weekFrom = addDays(date, -6);
    const weekDates = rangeDates(weekFrom, date);

    return list.map(h => {
      const log = byId[h.id];
      const active = habitActiveOn(h, date);
      const s = habitStats(user, h.id, null, date);
      // челлендж живёт числом, а не режимом: цель без числа — просто счётчик
      const challenge = h.challenge_target_days ? s.challenge : null;

      const weekMap = {};
      for (const l of habits.logsInRange(user.id, h.id, weekFrom, date)) weekMap[l.date] = l.status;
      const week = weekDates.map(d => ({
        date: d,
        status: weekMap[d] ?? null,
        active: habitActiveOn(h, d),
      }));

      return {
        week,
        streak: s.currentStreak,
        bestStreak: s.bestStreak,
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
        // вид и общий счёт — клиенту, чтобы он не повторял правило у себя
        kind: s.kind,
        total: s.total,
        target: s.target,
        scheduleMask: h.schedule_mask,
        timesPerWeek: h.times_per_week ?? null,
        weekNorm: s.week,
        status: log?.status ?? null,
        value: log?.value ?? null,
        activeToday: active,
        challenge,
      };
    });
  }

  /**
   * Серия по всем привычкам сразу: сколько дней подряд закрыт весь список.
   *
   * Плитка на «Сейчас» показывала «привычки за 7 дней, 56 %». Процент за
   * неделю ничего не говорит о том, держится ли человек: 56 % — это и «через
   * день», и «три дня подряд, потом бросил». Серия говорит ровно то, ради
   * чего привычки и ведут.
   *
   * Правила те же, что у серии одной привычки:
   *  - день засчитан, когда выполнены все привычки, обещанные на этот день;
   *  - «заморожено» не считается ни выполнением, ни срывом;
   *  - день, на который ничего не обещано (все привычки по будням, а это
   *    воскресенье), пропускается: он не рвёт серию и не удлиняет её;
   *  - свободный график («три раза в неделю») в серию не входит вовсе — он
   *    не про дни подряд; его отметка учитывается, если она есть;
   *  - сегодняшний незакрытый день серию не рвёт: он ещё не кончился.
   * Дальше года назад не смотрим — столько подряд не бывает, а запрос по
   * каждому дню стоит денег.
   */
  const STREAK_LIMIT = 366;

  function habitsStreak(user, date) {
    const today = todayFor(user.timezone, nowOf());
    const list = habits.list(user.id, { includeArchived: true })
      .map(h => localized(h, user.timezone))
      /*
       * Только серии. Непроставленная цель законна — пропуск у неё не срыв,
       * и рвать ею общую серию значит наказывать человека за то, что ему
       * прямо разрешено.
       */
      .filter(h => kindOf(h) === 'series');
    if (!list.length) return 0;

    const from = addDays(date, -STREAK_LIMIT);
    const logs = db.prepare(
      'SELECT habit_id, date, status FROM habit_logs WHERE user_id = ? AND date >= ? AND date <= ?',
    ).all(user.id, from, date);
    const byDate = new Map();
    for (const l of logs) {
      if (!byDate.has(l.date)) byDate.set(l.date, new Map());
      byDate.get(l.date).set(l.habit_id, l.status);
    }

    let streak = 0;
    for (let cursor = date; cursor >= from; cursor = addDays(cursor, -1)) {
      const обещано = list.filter(h => habitExistsOn(h, cursor) && habitActiveOn(h, cursor));
      if (!обещано.length) continue;

      const статусы = byDate.get(cursor) ?? new Map();
      const считаем = обещано.filter(h => статусы.get(h.id) !== 'skipped');
      if (!считаем.length) continue;

      if (считаем.every(h => статусы.get(h.id) === 'done')) { streak += 1; continue; }
      // сегодня ещё идёт: незакрытый день не срыв, но и не звено серии
      if (cursor >= today) continue;
      break;
    }
    return streak;
  }

  /** Прогресс дня: общий плюс шесть секций, без весов. */
  function dayProgress(user, date) {
    const section = rows => {
      const possible = rows.length;
      const done = rows.filter(r => r.done === 1).length;
      return { done, possible, percent: pct(done, possible) };
    };

    const allTasks = tasks.list(user.id, date);
    /*
     * Привычка со свободным графиком попадает в прогресс дня только если её
     * в этот день отметили. Иначе «три раза в неделю» висела бы в знаменателе
     * каждый день и портила процент в дни, на которые человек ничего и не
     * обещал.
     */
    const habitRows = habitsForDate(user, date)
      .filter(h => h.activeToday && h.status !== 'skipped')
      .filter(h => !h.timesPerWeek || h.status === 'done');

    /*
     * Прогресс — это ответ на вопрос «что я сделал», и в него входит только
     * то, что человек отмечает осознанно: дела, питание, спорт, привычки.
     *
     * Расписание из прогресса исключено намеренно. Раньше оно считалось
     * наравне с остальным, и на обычном дне девять строк расписания из
     * двадцати шести шагов давали больше трети «прогресса дня» — то есть
     * треть дня закрывалась галочками напротив «Подъём» и «Душ». Про время
     * знают часы; заставлять человека отмечать, что он проснулся, незачем.
     * Счётчик по расписанию остаётся отдельным полем: он нужен заголовку
     * секции, но в общую сумму не входит.
     */
    const parts = {
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

    return {
      total: { done, possible, percent: pct(done, possible) },
      ...parts,
      schedule: section(schedule.list(user.id, date)),
    };
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

  return { habitStats, habitsForDate, habitsStreak, dayProgress, overview, habitActiveOn };
}

module.exports = { statsService, habitActiveOn };
