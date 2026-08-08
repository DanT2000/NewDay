const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, post, today } = require('../helpers/client');

test('токен создаётся, секрет показывается один раз', async () => {
  const s = await loggedIn();
  try {
    const created = await api(s.url, s.cookie, 'POST', '/api/v1/tokens', { name: 'LLM', scope: 'write' });
    assert.match(created.token, /^nd_[a-f0-9]{8}_[a-f0-9]{64}$/);

    const list = await getJson(s.url, s.cookie, '/api/v1/tokens');
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].token, undefined, 'секрета в списке нет');
    assert.strictEqual(list[0].token_hash, undefined, 'хеша в списке тоже нет');
    assert.strictEqual(list[0].prefix, created.token.split('_')[1]);
  } finally { await s.close(); }
});

test('read-токен читает, но не пишет', async () => {
  const s = await loggedIn();
  try {
    const { token } = await api(s.url, s.cookie, 'POST', '/api/v1/tokens', { name: 'ro', scope: 'read' });
    const h = { Authorization: `Bearer ${token}` };

    const get = await fetch(`${s.url}/api/v1/tokens`, { headers: h });
    assert.strictEqual(get.status, 200);

    const write = await fetch(`${s.url}/api/v1/devices/1`, { method: 'DELETE', headers: h });
    assert.strictEqual(write.status, 403);
    assert.strictEqual((await write.json()).error.code, 'INSUFFICIENT_SCOPE');
  } finally { await s.close(); }
});

/*
 * Прав «только чтение» не должно хватать нигде, а не только под /api/v1.
 *
 * Проверка scope висела на одном мониторе — /api/v1, — а старые пути (/api/days,
 * /api/habits) и выгрузка с загрузкой смонтированы прямо под /api и требовали
 * лишь входа. Токен, выданный для чтения, мог переписать день, завести привычку
 * и — через /api/import в режиме «заменить» — стереть человеку всё.
 */
