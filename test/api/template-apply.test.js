/**
 * Применение общего расписания к дню.
 *
 * Нажать дважды — обычное дело: человек нажал, не понял, появилось ли,
 * нажал ещё раз. Раньше каждое нажатие добавляло все строки заново, и в дне
 * оказывалось два подъёма, два обеда и два отбоя.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, today, dayFromToday } = require('../helpers/client');

/** Именованное правило — это и есть «общее расписание». */
async function шаблон(s) {
  return api(s.url, s.cookie, 'POST', '/api/v1/series', {
    target: 'schedule', freq: 'daily', startDate: today(), name: 'Общее расписание',
    rows: [
      { title: 'Подъём', startMin: 420, endMin: 450 },
      { title: 'Обед', startMin: 780, endMin: 840 },
    ],
  });
}

test('второе применение шаблона не удваивает строки', async () => {
  const s = await loggedIn();
  try {
    const t = await шаблон(s);
    const день = dayFromToday(2);
    const первый = await api(s.url, s.cookie, 'POST', `/api/v1/series/${t.id}/apply`, { date: день });
    assert.strictEqual(первый.created, 2);

    const второй = await api(s.url, s.cookie, 'POST', `/api/v1/series/${t.id}/apply`, { date: день });
    assert.strictEqual(второй.created, 0, 'во второй раз дописывать нечего');

    const d = await getJson(s.url, s.cookie, `/api/v1/days/${день}/full`);
    const названия = d.schedule.map(r => r.title).sort();
    assert.deepStrictEqual(названия, ['Обед', 'Подъём'], JSON.stringify(названия));
  } finally { await s.close(); }
});

test('добавленная в шаблон строка доезжает в уже заполненный день', async () => {
  const s = await loggedIn();
  try {
    const t = await шаблон(s);
    const день = dayFromToday(2);
    await api(s.url, s.cookie, 'POST', `/api/v1/series/${t.id}/apply`, { date: день });

    // в шаблон добавили отбой
    await api(s.url, s.cookie, 'PATCH', `/api/v1/series/${t.id}`, {
      rows: [
        { title: 'Подъём', startMin: 420, endMin: 450 },
        { title: 'Обед', startMin: 780, endMin: 840 },
        { title: 'Отбой', startMin: 1350, endMin: 1380 },
      ],
    });
    const ещё = await api(s.url, s.cookie, 'POST', `/api/v1/series/${t.id}/apply`, { date: день });
    assert.strictEqual(ещё.created, 1, 'дописалась только новая строка');

    const d = await getJson(s.url, s.cookie, `/api/v1/days/${день}/full`);
    assert.strictEqual(d.schedule.length, 3, JSON.stringify(d.schedule.map(r => r.title)));
  } finally { await s.close(); }
});
