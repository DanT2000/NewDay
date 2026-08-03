const express = require('express');
const { wrap } = require('../../lib/errors');
const v = require('../../lib/validate');

/**
 * Роутер для «строк дня»: расписание, задачи, питание, спорт.
 * Монтируется как /api/v1/days/:date/<segment>.
 *
 * @param repoFor   (db) → репозиторий
 * @param sanitize  (body, { partial }) → объект полей для репозитория
 */
function entityRouter({ db, repoFor, sanitize, extra }) {
  const router = express.Router({ mergeParams: true });
  const repo = repoFor(db);

  const dateOf = req => v.date(req.params.date, { field: 'дата' });
  const idOf = req => v.int(req.params.id, { min: 1, field: 'id' });

  router.get('/', wrap((req, res) => {
    res.json(repo.list(req.user.id, dateOf(req)));
  }));

  router.post('/', wrap((req, res) => {
    const row = repo.create(req.user.id, dateOf(req), sanitize(req.body, { partial: false }));
    res.status(201).json(row);
  }));

  router.post('/reorder', wrap((req, res) => {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : [])
      .map(id => v.int(id, { min: 1, field: 'id' }));
    res.json(repo.reorder(req.user.id, dateOf(req), ids));
  }));

  if (extra) extra(router, repo, { dateOf, idOf });

  router.patch('/:id', wrap((req, res) => {
    const data = sanitize(req.body, { partial: true });
    if (req.body.updatedAt !== undefined) data.updatedAt = req.body.updatedAt;
    res.json(repo.update(req.user.id, idOf(req), data));
  }));

  router.delete('/:id', wrap((req, res) => {
    repo.remove(req.user.id, idOf(req));
    res.status(204).end();
  }));

  return router;
}

/** Пропускает только заданные ключи; в partial-режиме — только присутствующие. */
function pick(body, spec, partial) {
  const out = {};
  for (const [key, parse] of Object.entries(spec)) {
    if (partial && body[key] === undefined) continue;
    const value = parse(body[key], body);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

module.exports = { entityRouter, pick };
