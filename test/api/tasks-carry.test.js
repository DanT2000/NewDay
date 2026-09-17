/**
 * Перенос невыполненных задач на сегодня.
 *
 * Переключатель «Переносить невыполненное» в настройках был, а переноса не
 * было: он остался в старых маршрутах со старым хранилищем дня. Человек не
 * закрыл во вторник две задачи, открыл среду — и там пусто. Проверяем то, из
 * чего эта механика состоит: переезжает только невыполненное, только в
 * сегодня, только при включённом переключателе, дважды не задваивается, не
 * глубже трёх дней и не из дней до того, как перенос включили.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, today, dayFromToday } = require('../helpers/client');

const задачи = day => [...day.tasks.work, ...day.tasks.home];
const текст = day => задачи(day).map(t => t.text).sort();

/**
 * Включает перенос. Сервер ставит датой включения сегодня — а проверкам
 * нужны задачи из прошлых дней, поэтому дату включения сдвигаем назад, как у
 * человека, который пользуется переносом давно.
 */
async function стенд(s, { carryOver = true, включёнДнейНазад = 30 } = {}) {
  await api(s.url, s.cookie, 'PATCH', '/api/v1/settings', { settings: { carryOver } });
  if (carryOver && включёнДнейНазад) {
    s.db.prepare("UPDATE user_settings SET value = ? WHERE key = 'carryOverSince'")
      .run(JSON.stringify(dayFromToday(-включёнДнейНазад)));
  }
}

test('невыполненное вчерашнее оказывается в сегодня, с пометкой откуда', async () => {
  const s = await loggedIn();
  try {
    await стенд(s);
    const вчера = dayFromToday(-1);
    const незакрытая = await api(s.url, s.cookie, 'POST', `/api/v1/days/${вчера}/tasks`,
      { text: 'определить незакрытые задачи по Агрофарму', bucket: 'work' });
    const сделанная = await api(s.url, s.cookie, 'POST', `/api/v1/days/${вчера}/tasks`,
      { text: 'продвинуть основную задачу', bucket: 'work' });
    await api(s.url, s.cookie, 'PATCH', `/api/v1/days/${вчера}/tasks/${сделанная.id}`, { done: true });

    const сегодня = await getJson(s.url, s.cookie, `/api/v1/days/${today()}/full`);
    const приехала = задачи(сегодня).find(t => t.id === незакрытая.id);
    assert.ok(приехала, 'невыполненная задача переехала в сегодня');
    assert.strictEqual(приехала.carried_from, вчера, 'видно, с какого дня приехала');
    assert.strictEqual(приехала.done, 0);

    const было = await getJson(s.url, s.cookie, `/api/v1/days/${вчера}/full`);
    assert.deepStrictEqual(текст(было), ['продвинуть основную задачу'],
      'выполненная осталась во вчера, невыполненная уехала');
  } finally { await s.close(); }
});

test('перенос повторяется день за днём, а первый день остаётся в пометке', async () => {
  const s = await loggedIn();
  try {
    await стенд(s);
    const позавчера = dayFromToday(-2);
    const задача = await api(s.url, s.cookie, 'POST', `/api/v1/days/${позавчера}/tasks`,
      { text: 'парсер фриланс-бирж', bucket: 'work' });

    // первый переезд: позавчера → сегодня
    await getJson(s.url, s.cookie, `/api/v1/days/${today()}/full`);
    // второй запрос ничего не должен менять
    const сегодня = await getJson(s.url, s.cookie, `/api/v1/days/${today()}/full`);
    const приехала = задачи(сегодня).filter(t => t.text === 'парсер фриланс-бирж');
    assert.strictEqual(приехала.length, 1, 'задача одна, а не по копии на каждое открытие');
    assert.strictEqual(приехала[0].id, задача.id, 'та же самая запись, а не новая');
    assert.strictEqual(приехала[0].carried_from, позавчера, 'в пометке первый день, а не вчерашний');
  } finally { await s.close(); }
});

