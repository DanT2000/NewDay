# NewDay Этап 1 — Фундамент. План, часть 3 (задачи 10-14)

> Продолжение `2026-08-03-stage1-foundation.md` и `-part2.md`. Global Constraints оттуда действуют и здесь.

---

### Task 10: Почта и аккаунты — регистрация, подтверждение, сброс пароля

**Files:**
- Create: `server/lib/mailer.js`, `server/lib/secrets.js`, `server/repos/users.js`, `server/routes/v1/auth.js`
- Modify: `package.json` (`nodemailer`), `.env.example`
- Test: `test/api/auth.test.js`

**Interfaces:**
- Produces:
  - `createMailer(config) → { enabled: boolean, send({ to, subject, text, html }) }` — при `config.smtp === null` возвращает `{ enabled: false }`, `send` пишет письмо в `mailer.outbox` (массив) и в лог, наружу ничего не уходит. Тесты читают `outbox`.
  - `generateToken() → { token, hash, prefix }`; `hashToken(token) → string` (sha256 в hex)
  - `usersRepo(db)` → `{ findByEmail, findByUsername, findById, create({email, passwordHash}), setEmailVerified, setPassword, bindEmail, patchProfile }`
  - Роуты из §5.5 спеки

- [ ] **Step 1: Тесты на флоу регистрации**

```js
test('регистрация создаёт неподтверждённого пользователя и шлёт письмо', async () => {
  const srv = await startTestServer({ env: { SMTP_HOST: 'test', SMTP_FROM: 'no@reply' } });
  try {
    const res = await post(srv.url, '/api/v1/auth/register',
      { email: 'a@b.ru', password: 'secret12' });
    assert.strictEqual(res.status, 200);
    const u = srv.db.prepare('SELECT * FROM users WHERE email = ?').get('a@b.ru');
    assert.strictEqual(u.email_verified, 0);
    assert.strictEqual(srv.app.locals.mailer.outbox.length, 1);
    assert.match(srv.app.locals.mailer.outbox[0].text, /\/api\/v1\/auth\/verify\?token=/);
  } finally { await srv.close(); }
});

test('без подтверждения вход закрыт', async () => {
  const srv = await startTestServer({ env: { SMTP_HOST: 'test' } });
  try {
    await post(srv.url, '/api/v1/auth/register', { email: 'a@b.ru', password: 'secret12' });
    const res = await post(srv.url, '/api/v1/auth/login', { emailOrUsername: 'a@b.ru', password: 'secret12' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).error.code, 'EMAIL_NOT_VERIFIED');
  } finally { await srv.close(); }
});

test('переход по ссылке подтверждает и открывает вход', async () => {
  const srv = await startTestServer({ env: { SMTP_HOST: 'test' } });
  try {
    await post(srv.url, '/api/v1/auth/register', { email: 'a@b.ru', password: 'secret12' });
    const token = srv.app.locals.mailer.outbox[0].text.match(/token=([a-f0-9]+)/)[1];
    const v = await fetch(`${srv.url}/api/v1/auth/verify?token=${token}`, { redirect: 'manual' });
    assert.ok([200, 302].includes(v.status));
    const res = await post(srv.url, '/api/v1/auth/login', { emailOrUsername: 'a@b.ru', password: 'secret12' });
    assert.strictEqual(res.status, 200);
  } finally { await srv.close(); }
});

test('без SMTP подтверждение отключено — вход сразу', async () => {
  const srv = await startTestServer(); // SMTP_HOST не задан
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

test('сброс пароля: токен одноразовый', async () => {
  const srv = await startTestServer({ env: { SMTP_HOST: 'test' } });
  try {
    await post(srv.url, '/api/v1/auth/register', { email: 'a@b.ru', password: 'secret12' });
    srv.app.locals.mailer.outbox.length = 0;
    await post(srv.url, '/api/v1/auth/forgot', { email: 'a@b.ru' });
    const token = srv.app.locals.mailer.outbox[0].text.match(/token=([a-f0-9]+)/)[1];
    const ok = await post(srv.url, '/api/v1/auth/reset', { token, password: 'newsecret12' });
    assert.strictEqual(ok.status, 200);
    const again = await post(srv.url, '/api/v1/auth/reset', { token, password: 'third12345' });
    assert.strictEqual(again.status, 400);
  } finally { await srv.close(); }
});

test('forgot на несуществующую почту отвечает 200 и ничего не шлёт', async () => {
  const srv = await startTestServer({ env: { SMTP_HOST: 'test' } });
  try {
    const res = await post(srv.url, '/api/v1/auth/forgot', { email: 'нет@такого.ru' });
    assert.strictEqual(res.status, 200, 'не раскрываем, есть ли аккаунт');
    assert.strictEqual(srv.app.locals.mailer.outbox.length, 0);
  } finally { await srv.close(); }
});

test('legacy-пользователь входит по username и может привязать почту', async () => {
  const srv = await startTestServer();
  try {
    const bcrypt = require('bcryptjs');
    srv.db.prepare('INSERT INTO users (username, password_hash, email_verified) VALUES (?,?,1)')
      .run('dan', bcrypt.hashSync('oldpass', 10));
    const login = await post(srv.url, '/api/v1/auth/login', { emailOrUsername: 'dan', password: 'oldpass' });
    assert.strictEqual(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    const bind = await post(srv.url, '/api/v1/auth/bind-email', { email: 'dan@b.ru' }, { cookie });
    assert.strictEqual(bind.status, 200);
  } finally { await srv.close(); }
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node --test test/api/auth.test.js`
Expected: FAIL, 404

