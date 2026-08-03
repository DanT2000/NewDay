const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, post } = require('../helpers/client');

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
