/**
 * Панель администратора: вход по паролю экземпляра, приглашения,
 * тарифы помощника и статистика.
 *
 * Проверяем то, ради чего панель написана: что дефолтный пароль требует
 * смены, что перебор пароля упирается в лимит, что закрытая регистрация
 * действительно закрыта, а код приглашения нельзя потратить сверх предела,
 * и что рубильник с тарифами по-настоящему останавливают помощника.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { post, api, getJson, extractCookie, today } = require('../helpers/client');
const { startTestServer } = require('../helpers/server');

const DEFAULT = 'newday';

/** Вход в панель. Пароль экземпляра, а не пользовательский аккаунт. */
async function adminLogin(url, password = DEFAULT) {
  const res = await post(url, '/api/admin/login', { password });
  assert.strictEqual(res.status, 200, `вход админа: ${res.status}`);
  return { cookie: extractCookie(res), body: await res.json() };
}

/** Пользователь для проверок помощника. */
async function makeUser(url, email = 'user@example.com', password = 'secret12', extra = {}) {
  const reg = await post(url, '/api/v1/auth/register', { email, password, ...extra });
  assert.strictEqual(reg.status, 200, `регистрация ${email}: ${reg.status}`);
  const login = await post(url, '/api/v1/auth/login', { emailOrUsername: email, password });
  assert.strictEqual(login.status, 200);
  return extractCookie(login);
}

