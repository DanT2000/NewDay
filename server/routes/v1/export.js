const express = require('express');
const { wrap, badRequest } = require('../../lib/errors');
const v = require('../../lib/validate');
const { publicUser, usersRepo } = require('../../repos/users');
const { buildIcs } = require('../../lib/ical');
const { todayFor, addDays, isValidDate, isValidTimezone } = require('../../lib/dates');

const FORMAT_VERSION = 1;

const DAY_TABLES = ['schedule_items', 'tasks', 'meals', 'sport_sets'];


/*
 * Выгрузку проверяем до записи.
 *
 * Файл приходит от человека, а не от нашего же сервера: его правят руками,
 * склеивают из двух, режут по дороге. Без проверки дата-объект добиралась до
 * better-sqlite3 и давала «внутреннюю ошибку сервера» на кривом файле, а
 * строка вроде «не-дата» спокойно ложилась в базу — и потом день с
 * невозможной датой всплывал в списках, а арифметика дат на нём давала NaN.
 *
 * Проверяем до транзакции и целиком: либо файл берём весь, либо не берём
 * вовсе. Половина восстановленной выгрузки хуже, чем честный отказ.
 */
const DATE_FIELDS = {
  days: ['date'],
  scheduleItems: ['date'],
  tasks: ['date', 'carried_from'],
  meals: ['date'],
  sportSets: ['date'],
  seriesOverrides: ['date'],
  habitLogs: ['date'],
  series: ['start_date', 'end_date'],
};
const MAX_ROWS = 200000;

/*
 * Второй слой проверки выгрузки — значения.
 *
 * Даты сверяются до транзакции и целым файлом: с невозможной датой копию не
 * берём вовсе. С остальными полями так нельзя — отказать во всей копии из-за
 * одного цвета от прежней версии значит не вернуть человеку ничего. Поэтому
 * тут значения не отвергают файл, а приводятся к допустимым: неизвестный
 * цвет становится «без цвета», неизвестный тип — обычным блоком.
 *
 * Пропускать их тоже нельзя. Цвет не из палитры однажды гасил весь экран
 * дня, и перезагрузка не помогала: строка приезжала с сервера снова.
 */
const ЦВЕТА = ['violet', 'orange', 'green', 'red'];
const ВИДЫ = ['normal', 'work', 'meal', 'sport', 'rest', 'reminder'];
const БУДИЛЬНИК = ['none', 'notify', 'alarm'];
const ПРОФИЛИ = ['wakeup', 'gentle'];
const ПРИЁМЫ = ['breakfast', 'lunch', 'dinner', 'snack', 'other'];
const РАЗДЕЛЫ = ['work', 'home'];
const ВИДЫ_ПРИВЫЧЕК = ['binary', 'quant'];
const ПОЛЯРНОСТИ = ['do', 'avoid'];
const РЕЖИМЫ = ['ongoing', 'challenge'];
const ПРИ_СРЫВЕ = ['reset', 'keep'];
const СТАТУСЫ = ['done', 'missed', 'skipped'];
const ЦВЕТА_ПРИВЫЧЕК = ['blue', 'green', 'orange', 'red', 'purple', 'teal', 'pink', 'gray'];
const ПОВТОРЫ = ['daily', 'weekly', 'monthly', 'yearly'];
const ЦЕЛИ_ПОВТОРА = ['schedule', 'task', 'meal', 'sport'];
const СРОК_МАКС = 7 * 24 * 60;

const стр = (x, макс) => (x === undefined || x === null ? '' : String(x).slice(0, макс));
const из = (x, список, по) => (список.includes(x) ? x : по);
const флаг = x => (x ? 1 : 0);
const цел = (x, { min, max, по = null }) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return по;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};
const дробь = (x, { min, max, по = null }) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return по;
  return Math.min(max, Math.max(min, n));
};

/**
 * Сроки предупреждения хранятся строкой JSON. Строка из чужого файла может
 * оказаться чем угодно, а читают её и клиент, и планировщик — поэтому
 * разбираем, чистим и собираем заново по тем же правилам, что при записи:
 * по убыванию, не больше шести, −1 («к концу») допустим.
 */