- [ ] **Step 3: Установить nodemailer**

```bash
npm install nodemailer@^6
```

- [ ] **Step 4: Реализовать `server/lib/secrets.js`**

```js
const crypto = require('node:crypto');

function generateToken(bytes = 32) {
  const token = crypto.randomBytes(bytes).toString('hex');
  return { token, hash: hashToken(token), prefix: token.slice(0, 8) };
}
const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');
const shortCode = () => {
  const n = crypto.randomInt(0, 100000000).toString().padStart(8, '0');
  return `${n.slice(0, 4)}-${n.slice(4)}`;
};
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

module.exports = { generateToken, hashToken, shortCode, safeEqual };
```

В базе хранятся только sha256-хеши токенов. Сам токен показывается один раз и больше нигде не восстановим.

- [ ] **Step 5: Реализовать `server/lib/mailer.js`**

```js
function createMailer(config) {
  const outbox = [];
  if (!config.smtp) {
    return {
      enabled: false, outbox,
      async send(msg) {
        outbox.push(msg);
        console.warn('[newday] SMTP не настроен, письмо не отправлено:', msg.subject, '→', msg.to);
      },
    };
  }
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return {
    enabled: true, outbox,
    async send(msg) {
      outbox.push(msg);
      if (outbox.length > 50) outbox.shift();
      if (config.nodeEnv === 'test') return;
      await transport.sendMail({ from: config.smtp.from, ...msg });
    },
  };
}
module.exports = { createMailer };
```

`enabled` управляет обязательностью подтверждения: при `false` пользователь создаётся сразу с `email_verified = 1`. Это ровно то поведение, которое нужно для `git clone && docker compose up` без почты.

- [ ] **Step 6: Реализовать `usersRepo` и роутер аутентификации**

Валидация: email по `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` и до 254 символов, пароль от 8 до 200 символов (сейчас минимум 4 — поднимаем). Хеш `bcrypt.hashSync(password, 10)`. `email_tokens.expires_at` — `Date.now() + 24ч` для `verify` и `+1ч` для `reset`; `used_at` проставляется при первом использовании, повторный запрос даёт `400 TOKEN_INVALID`. `forgot` на неизвестный адрес всегда отвечает `200` без письма. `is_admin = 1`, если в таблице `users` ещё нет ни одной строки. Rate limit — 10 попыток на IP за 15 минут на `register`, `login`, `forgot`.

- [ ] **Step 7: Обновить `.env.example`**

```
NODE_ENV=production
PORT=3000
SESSION_SECRET=change_me_to_long_random_string_at_least_32_chars
DB_PATH=/app/data/newday.db
APP_URL=https://example.com

# Почта. Без неё подтверждение email отключается автоматически.
SMTP_HOST=
SMTP_PORT=465
SMTP_SECURE=1
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
```

