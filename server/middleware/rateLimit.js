const { ApiError } = require('../lib/errors');

/**
 * Простой счётчик в памяти. Для одного контейнера этого достаточно,
 * а тащить зависимость ради 20 строк не хочется.
 */
function rateLimit({ windowMs = 15 * 60 * 1000, max = 10, key = req => req.ip } = {}) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs);
  if (sweep.unref) sweep.unref();

  return (req, _res, next) => {
    const k = key(req);
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      return next(new ApiError(429, 'TOO_MANY_REQUESTS',
        'Слишком много попыток, попробуйте позже',
        { retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) }));
    }
    next();
  };
}

/**
 * Счётчик неудач, а не запросов.
 *
 * Предел на все попытки подряд наказывает не того: десять любых обращений с
 * одного адреса — это квартира, офис или приложение, переспросившее на плохой
 * связи, и вход после них закрывался у всех. Подбор пароля виден иначе — по
 * череде неудач, а успех счётчик обнуляет.
 *
 * Ключ обычно «адрес + логин»: чужие опечатки не должны запирать дверь
 * соседу, а перебор одного аккаунта с одного адреса виден и так.
 *
 * @param {{max?: number, windowMs?: number}} опции
 */
function failCounter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const неудачи = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of неудачи) if (v.resetAt <= now) неудачи.delete(k);
  }, windowMs);
  if (sweep.unref) sweep.unref();

  return {
    /** Бросает 429, если по этому ключу уже набралось слишком много неудач. */
    проверить(key) {
      const entry = неудачи.get(key);
      if (!entry || entry.resetAt <= Date.now()) return;
      if (entry.count >= max) {
        throw new ApiError(429, 'TOO_MANY_REQUESTS',
          'Слишком много неудачных попыток — подождите немного',
          { retryAfterSec: Math.ceil((entry.resetAt - Date.now()) / 1000) });
      }
    },
    /** Отметить неудачу. */
    неудача(key) {
      const now = Date.now();
      const entry = неудачи.get(key);
      if (!entry || entry.resetAt <= now) неудачи.set(key, { count: 1, resetAt: now + windowMs });
      else entry.count += 1;
    },
    /** Успех — счётчик чист. */
    успех(key) { неудачи.delete(key); },
  };
}

module.exports = { rateLimit, failCounter };
