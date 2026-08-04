const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, today } = require('../helpers/client');

test('openapi.json валиден и покрывает ключевые пути', async () => {
  const s = await loggedIn();
  try {
    const spec = await (await fetch(`${s.url}/api/v1/openapi.json`)).json();
    assert.ok(spec.openapi.startsWith('3.'));
    for (const p of ['/days/{date}/full', '/habits', '/tokens', '/auth/login', '/stats',
                     '/days/{date}/schedule', '/settings', '/export']) {
      assert.ok(spec.paths[p], `нет пути ${p}`);
    }
  } finally { await s.close(); }
});

test('старый GET /api/days/:date отдаёт форму прежнего фронтенда', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/schedule',
      { time: '9-13', title: 'Работа', done: true });
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/tasks',
      { bucket: 'work', text: 'Созвон' });

    const legacy = await getJson(s.url, s.cookie, '/api/days/2026-08-03');
    assert.strictEqual(legacy.date, '2026-08-03');
    assert.deepStrictEqual(legacy.schedule, [{ time: '09:00–13:00', action: 'Работа', done: true }]);
    assert.strictEqual(legacy.workTasks[0].text, 'Созвон');
    assert.deepStrictEqual(legacy.homeTasks, []);
  } finally { await s.close(); }
});

test('старый PUT /api/days/:date пустым телом больше не стирает день', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/schedule',
      { time: '9-13', title: 'Работа' });
    await api(s.url, s.cookie, 'PUT', '/api/days/2026-08-03', { date: '2026-08-03' });

    const full = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
    assert.strictEqual(full.schedule.length, 1, 'пустой PUT не уничтожил расписание');
  } finally { await s.close(); }
});

test('старый PUT со списками по-прежнему сохраняет правки', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'PUT', '/api/days/2026-08-03', {
      date: '2026-08-03',
      title: 'Понедельник',
      schedule: [{ time: '6-6:30', action: 'Подъём', done: false }],
      workTasks: [{ text: 'Отчёт', done: true }],
    });
    const full = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
    assert.strictEqual(full.title, 'Понедельник');
    assert.strictEqual(full.schedule[0].start_min, 360);
    assert.strictEqual(full.tasks.work[0].done, 1);
  } finally { await s.close(); }
});

test('старые эндпоинты привычек работают', async () => {
  const s = await loggedIn();
  try {
    const h = await api(s.url, s.cookie, 'POST', '/api/habits', { title: 'Вода', emoji: '💧' });
    // дата от сегодня: в днях до создания привычки теперь нет вовсе
    await api(s.url, s.cookie, 'PUT', `/api/habits/logs/${today()}/${h.id}`, { done: true });
    const logs = await getJson(s.url, s.cookie, `/api/habits/logs/${today()}`);
    assert.strictEqual(logs[0].done, true);
    const stats = await getJson(s.url, s.cookie, '/api/habits/stats');
    assert.strictEqual(stats.habits.length, 1);
  } finally { await s.close(); }
});

test('старый /api/auth/me и /api/export/all отвечают', async () => {
  const s = await loggedIn();
  try {
    const me = await getJson(s.url, s.cookie, '/api/auth/me');
    assert.strictEqual(me.email, 'user@example.com');
    const dump = await getJson(s.url, s.cookie, '/api/export/all');
    assert.strictEqual(dump.formatVersion, 1);
  } finally { await s.close(); }
});

test('неизвестный эндпоинт под /api даёт 404 в едином формате', async () => {
  const s = await loggedIn();
  try {
    const res = await api(s.url, s.cookie, 'GET', '/api/выдумка', undefined, {}, true);
    assert.strictEqual(res.status, 404);
    assert.strictEqual((await res.json()).error.code, 'NOT_FOUND');
  } finally { await s.close(); }
});
