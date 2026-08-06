/**
 * Напоминание — это строка расписания без конца, и вокруг этого решения
 * собралась стайка ошибок, каждая из которых даёт человеку не то, что он
 * просил. Здесь они и заперты.
 */
const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, dayFromToday } = require('../helpers/client');

const DAY = () => dayFromToday(1);

const reminder = (extra = {}) => ({
  startMin: 600, endMin: null, title: 'Забрать документы',
  kind: 'reminder', alarmMode: 'notify', ...extra,
});

test('«к концу» принимает и строка расписания, не только приём пищи', async () => {
  const s = await loggedIn();
  try {
    const date = DAY();
    /*
     * Приём пищи окном ставит в расписание блок с теми же сроками, и «к концу
     * окна» уезжает в него. Раньше проверка строки отказывала: приём пищи
     * записывался, а блока к нему не появлялось — половина сохранена,
     * половина нет.
     */
    const row = await api(s.url, s.cookie, 'POST', `/api/v1/days/${date}/schedule`, {
      startMin: 720, endMin: 840, title: 'Обед окном', kind: 'meal',
      alarmMode: 'notify', remindBefore: [-1],
    });
    assert.strictEqual(JSON.parse(row.remind_before_json)[0], -1);
    // одиночное число — только настоящий срок: старый клиент прочитал бы −1
    // как «через минуту после начала»
    assert.strictEqual(row.remind_before_min, null);
  } finally { await s.close(); }
});

test('«к концу» у строки считается от её конца, а не от начала', async () => {
  const s = await loggedIn();
  try {
    const date = DAY();
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${date}/schedule`, {
      startMin: 720, endMin: 840, title: 'Обед окном', kind: 'meal',
      alarmMode: 'notify', remindBefore: [-1],
    });
    const { notificationService } = require('../../server/services/notificationService');
    const svc = notificationService(s.db, s.config);
    const user = s.db.prepare('SELECT * FROM users LIMIT 1').get();
    const planned = svc.planDay({ ...user, timezone: 'Europe/Moscow' }, date);
    assert.strictEqual(planned.planned, 1, JSON.stringify(planned));
    const row = s.db.prepare('SELECT * FROM notification_queue WHERE user_id = ?').get(user.id);
    const payload = JSON.parse(row.payload_json);
    // 14:00 — конец окна, а не 12:00
    assert.strictEqual(payload.startMin, 720);
    assert.match(payload.body, /заканчивается в 14:00/);
  } finally { await s.close(); }
});

test('строку можно привязать к повтору и отвязать', async () => {
  const s = await loggedIn();
  try {
    const date = DAY();
    const row = await api(s.url, s.cookie, 'POST', `/api/v1/days/${date}/schedule`, reminder());
    const rule = await api(s.url, s.cookie, 'POST', '/api/v1/series', {
      freq: 'daily', startDate: date, rows: [reminder()],
    });

    const linked = await api(s.url, s.cookie, 'POST',
      `/api/v1/days/${date}/schedule/${row.id}/series`, { seriesId: rule.id });
    assert.strictEqual(linked.series_id, rule.id);

    /*
     * Привязка нужна затем, что иначе сервер считает день недостроенным и
     * создаёт вторую такую же строку: человек видел близнеца.
     */
    const day = await getJson(s.url, s.cookie, `/api/v1/days/${date}/full`);
    assert.strictEqual(day.schedule.length, 1, JSON.stringify(day.schedule));

    const free = await api(s.url, s.cookie, 'POST',
      `/api/v1/days/${date}/schedule/${row.id}/series`, { seriesId: null });
    assert.strictEqual(free.series_id, null);
  } finally { await s.close(); }
});

test('чужое правило к своей строке не привязывается', async () => {
  const s = await loggedIn();
  try {
    const date = DAY();
    const row = await api(s.url, s.cookie, 'POST', `/api/v1/days/${date}/schedule`, reminder());
    const other = await loggedIn({ email: 'other@example.com', server: s.srv });
    const rule = await api(other.url, other.cookie, 'POST', '/api/v1/series', {
      freq: 'daily', startDate: date, rows: [reminder()],
    });
    const res = await api(s.url, s.cookie, 'POST',
      `/api/v1/days/${date}/schedule/${row.id}/series`, { seriesId: rule.id }, {}, true);
    assert.strictEqual(res.status, 404);
  } finally { await s.close(); }
});

test('отвязанная строка переживает удаление повтора', async () => {
  const s = await loggedIn();
  try {
    const date = DAY();
    /*
     * «Повтор: Разово» у повторяющейся строки значит «эту оставить, дальше не
     * повторять». Раньше это стирало и её саму: удаление правила забирало все
     * строки от сегодняшнего дня, включая только что отредактированную.
     */
    await api(s.url, s.cookie, 'POST', '/api/v1/series', {
      freq: 'daily', startDate: date, rows: [reminder()],
    });
    const day = await getJson(s.url, s.cookie, `/api/v1/days/${date}/full`);
    const row = day.schedule[0];
    const ruleId = row.series_id;
    assert.ok(ruleId, 'строка должна прийти из правила');

    await api(s.url, s.cookie, 'POST', `/api/v1/days/${date}/schedule/${row.id}/series`, { seriesId: null });
    await api(s.url, s.cookie, 'DELETE', `/api/v1/series/${ruleId}`);

    const after = await getJson(s.url, s.cookie, `/api/v1/days/${date}/full`);
    assert.strictEqual(after.schedule.length, 1, 'строка должна остаться');
    assert.strictEqual(after.schedule[0].title, 'Забрать документы');
    // а следующий день повтор уже не достраивает
    const next = await getJson(s.url, s.cookie, `/api/v1/days/${dayFromToday(2)}/full`);
    assert.strictEqual(next.schedule.length, 0);
  } finally { await s.close(); }
});

test('копия дня сохраняет связь приёма пищи с его блоком', async () => {
  const s = await loggedIn();
  try {
    const date = DAY();
    const target = dayFromToday(3);
    const block = await api(s.url, s.cookie, 'POST', `/api/v1/days/${date}/schedule`, {
      startMin: 720, endMin: 840, title: 'Обед', kind: 'meal', alarmMode: 'notify',
    });
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${date}/meals`, {
      title: 'Обед', timeMin: 720, endMin: 840, scheduleItemId: block.id, remindBefore: [0],
    });

    const copy = await api(s.url, s.cookie, 'POST', `/api/v1/days/${date}/copy-to`, { targetDate: target });
    const meal = copy.meals.find(m => m.title === 'Обед');
    const newBlock = copy.schedule.find(r => r.title === 'Обед');
    /*
     * Без перевода ссылки приём пищи в копии считал себя ничьим, и на один
     * обед приходило два уведомления: одно от блока, второе от него самого.
     */
    assert.strictEqual(meal.schedule_item_id, newBlock.id);
  } finally { await s.close(); }
});

