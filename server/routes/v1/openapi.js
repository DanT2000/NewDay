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
        'API планировщика NewDay. Аутентификация — cookie-сессия или персональный токен ' +
        '`Authorization: Bearer nd_…`. Токен создаётся в настройках и показывается один раз.\n\n' +
        'Даты — строки `YYYY-MM-DD` в таймзоне пользователя. Время — минуты от полуночи.\n\n' +
        '`PUT /days/{date}/full` и `PATCH /days/{date}` требуют заголовок `If-Match` ' +
        'с текущим `rev` дня; при расхождении вернётся 409 с актуальным состоянием.',
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
      '/auth/pair/create': { post: { tags: ['Устройства'], summary: 'Создать код привязки (только веб-сессия)', responses: { 200: ok('{ code, shortCode, url, expiresAt }') } } },
      '/auth/pair/claim': { post: { tags: ['Устройства'], summary: 'Обменять код на токен устройства', requestBody: body('{ code, deviceName, platform }'), responses: { 200: ok('{ token, device }') } } },
      '/devices': { get: { tags: ['Устройства'], summary: 'Подключённые устройства', responses: { 200: ok('Список') } } },
      '/devices/{id}': { delete: { tags: ['Устройства'], summary: 'Отозвать устройство', parameters: [idParam], responses: { 204: { description: 'Отозвано' } } } },

      '/tokens': {
        get: { tags: ['Токены'], summary: 'Список токенов', responses: { 200: ok('Без секретов') } },
        post: { tags: ['Токены'], summary: 'Создать токен', requestBody: body('{ name, scope: read|write }'), responses: { 201: ok('Секрет виден один раз') } },
      },
      '/tokens/{id}': { delete: { tags: ['Токены'], summary: 'Отозвать токен', parameters: [idParam], responses: { 204: { description: 'Отозван' } } } },

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
      '/days/{date}/copy-to': { post: { tags: ['Дни'], summary: 'Скопировать день в другую дату', parameters: [dateParam], requestBody: body('{ targetDate, sections }'), responses: { 200: ok('Целевой день') } } },
      '/days/{date}/schedule/shift': { post: { tags: ['Расписание'], summary: 'Сдвинуть строку и, при cascade, все последующие', parameters: [dateParam], requestBody: body('{ fromId, minutes, cascade }'), responses: { 200: ok('Новое расписание') } } },

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
      '/habits/{id}/stats': { get: { tags: ['Привычки'], summary: 'Стрики, проценты, прогресс челленджа', parameters: [idParam], responses: { 200: ok('Статистика') } } },
      '/stats': { get: { tags: ['Статистика'], summary: 'Сводка за период', responses: { 200: ok('Дни и привычки') } } },
      '/settings': {
        get: { tags: ['Настройки'], summary: 'Профиль и настройки', responses: { 200: ok('Настройки') } },
        patch: { tags: ['Настройки'], summary: 'Изменить настройки', requestBody: body('{ timezone, theme, scheduleView, foodMode, settings }'), responses: { 200: ok('Настройки') } },
      },
      '/export': { get: { tags: ['Данные'], summary: 'Выгрузить всё', responses: { 200: ok('Дамп') } } },
      '/import': { post: { tags: ['Данные'], summary: 'Загрузить дамп', requestBody: body('{ data, mode: merge|replace }'), responses: { 200: ok('Готово') } } },
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
