/**
 * Свои звуки будильника.
 *
 * Проверяем не «эндпоинт отвечает», а обещания контракта: файл возвращается
 * тем же, каким пришёл, и с теми заголовками, на которые рассчитывает тег
 * audio; лимиты отказывают по-русски и заранее; чужие звуки не видны даже
 * по точному id; read-токен слушает, но не пишет.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson } = require('../helpers/client');

/** МБ здесь двоичный — как в лимите на сервере. */
const MB = 1024 * 1024;

/** Загружает звук формой — так же, как это делает браузер. */
async function upload(s, { buf, type = 'audio/mpeg', filename = 'zvuk.mp3', name, headers = {} } = {}) {
  const form = new FormData();
  form.append('file', new Blob([buf ?? Buffer.from('id3-подделка')], { type }), filename);
  if (name !== undefined) form.append('name', name);
  return fetch(`${s.url}/api/v1/sounds`, {
    method: 'POST',
    headers: { cookie: s.cookie, ...headers },
    body: form,
  });
}

// ── Основной путь: загрузить, увидеть, послушать, удалить ────

test('звук загружается, попадает в список, отдаётся байт в байт и удаляется', async () => {
  const s = await loggedIn();
  try {
    const noise = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
    const created = await (await upload(s, { buf: noise, name: 'Утро' })).json();

    assert.strictEqual(created.name, 'Утро');
    assert.strictEqual(created.mime, 'audio/mpeg');
    assert.strictEqual(created.sizeBytes, noise.length);
    assert.ok(created.id >= 1);
    assert.ok(created.createdAt, 'когда загружен — часть ответа');

    const list = await getJson(s.url, s.cookie, '/api/v1/sounds');
    assert.deepStrictEqual(list, [created], 'список отдаёт ту же форму, что и загрузка');

    // Файл — с верным типом и кешем на час, но только себе (private)
    const file = await fetch(`${s.url}/api/v1/sounds/${created.id}/file`, {
      headers: { cookie: s.cookie },
    });
    assert.strictEqual(file.status, 200);
    assert.strictEqual(file.headers.get('content-type'), 'audio/mpeg');
    assert.strictEqual(file.headers.get('cache-control'), 'private, max-age=3600');
    assert.deepStrictEqual(Buffer.from(await file.arrayBuffer()), noise,
      'файл должен вернуться тем же, каким пришёл');

    const del = await api(s.url, s.cookie, 'DELETE', `/api/v1/sounds/${created.id}`);
    assert.deepStrictEqual(del, { success: true });
    assert.deepStrictEqual(await getJson(s.url, s.cookie, '/api/v1/sounds'), []);

    const gone = await fetch(`${s.url}/api/v1/sounds/${created.id}/file`, {
      headers: { cookie: s.cookie },
    });
    assert.strictEqual(gone.status, 404);
  } finally { await s.close(); }
});

test('без поля name имя берётся из имени файла без расширения', async () => {
  const s = await loggedIn();
  try {
    const r = await (await upload(s, { filename: 'Пение птиц.mp3' })).json();
    assert.strictEqual(r.name, 'Пение птиц');
  } finally { await s.close(); }
});

