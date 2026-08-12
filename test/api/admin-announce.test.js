/**
 * Объявление владельца сервера: панель пишет — вошедшие читают.
 *
 * Проверяем не поля в ответе, а то, ради чего объявление сделано: владелец
 * набрал слова в панели, и их своими глазами увидел человек в приложении.
 * Поэтому почти каждая проверка идёт двумя сессиями сразу — админской
 * и пользовательской: панель и приложение ходят разными дверями, и «в базе
 * записалось» ничего не доказывает, пока второй запрос это не подтвердил.
 *
 * Отдельно стережём три свойства, которые легко потерять при правках:
 * — заготовленный, но выключенный текст пользователю не отдаётся;
 * — rev растёт от смены текста и молчит на щелчках тумблера (иначе закрытая
 *   человеком полоса всплывала бы после каждой проверки «как выглядит»);
 * — смайлики доезжают теми же символами, что набрал владелец.
 */

const test = require('node:test');
const assert = require('node:assert');
const { post, api, getJson, extractCookie } = require('../helpers/client');
const { startTestServer } = require('../helpers/server');

const DEFAULT = 'newday';

/** Вход в панель. Пароль экземпляра, а не пользовательский аккаунт. */
async function adminLogin(url, password = DEFAULT) {
  const res = await post(url, '/api/admin/login', { password });
  assert.strictEqual(res.status, 200, `вход админа: ${res.status}`);
  return { cookie: extractCookie(res), body: await res.json() };
}

/** Пользователь, который увидит полосу. Без SMTP регистрация сразу подтверждена. */
async function makeUser(url, email = 'user@example.com', password = 'secret12', extra = {}) {
  const reg = await post(url, '/api/v1/auth/register', { email, password, ...extra });
  assert.strictEqual(reg.status, 200, `регистрация ${email}: ${reg.status}`);
  const login = await post(url, '/api/v1/auth/login', { emailOrUsername: email, password });
  assert.strictEqual(login.status, 200);
  return extractCookie(login);
}

/** Что видит в приложении вошедший человек. */
const seenBy = (url, cookie) => getJson(url, cookie, '/api/v1/announce');

/** Поставить объявление от лица панели. */
const setAnnounce = (url, cookie, body, raw = false) =>
  api(url, cookie, 'PUT', '/api/admin/announce', body, {}, raw);

// ── Кому вообще можно ────────────────────────────────────────

/*
 * Объявление видят все — значит написать его не должен никто, кроме владельца.
 * Проверяем не только код отказа, но и то, что после отказа полоса не
 * появилась: 401 на входе бесполезен, если запись всё же прошла.
 */
test('без входа администратора объявление не поставить и не прочитать', async () => {
  const s = await startTestServer();
  try {
    const userCookie = await makeUser(s.url);

    const denied = await setAnnounce(s.url, null, { text: 'я тут хозяин', on: true }, true);
    assert.strictEqual(denied.status, 401);
    assert.strictEqual((await denied.json()).error.code, 'UNAUTHORIZED');

    // Пользовательская сессия — не админская: у панели свой вход по паролю
    const asUser = await setAnnounce(s.url, userCookie, { text: 'я тут хозяин', on: true }, true);
    assert.strictEqual(asUser.status, 401);

    const read = await api(s.url, null, 'GET', '/api/admin/announce', undefined, {}, true);
    assert.strictEqual(read.status, 401, 'чужой текст не должен читаться без входа');

    const seen = await seenBy(s.url, userCookie);
    assert.strictEqual(seen.on, false, 'отказ обязан быть отказом, а не задержкой записи');
    assert.strictEqual(seen.text, '');
  } finally { await s.close(); }
});

/*
 * Объявление — это то, что владелец говорит своим: «сервер переедет»,
 * «оплатите доступ». Публичный маршрут отдал бы этот текст всему интернету,
 * поэтому за ним ходит только вошедший.
 */
test('невошедший за объявлением не ходит, вошедший — ходит', async () => {
  const s = await startTestServer();
  try {
    const admin = await adminLogin(s.url);
    await setAnnounce(s.url, admin.cookie, { text: 'внутреннее дело', on: true });

    const anon = await api(s.url, null, 'GET', '/api/v1/announce', undefined, {}, true);
    assert.strictEqual(anon.status, 401);
    assert.ok(!(await anon.text()).includes('внутреннее дело'), 'текст не должен утечь и в тело отказа');

    const userCookie = await makeUser(s.url);
    const seen = await seenBy(s.url, userCookie);
    assert.strictEqual(seen.on, true);
    assert.strictEqual(seen.text, 'внутреннее дело');
  } finally { await s.close(); }
});

// ── Путь целиком: написал — увидели — выключил — не видят ─────

