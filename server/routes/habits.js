const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../auth');
const { validateDate } = require('../validation');

// ─── Helpers ─────────────────────────────────────────────────

function offsetDate(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function getDatesInRange(from, to) {
  const dates = [];
  let cur = from;
  while (cur <= to) {
    dates.push(cur);
    cur = offsetDate(cur, 1);
  }
  return dates;
}

/**
 * Calculate current streak and best streak for a habit.
 * logsMap: { [date]: true|false }
 * today: 'YYYY-MM-DD'
 * createdDate: 'YYYY-MM-DD'
 */
function calcStreaks(logsMap, today, createdDate) {
  // currentStreak: go backwards from today
  // - if today has no log (undefined/null), start from yesterday
  // - if today is false, streak = 0
  // - missing dates = break
  let currentStreak = 0;
  const todayVal = logsMap[today];

  if (todayVal === false) {
    currentStreak = 0;
  } else {
    // start from today if done, else from yesterday
    let checkDate = todayVal === true ? today : offsetDate(today, -1);
    let checking = true;
    while (checking) {
      if (checkDate < createdDate) break;
      const val = logsMap[checkDate];
      if (val === true) {
        currentStreak++;
        checkDate = offsetDate(checkDate, -1);
      } else {
        checking = false;
      }
    }
  }

  // bestStreak: scan all dates from createdDate to today
  let bestStreak = 0;
  let runStreak = 0;
  const allDates = getDatesInRange(createdDate, today);
  for (const d of allDates) {
    if (logsMap[d] === true) {
      runStreak++;
      if (runStreak > bestStreak) bestStreak = runStreak;
    } else {
      runStreak = 0;
    }
  }

  return { currentStreak, bestStreak };
}

// ─── GET /api/habits ─────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const habits = db
    .prepare('SELECT * FROM habits WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC')
    .all(req.session.userId);
  res.json(habits);
});

// ─── GET /api/habits/stats — must be before /:id ─────────────
router.get('/stats', requireAuth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const periodParam = req.query.period || '30';

  // Determine period window
  let periodFrom;
  if (periodParam === 'all') {
    // find earliest habit created_at
    const earliest = db.prepare(
      'SELECT MIN(date(created_at)) AS d FROM habits WHERE user_id = ?'
    ).get(req.session.userId);
    periodFrom = (earliest && earliest.d) ? earliest.d.split('T')[0] : offsetDate(today, -29);
  } else {
    const days = parseInt(periodParam, 10) || 30;
    periodFrom = offsetDate(today, -(days - 1));
  }

  const d7  = offsetDate(today, -6);
  const d30 = offsetDate(today, -29);

  const habits = db
    .prepare('SELECT * FROM habits WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC')
    .all(req.session.userId);

  const habitResults = habits.map(h => {
    const createdDate = h.created_at
      ? h.created_at.split('T')[0].split(' ')[0]
      : today;

    // Fetch all logs for this habit
    const allLogs = db.prepare(
      'SELECT date, done FROM habit_logs WHERE user_id = ? AND habit_id = ? ORDER BY date ASC'
    ).all(req.session.userId, h.id);

    const logsMap = {};
    for (const log of allLogs) {
      logsMap[log.date] = log.done === 1 || log.done === true;
    }

    // Streaks
    const { currentStreak, bestStreak } = calcStreaks(logsMap, today, createdDate);

    // Helper: percent over a date range respecting habit creation date
    function pctInRange(from, to) {
      const effectiveFrom = from > createdDate ? from : createdDate;
      if (effectiveFrom > to) return null;
      const dates = getDatesInRange(effectiveFrom, to);
      if (!dates.length) return null;
      const possible = dates.length;
      const done = dates.filter(d => logsMap[d] === true).length;
      return { percent: Math.round((done / possible) * 100), done, possible };
    }

    const r7   = pctInRange(d7, today);
    const r30  = pctInRange(d30, today);
    const rAll = pctInRange(createdDate, today);
    const rPeriod = pctInRange(periodFrom, today);

    // doneTotal and missedTotal across all time
    const allDates = getDatesInRange(createdDate, today);
    let doneTotal = 0;
    let missedTotal = 0;
    for (const d of allDates) {
      if (logsMap[d] === true) doneTotal++;
      else missedTotal++;
    }

    // last7 dots
    const last7 = getDatesInRange(d7, today).map(d => ({
      date: d,
      done: logsMap[d] === true,
    }));

    return {
      id: h.id,
      title: h.title,
      emoji: h.emoji || '',
      isActive: h.is_active === 1 || h.is_active === true,
      currentStreak,
      bestStreak,
      percent7:      r7     ? r7.percent     : null,
      percent30:     r30    ? r30.percent     : null,
      percentAll:    rAll   ? rAll.percent    : null,
      percentPeriod: rPeriod ? rPeriod.percent : null,
      doneTotal,
      missedTotal,
      last7,
    };
  });

  // Overall stats for active habits within period
  const activeHabits = habitResults.filter(h => h.isActive);
  let overallDoneCount = 0;
  let overallPossibleCount = 0;

  for (const h of activeHabits) {
    const habit = habits.find(hh => hh.id === h.id);
    const createdDate = habit && habit.created_at
      ? habit.created_at.split('T')[0].split(' ')[0]
      : today;
    const effectiveFrom = periodFrom > createdDate ? periodFrom : createdDate;
    if (effectiveFrom > today) continue;
    const dates = getDatesInRange(effectiveFrom, today);
    overallPossibleCount += dates.length;
    // Count done from habitStatsFull logs
    const allLogs = db.prepare(
      'SELECT date, done FROM habit_logs WHERE user_id = ? AND habit_id = ? AND date BETWEEN ? AND ?'
    ).all(req.session.userId, h.id, effectiveFrom, today);
    const doneInPeriod = allLogs.filter(l => l.done === 1 || l.done === true).length;
    overallDoneCount += doneInPeriod;
  }

  const overallPercent = overallPossibleCount > 0
    ? Math.round((overallDoneCount / overallPossibleCount) * 100)
    : 0;

  // Summary
  const activeWithPercent = activeHabits.filter(h => h.percent7 !== null);
  let bestHabit = null;
  let weakestHabit = null;
  if (activeWithPercent.length > 0) {
    const sorted = [...activeWithPercent].sort((a, b) => (b.percent7 ?? 0) - (a.percent7 ?? 0));
    bestHabit = { id: sorted[0].id, title: sorted[0].title, emoji: sorted[0].emoji, percent: sorted[0].percent7 };
    weakestHabit = { id: sorted[sorted.length - 1].id, title: sorted[sorted.length - 1].title, emoji: sorted[sorted.length - 1].emoji, percent: sorted[sorted.length - 1].percent7 };
    if (bestHabit.id === weakestHabit.id) weakestHabit = null;
  }
  const habitsAbove70 = activeWithPercent.filter(h => (h.percent7 ?? 0) >= 70).length;
  const habitsBelow40 = activeWithPercent.filter(h => (h.percent7 ?? 0) < 40).length;

  res.json({
    period: periodParam,
    from: periodFrom,
    to: today,
    overall: {
      percent: overallPercent,
      doneCount: overallDoneCount,
      possibleCount: overallPossibleCount,
      activeHabits: activeHabits.length,
    },
    habits: habitResults,
    summary: {
      bestHabit,
      weakestHabit,
      habitsAbove70,
      habitsBelow40,
    },
  });
});

