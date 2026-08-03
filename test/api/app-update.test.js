const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startTestServer } = require('../helpers/server');
const { apkStore, versionCodeOf } = require('../../server/services/apkStore');
const { updateService, parseTag } = require('../../server/services/updateService');

const UPLOAD_TOKEN = 'test-upload-token-0123456789';

/** Минимальный «APK»: важно только то, что это zip нужного размера. */
function fakeApk(size = 4096) {
  const buf = Buffer.alloc(size, 7);
  buf[0] = 0x50; buf[1] = 0x4b; buf[2] = 0x03; buf[3] = 0x04;
  return buf;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'newday-apk-test-'));
}

// ── Сравнение версий ─────────────────────────────────────────

test('versionCode считается так же, как в сборке', () => {
  assert.strictEqual(versionCodeOf('1.0.0'), 10000);
  assert.strictEqual(versionCodeOf('1.2.3'), 10203);
  assert.strictEqual(versionCodeOf('v2.0.1'), 20001);
  assert.strictEqual(versionCodeOf('чепуха'), 0);
});

test('1.10.0 новее 1.9.0 — строкой это сравнить нельзя', () => {
  assert.ok(versionCodeOf('1.10.0') > versionCodeOf('1.9.0'));
});

test('parseTag разбирает тег релиза', () => {
  assert.deepStrictEqual(parseTag('v1.4.2'), { versionName: '1.4.2', versionCode: 10402 });
  assert.strictEqual(parseTag('latest'), null);
});

// ── Хранилище ────────────────────────────────────────────────

