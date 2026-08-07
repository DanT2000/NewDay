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

/*
 * То же и про уведомления: без VAPID-ключей они не работают, а узнать об
 * этом иначе можно только войдя в настройки — то есть уже после того, как
 * человек не дождался напоминания.
 */
test('в /api/health виден признак уведомлений, но не ключи', async () => {
  const секрет = 'Zx3nJ0KQ0uS1cQ8k9Yy0oJ1n2Z3a4B5c6D7e8F9g0hI';
  const srv = await startTestServer({
    env: {
      VAPID_PUBLIC_KEY: 'BK4HJB_Mb9Uz9H66xlas5-RELrPKhXeVSSe9h9hz33S6VvVCEJ0j9nLPXt4H8pRZmqBl4uCq3iC7QZlYfHmMPBw',
      VAPID_PRIVATE_KEY: секрет,
      VAPID_SUBJECT: 'mailto:test@example.com',
    },
  });
  try {
    const body = await (await fetch(`${srv.url}/api/health`)).json();
    assert.deepStrictEqual(body.push, { enabled: true });
    assert.ok(!JSON.stringify(body).includes(секрет), 'закрытый ключ наружу не отдаём');
  } finally {
    await srv.close();
  }
});

test('без VAPID-ключей признак уведомлений честно выключен', async () => {
  const srv = await startTestServer();
  try {
    const body = await (await fetch(`${srv.url}/api/health`)).json();
    assert.deepStrictEqual(body.push, { enabled: false });
  } finally {
    await srv.close();
  }
});

/*
 * Ложной тревоги от окончательно неудавшихся уведомлений быть не должно.
 *
 * Уведомление, трижды упавшее на мёртвой подписке, навсегда остаётся без
 * sent_at — но планировщик такие больше не берёт, и «очередь стоит» они не
 * означают. Без учёта failed_at одна протухшая браузерная подписка держала
 * бы 503 на живом сервере до суток — ночная ложная тревога у наблюдалки.
 */
test('окончательно неудавшееся уведомление не валит здоровье', async () => {
  const srv = await startTestServer({
    env: {
      VAPID_PUBLIC_KEY: 'BK4HJB_Mb9Uz9H66xlas5-RELrPKhXeVSSe9h9hz33S6VvVCEJ0j9nLPXt4H8pRZmqBl4uCq3iC7QZlYfHmMPBw',
      VAPID_PRIVATE_KEY: 'Zx3nJ0KQ0uS1cQ8k9Yy0oJ1n2Z3a4B5c6D7e8F9g0hI',
      VAPID_SUBJECT: 'mailto:test@example.com',
    },
  });
  try {
    srv.db.prepare(
      "INSERT INTO users (username, email, password_hash, email_verified) VALUES ('q', 'q@b.ru', 'x', 1)",
    ).run();
    const userId = srv.db.prepare("SELECT id FROM users WHERE email = 'q@b.ru'").get().id;
    // час просроченное и окончательно неудавшееся: sent_at пуст, failed_at стоит
    srv.db.prepare(`
      INSERT INTO notification_queue (user_id, dedupe_key, fire_at_utc, payload_json, failed_at, attempts)
      VALUES (?, 'k1', ?, '{}', datetime('now'), 3)
    `).run(userId, Date.now() - 60 * 60 * 1000);

    const res = await fetch(`${srv.url}/api/health`);
    assert.strictEqual(res.status, 200, 'упавшее навсегда — не «очередь стоит»');

    // а честно ждущее и просроченное — ловится
    srv.db.prepare(`
      INSERT INTO notification_queue (user_id, dedupe_key, fire_at_utc, payload_json)
      VALUES (?, 'k2', ?, '{}')
    `).run(userId, Date.now() - 60 * 60 * 1000);
    const res2 = await fetch(`${srv.url}/api/health`);
    assert.strictEqual(res2.status, 503, 'застрявшую очередь видно как раньше');
  } finally {
    await srv.close();
  }
});
