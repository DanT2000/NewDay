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

module.exports = { rateLimit };
