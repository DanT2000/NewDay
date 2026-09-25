/**
 * Пределы попыток и вход в панель.
 *
 * Два разных вреда с одной стороны монеты: слишком слабый предел открывает
 * подбор пароля, слишком слепой — запирает дверь тому, кто набрал верно.
 * Здесь сторожим и то, и другое.
 */

const test = require('node:test');
const assert = require('node:assert');
const { startTestServer } = require('../helpers/server');
const { локальныйАдрес } = require('../../server/lib/net');

const post = (url, path, body, headers = {}) => fetch(url + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

test('череда чужих регистраций не запирает вход человеку с верным паролем', async () => {
  const srv = await startTestServer();
  try {
    await post(srv.url, '/api/v1/auth/register', { email: 'a@b.ru', password: 'secret12' });
    // столько же попыток, сколько раньше съедал общий предел на всё
    for (let i = 0; i < 12; i++) {
      await post(srv.url, '/api/v1/auth/register', { email: `x${i}@b.ru`, password: 'secret12' });
    }
    const вход = await post(srv.url, '/api/v1/auth/login',
      { emailOrUsername: 'a@b.ru', password: 'secret12' });
    assert.strictEqual(вход.status, 200,
      `вход должен работать, получили ${вход.status}: предел регистрации не его дело`);
  } finally { await srv.close(); }
});

test('подбор пароля к одному аккаунту всё равно останавливается', async () => {
  const srv = await startTestServer();
  try {
    await post(srv.url, '/api/v1/auth/register', { email: 'a@b.ru', password: 'secret12' });
    let последний = 0;
    for (let i = 0; i < 14; i++) {
      const r = await post(srv.url, '/api/v1/auth/login',
        { emailOrUsername: 'a@b.ru', password: `неверный${i}` });
      последний = r.status;
    }
    assert.strictEqual(последний, 429, `после череды неудач ждали 429, получили ${последний}`);
  } finally { await srv.close(); }
});

test('чужие неудачи не мешают войти под своим логином', async () => {
  const srv = await startTestServer();
  try {
    await post(srv.url, '/api/v1/auth/register', { email: 'a@b.ru', password: 'secret12' });
    await post(srv.url, '/api/v1/auth/register', { email: 'b@b.ru', password: 'secret12' });
    for (let i = 0; i < 14; i++) {
      await post(srv.url, '/api/v1/auth/login', { emailOrUsername: 'b@b.ru', password: 'ой' });
    }
    const вход = await post(srv.url, '/api/v1/auth/login',
      { emailOrUsername: 'a@b.ru', password: 'secret12' });
    assert.strictEqual(вход.status, 200,
      'перебор соседнего аккаунта с того же адреса не запирает этот');
  } finally { await srv.close(); }
});

test('верный пароль обнуляет счётчик неудач', async () => {
  const srv = await startTestServer();
  try {
    await post(srv.url, '/api/v1/auth/register', { email: 'a@b.ru', password: 'secret12' });
    for (let i = 0; i < 8; i++) {
      await post(srv.url, '/api/v1/auth/login', { emailOrUsername: 'a@b.ru', password: 'ой' });
    }
    const ок = await post(srv.url, '/api/v1/auth/login',
      { emailOrUsername: 'a@b.ru', password: 'secret12' });
    assert.strictEqual(ок.status, 200);
    for (let i = 0; i < 8; i++) {
      await post(srv.url, '/api/v1/auth/login', { emailOrUsername: 'a@b.ru', password: 'ой' });
    }
    const снова = await post(srv.url, '/api/v1/auth/login',
      { emailOrUsername: 'a@b.ru', password: 'secret12' });
    assert.strictEqual(снова.status, 200, 'после успеха счёт начинается заново');
  } finally { await srv.close(); }
});

// ── Панель ──────────────────────────────────────────────────

test('заводской пароль панели работает с локальной машины', async () => {
  const srv = await startTestServer();
  try {
    // тестовый сервер слушает 127.0.0.1 — это и есть локальный случай
    const r = await post(srv.url, '/api/admin/login', { password: 'newday' });
    assert.strictEqual(r.status, 200, 'свежий сервер должен настраиваться');
    assert.strictEqual((await r.json()).mustChangePassword, true, 'и просить сменить пароль');
  } finally { await srv.close(); }
});

test('заводской пароль панели не работает из интернета', async () => {
  // TRUST_PROXY включён, как на живом сервере за обратным прокси: адрес
  // запроса берётся из X-Forwarded-For
  const srv = await startTestServer({ env: { TRUST_PROXY: '1' } });
  try {
    /*
     * Запрос из-за обратного прокси: адрес приходит в X-Forwarded-For, и
     * `trust proxy` делает его адресом запроса. Раньше «newday» с чужого
     * адреса открывало панель со списком людей, кодами приглашений и
     * ключами помощника.
     */
    const r = await post(srv.url, '/api/admin/login', { password: 'newday' },
      { 'X-Forwarded-For': '203.0.113.9' });
    assert.strictEqual(r.status, 401, `ожидали отказ, получили ${r.status}`);
  } finally { await srv.close(); }
});

test('пароль из окружения сильнее заводского', async () => {
  const srv = await startTestServer({ env: { ADMIN_PASSWORD: 'своё-длинное-слово' } });
  try {
    const заводской = await post(srv.url, '/api/admin/login', { password: 'newday' });
    assert.strictEqual(заводской.status, 401, 'заводской больше не подходит');
    const свой = await post(srv.url, '/api/admin/login', { password: 'своё-длинное-слово' });
    assert.strictEqual(свой.status, 200, 'а заданный в окружении — да');
  } finally { await srv.close(); }
});

test('свои и чужие адреса различаются верно', () => {
  for (const свой of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '172.18.0.1',
    '192.168.1.5', '169.254.1.1', 'fd00::1', 'fe80::1']) {
    assert.strictEqual(локальныйАдрес(свой), true, `${свой} — свой`);
  }
  for (const чужой of ['203.0.113.9', '8.8.8.8', '172.32.0.1', '11.0.0.1',
    '2a00:1450:4010::1', '', null]) {
    assert.strictEqual(локальныйАдрес(чужой), false, `${чужой} — чужой`);
  }
});
