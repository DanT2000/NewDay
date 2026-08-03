const express = require('express');
const { wrap } = require('../../lib/errors');
const v = require('../../lib/validate');
const { statsService } = require('../../services/statsService');

module.exports = function statsRouter({ db }) {
  const router = express.Router();
  const stats = statsService(db);

  router.get('/', wrap((req, res) => {
    const from = req.query.from ? v.date(req.query.from, { field: 'from' }) : null;
    const to = req.query.to ? v.date(req.query.to, { field: 'to' }) : null;
    res.json(stats.overview(req.user, from, to));
  }));

  return router;
};
