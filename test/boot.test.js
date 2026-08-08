const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const tmp = require('../tools/lib/tmp');

/**
 * Проверка настоящей точки входа.
 *
 * Остальные тесты поднимают server/app.js фабрикой, минуя server/index.js —
 * из-за этого синтаксическая ошибка в index.js однажды прошла все 144 теста
 * и всплыла только при запуске в контейнере. Этот тест закрывает пробел:
 * он запускает ровно то, что запускает Docker.
 */

const ROOT = path.join(__dirname, '..');

function startServer(env) {
  const dir = tmp.tempDir('boot');
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: '0',
      DB_PATH: path.join(dir, 'boot.db'),
      SMTP_HOST: '',
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });

  return {
    child, dir,
    output: () => out,
    async waitForListen(timeoutMs = 15000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (child.exitCode !== null) throw new Error(`процесс упал: ${out}`);
        const m = out.match(/listening on port (\d+)/);
        if (m) return Number(m[1]);
        await new Promise(r => setTimeout(r, 150));
      }
      throw new Error(`сервер не поднялся за ${timeoutMs} мс: ${out}`);
    },
    /**
     * Windows не отдаёт файл базы, пока процесс жив, поэтому сначала ждём его
     * выхода, и только потом убираем каталог. Уборкой занимается общий модуль:
     * он и повторит попытку, и скажет в stderr, если каталог всё же остался, —
     * прежний молчаливый цикл из пяти попыток просто сдавался и утечка
     * становилась невидимой.
     */
    async stop() {
      if (child.exitCode === null) {
        child.kill();
        await new Promise(r => child.once('exit', r));
      }
      tmp.releaseSync(dir);
    },
  };
}

test('server/index.js запускается и отвечает на /api/health', async () => {
  const srv = startServer({ SESSION_SECRET: 'boot-test-secret-0123456789012345678' });
  try {
    const port = await srv.waitForListen();
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.ok(body.schemaVersion >= 3);
  } finally { await srv.stop(); }
});

test('без SMTP и VAPID приложение поднимается и сообщает об этом', async () => {
  const srv = startServer({ SESSION_SECRET: 'boot-test-secret-0123456789012345678' });
  try {
    await srv.waitForListen();
    assert.match(srv.output(), /push disabled/i, 'в логе есть отметка про выключенный push');
  } finally { await srv.stop(); }
});

test('слабый SESSION_SECRET вызывает предупреждение, но не мешает запуску', async () => {
  const srv = startServer({ SESSION_SECRET: 'change_me_please' });
  try {
    await srv.waitForListen();
    assert.match(srv.output(), /SESSION_SECRET/, 'предупреждение выведено');
  } finally { await srv.stop(); }
});

test('миграции применяются на пустой базе при первом запуске', async () => {
  const srv = startServer({ SESSION_SECRET: 'boot-test-secret-0123456789012345678' });
  try {
    await srv.waitForListen();
    assert.match(srv.output(), /schema 0 → \d+/, 'схема создана с нуля');
  } finally { await srv.stop(); }
});
