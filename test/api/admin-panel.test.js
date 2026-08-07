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
    assert.strictEqual(inv.url, `${s.config.appUrl}/register.html?invite=${inv.code}`);

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

test('панель ИИ: ключ не отдаётся, socks5 честно откладывается, мёртвый прокси не мешает', async () => {
  const s = await startTestServer({ fetchImpl: fakeProvider() });
  try {
    const userCookie = await makeUser(s.url);
    const admin = await adminLogin(s.url);
    await connectAi(s.url, admin.cookie);

    const overview = await getJson(s.url, admin.cookie, '/api/admin/ai');
    assert.strictEqual(overview.keySet, true);
    assert.strictEqual(overview.ready, true);
    assert.ok(!JSON.stringify(overview).includes('sk-panel-test'), 'ключ наружу не отдаётся');

    const socks = await api(s.url, admin.cookie, 'POST', '/api/admin/ai/proxies',
      { type: 'socks5', host: 'proxy.test', port: 1080 }, {}, true);
    assert.strictEqual(socks.status, 400);
    assert.match((await socks.json()).error.message, /SOCKS/);

    // Порт 9 — заведомо мёртвый: клиент должен пометить прокси и дойти
    // до провайдера напрямую, а не сломать помощника
    const dead = await api(s.url, admin.cookie, 'POST', '/api/admin/ai/proxies',
      { type: 'http', host: '127.0.0.1', port: 9, login: 'l', password: 'p' });
    assert.strictEqual(dead.active, true);

    const withProxy = await getJson(s.url, admin.cookie, '/api/admin/ai');
    assert.strictEqual(withProxy.proxies.length, 1);
    assert.ok(!JSON.stringify(withProxy).includes('"p"'), 'пароль прокси наружу не отдаётся');

    const parsed = await api(s.url, userCookie, 'POST', '/api/v1/ai/parse', { text: 'дела' }, {}, true);
    assert.strictEqual(parsed.status, 200, 'мёртвый прокси не должен убивать помощника');

    // Выключение и удаление
    const off = await api(s.url, admin.cookie, 'PATCH', `/api/admin/ai/proxies/${dead.id}`, { active: false });
    assert.strictEqual(off.active, false);
    await api(s.url, admin.cookie, 'DELETE', `/api/admin/ai/proxies/${dead.id}`);
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