test('такая же задача на сегодня уже есть — прошлая остаётся в своём дне', async () => {
  const s = await loggedIn();
  try {
    await стенд(s);
    const вчера = dayFromToday(-1);
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${вчера}/tasks`,
      { text: 'Купить  хлеб', bucket: 'home' });
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${today()}/tasks`,
      { text: 'купить хлеб', bucket: 'home' });

    const сегодня = await getJson(s.url, s.cookie, `/api/v1/days/${today()}/full`);
    assert.strictEqual(задачи(сегодня).length, 1, 'дубля по тексту не появилось');
    const было = await getJson(s.url, s.cookie, `/api/v1/days/${вчера}/full`);
    assert.strictEqual(задачи(было).length, 1, 'прошлая осталась там, где была');
  } finally { await s.close(); }
});

test('выключенный переключатель ничего не переносит', async () => {
  const s = await loggedIn();
  try {
    await стенд(s, { carryOver: false });
    const вчера = dayFromToday(-1);
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${вчера}/tasks`,
      { text: 'разобрать почту', bucket: 'work' });

    const сегодня = await getJson(s.url, s.cookie, `/api/v1/days/${today()}/full`);
    assert.strictEqual(задачи(сегодня).length, 0);
    const было = await getJson(s.url, s.cookie, `/api/v1/days/${вчера}/full`);
    assert.strictEqual(задачи(было).length, 1);
  } finally { await s.close(); }
});

test('завтрашний день не вытягивает несделанное, и глубже трёх дней не тянем', async () => {
  const s = await loggedIn();
  try {
    await стенд(s);
    const вчера = dayFromToday(-1);
    const давно = dayFromToday(-5);
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${вчера}/tasks`,
      { text: 'вчерашняя', bucket: 'work' });
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${давно}/tasks`,
      { text: 'пятидневной давности', bucket: 'work' });

    // открытая завтрашняя страница не должна забирать задачу из вчера себе
    const завтра = await getJson(s.url, s.cookie, `/api/v1/days/${dayFromToday(1)}/full`);
    assert.strictEqual(задачи(завтра).length, 0, 'завтра к себе ничего не тянет');

    const сегодня = await getJson(s.url, s.cookie, `/api/v1/days/${today()}/full`);
    assert.deepStrictEqual(текст(сегодня), ['вчерашняя'], 'приехало только недавнее');
    const старое = await getJson(s.url, s.cookie, `/api/v1/days/${давно}/full`);
    assert.deepStrictEqual(текст(старое), ['пятидневной давности'], 'давнее осталось в своём дне');
  } finally { await s.close(); }
});

test('задачи из дней до включения переноса остаются на месте', async () => {
  const s = await loggedIn();
  try {
    const вчера = dayFromToday(-1);
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${вчера}/tasks`,
      { text: 'сделал, но не отметил', bucket: 'home' });
    // включил сегодня — вчерашнее к переносу не относится
    await стенд(s, { включёнДнейНазад: 0 });

    const сегодня = await getJson(s.url, s.cookie, `/api/v1/days/${today()}/full`);
    assert.strictEqual(задачи(сегодня).length, 0, 'ничего не приехало');
    const было = await getJson(s.url, s.cookie, `/api/v1/days/${вчера}/full`);
    assert.deepStrictEqual(текст(было), ['сделал, но не отметил']);
  } finally { await s.close(); }
});

test('включение ставит дату, выключение снимает, а подделать её клиент не может', async () => {
  const s = await loggedIn();
  try {
    const настройки = () => getJson(s.url, s.cookie, '/api/v1/settings').then(r => r.settings);
    await api(s.url, s.cookie, 'PATCH', '/api/v1/settings', { settings: { carryOver: true } });
    assert.strictEqual((await настройки()).carryOverSince, today());

    // клиент не может сам выставить дату включения
    await api(s.url, s.cookie, 'PATCH', '/api/v1/settings', { settings: { carryOverSince: '2020-01-01' } });
    assert.strictEqual((await настройки()).carryOverSince, today());

    // повторное «включить», когда уже включено, дату не сдвигает
    s.db.prepare("UPDATE user_settings SET value = ? WHERE key = 'carryOverSince'")
      .run(JSON.stringify(dayFromToday(-2)));
    await api(s.url, s.cookie, 'PATCH', '/api/v1/settings', { settings: { carryOver: true } });
    assert.strictEqual((await настройки()).carryOverSince, dayFromToday(-2));

    await api(s.url, s.cookie, 'PATCH', '/api/v1/settings', { settings: { carryOver: false } });
    assert.strictEqual((await настройки()).carryOverSince, null);
  } finally { await s.close(); }
});