function сроки(x) {
  let list = x;
  if (typeof x === 'string') {
    try { list = JSON.parse(x); } catch { return null; }
  }
  if (!Array.isArray(list)) return null;
  const числа = list
    .map(n => цел(n, { min: -1, max: СРОК_МАКС }))
    .filter(n => n !== null);
  const чистые = [...new Set(числа)].sort((a, b) => b - a).slice(0, 6);
  return чистые.length ? JSON.stringify(чистые) : null;
}

/**
 * Тело правила повтора — тоже строка JSON. Неразбираемую заменяем пустой:
 * правило без тела достроит пустую строку, а мусор в этой колонке роняет
 * весь день, в который правило попадает.
 */
function телоПовтора(x) {
  const s = стр(x, 20000) || '{}';
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o) ? s : '{}';
  } catch { return '{}'; }
}

const ТЕМЫ = ['system', 'light', 'dark'];
const ВИДЫ_РАСПИСАНИЯ = ['list', 'timeline'];
const РЕЖИМЫ_ПИТАНИЯ = ['checklist', 'timed'];
const НАСТРОЕК_МАКС = 100;
const НАСТРОЙКА_МАКС = 20000;

/**
 * Человек и его переключатели.
 *
 * В выгрузке они есть, а восстановление их не трогало: аккаунт, поднятый из
 * копии, возвращал все дни — и встречал человека чужим часовым поясом
 * (значит, сдвинутым «сегодня»), системной темой, воскресеньем как началом
 * недели и выключенным переносом невыполненного. Выглядело так, будто копия
 * неполная, и найти этому объяснение было нельзя.
 *
 * Только при «заменить всё»: там человек и просит сделать аккаунт тем, что в
 * файле. При «добавить» его собственные настройки важнее файла.
 */
function восстановитьЧеловека(users, uid, u) {
  if (!u || typeof u !== 'object') return;

  const профиль = {};
  if (u.displayName !== undefined) профиль.displayName = стр(u.displayName, 80);
  if (typeof u.timezone === 'string' && isValidTimezone(u.timezone)) профиль.timezone = u.timezone;
  if (ТЕМЫ.includes(u.theme)) профиль.theme = u.theme;
  const неделя = цел(u.weekStart, { min: 1, max: 7 });
  if (неделя !== null) профиль.weekStart = неделя;
  if (ВИДЫ_РАСПИСАНИЯ.includes(u.scheduleView)) профиль.scheduleView = u.scheduleView;
  if (РЕЖИМЫ_ПИТАНИЯ.includes(u.foodMode)) профиль.foodMode = u.foodMode;
  if (Object.keys(профиль).length) users.patchProfile(uid, профиль);

  const s = u.settings;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return;
  const чистые = {};
  for (const [k, значение] of Object.entries(s)) {
    if (Object.keys(чистые).length >= НАСТРОЕК_МАКС) break;
    if (k.length > 64) continue;
    if (JSON.stringify(значение ?? null).length > НАСТРОЙКА_МАКС) continue;
    чистые[k] = значение;
  }
  // то же правило, что в настройках: «с какого дня переносим» без включённого
  // переноса — мусор, который однажды сработает сам
  if (чистые.carryOver !== true) чистые.carryOverSince = null;
  else if (!isValidDate(чистые.carryOverSince)) чистые.carryOverSince = null;
  if (Object.keys(чистые).length) users.setSettings(uid, чистые);
}

/** Первый настоящий срок — его видит всё, что умеет только одно число. */
function первыйСрок(json) {
  if (!json) return null;
  const list = JSON.parse(json).filter(n => n >= 0);
  return list.length ? list[0] : null;
}

function проверитьВыгрузку(data) {
  for (const [ключ, поля] of Object.entries(DATE_FIELDS)) {
    const list = data[ключ];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) throw badRequest(`Раздел «${ключ}» в выгрузке должен быть списком`);
    if (list.length > MAX_ROWS) throw badRequest(`Слишком много записей в разделе «${ключ}»`);
    for (const [i, row] of list.entries()) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw badRequest(`${ключ}[${i}]: ожидается запись, а не ${Array.isArray(row) ? 'список' : typeof row}`);
      }
      for (const поле of поля) {
        const value = row[поле];
        if (value === undefined || value === null || value === '') continue;
        if (typeof value !== 'string' || !isValidDate(value)) {
          throw badRequest(`${ключ}[${i}].${поле}: «${String(value).slice(0, 40)}» — не дата в формате ГГГГ-ММ-ДД`);
        }
      }
    }
  }
}

