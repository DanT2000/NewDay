const express = require('express');
const { wrap, badRequest } = require('../../lib/errors');
const v = require('../../lib/validate');
const { publicUser, usersRepo } = require('../../repos/users');
const { buildIcs } = require('../../lib/ical');
const { todayFor, addDays } = require('../../lib/dates');

const FORMAT_VERSION = 1;

const DAY_TABLES = ['schedule_items', 'tasks', 'meals', 'sport_sets'];

module.exports = function exportRouter({ db }) {
  const router = express.Router();
  const users = usersRepo(db);

  const dump = userId => {
    const q = sql => db.prepare(sql).all(userId);
    return {
      formatVersion: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      user: publicUser(users.findById(userId), users.getSettings(userId)),
      days: q('SELECT date, title, focus, weight, notes FROM days WHERE user_id = ? ORDER BY date'),
      /*
       * Поля перечислены по одному, а не звёздочкой: так видно, что уходит
       * человеку. Обратная сторона — новую колонку легко забыть, и однажды
       * это уже случилось: цвет, список сроков, окно приёма пищи и свободный
       * график привычки в выгрузку не попадали, а «заменить всё» их стирало.
       */
      scheduleItems: q(`SELECT id, date, start_min, end_min, title, note, done, sort_order, kind,
                               alarm_mode, alarm_profile, remind_before_min, remind_before_json, color
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
      sportSets: q('SELECT date, exercise, sets, reps, weight, done, sort_order FROM sport_sets WHERE user_id = ? ORDER BY date'),
      habits: q(`SELECT id, title, description, emoji, color, type, target_per_day, unit,
                        schedule_mask, times_per_week, polarity, mode, challenge_target_days,
                        challenge_start_date, break_policy, allowed_skips_per_week, is_active,
                        sort_order, archived_at, created_at
                   FROM habits WHERE user_id = ? ORDER BY sort_order`),
      habitLogs: q('SELECT habit_id, date, status, value FROM habit_logs WHERE user_id = ? ORDER BY date'),
      series: q('SELECT id, target, freq, interval, byweekday, start_date, end_date, payload_json, name FROM series WHERE user_id = ?'),
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
    // Окно приёма пищи — это тоже отрезок: без end_min обед 12:00–14:00
    // уезжал в календарь получасовой точкой
    const meals = db.prepare(
      `SELECT date, time_min, end_min, title, note, done, sort_order
         FROM meals WHERE user_id = ? AND date BETWEEN ? AND ? AND time_min IS NOT NULL
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

    const tx = db.transaction(() => {
      if (mode === 'replace') {
        for (const t of [...DAY_TABLES, 'habit_logs', 'habits', 'series_overrides', 'series', 'days']) {
          db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(uid);
        }
      }

      const existingDates = new Set(
        db.prepare('SELECT date FROM days WHERE user_id = ?').all(uid).map(r => r.date)
      );

      for (const d of data.days || []) {
        if (mode === 'merge' && existingDates.has(d.date)) continue;
        db.prepare(`INSERT OR REPLACE INTO days (user_id, date, title, focus, weight, notes)
                    VALUES (?,?,?,?,?,?)`)
          .run(uid, d.date, d.title ?? '', d.focus ?? '', d.weight ?? null, d.notes ?? '');
      }

      const skip = date => mode === 'merge' && existingDates.has(date);

      // старый id блока → новый: по нему приём пищи находит свой блок
      const rowIdMap = new Map();
      for (const r of data.scheduleItems || []) {
        if (skip(r.date)) continue;
        const info = db.prepare(`INSERT INTO schedule_items
          (user_id, date, start_min, end_min, title, note, done, sort_order, kind,
           alarm_mode, alarm_profile, remind_before_min, remind_before_json, color)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          uid, r.date, r.start_min ?? 0, r.end_min ?? null, r.title ?? '', r.note ?? '',
          r.done ?? 0, r.sort_order ?? 0, r.kind ?? 'normal',
          r.alarm_mode ?? 'none', r.alarm_profile ?? 'gentle', r.remind_before_min ?? null,
          r.remind_before_json ?? null, r.color ?? null);
        if (r.id) rowIdMap.set(r.id, info.lastInsertRowid);
      }
      for (const r of data.tasks || []) {
        if (skip(r.date)) continue;
        db.prepare(`INSERT INTO tasks (user_id, date, bucket, text, done, sort_order, carried_from)
                    VALUES (?,?,?,?,?,?,?)`)
          .run(uid, r.date, r.bucket ?? 'work', r.text ?? '', r.done ?? 0, r.sort_order ?? 0, r.carried_from ?? null);
      }
      for (const r of data.meals || []) {
        if (skip(r.date)) continue;
        db.prepare(`INSERT INTO meals (user_id, date, slot, time_min, end_min, title, note,
                                       calories, done, sort_order, remind_before_json, schedule_item_id)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(uid, r.date, r.slot ?? 'other', r.time_min ?? null, r.end_min ?? null,
               r.title ?? '', r.note ?? '', r.calories ?? null, r.done ?? 0, r.sort_order ?? 0,
               r.remind_before_json ?? null, rowIdMap.get(r.schedule_item_id) ?? null);
      }
      for (const r of data.sportSets || []) {
        if (skip(r.date)) continue;
        db.prepare(`INSERT INTO sport_sets (user_id, date, exercise, sets, reps, weight, done, sort_order)
                    VALUES (?,?,?,?,?,?,?,?)`)
          .run(uid, r.date, r.exercise ?? '', r.sets ?? null, r.reps ?? null, r.weight ?? null, r.done ?? 0, r.sort_order ?? 0);
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
          uid, h.title ?? '', h.description ?? '', h.emoji ?? '', h.color ?? 'blue',
          h.type ?? 'binary', h.target_per_day ?? null, h.unit ?? null, h.schedule_mask ?? 127,
          h.times_per_week ?? null,
          h.polarity ?? 'do', h.mode ?? 'ongoing', h.challenge_target_days ?? null,
          h.challenge_start_date ?? null, h.break_policy ?? 'reset',
          h.allowed_skips_per_week ?? 0, h.is_active ?? 1, h.sort_order ?? 0,
          h.archived_at ?? null, h.created_at ?? new Date().toISOString().slice(0, 19).replace('T', ' '));
        habitIdMap.set(h.id, info.lastInsertRowid);
        byTitle.set(String(h.title ?? '').trim().toLowerCase(), info.lastInsertRowid);
      }
      for (const l of data.habitLogs || []) {
        const newId = habitIdMap.get(l.habit_id);
        if (!newId) continue;
        db.prepare(`INSERT OR REPLACE INTO habit_logs (user_id, habit_id, date, status, value)
                    VALUES (?,?,?,?,?)`)
          .run(uid, newId, l.date, l.status ?? 'done', l.value ?? null);
      }

      /*
       * Повторы и шаблоны.
       *
       * Раньше «заменить всё» их удаляло, а обратно не кладло: восстановление
       * собственной выгрузки молча стирало и повторяющиеся напоминания, и
       * общее расписание — то есть ровно то, ради чего копию и делают.
       *
       * В режиме «добавить» правило с тем же именем считается тем же самым:
       * иначе своя же выгрузка удваивала бы шаблон. Безымянные повторы
       * сравниваем по содержимому — у них имени нет.
       */
      const sameRule = new Set();
      if (mode === 'merge') {
        for (const row of db.prepare('SELECT name, freq, start_date, payload_json FROM series WHERE user_id = ?').all(uid)) {
          sameRule.add(row.name ? `name:${row.name}` : `body:${row.freq}|${row.start_date}|${row.payload_json}`);
        }
      }
      for (const s of data.series || []) {
        const key = s.name ? `name:${s.name}` : `body:${s.freq}|${s.start_date}|${s.payload_json}`;
        if (sameRule.has(key)) continue;
        sameRule.add(key);
        db.prepare(`INSERT INTO series
          (user_id, target, freq, interval, byweekday, start_date, end_date, payload_json, name)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(
          uid, s.target ?? 'schedule', s.freq ?? 'daily', s.interval ?? 1,
          s.byweekday ?? 127, s.start_date ?? null, s.end_date ?? null,
          s.payload_json ?? '{}', s.name ?? null);
      }

      // Заметки без даты: в режиме «заменить всё» их тоже нужно заменить
      if (mode === 'replace') db.prepare('DELETE FROM free_notes WHERE user_id = ?').run(uid);
      for (const n of data.freeNotes || []) {
        db.prepare('INSERT INTO free_notes (user_id, title, text) VALUES (?,?,?)')
          .run(uid, n.title ?? '', n.text ?? '');
      }
    });
    tx();

    res.json({ success: true, mode });
  }));

  return router;
};

module.exports.FORMAT_VERSION = FORMAT_VERSION;
