/**
 * Перебор прокси на пути к модели.
 *
 * Проверяем не «функция что-то вернула», а то, ради чего перебор написан:
 * что сбойный прокси не задерживает человека, что о сбое помнят и второй
 * запрос через него не идёт, и что прокси, который принял соединение и
 * молчит, не подвешивает запрос навсегда — это самый частый способ сломаться
 * у прокси и самый незаметный.
 */

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { createDb } = require('../../server/db');
const { runMigrations } = require('../../server/db/migrations');
const { createAiFetch } = require('../../server/lib/aiFetch');
const { tmpDatabase } = require('../helpers/server');

const URL_TO_MODEL = 'https://provider.test/v1/chat/completions';

/** Прокси, который принимает соединение и не отвечает ничего и никогда. */
function blackHole() {
  return new Promise(resolve => {
    const alive = [];
    // resume() — чтобы сторона прокси замечала, что клиент ушёл: приостановленный
    // сокет не разбирает входящий поток и не увидит закрытия
    const srv = net.createServer(s => { alive.push(s); s.resume(); s.on('error', () => {}); });
    srv.listen(0, '127.0.0.1', () => resolve({
      port: srv.address().port,
      /** Сколько соединений прокси всё ещё держит открытыми. */
      openSockets: () => alive.filter(s => !s.destroyed).length,
      close: () => { alive.forEach(s => s.destroy()); srv.close(); },
    }));
  });
}

/** Порт, на котором никто не слушает: соединение отвергается сразу. */
function deadPort() {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function sandbox() {
  const t = tmpDatabase();
  const db = createDb(t.file);
  runMigrations(db);
  return { db, cleanup: () => { db.close(); t.cleanup(); } };
}

const addProxy = (db, port) => db
  .prepare('INSERT INTO ai_proxies (type, host, port, position) VALUES (?,?,?,?)')
  .run('http', '127.0.0.1', port, 1);

/** Ждём, пока условие станет верным: закрытие сокета доезжает не в тот же тик. */
async function eventually(check, ms = 2000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return check();
}

/** Ждём результат, но не вечно: висящий промис должен быть виден как провал. */
function within(ms, promise, what) {
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: ответа нет за ${ms} мс`)), ms);
  });
  return Promise.race([promise, watchdog]).finally(() => clearTimeout(timer));
}

test('прокси, который не отвечает, помечается сбойным и не мешает следующему запросу', async () => {
  const { db, cleanup } = sandbox();
  try {
    addProxy(db, await deadPort());
    let direct = 0;
    const aiFetch = createAiFetch(db, {
      fetchImpl: async () => { direct += 1; return { ok: true, status: 200 }; },
    });

    const first = await aiFetch(URL_TO_MODEL, { method: 'POST', body: '{}' });
    assert.strictEqual(first.status, 200, 'кончились прокси — идём напрямую');
    assert.strictEqual(direct, 1);

    await aiFetch(URL_TO_MODEL, { method: 'POST', body: '{}' });
    assert.strictEqual(direct, 2, 'второй запрос в мёртвый прокси уже не стучится');
  } finally { cleanup(); }
});

/*
 * Прокси, который принимает соединение и молчит.
 *
 * Ответ на аборт приходил не от запроса, а ниоткуда: пока агент ещё
 * договаривается с прокси о туннеле, у запроса нет сокета, и req.destroy()
 * в этот момент не даёт ни 'error', ни 'close'. Промис не завершался
 * никогда: таймаут срабатывал, а обращение к помощнику висело до конца
 * жизни процесса — вместе с сокетом и незакрытым ответом клиенту. И так
 * каждый следующий запрос, потому что о сбое никто не узнавал.
 */
test('прокси-молчун не подвешивает запрос навсегда', async () => {
  const { db, cleanup } = sandbox();
  const hole = await blackHole();
  try {
    addProxy(db, hole.port);
    let direct = 0;
    const aiFetch = createAiFetch(db, {
      fetchImpl: async () => { direct += 1; return { ok: true, status: 200 }; },
    });

    const failed = await within(5000, aiFetch(URL_TO_MODEL, {
      method: 'POST', body: '{}', signal: AbortSignal.timeout(300),
    }).then(() => null, e => e), 'запрос через прокси-молчун');

    assert.ok(failed, 'запрос обязан завершиться отказом, а не висеть');
    assert.strictEqual(failed.name, 'TimeoutError',
      'наружу уходит тот же таймаут, что и без прокси');
    assert.ok(await eventually(() => hole.openSockets() === 0),
      'соединение с прокси закрыто, а не брошено');

    // О сбое помнят: следующий запрос не повторяет ожидание, а идёт напрямую
    const next = await within(5000, aiFetch(URL_TO_MODEL, {
      method: 'POST', body: '{}', signal: AbortSignal.timeout(5000),
    }), 'следующий запрос');
    assert.strictEqual(next.status, 200);
    assert.strictEqual(direct, 1, 'молчун помечен сбойным и пропущен');
  } finally { hole.close(); cleanup(); }
});
