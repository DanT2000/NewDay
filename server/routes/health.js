const express = require('express');
const pkg = require('../../package.json');
const { MIGRATIONS } = require('../db/migrations');
const { hashToken, safeEqual } = require('../lib/secrets');
const { appSettingsRepo } = require('../repos/appSettings');
const { panelSettings } = require('../repos/panelSettings');

/**
 * Состояние службы. Открыто без входа, поэтому здесь только то, по чему нельзя
 * ничего узнать о людях и секретах: версия, версия схемы, пишется ли база,
 * подключён ли помощник, жив ли планировщик уведомлений.
 *
 * Отвечает не только «да/нет», но и почему нет: список `problems` человеческими
 * фразами. Наблюдалка присылает уведомление ночью, и в нём должно быть видно,
 * что чинить, — «сайт упал» без причины означает лезть в логи с телефона.
 *
 * Про помощника и уведомления — признак «да/нет», без адреса, ключей и
 * названий моделей. Он нужен затем, чтобы после развёртывания было видно,
 * доехали ли до контейнера переменные: настройки закрыты админом, а вход
 * требует подтверждённой почты, и неподключённый помощник обнаружился бы
 * только тогда, когда человек нажал кнопку и ничего не произошло.
 */

/*
 * Насколько просроченная очередь считается застрявшей.
 *
 * Отправка идёт раз в тридцать секунд, поэтому пара минут опоздания — это
 * нормальная жизнь. Десять минут — уже значит, что уведомления не уходят, а
 * это ровно та поломка, которую замечают, проспав.
 */
const QUEUE_STUCK_MS = 10 * 60 * 1000;

module.exports = function healthRouter(db, { ai, push, mailer } = {}) {
  const router = express.Router();
  const panel = panelSettings(appSettingsRepo(db));

  /**
   * Показывать ли подробности этому запросу.
   *
   * Ключ можно прислать заголовком `Authorization: Bearer …`, заголовком
   * `X-Health-Token` или параметром `?token=` — у наблюдалок разные привычки,
   * и заставлять человека подбирать способ незачем. Пока ключ не выпущен,
   * подробности открыты: сервер, поднятый пять минут назад, должен уметь
   * объяснить, что с ним не так, до всякой настройки.
   */
  function detailsAllowed(req) {
    if (panel.healthOpen()) return true;
    const hash = panel.healthTokenHash();
    if (!hash) return true;
    const header = req.get('authorization') || '';
    const given = (header.startsWith('Bearer ') ? header.slice(7) : '')
      || req.get('x-health-token')
      || (typeof req.query.token === 'string' ? req.query.token : '');
    return Boolean(given) && safeEqual(hashToken(given), hash);
  }

  router.get('/', (req, res) => {
    const problems = [];      // из-за чего служба нездорова
    const notes = [];         // на что стоит посмотреть, но это не поломка

    // ── База ──
    let schemaVersion = 0;
    let dbWritable = false;
    try {
      schemaVersion = db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v ?? 0;
      db.prepare('CREATE TABLE IF NOT EXISTS _write_probe (x INTEGER)').run();
      db.prepare('DROP TABLE IF EXISTS _write_probe').run();
      dbWritable = true;
    } catch (e) {
      dbWritable = false;
      problems.push(`База не пишется: ${e.message}. Проверьте том с базой и место на диске`);
    }

    /*
     * Схема должна быть накатана до последней миграции. Отставание значит, что
     * контейнер поднялся на старой базе: часть запросов будет падать «no such
     * column», и по одному «ok: true» этого не увидеть.
     */
    const expected = MIGRATIONS.length;
    if (dbWritable && schemaVersion < expected) {
      problems.push(
        `Схема базы отстаёт: накатано ${schemaVersion} из ${expected} миграций`,
      );
    }

    // ── Очередь уведомлений ──
    let queue = null;
    if (dbWritable) {
      try {
        /*
         * failed_at IS NULL — как у планировщика: он берёт в работу только
         * такие строки. Уведомление, окончательно упавшее на мёртвой
         * подписке, навсегда остаётся без sent_at, и без этого условия одна
         * протухшая браузерная подписка держала бы 503 до суток — ложная
         * ночная тревога на живом сервере.
         */
        const row = db.prepare(`
          SELECT COUNT(*) AS waiting,
                 MIN(fire_at_utc) AS oldest
            FROM notification_queue
           WHERE sent_at IS NULL AND failed_at IS NULL
        `).get();
        const oldest = row?.oldest ? new Date(row.oldest).getTime() : null;
        const lateMs = oldest ? Date.now() - oldest : 0;
        queue = {
          waiting: row?.waiting ?? 0,
          lateSeconds: lateMs > 0 ? Math.round(lateMs / 1000) : 0,
        };
        if (push?.enabled && lateMs > QUEUE_STUCK_MS) {
          problems.push(
            `Очередь уведомлений стоит: самое старое опоздало на ${Math.round(lateMs / 60000)} мин. `
            + 'Похоже, планировщик не работает — перезапустите службу',
          );
        }
      } catch (e) {
        notes.push(`Очередь уведомлений не читается: ${e.message}`);
      }
    }

    // ── Что настроено ──
    const state = ai?.status();
    if (push && !push.enabled) {
      notes.push('Уведомления выключены: не заданы VAPID_PUBLIC_KEY и VAPID_PRIVATE_KEY');
    }
    if (state && !state.ready) {
      notes.push('Помощник не подключён: не задан ключ модели');
    }
    if (mailer && !mailer.enabled) {
      notes.push('Почта не настроена: регистрация впускает без подтверждения адреса');
    }

    /*
     * Отвечаем 503, когда служба нездорова, и 200, когда с ней всё в порядке:
     * наблюдалке нужен именно код ответа, а не разбор тела. `problems` —
     * чтобы в уведомлении была причина, а не только «сайт упал».
     */
    const ok = problems.length === 0;
    /*
     * Без ключа — только «жив или нет». Наблюдалке этого хватает: она смотрит
     * на код ответа. Подробности (версия схемы, очередь, причины поломки)
     * рассказывают о внутренностях, и на публичном адресе им не место.
     */
    if (!detailsAllowed(req)) {
      return res.status(ok ? 200 : 503).json({ ok, status: ok ? 'up' : 'down' });
    }
    res.status(ok ? 200 : 503).json({
      ok,
      status: ok ? 'up' : 'down',
      version: pkg.version,
      schemaVersion,
      dbWritable,
      ...(queue ? { queue } : {}),
      ...(state ? { ai: { ready: state.ready, voice: state.voice } } : {}),
      ...(push ? { push: { enabled: Boolean(push.enabled) } } : {}),
      problems,
      notes,
    });
  });

  return router;
};
