class ApiError extends Error {
  constructor(status, code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.publicMessage = message;
    this.details = details;
  }
}

const badRequest   = (m, d)                    => new ApiError(400, 'BAD_REQUEST', m, d);
const unauthorized = (m = 'Требуется вход')    => new ApiError(401, 'UNAUTHORIZED', m);
const forbidden    = (m = 'Недостаточно прав') => new ApiError(403, 'FORBIDDEN', m);
const notFound     = (m = 'Не найдено')        => new ApiError(404, 'NOT_FOUND', m);
const conflict     = (code, m, d)              => new ApiError(409, code, m, d);

/** Оборачивает async-обработчик, чтобы отказ промиса дошёл до errorHandler. */
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function errorHandler(err, _req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.publicMessage,
        ...(err.details ? { details: err.details } : {}),
      },
    });
  }
  console.error('[newday] unhandled', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Внутренняя ошибка сервера' } });
}

module.exports = {
  ApiError, errorHandler, wrap,
  badRequest, unauthorized, forbidden, notFound, conflict,
};
