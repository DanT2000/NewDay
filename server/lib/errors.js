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

/*
 * Ошибки разбора тела — это ошибки запроса, а не поломка сервера.
 *
 * `express.json` бросает свои ошибки со `status`: 400 на оборванный JSON,
 * 413 на слишком большое тело, 415 на неизвестную кодировку. Раньше сюда
 * смотрел только `instanceof ApiError`, и человек с чуть побитым запросом
 * получал «Внутренняя ошибка сервера», а в логе копилось «unhandled» —
 * то есть настоящие поломки терялись среди чужих кривых запросов.
 */
const BODY_ERRORS = {
  'entity.parse.failed': ['BAD_JSON', 'Тело запроса не разбирается как JSON'],
  'entity.too.large': ['TOO_LARGE', 'Слишком большое тело запроса'],
  'request.aborted': ['ABORTED', 'Запрос оборван'],
  'encoding.unsupported': ['BAD_ENCODING', 'Неизвестная кодировка тела'],
  'parameters.too.many': ['TOO_MANY_PARAMS', 'Слишком много полей в запросе'],
};

function errorHandler(err, _req, res, _next) {
  /*
   * Заголовки уже ушли — значит ответ начался и менять его статус поздно.
   * Так бывает, когда соединение оборвали посреди отдачи файла: попытка
   * дописать JSON поверх наполовину отправленного ответа бросает
   * ERR_HTTP_HEADERS_SENT уже внутри самого обработчика ошибок.
   */
  if (res.headersSent) {
    res.destroy?.();
    return undefined;
  }

  if (err instanceof ApiError) {
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.publicMessage,
        ...(err.details ? { details: err.details } : {}),
      },
    });
  }

  const status = Number(err?.status ?? err?.statusCode);
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    const [code, message] = BODY_ERRORS[err?.type] ?? ['BAD_REQUEST', 'Запрос не принят'];
    return res.status(status).json({ error: { code, message } });
  }

  console.error('[newday] unhandled', err);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Внутренняя ошибка сервера' } });
}

module.exports = {
  ApiError, errorHandler, wrap,
  badRequest, unauthorized, forbidden, notFound, conflict,
};
