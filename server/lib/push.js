/**
 * Web Push.
 *
 * Без VAPID-ключей модуль работает в режиме «выключен»: отправки не происходит,
 * но всё остальное приложение поднимается. Это нужно, чтобы self-host
 * запускался без обязательной настройки push.
 */

function createPush(config) {
  const sent = [];   // последние отправки — для тестов и диагностики

  if (!config.vapid?.publicKey || !config.vapid?.privateKey) {
    return {
      enabled: false, sent, publicKey: null,
      async send(subscription, payload) {
        sent.push({ subscription, payload });
        return { ok: false, reason: 'PUSH_DISABLED' };
      },
    };
  }

  const webpush = require('web-push');
  webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);

  return {
    enabled: true,
    sent,
    publicKey: config.vapid.publicKey,

    /**
     * @returns { ok } либо { ok: false, gone } — gone означает, что подписка
     *          мертва и её надо удалить, а не пытаться отправить снова.
     */
    async send(subscription, payload) {
      sent.push({ subscription, payload });
      if (sent.length > 50) sent.shift();
      if (config.nodeEnv === 'test') return { ok: true };

      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify(payload),
          { TTL: 600, urgency: 'high' },
        );
        return { ok: true };
      } catch (e) {
        // 404 и 410 от push-сервиса означают, что подписка больше не существует
        const gone = e.statusCode === 404 || e.statusCode === 410;
        return { ok: false, gone, reason: e.body || e.message };
      }
    },
  };
}

module.exports = { createPush };
