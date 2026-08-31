const test = require('node:test');
const assert = require('node:assert/strict');
const { loggedIn, api, getJson, dayFromToday } = require('../helpers/client');

/*
 * Интеграционный API: /integrations/apply.
 *
 * Смысл механики — идентичность записи парой source + externalId: повторный
 * запуск интеграции не плодит дубли, ручные правки человека неприкосновенны
 * (conflict с причиной), удалённое человеком не воскресает (надгробие).
 */

const D = dayFromToday(2);

const apply = (s, items, extra = {}) =>
  api(s.url, s.cookie, 'POST', '/api/v1/integrations/apply', { source: 'chatgpt', items, ...extra });

test('создание и идемпотичный повтор', async () => {
  const s = await loggedIn();
  try {
    const items = [{
      entity: 'schedule', externalId: 'evt-1', date: D,
      data: { time: '9:00-10:30', title: 'Отчёт', alarmMode: 'notify' },
    }];
    const first = await apply(s, items);
    assert.equal(first.results[0].status, 'created');
    assert.equal(first.counts.created, 1);

    const again = await apply(s, items);
    assert.equal(again.results[0].status, 'unchanged', 'повтор не меняет и не дублирует');

    const day = await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`);
    assert.equal(day.schedule.length, 1);
    assert.equal(day.schedule[0].source, 'chatgpt');
    assert.equal(day.schedule[0].external_id, 'evt-1');
    assert.equal(day.schedule[0].last_modified_by, 'chatgpt');
    assert.equal(day.schedule[0].start_min, 540);
  } finally { await s.close(); }
});

test('обновление — PATCH: непереданные поля не трогаются', async () => {
  const s = await loggedIn();
  try {
    await apply(s, [{ entity: 'schedule', externalId: 'evt-2', date: D,
      data: { startMin: 600, endMin: 660, title: 'Спорт', color: 'green' } }]);
    const r = await apply(s, [{ entity: 'schedule', externalId: 'evt-2', date: D,
      data: { title: 'Спорт в зале' } }]);
    assert.equal(r.results[0].status, 'updated');

    const day = await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`);
    const row = day.schedule.find(x => x.external_id === 'evt-2');
    assert.equal(row.title, 'Спорт в зале');
    assert.equal(row.color, 'green', 'цвет, которого не присылали, цел');
    assert.equal(row.start_min, 600);
  } finally { await s.close(); }
});

test('ручная правка священна: conflict / modified_by_user', async () => {
  const s = await loggedIn();
  try {
    const created = await apply(s, [{ entity: 'schedule', externalId: 'evt-3', date: D,
      data: { startMin: 700, title: 'Обед' } }]);
    const id = created.results[0].id;

    // человек правит строку обычным путём
    await api(s.url, s.cookie, 'PATCH', `/api/v1/days/${D}/schedule/${id}`, { title: 'Обед с командой' });

    const r = await apply(s, [{ entity: 'schedule', externalId: 'evt-3', date: D,
      data: { title: 'Обед (переписано ботом)' } }]);
    assert.equal(r.results[0].status, 'conflict');
    assert.equal(r.results[0].reason, 'modified_by_user');
    assert.equal(r.results[0].current.title, 'Обед с командой', 'в ответе текущее состояние');

    const day = await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`);
    assert.equal(day.schedule.find(x => x.external_id === 'evt-3').title, 'Обед с командой');
  } finally { await s.close(); }
});

test('удалённое человеком не воскресает: надгробие и его снятие', async () => {
  const s = await loggedIn();
  try {
    const created = await apply(s, [{ entity: 'schedule', externalId: 'evt-4', date: D,
      data: { startMin: 800, title: 'Звонок' } }]);
    await api(s.url, s.cookie, 'DELETE', `/api/v1/days/${D}/schedule/${created.results[0].id}`);

    const r = await apply(s, [{ entity: 'schedule', externalId: 'evt-4', date: D,
      data: { startMin: 800, title: 'Звонок' } }]);
    assert.equal(r.results[0].status, 'conflict');
    assert.equal(r.results[0].reason, 'removed_by_user');
    const day = await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`);
    assert.equal(day.schedule.filter(x => x.external_id === 'evt-4').length, 0, 'не воскресла');

    // человек передумал: надгробие снимается явно, запись можно создать снова
    await api(s.url, s.cookie, 'DELETE', '/api/v1/integrations/tombstones',
      { source: 'chatgpt', entity: 'schedule', externalId: 'evt-4', date: D });
    const back = await apply(s, [{ entity: 'schedule', externalId: 'evt-4', date: D,
      data: { startMin: 800, title: 'Звонок' } }]);
    assert.equal(back.results[0].status, 'created');
  } finally { await s.close(); }
});

test('delete: true удаляет своё, идемпотентно, без надгробия', async () => {
  const s = await loggedIn();
  try {
    await apply(s, [{ entity: 'task', externalId: 't-1', date: D, data: { text: 'Купить хлеб' } }]);
    const del = await apply(s, [{ entity: 'task', externalId: 't-1', date: D, delete: true }]);
    assert.equal(del.results[0].status, 'deleted');

    const again = await apply(s, [{ entity: 'task', externalId: 't-1', date: D, delete: true }]);
    assert.equal(again.results[0].status, 'unchanged', 'удаление отсутствующего — не ошибка');

    // своё удаление надгробия не ставит: интеграция вправе создать запись заново
    const back = await apply(s, [{ entity: 'task', externalId: 't-1', date: D, data: { text: 'Купить хлеб' } }]);
    assert.equal(back.results[0].status, 'created');
  } finally { await s.close(); }
});

