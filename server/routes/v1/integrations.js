const express = require('express');
const { wrap } = require('../../lib/errors');
const { integrationService } = require('../../services/integrationService');

/**
 * Пути внешних интеграций.
 *
 * POST /apply — идемпотентное применение батча записей (см. integrationService:
 * там же вся семантика created / updated / unchanged / deleted / conflict).
 * DELETE /tombstones — явное снятие надгробия, когда человек передумал и
 * хочет вернуть удалённую запись интеграции.
 *
 * Авторизация обычная: Bearer-токен со scope write (глобальный requireWrite
 * стоит выше по цепочке /api/v1) либо сессия.
 */
module.exports = function integrationsRouter({ db, notify }) {
  const router = express.Router();
  const svc = integrationService(db);

  router.post('/apply', wrap((req, res) => {
    const out = svc.apply(req.user, req.body || {});
    /*
     * Расписание и питание — это ещё и уведомления: пересчитываем очередь
     * после настоящих изменений. Ошибка пересчёта не ломает сам ответ —
     * записи уже применены, а планировщик догонит своим тиком.
     */
    if (out.touchedNotify && notify) {
      try { notify.planUpcoming(req.user); }
      catch (e) { console.error('[newday] пересчёт уведомлений после apply не удался:', e.message); }
    }
    res.json({ dryRun: out.dryRun, results: out.results, counts: out.counts });
  }));

  router.delete('/tombstones', wrap((req, res) => {
    svc.clearTombstone(req.user.id, req.body || {});
    res.status(204).end();
  }));

  return router;
};
