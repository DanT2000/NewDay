const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, post, extractCookie } = require('../helpers/client');
const { startTestServer } = require('../helpers/server');
const { isAdmin } = require('../../server/lib/admin');

// ── Кто админ ────────────────────────────────────────────────

test('админ определяется флагом в базе или адресом из окружения', () => {
  const cfg = { adminEmails: ['owner@example.com'] };
  assert.strictEqual(isAdmin({ is_admin: 1, email: 'x@y.z' }, cfg), true, 'флаг в базе');
  assert.strictEqual(isAdmin({ is_admin: 0, email: 'owner@example.com' }, cfg), true, 'адрес в списке');
  assert.strictEqual(isAdmin({ is_admin: 0, email: 'OWNER@Example.com' }, cfg), true, 'регистр не важен');
  assert.strictEqual(isAdmin({ is_admin: 0, email: 'other@example.com' }, cfg), false);
  assert.strictEqual(isAdmin(null, cfg), false);
  assert.strictEqual(isAdmin({ is_admin: 0, email: '' }, { adminEmails: [] }), false);
});

test('ADMIN_EMAILS делает админом того, у кого нет флага в базе', async () => {
  const s = await startTestServer({ env: { ADMIN_EMAILS: 'second@example.com' } });
  try {
    // первый — админ по флагу
    await post(s.url, '/api/v1/auth/register', { email: 'first@example.com', password: 'secret12' });
    // второй — админ только по списку адресов
    await post(s.url, '/api/v1/auth/register', { email: 'second@example.com', password: 'secret12' });
    const login = await post(s.url, '/api/v1/auth/login',
      { emailOrUsername: 'second@example.com', password: 'secret12' });
    const cookie = extractCookie(login);

    const me = await getJson(s.url, cookie, '/api/v1/settings');
    assert.strictEqual(me.isAdmin, true);

    const ai = await api(s.url, cookie, 'GET', '/api/v1/admin/ai', undefined, {}, true);
    assert.strictEqual(ai.status, 200, 'раздел ИИ доступен');
  } finally { await s.close(); }
});

test('без ADMIN_EMAILS второй пользователь админом не становится', async () => {
  const s = await startTestServer();
  try {
    await post(s.url, '/api/v1/auth/register', { email: 'first@example.com', password: 'secret12' });
    await post(s.url, '/api/v1/auth/register', { email: 'second@example.com', password: 'secret12' });
    const login = await post(s.url, '/api/v1/auth/login',
      { emailOrUsername: 'second@example.com', password: 'secret12' });
    const cookie = extractCookie(login);

    const me = await getJson(s.url, cookie, '/api/v1/settings');
    assert.strictEqual(me.isAdmin, false);
    const ai = await api(s.url, cookie, 'GET', '/api/v1/admin/ai', undefined, {}, true);
    assert.strictEqual(ai.status, 403);
  } finally { await s.close(); }
});

// ── Смена пароля ─────────────────────────────────────────────

test('пароль меняется и старый перестаёт работать', async () => {
  const s = await loggedIn({ email: 'user@example.com', password: 'secret12' });
  try {
    const ok = await api(s.url, s.cookie, 'POST', '/api/v1/auth/password',
      { currentPassword: 'secret12', newPassword: 'brandnew99' });
    assert.strictEqual(ok.success, true);

    const oldTry = await post(s.url, '/api/v1/auth/login',
      { emailOrUsername: 'user@example.com', password: 'secret12' });
    assert.strictEqual(oldTry.status, 401, 'старый пароль больше не подходит');

    const newTry = await post(s.url, '/api/v1/auth/login',
      { emailOrUsername: 'user@example.com', password: 'brandnew99' });
    assert.strictEqual(newTry.status, 200, 'новый работает');
  } finally { await s.close(); }
});

test('без верного текущего пароля смена не проходит', async () => {
  const s = await loggedIn({ email: 'user@example.com', password: 'secret12' });
  try {
    const res = await api(s.url, s.cookie, 'POST', '/api/v1/auth/password',
      { currentPassword: 'wrong-one', newPassword: 'brandnew99' }, {}, true);
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).error.code, 'BAD_PASSWORD');

    // старый пароль должен остаться рабочим
    const still = await post(s.url, '/api/v1/auth/login',
      { emailOrUsername: 'user@example.com', password: 'secret12' });
    assert.strictEqual(still.status, 200);
  } finally { await s.close(); }
});

test('новый пароль не может совпадать со старым и обязан быть длинным', async () => {
  const s = await loggedIn({ email: 'user@example.com', password: 'secret12' });
  try {
    const same = await api(s.url, s.cookie, 'POST', '/api/v1/auth/password',
      { currentPassword: 'secret12', newPassword: 'secret12' }, {}, true);
    assert.strictEqual(same.status, 400);

    const short = await api(s.url, s.cookie, 'POST', '/api/v1/auth/password',
      { currentPassword: 'secret12', newPassword: '123' }, {}, true);
    assert.strictEqual(short.status, 400);
  } finally { await s.close(); }
});

test('по токену пароль не меняется — только из живой сессии', async () => {
  const s = await loggedIn();
  try {
    const t = await api(s.url, s.cookie, 'POST', '/api/v1/tokens', { name: 'бот', scope: 'write' });
    const res = await fetch(`${s.url}/api/v1/auth/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` },
      body: JSON.stringify({ currentPassword: 'secret12', newPassword: 'brandnew99' }),
    });
    assert.strictEqual(res.status, 403, 'украденный токен не должен давать смену пароля');
  } finally { await s.close(); }
});
