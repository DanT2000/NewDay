const express = require('express');
const { wrap, badRequest } = require('../../lib/errors');
const v = require('../../lib/validate');
const { pushRepo } = require('../../repos/push');
const { notificationService } = require('../../services/notificationService');

module.exports = function pushRouter({ db, push }) {
  const router = express.Router();
  const repo = pushRepo(db);
  const notify = notificationService(db, { push });

  /**
   * Публичный VAPID-ключ. Секрета не содержит, но роутер смонтирован
   * под общей аутентификацией /api/v1 — браузер запрашивает ключ уже
   * после входа, так что отдельный публичный маршрут не нужен.
   */
  router.get('/key', (_req, res) => {
    res.json({ enabled: push.enabled, publicKey: push.publicKey });
  });

  router.post('/subscribe', wrap((req, res) => {
    const sub = req.body?.subscription || req.body;
    const endpoint = v.str(sub?.endpoint, { max: 1000, field: 'endpoint' });
    const p256dh = v.str(sub?.keys?.p256dh ?? sub?.p256dh, { max: 300, field: 'p256dh' });
    const auth = v.str(sub?.keys?.auth ?? sub?.auth, { max: 300, field: 'auth' });
    if (!endpoint || !p256dh || !auth) throw badRequest('Неполные данные подписки');

    const saved = repo.saveSubscription(req.user.id, {
      endpoint, p256dh, auth, userAgent: req.get('user-agent'),
    });
    notify.planUpcoming(req.user);   // подписались — сразу планируем ближайшее
    res.status(201).json(saved);
  }));

  router.delete('/subscribe', wrap((req, res) => {
    repo.removeSubscription(req.user.id, v.str(req.body?.endpoint, { max: 1000, field: 'endpoint' }));
    res.status(204).end();
  }));

  router.get('/status', wrap((req, res) => {
    res.json({
      enabled: push.enabled,
      subscriptions: repo.listSubscriptions(req.user.id).map(s => ({
        id: s.id, userAgent: s.user_agent, createdAt: s.created_at,
      })),
      settings: notify.settingsOf(req.user),
      pending: repo.pending(req.user.id).map(r => ({
        key: r.dedupe_key, fireAt: r.fire_at_utc, payload: JSON.parse(r.payload_json),
      })),
    });
  }));

  /** Проверочное уведомление: приходит сразу, без очереди. */
  router.post('/test', wrap(async (req, res) => {
    const subs = repo.listSubscriptions(req.user.id);
    if (!subs.length) throw badRequest('Сначала разрешите уведомления в браузере');

    const results = [];
    for (const sub of subs) {
      const r = await push.send(sub, {
        kind: 'notify',
        title: 'NewDay',
        body: 'Проверка уведомлений — всё работает.',
        url: '/app.html',
      });
      if (r.gone) repo.removeSubscriptionById(sub.id);
      results.push(r.ok);
    }
    res.json({ success: results.some(Boolean), sent: results.filter(Boolean).length });
  }));

  /** Пересчитать план — пригодится после массовых правок и в диагностике. */
  router.post('/replan', wrap((req, res) => {
    res.json({ days: notify.planUpcoming(req.user) });
  }));

  return router;
};