test('админ включил — человек видит тот же текст; выключил — не видит', async () => {
  const s = await startTestServer();
  try {
    const userCookie = await makeUser(s.url);
    const admin = await adminLogin(s.url);

    // До объявления полоса пуста, и это не «ключа нет», а «показывать нечего»
    const cold = await seenBy(s.url, userCookie);
    assert.strictEqual(cold.on, false);
    assert.strictEqual(cold.text, '');
    assert.strictEqual(cold.rev, 0);

    const TEXT = 'В субботу с 10:00 обновляем сервер — NewDay может ненадолго пропасть';
    const saved = await setAnnounce(s.url, admin.cookie, { text: TEXT, on: true });
    assert.strictEqual(saved.on, true);
    assert.strictEqual(saved.text, TEXT);

    const seen = await seenBy(s.url, userCookie);
    assert.strictEqual(seen.on, true, 'человек обязан увидеть то, что владелец включил');
    assert.strictEqual(seen.text, TEXT, 'слово в слово, без чистки и переносов');
    assert.strictEqual(seen.rev, saved.rev);

    const off = await setAnnounce(s.url, admin.cookie, { text: TEXT, on: false });
    assert.strictEqual(off.on, false);

    const hidden = await seenBy(s.url, userCookie);
    assert.strictEqual(hidden.on, false);
    assert.strictEqual(hidden.text, '', 'выключенный текст пользователю не отдаётся');
    assert.strictEqual(hidden.rev, saved.rev, 'редакция та же — закрытие полосы остаётся в силе');

    // А панель текст видит и погашенным: иначе форма при каждом открытии
    // показывала бы пустое поле и включить заготовленное было бы нечем
    const inPanel = await getJson(s.url, admin.cookie, '/api/admin/announce');
    assert.strictEqual(inPanel.text, TEXT);
    assert.strictEqual(inPanel.on, false);
  } finally { await s.close(); }
});

/*
 * Включённый показ при пустом тексте — не объявление, а пустая полоса поверх
 * приложения. Сервер отвечает «показывать нечего» так же, как на погашенный
 * тумблер: клиенту незачем различать эти два случая.
 */
test('включённый показ без текста не рисует пустую полосу', async () => {
  const s = await startTestServer();
  try {
    const userCookie = await makeUser(s.url);
    const admin = await adminLogin(s.url);

    const saved = await setAnnounce(s.url, admin.cookie, { text: '', on: true });
    assert.strictEqual(saved.on, true, 'тумблер записан как просили');

    const seen = await seenBy(s.url, userCookie);
    assert.strictEqual(seen.on, false, 'пустой текст показывать нечем');
    assert.strictEqual(seen.text, '');
  } finally { await s.close(); }
});

// ── Смайлики ─────────────────────────────────────────────────

/*
 * Владелец пишет обычными словами, и смайлик в них — норма. Дорога длинная:
 * JSON панели → SQLite → JSON приложения. Один лишний «санитайзер» по пути,
 * одна перекодировка в latin1 — и вместо ракеты приезжает «??».
 *
 * Длину сверяем нарочно: у «🚀» две единицы UTF-16, и совпадение length
 * доказывает, что суррогатная пара доехала парой, а не была порезана
 * пополам (порезанная выглядела бы как «�» и сравнение бы не прошло).
 */
test('смайлики доезжают дословно', async () => {
  const s = await startTestServer();
  try {
    const userCookie = await makeUser(s.url);
    const admin = await adminLogin(s.url);

    const TEXT = 'Всё уехало на новый сервер 🚀 спасибо!';
    const saved = await setAnnounce(s.url, admin.cookie, { text: TEXT, on: true });
    assert.strictEqual(saved.text, TEXT, 'панель получила обратно свой же текст');

    const seen = await seenBy(s.url, userCookie);
    assert.strictEqual(seen.text, TEXT);
    assert.strictEqual(seen.text.length, TEXT.length, 'суррогатная пара доехала целиком');
    assert.ok(seen.text.includes('🚀'));
    assert.ok(seen.text.includes('Всё'), 'кириллица с ё тоже часть проверки');

    // И в базе лежит тот же текст, а не экранированная замена
    const row = s.db.prepare("SELECT value FROM app_settings WHERE key = 'announceText'").get();
    assert.strictEqual(row.value, TEXT);
  } finally { await s.close(); }
});

// ── Смысл rev ────────────────────────────────────────────────

/*
 * Ради этого номера объявление и устроено так, как устроено.
 *
 * Человек закрыл полосу крестиком — клиент запомнил rev. Владелец после
 * этого сто раз щёлкнет тумблером: посмотрит, как выглядит, выключит на
 * время ремонта, включит снова. Поднимайся rev на каждом сохранении —
 * прочитанное объявление всплывало бы у всех после каждого щелчка, и полосу
 * перестали бы читать вовсе. А новый текст обязан показаться даже тем, кто
 * закрыл прежний, — значит от смены текста rev расти обязан.
 */
