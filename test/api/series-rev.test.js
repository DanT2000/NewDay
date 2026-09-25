/**
 * Версия дня после снятия повтора.
 *
 * `rev` — то, чем два устройства договариваются, кто правит свежее. Удаление
 * строк повтора меняет день, и если версия не растёт, телефон со старой копией
 * отправит день целиком, сервер сочтёт это свежей правкой — и снятые строки
 * вернутся.
 */
const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, today, dayFromToday } = require('../helpers/client');

test('снятие повтора двигает версию затронутых дней', async () => {
  const s = await loggedIn();
  try {
    const D = today();
    const завтра = dayFromToday(1);
    await api(s.url, s.cookie, 'POST', '/api/v1/series', {
      target: 'schedule', freq: 'daily', startDate: D,
      payload: { title: 'Зарядка', startMin: 420, endMin: 450 },
    });

    // достраиваем завтрашний день и запоминаем его версию
    const до = await getJson(s.url, s.cookie, `/api/v1/days/${завтра}/full`);
    const было = до.rev;
    assert.ok(до.schedule.some(r => r.title === 'Зарядка'), 'повтор достроил завтра');

    const правила = await getJson(s.url, s.cookie, '/api/v1/series');
    await api(s.url, s.cookie, 'DELETE', `/api/v1/series/${правила[0].id}?scope=future`);

    const после = await getJson(s.url, s.cookie, `/api/v1/days/${завтра}/full`);
    assert.ok(после.rev > было,
      `версия дня должна вырасти: было ${было}, стало ${после.rev}`);
  } finally { await s.close(); }
});
