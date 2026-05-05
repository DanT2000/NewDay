const express = require('express');
const { db } = require('../db');
const { validateDayData } = require('../validation');

const router = express.Router();

// GET /api/days
router.get('/', (req, res) => {
  try {
    const rows = db.prepare('SELECT date, data FROM days WHERE user_id = ? ORDER BY date DESC').all(req.session.userId);

    const days = rows.map(row => {
      const data = JSON.parse(row.data);
      return {
        date: row.date,
        weekday: data.weekday || '',
        title: data.title || '',
        weight: data.weight != null ? data.weight : null,
      };
    });

    res.json(days);
  } catch (err) {
    console.error('Get days error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/days/import  — must be before /:date
router.post('/import', (req, res) => {
  try {
    const data = req.body;
    const error = validateDayData(data);
    if (error) return res.status(400).json({ error });

    db.prepare(`
      INSERT INTO days (user_id, date, data) VALUES (?, ?, ?)
      ON CONFLICT (user_id, date) DO UPDATE SET data = excluded.data, updated_at = datetime('now')
    `).run(req.session.userId, data.date, JSON.stringify(data));

    res.json({ success: true, date: data.date });
  } catch (err) {
    console.error('Import day error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /api/days/:date
router.get('/:date', (req, res) => {
  try {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Неверный формат даты (ожидается YYYY-MM-DD)' });
    }

    const row = db.prepare('SELECT data FROM days WHERE user_id = ? AND date = ?').get(req.session.userId, date);
    if (!row) return res.status(404).json({ error: 'День не найден' });

    res.json(JSON.parse(row.data));
  } catch (err) {
    console.error('Get day error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/days
router.post('/', (req, res) => {
  try {
    const data = req.body;
    const error = validateDayData(data);
    if (error) return res.status(400).json({ error });

    db.prepare('INSERT INTO days (user_id, date, data) VALUES (?, ?, ?)').run(
      req.session.userId, data.date, JSON.stringify(data)
    );

    res.status(201).json({ success: true, date: data.date });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'День с такой датой уже существует' });
    }
    console.error('Create day error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PUT /api/days/:date
router.put('/:date', (req, res) => {
  try {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Неверный формат даты' });
    }

    const data = req.body;
    const error = validateDayData(data);
    if (error) return res.status(400).json({ error });

    const info = db.prepare(
      "UPDATE days SET data = ?, updated_at = datetime('now') WHERE user_id = ? AND date = ?"
    ).run(JSON.stringify(data), req.session.userId, date);

    if (info.changes === 0) return res.status(404).json({ error: 'День не найден' });

    res.json({ success: true });
  } catch (err) {
    console.error('Update day error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /api/days/:date
router.delete('/:date', (req, res) => {
  try {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Неверный формат даты' });
    }

    const info = db.prepare('DELETE FROM days WHERE user_id = ? AND date = ?').run(req.session.userId, date);
    if (info.changes === 0) return res.status(404).json({ error: 'День не найден' });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete day error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /api/days/:date/export
router.get('/:date/export', (req, res) => {
  try {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Неверный формат даты' });
    }

    const row = db.prepare('SELECT data FROM days WHERE user_id = ? AND date = ?').get(req.session.userId, date);
    if (!row) return res.status(404).json({ error: 'День не найден' });

    const json = JSON.stringify(JSON.parse(row.data), null, 2);
    res.setHeader('Content-Disposition', `attachment; filename="day-${date}.json"`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(json);
  } catch (err) {
    console.error('Export day error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
