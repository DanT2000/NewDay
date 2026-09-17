const express = require('express');
const { wrap, badRequest } = require('../../lib/errors');
const v = require('../../lib/validate');
const { diffDays } = require('../../lib/dates');
const { statsService } = require('../../services/statsService');

module.exports = function statsRouter({ db }) {
  const router = express.Router();
  const stats = statsService(db);

  /*
   * Ширину периода ограничиваем.
   *
   * `overview` идёт по каждому дню и на каждом считает привычки: 366 дней
   * на десяти привычках — это двадцать семь секунд синхронной работы, то
   * есть сервер стоит целиком для всех. Двести лет одним запросом
   * укладывали его насмерть. Год покрывает все экраны (неделя, месяц,
   * «за 90 дней»), а просьбу шире честно отклоняем.
   */
  const MAX_DAYS = 400;

  router.get('/', wrap((req, res) => {
    const from = req.query.from ? v.date(req.query.from, { field: 'from' }) : null;
    const to = req.query.to ? v.date(req.query.to, { field: 'to' }) : null;
    if (from && to && diffDays(from, to) + 1 > MAX_DAYS) {
      throw badRequest(`Период длиннее ${MAX_DAYS} дней; запросите его частями`);
    }
    res.json(stats.overview(req.user, from, to));
  }));

  return router;
};
