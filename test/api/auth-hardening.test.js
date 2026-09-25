/**
 * Пути, которыми можно увести аккаунт.
 *
 * Здесь не «работает ли вход», а «нельзя ли войти не своим». Каждый тест
 * описывает конкретный способ, который однажды нашли, — и сторожит, чтобы
 * он не открылся заново.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, call, today } = require('../helpers/client');

/** Токен интеграции с нужным доступом. */
async function токен(s, scope) {
  const r = await api(s.url, s.cookie, 'POST', '/api/v1/tokens', { name: 'проба', scope });
  return r.token ?? r.secret ?? r.value;
}

const сТокеном = t => ({ Authorization: `Bearer ${t}` });

test('токен «только чтение» не меняет почту аккаунта', async () => {
  const s = await loggedIn();
  try {
    const t = await токен(s, 'read');
    // читать им можно
    const день = await call(s.url, null, 'GET', `/api/v1/days/${today()}/full`, undefined, сТокеном(t), true);
    assert.strictEqual(день.status, 200, 'чтение разрешено');

    /*
     * А вот смена почты — это захват: следом «забыли пароль» уходит уже на
     * новый адрес, и аккаунт у владельца токена. Роутер входа монтируется
     * раньше общей проверки доступа, поэтому охрана нужна на самом пути.
     */
    const r = await call(s.url, null, 'POST', '/api/v1/auth/bind-email',
      { email: 'ugon@example.com' }, сТокеном(t), true);
    assert.strictEqual(r.status, 403, `ожидали отказ, получили ${r.status}`);

    const я = await call(s.url, null, 'GET', '/api/v1/auth/me', undefined, сТокеном(t));
    assert.notStrictEqual(я.email, 'ugon@example.com', 'почта не сменилась');
  } finally { await s.close(); }
});

test('токен «только чтение» не меняет пароль', async () => {
  const s = await loggedIn();
  try {
    const t = await токен(s, 'read');
    const r = await call(s.url, null, 'POST', '/api/v1/auth/password',
      { currentPassword: 'secret12', newPassword: 'secret34' }, сТокеном(t), true);
    assert.strictEqual(r.status, 403, `ожидали отказ, получили ${r.status}`);
  } finally { await s.close(); }
});

test('ссылка подтверждения почты не подменяет человека в чужой сессии', async () => {
  const жертва = await loggedIn();
  try {
    /*
     * Нападающий регистрируется, получает свою ссылку подтверждения и
     * подсовывает её жертве. Раньше переход по ней клал в сессию жертвы
     * чужой номер пользователя: дальше всё, что она пишет, ложилось в
     * чужой аккаунт и читалось нападающим.
     */
    await api(жертва.url, null, 'POST', '/api/v1/auth/register',
      { email: 'evil@example.com', password: 'secret12' });
    const чужойId = жертва.db.prepare("SELECT id FROM users WHERE email = 'evil@example.com'").get().id;
    // письма в тестах не уходят, поэтому кладём ссылку подтверждения сами —
    // ровно такую, какую прислал бы себе нападающий
    const { randomHex, hashToken } = require('../../server/lib/secrets');
    const ссылка = randomHex(32);
    жертва.db.prepare('INSERT INTO email_tokens (user_id, kind, token_hash, expires_at) VALUES (?,?,?,?)')
      .run(чужойId, 'verify', hashToken(ссылка), Date.now() + 3600000);

    await call(жертва.url, жертва.cookie, 'GET', `/api/v1/auth/verify?token=${ссылка}`,
      undefined, {}, true);

    const я = await call(жертва.url, жертва.cookie, 'GET', '/api/v1/auth/me', undefined, {}, true);
    const почта = я.status === 200 ? (await я.json()).email : null;
    assert.notStrictEqual(почта, 'evil@example.com', 'в сессии жертвы остался её же аккаунт');
  } finally { await жертва.close(); }
});

test('смена пароля отзывает прежние входы', async () => {
  const s = await loggedIn();
  try {
    /*
     * Телефон украли, человек меняет пароль — и ждёт, что чужой доступ
     * закончился. Раньше не отзывалось ничего: ни сессии, ни токены
     * устройств, — и отобрать доступ было нечем.
     */
    const вход = await call(s.url, null, 'POST', '/api/v1/auth/login',
      { emailOrUsername: 'user@example.com', password: 'secret12', issueDeviceToken: true });
    const устройство = вход.deviceToken;
    assert.ok(устройство, 'вход выдал токен устройства');

    await api(s.url, s.cookie, 'POST', '/api/v1/auth/password',
      { currentPassword: 'secret12', newPassword: 'secret34' });

    const после = await call(s.url, null, 'GET', '/api/v1/auth/me', undefined, сТокеном(устройство), true);
    assert.strictEqual(после.status, 401, `старое устройство отозвано (получили ${после.status})`);
  } finally { await s.close(); }
});