test('чужую правленую запись delete не трогает', async () => {
  const s = await loggedIn();
  try {
    const created = await apply(s, [{ entity: 'task', externalId: 't-2', date: D, data: { text: 'Отчёт' } }]);
    await api(s.url, s.cookie, 'PATCH', `/api/v1/days/${D}/tasks/${created.results[0].id}`, { done: true });

    const r = await apply(s, [{ entity: 'task', externalId: 't-2', date: D, delete: true }]);
    assert.equal(r.results[0].status, 'conflict');
    assert.equal(r.results[0].reason, 'modified_by_user');
    // tasks в полном дне — объект с корзинами, а не общий список
    const day = await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`);
    assert.equal(day.tasks.work.length, 1, 'запись на месте');
  } finally { await s.close(); }
});

test('dryRun показывает исходы и ничего не пишет', async () => {
  const s = await loggedIn();
  try {
    const r = await apply(s, [{ entity: 'meal', externalId: 'm-1', date: D,
      data: { slot: 'lunch', title: 'Суп' } }], { dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.results[0].status, 'created');
    const day = await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`);
    assert.equal(day.meals.length, 0, 'в базе пусто');
  } finally { await s.close(); }
});

test('source валидируется: мусор не проходит', async () => {
  const s = await loggedIn();
  try {
    for (const bad of ['', 'плохой источник', 'a'.repeat(65), 'a b', 'x/../y']) {
      const res = await api(s.url, s.cookie, 'POST', '/api/v1/integrations/apply',
        { source: bad, items: [{ entity: 'task', externalId: 'z', date: D, data: { text: 'x' } }] },
        {}, true);
      assert.equal(res.status, 400, `source ${JSON.stringify(bad)} должен отвергаться`);
    }
  } finally { await s.close(); }
});

test('привычка: создание, обновление, архив по delete', async () => {
  const s = await loggedIn();
  try {
    const created = await apply(s, [{ entity: 'habit', externalId: 'h-1',
      data: { title: 'Вода', emoji: '💧' } }]);
    assert.equal(created.results[0].status, 'created');

    const upd = await apply(s, [{ entity: 'habit', externalId: 'h-1', data: { title: 'Вода 2 л' } }]);
    assert.equal(upd.results[0].status, 'updated');
    const list = await getJson(s.url, s.cookie, '/api/v1/habits');
    assert.equal(list.length, 1);
    assert.equal(list[0].title, 'Вода 2 л');
    assert.equal(list[0].emoji, '💧', 'PATCH-семантика и у привычек');

    const del = await apply(s, [{ entity: 'habit', externalId: 'h-1', delete: true }]);
    assert.equal(del.results[0].status, 'deleted');
    assert.equal((await getJson(s.url, s.cookie, '/api/v1/habits')).length, 0, 'ушла в архив');
  } finally { await s.close(); }
});

test('series: повтор создаётся и материализует день', async () => {
  const s = await loggedIn();
  try {
    const r = await apply(s, [{ entity: 'series', externalId: 's-1',
      data: { freq: 'daily', startDate: D, rows: [{ time: '07:00', title: 'Зарядка' }] } }]);
    assert.equal(r.results[0].status, 'created');
    const day = await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`);
    assert.ok(day.schedule.some(x => x.title === 'Зарядка'), 'повтор достроил день');
  } finally { await s.close(); }
});

test('токен со scope read в apply не пускается', async () => {
  const s = await loggedIn();
  try {
    const t = await api(s.url, s.cookie, 'POST', '/api/v1/tokens', { name: 'ro', scope: 'read' });
    const res = await fetch(`${s.url}/api/v1/integrations/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` },
      body: JSON.stringify({ source: 'chatgpt', items: [{ entity: 'task', externalId: 'q', date: D, data: { text: 'x' } }] }),
    });
    assert.equal(res.status, 403);
  } finally { await s.close(); }
});

test('лимит: больше 100 элементов — 400', async () => {
  const s = await loggedIn();
  try {
    const items = Array.from({ length: 101 }, (_, i) => ({
      entity: 'task', externalId: `mass-${i}`, date: D, data: { text: 'x' },
    }));
    const res = await api(s.url, s.cookie, 'POST', '/api/v1/integrations/apply',
      { source: 'chatgpt', items }, {}, true);
    assert.equal(res.status, 400);
  } finally { await s.close(); }
});

test('счётчики сходятся по батчу', async () => {
  const s = await loggedIn();
  try {
    await apply(s, [{ entity: 'task', externalId: 'c-1', date: D, data: { text: 'старая' } }]);
    const r = await apply(s, [
      { entity: 'task', externalId: 'c-1', date: D, data: { text: 'старая' } },        // unchanged
      { entity: 'task', externalId: 'c-2', date: D, data: { text: 'новая' } },         // created
    ]);
    assert.deepEqual(r.counts, { created: 1, updated: 0, unchanged: 1, deleted: 0, conflict: 0 });
  } finally { await s.close(); }
});