test('read-токен не пишет и на старых путях', async () => {
  const s = await loggedIn();
  try {
    const { token } = await api(s.url, s.cookie, 'POST', '/api/v1/tokens', { name: 'ro', scope: 'read' });
    const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const d = today();

    // сначала кладём день сессией — потом смотрим, что токен его не тронул
    await api(s.url, s.cookie, 'PUT', `/api/days/${d}`, { title: 'Мой день' });

    const cases = [
      ['POST', `/api/days`, { date: d, title: 'угнал' }],
      ['PUT', `/api/days/${d}`, { title: 'угнал' }],
      ['DELETE', `/api/days/${d}`, undefined],
      ['POST', '/api/habits', { title: 'чужая привычка' }],
      ['POST', '/api/import', { mode: 'replace', data: { formatVersion: 1, days: [] } }],
    ];
    for (const [method, path, body] of cases) {
      const res = await fetch(`${s.url}${path}`, {
        method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.strictEqual(res.status, 403, `${method} ${path} должен быть закрыт для read-токена`);
      assert.strictEqual((await res.json()).error.code, 'INSUFFICIENT_SCOPE', `${method} ${path}`);
    }

    // читать по-прежнему можно, и день остался на месте
    const read = await fetch(`${s.url}/api/days/${d}`, { headers: h });
    assert.strictEqual(read.status, 200);
    assert.strictEqual((await read.json()).title, 'Мой день');
    const habits = await fetch(`${s.url}/api/habits`, { headers: h });
    assert.strictEqual((await habits.json()).length, 0, 'привычка не завелась');
  } finally { await s.close(); }
});

/*
 * «Когда пользовались» — единственное, по чему в списке видно живой токен и
 * забытый. Троттлинг записи держался в кеше на весь процесс и ключевался
 * одним номером строки, поэтому токены разных баз с одинаковым номером
 * считались одним и тем же: второй показывался как ни разу не использованный.
 * Ровно это уже исправляли у устройств (repos/devices) — здесь осталось.
 */
test('«когда пользовались» пишется у каждого экземпляра базы', async () => {
  const a = await loggedIn({ email: 'a@example.com' });
  const b = await loggedIn({ email: 'b@example.com' });
  try {
    const ta = await api(a.url, a.cookie, 'POST', '/api/v1/tokens', { name: 'A', scope: 'read' });
    const tb = await api(b.url, b.cookie, 'POST', '/api/v1/tokens', { name: 'B', scope: 'read' });
    assert.strictEqual(ta.id, tb.id, 'номера строк в разных базах совпадают — на этом и ловилось');

    for (const [srv, t] of [[a, ta], [b, tb]]) {
      const r = await fetch(`${srv.url}/api/v1/tokens`, { headers: { Authorization: `Bearer ${t.token}` } });
      assert.strictEqual(r.status, 200);
    }

    for (const srv of [a, b]) {
      const list = await getJson(srv.url, srv.cookie, '/api/v1/tokens');
      assert.ok(list[0].last_used_at, 'токеном только что пользовались — это должно быть видно');
    }
  } finally { await a.close(); await b.close(); }
});

test('отозванный токен не работает', async () => {
  const s = await loggedIn();
  try {
    const created = await api(s.url, s.cookie, 'POST', '/api/v1/tokens', { name: 't', scope: 'write' });
    await api(s.url, s.cookie, 'DELETE', `/api/v1/tokens/${created.id}`);
    const res = await fetch(`${s.url}/api/v1/tokens`, {
      headers: { Authorization: `Bearer ${created.token}` },
    });
    assert.strictEqual(res.status, 401);
  } finally { await s.close(); }
});

test('подделанный секрет с верным префиксом не проходит', async () => {
  const s = await loggedIn();
  try {
    const created = await api(s.url, s.cookie, 'POST', '/api/v1/tokens', { name: 't', scope: 'write' });
    const [, prefix] = created.token.split('_');
    const forged = `nd_${prefix}_${'a'.repeat(64)}`;
    const res = await fetch(`${s.url}/api/v1/tokens`, { headers: { Authorization: `Bearer ${forged}` } });
    assert.strictEqual(res.status, 401);
  } finally { await s.close(); }
});

test('токеном нельзя создать другой токен', async () => {
  const s = await loggedIn();
  try {
    const { token } = await api(s.url, s.cookie, 'POST', '/api/v1/tokens', { name: 't', scope: 'write' });
    const res = await fetch(`${s.url}/api/v1/tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ещё один', scope: 'write' }),
    });
    assert.strictEqual(res.status, 403);
  } finally { await s.close(); }
});

test('пейринг: код одноразовый и выдаёт рабочий device-токен', async () => {
  const s = await loggedIn();
  try {
    const pair = await api(s.url, s.cookie, 'POST', '/api/v1/auth/pair/create');
    assert.match(pair.shortCode, /^\d{4}-\d{4}$/);
    assert.ok(pair.url.endsWith(`/pair#${pair.code}`));

    const claimed = await post(s.url, '/api/v1/auth/pair/claim',
      { code: pair.code, deviceName: 'Pixel 7', platform: 'android' });
    assert.strictEqual(claimed.status, 200);
    const { token } = await claimed.json();
    assert.match(token, /^ndd_[a-f0-9]{8}_[a-f0-9]{64}$/);

    const me = await fetch(`${s.url}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    assert.strictEqual(me.status, 200);
    assert.strictEqual((await me.json()).auth.kind, 'device');

    const again = await post(s.url, '/api/v1/auth/pair/claim', { code: pair.code, deviceName: 'Вор' });
    assert.strictEqual(again.status, 400);
  } finally { await s.close(); }
});

test('короткий код тоже принимается', async () => {
  const s = await loggedIn();
  try {
    const pair = await api(s.url, s.cookie, 'POST', '/api/v1/auth/pair/create');
    const res = await post(s.url, '/api/v1/auth/pair/claim',
      { code: pair.shortCode, deviceName: 'Ноутбук' });
    assert.strictEqual(res.status, 200);
  } finally { await s.close(); }
});

test('просроченный код не принимается', async () => {
  const s = await loggedIn();
  try {
    const pair = await api(s.url, s.cookie, 'POST', '/api/v1/auth/pair/create');
    s.db.prepare('UPDATE pair_codes SET expires_at = ?').run(Date.now() - 1000);
    const res = await post(s.url, '/api/v1/auth/pair/claim', { code: pair.code, deviceName: 'X' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).error.details.code, 'PAIR_CODE_INVALID');
  } finally { await s.close(); }
});

test('вход из приложения: голое «Android» заменяется моделью, в списке виден адрес', async () => {
  const s = await loggedIn();
  try {
    const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UP1A.231005.007; wv) '
      + 'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36';
    const login = await post(s.url, '/api/v1/auth/login', {
      emailOrUsername: 'user@example.com', password: 'secret12',
      issueDeviceToken: true, deviceName: 'Android', platform: 'android',
    }, { 'User-Agent': ua });
    assert.strictEqual(login.status, 200);
    const { deviceToken } = await login.json();
    assert.ok(deviceToken);

    // Адрес пишется при обращении с токеном устройства, не при выдаче
    const me = await fetch(`${s.url}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
    });
    assert.strictEqual(me.status, 200);

    const list = await getJson(s.url, s.cookie, '/api/v1/devices');
    const dev = list.find(d => d.name === 'Pixel 7');
    assert.ok(dev, 'голое «Android» заменилось моделью из User-Agent');
    assert.match(String(dev.lastIp), /127\.0\.0\.1/, 'после запроса известен адрес устройства');
  } finally { await s.close(); }
});

test('отзыв устройства убивает токен немедленно', async () => {
  const s = await loggedIn();
  try {
    const pair = await api(s.url, s.cookie, 'POST', '/api/v1/auth/pair/create');
    const { token, device } = await (await post(s.url, '/api/v1/auth/pair/claim',
      { code: pair.code, deviceName: 'Pixel 7' })).json();

    const list = await getJson(s.url, s.cookie, '/api/v1/devices');
    assert.strictEqual(list.length, 1);

    await api(s.url, s.cookie, 'DELETE', `/api/v1/devices/${device.id}`);
    const me = await fetch(`${s.url}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    assert.strictEqual(me.status, 401);
  } finally { await s.close(); }
});
