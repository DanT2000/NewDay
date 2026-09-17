/**
 * Устойчивость: то, от чего сервер не должен ни падать, ни зависать.
 *
 * Каждая проверка здесь выросла из воспроизведённой поломки, а не из
 * предположения: нечитаемое вложение роняло процесс целиком, кривое тело
 * запроса отвечало «внутренней ошибкой», а статистика за двести лет
 * блокировала сервер на четырнадцать секунд.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loggedIn, api, post } = require('../helpers/client');

/** Сообщение о проблеме со снимком экрана: multipart руками, без библиотек. */
async function отправитьСнимок(s) {
  const boundary = '----newday-test-boundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\nпроба\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="shot"; filename="s.png"\r\n`
      + 'Content-Type: image/png\r\n\r\n'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const r = await fetch(`${s.url}/api/v1/reports`, {
    method: 'POST',
    headers: { cookie: s.cookie, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  assert.strictEqual(r.status, 201, 'сообщение о проблеме создано');
  return r.json();
}

test('нечитаемое вложение не роняет сервер', async () => {
  const s = await loggedIn({ env: { ADMIN_EMAILS: 'user@example.com' } });
  try {
    const отчёт = await отправитьСнимок(s);
    const файл = path.join(s.config.reportsDir, String(отчёт.id), 'shot.png');
    assert.ok(fs.existsSync(файл), 'снимок лёг на диск');

    /*
     * Файл на месте, а прочитать его нельзя — на его месте каталог. Так же
     * ведёт себя том с ошибкой ввода-вывода и файл, удалённый между
     * проверкой существования и открытием: поток бросает событие error, и
     * без обработчика это необработанное исключение, то есть смерть всего
     * процесса вместе с чужими сессиями.
     */
    fs.unlinkSync(файл);
    fs.mkdirSync(файл);

    const r = await api(s.url, s.cookie, 'GET', `/api/v1/reports/${отчёт.id}/shot`, undefined, {}, true);
    assert.ok(r.status >= 400, `отказ, а не падение (пришло ${r.status})`);

    // сервер жив и отвечает на следующий запрос
    const после = await api(s.url, s.cookie, 'GET', '/api/v1/reports', undefined, {}, true);
    assert.strictEqual(после.status, 200, 'сервер продолжает работать');
  } finally { await s.close(); }
});

test('кривое и слишком большое тело — это ошибка запроса, а не внутренняя', async () => {
  const s = await loggedIn();
  try {
    const кривое = await fetch(`${s.url}/api/v1/notes`, {
      method: 'POST',
      headers: { cookie: s.cookie, 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.strictEqual(кривое.status, 400, 'оборванный JSON — 400');
    const тело = await кривое.json();
    assert.notStrictEqual(тело.error?.code, 'INTERNAL', 'и не «внутренняя ошибка»');

    const огромное = await fetch(`${s.url}/api/v1/notes`, {
      method: 'POST',
      headers: { cookie: s.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'я'.repeat(3 * 1024 * 1024) }),
    });
    assert.strictEqual(огромное.status, 413, 'тело больше лимита — 413');
  } finally { await s.close(); }
});

test('статистика за огромный период отклоняется, а не морозит сервер', async () => {
  const s = await loggedIn();
  try {
    const t = Date.now();
    const r = await api(s.url, s.cookie, 'GET', '/api/v1/stats?from=1900-01-01&to=2100-01-01', undefined, {}, true);
    const прошло = Date.now() - t;
    assert.strictEqual(r.status, 400, 'двести лет — отказ');
    assert.ok(прошло < 3000, `отказ быстрый, а не после расчёта (${прошло} мс)`);

    const год = await api(s.url, s.cookie, 'GET', '/api/v1/stats?from=2026-01-01&to=2026-12-31', undefined, {}, true);
    assert.strictEqual(год.status, 200, 'год по-прежнему считается');

    // статистика одной привычки — тот же предел
    const h = await api(s.url, s.cookie, 'POST', '/api/v1/habits', { title: 'Вода' });
    const долгая = await api(s.url, s.cookie, 'GET',
      `/api/v1/habits/${h.id}/stats?from=1900-01-01&to=2100-01-01`, undefined, {}, true);
    assert.strictEqual(долгая.status, 400, 'и у привычки период ограничен');
  } finally { await s.close(); }
});

test('выкладка APK без токена отказывает, не читая тело целиком', async () => {
  const s = await loggedIn({ env: { APK_UPLOAD_TOKEN: 'right-token-123' } });
  try {
    /*
     * Маршрут публичный: до проверки токена сервер буферизовал в память всё
     * присланное — до 80 МБ на запрос, без входа. Несколько параллельных
     * запросов укладывали контейнер по памяти. Тело должно отвергаться
     * вместе с запросом, а не после полной выгрузки.
     */
    const r = await fetch(`${s.url}/api/v1/app/upload?versionName=9.9.9`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(5 * 1024 * 1024, 7),
    });
    assert.strictEqual(r.status, 401, 'без токена — отказ');

    const живой = await api(s.url, s.cookie, 'GET', '/api/v1/app/version', undefined, {}, true);
    assert.strictEqual(живой.status, 200, 'сервер жив');
  } finally { await s.close(); }
});

test('скачивание APK с испорченным файлом не роняет сервер', async () => {
  const s = await loggedIn({ env: { APK_UPLOAD_TOKEN: 'right-token-123' } });
  try {
    const apk = Buffer.concat([Buffer.from('PK'), Buffer.alloc(2048, 1)]);
    const up = await fetch(`${s.url}/api/v1/app/upload?versionName=1.2.3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Token': 'right-token-123' },
      body: apk,
    });
    assert.strictEqual(up.status, 200, 'APK выложен');

    // подменяем файл каталогом — как если бы том отвалился или файл удалили
    const meta = JSON.parse(fs.readFileSync(path.join(s.config.apkDir, 'latest.json'), 'utf8'));
    const файл = path.join(s.config.apkDir, meta.fileName);
    fs.unlinkSync(файл);
    fs.mkdirSync(файл);

    const r = await fetch(`${s.url}/api/v1/app/download`);
    assert.ok(r.status >= 400, `отказ, а не падение (пришло ${r.status})`);
    await r.arrayBuffer().catch(() => null);

    const живой = await api(s.url, s.cookie, 'GET', '/api/v1/app/version', undefined, {}, true);
    assert.strictEqual(живой.status, 200, 'сервер жив');
  } finally { await s.close(); }
});
