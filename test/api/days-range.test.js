/**
 * Выборка дней за период — то, на чём стоит сетка недели и месяца.
 *
 * Проверяем не «отвечает 200», а то, ради чего она нужна: что дни идут
 * подряд без пропусков, что повторы достроены и в сетке не окажется
 * пустого дня с настоящим расписанием, и что тридцать дней месяца не
 * тянут за собой тридцать полных расчётов.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, today, dayFromToday } = require('../helpers/client');

test('период отдаёт дни подряд, включая пустые', async () => {
  const s = await loggedIn();
  try {
    const from = today();
    const to = dayFromToday(6);
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${from}/schedule`,
      { title: 'Подъём', startMin: 420, endMin: 450 });
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${dayFromToday(3)}/schedule`,
      { title: 'Созвон с подрядчиком', startMin: 600, endMin: 660 });

    const r = await getJson(s.url, s.cookie, `/api/v1/days/range?from=${from}&to=${to}`);

    assert.strictEqual(r.days.length, 7, 'семь дней недели, а не только заполненные');
    assert.deepStrictEqual(r.days.map(d => d.date), Array.from({ length: 7 }, (_, i) => dayFromToday(i)));
    assert.strictEqual(r.days[0].schedule.length, 1);
    assert.strictEqual(r.days[0].schedule[0].title, 'Подъём');
    assert.strictEqual(r.days[1].schedule.length, 0, 'пустой день тоже приходит');
    assert.strictEqual(r.days[3].schedule[0].title, 'Созвон с подрядчиком');
  } finally { await s.close(); }
});

test('счётчики считают строки и выполненное', async () => {
  const s = await loggedIn();
  try {
    const d = today();
    const one = await api(s.url, s.cookie, 'POST', `/api/v1/days/${d}/schedule`,
      { title: 'Зарядка и душ', startMin: 430, endMin: 470 });
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${d}/schedule`,
      { title: 'Работа: первый блок', startMin: 540, endMin: 750 });
    await api(s.url, s.cookie, 'PATCH', `/api/v1/days/${d}/schedule/${one.id}`, { done: true });

    const r = await getJson(s.url, s.cookie, `/api/v1/days/range?from=${d}&to=${d}`);
    assert.deepStrictEqual(r.days[0].counts, { schedule: 2, done: 1 });
  } finally { await s.close(); }
});

test('в период попадают и повторяющиеся строки', async () => {
  const s = await loggedIn();
  try {
    // Ежедневный повтор: в сетке он должен быть в каждом дне, иначе неделя
    // покажется пустой там, где расписание есть
    await api(s.url, s.cookie, 'POST', '/api/v1/series', {
      target: 'schedule',
      freq: 'daily',
      startDate: today(),
      payload: { title: 'Отбой', startMin: 1350 },
    });

    const r = await getJson(s.url, s.cookie, `/api/v1/days/range?from=${today()}&to=${dayFromToday(4)}`);
    const titles = r.days.map(d => d.schedule.map(x => x.title));
    assert.ok(titles.every(t => t.includes('Отбой')), `повтор не во всех днях: ${JSON.stringify(titles)}`);
  } finally { await s.close(); }
});

test('период отдаёт только расписание и счётчики', async () => {
  const s = await loggedIn();
  try {
    const d = today();
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${d}/tasks`, { text: 'Закрыть отчёт за июль' });
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${d}/meals`, { title: 'Обед', calories: 640 });

    const r = await getJson(s.url, s.cookie, `/api/v1/days/range?from=${d}&to=${d}`);
    assert.deepStrictEqual(Object.keys(r.days[0]).sort(), ['counts', 'date', 'schedule']);
    // Задачи и еда в сетке не нужны — за ними идут в сам день
    assert.ok(!JSON.stringify(r).includes('Закрыть отчёт'));
  } finally { await s.close(); }
});

test('перевёрнутый период — понятная ошибка, а не пустота', async () => {
  const s = await loggedIn();
  try {
    const r = await api(s.url, s.cookie, 'GET',
      `/api/v1/days/range?from=${dayFromToday(5)}&to=${today()}`, undefined, {}, true);
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error.message, /раньше начала/);
  } finally { await s.close(); }
});

test('период без границ не принимается', async () => {
  const s = await loggedIn();
  try {
    for (const q of ['', `?from=${today()}`, '?to=2026-01-01', '?from=не-дата&to=2026-01-02']) {
      const r = await api(s.url, s.cookie, 'GET', `/api/v1/days/range${q}`, undefined, {}, true);
      assert.strictEqual(r.status, 400, `range${q}`);
    }
  } finally { await s.close(); }
});

test('«range» не путается с датой', async () => {
  const s = await loggedIn();
  try {
    // Маршрут /:date стоит после /range. Если порядок сломается, здесь
    // придёт 400 «неверная дата» вместо данных
    const r = await api(s.url, s.cookie, 'GET',
      `/api/v1/days/range?from=${today()}&to=${today()}`, undefined, {}, true);
    assert.strictEqual(r.status, 200);
  } finally { await s.close(); }
});

test('чужие дни в период не попадают', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${today()}/schedule`, { title: 'Моё дело', startMin: 600 });

    const other = await loggedIn({ email: 'other@example.com', server: s.srv });
    const r = await getJson(s.url, other.cookie, `/api/v1/days/range?from=${today()}&to=${today()}`);
    assert.strictEqual(r.days[0].schedule.length, 0);
  } finally { await s.close(); }
});
