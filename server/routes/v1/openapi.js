const express = require('express');
const pkg = require('../../../package.json');

const json = { 'application/json': { schema: { type: 'object' } } };
const ok = (description, extra = {}) => ({ description, content: json, ...extra });
const dateParam = {
  name: 'date', in: 'path', required: true,
  schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  description: 'Дата в таймзоне пользователя',
};
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } };
const body = description => ({ required: true, description, content: json });

function entityPaths(segment, human) {
  return {
    [`/days/{date}/${segment}`]: {
      get: { tags: [human], summary: `Список: ${human.toLowerCase()}`, parameters: [dateParam], responses: { 200: ok('Список строк') } },
      post: { tags: [human], summary: 'Добавить строку', parameters: [dateParam], requestBody: body('Поля строки'), responses: { 201: ok('Созданная строка') } },
    },
    [`/days/{date}/${segment}/reorder`]: {
      post: { tags: [human], summary: 'Изменить порядок', parameters: [dateParam], requestBody: body('{ ids: number[] }'), responses: { 200: ok('Новый порядок') } },
    },
    [`/days/{date}/${segment}/{id}`]: {
      patch: { tags: [human], summary: 'Изменить строку', parameters: [dateParam, idParam], requestBody: body('Изменяемые поля'), responses: { 200: ok('Обновлённая строка'), 409: ok('STALE_ROW') } },
      delete: { tags: [human], summary: 'Удалить строку', parameters: [dateParam, idParam], responses: { 204: { description: 'Удалено' } } },
    },
  };
}

