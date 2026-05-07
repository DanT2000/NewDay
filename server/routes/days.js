const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../auth');
const { validateDate, validateJsonSize } = require('../validation');

function tryParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// ─── Task carry-over helpers ──────────────────────────────────

function normalizeText(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getCarrySource(userId, beforeDate) {
  const row = db.prepare(
    'SELECT date, data_json FROM days WHERE user_id = ? AND date < ? ORDER BY date DESC LIMIT 1'
  ).get(userId, beforeDate);
  if (!row) return null;
  const data = tryParse(row.data_json) || {};
  return { date: row.date, workTasks: data.workTasks || [] };
}

function mergeCarriedTasks(targetTasks, sourceDate, sourceTasks) {
  const target = Array.isArray(targetTasks) ? targetTasks : [];
  const existing = new Set(target.map(t => normalizeText(t.text)));

  const toAdd = sourceTasks
    .filter(t => !t.done)
    .filter(t => !existing.has(normalizeText(t.text)))
    .map(t => ({
      text: t.text,
      done: false,
      carriedFrom: t.carriedFrom || sourceDate,
    }));

  return [...target, ...toAdd];
}

// ─── Schedule normalization helpers ───────────────────────────

function parseTimePart(str) {
  str = str.trim();
  let m = str.match(/^(\d{1,2}):(\d{2})$/);
  if (m) { const h = +m[1], min = +m[2]; if (h <= 23 && min <= 59) return { ok: true, h, min }; }
  m = str.match(/^(\d{1,2})\.(\d{2})$/);
  if (m) { const h = +m[1], min = +m[2]; if (h <= 23 && min <= 59) return { ok: true, h, min }; }
  m = str.match(/^(\d{1,2})\s+(\d{2})$/);
  if (m) { const h = +m[1], min = +m[2]; if (h <= 23 && min <= 59) return { ok: true, h, min }; }
  m = str.match(/^(\d{1,2})$/);
  if (m) { const h = +m[1]; if (h <= 23) return { ok: true, h, min: 0 }; }
  return { ok: false };
}

function normalizeTimeRange(input) {
  if (!input || !input.trim()) return { ok: false, display: input || '', startMinutes: null };
  const s = input.trim();
  const parts = s.split(/\s*[–\-]\s*/);
  if (parts.length !== 2) return { ok: false, display: s, startMinutes: null };

  const startP = parseTimePart(parts[0]);
  if (!startP.ok) return { ok: false, display: s, startMinutes: null };
  const endP = parseTimePart(parts[1]);
  if (!endP.ok) return { ok: false, display: s, startMinutes: null };

  let endH = endP.h;
  const isSingle = parts[1].trim().length === 1;

  if (isSingle && endH <= startP.h) {
    if (endH === 0 && startP.h >= 20) {
      endH = 0;
    } else if (endH + 12 > startP.h && endH + 12 <= 23) {
      endH = endH + 12;
    }
  }

  const fmt = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return {
    ok: true,
    display: `${fmt(startP.h, startP.min)}–${fmt(endH, endP.min)}`,
    startMinutes: startP.h * 60 + startP.min,
  };
}

function sortSchedule(schedule) {
  if (!Array.isArray(schedule) || !schedule.length) return schedule || [];

  const parsed = schedule.map(row => {
    const norm = normalizeTimeRange(row.time);
    return {
      row: { ...row, time: norm.ok ? norm.display : row.time },
      startMinutes: norm.ok ? norm.startMinutes : null,
    };
  });

  const known   = parsed.filter(p => p.startMinutes !== null);
  const unknown = parsed.filter(p => p.startMinutes === null);
  known.sort((a, b) => a.startMinutes - b.startMinutes);

  return [...known, ...unknown].map(p => p.row);
}

function normalizeDay(data) {
  if (!data || typeof data !== 'object') return data;
  if (Array.isArray(data.schedule)) {
    data.schedule = sortSchedule(data.schedule);
  }
  return data;
}

// ─── Routes ───────────────────────────────────────────────────

// GET /api/days
router.get('/', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT date, data_json, updated_at FROM days WHERE user_id = ? ORDER BY date DESC')
    .all(req.session.userId);

  res.json(rows.map(r => {
    const d = tryParse(r.data_json) || {};
    return { date: r.date, updated_at: r.updated_at, title: d.title || '', weight: d.weight ?? null };
  }));
});

