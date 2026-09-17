/**
 * Целостность данных: случаи, где один неудачный набор записей ломает день
 * целиком или тихо портит содержимое.
 *
 * Все проверки здесь — воспроизведённые поломки, а не догадки.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, today, dayFromToday } = require('../helpers/client');

const задачи = day => [...day.tasks.work, ...day.tasks.home];

/** Включает перенос невыполненного и сдвигает дату включения в прошлое. */
function включитьПеренос(s) {
  return api(s.url, s.cookie, 'PATCH', '/api/v1/settings', { settings: { carryOver: true } })
    .then(() => s.db.prepare("UPDATE user_settings SET value = ? WHERE key = 'carryOverSince'")
      .run(JSON.stringify(dayFromToday(-30))));
}

test('задача из интеграции не ломает открытие сегодняшнего дня', async () => {
  const s = await loggedIn();
  try {
    await включитьПеренос(s);
    /*
     * У записей интеграции ключ — source + externalId + дата, и на него
     * стоит уникальный индекс. Перенос двигал такие задачи вместе с
     * остальными, а если такая же задача уже была на сегодня, UPDATE
     * упирался в индекс. Открытие сегодняшнего дня после этого отвечало
     * «внутренней ошибкой» при каждом запросе — день нельзя было ни
     * прочитать, ни починить из приложения.
     */
    const вчера = dayFromToday(-1);
    await api(s.url, s.cookie, 'POST', '/api/v1/integrations/apply', {
      source: 'todoist',
      items: [{ entity: 'task', externalId: 'T1', date: вчера, data: { text: 'вчерашняя из внешнего списка', bucket: 'work' } }],
    });
    await api(s.url, s.cookie, 'POST', '/api/v1/integrations/apply', {
      source: 'todoist',
      items: [{ entity: 'task', externalId: 'T1', date: today(), data: { text: 'сегодняшняя из внешнего списка', bucket: 'work' } }],
    });

    const r = await api(s.url, s.cookie, 'GET', `/api/v1/days/${today()}/full`, undefined, {}, true);
    assert.strictEqual(r.status, 200, 'сегодняшний день открывается');

    const день = await getJson(s.url, s.cookie, `/api/v1/days/${today()}/full`);
    const тексты = задачи(день).map(t => t.text);
    assert.ok(тексты.includes('сегодняшняя из внешнего списка'), 'своя задача дня на месте');

    // вчерашняя запись интеграции осталась в своём дне: ею владеет внешний список
    const вчерашний = await getJson(s.url, s.cookie, `/api/v1/days/${вчера}/full`);
    assert.deepStrictEqual(задачи(вчерашний).map(t => t.text), ['вчерашняя из внешнего списка']);
  } finally { await s.close(); }
});

test('обычные задачи переносятся, а задачи интеграции остаются в своём дне', async () => {
  const s = await loggedIn();
  try {
    await включитьПеренос(s);
    const вчера = dayFromToday(-1);
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${вчера}/tasks`, { text: 'моя невыполненная', bucket: 'home' });
    await api(s.url, s.cookie, 'POST', '/api/v1/integrations/apply', {
      source: 'todoist',
      items: [{ entity: 'task', externalId: 'T7', date: вчера, data: { text: 'из внешнего списка', bucket: 'work' } }],
    });

    const сегодня = await getJson(s.url, s.cookie, `/api/v1/days/${today()}/full`);
    assert.deepStrictEqual(задачи(сегодня).map(t => t.text), ['моя невыполненная'],
      'приехала только своя задача');
    const вчерашний = await getJson(s.url, s.cookie, `/api/v1/days/${вчера}/full`);
    assert.deepStrictEqual(задачи(вчерашний).map(t => t.text), ['из внешнего списка'],
      'запись интеграции осталась там, где её ждёт внешний список');
  } finally { await s.close(); }
});

test('вес дня проверяется, а не превращается молча в пустоту', async () => {
  const s = await loggedIn();
  try {
    const D = today();
    const rev = (await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`)).rev;
    const патч = (body, r) => api(s.url, s.cookie, 'PATCH', `/api/v1/days/${D}`, body, { 'If-Match': `"${r}"` }, true);

    const ок = await патч({ weight: 72.5 }, rev);
    assert.strictEqual(ок.status, 200);
    assert.strictEqual((await ок.json()).weight, 72.5);

    /*
     * Раньше вес шёл через голый Number(): «семьдесят» превращалось в NaN,
     * а better-sqlite3 молча писал NULL — человек вводил вес, получал 200 и
     * пустую графу. «1e400» уходило в базу как Infinity.
     */
    const словом = await патч({ weight: 'семьдесят' }, (await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`)).rev);
    assert.strictEqual(словом.status, 400, 'вес словом — отказ');
    const бесконечность = await патч({ weight: '1e400' }, (await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`)).rev);
    assert.strictEqual(бесконечность.status, 400, 'бесконечный вес — отказ');
    const отрицательный = await патч({ weight: -5 }, (await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`)).rev);
    assert.strictEqual(отрицательный.status, 400, 'отрицательный вес — отказ');

    const остался = await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`);
    assert.strictEqual(остался.weight, 72.5, 'прежний вес не потерян');

    // пустая строка и null по-прежнему означают «стереть»
    const стёрли = await патч({ weight: null }, остался.rev);
    assert.strictEqual(стёрли.status, 200);
    assert.strictEqual((await стёрли.json()).weight, null);
  } finally { await s.close(); }
});