function buildSpec(appUrl) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'NewDay API',
      version: pkg.version,
      description:
        'API планировщика NewDay: день, расписание, задачи, питание, спорт, привычки, ' +
        'заметки, повторы и шаблон дня.\n\n' +
        '**Аутентификация.** Либо cookie-сессия (её ставит вход в браузере), либо ' +
        'персональный токен: `Authorization: Bearer nd_…`. Токен выпускается в шторке ' +
        '«Аккаунт» и показывается ровно один раз — сервер хранит только его хеш. ' +
        'Токен с областью `read` видит всё, но менять ничего не может; `write` — может. ' +
        'Токен нарочно не умеет выпускать другие токены, привязывать устройства и ' +
        'менять пароль: такие пути требуют именно сессии.\n\n' +
        '**Даты и время.** Дата — строка `YYYY-MM-DD` в таймзоне пользователя (не UTC). ' +
        'Время внутри дня — минуты от полуночи: `540` это 09:00. `endMin: null` значит ' +
        '«момент, а не отрезок» — так выглядит напоминание.\n\n' +
        '**Одновременная правка.** `PUT /days/{date}/full` и `PATCH /days/{date}` требуют ' +
        'заголовок `If-Match` с текущим `rev` дня; при расхождении вернётся 409 и в теле — ' +
        'актуальное состояние, чтобы было чем разрешить расхождение. Правка отдельной строки ' +
        '`If-Match` не требует, но принимает `updatedAt` и отвечает 409 `STALE_ROW`, если ' +
        'строку успели поменять.\n\n' +
        '**Отказы** приходят как `{ error: { code, message, details } }` с человекочитаемым ' +
        '`message` по-русски.',
    },
    servers: [{ url: `${appUrl}/api/v1` }],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'Персональный токен nd_… или токен устройства ndd_…' },
        cookie: { type: 'apiKey', in: 'cookie', name: 'connect.sid' },
      },
    },
    security: [{ bearer: [] }, { cookie: [] }],
    paths: {
      '/auth/register': { post: { tags: ['Аккаунт'], summary: 'Регистрация по почте', requestBody: body('{ email, password }'), responses: { 200: ok('Создан') } } },
      '/auth/login': { post: { tags: ['Аккаунт'], summary: 'Вход', requestBody: body('{ emailOrUsername, password }'), responses: { 200: ok('Вошли'), 403: ok('EMAIL_NOT_VERIFIED') } } },
      '/auth/logout': { post: { tags: ['Аккаунт'], summary: 'Выход', responses: { 200: ok('Вышли') } } },
      '/auth/me': { get: { tags: ['Аккаунт'], summary: 'Текущий пользователь', responses: { 200: ok('Профиль') } } },
      '/auth/forgot': { post: { tags: ['Аккаунт'], summary: 'Запросить сброс пароля', requestBody: body('{ email }'), responses: { 200: ok('Всегда 200') } } },
      '/auth/reset': { post: { tags: ['Аккаунт'], summary: 'Задать новый пароль', requestBody: body('{ token, password }'), responses: { 200: ok('Пароль изменён') } } },
      '/auth/verify': { get: { tags: ['Аккаунт'], summary: 'Подтвердить почту по ссылке из письма', parameters: [{ name: 'token', in: 'query', required: true, schema: { type: 'string' } }], responses: { 302: { description: 'Редирект на вход' } } } },
      '/auth/resend-verification': { post: { tags: ['Аккаунт'], summary: 'Выслать письмо с подтверждением ещё раз', requestBody: body('{ email }'), responses: { 200: ok('Всегда 200') } } },
      '/auth/password': { post: { tags: ['Аккаунт'], summary: 'Сменить пароль (нужна сессия)', requestBody: body('{ currentPassword, newPassword }'), responses: { 200: ok('Пароль изменён'), 401: ok('WRONG_PASSWORD') } } },
      '/auth/bind-email': { post: { tags: ['Аккаунт'], summary: 'Привязать почту к аккаунту без неё', requestBody: body('{ email, password }'), responses: { 200: ok('Письмо отправлено') } } },

      '/auth/pair/create': { post: { tags: ['Устройства'], summary: 'Создать код привязки (только веб-сессия)', responses: { 200: ok('{ code, shortCode, url, expiresAt }') } } },
      '/auth/pair/claim': { post: { tags: ['Устройства'], summary: 'Обменять код на токен устройства', requestBody: body('{ code, deviceName, platform }'), responses: { 200: ok('{ token, device }') } } },
      '/devices': { get: { tags: ['Устройства'], summary: 'Подключённые устройства', responses: { 200: ok('Список') } } },
      '/devices/{id}': { delete: { tags: ['Устройства'], summary: 'Отозвать устройство', parameters: [idParam], responses: { 204: { description: 'Отозвано' } } } },

      '/tokens': {
        get: { tags: ['Токены'], summary: 'Список токенов: имя, префикс, область, когда использовался', responses: { 200: ok('Без секретов — их сервер не хранит') } },
        post: {
          tags: ['Токены'],
          summary: 'Выпустить токен (только веб-сессия)',
          description: 'Секрет приходит в поле `token` и больше не показывается никогда: '
            + 'в базе лежит только его хеш. Не сохранили — перевыпустите.',
          requestBody: body('{ name, scope: read|write }'),
          responses: { 201: ok('{ id, name, prefix, scope, token }') },
        },
      },
      '/tokens/{id}': { delete: { tags: ['Токены'], summary: 'Отозвать токен (только веб-сессия)', parameters: [idParam], responses: { 204: { description: 'Отозван' } } } },

      '/days': { get: { tags: ['Дни'], summary: 'Список дней', parameters: [
        { name: 'from', in: 'query', schema: { type: 'string' } },
        { name: 'to', in: 'query', schema: { type: 'string' } },
      ], responses: { 200: ok('Краткие сводки') } } },
      '/days/{date}': {
        get: { tags: ['Дни'], summary: 'День без вложенных коллекций', parameters: [dateParam], responses: { 200: ok('День') } },
        patch: { tags: ['Дни'], summary: 'Изменить поля дня (нужен If-Match)', parameters: [dateParam], requestBody: body('{ title, focus, weight, notes }'), responses: { 200: ok('День'), 409: ok('REV_MISMATCH'), 428: ok('IF_MATCH_REQUIRED') } },
        delete: { tags: ['Дни'], summary: 'Удалить день', parameters: [dateParam], responses: { 204: { description: 'Удалён' } } },
      },
      '/days/{date}/full': {
        get: { tags: ['Дни'], summary: 'День целиком с прогрессом', parameters: [dateParam], responses: { 200: ok('Полный день; rev = 0, если дня ещё нет') } },
        put: { tags: ['Дни'], summary: 'Заменить день целиком (нужен If-Match)', parameters: [dateParam], requestBody: body('{ title, focus, weight, notes, schedule, tasks, meals, sport }'), responses: { 200: ok('Полный день'), 409: ok('REV_MISMATCH'), 428: ok('IF_MATCH_REQUIRED') } },
      },
      '/days/range': { get: { tags: ['Дни'], summary: 'Расписание и счётчики за период — для сеток недели и месяца', parameters: [
        { name: 'from', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'to', in: 'query', required: true, schema: { type: 'string' } },
      ], responses: { 200: ok('{ from, to, requestedTo, truncated, days }') } } },
      '/days/{date}/copy-to': { post: { tags: ['Дни'], summary: 'Скопировать день в другую дату', parameters: [dateParam], requestBody: body('{ targetDate, sections }'), responses: { 200: ok('Целевой день') } } },
      '/days/{date}/schedule/shift': { post: { tags: ['Расписание'], summary: 'Сдвинуть строку и, при cascade, все последующие', parameters: [dateParam], requestBody: body('{ fromId, minutes, cascade }'), responses: { 200: ok('Новое расписание') } } },
      '/days/{date}/schedule/{id}/series': {
        post: {
          tags: ['Расписание'],
          summary: 'Привязать строку к повтору или отвязать',
          description: '`{ seriesId: null }` снимает связь. Привязанная строка говорит серверу, '
            + 'что этот день повтором уже достроен, — без неё появлялась бы вторая такая же.',
          parameters: [dateParam, idParam],
          requestBody: body('{ seriesId: number | null }'),
          responses: { 200: ok('Строка'), 404: ok('Строка или правило не найдены') },
        },
      },

      ...entityPaths('schedule', 'Расписание'),
      ...entityPaths('tasks', 'Задачи'),
      ...entityPaths('meals', 'Питание'),
      ...entityPaths('sport', 'Спорт'),

      '/habits': {
        get: { tags: ['Привычки'], summary: 'Список привычек', responses: { 200: ok('Список') } },
        post: { tags: ['Привычки'], summary: 'Создать привычку', requestBody: body('{ title, emoji, preset: simple|challenge30|marathon300|quit, … }'), responses: { 201: ok('Привычка') } },
      },
      '/habits/{id}': {
        patch: { tags: ['Привычки'], summary: 'Изменить привычку', parameters: [idParam], requestBody: body('Изменяемые поля'), responses: { 200: ok('Привычка') } },
        delete: { tags: ['Привычки'], summary: 'В архив; ?hard=1 — удалить насовсем', parameters: [idParam], responses: { 200: ok('Заархивирована'), 204: { description: 'Удалена' } } },
      },
      '/habits/{id}/log/{date}': {
        put: { tags: ['Привычки'], summary: 'Отметить день', parameters: [idParam, dateParam], requestBody: body('{ status: done|missed|skipped, value }'), responses: { 200: ok('Лог') } },
        delete: { tags: ['Привычки'], summary: 'Снять отметку', parameters: [idParam, dateParam], responses: { 204: { description: 'Снято' } } },
      },
      '/habits/{id}/logs': { get: { tags: ['Привычки'], summary: 'Журнал отметок за период', parameters: [idParam,
        { name: 'from', in: 'query', schema: { type: 'string' } },
        { name: 'to', in: 'query', schema: { type: 'string' } },
      ], responses: { 200: ok('Отметки') } } },
      '/habits/{id}/stats': { get: { tags: ['Привычки'], summary: 'Стрики, проценты, прогресс челленджа', parameters: [idParam], responses: { 200: ok('Статистика') } } },
      '/habits/{id}/restore': { post: { tags: ['Привычки'], summary: 'Вернуть из архива', parameters: [idParam], responses: { 200: ok('Привычка') } } },
      '/habits/reorder': { post: { tags: ['Привычки'], summary: 'Изменить порядок', requestBody: body('{ ids: number[] }'), responses: { 200: ok('Новый порядок') } } },

      '/series': {
        get: {
          tags: ['Повторы и шаблон'],
          summary: 'Правила: повторы и шаблон дня',
          description: 'Одна таблица, два смысла. Правило без имени — повтор: сервер сам '
            + 'достраивает им дни. Правило с именем — шаблон дня: применяется вручную или '
            + 'заполняет пустой день. Разделяет их `?templates=1` / `?templates=0`.',
          parameters: [{ name: 'templates', in: 'query', schema: { type: 'string', enum: ['0', '1'] } }],
          responses: { 200: ok('Список правил') },
        },
        post: { tags: ['Повторы и шаблон'], summary: 'Создать правило', requestBody: body('{ target: schedule, freq: daily|weekly|monthly|yearly, interval, byweekday, startDate, endDate, rows[], name }'), responses: { 201: ok('Правило') } },
      },
      '/series/{id}': {
        patch: { tags: ['Повторы и шаблон'], summary: 'Изменить правило', parameters: [idParam], requestBody: body('Изменяемые поля'), responses: { 200: ok('Правило') } },
        delete: {
          tags: ['Повторы и шаблон'],
          summary: 'Убрать правило; ?from=YYYY-MM-DD — завершить с даты',
          description: 'Без `from` правило уходит вместе с будущими строками, прошлые остаются — '
            + 'они часть прожитых дней. С `from` правило получает дату окончания.',
          parameters: [idParam, { name: 'from', in: 'query', schema: { type: 'string' } }],
          responses: { 200: ok('Правило с датой окончания'), 204: { description: 'Убрано' } },
        },
      },
      '/series/{id}/apply': { post: { tags: ['Повторы и шаблон'], summary: 'Применить шаблон к дню', parameters: [idParam], requestBody: body('{ date }'), responses: { 200: ok('День') } } },

      '/notes': {
        get: { tags: ['Заметки'], summary: 'Заметки без даты', responses: { 200: ok('Список') } },
        post: { tags: ['Заметки'], summary: 'Создать заметку без даты', requestBody: body('{ title, text }'), responses: { 201: ok('Заметка') } },
      },
      '/notes/{id}': {
        patch: { tags: ['Заметки'], summary: 'Изменить заметку', parameters: [idParam], requestBody: body('{ title, text }'), responses: { 200: ok('Заметка') } },
        delete: { tags: ['Заметки'], summary: 'Удалить заметку', parameters: [idParam], responses: { 204: { description: 'Удалена' } } },
      },

      '/stats': { get: { tags: ['Статистика'], summary: 'Сводка за период: дни, привычки, серии', parameters: [
        { name: 'from', in: 'query', schema: { type: 'string' } },
        { name: 'to', in: 'query', schema: { type: 'string' } },
      ], responses: { 200: ok('Дни и привычки') } } },
      '/settings': {
        get: { tags: ['Настройки'], summary: 'Профиль и настройки', responses: { 200: ok('{ email, username, timezone, today, settings }') } },
        patch: { tags: ['Настройки'], summary: 'Изменить настройки', requestBody: body('{ timezone, theme, displayName, scheduleView, foodMode, settings }'), responses: { 200: ok('Настройки') } },
      },

      '/push/key': { get: { tags: ['Уведомления'], summary: 'Открытый ключ VAPID для подписки', responses: { 200: ok('{ key }') } } },
      '/push/subscribe': {
        post: { tags: ['Уведомления'], summary: 'Подписать браузер на push', requestBody: body('Подписка из PushManager'), responses: { 200: ok('Подписан') } },
        delete: { tags: ['Уведомления'], summary: 'Отписаться', requestBody: body('{ endpoint }'), responses: { 200: ok('Отписан') } },
      },
      '/push/status': { get: { tags: ['Уведомления'], summary: 'Подписки и очередь ближайших уведомлений', responses: { 200: ok('Состояние') } } },
      '/push/test': { post: { tags: ['Уведомления'], summary: 'Прислать проверочное уведомление', responses: { 200: ok('Отправлено') } } },
      '/push/replan': { post: { tags: ['Уведомления'], summary: 'Пересчитать очередь на сегодня и завтра', responses: { 200: ok('{ planned, skipped }') } } },

      '/ai/status': { get: { tags: ['Помощник'], summary: 'Включён ли помощник и распознавание речи', responses: { 200: ok('{ ready, voice }') } } },
      '/ai/parse': { post: { tags: ['Помощник'], summary: 'Разобрать текст в пункты плана', requestBody: body('{ text, date }'), responses: { 200: ok('{ items }') } } },
      '/ai/improve': { post: { tags: ['Помощник'], summary: 'Предложить, чем дополнить день', requestBody: body('{ date }'), responses: { 200: ok('{ items }') } } },
      '/ai/transcribe': { post: { tags: ['Помощник'], summary: 'Расшифровать надиктованное (multipart)', responses: { 200: ok('{ text }') } } },

      '/export': { get: { tags: ['Данные'], summary: 'Выгрузить всё в JSON', description: 'Дни, строки, задачи, питание, спорт, привычки с журналом, правила повторов и шаблон, отметки дней, заметки без даты. ?download=1 — как файл.', responses: { 200: ok('Дамп') } } },
      '/export.ics': { get: { tags: ['Данные'], summary: 'Расписание в iCalendar', description: 'Понимает любой календарь. По умолчанию месяц назад и всё вперёд.', parameters: [
        { name: 'from', in: 'query', schema: { type: 'string' } },
        { name: 'to', in: 'query', schema: { type: 'string' } },
      ], responses: { 200: { description: 'text/calendar' } } } },
      '/import': { post: { tags: ['Данные'], summary: 'Загрузить дамп', description: '`merge` не трогает дни, которые уже есть; `replace` заменяет всё.', requestBody: body('{ data, mode: merge|replace }'), responses: { 200: ok('Готово') } } },

      '/app/version': { get: { tags: ['Приложение'], summary: 'Текущая версия Android-приложения', responses: { 200: ok('{ version, url, notes }') } } },
      '/app/download': { get: { tags: ['Приложение'], summary: 'Скачать APK', responses: { 200: { description: 'application/vnd.android.package-archive' } } } },
    },
  };
}

module.exports = function openapiRouter({ config }) {
  const router = express.Router();
  const spec = buildSpec(config.appUrl);
  router.get('/openapi.json', (_req, res) => res.json(spec));
  return router;
};

module.exports.buildSpec = buildSpec;