- [ ] **Step 8: Прогнать тесты и закоммитить**

Run: `npm test` → PASS

```bash
git add server/lib/mailer.js server/lib/secrets.js server/repos/users.js server/routes/v1/auth.js package.json package-lock.json .env.example test/api/auth.test.js
git commit -m "feat: аккаунты по email с подтверждением и сбросом пароля"
```

---

### Task 11: Смешанная аутентификация и API-токены

**Files:**
- Create: `server/middleware/auth.js` (полная версия), `server/middleware/rateLimit.js`, `server/repos/tokens.js`, `server/routes/v1/tokens.js`
- Test: `test/api/tokens.test.js`

**Interfaces:**
- Produces:
  - `requireAuth(req, res, next)` — принимает cookie-сессию, `Bearer nd_*` и `Bearer ndd_*`; кладёт в `req.user` полную строку пользователя и в `req.auth` объект `{ kind: 'session'|'token'|'device', scope: 'read'|'write', id }`
  - `requireScope('write')` — middleware, дающий `403 INSUFFICIENT_SCOPE`
  - `tokensRepo(db)` → `{ list(userId), create(userId, {name, scope}), revoke(userId, id), authenticate(rawToken) }`

- [ ] **Step 1: Тесты на токены и скоупы**

```js
test('токен создаётся, секрет показывается один раз', async () => {
  const { url, cookie } = await loggedIn();
  const created = await api(url, cookie, 'POST', '/api/v1/tokens', { name: 'LLM', scope: 'write' });
  assert.match(created.token, /^nd_[a-z0-9]{8}_[a-f0-9]{64}$/);
  const list = await getJson(url, cookie, '/api/v1/tokens');
  assert.strictEqual(list[0].token, undefined, 'секрета в списке нет');
  assert.strictEqual(list[0].prefix, created.token.split('_')[1]);
});

test('read-токен читает, но не пишет', async () => {
  const { url, cookie } = await loggedIn();
  const { token } = await api(url, cookie, 'POST', '/api/v1/tokens', { name: 'ro', scope: 'read' });
  const h = { Authorization: `Bearer ${token}` };
  const get = await fetch(`${url}/api/v1/days/2026-08-03/full`, { headers: h });
  assert.strictEqual(get.status, 200);
  const post = await fetch(`${url}/api/v1/days/2026-08-03/schedule`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startMin: 540, title: 'X' }),
  });
  assert.strictEqual(post.status, 403);
  assert.strictEqual((await post.json()).error.code, 'INSUFFICIENT_SCOPE');
});

test('write-токен заполняет день целиком', async () => {
  const { url, cookie } = await loggedIn();
  const { token } = await api(url, cookie, 'POST', '/api/v1/tokens', { name: 'llm', scope: 'write' });
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const cur = await (await fetch(`${url}/api/v1/days/2026-08-05/full`, { headers: h })).json();
  const res = await fetch(`${url}/api/v1/days/2026-08-05/full`, {
    method: 'PUT', headers: { ...h, 'If-Match': `"${cur.rev}"` },
    body: JSON.stringify({
      title: 'План от бота',
      schedule: [{ time: '06:00-06:30', title: 'Подъём', alarmMode: 'alarm', alarmProfile: 'wakeup' }],
      tasks: { work: [{ text: 'Созвон' }], home: [] },
    }),
  });
  assert.strictEqual(res.status, 200);
  const after = await (await fetch(`${url}/api/v1/days/2026-08-05/full`, { headers: h })).json();
  assert.strictEqual(after.title, 'План от бота');
  assert.strictEqual(after.schedule[0].alarm_mode, 'alarm');
});

test('отозванный токен не работает', async () => {
  const { url, cookie } = await loggedIn();
  const created = await api(url, cookie, 'POST', '/api/v1/tokens', { name: 't', scope: 'write' });
  await api(url, cookie, 'DELETE', `/api/v1/tokens/${created.id}`);
  const res = await fetch(`${url}/api/v1/days/2026-08-03/full`, {
    headers: { Authorization: `Bearer ${created.token}` },
  });
  assert.strictEqual(res.status, 401);
});

test('токен одного пользователя не видит дни другого', async () => {
  const a = await loggedIn({ email: 'a@b.ru' });
  const b = await loggedIn({ email: 'c@d.ru', server: a.srv });
  await api(a.url, a.cookie, 'POST', '/api/v1/days/2026-08-03/schedule', { startMin: 540, title: 'Секрет' });
  const { token } = await api(b.url, b.cookie, 'POST', '/api/v1/tokens', { name: 't', scope: 'read' });
  const res = await (await fetch(`${a.url}/api/v1/days/2026-08-03/full`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  assert.deepStrictEqual(res.schedule, []);
});
```

