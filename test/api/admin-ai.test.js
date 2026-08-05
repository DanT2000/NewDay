const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, post, extractCookie } = require('../helpers/client');
const { startTestServer } = require('../helpers/server');

const KEY = 'sk-secret-value-0123456789';

/** Второй пользователь на том же сервере: первый становится админом. */
async function secondUser(srv) {
  await post(srv.url, '/api/v1/auth/register', { email: 'second@example.com', password: 'secret12' });
  const login = await post(srv.url, '/api/v1/auth/login',
    { emailOrUsername: 'second@example.com', password: 'secret12' });
  assert.strictEqual(login.status, 200);
  return extractCookie(login);
}

test('первый пользователь — админ, второй — нет', async () => {
  const s = await loggedIn();
  try {
    const first = await getJson(s.url, s.cookie, '/api/v1/settings');
    assert.strictEqual(first.isAdmin, true);

    const cookie2 = await secondUser(s.srv);
    const second = await getJson(s.url, cookie2, '/api/v1/settings');
    assert.strictEqual(second.isAdmin, false);
  } finally { await s.close(); }
});

test('обычный пользователь не видит и не меняет настройки ИИ', async () => {
  const s = await loggedIn();
  try {
    const cookie2 = await secondUser(s.srv);

    const read = await api(s.url, cookie2, 'GET', '/api/v1/admin/ai', undefined, {}, true);
    assert.strictEqual(read.status, 403);
    const body = await read.json();
    assert.strictEqual(body.error.code, 'NOT_ADMIN');

    const write = await api(s.url, cookie2, 'PATCH', '/api/v1/admin/ai',
      { baseUrl: 'https://evil.test/v1' }, {}, true);
    assert.strictEqual(write.status, 403);
  } finally { await s.close(); }
});

test('ключ наружу не отдаётся — только признак и хвост', async () => {
  const s = await loggedIn();
  try {
    const saved = await api(s.url, s.cookie, 'PATCH', '/api/v1/admin/ai', {
      baseUrl: 'https://api.aitunnel.ru/v1', model: 'gpt-4o-mini', apiKey: KEY, enabled: true,
    });
    assert.strictEqual(saved.hasKey, true);
    assert.strictEqual(saved.keyTail, KEY.slice(-4));
    assert.strictEqual(saved.ready, true);
    assert.ok(!JSON.stringify(saved).includes(KEY), 'ключа в ответе быть не должно');

    const again = await getJson(s.url, s.cookie, '/api/v1/admin/ai');
    assert.ok(!JSON.stringify(again).includes(KEY));
  } finally { await s.close(); }
});

test('пустой ключ не стирает сохранённый, null стирает', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'PATCH', '/api/v1/admin/ai', { apiKey: KEY });
    // Открытая форма не показывает ключ; сохранение с пустым полем не должно
    // его затирать, иначе любая правка модели убивала бы подключение
    const kept = await api(s.url, s.cookie, 'PATCH', '/api/v1/admin/ai', { apiKey: '', model: 'other' });
    assert.strictEqual(kept.hasKey, true);
    assert.strictEqual(kept.model, 'other');

    const cleared = await api(s.url, s.cookie, 'PATCH', '/api/v1/admin/ai', { apiKey: null });
    assert.strictEqual(cleared.hasKey, false);
  } finally { await s.close(); }
});

test('адрес без схемы отвергается', async () => {
  const s = await loggedIn();
  try {
    const res = await api(s.url, s.cookie, 'PATCH', '/api/v1/admin/ai',
      { baseUrl: 'api.aitunnel.ru/v1' }, {}, true);
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).error.code, 'BAD_URL');
  } finally { await s.close(); }
});

test('все пользователи видят только признак «ИИ готов»', async () => {
  const s = await loggedIn();
  try {
    const cookie2 = await secondUser(s.srv);

    let plain = await getJson(s.url, cookie2, '/api/v1/settings');
    assert.deepStrictEqual(plain.ai, { ready: false });

    await api(s.url, s.cookie, 'PATCH', '/api/v1/admin/ai', {
      baseUrl: 'https://api.aitunnel.ru/v1', model: 'gpt-4o-mini', apiKey: KEY, enabled: true,
    });

    plain = await getJson(s.url, cookie2, '/api/v1/settings');
    assert.deepStrictEqual(plain.ai, { ready: true }, 'подключённый ИИ доступен всем');
    assert.ok(!JSON.stringify(plain).includes(KEY));
  } finally { await s.close(); }
});

test('выключенный ИИ не считается готовым', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'PATCH', '/api/v1/admin/ai', {
      baseUrl: 'https://api.aitunnel.ru/v1', model: 'm', apiKey: KEY, enabled: false,
    });
    const me = await getJson(s.url, s.cookie, '/api/v1/settings');
    assert.strictEqual(me.ai.ready, false);
  } finally { await s.close(); }
});

test('проверка связи без адреса отвечает понятной ошибкой', async () => {
  const s = await startTestServer();
  try {
    await post(s.url, '/api/v1/auth/register', { email: 'a@b.test', password: 'secret12' });
    const login = await post(s.url, '/api/v1/auth/login', { emailOrUsername: 'a@b.test', password: 'secret12' });
    const cookie = extractCookie(login);

    const res = await api(s.url, cookie, 'POST', '/api/v1/admin/ai/test', {}, {}, true);
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).error.code, 'NO_URL');
  } finally { await s.close(); }
});

test('недоступный адрес не роняет проверку, а возвращает ok: false', async () => {
  const s = await loggedIn();
  try {
    // Порт, на котором заведомо никто не слушает
    await api(s.url, s.cookie, 'PATCH', '/api/v1/admin/ai',
      { baseUrl: 'http://127.0.0.1:9', model: 'm', enabled: true });
    const r = await api(s.url, s.cookie, 'POST', '/api/v1/admin/ai/test', {});
    assert.strictEqual(r.ok, false);
    assert.ok(r.message, 'должно быть объяснение');
  } finally { await s.close(); }
});
