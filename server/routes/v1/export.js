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
      scheduleItems: q(`SELECT date, start_min, end_min, title, note, done, sort_order, kind,
                               alarm_mode, alarm_profile, remind_before_min
                          FROM schedule_items WHERE user_id = ? ORDER BY date, start_min`),
      tasks: q('SELECT date, bucket, text, done, sort_order, carried_from FROM tasks WHERE user_id = ? ORDER BY date'),
      meals: q('SELECT date, slot, time_min, title, note, calories, done, sort_order FROM meals WHERE user_id = ? ORDER BY date'),
      sportSets: q('SELECT date, exercise, sets, reps, weight, done, sort_order FROM sport_sets WHERE user_id = ? ORDER BY date'),
      habits: q(`SELECT id, title, description, emoji, color, type, target_per_day, unit,
                        schedule_mask, polarity, mode, challenge_target_days, challenge_start_date,
                        break_policy, allowed_skips_per_week, is_active, sort_order, archived_at, created_at
                   FROM habits WHERE user_id = ? ORDER BY sort_order`),
      habitLogs: q('SELECT habit_id, date, status, value FROM habit_logs WHERE user_id = ? ORDER BY date'),
      series: q('SELECT id, target, freq, interval, byweekday, start_date, end_date, payload_json, name FROM series WHERE user_id = ?'),
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
    const meals = db.prepare(
      `SELECT date, time_min, title, note, done, sort_order
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
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!data || typeof data !== 'object') throw badRequest('Не переданы данные для импорта');
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

      for (const r of data.scheduleItems || []) {
        if (skip(r.date)) continue;
        db.prepare(`INSERT INTO schedule_items
          (user_id, date, start_min, end_min, title, note, done, sort_order, kind,
           alarm_mode, alarm_profile, remind_before_min)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          uid, r.date, r.start_min ?? 0, r.end_min ?? null, r.title ?? '', r.note ?? '',
          r.done ?? 0, r.sort_order ?? 0, r.kind ?? 'normal',
          r.alarm_mode ?? 'none', r.alarm_profile ?? 'gentle', r.remind_before_min ?? null);
      }
      for (const r of data.tasks || []) {
        if (skip(r.date)) continue;
        db.prepare(`INSERT INTO tasks (user_id, date, bucket, text, done, sort_order, carried_from)
                    VALUES (?,?,?,?,?,?,?)`)
          .run(uid, r.date, r.bucket ?? 'work', r.text ?? '', r.done ?? 0, r.sort_order ?? 0, r.carried_from ?? null);
      }
      for (const r of data.meals || []) {
        if (skip(r.date)) continue;
        db.prepare(`INSERT INTO meals (user_id, date, slot, time_min, title, note, calories, done, sort_order)
                    VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(uid, r.date, r.slot ?? 'other', r.time_min ?? null, r.title ?? '', r.note ?? '',
               r.calories ?? null, r.done ?? 0, r.sort_order ?? 0);
      }
      for (const r of data.sportSets || []) {
        if (skip(r.date)) continue;
        db.prepare(`INSERT INTO sport_sets (user_id, date, exercise, sets, reps, weight, done, sort_order)
                    VALUES (?,?,?,?,?,?,?,?)`)
          .run(uid, r.date, r.exercise ?? '', r.sets ?? null, r.reps ?? null, r.weight ?? null, r.done ?? 0, r.sort_order ?? 0);
      }

      // Привычки переносим с новыми id, логи привязываем по карте старый→новый.
      const habitIdMap = new Map();
      for (const h of data.habits || []) {
        const info = db.prepare(`INSERT INTO habits
          (user_id, title, description, emoji, color, type, target_per_day, unit, schedule_mask,
           polarity, mode, challenge_target_days, challenge_start_date, break_policy,
           allowed_skips_per_week, is_active, sort_order, archived_at, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          uid, h.title ?? '', h.description ?? '', h.emoji ?? '', h.color ?? 'blue',
          h.type ?? 'binary', h.target_per_day ?? null, h.unit ?? null, h.schedule_mask ?? 127,
          h.polarity ?? 'do', h.mode ?? 'ongoing', h.challenge_target_days ?? null,
          h.challenge_start_date ?? null, h.break_policy ?? 'reset',
          h.allowed_skips_per_week ?? 0, h.is_active ?? 1, h.sort_order ?? 0,
          h.archived_at ?? null, h.created_at ?? new Date().toISOString().slice(0, 19).replace('T', ' '));
        habitIdMap.set(h.id, info.lastInsertRowid);
      }
      for (const l of data.habitLogs || []) {
        const newId = habitIdMap.get(l.habit_id);
        if (!newId) continue;
        db.prepare(`INSERT OR REPLACE INTO habit_logs (user_id, habit_id, date, status, value)
                    VALUES (?,?,?,?,?)`)
          .run(uid, newId, l.date, l.status ?? 'done', l.value ?? null);
      }
    });
    tx();

    res.json({ success: true, mode });
  }));

  return router;
};

module.exports.FORMAT_VERSION = FORMAT_VERSION;
