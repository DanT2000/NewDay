const express = require('express');
const net = require('node:net');
const { wrap, badRequest } = require('../../lib/errors');
const v = require('../../lib/validate');
const { pushRepo } = require('../../repos/push');
const { notificationService } = require('../../services/notificationService');


/*
 * Адрес подписки — это адрес, по которому сервер будет сам ходить.
 *
 * Проверялись только тип и длина, а дальше web-push отправлял запрос куда
 * скажут. Так сервер можно заставить постучаться во внутреннюю сеть:
 * служебный адрес облака (169.254.169.254), соседний контейнер, админка на
 * localhost. Push-сервисы живут только на https и только на публичных
 * адресах, поэтому правило простое.
 *
 * Адрес разбираем, а не сверяем с образцом: первая версия проверки была
 * регулярным выражением, и ветка для внутренних адресов IPv6 («fc…»)
 * заодно отвергала `fcm.googleapis.com` — то есть push у всех на Android.
 */
const ЧАСТНЫЕ_ИМЕНА = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i;

function частныйIPv4(host) {
  const p = host.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)   // общий адрес провайдера
    || a >= 224;                            // multicast и выше
}

function частныйIPv6(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === '::1' || h === '::'
    || /^f[cd][0-9a-f]{2}:/.test(h)         // уникальные локальные
    || /^fe[89ab][0-9a-f]:/.test(h)         // link-local
    || /^::ffff:/.test(h);                  // IPv4 внутри IPv6
}

function проверитьАдрес(endpoint) {
  let url;
  try { url = new URL(endpoint); }
  catch { throw badRequest('Адрес подписки не похож на ссылку'); }
  if (url.protocol !== 'https:') throw badRequest('Адрес подписки должен быть https');

  const host = url.hostname;
  const вид = net.isIP(host.replace(/^\[|\]$/g, ''));
  const частный = вид === 4 ? частныйIPv4(host)
    : вид === 6 ? частныйIPv6(host)
      : ЧАСТНЫЕ_ИМЕНА.test(host);
  if (частный) throw badRequest('Адрес подписки ведёт во внутреннюю сеть — такие не принимаем');
  return endpoint;
}

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
    const endpoint = проверитьАдрес(v.str(sub?.endpoint, { max: 1000, field: 'endpoint' }));
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