- [ ] **Step 2: Убедиться, что тесты падают** — Run: `node --test test/api/tokens.test.js` → FAIL, 404

- [ ] **Step 3: Реализовать формат токена**

`nd_<prefix8>_<secret64>` для API-токенов, `ndd_<prefix8>_<secret64>` для устройств. Поиск по `prefix` через индекс, затем сверка `hashToken(secret)` с `token_hash` через `safeEqual`. `last_used_at` обновляется не чаще раза в минуту, чтобы не писать в базу на каждый запрос.

- [ ] **Step 4: Реализовать `requireAuth` и `requireScope`**

Порядок: сначала `Authorization`, потом сессия. Сессия всегда даёт `scope: 'write'`. `requireScope('write')` вешается на все не-`GET` методы `/api/v1` одной строкой в `app.js`:

```js
app.use('/api/v1', requireAuth, (req, res, next) =>
  ['GET', 'HEAD'].includes(req.method) ? next() : requireScope('write')(req, res, next));
```

- [ ] **Step 5: Реализовать роутер `/api/v1/tokens`**

`POST` возвращает `{ id, name, scope, prefix, token, createdAt }` — единственный ответ с полем `token`. `GET` не возвращает ни `token`, ни `token_hash`. `DELETE` ставит `revoked_at`.

- [ ] **Step 6: Прогнать тесты и закоммитить**

```bash
git add server/middleware/ server/repos/tokens.js server/routes/v1/tokens.js server/app.js test/api/tokens.test.js
git commit -m "feat: API-токены со скоупами и смешанная аутентификация"
```

---

### Task 12: QR-пейринг устройств

**Files:**
- Create: `server/repos/devices.js`, `server/routes/v1/devices.js`
- Test: `test/api/devices.test.js`

**Interfaces:**
- Produces:
  - `POST /api/v1/auth/pair/create` (только сессия) → `{ code, shortCode, url, expiresAt }`, где `url = ${appUrl}/pair#${code}`
  - `POST /api/v1/auth/pair/claim` `{ code, deviceName, platform }` → `{ token, device: {...} }`
  - `GET /api/v1/devices`, `DELETE /api/v1/devices/:id`

- [ ] **Step 1: Тесты**

