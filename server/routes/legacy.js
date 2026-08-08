const express = require('express');
const { wrap, notFound } = require('../lib/errors');
const v = require('../lib/validate');
const { formatMinutes, parseTimeRange } = require('../lib/dates');
const { daysRepo } = require('../repos/days');
const { scheduleRepo } = require('../repos/schedule');
const { tasksRepo } = require('../repos/tasks');
const { sportRepo } = require('../repos/sport');
const { habitsRepo } = require('../repos/habits');
const { dayService } = require('../services/dayService');
const { statsService } = require('../services/statsService');

/**
 * Совместимость со старым фронтендом (public/app.js), пока он не переписан на этапе 2.
 * Пути и форма ответов — как раньше, но поверх новой нормализованной схемы.
 *
 * Единственное сознательное расхождение: PUT /api/days/:date больше не стирает
 * секции, которых нет в теле запроса. Старое поведение и было багом — обрыв связи
 * приводил к отправке {date} и уничтожал день целиком.
 */
module.exports = function legacyRouter({ db, auth, requireWrite }) {
  const router = express.Router();
  /*
   * Пишущим маршрутам нужен не только вход, но и scope=write.
   *
   * requireAuth здесь стоит на каждом маршруте по отдельности, поэтому
   * проверку прав нельзя повесить на роутер целиком — она сработала бы
   * раньше, чем появится req.auth. Отсюда пара «вход + права» на каждую
   * запись: без неё токен «только чтение» переписывал день через /api/days.
   *
   * Падаем сразу, если проверку не передали. Мягкое «нет так нет» вернуло бы
   * ту же дыру молча — а найти её потом можно только чужим токеном.
   */
  if (!requireWrite) throw new Error('legacyRouter: нужен requireWrite, иначе запись открыта токену «только чтение»');
  const write = [auth.requireAuth, requireWrite];
  const days = daysRepo(db);
  const schedule = scheduleRepo(db);
  const tasks = tasksRepo(db);
  const sport = sportRepo(db);
  const habits = habitsRepo(db);
  const svc = dayService(db);
  const stats = statsService(db);

  const timeOf = r => r.end_min === null
    ? formatMinutes(r.start_min)
    : `${formatMinutes(r.start_min)}–${formatMinutes(r.end_min)}`;

  function legacyDay(user, date) {
    const full = svc.getFull(user, date);
    return {
      date,
      title: full.title,
      focus: full.focus,
      weight: full.weight,
      notes: full.notes,
      schedule: full.schedule.map(r => ({ time: timeOf(r), action: r.title, done: r.done === 1 })),
      workTasks: full.tasks.work.map(t => ({ text: t.text, done: t.done === 1, carriedFrom: t.carried_from || undefined })),
      homeTasks: full.tasks.home.map(t => ({ text: t.text, done: t.done === 1 })),
      sport: full.sport.map(x => ({ exercise: x.exercise, sets: x.sets, reps: x.reps, done: x.done === 1 })),
    };
  }

  /** Заменяет только те секции, которые реально пришли в теле. */
  function writeSections(user, date, body) {
    const tx = db.transaction(() => {
      days.ensure(user.id, date);
      const fields = {};
      for (const k of ['title', 'focus', 'notes']) {
        if (body[k] !== undefined) fields[k] = String(body[k] ?? '');
      }
      if (body.weight !== undefined) {
        fields.weight = body.weight === null || body.weight === '' ? null : Number(body.weight);
      }
      if (Object.keys(fields).length) days.patch(user.id, date, fields);

      if (Array.isArray(body.schedule)) {
        schedule.removeAllForDate(user.id, date);
        body.schedule.forEach((s, i) => {
          const r = parseTimeRange(String(s.time ?? ''));
          schedule.create(user.id, date, {
            startMin: r ? r.startMin : 0,
            endMin: r ? r.endMin : null,
            title: String(s.action ?? s.title ?? ''),
            done: s.done ? 1 : 0,
            sortOrder: i,
          });
        });
      }
      for (const [field, bucket] of [['workTasks', 'work'], ['homeTasks', 'home']]) {
        if (!Array.isArray(body[field])) continue;
        for (const row of tasks.list(user.id, date).filter(t => t.bucket === bucket)) {
          tasks.remove(user.id, row.id);
        }
        body[field].forEach((t, i) => tasks.create(user.id, date, {
          bucket, text: String(t.text ?? ''), done: t.done ? 1 : 0,
          sortOrder: i, carriedFrom: t.carriedFrom ?? null,
        }));
      }
      if (Array.isArray(body.sport)) {
        sport.removeAllForDate(user.id, date);
        body.sport.forEach((x, i) => sport.create(user.id, date, {
          exercise: String(x.exercise ?? ''),
          sets: Number.isFinite(Number(x.sets)) && x.sets !== '' ? Number(x.sets) : null,
          reps: Number.isFinite(Number(x.reps)) && x.reps !== '' ? Number(x.reps) : null,
          done: x.done ? 1 : 0, sortOrder: i,
        }));
      }
    });
    tx();
  }

  // ── дни ───────────────────────────────────────────────────────────
  router.get('/days', auth.requireAuth, wrap((req, res) => {
    res.json(days.list(req.user.id, null, null).map(d => ({
      date: d.date, updated_at: d.updated_at, title: d.title || '', weight: d.weight ?? null,
    })));
  }));

  router.post('/days', write, wrap((req, res) => {
    const { date, ...rest } = req.body || {};
    writeSections(req.user, v.date(date, { field: 'дата' }), rest);
    res.json({ success: true, date });
  }));

  router.get('/days/:date/export', auth.requireAuth, wrap((req, res) => {
    const date = v.date(req.params.date, { field: 'дата' });
    if (!days.get(req.user.id, date)) throw notFound('День не найден');
    const payload = legacyDay(req.user, date);
    payload.habitLogs = habits.logsForDate(req.user.id, date);
    res.setHeader('Content-Disposition', `attachment; filename="newday-${date}.json"`);
    res.json(payload);
  }));

  router.get('/days/:date', auth.requireAuth, wrap((req, res) => {
    const date = v.date(req.params.date, { field: 'дата' });
    if (!days.get(req.user.id, date)) throw notFound('День не найден');
    res.json(legacyDay(req.user, date));
  }));

  router.put('/days/:date', write, wrap((req, res) => {
    const date = v.date(req.params.date, { field: 'дата' });
    writeSections(req.user, date, req.body || {});
    res.json({ success: true, date });
  }));

  router.delete('/days/:date', write, wrap((req, res) => {
    days.remove(req.user.id, v.date(req.params.date, { field: 'дата' }));
    res.json({ success: true });
  }));

  // ── привычки ──────────────────────────────────────────────────────
  router.get('/habits', auth.requireAuth, wrap((req, res) => {
    res.json(habits.list(req.user.id));
  }));

  router.post('/habits', write, wrap((req, res) => {
    res.json(habits.create(req.user.id, {
      title: v.str(req.body.title, { max: 120, field: 'название' }),
      description: v.str(req.body.description, { max: 500, field: 'описание' }),
      emoji: v.str(req.body.emoji, { max: 16, field: 'эмодзи' }),
    }));
  }));

  router.get('/habits/stats', auth.requireAuth, wrap((req, res) => {
    const o = stats.overview(req.user, null, null);
    res.json({
      period: req.query.period || '30',
      from: o.from, to: o.to,
      overall: {
        percent: o.summary.bestHabit ? Math.round(
          o.habits.reduce((s, h) => s + (h.percent ?? 0), 0) / Math.max(o.habits.length, 1)
        ) : 0,
        activeHabits: o.habits.length,
      },
      habits: o.habits.map(h => ({
        id: h.id, title: h.title, emoji: h.emoji, isActive: true,
        currentStreak: h.currentStreak, bestStreak: h.bestStreak,
        percent7: h.percent, percent30: h.percent, percentAll: h.percent, percentPeriod: h.percent,
        doneTotal: h.done, missedTotal: h.missed,
        last7: h.last14.slice(-7).map(x => ({ date: x.date, done: x.status === 'done' })),
      })),
      summary: o.summary,
    });
  }));

  router.get('/habits/logs/:date', auth.requireAuth, wrap((req, res) => {
    const date = v.date(req.params.date, { field: 'дата' });
    res.json(stats.habitsForDate(req.user, date).map(h => ({
      id: h.id, title: h.title, emoji: h.emoji, description: '',
      is_active: h.activeToday ? 1 : 0, done: h.status === 'done',
    })));
  }));

  router.put('/habits/logs/:date/:habitId', write, wrap((req, res) => {
    const date = v.date(req.params.date, { field: 'дата' });
    const id = v.int(req.params.habitId, { min: 1, field: 'id' });
    habits.setLog(req.user.id, id, date, { status: req.body.done ? 'done' : 'missed' });
    res.json({ success: true, done: Boolean(req.body.done) });
  }));

  router.put('/habits/:id', write, wrap((req, res) => {
    const data = {};
    if (req.body.title !== undefined) data.title = v.str(req.body.title, { max: 120, field: 'название' });
    if (req.body.description !== undefined) data.description = v.str(req.body.description, { max: 500, field: 'описание' });
    if (req.body.emoji !== undefined) data.emoji = v.str(req.body.emoji, { max: 16, field: 'эмодзи' });
    if (req.body.is_active !== undefined) data.isActive = req.body.is_active ? 1 : 0;
    if (req.body.sort_order !== undefined) data.sortOrder = Number(req.body.sort_order);
    res.json(habits.update(req.user.id, v.int(req.params.id, { min: 1, field: 'id' }), data));
  }));

  router.delete('/habits/:id', write, wrap((req, res) => {
    habits.archive(req.user.id, v.int(req.params.id, { min: 1, field: 'id' }));
    res.json({ success: true });
  }));

  return router;
};