test('заметка и заголовок дня ограничены по длине', async () => {
  const s = await loggedIn();
  try {
    const D = today();
    const rev = () => getJson(s.url, s.cookie, `/api/v1/days/${D}/full`).then(d => d.rev);
    const патч = async body => api(s.url, s.cookie, 'PATCH', `/api/v1/days/${D}`, body, { 'If-Match': `"${await rev()}"` }, true);

    /*
     * `POST /notes` ограничивает текст двадцатью тысячами знаков, а тот же
     * текст через день не ограничивался ничем: полтора мегабайта уезжали в
     * базу и потом приезжали в каждый список заметок.
     */
    const огромная = await патч({ notes: 'я'.repeat(60000) });
    assert.strictEqual(огромная.status, 400, 'заметка длиннее предела — отказ');
    const длинныйЗаголовок = await патч({ title: 'я'.repeat(5000) });
    assert.strictEqual(длинныйЗаголовок.status, 400, 'заголовок длиннее предела — отказ');

    const нормальная = await патч({ notes: 'обычная заметка' });
    assert.strictEqual(нормальная.status, 200, 'обычный текст сохраняется');
  } finally { await s.close(); }
});

test('отметка привычки поднимает версию дня', async () => {
  const s = await loggedIn();
  try {
    const D = today();
    const h = await api(s.url, s.cookie, 'POST', '/api/v1/habits', { title: 'Вода' });
    const до = (await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`)).rev;
    await api(s.url, s.cookie, 'PUT', `/api/v1/habits/${h.id}/log/${D}`, { status: 'done' });
    const после = (await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`)).rev;
    /*
     * День отдаёт привычки и прогресс, а ETag дня — это его rev. Пока
     * отметка привычки не поднимала версию, второе устройство продолжало
     * считать свою копию свежей и затирало её своей записью.
     */
    assert.ok(после > до, `версия дня выросла (${до} → ${после})`);

    const снято = (async () => {
      await api(s.url, s.cookie, 'DELETE', `/api/v1/habits/${h.id}/log/${D}`, undefined, {}, true);
      return (await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`)).rev;
    })();
    assert.ok(await снято > после, 'снятие отметки тоже поднимает версию');
  } finally { await s.close(); }
});

test('кривой файл выгрузки отклоняется, а не роняет импорт в базу', async () => {
  const s = await loggedIn();
  try {
    const кривые = await api(s.url, s.cookie, 'POST', '/api/v1/import', {
      data: { formatVersion: 1, days: [{ date: { $: 'x' }, title: 't' }] },
    }, {}, true);
    assert.strictEqual(кривые.status, 400, 'дата объектом — ошибка запроса, а не 500');

    const мусорныеДаты = await api(s.url, s.cookie, 'POST', '/api/v1/import', {
      data: {
        formatVersion: 1,
        days: [{ date: 'не-дата', title: 'x' }],
        scheduleItems: [{ date: '0000-00-00', start_min: -9999, end_min: 99999, title: 'x' }],
      },
    }, {}, true);
    assert.strictEqual(мусорныеДаты.status, 400, 'невозможные даты — отказ');

    const дни = await getJson(s.url, s.cookie, '/api/v1/days');
    const плохие = (дни.days ?? дни ?? []).filter?.(d => !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) ?? [];
    assert.strictEqual(плохие.length, 0, 'в базе не осталось дней с невозможной датой');
  } finally { await s.close(); }
});