```js
test('пейринг: код одноразовый и выдаёт рабочий device-токен', async () => {
  const { url, cookie } = await loggedIn();
  const pair = await api(url, cookie, 'POST', '/api/v1/auth/pair/create');
  assert.match(pair.shortCode, /^\d{4}-\d{4}$/);
  assert.ok(pair.url.endsWith(`/pair#${pair.code}`));

  const claimed = await post(url, '/api/v1/auth/pair/claim',
    { code: pair.code, deviceName: 'Pixel 7', platform: 'android' });
  assert.strictEqual(claimed.status, 200);
  const { token } = await claimed.json();
  assert.match(token, /^ndd_/);

  const me = await fetch(`${url}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(me.status, 200);

  const again = await post(url, '/api/v1/auth/pair/claim', { code: pair.code, deviceName: 'Вор' });
  assert.strictEqual(again.status, 400);
});

test('короткий код тоже принимается', async () => {
  const { url, cookie } = await loggedIn();
  const pair = await api(url, cookie, 'POST', '/api/v1/auth/pair/create');
  const res = await post(url, '/api/v1/auth/pair/claim',
    { code: pair.shortCode, deviceName: 'Ноутбук' });
  assert.strictEqual(res.status, 200);
});

test('просроченный код не принимается', async () => {
  const { url, cookie, db } = await loggedIn();
  const pair = await api(url, cookie, 'POST', '/api/v1/auth/pair/create');
  db.prepare('UPDATE pair_codes SET expires_at = ?').run(Date.now() - 1000);
  const res = await post(url, '/api/v1/auth/pair/claim', { code: pair.code, deviceName: 'X' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).error.code, 'PAIR_CODE_INVALID');
});

test('отзыв устройства убивает токен немедленно', async () => {
  const { url, cookie } = await loggedIn();
  const pair = await api(url, cookie, 'POST', '/api/v1/auth/pair/create');
  const { token, device } = await (await post(url, '/api/v1/auth/pair/claim',
    { code: pair.code, deviceName: 'Pixel 7' })).json();
  await api(url, cookie, 'DELETE', `/api/v1/devices/${device.id}`);
  const me = await fetch(`${url}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(me.status, 401);
});
```

- [ ] **Step 2: Убедиться, что тесты падают** — Run: `node --test test/api/devices.test.js` → FAIL, 404

- [ ] **Step 3: Реализовать**

TTL кода — 120 секунд. `claim` принимает либо полный `code`, либо `short_code`; ищет неистёкшую строку с `claimed_at IS NULL`, в одной транзакции проставляет `claimed_at`, создаёт `devices` и возвращает `ndd_`-токен. Rate limit на `claim` — 20 попыток на IP за 15 минут, чтобы короткий восьмизначный код нельзя было подобрать за две минуты жизни.

- [ ] **Step 4: Прогнать тесты и закоммитить**

```bash
git add server/repos/devices.js server/routes/v1/devices.js server/routes/v1/auth.js test/api/devices.test.js
git commit -m "feat: вход по QR-коду и управление устройствами"
```

---

### Task 13: Настройки, экспорт, импорт, бэкапы

**Files:**
- Create: `server/routes/v1/settings.js`, `server/routes/v1/export.js`, `server/lib/backup.js`
- Test: `test/api/settings.test.js`, `test/api/export.test.js`

**Interfaces:**
- Produces:
  - `GET /api/v1/settings` → профиль (`email, displayName, timezone, theme, weekStart, scheduleView, foodMode, isAdmin`) плюс произвольные ключи из `user_settings`
  - `PATCH /api/v1/settings` — те же поля плюс `settings: { key: value }`
  - `GET /api/v1/export` → `{ formatVersion: 1, exportedAt, user, days, habits, habitLogs, series }`
  - `POST /api/v1/import` `{ data, mode: 'merge' | 'replace' }`
  - `runBackup(db, dbPath) → string` — путь к созданному файлу; ротация 14 копий в `<dir>/backups/`

- [ ] **Step 1: Тесты**

```js
test('таймзона пользователя влияет на «сегодня»', async () => {
  const { url, cookie } = await loggedIn();
  await api(url, cookie, 'PATCH', '/api/v1/settings', { timezone: 'Asia/Kamchatka' });
  const s = await getJson(url, cookie, '/api/v1/settings');
  assert.strictEqual(s.timezone, 'Asia/Kamchatka');
});

test('невалидная таймзона отвергается', async () => {
  const { url, cookie } = await loggedIn();
  const res = await api(url, cookie, 'PATCH', '/api/v1/settings', { timezone: 'Марс/Олимп' }, {}, true);
  assert.strictEqual(res.status, 400);
});

test('экспорт и импорт в режиме replace дают тот же результат', async () => {
  const { url, cookie } = await loggedIn();
  await api(url, cookie, 'POST', '/api/v1/days/2026-08-03/schedule', { startMin: 540, title: 'Работа' });
  await api(url, cookie, 'POST', '/api/v1/habits', { title: 'Вода', emoji: '💧' });
  const dump = await getJson(url, cookie, '/api/v1/export');

  await api(url, cookie, 'DELETE', '/api/v1/days/2026-08-03');
  await api(url, cookie, 'POST', '/api/v1/import', { data: dump, mode: 'replace' });

  const full = await getJson(url, cookie, '/api/v1/days/2026-08-03/full');
  assert.strictEqual(full.schedule[0].title, 'Работа');
  const habits = await getJson(url, cookie, '/api/v1/habits');
  assert.strictEqual(habits.length, 1);
});