test('сохраняет APK и отдаёт сведения о нём', () => {
  const dir = tmpDir();
  try {
    const store = apkStore({ dir });
    assert.strictEqual(store.current(), null, 'пока ничего не выложено');

    const meta = store.save(fakeApk(), { versionName: '1.0.0', notes: 'первая' });
    assert.strictEqual(meta.versionName, '1.0.0');
    assert.strictEqual(meta.versionCode, 10000);
    assert.strictEqual(meta.fileName, 'NewDay-1.0.0.apk');
    assert.match(meta.sha256, /^[0-9a-f]{64}$/);

    const cur = store.current();
    assert.strictEqual(cur.versionName, '1.0.0');
    assert.ok(fs.existsSync(cur.filePath));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('версию не новее не принимает: подмена свежего APK старым ломает обновление', () => {
  const dir = tmpDir();
  try {
    const store = apkStore({ dir });
    store.save(fakeApk(), { versionName: '1.2.0' });
    assert.throws(() => store.save(fakeApk(), { versionName: '1.1.9' }), /не новее/);
    assert.throws(() => store.save(fakeApk(), { versionName: '1.2.0' }), /не новее/);
    assert.strictEqual(store.current().versionName, '1.2.0');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('не-APK и мусорную версию отвергает', () => {
  const dir = tmpDir();
  try {
    const store = apkStore({ dir });
    assert.throws(() => store.save(Buffer.alloc(4096), { versionName: '1.0.0' }), /не APK/);
    assert.throws(() => store.save(fakeApk(), { versionName: 'latest' }), /1\.2\.3/);
    assert.throws(() => store.save(fakeApk(10), { versionName: '1.0.0' }), /маленьк/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('держит несколько последних версий, старые убирает', () => {
  const dir = tmpDir();
  try {
    const store = apkStore({ dir });
    for (const v of ['1.0.0', '1.0.1', '1.0.2', '1.0.3', '1.0.4']) {
      store.save(fakeApk(), { versionName: v });
    }
    const apks = fs.readdirSync(dir).filter(f => f.endsWith('.apk')).sort();
    assert.deepStrictEqual(apks, ['NewDay-1.0.2.apk', 'NewDay-1.0.3.apk', 'NewDay-1.0.4.apk']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Выбор источника ──────────────────────────────────────────

test('выложенное на сайт важнее GitHub', async () => {
  const dir = tmpDir();
  try {
    const store = apkStore({ dir });
    store.save(fakeApk(), { versionName: '2.0.0' });
    let githubCalled = false;
    const svc = updateService(
      { update: { enabled: true, repo: 'x/y' } },
      { store, fetchImpl: async () => { githubCalled = true; throw new Error('не должны были спрашивать'); } },
    );
    const latest = await svc.latest();
    assert.strictEqual(latest.versionName, '2.0.0');
    assert.strictEqual(latest.source, 'site');
    assert.strictEqual(latest.apkUrl, '/api/v1/app/download');
    assert.strictEqual(githubCalled, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('без выложенного файла берёт версию из окружения', async () => {
  const svc = updateService({
    update: { enabled: true, apkUrl: 'https://example.test/a.apk', versionName: '3.1.0' },
  }, { store: { current: () => null } });
  const latest = await svc.latest();
  assert.strictEqual(latest.versionCode, 30100);
  assert.strictEqual(latest.source, 'env');
});

test('GitHub — запасной источник, и только если репозиторий задан', async () => {
  const empty = updateService({ update: { enabled: true, repo: '' } }, { store: { current: () => null } });
  assert.strictEqual(await empty.latest(), null);

  let calls = 0;
  const svc = updateService({ update: { enabled: true, repo: 'a/b' } }, {
    store: { current: () => null },
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({
          tag_name: 'v1.5.0',
          body: 'заметки',
          assets: [{ name: 'NewDay-1.5.0.apk', size: 123, browser_download_url: 'https://x/y.apk' }],
        }),
      };
    },
  });
  const first = await svc.latest();
  assert.strictEqual(first.versionName, '1.5.0');
  assert.strictEqual(first.source, 'github');
  await svc.latest();
  assert.strictEqual(calls, 1, 'ответ кэшируется, GitHub не спрашиваем на каждый запрос');
});

test('недоступный GitHub не роняет проверку', async () => {
  const svc = updateService({ update: { enabled: true, repo: 'a/b' } }, {
    store: { current: () => null },
    fetchImpl: async () => { throw new Error('сети нет'); },
  });
  assert.strictEqual(await svc.latest(), null);
});

test('UPDATE_DISABLED выключает проверку целиком', async () => {
  const dir = tmpDir();
  try {
    const store = apkStore({ dir });
    store.save(fakeApk(), { versionName: '9.9.9' });
    const svc = updateService({ update: { enabled: false } }, { store });
    assert.strictEqual(await svc.latest(), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Эндпоинты ────────────────────────────────────────────────

test('версия доступна без входа и сообщает, что APK нет', async () => {
  const s = await startTestServer({ env: { APK_DIR: tmpDir() } });
  try {
    const res = await fetch(`${s.url}/api/v1/app/version`);
    assert.strictEqual(res.status, 200, 'без cookie и токена');
    const body = await res.json();
    assert.strictEqual(body.latest, null);

    const dl = await fetch(`${s.url}/api/v1/app/download`);
    assert.strictEqual(dl.status, 404);
  } finally { await s.close(); }
});

test('выкладка закрыта, пока не задан токен', async () => {
  const s = await startTestServer({ env: { APK_DIR: tmpDir() } });
  try {
    const res = await fetch(`${s.url}/api/v1/app/upload?versionName=1.0.0`, {
      method: 'POST', body: fakeApk(),
    });
    assert.strictEqual(res.status, 503);
    const body = await res.json();
    assert.match(body.error.code, /UPLOAD_DISABLED/);
  } finally { await s.close(); }
});

test('выкладка требует верный токен', async () => {
  const s = await startTestServer({ env: { APK_DIR: tmpDir(), APK_UPLOAD_TOKEN: UPLOAD_TOKEN } });
  try {
    // значения только из ASCII: кириллица в заголовке недопустима в принципе
    for (const token of ['', 'wrong-token', UPLOAD_TOKEN + 'x', UPLOAD_TOKEN.slice(0, -1)]) {
      const res = await fetch(`${s.url}/api/v1/app/upload?versionName=1.0.0`, {
        method: 'POST', headers: { 'X-Upload-Token': token }, body: fakeApk(),
      });
      assert.strictEqual(res.status, 401, `токен «${token}» не должен работать`);
    }
  } finally { await s.close(); }
});

test('выложенный APK сразу отдаётся и попадает в версию', async () => {
  const dir = tmpDir();
  const s = await startTestServer({ env: { APK_DIR: dir, APK_UPLOAD_TOKEN: UPLOAD_TOKEN } });
  try {
    const apk = fakeApk(8192);
    const up = await fetch(`${s.url}/api/v1/app/upload?versionName=1.4.0&notes=%D1%82%D0%B5%D1%81%D1%82`, {
      method: 'POST',
      headers: { 'X-Upload-Token': UPLOAD_TOKEN, 'Content-Type': 'application/octet-stream' },
      body: apk,
    });
    assert.strictEqual(up.status, 200);
    const meta = await up.json();
    assert.strictEqual(meta.versionName, '1.4.0');
    assert.strictEqual(meta.sizeBytes, 8192);

    const ver = await (await fetch(`${s.url}/api/v1/app/version`)).json();
    assert.strictEqual(ver.latest.versionName, '1.4.0');
    assert.strictEqual(ver.latest.versionCode, 10400);
    assert.strictEqual(ver.latest.notes, 'тест');

    const dl = await fetch(`${s.url}/api/v1/app/download`);
    assert.strictEqual(dl.status, 200);
    assert.strictEqual(dl.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.match(dl.headers.get('content-disposition'), /NewDay-1\.4\.0\.apk/);
    const got = Buffer.from(await dl.arrayBuffer());
    assert.strictEqual(got.length, apk.length, 'файл отдаётся байт в байт');
    assert.ok(got.equals(apk));
  } finally { await s.close(); }
});

test('повторная выкладка той же версии — 409, файл остаётся прежним', async () => {
  const dir = tmpDir();
  const s = await startTestServer({ env: { APK_DIR: dir, APK_UPLOAD_TOKEN: UPLOAD_TOKEN } });
  try {
    const opts = {
      method: 'POST',
      headers: { 'X-Upload-Token': UPLOAD_TOKEN },
      body: fakeApk(),
    };
    assert.strictEqual((await fetch(`${s.url}/api/v1/app/upload?versionName=1.0.0`, opts)).status, 200);
    const again = await fetch(`${s.url}/api/v1/app/upload?versionName=1.0.0`, { ...opts, body: fakeApk() });
    assert.strictEqual(again.status, 409);

    const ver = await (await fetch(`${s.url}/api/v1/app/version`)).json();
    assert.strictEqual(ver.latest.versionName, '1.0.0');
  } finally { await s.close(); }
});
