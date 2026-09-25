const { ApiError, notFound, badRequest } = require('../lib/errors');
const v = require('../lib/validate');
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
const { usersRepo } = require('../repos/users');
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
  const users = usersRepo(db);

  /**
   * Читает день. Если записи нет — отдаёт валидный пустой день с rev: 0
   * и НЕ создаёт его в базе. Именно поэтому клиенту больше не нужен
   * «пустой фолбэк», из-за которого раньше день затирался при обрыве связи.
   */
  function getFull(user, date) {
    // Повторы достраиваются при открытии дня: человек, открывший завтра,
    // ожидает увидеть своё расписание, а не пустоту.
    series.materializeDay(user.id, date, { today: todayFor(user.timezone) });
    carryTasks(user, date);
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
      /*
       * Серия по всем привычкам — отдельным полем, а не внутри прогресса:
       * прогресс считается ещё и по каждому дню сводки за месяц, и лишний
       * проход по году истории на каждую из тридцати клеток там не нужен.
       */
      habitsStreak: stats.habitsStreak(user, date),
    };
  }

  /**
   * Невыполненное из прошлых дней переезжает в сегодня.
   *
   * Переключатель «Переносить невыполненное — задачи уезжают на завтра» в
   * настройках был, а переноса не было: он остался в старом наборе
   * маршрутов, работавшем с прежним хранилищем дня. Человек видел
   * включённый переключатель, не закрывал во вторник две задачи, открывал
   * среду — и там их не было. Тихо не работающая настройка хуже, чем её
   * отсутствие.
   *
   * Задача именно переезжает, а не копируется: так обещает сама подпись
   * переключателя, и так задача остаётся одной штукой, а не следом в каждом
   * прошедшем дне. Откуда приехала, видно на самой задаче — «↩ с 15
   * сентября», это поле `carried_from`, и первая дата в нём сохраняется.
   *
   * Только в сегодня и только по открытию дня — там же, где достраиваются
   * повторы. Открытая среда не должна вытягивать к себе несделанное, пока
   * на календаре вторник: иначе задача исчезла бы из сегодняшнего дня.
   *
   * Глубина — три дня и не раньше дня, когда перенос включили. Первая версия
   * брала две недели назад, и при первом же открытии дня человеку приехали
   * восемь задач, пять из них — двухнедельной давности, давно сделанные и
   * просто не отмеченные («Подготовить план на 3 сентября»). Перенос — про
   * вчерашнее и позавчерашнее, которое реально доделывают, а не про свалку.
   */
  const CARRY_DAYS = 3;
  const sameText = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

  function carryTasks(user, date) {
    const today = todayFor(user.timezone);
    if (date !== today) return;
    const settings = users.getSettings(user.id) ?? {};
    if (settings.carryOver !== true) return;

    /*
     * Перенос, включённый до того, как появилась дата включения, считаем
     * включённым сегодня: так и у давних пользователей переносится только
     * то, что осталось несделанным с этого момента.
     */
    let enabled = /^\d{4}-\d{2}-\d{2}$/.test(settings.carryOverSince ?? '') ? settings.carryOverSince : null;
    if (!enabled) {
      enabled = today;
      users.setSettings(user.id, { carryOverSince: today });
    }
    const window = addDays(today, -CARRY_DAYS);
    const since = enabled > window ? enabled : window;
    /*
     * Записи интеграций не переносим.
     *
     * У задачи из внешнего списка ключ — источник, внешний номер и дата, и
     * на эту тройку стоит уникальный индекс. Перенос двигал такие задачи
     * вместе со своими, и если та же задача уже стояла на сегодня, UPDATE
     * упирался в индекс: сегодняшний день переставал открываться совсем —
     * «внутренняя ошибка» на каждый запрос, починить из приложения нечем.
     * Да и по смыслу такой задачей владеет внешний список: сдвинь её дату,
     * и следующая синхронизация просто создаст её заново на прежнем месте.
     */
    const rows = db.prepare(
      `SELECT id, date, text, bucket FROM tasks
        WHERE user_id = ? AND done = 0 AND date < ? AND date >= ? AND source IS NULL
        ORDER BY date ASC, sort_order ASC, id ASC`,
    ).all(user.id, today, since);
    if (!rows.length) return;

    /*
     * «Та же задача» — это тот же текст в том же разделе.
     *
     * Раньше сравнивался только текст, и «Позвонить» в рабочих делах на сегодня
     * не давало перенести «Позвонить» из домашних за вчера: задача молча
     * оставалась в прошлом дне, и человек считал, что перенос не работает.
     * Разделы — это разные списки, одинаковые названия в них обычны.
     */
    const here = tasks.list(user.id, today);
    const ключ = t => `${t.bucket}|${sameText(t.text)}`;
    const seen = new Set(here.map(ключ));
    let order = here.reduce((max, t) => Math.max(max, t.sort_order ?? 0), -1);
    /*
     * `carried_from` и `date` справа считаются по прежним значениям строки —
     * это свойство UPDATE в SQLite, поэтому COALESCE берёт именно первый
     * день, где задача появилась, а не сегодняшний.
     */
    const move = db.prepare(
      `UPDATE tasks SET date = ?, sort_order = ?, carried_from = COALESCE(carried_from, date),
              updated_at = datetime('now')
        WHERE id = ?`,
    );
    const from = new Set();
    db.transaction(() => {
      for (const t of rows) {
        // такая же задача на сегодня уже стоит — пусть остаётся в своём дне
        if (seen.has(ключ(t))) continue;
        seen.add(ключ(t));
        move.run(today, (order += 1), t.id);
        from.add(t.date);
      }
    })();

    if (!from.size) return;
    bumpRev(db, user.id, today);
    for (const d of from) bumpRev(db, user.id, d);
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
      /*
       * Задачи едут вместе с расписанием.
       *
       * Расписание — это когда, а задачи — что вообще нужно сделать; на
       * неделе и в месяце второе важнее первого. Раньше выборка за период
       * отдавала только строки времени, и сетка физически не могла показать
       * задачи — за ними пришлось бы ходить в каждый день отдельным запросом,
       * то есть сорок два запроса на лист месяца.
       */
      const dayTasks = tasks.list(user.id, cur);
      days.push({
        date: cur,
        schedule: rows,
        tasks: dayTasks,
        counts: {
          schedule: rows.length,
          done: rows.filter(r => r.done === 1).length,
          tasks: dayTasks.length,
          tasksDone: dayTasks.filter(t => t.done === 1).length,
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

  /**
   * Поля самого дня, приведённые и проверенные.
   *
   * Вес раньше шёл через голый `Number()`: «семьдесят» превращалось в NaN,
   * а better-sqlite3 пишет NaN как NULL — человек вводил вес, получал в
   * ответ 200 и пустую графу, без единого слова о том, что не так. «1e400»
   * уезжало в базу бесконечностью. Тексты дня не были ограничены вовсе,
   * хотя тот же текст через `POST /notes` ограничен двадцатью тысячами
   * знаков: полтора мегабайта в заметке дня потом приезжали в каждый
   * список заметок.
   */
  const MAX_NOTES = 20000;
  const MAX_TITLE = 200;

  function dayText(value, max, field) {
    const text = String(value);
    if (text.length > max) throw badRequest(`Поле «${field}» длиннее ${max} символов`);
    return text;
  }

  function dayWeight(value) {
    if (value === null || value === undefined || value === '') return null;
    return v.num(value, { min: 1, max: 700, field: 'вес' });
  }

  function dayFields(body) {
    const fields = {};
    if (body.title !== undefined) fields.title = dayText(body.title, MAX_TITLE, 'заголовок');
    if (body.focus !== undefined) fields.focus = dayText(body.focus, MAX_TITLE, 'главное на день');
    if (body.notes !== undefined) fields.notes = dayText(body.notes, MAX_NOTES, 'заметка');
    if (body.foodPlan !== undefined) fields.foodPlan = String(body.foodPlan).slice(0, 500);
    if (body.weight !== undefined) fields.weight = dayWeight(body.weight);
    return fields;
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
        title: dayText(body.title ?? '', MAX_TITLE, 'заголовок'),
        focus: dayText(body.focus ?? '', MAX_TITLE, 'главное на день'),
        weight: dayWeight(body.weight),
        notes: dayText(body.notes ?? '', MAX_NOTES, 'заметка'),
        foodPlan: String(body.foodPlan ?? '').slice(0, 500),
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
    const fields = dayFields(body);
    days.patch(user.id, date, fields);
    return getFull(user, date);
  }

  /**
   * Удаление дня целиком.
   *
   * Раньше день стирался четырьмя сырыми DELETE прямо в репозитории дней, в
   * обход всей логики удаления: не оставалось ни надгробий интеграций
   * (удалённая строка воскресала первой же синхронизацией), ни пометок «в
   * этот день повтора нет» (день восстанавливался сам при следующем
   * открытии — и даже раньше, пересчётом уведомлений сразу после ответа).
   * Теперь удаление идёт теми же руками, что и удаление по одной записи.
   */
  function removeDay(user, date) {
    const tx = db.transaction(() => {
      for (const repo of [schedule, tasks, meals, sport]) repo.removeAllForDate(user.id, date);
      days.remove(user.id, date);
    });
    tx();
  }

  /** Копирование дня в другую дату. Отметки выполнения не переносятся — это план, а не факт. */
  /**
   * Копия дня в другой день.
   *
   * @param {object} opts
   * @param {string=} opts.ifMatch — версия дня-получателя
   * @param {boolean=} opts.overwrite — «да, затереть» без версии
   */
  function copyTo(user, date, targetDate, sections = SECTIONS, opts = {}) {
    const src = getFull(user, date);
    if (src.rev === 0) throw notFound('Исходный день пуст');
    const want = new Set(sections);

    /*
     * Непустой день-получатель не затираем молча.
     *
     * Копирование стирает в цели всё, что было, — и делало это без единой
     * проверки: одна опечатка в дате, и день с полным расписанием, делами и
     * отметками заменялся чужим содержимым. Восстановить нечем.
     *
     * Пустой день (версия 0) копируем свободно: терять там нечего, а
     * требовать версию у дня, которого ещё нет, — лишний шаг на ровном месте.
     * Непустой требует либо версии в If-Match (как правки дня), либо явного
     * «overwrite: true» — сознательного «да, затереть».
     */
    const цель = days.get(user.id, targetDate);
    if ((цель?.rev ?? 0) > 0 && !opts.overwrite) {
      checkIfMatch(opts.ifMatch, user, targetDate);
    }

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
            /*
             * Копия помнит, каким повтором рождена исходная строка. Без
             * этого день-получатель считал, что повтор в нём ещё не
             * достроен, и создавал вторую такую же строку: две «Зарядки»,
             * два уведомления, неверный счётчик в сетке месяца.
             */
            seriesId: r.series_id ?? null,
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

  return { getFull, getRange, replaceFull, patchDay, copyTo, removeDay, checkIfMatch, SECTIONS };
}

module.exports = { dayService, DAY_SECTIONS: SECTIONS };