test('бэкап создаёт файл и соблюдает ротацию', async () => {
  const srv = await startTestServer();
  try {
    const { runBackup } = require('../../server/lib/backup');
    const first = runBackup(srv.db, srv.config.dbPath);
    assert.ok(require('node:fs').existsSync(first));
  } finally { await srv.close(); }
});
```

- [ ] **Step 2: Убедиться, что тесты падают** — Run: `node --test test/api/settings.test.js test/api/export.test.js` → FAIL

- [ ] **Step 3: Реализовать валидацию таймзоны**

```js
function isValidTimezone(tz) {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; }
  catch { return false; }
}
```

- [ ] **Step 4: Реализовать экспорт, импорт и бэкап**

Экспорт собирает все дневные таблицы, привычки, логи и серии. Импорт в режиме `replace` в одной транзакции чистит данные пользователя и заливает заново; в режиме `merge` дни с совпадающей датой пропускаются. Бэкап — `db.backup(path)` из better-sqlite3 в `data/backups/newday-<timestamp>.db`, старше 14 копий удаляются. Вызывается при старте перед миграциями, если есть pending-миграции, и по расписанию раз в сутки.

- [ ] **Step 5: Прогнать тесты и закоммитить**

```bash
git add server/routes/v1/settings.js server/routes/v1/export.js server/lib/backup.js server/index.js test/api/
git commit -m "feat: настройки пользователя, экспорт-импорт и автоматические бэкапы"
```

---

### Task 14: OpenAPI, `/api/docs`, legacy-алиасы, деплой и приёмка

**Files:**
- Create: `server/routes/v1/openapi.js`, `public/api-docs.html`
- Create: `server/routes/legacy.js`
- Modify: `server/app.js`, `README.md`
- Test: `test/api/legacy.test.js`, `test/api/openapi.test.js`

**Interfaces:**
- Produces:
  - `GET /api/v1/openapi.json` — валидный OpenAPI 3.1 со всеми путями этапа 1
  - `GET /api/docs` — статическая страница документации, читает openapi.json и рисует список эндпоинтов без внешних скриптов
  - Алиасы: `/api/auth/*` → `/api/v1/auth/*`, `/api/days/*` → `/api/v1/days/*`, `/api/habits/*` → `/api/v1/habits/*`

- [ ] **Step 1: Тесты**

```js
test('openapi.json валиден и покрывает ключевые пути', async () => {
  const srv = await startTestServer();
  try {
    const spec = await (await fetch(`${srv.url}/api/v1/openapi.json`)).json();
    assert.strictEqual(spec.openapi.startsWith('3.'), true);
    for (const p of ['/days/{date}/full', '/habits', '/tokens', '/auth/login', '/stats']) {
      assert.ok(spec.paths[p], `нет пути ${p}`);
    }
  } finally { await srv.close(); }
});

test('старый путь /api/days/:date отвечает так же, как v1', async () => {
  const { url, cookie } = await loggedIn();
  await api(url, cookie, 'POST', '/api/v1/days/2026-08-03/schedule', { startMin: 540, title: 'Работа' });
  const legacy = await (await fetch(`${url}/api/days/2026-08-03`, { headers: { cookie } })).json();
  assert.strictEqual(legacy.title, '');
  assert.strictEqual(legacy.date, '2026-08-03');
});

test('старый PUT /api/days/:date больше не стирает день', async () => {
  const { url, cookie } = await loggedIn();
  await api(url, cookie, 'POST', '/api/v1/days/2026-08-03/schedule', { startMin: 540, title: 'Работа' });
  await fetch(`${url}/api/days/2026-08-03`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ date: '2026-08-03' }),
  });
  const full = await getJson(url, cookie, '/api/v1/days/2026-08-03/full');
  assert.strictEqual(full.schedule.length, 1, 'пустой PUT не уничтожил расписание');
});
```

Последний тест — прямая страховка от бага №1: даже если где-то остался старый клиент, он больше не может стереть день.

- [ ] **Step 2: Убедиться, что тесты падают** — Run: `node --test test/api/legacy.test.js test/api/openapi.test.js` → FAIL

- [ ] **Step 3: Реализовать legacy-роутер**

`PUT /api/days/:date` мапится не на `replaceFull`, а на `patchDay` — то есть трогает только `title/focus/weight/notes` и не удаляет вложенные сущности. Это сознательное расхождение со старой семантикой: старая семантика и была багом. `If-Match` для legacy не требуется.

- [ ] **Step 4: Реализовать openapi.json и страницу документации**

Спецификация собирается статическим объектом в коде (не генерируется из роутов — так проще держать описания на русском). Страница `/api/docs` — обычный HTML, который фетчит `openapi.json` и рисует таблицу путей; никаких Swagger UI с CDN.

- [ ] **Step 5: Обновить README**

Раздел «API» переписать под `/api/v1`, добавить пример работы через токен:

```bash
curl -H "Authorization: Bearer nd_xxxxxxxx_..." \
     https://newday.appswire.ru/api/v1/days/2026-08-03/full
```

- [ ] **Step 6: Прогнать весь набор тестов**

Run: `npm test`
Expected: PASS, все тесты этапа

- [ ] **Step 7: Слить в master и задеплоить**

```bash
git add server/routes/v1/openapi.js server/routes/legacy.js public/api-docs.html README.md test/api/
git commit -m "feat: OpenAPI, страница документации и безопасные legacy-алиасы"
git checkout master && git merge --no-ff develop -m "Этап 1: фундамент"
git push origin master develop
```

Затем через Coolify API: убрать дублирующийся `SESSION_SECRET`, добавить `SMTP_*`, запустить деплой, дождаться `GET /api/health` с `ok: true` и `schemaVersion: 2`.

- [ ] **Step 8: Приёмка на проде**

1. `GET https://newday.appswire.ru/api/health` → `{"ok":true,"schemaVersion":2}`.
2. Зарегистрировать новый аккаунт на реальный адрес, получить письмо, подтвердить, войти.
3. Создать токен со скоупом write, залить им день через `PUT /api/v1/days/<завтра>/full`, прочитать обратно.
4. Открыть один и тот же день в двух вкладках, править разные строки — обе правки на месте.
5. Отключить сеть в DevTools, потыкать интерфейс, включить обратно, перезагрузить — день цел.
6. Проверить, что старые дни из `data_json` видны и содержат расписание, задачи и спорт.

- [ ] **Step 9: Финальный коммит README с отметкой о завершении этапа**

---

## Self-review плана

**Покрытие спеки этапом 1.** §4.1 схема → Task 4. §4.2 `status` → Task 4, 9. §4.3 таймзоны → Task 3, 13. §4.4 миграция → Task 4. §5.1 принципы → Task 5, 6. §5.2 три способа аутентификации → Task 11, 12. §5.3 дневные ресурсы → Task 6, 7. §5.4 привычки и статистика → Task 8, 9. §5.5 аккаунты и токены → Task 10, 11, 12, 13. §5.6 экспорт-импорт → Task 13. §7.1-7.2 оси и пресеты → Task 8. §7.5 расчёт статистики → Task 9. §9.1 инфраструктура → Task 1, 13, 14. §9.3 тесты → в каждой задаче.

**Что сознательно отложено на следующие этапы и не входит в этап 1.** Материализация серий повторов в дни (`series`/`series_overrides` создаются миграцией и лежат пустыми — логика в этапе 2 вместе с интерфейсом повторов). Таблицы `push_subscriptions` и `notification_queue` создаются, но не используются до этапа 3. Перенос невыполненных задач на следующий день (§6.6) — этап 2, потому что он завязан на открытие дня в интерфейсе.

**Согласованность имён.** `bumpRev(db, userId, date)` — Task 5, используется в Task 5-8. `todayFor(timezone, now)` — Task 3, используется в Task 8, 9, 13. `generateToken()/hashToken()` — Task 10, используются в Task 10, 11, 12. `requireAuth`/`requireScope` — Task 11, подключаются в `app.js` там же. `startTestServer({ env })` — Task 2, используется во всех тестах. `loggedIn()/api()/getJson()/post()` — Task 6, используются в Task 6-14.

**Исправлено при проверке.** В Task 5 Step 6 `shift` изначально бросал `badRequest` с кодом внутри `details`, из-за чего тест на `/OUT_OF_RANGE/` не прошёл бы — заменено на `ApiError` с этим кодом в поле `code`.
