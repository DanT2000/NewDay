const test = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const { startTestServer } = require('../helpers/server');
const { post, extractCookie } = require('../helpers/client');

const SMTP_ON = { SMTP_HOST: 'test.local', SMTP_FROM: 'no@reply.local' };
const tokenFrom = msg => msg.text.match(/token=([a-f0-9]+)/)[1];

test('регистрация создаёт неподтверждённого пользователя и шлёт письмо', async () => {
  const srv = await startTestServer({ env: SMTP_ON });
  try {
    const res = await post(srv.url, '/api/v1/auth/register', { email: 'a@b.ru', password: 'secret12' });
    assert.strictEqual(res.status, 200);
    const u = srv.db.prepare('SELECT * FROM users WHERE email = ?').get('a@b.ru');
    assert.strictEqual(u.email_verified, 0);
    assert.strictEqual(srv.app.locals.mailer.outbox.length, 1);
    assert.match(srv.app.locals.mailer.outbox[0].text, /\/api\/v1\/auth\/verify\?token=/);
  } finally { await srv.close(); }
});

test('без подтверждения вход закрыт', async () => {
  const srv = await startTestServer({ env: SMTP_ON });
  try {
    await post(srv.url, '/api/v1/auth/register', { email: 'a@b.ru', password: 'secret12' });
    const res = await post(srv.url, '/api/v1/auth/login', { emailOrUsername: 'a@b.ru', password: 'secret12' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).error.code, 'EMAIL_NOT_VERIFIED');
  } finally { await srv.close(); }
});

test('переход по ссылке подтверждает и открывает вход', async () => {
  const srv = await startTestServer({ env: SMTP_ON });
  try {
    await post(srv.url, '/api/v1/auth/register', { email: 'a@b.ru', password: 'secret12' });
    const token = tokenFrom(srv.app.locals.mailer.outbox[0]);
    const v = await fetch(`${srv.url}/api/v1/auth/verify?token=${token}`, { redirect: 'manual' });
    assert.ok([200, 302].includes(v.status), `неожиданный статус ${v.status}`);
    const res = await post(srv.url, '/api/v1/auth/login', { emailOrUsername: 'a@b.ru', password: 'secret12' });
    assert.strictEqual(res.status, 200);
  } finally { await srv.close(); }
});

test('ссылка подтверждения одноразовая', async () => {
  const srv = await startTestServer({ env: SMTP_ON });
  try {
    await post(srv.url, '/api/v1/auth/register', { email: 'a@b.ru', password: 'secret12' });
    const token = tokenFrom(srv.app.locals.mailer.outbox[0]);
    await fetch(`${srv.url}/api/v1/auth/verify?token=${token}`, { redirect: 'manual' });
    const again = await fetch(`${srv.url}/api/v1/auth/verify?token=${token}`, {
      headers: { accept: 'application/json' }, redirect: 'manual',
    });
    assert.strictEqual(again.status, 400);
  } finally { await srv.close(); }
});

test('без SMTP подтверждение отключено — вход сразу', async () => {
  const srv = await startTestServer();
  try {
    await post(srv.url, '/api/v1/auth/register', { email: 'a@b.ru', password: 'secret12' });
    const u = srv.db.prepare('SELECT email_verified FROM users WHERE email = ?').get('a@b.ru');
    assert.strictEqual(u.email_verified, 1, 'self-host без почты работает из коробки');
    const res = await post(srv.url, '/api/v1/auth/login', { emailOrUsername: 'a@b.ru', password: 'secret12' });
    assert.strictEqual(res.status, 200);
  } finally { await srv.close(); }
});

test('первый зарегистрировавшийся становится админом', async () => {
  const srv = await startTestServer();
  try {
    await post(srv.url, '/api/v1/auth/register', { email: 'a@b.ru', password: 'secret12' });
    await post(srv.url, '/api/v1/auth/register', { email: 'c@d.ru', password: 'secret12' });
    const rows = srv.db.prepare('SELECT email, is_admin FROM users ORDER BY id').all();
    assert.deepStrictEqual(rows.map(r => r.is_admin), [1, 0]);
  } finally { await srv.close(); }
});

test('повторная регистрация на тот же адрес отвергается', async () => {
  const srv = await startTestServer();
  try {
    await post(srv.url, '/api/v1/auth/register', { email: 'a@b.ru', password: 'secret12' });
    const res = await post(srv.url, '/api/v1/auth/register', { email: 'a@b.ru', password: 'other123' });
    assert.strictEqual(res.status, 400);
  } finally { await srv.close(); }
});

test('короткий пароль отвергается', async () => {
  const srv = await startTestServer();
  try {
    const res = await post(srv.url, '/api/v1/auth/register', { email: 'a@b.ru', password: '123' });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error.message, /8 символов/);
  } finally { await srv.close(); }
});

test('сброс пароля: токен одноразовый', async () => {
  const srv = await startTestServer({ env: SMTP_ON });
  try {
    await post(srv.url, '/api/v1/auth/register', { email: 'a@b.ru', password: 'secret12' });
    srv.app.locals.mailer.outbox.length = 0;
    await post(srv.url, '/api/v1/auth/forgot', { email: 'a@b.ru' });
    const token = tokenFrom(srv.app.locals.mailer.outbox[0]);

    const ok = await post(srv.url, '/api/v1/auth/reset', { token, password: 'newsecret12' });
    assert.strictEqual(ok.status, 200);
    const again = await post(srv.url, '/api/v1/auth/reset', { token, password: 'third12345' });
    assert.strictEqual(again.status, 400);

    const login = await post(srv.url, '/api/v1/auth/login',
      { emailOrUsername: 'a@b.ru', password: 'newsecret12' });
    assert.strictEqual(login.status, 200, 'новый пароль работает');
  } finally { await srv.close(); }
});

test('forgot на несуществующую почту отвечает 200 и ничего не шлёт', async () => {
  const srv = await startTestServer({ env: SMTP_ON });
  try {
    const res = await post(srv.url, '/api/v1/auth/forgot', { email: 'nobody@example.com' });
    assert.strictEqual(res.status, 200, 'не раскрываем, есть ли аккаунт');
    assert.strictEqual(srv.app.locals.mailer.outbox.length, 0);
  } finally { await srv.close(); }
});

test('legacy-пользователь входит по username и может привязать почту', async () => {
  const srv = await startTestServer();
  try {
    srv.db.prepare('INSERT INTO users (username, password_hash, email_verified) VALUES (?,?,1)')
      .run('dan', bcrypt.hashSync('oldpass12', 10));

    const login = await post(srv.url, '/api/v1/auth/login',
      { emailOrUsername: 'dan', password: 'oldpass12' });
    assert.strictEqual(login.status, 200);
    const cookie = extractCookie(login);

    const bind = await post(srv.url, '/api/v1/auth/bind-email', { email: 'dan@b.ru' }, { cookie });
    assert.strictEqual(bind.status, 200);
    const u = srv.db.prepare('SELECT email FROM users WHERE username = ?').get('dan');
    assert.strictEqual(u.email, 'dan@b.ru');
  } finally { await srv.close(); }
});

test('неаутентифицированный запрос к /api/v1 даёт 401', async () => {
  const srv = await startTestServer();
  try {
    const res = await fetch(`${srv.url}/api/v1/tokens`);
    assert.strictEqual(res.status, 401);
    assert.strictEqual((await res.json()).error.code, 'UNAUTHORIZED');
  } finally { await srv.close(); }
});
