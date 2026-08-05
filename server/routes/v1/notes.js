/**
 * Заметки.
 *
 * Их два вида, и вид определяется датой. Заметка с датой — это заметка дня:
 * она живёт полем дня, попадает в печать, в выгрузку и в сам день. Заметке
 * без даты («книги на осень») положить дату некуда, и для таких есть своя
 * таблица.
 *
 * Хранилище выбирается однозначно по наличию даты, поэтому одна и та же
 * заметка не может оказаться в двух местах. Отсюда и адресация: заметку дня
 * правят через день (`PATCH /days/:date`), заметку без даты — через этот
 * роутер по её номеру.
 *
 * Список отдаёт оба вида вместе: на вкладке «Заметки» человек не должен
 * знать, где что лежит.
 */

const express = require('express');
const { wrap, notFound, badRequest } = require('../../lib/errors');
const v = require('../../lib/validate');

/** Заголовок заметки дня — её первая строка; остальное текст. */
function split(raw) {
  const [first, ...rest] = String(raw ?? '').split('\n');
  return { title: first.trim(), text: rest.join('\n') };
}

module.exports = function notesRouter({ db }) {
  const router = express.Router();

  const own = (userId, id) => {
    const row = db.prepare('SELECT * FROM free_notes WHERE id = ? AND user_id = ?').get(id, userId);
    if (!row) throw notFound('Заметка не найдена');
    return row;
  };

  const shape = row => ({
    id: row.id, date: null, title: row.title, text: row.text, updated_at: row.updated_at,
  });

  router.get('/', wrap((req, res) => {
    // Пустые дни в список не идут: список из пустых заметок — не список
    const dated = db.prepare(
      `SELECT date, notes AS raw, updated_at
         FROM days
        WHERE user_id = ? AND notes IS NOT NULL AND TRIM(notes) <> ''
        ORDER BY date DESC`,
    ).all(req.user.id).map(r => ({
      id: r.date, date: r.date, ...split(r.raw), updated_at: r.updated_at,
    }));

    const free = db.prepare(
      'SELECT * FROM free_notes WHERE user_id = ? ORDER BY updated_at DESC, id DESC',
    ).all(req.user.id).map(shape);

    res.json([...dated, ...free]);
  }));

  router.post('/', wrap((req, res) => {
    const title = v.str(req.body.title, { max: 200, field: 'заголовок' });
    const text = v.str(req.body.text, { max: 20000, field: 'текст' });
    if (!title && !text) throw badRequest('Пустую заметку хранить незачем');
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO free_notes (user_id, title, text) VALUES (?,?,?)',
    ).run(req.user.id, title, text);
    res.status(201).json(shape(own(req.user.id, lastInsertRowid)));
  }));

  router.patch('/:id', wrap((req, res) => {
    const id = v.int(req.params.id, { min: 1, field: 'id' });
    const before = own(req.user.id, id);
    const title = req.body.title === undefined
      ? before.title : v.str(req.body.title, { max: 200, field: 'заголовок' });
    const text = req.body.text === undefined
      ? before.text : v.str(req.body.text, { max: 20000, field: 'текст' });
    db.prepare(
      "UPDATE free_notes SET title = ?, text = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
    ).run(title, text, id, req.user.id);
    res.json(shape(own(req.user.id, id)));
  }));

  router.delete('/:id', wrap((req, res) => {
    const id = v.int(req.params.id, { min: 1, field: 'id' });
    own(req.user.id, id);
    db.prepare('DELETE FROM free_notes WHERE id = ? AND user_id = ?').run(id, req.user.id);
    res.status(204).end();
  }));

  return router;
};
