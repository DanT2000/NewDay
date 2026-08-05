const test = require('node:test');
const assert = require('node:assert');
const { startTestServer } = require('./helpers/server');

test('GET /api/health отдаёт ok и версию схемы', async () => {
  const srv = await startTestServer();
  try {
    const res = await fetch(`${srv.url}/api/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.dbWritable, true);
    assert.strictEqual(typeof body.schemaVersion, 'number');
    assert.ok(body.schemaVersion >= 1);
  } finally {
    await srv.close();
  }
});

/*
 * Признак подключения помощника открыт без входа нарочно: иначе после
 * развёртывания нечем проверить, доехали ли переменные до контейнера.
 * Но открыто ровно «да/нет» — ни ключа, ни адреса, ни названий моделей.
 */
test('в /api/health виден признак помощника, но не его настройки', async () => {
  const секрет = 'sk-очень-секретный-ключ';
  const srv = await startTestServer({
    env: {
      AI_BASE_URL: 'https://provider.test/v1',
      AI_API_KEY: секрет,
      AI_MODEL: 'быстрая',
      AI_VOICE_MODEL: 'голосовая',
    },
  });
  try {
    const body = await (await fetch(`${srv.url}/api/health`)).json();
    assert.deepStrictEqual(body.ai, { ready: true, voice: true });

    const весь = JSON.stringify(body);
    assert.ok(!весь.includes(секрет), 'ключ не должен попадать в открытый ответ');
    assert.ok(!весь.includes('provider.test'), 'адрес провайдера тоже лишний');
    assert.ok(!весь.includes('быстрая'), 'названия моделей наружу не нужны');
  } finally {
    await srv.close();
  }
});

test('без подключения помощника признак говорит об этом честно', async () => {
  const srv = await startTestServer();
  try {
    const body = await (await fetch(`${srv.url}/api/health`)).json();
    assert.deepStrictEqual(body.ai, { ready: false, voice: false });
  } finally {
    await srv.close();
  }
});