test('файл доступен и по Bearer-токену — не только из браузера', async () => {
  const s = await loggedIn();
  try {
    const created = await (await upload(s, {})).json();
    const { token } = await api(s.url, s.cookie, 'POST', '/api/v1/tokens',
      { name: 'читалка', scope: 'read' });

    const file = await fetch(`${s.url}/api/v1/sounds/${created.id}/file`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(file.status, 200);
    assert.strictEqual(file.headers.get('content-type'), 'audio/mpeg');
  } finally { await s.close(); }
});

// ── Лимиты ───────────────────────────────────────────────────

test('файл больше 10 МБ не принимается, и в отказе назван его вес', async () => {
  const s = await loggedIn();
  try {
    const r = await upload(s, { buf: Buffer.alloc(11 * MB) });
    assert.strictEqual(r.status, 400);
    const { error } = await r.json();
    assert.match(error.message, /Файл весит 11 МБ, а будильнику хватает 10/);
    assert.deepStrictEqual(await getJson(s.url, s.cookie, '/api/v1/sounds'), [],
      'отказанный файл не должен оставить следа');
  } finally { await s.close(); }
});

test('лимит режет и без честного Content-Length — по фактическим байтам', async () => {
  const s = await loggedIn();
  try {
    // Chunked-запрос: заголовка с размером нет, врать нечем
    const boundary = '----granica0123456789';
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const body = new ReadableStream({
      start(c) {
        c.enqueue(Buffer.from(head));
        for (let i = 0; i < 11; i++) c.enqueue(new Uint8Array(MB));
        c.enqueue(Buffer.from(tail));
        c.close();
      },
    });
    const r = await fetch(`${s.url}/api/v1/sounds`, {
      method: 'POST',
      headers: { cookie: s.cookie, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
      duplex: 'half',
    });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error.message, /будильнику хватает 10/);
  } finally { await s.close(); }
});

test('двадцать первый звук не принимается', async () => {
  const s = await loggedIn();
  try {
    const userId = s.db.prepare('SELECT id FROM users').get().id;
    const ins = s.db.prepare(
      "INSERT INTO user_sounds (user_id, name, mime, ext, size_bytes) VALUES (?, ?, 'audio/mpeg', 'mp3', 1)",
    );
    for (let i = 1; i <= 20; i++) ins.run(userId, `Звук ${i}`);

    const r = await upload(s, {});
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error.message, /Уже 20 своих звуков — удалите ненужный/);
  } finally { await s.close(); }
});

test('не-звук отвергается по типу', async () => {
  const s = await loggedIn();
  try {
    for (const type of ['text/plain', 'video/mp4', 'application/octet-stream']) {
      const r = await upload(s, { type, filename: 'подозрительный.bin' });
      assert.strictEqual(r.status, 400, type);
      assert.match((await r.json()).error.message,
        /Это не похоже на звук: нужен mp3, ogg, wav или m4a/);
    }
    // А заявленные в контракте типы — принимаются
    for (const type of ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/x-m4a']) {
      const r = await upload(s, { type, filename: 'melodia' });
      assert.strictEqual(r.status, 201, type);
    }
  } finally { await s.close(); }
});

// ── Границы доступа ──────────────────────────────────────────

test('чужой звук — 404, даже с точным id', async () => {
  const s = await loggedIn();
  try {
    const created = await (await upload(s, {})).json();
    const other = await loggedIn({ email: 'sosed@example.com', server: s.srv });

    assert.deepStrictEqual(await getJson(s.url, other.cookie, '/api/v1/sounds'), []);
    for (const [method, path] of [
      ['GET', `/api/v1/sounds/${created.id}/file`],
      ['DELETE', `/api/v1/sounds/${created.id}`],
    ]) {
      const r = await api(s.url, other.cookie, method, path, undefined, {}, true);
      assert.strictEqual(r.status, 404, `${method} ${path}`);
    }
    // И у хозяина звук цел
    assert.strictEqual((await getJson(s.url, s.cookie, '/api/v1/sounds')).length, 1);
  } finally { await s.close(); }
});

test('read-токен слушает и смотрит, но не загружает и не удаляет', async () => {
  const s = await loggedIn();
  try {
    const created = await (await upload(s, {})).json();
    const { token } = await api(s.url, s.cookie, 'POST', '/api/v1/tokens',
      { name: 'ro', scope: 'read' });
    const h = { Authorization: `Bearer ${token}` };

    const list = await fetch(`${s.url}/api/v1/sounds`, { headers: h });
    assert.strictEqual(list.status, 200);

    // Запрос уйдёт и с cookie, и с Bearer — сервер нарочно выбирает Bearer,
    // поэтому scope здесь именно токенный
    const write = await upload(s, { headers: h });
    assert.strictEqual(write.status, 403);
    assert.strictEqual((await write.json()).error.code, 'INSUFFICIENT_SCOPE');

    const del = await fetch(`${s.url}/api/v1/sounds/${created.id}`, { method: 'DELETE', headers: h });
    assert.strictEqual(del.status, 403);
  } finally { await s.close(); }
});
