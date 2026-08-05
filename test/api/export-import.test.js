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

/*
 * Ниже — то, что нашлось прогоном ботов: выгрузка молчала о половине полей,
 * а «заменить всё» стирало повторы и не кладло их обратно. Резервная копия,
 * которая теряет данные, хуже отсутствия копии: узнаёшь при восстановлении.
 */

test('выгрузка содержит повторы и шаблоны, а загрузка их возвращает', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/series', {
      freq: 'daily', startDate: '2026-08-01',
      rows: [{ time: '07:00', title: 'Подъём' }],
    });
    await api(s.url, s.cookie, 'POST', '/api/v1/series', {
      name: 'Общее расписание', freq: 'daily', startDate: '2026-08-01', forceRows: true,
      rows: [{ time: '09:00-13:00', title: 'Работа' }],
    });

    const dump = await getJson(s.url, s.cookie, '/api/v1/export');
    assert.strictEqual(dump.series.length, 2, 'оба правила в выгрузке');

    await api(s.url, s.cookie, 'POST', '/api/v1/import', { data: dump, mode: 'replace' });
    const rules = await getJson(s.url, s.cookie, '/api/v1/series');
    assert.strictEqual(rules.length, 2, 'оба правила восстановлены');
    assert.ok(rules.some(r => r.name === 'Общее расписание'), 'шаблон на месте');
  } finally { await s.close(); }
});

test('своя же выгрузка не удваивает повторы и шаблоны', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/series', {
      name: 'Общее расписание', freq: 'daily', startDate: '2026-08-01', forceRows: true,
      rows: [{ time: '09:00-13:00', title: 'Работа' }],
    });
    const dump = await getJson(s.url, s.cookie, '/api/v1/export');
    await api(s.url, s.cookie, 'POST', '/api/v1/import', { data: dump, mode: 'merge' });
    const rules = await getJson(s.url, s.cookie, '/api/v1/series');
    assert.strictEqual(rules.length, 1, 'шаблон остался один');
  } finally { await s.close(); }
});

test('выгрузка и загрузка держат цвет, список сроков, окно питания и свободный график', async () => {
  const s = await loggedIn();
  const date = '2026-08-05';
  try {
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${date}/schedule`, {
      time: '09:00-13:00', title: 'Работа', color: 'green',
      alarmMode: 'notify', remindBefore: [1440, 60],
    });
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${date}/meals`, {
      title: 'Обед окном', timeMin: 720, endMin: 840, remindBefore: [15],
    });
    await api(s.url, s.cookie, 'POST', '/api/v1/habits',
      { title: 'Медитация', emoji: '🧘', timesPerWeek: 3 });
    await api(s.url, s.cookie, 'POST', '/api/v1/notes', { title: 'Книги на осень', text: 'без даты' });

    const dump = await getJson(s.url, s.cookie, '/api/v1/export');
    await api(s.url, s.cookie, 'POST', '/api/v1/import', { data: dump, mode: 'replace' });

    const day = await getJson(s.url, s.cookie, `/api/v1/days/${date}/full`);
    const row = day.schedule.find(r => r.title === 'Работа');
    assert.strictEqual(row.color, 'green', 'цвет блока');
    assert.strictEqual(row.remind_before_json, '[1440,60]', 'список сроков');

    const meal = day.meals.find(m => m.title === 'Обед окном');
    assert.strictEqual(meal.end_min, 840, 'окно приёма пищи');
    assert.strictEqual(meal.remind_before_json, '[15]', 'напоминание о еде');

    const habits = await getJson(s.url, s.cookie, '/api/v1/habits');
    const free = habits.find(h => h.title === 'Медитация');
    assert.strictEqual(free.timesPerWeek ?? free.times_per_week, 3, 'свободный график');

    const notes = await getJson(s.url, s.cookie, '/api/v1/notes');
    assert.strictEqual(notes.filter(n => !n.date).length, 1, 'заметка без даты одна');
  } finally { await s.close(); }
});

test('связь приёма пищи с блоком расписания переживает выгрузку', async () => {
  const s = await loggedIn();
  const date = '2026-08-06';
  try {
    const block = await api(s.url, s.cookie, 'POST', `/api/v1/days/${date}/schedule`, {
      time: '13:00-13:30', title: 'Обед', kind: 'meal',
    });
    const meal = await api(s.url, s.cookie, 'POST', `/api/v1/days/${date}/meals`, {
      title: 'Обед', timeMin: 780, scheduleItemId: block.id,
    });
    assert.strictEqual(meal.schedule_item_id, block.id);

    const dump = await getJson(s.url, s.cookie, '/api/v1/export');
    await api(s.url, s.cookie, 'POST', '/api/v1/import', { data: dump, mode: 'replace' });

    const day = await getJson(s.url, s.cookie, `/api/v1/days/${date}/full`);
    const sameBlock = day.schedule.find(r => r.title === 'Обед');
    const sameMeal = day.meals.find(m => m.title === 'Обед');
    assert.strictEqual(sameMeal.schedule_item_id, sameBlock.id, 'ссылка переведена на новый номер');
  } finally { await s.close(); }
});