test('rev растёт от нового текста и не растёт от тумблера', async () => {
  const s = await startTestServer();
  try {
    const userCookie = await makeUser(s.url);
    const admin = await adminLogin(s.url);

    const A = 'Ремонт в субботу';
    const first = await setAnnounce(s.url, admin.cookie, { text: A, on: true });
    assert.strictEqual(first.rev, 1, 'первое объявление — первая редакция');

    const offSame = await setAnnounce(s.url, admin.cookie, { text: A, on: false });
    assert.strictEqual(offSame.rev, 1, 'выключение того же текста — не новая редакция');

    const onSame = await setAnnounce(s.url, admin.cookie, { text: A, on: true });
    assert.strictEqual(onSame.rev, 1, 'и включение обратно тоже');

    // Пробелы по краям обрезает валидатор — «тот же текст с отступом»
    // не должен считаться новой редакцией
    const padded = await setAnnounce(s.url, admin.cookie, { text: `  ${A}  `, on: true });
    assert.strictEqual(padded.rev, 1, 'лишние пробелы — не новость для читателя');
    assert.strictEqual(padded.text, A);

    const B = 'Ремонт перенесли на воскресенье';
    const second = await setAnnounce(s.url, admin.cookie, { text: B, on: true });
    assert.strictEqual(second.rev, 2, 'новый текст — новая редакция');

    // Пользователю приезжает та же редакция, что панели: по ней клиент
    // решает, закрывал он это объявление или пришло другое
    const seen = await seenBy(s.url, userCookie);
    assert.strictEqual(seen.rev, 2);
    assert.strictEqual(seen.text, B);

    /*
     * Стирание — тоже смена текста, и rev растёт. Пустое объявление никому
     * не покажется, но если позже вернуть прежние слова, это будет уже
     * следующая редакция — и её увидят даже те, кто закрывал первую.
     */
    const wiped = await setAnnounce(s.url, admin.cookie, { text: '', on: false });
    assert.strictEqual(wiped.rev, 3);
    const again = await setAnnounce(s.url, admin.cookie, { text: A, on: true });
    assert.strictEqual(again.rev, 4, 'вернувшийся текст — новая редакция, а не старая');
    const back = await seenBy(s.url, userCookie);
    assert.strictEqual(back.on, true);
    assert.strictEqual(back.rev, 4);
  } finally { await s.close(); }
});

// ── Предел длины ─────────────────────────────────────────────

/*
 * Две тысячи знаков — предел и в поле панели (maxlength), и здесь. Считаются
 * единицы UTF-16, ровно как их считает v.str: считай сервер кодовые точки,
 * поле обещало бы место, которого не даёт.
 *
 * Отказ обязан быть по-русски и называть поле: «Поле «значение» длиннее» не
 * говорит владельцу, где он перебрал.
 */
test('текст длиннее 2000 знаков отвергается, и прежнее объявление цело', async () => {
  const s = await startTestServer();
  try {
    const userCookie = await makeUser(s.url);
    const admin = await adminLogin(s.url);

    const KEPT = 'Короткое и важное';
    const saved = await setAnnounce(s.url, admin.cookie, { text: KEPT, on: true });

    const tooLong = await setAnnounce(s.url, admin.cookie, { text: 'я'.repeat(2001), on: true }, true);
    assert.strictEqual(tooLong.status, 400);
    const err = (await tooLong.json()).error;
    assert.match(err.message, /текст объявления/, 'владельцу надо сказать, какое поле не влезло');
    assert.match(err.message, /2000/, 'и назвать предел числом');

    // Отказ не должен стирать то, что уже висит
    const seen = await seenBy(s.url, userCookie);
    assert.strictEqual(seen.text, KEPT);
    assert.strictEqual(seen.rev, saved.rev, 'неудачная правка редакцию не двигает');

    // Ровно 2000 — ещё в пределах: граница принадлежит разрешённому
    const edge = 'я'.repeat(2000);
    const ok = await setAnnounce(s.url, admin.cookie, { text: edge, on: true });
    assert.strictEqual(ok.text.length, 2000);
    assert.strictEqual((await seenBy(s.url, userCookie)).text, edge);

    // Не строка — тоже внятный отказ, а не 500 из глубины репозитория
    const notText = await setAnnounce(s.url, admin.cookie, { text: 42, on: true }, true);
    assert.strictEqual(notText.status, 400);
    assert.match((await notText.json()).error.message, /текст объявления/);
  } finally { await s.close(); }
});
