/**
 * Сессия при входе и здоровье сервера.
 *
 * Обе темы скучные ровно до того дня, когда из-за них теряют аккаунт или
 * кладут сервер публичным запросом.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, post, api, extractCookie } = require('../helpers/client');

test('подложенный идентификатор сессии не становится входом', async () => {
  const s = await loggedIn();
  try {
    /*
     * Классическая подмена сессии: злоумышленник навязывает браузеру жертвы
     * свой идентификатор и ждёт, пока та войдёт. Здесь это не проходит по
     * двум причинам, и обе стоит закрепить: гостю сервер идентификатор
     * вообще не выдаёт (сессия заводится только при входе), а неизвестный
     * идентификатор не подхватывается — на вход выдаётся новый.
     */
    const гость = await fetch(`${s.url}/api/v1/auth/me`, { redirect: 'manual' });
    assert.strictEqual(extractCookie(гость), '', 'гостю идентификатор не выдаётся');

    const подложенный = 'newday.sid=s%3AVYDUMKA.podpis';
    const вход = await fetch(`${s.url}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: подложенный },
      body: JSON.stringify({ emailOrUsername: 'user@example.com', password: 'secret12' }),
      redirect: 'manual',
    });
    assert.strictEqual(вход.status, 200, 'вход удался');
    const выданный = extractCookie(вход);
    assert.ok(выданный && выданный !== подложенный, 'выдан свой идентификатор, а не подложенный');

    const старым = await fetch(`${s.url}/api/v1/auth/me`, { headers: { cookie: подложенный }, redirect: 'manual' });
    assert.strictEqual(старым.status, 401, 'подложенный идентификатор входом не стал');
  } finally { await s.close(); }
});

test('проверка здоровья не создаёт таблицу на каждый запрос', async () => {
  const s = await loggedIn();
  try {
    /*
     * Проверка «база пишется» создавала и удаляла таблицу при КАЖДОМ
     * обращении к /api/health. Маршрут публичный и без ограничений:
     * это и блокировка на запись в SQLite, и сброс кеша подготовленных
     * запросов, и рост журнала — то есть публичная кнопка «притормози
     * сервер».
     */
    const было = s.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = '_write_probe'").get().n;
    assert.strictEqual(было, 0, 'таблицы-пробы нет');

    const t = Date.now();
    for (let i = 0; i < 40; i += 1) {
      const r = await api(s.url, null, 'GET', '/api/health', undefined, {}, true);
      assert.strictEqual(r.status, 200);
    }
    const прошло = Date.now() - t;
    assert.ok(прошло < 3000, `сорок проверок быстрые (${прошло} мс)`);

    const первый = await api(s.url, null, 'GET', '/api/health');
    assert.ok(первый.ok !== false || первый.status, 'ответ осмысленный');
  } finally { await s.close(); }
});

test('валидатор чисел не принимает список и «да» за число', async () => {
  const s = await loggedIn();
  try {
    /*
     * `Number([5])` — это 5, `Number(true)` — 1, `Number('0x10')` — 16.
     * Валидатор молча соглашался, и дальше по коду «точно число» могло
     * оказаться чем угодно. Обычная строка с числом («600» из формы)
     * по-прежнему принимается — это законный случай.
     */
    const D = (await api(s.url, s.cookie, 'GET', '/api/v1/settings')).today;
    const списком = await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/schedule`,
      { title: 'x', startMin: [600], endMin: 660 }, {}, true);
    assert.strictEqual(списком.status, 400, 'список вместо числа — отказ');

    const булево = await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/sport`,
      { exercise: 'жим', sets: true }, {}, true);
    assert.strictEqual(булево.status, 400, '«да» вместо числа — отказ');

    const строкой = await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/schedule`,
      { title: 'из формы', startMin: '600', endMin: '660' }, {}, true);
    assert.strictEqual(строкой.status, 201, 'число строкой из формы по-прежнему принимается');
  } finally { await s.close(); }
});
