/**
 * Версия и раздача Android-приложения.
 *
 * Всё публично, кроме выкладки: приложение спрашивает версию до входа,
 * а ссылку на скачивание человек открывает в браузере телефона, где сессии
 * этого сайта может не быть.
 *
 * Выкладку делает CI сразу после сборки APK — поэтому «новая версия на сайте»
 * появляется тем же движением, что и сама сборка.
 */

const express = require('express');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { wrap, ApiError } = require('../../lib/errors');
const { sendFileSafe } = require('../../lib/sendFile');

const MAX_APK_BYTES = 80 * 1024 * 1024;

/** Сравнение секретов без утечки по времени. */
function sameSecret(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = function appRouter({ config, store, update }) {
  const router = express.Router();

  /** Что скачивать и с какой версии обновляться. */
  router.get('/version', wrap(async (_req, res) => {
    const latest = await update.latest();
    res.set('Cache-Control', 'no-store');
    res.json({
      enabled: Boolean(config.update?.enabled),
      latest,                                   // null, если версия неизвестна
      minSupportedVersionCode: 0,
    });
  }));

  router.get('/download', wrap((_req, res, next) => {
    const cur = store.current();
    if (!cur) {
      throw new ApiError(404, 'NO_APK',
        'На этом сервере ещё нет выложенного APK. Соберите приложение и выложите его.');
    }
    sendFileSafe(res, next, cur.filePath, {
      headers: {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': `attachment; filename="${cur.fileName}"`,
        'X-App-Version': cur.versionName,
        'Cache-Control': 'public, max-age=300',
      },
      notFoundMessage: 'Файл приложения потерян',
    });
  }));

  /**
   * Выкладка новой версии.
   *
   * Токен отдельный, а не пользовательский: выкладывает CI, у которого нет
   * и не должно быть чужого аккаунта. Пока токен не задан, эндпоинт закрыт —
   * иначе любой смог бы подменить приложение, которое люди установят.
   */
  // type: () => true, а не '*/*': сопоставление по типу требует заголовка
  // Content-Type, а без него тело просто не разбиралось — и выкладка падала
  // с «пустой файл» вместо понятной ошибки.
  /*
   * Токен сверяем до чтения тела.
   *
   * `express.raw` дочитывает запрос в память целиком — до восьмидесяти
   * мегабайт, — и только потом управление доходит до обработчика. Маршрут
   * публичный: пока проверка стояла внутри, любой из интернета клал
   * контейнер по памяти, отправив несколько таких запросов без всякого
   * токена. Теперь неверный токен отвергается вместе с телом.
   */
  const проверитьТокен = (req, _res, next) => {
    if (!config.apkUploadToken) {
      next(new ApiError(503, 'UPLOAD_DISABLED',
        'Выкладка APK не настроена: задайте APK_UPLOAD_TOKEN в окружении сервера.'));
      return;
    }
    if (!sameSecret(req.get('X-Upload-Token'), config.apkUploadToken)) {
      next(new ApiError(401, 'BAD_UPLOAD_TOKEN', 'Неверный токен выкладки'));
      return;
    }
    next();
  };

  router.post('/upload',
    проверитьТокен,
    express.raw({ type: () => true, limit: MAX_APK_BYTES }),
    wrap((req, res) => {

      const versionName = String(req.query.versionName || '');
      const notes = String(req.query.notes || '').slice(0, 2000);
      try {
        const meta = store.save(req.body, { versionName, notes });
        console.log(`[newday] выложен APK ${meta.versionName} (${meta.sizeBytes} байт)`);
        res.json({ ok: true, ...meta });
      } catch (e) {
        const status = e.code === 'NOT_NEWER' ? 409 : 400;
        throw new ApiError(status, e.code || 'BAD_REQUEST', e.message);
      }
    }));

  return router;
};