/** Поддельный провайдер: чат всегда отвечает пустым планом. */
const fakeProvider = () => async () => ({
  ok: true, status: 200,
  json: async () => ({
    choices: [{ message: { content: '{"items":[]}' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }),
});

/** Подключить помощника через панель. */
async function connectAi(url, cookie) {
  await api(url, cookie, 'PATCH', '/api/admin/ai', {
    baseUrl: 'https://provider.test/v1', model: 'быстрая', apiKey: 'sk-panel-test', enabled: true,
  });
}

// ── Вход ─────────────────────────────────────────────────────

test('пароль по умолчанию пускает, но требует смены', async () => {
  const s = await startTestServer();
  try {
    // Без входа панель закрыта
    const denied = await api(s.url, null, 'GET', '/api/admin/stats', undefined, {}, true);
    assert.strictEqual(denied.status, 401);

    const { cookie, body } = await adminLogin(s.url);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.mustChangePassword, true, 'дефолтный пароль — это дыра, о ней надо говорить');

    const stats = await getJson(s.url, cookie, '/api/admin/stats');
    assert.ok(stats.users, 'после входа панель открыта');
  } finally { await s.close(); }
});

test('смена пароля: старый умирает, новый входит без предупреждения', async () => {
  const s = await startTestServer();
  try {
    const { cookie } = await adminLogin(s.url);

    // Короткий пароль — русский отказ
    const short = await api(s.url, cookie, 'POST', '/api/admin/password',
      { current: DEFAULT, next: 'kor' }, {}, true);
    assert.strictEqual(short.status, 400);
    assert.match((await short.json()).error.message, /не менее 8/);

    // Неверный текущий — отказ: открытая сессия не должна отдавать панель
    const wrong = await api(s.url, cookie, 'POST', '/api/admin/password',
      { current: 'ne-tot-parol', next: 'novyj-parol-12' }, {}, true);
    assert.strictEqual(wrong.status, 400);
    assert.strictEqual((await wrong.json()).error.code, 'BAD_PASSWORD');

    await api(s.url, cookie, 'POST', '/api/admin/password', { current: DEFAULT, next: 'novyj-parol-12' });

    const old = await post(s.url, '/api/admin/login', { password: DEFAULT });
    assert.strictEqual(old.status, 401, 'старый пароль должен умереть');

    const fresh = await adminLogin(s.url, 'novyj-parol-12');
    assert.strictEqual(fresh.body.mustChangePassword, false);
  } finally { await s.close(); }
});

test('пять неверных паролей подряд — и даже верный ждёт', async () => {
  const s = await startTestServer();
  try {
    for (let i = 0; i < 5; i++) {
      const r = await post(s.url, '/api/admin/login', { password: 'mimo' });
      assert.strictEqual(r.status, 401);
    }
    const blocked = await post(s.url, '/api/admin/login', { password: DEFAULT });
    assert.strictEqual(blocked.status, 429, 'подбор должен упереться в лимит');
    assert.strictEqual((await blocked.json()).error.code, 'TOO_MANY_REQUESTS');
  } finally { await s.close(); }
});

// ── Регистрация и приглашения ────────────────────────────────

test('закрытая регистрация: без кода отказ, с кодом — вход и тариф из кода', async () => {
  const s = await startTestServer();
  try {
    const admin = await adminLogin(s.url);
    await api(s.url, admin.cookie, 'PATCH', '/api/admin/settings', { registrationOpen: false });

    // Страница входа видит закрытую регистрацию без всякого входа
    const cfg = await getJson(s.url, null, '/api/v1/auth/config');
    assert.strictEqual(cfg.registrationOpen, false);

    const refused = await post(s.url, '/api/v1/auth/register',
      { email: 'gost@example.com', password: 'secret12' });
    assert.strictEqual(refused.status, 403);
    assert.match((await refused.json()).error.message, /по приглашениям/);

    const inv = await api(s.url, admin.cookie, 'POST', '/api/admin/invites', { aiTier: 'limited' });
    assert.ok(inv.code);
    // адрес — с того хоста, где открыта админка, а не из APP_URL
    assert.strictEqual(inv.url, `${s.url}/register.html?invite=${inv.code}`);

    await makeUser(s.url, 'gost@example.com', 'secret12', { invite: inv.code });
    const row = s.db.prepare('SELECT ai_tier FROM users WHERE email = ?').get('gost@example.com');
    assert.strictEqual(row.ai_tier, 'limited', 'тариф приезжает из приглашения');
  } finally { await s.close(); }
});

test('код тратится ровно до предела, и трата видна в списке', async () => {
  const s = await startTestServer();
  try {
    const admin = await adminLogin(s.url);
    await api(s.url, admin.cookie, 'PATCH', '/api/admin/settings', { registrationOpen: false });
    const inv = await api(s.url, admin.cookie, 'POST', '/api/admin/invites', { uses: 2 });

    await makeUser(s.url, 'raz@example.com', 'secret12', { invite: inv.code });
    await makeUser(s.url, 'dva@example.com', 'secret12', { invite: inv.code });

    const third = await post(s.url, '/api/v1/auth/register',
      { email: 'tri@example.com', password: 'secret12', invite: inv.code });
    assert.strictEqual(third.status, 403, 'исчерпанный код не должен пускать');

    const list = await getJson(s.url, admin.cookie, '/api/admin/invites');
    const mine = list.find(i => i.id === inv.id);
    assert.strictEqual(mine.used, 2);
    assert.strictEqual(mine.uses, 2);
    assert.strictEqual(mine.revoked, false);
  } finally { await s.close(); }
});

test('отозванный код перестаёт пускать', async () => {
  const s = await startTestServer();
  try {
    const admin = await adminLogin(s.url);
    await api(s.url, admin.cookie, 'PATCH', '/api/admin/settings', { registrationOpen: false });
    const inv = await api(s.url, admin.cookie, 'POST', '/api/admin/invites', {});

    await api(s.url, admin.cookie, 'DELETE', `/api/admin/invites/${inv.id}`);

    const refused = await post(s.url, '/api/v1/auth/register',
      { email: 'pozdno@example.com', password: 'secret12', invite: inv.code });
    assert.strictEqual(refused.status, 403);

    const list = await getJson(s.url, admin.cookie, '/api/admin/invites');
    assert.strictEqual(list.find(i => i.id === inv.id).revoked, true);
  } finally { await s.close(); }
});

test('при открытой регистрации код не обязателен, но присланный тратится', async () => {
  const s = await startTestServer();
  try {
    const admin = await adminLogin(s.url);
    const inv = await api(s.url, admin.cookie, 'POST', '/api/admin/invites', { aiTier: 'off' });

    await makeUser(s.url, 'po-kodu@example.com', 'secret12', { invite: inv.code });

    const list = await getJson(s.url, admin.cookie, '/api/admin/invites');
    assert.strictEqual(list.find(i => i.id === inv.id).used, 1);
    const row = s.db.prepare('SELECT ai_tier FROM users WHERE email = ?').get('po-kodu@example.com');
    assert.strictEqual(row.ai_tier, 'off');

    // Без кода — как раньше, и тариф по умолчанию не режет никого
    await makeUser(s.url, 'bez-koda@example.com');
    const plain = s.db.prepare('SELECT ai_tier FROM users WHERE email = ?').get('bez-koda@example.com');
    assert.strictEqual(plain.ai_tier, 'unlimited');
  } finally { await s.close(); }
});

test('тариф по умолчанию применяется при регистрации, приглашение его перекрывает', async () => {
  const s = await startTestServer();
  try {
    const admin = await adminLogin(s.url);

    const patched = await api(s.url, admin.cookie, 'PATCH', '/api/admin/settings', { defaultAiTier: 'limited' });
    assert.strictEqual(patched.defaultAiTier, 'limited');
    const settings = await getJson(s.url, admin.cookie, '/api/admin/settings');
    assert.strictEqual(settings.defaultAiTier, 'limited');

    // Мусорный тариф — русский отказ, настройка не портится
    const bad = await api(s.url, admin.cookie, 'PATCH', '/api/admin/settings',
      { defaultAiTier: 'vip' }, {}, true);
    assert.strictEqual(bad.status, 400);

    // Регистрация без приглашения получает умолчание
    await makeUser(s.url, 'obychnyj@example.com');
    const plain = s.db.prepare('SELECT ai_tier FROM users WHERE email = ?').get('obychnyj@example.com');
    assert.strictEqual(plain.ai_tier, 'limited');

    // Код приглашения сильнее умолчания: его выдают лично
    const inv = await api(s.url, admin.cookie, 'POST', '/api/admin/invites', { aiTier: 'unlimited' });
    await makeUser(s.url, 'po-kodu@example.com', 'secret12', { invite: inv.code });
    const invited = s.db.prepare('SELECT ai_tier FROM users WHERE email = ?').get('po-kodu@example.com');
    assert.strictEqual(invited.ai_tier, 'unlimited');
  } finally { await s.close(); }
});

// ── Блокировка и удаление пользователя ───────────────────────

test('блокировка закрывает запросы и вход, разблокировка возвращает всё как было', async () => {
  const s = await startTestServer();
  try {
    const userCookie = await makeUser(s.url);
    const admin = await adminLogin(s.url);
    const me = (await getJson(s.url, admin.cookie, '/api/admin/users'))
      .find(u => u.email === 'user@example.com');

    const blocked = await api(s.url, admin.cookie, 'POST', `/api/admin/users/${me.id}/block`, {});
    assert.ok(blocked.blockedAt, 'отметка блокировки возвращается сразу');
    assert.ok(blocked.deleteAfter > blocked.blockedAt, 'срок удаления — позже блокировки');

    // Сессия жива, но дверь закрыта — 403, а не 401
    const denied = await api(s.url, userCookie, 'GET', '/api/v1/auth/me', undefined, {}, true);
    assert.strictEqual(denied.status, 403);
    assert.strictEqual((await denied.json()).error.code, 'ACCOUNT_BLOCKED');

    // Верный пароль — тем же отказом
    const login = await post(s.url, '/api/v1/auth/login',
      { emailOrUsername: 'user@example.com', password: 'secret12' });
    assert.strictEqual(login.status, 403);
    assert.strictEqual((await login.json()).error.code, 'ACCOUNT_BLOCKED');

    // Админ видит и отметку, и дату будущего удаления
    const listed = (await getJson(s.url, admin.cookie, '/api/admin/users')).find(u => u.id === me.id);
    assert.ok(listed.blockedAt);
    assert.strictEqual(listed.deleteAfter > listed.blockedAt, true);

    // Разблокировка: старая сессия снова работает — токены никто не отзывал
    await api(s.url, admin.cookie, 'POST', `/api/admin/users/${me.id}/unblock`, {});
    const back = await api(s.url, userCookie, 'GET', '/api/v1/auth/me', undefined, {}, true);
    assert.strictEqual(back.status, 200);
    const relisted = (await getJson(s.url, admin.cookie, '/api/admin/users')).find(u => u.id === me.id);
    assert.strictEqual(relisted.blockedAt, null);
    assert.strictEqual(relisted.deleteAfter, null);
  } finally { await s.close(); }
});

test('удаление: без блокировки отказ, после — человек исчезает вместе с данными', async () => {
  const s = await startTestServer();
  try {
    const userCookie = await makeUser(s.url);
    const admin = await adminLogin(s.url);
    const me = (await getJson(s.url, admin.cookie, '/api/admin/users'))
      .find(u => u.email === 'user@example.com');

    // Данные: строка расписания и звук — у звука есть файл вне базы
    await api(s.url, userCookie, 'POST', `/api/v1/days/${today()}/schedule`,
      { startMin: 540, title: 'дело' });
    const soundId = s.db.prepare(
      'INSERT INTO user_sounds (user_id, name, mime, ext, size_bytes) VALUES (?,?,?,?,?)',
    ).run(me.id, 'звук', 'audio/mpeg', 'mp3', 3).lastInsertRowid;
    const soundDir = path.join(s.config.soundsDir, String(me.id));
    fs.mkdirSync(soundDir, { recursive: true });
    fs.writeFileSync(path.join(soundDir, `${soundId}.mp3`), 'mp3');

    // Незаблокированного стереть нельзя: между кликами обязан стоять шаг
    const early = await api(s.url, admin.cookie, 'DELETE', `/api/admin/users/${me.id}`, undefined, {}, true);
    assert.strictEqual(early.status, 400);
    assert.match((await early.json()).error.message, /закройте доступ/);

    await api(s.url, admin.cookie, 'POST', `/api/admin/users/${me.id}/block`, {});
    await api(s.url, admin.cookie, 'DELETE', `/api/admin/users/${me.id}`);

    const count = t => s.db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE user_id = ?`).get(me.id).c;
    assert.strictEqual(s.db.prepare('SELECT COUNT(*) AS c FROM users WHERE id = ?').get(me.id).c, 0);
    assert.strictEqual(count('schedule_items'), 0, 'расписание уходит каскадом');
    assert.strictEqual(count('user_sounds'), 0, 'метаданные звуков уходят каскадом');
    assert.strictEqual(count('devices'), 0, 'устройства уходят каскадом');
    assert.strictEqual(fs.existsSync(soundDir), false, 'файлы звуков стёрты с диска');

    // Живая сессия удалённого отвечает 401: человека больше нет
    const gone = await api(s.url, userCookie, 'GET', '/api/v1/auth/me', undefined, {}, true);
    assert.strictEqual(gone.status, 401);
  } finally { await s.close(); }
});

test('автоочистка стирает заблокированного 61 день назад и не трогает вчерашнего', async () => {
  const s = await startTestServer();
  try {
    const admin = await adminLogin(s.url);
    await makeUser(s.url, 'davno@example.com');
    await makeUser(s.url, 'vchera@example.com');
    const list = await getJson(s.url, admin.cookie, '/api/admin/users');
    const old = list.find(u => u.email === 'davno@example.com');
    const fresh = list.find(u => u.email === 'vchera@example.com');

    await api(s.url, admin.cookie, 'POST', `/api/admin/users/${old.id}/block`, {});
    await api(s.url, admin.cookie, 'POST', `/api/admin/users/${fresh.id}/block`, {});
    // Время блокировки подставляем прямо в базу: ждать 61 день тест не будет
    s.db.prepare("UPDATE users SET blocked_at = datetime('now', '-61 days') WHERE id = ?").run(old.id);
    s.db.prepare("UPDATE users SET blocked_at = datetime('now', '-1 day') WHERE id = ?").run(fresh.id);

    const purged = s.app.locals.userCleanup.purgeExpired();
    assert.strictEqual(purged, 1, 'под очистку попадает ровно один');
    assert.strictEqual(
      s.db.prepare('SELECT COUNT(*) AS c FROM users WHERE id = ?').get(old.id).c, 0);
    assert.strictEqual(
      s.db.prepare('SELECT COUNT(*) AS c FROM users WHERE id = ?').get(fresh.id).c, 1,
      'вчерашняя блокировка ещё ждёт свои 60 дней');
  } finally { await s.close(); }
});

// ── Рубильник и тарифы помощника ─────────────────────────────

test('рубильник и тариф off закрывают помощника, limited упирается в 429', async () => {
  const s = await startTestServer({ fetchImpl: fakeProvider() });
  try {
    const userCookie = await makeUser(s.url);
    const admin = await adminLogin(s.url);
    await connectAi(s.url, admin.cookie);

    // Рубильник: помощник подключён, но выключен для всех
    await api(s.url, admin.cookie, 'PATCH', '/api/admin/settings', { aiEnabled: false });
    let r = await api(s.url, userCookie, 'POST', '/api/v1/ai/parse', { text: 'дела' }, {}, true);
    assert.strictEqual(r.status, 403);
    assert.strictEqual((await r.json()).error.code, 'AI_DISABLED');

    await api(s.url, admin.cookie, 'PATCH', '/api/admin/settings', { aiEnabled: true });

    // Тариф off: выключен только этот человек
    const users = await getJson(s.url, admin.cookie, '/api/admin/users');
    const me = users.find(u => u.email === 'user@example.com');
    await api(s.url, admin.cookie, 'PATCH', `/api/admin/users/${me.id}`, { aiTier: 'off' });
    r = await api(s.url, userCookie, 'POST', '/api/v1/ai/parse', { text: 'дела' }, {}, true);
    assert.strictEqual(r.status, 403);
    assert.strictEqual((await r.json()).error.code, 'AI_DISABLED');

    // Тариф limited: 50 в сутки. Подкладываем 49 потраченных, чтобы не
    // гонять полсотни запросов, — день считается по часам пользователя
    await api(s.url, admin.cookie, 'PATCH', `/api/admin/users/${me.id}`, { aiTier: 'limited' });
    s.db.prepare('INSERT INTO ai_daily_usage (user_id, day, count) VALUES (?, ?, 49)').run(me.id, today());

    const fifty = await api(s.url, userCookie, 'POST', '/api/v1/ai/parse', { text: 'дела' }, {}, true);
    assert.strictEqual(fifty.status, 200, 'пятидесятый запрос ещё проходит');

    const status = await getJson(s.url, userCookie, '/api/v1/ai/status');
    assert.strictEqual(status.tier, 'limited');
    assert.strictEqual(status.usedToday, 50);
    assert.strictEqual(status.dailyLimit, 50);

    r = await api(s.url, userCookie, 'POST', '/api/v1/ai/parse', { text: 'ещё' }, {}, true);
    assert.strictEqual(r.status, 429);
    assert.strictEqual((await r.json()).error.code, 'AI_LIMIT');

    // Расход виден админу в списке людей
    const after = await getJson(s.url, admin.cookie, '/api/admin/users');
    assert.strictEqual(after.find(u => u.id === me.id).aiUsedToday, 50);
  } finally { await s.close(); }
});

// ── Подключение ИИ и прокси ──────────────────────────────────

test('панель ИИ: ключ не отдаётся, socks5 принимается, мёртвые прокси не мешают', async () => {
  const s = await startTestServer({ fetchImpl: fakeProvider() });
  try {
    const userCookie = await makeUser(s.url);
    const admin = await adminLogin(s.url);
    await connectAi(s.url, admin.cookie);

    const overview = await getJson(s.url, admin.cookie, '/api/admin/ai');
    assert.strictEqual(overview.keySet, true);
    assert.strictEqual(overview.ready, true);
    assert.ok(!JSON.stringify(overview).includes('sk-panel-test'), 'ключ наружу не отдаётся');

    // Порт 9 — заведомо мёртвый: клиент должен пометить прокси и дойти
    // до провайдера напрямую, а не сломать помощника. socks5 — полноправный
    // тип наравне с http, отказа «появится позже» больше нет.
    const socks = await api(s.url, admin.cookie, 'POST', '/api/admin/ai/proxies',
      { type: 'socks5', host: '127.0.0.1', port: 9, login: 'l', password: 'p' });
    assert.strictEqual(socks.type, 'socks5');
    assert.strictEqual(socks.active, true);
    const dead = await api(s.url, admin.cookie, 'POST', '/api/admin/ai/proxies',
      { type: 'http', host: '127.0.0.1', port: 9, login: 'l', password: 'p' });
    assert.strictEqual(dead.active, true);

    const withProxy = await getJson(s.url, admin.cookie, '/api/admin/ai');
    assert.strictEqual(withProxy.proxies.length, 2);
    assert.ok(!JSON.stringify(withProxy).includes('"p"'), 'пароль прокси наружу не отдаётся');

    const parsed = await api(s.url, userCookie, 'POST', '/api/v1/ai/parse', { text: 'дела' }, {}, true);
    assert.strictEqual(parsed.status, 200, 'мёртвые прокси не должны убивать помощника');

    // Выключение и удаление
    const off = await api(s.url, admin.cookie, 'PATCH', `/api/admin/ai/proxies/${dead.id}`, { active: false });
    assert.strictEqual(off.active, false);
    await api(s.url, admin.cookie, 'DELETE', `/api/admin/ai/proxies/${dead.id}`);
    await api(s.url, admin.cookie, 'DELETE', `/api/admin/ai/proxies/${socks.id}`);
    const clean = await getJson(s.url, admin.cookie, '/api/admin/ai');
    assert.strictEqual(clean.proxies.length, 0);
  } finally { await s.close(); }
});

test('проверка связи отвечает ok и временем, а без подключения — причиной', async () => {
  const s = await startTestServer({ fetchImpl: fakeProvider() });
  try {
    const admin = await adminLogin(s.url);

    const cold = await api(s.url, admin.cookie, 'POST', '/api/admin/ai/check', {});
    assert.strictEqual(cold.ok, false);
    assert.ok(cold.error, 'должна быть причина');

    await connectAi(s.url, admin.cookie);
    const warm = await api(s.url, admin.cookie, 'POST', '/api/admin/ai/check', {});
    assert.strictEqual(warm.ok, true);
    assert.ok(warm.latencyMs >= 0);
  } finally { await s.close(); }
});

// ── Статистика ───────────────────────────────────────────────

test('статистика: люди, расход помощника по дням, здоровье', async () => {
  const s = await startTestServer({ fetchImpl: fakeProvider() });
  try {
    const userCookie = await makeUser(s.url);
    const admin = await adminLogin(s.url);
    await connectAi(s.url, admin.cookie);

    await api(s.url, userCookie, 'POST', '/api/v1/ai/parse', { text: 'раз' });
    await api(s.url, userCookie, 'POST', '/api/v1/ai/parse', { text: 'два' });

    const stats = await getJson(s.url, admin.cookie, '/api/admin/stats');
    assert.strictEqual(stats.users.total, 1);
    assert.strictEqual(stats.ai.today, 2);
    assert.strictEqual(stats.ai.week, 2);
    assert.strictEqual(stats.ai.byDay.length, 1);
    assert.strictEqual(stats.ai.byDay[0].count, 2);
    assert.strictEqual(stats.health.ok, true);
    assert.strictEqual(stats.health.dbWritable, true);
    assert.ok(stats.health.schemaVersion >= 10, 'схема должна быть накатана целиком');
  } finally { await s.close(); }
});

/*
 * Развёртывание «в два клика» проверяется здесь же.
 *
 * Оба сценария ловились руками на свежем контейнере: сервер отвечал «ок»,
 * а пользоваться им было нельзя.
 */
test('по обычному HTTP вход работает: сессия не помечена secure', async () => {
  const srv = await startTestServer({ env: { NODE_ENV: 'production' } });
  try {
    const res = await post(srv.url, '/api/admin/login', { password: 'newday' });
    assert.strictEqual(res.status, 200);
    const cookie = res.headers.get('set-cookie');
    assert.ok(cookie, 'Set-Cookie должен прийти — иначе войти нечем');
    assert.ok(!/;\s*Secure/i.test(cookie),
      'на голом HTTP secure-cookie не доедет до браузера');
  } finally { await srv.close(); }
});

test('ссылка приглашения ведёт на тот адрес, по которому открыта админка', async () => {
  // APP_URL нарочно чужой: свежий сервер поднимают без него,
  // и ссылка на localhost отправила бы приглашённого в никуда
  const srv = await startTestServer({ env: { APP_URL: 'http://localhost:3000' } });
  try {
    const { cookie: jar } = await adminLogin(srv.url);
    const res = await fetch(`${srv.url}/api/admin/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: jar },
      body: JSON.stringify({ uses: 1 }),
    });
    const body = await res.json();
    assert.ok(body.url.startsWith(srv.url), `ссылка ${body.url} не с этого сервера`);
    assert.ok(body.url.includes('/register.html?invite='));
  } finally { await srv.close(); }
});