// ─── GET /api/habits/logs/:date — must be before /:id ────────
router.get('/logs/:date', requireAuth, (req, res) => {
  const err = validateDate(req.params.date);
  if (err) return res.status(400).json({ error: err });

  const logs = db.prepare(`
    SELECT h.id, h.title, h.emoji, h.description, h.is_active, h.sort_order,
           COALESCE(hl.done, 0) AS done
    FROM habits h
    LEFT JOIN habit_logs hl
      ON hl.habit_id = h.id AND hl.date = ? AND hl.user_id = ?
    WHERE h.user_id = ? AND h.is_active = 1
    ORDER BY h.sort_order ASC, h.created_at ASC
  `).all(req.params.date, req.session.userId, req.session.userId);

  res.json(logs.map(l => ({ ...l, done: l.done === 1 })));
});

// ─── PUT /api/habits/logs/:date/:habitId ─────────────────────
router.put('/logs/:date/:habitId', requireAuth, (req, res) => {
  const err = validateDate(req.params.date);
  if (err) return res.status(400).json({ error: err });

  const habit = db
    .prepare('SELECT id FROM habits WHERE id = ? AND user_id = ?')
    .get(req.params.habitId, req.session.userId);
  if (!habit) return res.status(404).json({ error: 'Привычка не найдена' });

  const done = req.body.done ? 1 : 0;

  db.prepare(`
    INSERT INTO habit_logs (user_id, habit_id, date, done)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, habit_id, date) DO UPDATE SET done = excluded.done, updated_at = datetime('now')
  `).run(req.session.userId, req.params.habitId, req.params.date, done);

  res.json({ success: true, done: done === 1 });
});

// ─── POST /api/habits ─────────────────────────────────────────
router.post('/', requireAuth, (req, res) => {
  const { title, description = '', emoji = '' } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Название обязательно' });

  const maxRow = db
    .prepare('SELECT MAX(sort_order) AS m FROM habits WHERE user_id = ?')
    .get(req.session.userId);
  const sortOrder = (maxRow.m ?? -1) + 1;

  const result = db
    .prepare('INSERT INTO habits (user_id, title, description, emoji, is_active, sort_order) VALUES (?, ?, ?, ?, 1, ?)')
    .run(req.session.userId, title.trim(), description, emoji, sortOrder);

  const habit = db.prepare('SELECT * FROM habits WHERE id = ?').get(result.lastInsertRowid);
  res.json(habit);
});

// ─── PUT /api/habits/:id ──────────────────────────────────────
router.put('/:id', requireAuth, (req, res) => {
  const habit = db
    .prepare('SELECT id FROM habits WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!habit) return res.status(404).json({ error: 'Привычка не найдена' });

  const { title, description, emoji, is_active, sort_order } = req.body;
  const fields = [];
  const vals = [];

  if (title !== undefined)       { fields.push('title = ?');       vals.push(title.trim()); }
  if (description !== undefined) { fields.push('description = ?'); vals.push(description); }
  if (emoji !== undefined)       { fields.push('emoji = ?');       vals.push(emoji); }
  if (is_active !== undefined)   { fields.push('is_active = ?');   vals.push(is_active ? 1 : 0); }
  if (sort_order !== undefined)  { fields.push('sort_order = ?');  vals.push(sort_order); }

  if (!fields.length) return res.status(400).json({ error: 'Нечего обновлять' });

  fields.push("updated_at = datetime('now')");
  vals.push(req.params.id);

  db.prepare(`UPDATE habits SET ${fields.join(', ')} WHERE id = ?`).run(...vals);

  const updated = db.prepare('SELECT * FROM habits WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// ─── DELETE /api/habits/:id ───────────────────────────────────
router.delete('/:id', requireAuth, (req, res) => {
  const habit = db
    .prepare('SELECT id FROM habits WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!habit) return res.status(404).json({ error: 'Привычка не найдена' });

  db.prepare('DELETE FROM habits WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
