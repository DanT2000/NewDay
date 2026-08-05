/**
 * Выгрузка и загрузка.
 *
 * Главная проверка здесь одна: своя же выгрузка, влитая обратно, не должна
 * ничего удваивать. Это то, ради чего резервная копия и делается, и узнать
 * о поломке при восстановлении — значит узнать слишком поздно.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, today, dayFromToday } = require('../helpers/client');

/** День с делами во всех разделах плюс привычка с отметкой. */
async function seed(s) {
  const d = today();
  await api(s.url, s.cookie, 'POST', `/api/v1/days/${d}/schedule`, { title: 'Подъём', startMin: 420, endMin: 450 });
  await api(s.url, s.cookie, 'POST', `/api/v1/days/${d}/tasks`, { text: 'Закрыть отчёт за июль' });
  await api(s.url, s.cookie, 'POST', `/api/v1/days/${d}/meals`, { title: 'Обед', calories: 640 });
  await api(s.url, s.cookie, 'POST', `/api/v1/days/${d}/sport`, { exercise: 'Жим лёжа', sets: 4, reps: 8 });
  const habit = await api(s.url, s.cookie, 'POST', '/api/v1/habits', { title: 'Вода — 2 литра', emoji: '💧' });
  await api(s.url, s.cookie, 'PUT', `/api/v1/habits/${habit.id}/log/${d}`, { status: 'done' });
  return { date: d, habitId: habit.id };
}

const habitTitles = async s =>
  (await getJson(s.url, s.cookie, '/api/v1/habits')).map(h => h.title).sort();

test('выгрузка отдаёт всё, что нужно для восстановления', async () => {
  const s = await loggedIn();
  try {
    await seed(s);
    const dump = await getJson(s.url, s.cookie, '/api/v1/export');

    for (const key of ['days', 'scheduleItems', 'tasks', 'meals', 'sportSets', 'habits', 'habitLogs']) {
      assert.ok(Array.isArray(dump[key]), `нет раздела ${key}`);
    }
    assert.strictEqual(dump.scheduleItems.length, 1);
    assert.strictEqual(dump.habits.length, 1);
    assert.strictEqual(dump.habitLogs.length, 1);
    assert.ok(dump.formatVersion, 'без версии формата восстановление вслепую');
  } finally { await s.close(); }
});

test('своя же выгрузка не удваивает привычки', async () => {
  const s = await loggedIn();
  try {
    await seed(s);
    const dump = await getJson(s.url, s.cookie, '/api/v1/export');
    const before = await habitTitles(s);

    await api(s.url, s.cookie, 'POST', '/api/v1/import', { data: dump, mode: 'merge' });
    assert.deepStrictEqual(await habitTitles(s), before, 'привычки удвоились');

    // И второй раз тоже: восстановление должно быть безопасно повторять
    await api(s.url, s.cookie, 'POST', '/api/v1/import', { data: dump, mode: 'merge' });
    assert.deepStrictEqual(await habitTitles(s), before);
  } finally { await s.close(); }
});

test('журнал привычки после повторной загрузки остаётся на своей привычке', async () => {
  const s = await loggedIn();
  try {
    const { date } = await seed(s);
    const dump = await getJson(s.url, s.cookie, '/api/v1/export');
    await api(s.url, s.cookie, 'POST', '/api/v1/import', { data: dump, mode: 'merge' });

    const day = await getJson(s.url, s.cookie, `/api/v1/days/${date}/full`);
    assert.strictEqual(day.habits.length, 1, 'в дне должна остаться одна привычка');
    assert.strictEqual(day.habits[0].status, 'done', 'отметка не должна потеряться');
  } finally { await s.close(); }
});

test('своя же выгрузка не удваивает дела дня', async () => {
  const s = await loggedIn();
  try {
    const { date } = await seed(s);
    const dump = await getJson(s.url, s.cookie, '/api/v1/export');
    await api(s.url, s.cookie, 'POST', '/api/v1/import', { data: dump, mode: 'merge' });

    const day = await getJson(s.url, s.cookie, `/api/v1/days/${date}/full`);
    assert.strictEqual(day.schedule.length, 1);
    assert.strictEqual(Object.values(day.tasks).flat().length, 1);
    assert.strictEqual(day.meals.length, 1);
    assert.strictEqual(day.sport.length, 1);
  } finally { await s.close(); }
});

test('новая привычка из чужой выгрузки добавляется', async () => {
  const s = await loggedIn();
  try {
    await seed(s);
    const dump = await getJson(s.url, s.cookie, '/api/v1/export');
    // Подменяем название: для сервера это другая привычка
    dump.habits[0] = { ...dump.habits[0], id: 999, title: 'Чтение 20 минут' };
    dump.habitLogs = dump.habitLogs.map(l => ({ ...l, habit_id: 999 }));

    await api(s.url, s.cookie, 'POST', '/api/v1/import', { data: dump, mode: 'merge' });
    assert.deepStrictEqual(await habitTitles(s), ['Вода — 2 литра', 'Чтение 20 минут']);
  } finally { await s.close(); }
});

test('«заменить всё» стирает прежнее и кладёт выгруженное', async () => {
  const s = await loggedIn();
  try {
    const { date } = await seed(s);
    const dump = await getJson(s.url, s.cookie, '/api/v1/export');

    await api(s.url, s.cookie, 'POST', `/api/v1/days/${date}/schedule`, { title: 'Лишняя строка', startMin: 900 });
    await api(s.url, s.cookie, 'POST', '/api/v1/habits', { title: 'Лишняя привычка' });

    await api(s.url, s.cookie, 'POST', '/api/v1/import', { data: dump, mode: 'replace' });

    const day = await getJson(s.url, s.cookie, `/api/v1/days/${date}/full`);
    assert.deepStrictEqual(day.schedule.map(r => r.title), ['Подъём']);
    assert.deepStrictEqual(await habitTitles(s), ['Вода — 2 литра']);
  } finally { await s.close(); }
});

test('чужой формат не принимается', async () => {
  const s = await loggedIn();
  try {
    for (const body of [{ data: { formatVersion: 999 } }, { data: 'не объект' }, {}]) {
      const r = await api(s.url, s.cookie, 'POST', '/api/v1/import', body, {}, true);
      assert.strictEqual(r.status, 400, JSON.stringify(body));
    }
  } finally { await s.close(); }
});

test('календарь отдаётся как .ics и содержит события', async () => {
  const s = await loggedIn();
  try {
    await seed(s);
    const res = await api(s.url, s.cookie, 'GET', '/api/v1/export.ics', undefined, {}, true);
    const text = await res.text();

    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/calendar/);
    assert.match(text, /BEGIN:VCALENDAR/);
    assert.match(text, /BEGIN:VEVENT/);
    assert.match(text, /Подъём/);
  } finally { await s.close(); }
});

test('чужую выгрузку не отдаём и в чужой аккаунт не пишем', async () => {
  const s = await loggedIn();
  try {
    await seed(s);
    const other = await loggedIn({ email: 'other@example.com', server: s.srv });

    const dump = await getJson(s.url, other.cookie, '/api/v1/export');
    assert.strictEqual(dump.habits.length, 0, 'в чужой выгрузке пусто');
    assert.strictEqual(dump.scheduleItems.length, 0);

    const mine = await getJson(s.url, s.cookie, '/api/v1/export');
    await api(s.url, other.cookie, 'POST', '/api/v1/import', { data: mine, mode: 'merge' });
    // Данные легли второму человеку, а у первого ничего не изменилось
    assert.deepStrictEqual(await habitTitles(s), ['Вода — 2 литра']);
  } finally { await s.close(); }
});