// POST /api/days/import — must be before /:date
router.post('/import', requireAuth, (req, res) => {
  const { data, overwrite, carryUnfinishedWorkTasks = true } = req.body;
  if (!data) return res.status(400).json({ error: 'Данные не переданы' });

  let dayData;
  try { dayData = typeof data === 'string' ? JSON.parse(data) : data; }
  catch { return res.status(400).json({ error: 'Неверный JSON' }); }

  if (!dayData.date || !/^\d{4}-\d{2}-\d{2}$/.test(dayData.date)) {
    return res.status(400).json({ error: 'Неверная или отсутствующая дата в JSON (YYYY-MM-DD)' });
  }

  // Carry over unfinished work tasks from previous day
  if (carryUnfinishedWorkTasks) {
    const prev = getCarrySource(req.session.userId, dayData.date);
    if (prev && prev.workTasks.length) {
      dayData.workTasks = mergeCarriedTasks(dayData.workTasks, prev.date, prev.workTasks);
    }
  }

  normalizeDay(dayData);

  const dataStr = JSON.stringify(dayData);
  const sizeErr = validateJsonSize(dataStr);
  if (sizeErr) return res.status(400).json({ error: sizeErr });

  const existing = db
    .prepare('SELECT id FROM days WHERE user_id = ? AND date = ?')
    .get(req.session.userId, dayData.date);

  if (existing && !overwrite) return res.json({ exists: true, date: dayData.date });

  if (existing) {
    db.prepare("UPDATE days SET data_json = ?, updated_at = datetime('now') WHERE user_id = ? AND date = ?")
      .run(dataStr, req.session.userId, dayData.date);
  } else {
    db.prepare('INSERT INTO days (user_id, date, data_json) VALUES (?, ?, ?)')
      .run(req.session.userId, dayData.date, dataStr);
  }

  res.json({ success: true, date: dayData.date });
});

// GET /api/days/:date
router.get('/:date', requireAuth, (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date))
    return res.status(400).json({ error: 'Неверный формат даты' });

  const row = db
    .prepare('SELECT date, data_json FROM days WHERE user_id = ? AND date = ?')
    .get(req.session.userId, req.params.date);

  if (!row) return res.status(404).json({ error: 'День не найден' });

  res.json({ date: row.date, ...(tryParse(row.data_json) || {}) });
});

// POST /api/days
router.post('/', requireAuth, (req, res) => {
  const { date, carryUnfinishedWorkTasks = true, ...rest } = req.body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Неверный формат даты (YYYY-MM-DD)' });

  const existing = db
    .prepare('SELECT id, data_json FROM days WHERE user_id = ? AND date = ?')
    .get(req.session.userId, date);

  let dayData = { date, ...rest };

  if (!existing) {
    // New day: carry over unfinished tasks
    if (carryUnfinishedWorkTasks) {
      const prev = getCarrySource(req.session.userId, date);
      if (prev && prev.workTasks.length) {
        dayData.workTasks = mergeCarriedTasks(dayData.workTasks, prev.date, prev.workTasks);
      }
    }
  }

  normalizeDay(dayData);

  const dataStr = JSON.stringify(dayData);
  const sizeErr = validateJsonSize(dataStr);
  if (sizeErr) return res.status(400).json({ error: sizeErr });

  if (existing) {
    db.prepare("UPDATE days SET data_json = ?, updated_at = datetime('now') WHERE user_id = ? AND date = ?")
      .run(dataStr, req.session.userId, date);
  } else {
    db.prepare('INSERT INTO days (user_id, date, data_json) VALUES (?, ?, ?)')
      .run(req.session.userId, date, dataStr);
  }

  res.json({ success: true, date });
});

// PUT /api/days/:date
router.put('/:date', requireAuth, (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date))
    return res.status(400).json({ error: 'Неверный формат даты' });

  const dayData = { date: req.params.date, ...req.body };
  normalizeDay(dayData);

  const dataStr = JSON.stringify(dayData);
  const sizeErr = validateJsonSize(dataStr);
  if (sizeErr) return res.status(400).json({ error: sizeErr });

  const existing = db
    .prepare('SELECT id FROM days WHERE user_id = ? AND date = ?')
    .get(req.session.userId, req.params.date);

  if (existing) {
    db.prepare("UPDATE days SET data_json = ?, updated_at = datetime('now') WHERE user_id = ? AND date = ?")
      .run(dataStr, req.session.userId, req.params.date);
  } else {
    db.prepare('INSERT INTO days (user_id, date, data_json) VALUES (?, ?, ?)')
      .run(req.session.userId, req.params.date, dataStr);
  }

  res.json({ success: true, date: req.params.date });
});

// DELETE /api/days/:date
router.delete('/:date', requireAuth, (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date))
    return res.status(400).json({ error: 'Неверный формат даты' });

  const result = db
    .prepare('DELETE FROM days WHERE user_id = ? AND date = ?')
    .run(req.session.userId, req.params.date);

  if (result.changes === 0) return res.status(404).json({ error: 'День не найден' });
  res.json({ success: true });
});

// GET /api/days/:date/export
router.get('/:date/export', requireAuth, (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date))
    return res.status(400).json({ error: 'Неверный формат даты' });

  const row = db
    .prepare('SELECT data_json FROM days WHERE user_id = ? AND date = ?')
    .get(req.session.userId, req.params.date);

  if (!row) return res.status(404).json({ error: 'День не найден' });

  const dayData = tryParse(row.data_json) || {};

  const habitLogs = db.prepare(`
    SELECT hl.habit_id, hl.done, h.title, h.emoji
    FROM habit_logs hl
    JOIN habits h ON h.id = hl.habit_id
    WHERE hl.user_id = ? AND hl.date = ?
  `).all(req.session.userId, req.params.date);

  dayData.habitLogs = habitLogs;

  res.setHeader('Content-Disposition', `attachment; filename="newday-${req.params.date}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(dayData, null, 2));
});

module.exports = router;
