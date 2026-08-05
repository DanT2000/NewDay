/**
 * Заметки.
 *
 * Пока заметка — это поле дня: одна заметка на дату. В макете заметки
 * отдельная сущность, у которой может не быть даты вовсе, и это следующий
 * этап переноса. Здесь ровно тот минимум, который делает вкладку «Заметки»
 * настоящей: список того, что уже написано, без выдумывания данных.
 *
 * Возвращаем только непустые: список из пустых дней — не список.
 */

const express = require('express');
const { wrap } = require('../../lib/errors');

module.exports = function notesRouter({ db }) {
  const router = express.Router();

  router.get('/', wrap((req, res) => {
    const rows = db.prepare(
      `SELECT date, notes AS text, updated_at
         FROM days
        WHERE user_id = ? AND notes IS NOT NULL AND TRIM(notes) <> ''
        ORDER BY date DESC`,
    ).all(req.user.id);
    res.json(rows);
  }));

  return router;
};
