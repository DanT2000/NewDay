/**
 * Повтор создания не делает вторую строку.
 *
 * Офлайн-очередь повторяет запрос, когда не дождалась ответа, — а ответ мог
 * и потеряться уже после того, как сервер всё записал. Без ключа человек
 * получил бы две одинаковые задачи и не понял, откуда.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, today } = require('../helpers/client');

test('два создания с одним ключом дают одну строку и один ответ', async () => {
  const s = await loggedIn();
  try {
    const D = today();
    const h = { 'Idempotency-Key': 'op-abc-123' };
    const первый = await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/tasks`, { text: 'хлеб' }, h);
    const второй = await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/tasks`, { text: 'хлеб' }, h);
    assert.strictEqual(второй.id, первый.id, 'ответ тот же самый');
    const день = await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`);
    const свои = [...день.tasks.work, ...день.tasks.home].filter(t => t.text === 'хлеб');
    assert.strictEqual(свои.length, 1, 'строка одна');
  } finally { await s.close(); }
});

test('разные ключи создают разные строки', async () => {
  const s = await loggedIn();
  try {
    const D = today();
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/tasks`, { text: 'молоко' }, { 'Idempotency-Key': 'op-1' });
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/tasks`, { text: 'молоко' }, { 'Idempotency-Key': 'op-2' });
    const день = await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`);
    const свои = [...день.tasks.work, ...день.tasks.home].filter(t => t.text === 'молоко');
    assert.strictEqual(свои.length, 2);
  } finally { await s.close(); }
});

test('ключ живёт внутри аккаунта, а не на весь сервер', async () => {
  const первый = await loggedIn();
  // тот же сервер и та же база: иначе ключи просто не встретятся
  const второй = await loggedIn({ server: первый.srv, email: 'other@example.com' });
  try {
    const D = today();
    const h = { 'Idempotency-Key': 'op-obshchiy' };
    await api(первый.url, первый.cookie, 'POST', `/api/v1/days/${D}/tasks`, { text: 'моё' }, h);
    const чужой = await api(второй.url, второй.cookie, 'POST', `/api/v1/days/${D}/tasks`, { text: 'чужое' }, h, true);
    assert.strictEqual(чужой.status, 201, 'чужой ключ не мешает');
    const день = await getJson(второй.url, второй.cookie, `/api/v1/days/${D}/full`);
    const свои = [...день.tasks.work, ...день.tasks.home];
    assert.strictEqual(свои.length, 1);
    assert.strictEqual(свои[0].text, 'чужое');
  } finally { await первый.close(); }
});

test('создание без ключа работает по-прежнему', async () => {
  const s = await loggedIn();
  try {
    const D = today();
    const r = await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/tasks`, { text: 'без ключа' }, {}, true);
    assert.strictEqual(r.status, 201);
  } finally { await s.close(); }
});

test('слишком длинный ключ отвергается, а не пишется в базу', async () => {
  const s = await loggedIn();
  try {
    const D = today();
    const r = await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/tasks`,
      { text: 'длинный ключ' }, { 'Idempotency-Key': 'x'.repeat(200) }, true);
    assert.strictEqual(r.status, 400);
  } finally { await s.close(); }
});

test('испорченный сохранённый ответ не превращается в дубль', async () => {
  const s = await loggedIn();
  try {
    const D = today();
    const h = { 'Idempotency-Key': 'op-broken-1' };
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/tasks`, { text: 'один раз' }, h);
    /*
     * Портим сохранённый ответ так, как это сделала бы повреждённая база.
     * Ключ хранится вместе с путём («…/tasks|op-broken-1»): один и тот же ключ
     * на разных путях — разные запросы, поэтому ищем по концу строки.
     */
    s.db.prepare("UPDATE op_keys SET body = '{не json' WHERE key LIKE ?").run('%op-broken-1');

    const второй = await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/tasks`, { text: 'один раз' }, h, true);
    assert.notStrictEqual(второй.status, 201, 'вторую строку не создаём');
    const день = await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`);
    const свои = [...день.tasks.work, ...день.tasks.home].filter(t => t.text === 'один раз');
    assert.strictEqual(свои.length, 1, 'строка осталась одна');
  } finally { await s.close(); }
});
