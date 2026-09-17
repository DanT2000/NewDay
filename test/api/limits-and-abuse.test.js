/**
 * Пределы и злоупотребления: что может сделать с сервером один клиент —
 * свой, чужой или просто сломавшийся.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, post, today } = require('../helpers/client');

test('порядок записей нельзя переставить списком на сотни тысяч номеров', async () => {
  const s = await loggedIn();
  try {
    /*
     * `reorder` выполняет по одному UPDATE на номер в одной транзакции.
     * Двести тысяч номеров укладываются в лимит тела и блокируют базу и
     * event loop на минуты — сервер стоит для всех.
     */
    const row = await api(s.url, s.cookie, 'POST', `/api/v1/days/${today()}/schedule`,
      { title: 'строка', startMin: 600, endMin: 660 });
    const ids = Array.from({ length: 200000 }, () => row.id);
    const t = Date.now();
    const r = await api(s.url, s.cookie, 'POST', `/api/v1/days/${today()}/schedule/reorder`, { ids }, {}, true);
    const прошло = Date.now() - t;
    assert.strictEqual(r.status, 400, 'слишком длинный список — отказ');
    assert.ok(прошло < 5000, `отказ быстрый (${прошло} мс)`);
  } finally { await s.close(); }
});

test('настройки не резиновые', async () => {
  const s = await loggedIn();
  try {
    /*
     * `settings` — свободный мешок ключ-значение, он же приезжает в каждый
     * ответ о входе и в каждый GET настроек. Без предела один аккаунт
     * раздувает базу и свои же ответы до мегабайтов.
     */
    const огромный = await api(s.url, s.cookie, 'PATCH', '/api/v1/settings',
      { settings: { заметка: 'я'.repeat(200000) } }, {}, true);
    assert.strictEqual(огромный.status, 400, 'значение в 200 КБ — отказ');

    const многоКлючей = {};
    for (let i = 0; i < 500; i += 1) многоКлючей[`ключ${i}`] = i;
    const частый = await api(s.url, s.cookie, 'PATCH', '/api/v1/settings', { settings: многоКлючей }, {}, true);
    assert.strictEqual(частый.status, 400, 'пятьсот ключей за раз — отказ');

    const обычные = await api(s.url, s.cookie, 'PATCH', '/api/v1/settings',
      { settings: { carryOver: true, accent: 'violet' } }, {}, true);
    assert.strictEqual(обычные.status, 200, 'обычные настройки сохраняются');
  } finally { await s.close(); }
});

test('ограничение попыток входа не обходится вторым адресом того же маршрута', async () => {
  const s = await loggedIn();
  try {
    /*
     * Роутер входа смонтирован дважды: /api/v1/auth и /api/auth. Каждый
     * вызов создавал свой счётчик попыток, и «десять за пятнадцать минут»
     * на деле означало двадцать — достаточно чередовать адреса.
     */
    let отказов = 0;
    for (let i = 0; i < 12; i += 1) {
      const r = await post(s.url, '/api/v1/auth/login', { emailOrUsername: 'user@example.com', password: 'неверный' });
      if (r.status === 429) { отказов += 1; break; }
    }
    assert.ok(отказов > 0, 'первый адрес ограничивает попытки');

    const второй = await post(s.url, '/api/auth/login', { emailOrUsername: 'user@example.com', password: 'неверный' });
    assert.strictEqual(второй.status, 429, 'второй адрес считает те же попытки');
  } finally { await s.close(); }
});

test('подписка на уведомления не отправляет сервер по произвольному адресу', async () => {
  const s = await loggedIn({
    env: {
      VAPID_PUBLIC_KEY: 'BFvQ0zP9r4kF1k2z0Q0Wl8k7QpQ8u1Zb7hYyq9x3bYb9qQ8y4Q1W2e3R4t5Y6u7I8o9P0a1S2d3F4g5H6j7K8l9',
      VAPID_PRIVATE_KEY: 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef_',
    },
  });
  try {
    /*
     * Адрес подписки проверялся только на длину, а потом сервер сам ходил
     * по нему запросом. Это способ заставить сервер стучаться во
     * внутреннюю сеть — служебный адрес облака, соседний контейнер,
     * админка на localhost.
     */
    const ключи = { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) };
    for (const endpoint of [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:3000/api/admin',
      'https://localhost/секрет',
      'file:///etc/passwd',
      'https://10.0.0.5/push',
    ]) {
      const r = await api(s.url, s.cookie, 'POST', '/api/v1/push/subscribe',
        { subscription: { endpoint, keys: ключи } }, {}, true);
      assert.strictEqual(r.status, 400, `адрес «${endpoint}» отклонён`);
    }

    const обычный = await api(s.url, s.cookie, 'POST', '/api/v1/push/subscribe',
      { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: ключи } }, {}, true);
    assert.strictEqual(обычный.status, 201, 'настоящая подписка принимается');
  } finally { await s.close(); }
});