module.exports = function exportRouter({ db }) {
  const router = express.Router();
  const users = usersRepo(db);

  const dump = userId => {
    const q = sql => db.prepare(sql).all(userId);
    return {
      formatVersion: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      user: publicUser(users.findById(userId), users.getSettings(userId)),
      /*
       * `food_plan` — план питания дня («Итого: примерно 1700–2150 ккал»).
       * Колонку добавили миграцией, а в выгрузку не внесли: своя же
       * резервная копия возвращала день без плана питания, молча.
       */
      days: q(`SELECT date, title, focus, weight, notes, food_plan
                 FROM days WHERE user_id = ? ORDER BY date`),
      /*
       * Поля перечислены по одному, а не звёздочкой: так видно, что уходит
       * человеку. Обратная сторона — новую колонку легко забыть, и однажды
       * это уже случилось: цвет, список сроков, окно приёма пищи и свободный
       * график привычки в выгрузку не попадали, а «заменить всё» их стирало.
       */
      scheduleItems: q(`SELECT id, date, start_min, end_min, title, note, done, sort_order, kind,
                               alarm_mode, alarm_profile, remind_before_min, remind_before_json, color,
                               series_id
                          FROM schedule_items WHERE user_id = ? ORDER BY date, start_min`),
      tasks: q('SELECT date, bucket, text, done, sort_order, carried_from FROM tasks WHERE user_id = ? ORDER BY date'),
      /*
       * id блока расписания уходит как есть, а при загрузке переводится в новый
       * по карте: иначе приём пищи после восстановления терял связь со своим
       * блоком и при первой же правке создавал второй.
       */
      meals: q(`SELECT date, slot, time_min, end_min, title, note, calories, done, sort_order,
                       remind_before_json, schedule_item_id
                  FROM meals WHERE user_id = ? ORDER BY date`),
      /*
       * `reps_max` — верх вилки «3×8–12». Колонку добавили миграцией, а в
       * список выгрузки забыли: своя же резервная копия возвращала «3×8»
       * вместо «3×8–12», и заметить это можно было только по памяти.
       */
      sportSets: q(`SELECT date, exercise, sets, reps, reps_max, weight, done, sort_order
                      FROM sport_sets WHERE user_id = ? ORDER BY date`),
      habits: q(`SELECT id, title, description, emoji, color, type, target_per_day, unit,
                        schedule_mask, times_per_week, polarity, mode, challenge_target_days,
                        challenge_start_date, break_policy, allowed_skips_per_week, is_active,
                        sort_order, archived_at, created_at
                   FROM habits WHERE user_id = ? ORDER BY sort_order`),
      habitLogs: q('SELECT habit_id, date, status, value FROM habit_logs WHERE user_id = ? ORDER BY date'),
      series: q('SELECT id, target, freq, interval, byweekday, start_date, end_date, payload_json, name FROM series WHERE user_id = ?'),
      /*
       * Отметки «в этот день повтора нет». Без них восстановление возвращало
       * удалённые вручную дни: правило достраивало их заново, и человек снова
       * видел то, что однажды убрал.
       */
      seriesOverrides: q('SELECT series_id, date, action FROM series_overrides WHERE user_id = ? ORDER BY date'),
      freeNotes: q('SELECT title, text, created_at, updated_at FROM free_notes WHERE user_id = ? ORDER BY id'),
    };
  };

  // '/export/all' — старый путь, оставлен до конца этапа 2
  router.get(['/export', '/export/all'], wrap((req, res) => {
    const payload = dump(req.user.id);
    if (req.query.download === '1' || req.path === '/export/all') {
      res.setHeader('Content-Disposition', 'attachment; filename="newday-export.json"');
    }
    res.json(payload);
  }));

  /**
   * Расписание в iCalendar. Свой JSON понимает только NewDay, .ics —
   * любой календарь; это способ посмотреть свой день там, где удобно.
   *
   * ?from&to — период, по умолчанию месяц назад и всё вперёд: выгружать
   * годы истории в календарь незачем.
   */
  router.get('/export.ics', wrap((req, res) => {
    const uid = req.user.id;
    const from = req.query.from
      ? v.date(req.query.from, { field: 'начало' })
      : addDays(todayFor(req.user.timezone), -30);
    const to = req.query.to ? v.date(req.query.to, { field: 'конец' }) : '9999-12-31';

    const schedule = db.prepare(
      `SELECT date, start_min, end_min, title, note, done, sort_order
         FROM schedule_items WHERE user_id = ? AND date BETWEEN ? AND ?
        ORDER BY date, start_min`).all(uid, from, to);
    /*
     * Окно приёма пищи — это тоже отрезок: без end_min обед 12:00–14:00 уезжал
     * в календарь получасовой точкой.
     *
     * А приёмы, у которых есть свой блок в расписании, пропускаем: блок уже
     * выгружен строкой выше, и календарь рисовал два наложенных события с
     * одним названием и одним временем.
     */
    const meals = db.prepare(
      `SELECT date, time_min, end_min, title, note, done, sort_order
         FROM meals WHERE user_id = ? AND date BETWEEN ? AND ? AND time_min IS NOT NULL
          AND schedule_item_id IS NULL
        ORDER BY date, time_min`).all(uid, from, to);

    const body = buildIcs({ schedule, meals }, {
      timeZone: req.user.timezone || 'Europe/Moscow',
      calendarName: 'NewDay — расписание',
    });

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="newday.ics"');
    res.send(body);
  }));

  router.post('/import', wrap((req, res) => {
    const raw = req.body?.data;
    let data = raw;
    if (typeof raw === 'string') {
      // Разбор в try: испорченный файл — обычное дело, и человек должен
      // прочитать «это не похоже на выгрузку», а не «внутренняя ошибка»
      try { data = JSON.parse(raw); }
      catch { throw badRequest('Файл не похож на выгрузку NewDay: это не JSON'); }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw badRequest('Не переданы данные для импорта');
    }
    if (data.formatVersion !== FORMAT_VERSION) {
      throw badRequest(`Неподдерживаемая версия формата: ${data.formatVersion}`);
    }
    const mode = v.oneOf(req.body.mode, ['merge', 'replace'], { field: 'режим', fallback: 'merge' });
    const uid = req.user.id;
    проверитьВыгрузку(data);

    const tx = db.transaction(() => {
      if (mode === 'replace') {
        for (const t of [...DAY_TABLES, 'habit_logs', 'habits', 'series_overrides', 'series', 'days']) {
          db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(uid);
        }
        восстановитьЧеловека(users, uid, data.user);
      }

      const existingDates = new Set(
        db.prepare('SELECT date FROM days WHERE user_id = ?').all(uid).map(r => r.date)
      );

      for (const d of data.days || []) {
        if (mode === 'merge' && existingDates.has(d.date)) continue;
        db.prepare(`INSERT OR REPLACE INTO days (user_id, date, title, focus, weight, notes, food_plan)
                    VALUES (?,?,?,?,?,?,?)`)
          .run(uid, d.date, стр(d.title, 200), стр(d.focus, 500),
               дробь(d.weight, { min: 0, max: 1000 }), стр(d.notes, 20000), стр(d.food_plan, 20000));
      }

      const skip = date => mode === 'merge' && existingDates.has(date);

      /*
       * Правила кладём раньше строк: строка помнит, каким повтором создана, и
       * этот номер нужно перевести на новый. Без перевода восстановленная
       * строка приезжала ничьей, повтор достраивал день ещё раз, и на каждый
       * вторник выходило по две «Зарядки».
       *
       * В режиме «добавить» правило с тем же именем считается тем же самым:
       * иначе своя же выгрузка удваивала бы шаблон. Безымянные повторы
       * сравниваем по содержимому — у них имени нет.
       */
      const ruleByKey = new Map();
      if (mode === 'merge') {
        for (const row of db.prepare('SELECT id, name, freq, start_date, payload_json FROM series WHERE user_id = ?').all(uid)) {
          ruleByKey.set(row.name ? `name:${row.name}` : `body:${row.freq}|${row.start_date}|${row.payload_json}`, row.id);
        }
      }
      const seriesIdMap = new Map();
      for (const s of data.series || []) {
        const key = s.name ? `name:${s.name}` : `body:${s.freq}|${s.start_date}|${s.payload_json}`;
        const same = ruleByKey.get(key);
        if (same) { if (s.id) seriesIdMap.set(s.id, same); continue; }
        const info = db.prepare(`INSERT INTO series
          (user_id, target, freq, interval, byweekday, start_date, end_date, payload_json, name)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(
          uid, из(s.target, ЦЕЛИ_ПОВТОРА, 'schedule'), из(s.freq, ПОВТОРЫ, 'daily'),
          цел(s.interval, { min: 1, max: 365, по: 1 }),
          цел(s.byweekday, { min: 0, max: 127, по: 127 }),
          s.start_date || null, s.end_date || null,
          телоПовтора(s.payload_json), s.name ? стр(s.name, 200) : null);
        ruleByKey.set(key, info.lastInsertRowid);
        if (s.id) seriesIdMap.set(s.id, info.lastInsertRowid);
      }
      for (const o of data.seriesOverrides || []) {
        const sid = seriesIdMap.get(o.series_id);
        if (!sid || skip(o.date)) continue;
        db.prepare(`INSERT INTO series_overrides (user_id, series_id, date, action) VALUES (?,?,?,?)
                    ON CONFLICT(series_id, date) DO UPDATE SET action = excluded.action`)
          .run(uid, sid, o.date, из(o.action, ['deleted'], 'deleted'));
      }

      // старый id блока → новый: по нему приём пищи находит свой блок
      const rowIdMap = new Map();
      for (const r of data.scheduleItems || []) {
        if (skip(r.date)) continue;
        /*
         * Список сроков — главный, одиночное число выводится из него. Иначе
         * из чужого файла приезжала пара, в которой они расходятся, и
         * напоминание приходило не тогда, о чём просили.
         */
        const срокиСтроки = сроки(r.remind_before_json ?? r.remind_before_min);
        const info = db.prepare(`INSERT INTO schedule_items
          (user_id, date, start_min, end_min, title, note, done, sort_order, kind,
           alarm_mode, alarm_profile, remind_before_min, remind_before_json, color, series_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          uid, r.date,
          цел(r.start_min, { min: 0, max: 1439, по: 0 }),
          цел(r.end_min, { min: 0, max: 1439 }),
          стр(r.title, 200), стр(r.note, 1000),
          флаг(r.done), цел(r.sort_order, { min: 0, max: 100000, по: 0 }),
          из(r.kind, ВИДЫ, 'normal'),
          из(r.alarm_mode, БУДИЛЬНИК, 'none'), из(r.alarm_profile, ПРОФИЛИ, 'gentle'),
          первыйСрок(срокиСтроки), срокиСтроки,
          из(r.color, ЦВЕТА, null),
          seriesIdMap.get(r.series_id) ?? null);
        if (r.id) rowIdMap.set(r.id, info.lastInsertRowid);
      }
      for (const r of data.tasks || []) {
        if (skip(r.date)) continue;
        db.prepare(`INSERT INTO tasks (user_id, date, bucket, text, done, sort_order, carried_from)
                    VALUES (?,?,?,?,?,?,?)`)
          .run(uid, r.date, из(r.bucket, РАЗДЕЛЫ, 'work'), стр(r.text, 500), флаг(r.done),
               цел(r.sort_order, { min: 0, max: 100000, по: 0 }), r.carried_from || null);
      }
      for (const r of data.meals || []) {
        if (skip(r.date)) continue;
        db.prepare(`INSERT INTO meals (user_id, date, slot, time_min, end_min, title, note,
                                       calories, done, sort_order, remind_before_json, schedule_item_id)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(uid, r.date, из(r.slot, ПРИЁМЫ, 'other'),
               цел(r.time_min, { min: 0, max: 1439 }), цел(r.end_min, { min: 0, max: 1439 }),
               стр(r.title, 200), стр(r.note, 1000),
               цел(r.calories, { min: 0, max: 20000 }),
               флаг(r.done), цел(r.sort_order, { min: 0, max: 100000, по: 0 }),
               сроки(r.remind_before_json), rowIdMap.get(r.schedule_item_id) ?? null);
      }
      for (const r of data.sportSets || []) {
        if (skip(r.date)) continue;
        db.prepare(`INSERT INTO sport_sets (user_id, date, exercise, sets, reps, reps_max, weight, done, sort_order)
                    VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(uid, r.date, стр(r.exercise, 200),
               цел(r.sets, { min: 0, max: 1000 }), цел(r.reps, { min: 0, max: 10000 }),
               цел(r.reps_max, { min: 0, max: 10000 }),
               дробь(r.weight, { min: 0, max: 10000 }),
               флаг(r.done), цел(r.sort_order, { min: 0, max: 100000, по: 0 }));
      }

      /*
       * Привычки переносим с новыми id, логи привязываем по карте
       * старый→новый.
       *
       * В режиме «добавить» привычка с тем же названием считается той же
       * самой: иначе восстановление собственной выгрузки удваивало каждую
       * привычку, а её журнал уезжал в копию. Название — это то, чем
       * человек их и различает.
       */
      const byTitle = new Map();
      if (mode === 'merge') {
        for (const row of db.prepare('SELECT id, title FROM habits WHERE user_id = ?').all(uid)) {
          byTitle.set(String(row.title).trim().toLowerCase(), row.id);
        }
      }

      const habitIdMap = new Map();
      for (const h of data.habits || []) {
        const same = byTitle.get(String(h.title ?? '').trim().toLowerCase());
        if (same) { habitIdMap.set(h.id, same); continue; }

        const info = db.prepare(`INSERT INTO habits
          (user_id, title, description, emoji, color, type, target_per_day, unit, schedule_mask,
           times_per_week, polarity, mode, challenge_target_days, challenge_start_date, break_policy,
           allowed_skips_per_week, is_active, sort_order, archived_at, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          uid, стр(h.title, 200), стр(h.description, 1000), стр(h.emoji, 16),
          из(h.color, ЦВЕТА_ПРИВЫЧЕК, 'blue'),
          из(h.type, ВИДЫ_ПРИВЫЧЕК, 'binary'),
          цел(h.target_per_day, { min: 1, max: 100000 }), h.unit ? стр(h.unit, 40) : null,
          цел(h.schedule_mask, { min: 0, max: 127, по: 127 }),
          цел(h.times_per_week, { min: 0, max: 7 }),
          из(h.polarity, ПОЛЯРНОСТИ, 'do'), из(h.mode, РЕЖИМЫ, 'ongoing'),
          цел(h.challenge_target_days, { min: 1, max: 3650 }),
          h.challenge_start_date || null, из(h.break_policy, ПРИ_СРЫВЕ, 'reset'),
          цел(h.allowed_skips_per_week, { min: 0, max: 7, по: 0 }),
          флаг(h.is_active ?? 1), цел(h.sort_order, { min: 0, max: 100000, по: 0 }),
          h.archived_at || null,
          h.created_at || new Date().toISOString().slice(0, 19).replace('T', ' '));
        habitIdMap.set(h.id, info.lastInsertRowid);
        byTitle.set(String(h.title ?? '').trim().toLowerCase(), info.lastInsertRowid);
      }
      for (const l of data.habitLogs || []) {
        const newId = habitIdMap.get(l.habit_id);
        if (!newId) continue;
        db.prepare(`INSERT OR REPLACE INTO habit_logs (user_id, habit_id, date, status, value)
                    VALUES (?,?,?,?,?)`)
          .run(uid, newId, l.date, из(l.status, СТАТУСЫ, 'done'),
               цел(l.value, { min: 0, max: 1000000 }));
      }

      // Заметки без даты: в режиме «заменить всё» их тоже нужно заменить
      if (mode === 'replace') db.prepare('DELETE FROM free_notes WHERE user_id = ?').run(uid);
      for (const n of data.freeNotes || []) {
        db.prepare('INSERT INTO free_notes (user_id, title, text) VALUES (?,?,?)')
          .run(uid, стр(n.title, 200), стр(n.text, 100000));
      }
    });
    tx();

    res.json({ success: true, mode });
  }));

  return router;
};

module.exports.FORMAT_VERSION = FORMAT_VERSION;