test('приём пищи со своим блоком не уезжает в .ics вторым событием', async () => {
  const s = await loggedIn();
  try {
    const date = DAY();
    const block = await api(s.url, s.cookie, 'POST', `/api/v1/days/${date}/schedule`, {
      startMin: 720, endMin: 840, title: 'Обед окном', kind: 'meal',
    });
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${date}/meals`, {
      title: 'Обед окном', timeMin: 720, endMin: 840, scheduleItemId: block.id,
    });
    const res = await api(s.url, s.cookie, 'GET', '/api/v1/export.ics', undefined, {}, true);
    const text = await res.text();
    const count = text.split('SUMMARY:Обед окном').length - 1;
    assert.strictEqual(count, 1, 'событие должно быть одно');
  } finally { await s.close(); }
});

test('выгрузка и загрузка не плодят строки повтора', async () => {
  const s = await loggedIn();
  try {
    const date = DAY();
    await api(s.url, s.cookie, 'POST', '/api/v1/series', {
      freq: 'daily', startDate: date, rows: [reminder()],
    });
    const before = await getJson(s.url, s.cookie, `/api/v1/days/${date}/full`);
    assert.strictEqual(before.schedule.length, 1);

    const dump = await getJson(s.url, s.cookie, '/api/v1/export');
    await api(s.url, s.cookie, 'POST', '/api/v1/import', { data: dump, mode: 'replace' });

    /*
     * Раньше строка приезжала без `series_id`, повтор считал день пустым и
     * достраивал его ещё раз — на каждую загрузку выходила лишняя копия.
     */
    const after = await getJson(s.url, s.cookie, `/api/v1/days/${date}/full`);
    assert.strictEqual(after.schedule.length, 1, JSON.stringify(after.schedule));
  } finally { await s.close(); }
});

test('загрузка помнит день, из которого повтор убрали', async () => {
  const s = await loggedIn();
  try {
    const date = DAY();
    await api(s.url, s.cookie, 'POST', '/api/v1/series', {
      freq: 'daily', startDate: date, rows: [reminder()],
    });
    const day = await getJson(s.url, s.cookie, `/api/v1/days/${date}/full`);
    await api(s.url, s.cookie, 'DELETE', `/api/v1/days/${date}/schedule/${day.schedule[0].id}`);
    const cleared = await getJson(s.url, s.cookie, `/api/v1/days/${date}/full`);
    assert.strictEqual(cleared.schedule.length, 0, 'удаление одного дня должно держаться');

    const dump = await getJson(s.url, s.cookie, '/api/v1/export');
    await api(s.url, s.cookie, 'POST', '/api/v1/import', { data: dump, mode: 'replace' });

    // отметка «в этот день повтора нет» — часть плана, и восстановление её не теряет
    const after = await getJson(s.url, s.cookie, `/api/v1/days/${date}/full`);
    assert.strictEqual(after.schedule.length, 0, JSON.stringify(after.schedule));
  } finally { await s.close(); }
});
