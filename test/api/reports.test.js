/**
 * Сообщения о проблемах.
 *
 * Смысл механики — ничего не потерять. Человек нажал одну кнопку и
 * наговорил, что сломалось; всё, что может подвести дальше — распознавание,
 * чужой сервис, отсутствующая настройка, — не должно превращать его рассказ
 * в пустоту. Поэтому проверяем не «эндпоинт отвечает 201», а что запись
 * доживает до владельца даже когда расшифровать её не вышло, и что читать
 * чужие сообщения нельзя.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loggedIn, api, getJson, post, extractCookie } = require('../helpers/client');

const ADMIN = 'admin@example.com';
const KEY = 'sk-test-reports';

/** Поддельный провайдер распознавания: настоящий в тестах не трогаем. */
function fakeVoice({ heard = 'Задача не добавилась на четырнадцатое', status = 200 } = {}) {
  const impl = async (url) => {
    if (!url.includes('/audio/transcriptions')) {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ок' } }] }) };
    }
    if (status !== 200) {
      return { ok: false, status, json: async () => ({ error: { message: 'распознавание легло' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ text: heard }) };
  };
  return impl;
}

/** Владелец: первый зарегистрированный и он же в ADMIN_EMAILS. */
const owner = (opts = {}) => loggedIn({ email: ADMIN, env: { ADMIN_EMAILS: ADMIN }, ...opts });

/** Второй человек на том же сервере — у него своя сессия и никаких прав. */
async function stranger(s) {
  const email = 'guest@example.com';
  await post(s.url, '/api/v1/auth/register', { email, password: 'secret12' });
  const login = await post(s.url, '/api/v1/auth/login', { emailOrUsername: email, password: 'secret12' });
  return extractCookie(login);
}

/** Отправка формы: как это делает приложение — multipart, без своих заголовков. */
async function send(s, { cookie, text, audio, shot, context, log } = {}) {
  const form = new FormData();
  if (text !== undefined) form.append('text', text);
  if (context !== undefined) form.append('context', JSON.stringify(context));
  if (log !== undefined) form.append('log', JSON.stringify(log));
  if (audio) form.append('audio', new Blob([audio.bytes], { type: audio.mime }), audio.name);
  if (shot) form.append('shot', new Blob([shot.bytes], { type: shot.mime }), shot.name);
  const res = await fetch(`${s.url}/api/v1/reports`, {
    method: 'POST', body: form, headers: { cookie: cookie ?? s.cookie },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const включитьГолос = s => api(s.url, s.cookie, 'PATCH', '/api/v1/admin/ai', {
  baseUrl: 'https://provider.test/v1', model: 'текст', voiceModel: 'голос', apiKey: KEY, enabled: true,
});

test('написанное текстом доходит до владельца вместе с обстоятельствами', async () => {
  const s = await owner();
  try {
    const sent = await send(s, {
      text: 'Добавил задачу на 14 сентября — не появилась',
      context: { сборка: 'newday-abc123', экран: 'tasks', окно: '375×812' },
      log: [{ t: '2026-09-12T10:00:00.000Z', kind: 'отказ', text: 'POST /days/.../tasks → 500' }],
    });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.typed, true);
    assert.equal(sent.body.hasAudio, false);
    assert.equal(sent.body.status, 'new');

    const list = await getJson(s.url, s.cookie, '/api/v1/reports');
    assert.equal(list.reports.length, 1);
    assert.equal(list.reports[0].text, 'Добавил задачу на 14 сентября — не появилась');
    assert.equal(list.reports[0].from.email, ADMIN);
    assert.equal(list.counts.new, 1);

    const one = await getJson(s.url, s.cookie, `/api/v1/reports/${sent.body.id}`);
    assert.equal(one.context.сборка, 'newday-abc123', 'сборка — первое, что нужно знать');
    assert.equal(one.context.экран, 'tasks');
    assert.equal(one.log[0].kind, 'отказ');
  } finally { await s.close(); }
});

test('пустое сообщение не принимается', async () => {
  const s = await owner();
  try {
    const sent = await send(s, { text: '   ' });
    assert.equal(sent.status, 400);
    assert.match(sent.body.error.message, /напишите или наговорите/i);
  } finally { await s.close(); }
});

test('запись голоса расшифровывается и попадает в текст сообщения', async () => {
  const s = await owner({ fetchImpl: fakeVoice() });
  try {
    await включитьГолос(s);
    const sent = await send(s, {
      audio: { bytes: Buffer.from('фальшивый звук'), mime: 'audio/webm', name: 'zapis.webm' },
    });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.text, 'Задача не добавилась на четырнадцатое');
    assert.equal(sent.body.voiceError, null);
    assert.equal(sent.body.typed, false, 'это сказано, а не напечатано');
    assert.equal(sent.body.hasAudio, true);

    const file = await fetch(`${s.url}/api/v1/reports/${sent.body.id}/audio`, { headers: { cookie: s.cookie } });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'audio/webm');
    assert.equal((await file.arrayBuffer()).byteLength, Buffer.from('фальшивый звук').length);
  } finally { await s.close(); }
});

test('распознавание отказало — запись всё равно сохранена, и об этом сказано', async () => {
  const s = await owner({ fetchImpl: fakeVoice({ status: 500 }) });
  try {
    await включитьГолос(s);
    const sent = await send(s, {
      audio: { bytes: Buffer.from('звук'), mime: 'audio/webm', name: 'zapis.webm' },
    });
    assert.equal(sent.status, 201, 'отказ распознавания не повод терять сказанное');
    assert.ok(sent.body.voiceError, 'причина названа');
    assert.equal(sent.body.hasAudio, true);

    const file = await fetch(`${s.url}/api/v1/reports/${sent.body.id}/audio`, { headers: { cookie: s.cookie } });
    assert.equal(file.status, 200, 'файл на месте — можно послушать');
  } finally { await s.close(); }
});

test('распознавание не подключено — тоже не потеря, а пометка', async () => {
  const s = await owner();
  try {
    const sent = await send(s, { audio: { bytes: Buffer.from('звук'), mime: 'audio/webm', name: 'z.webm' } });
    assert.equal(sent.status, 201);
    assert.match(sent.body.voiceError, /не подключено/i);
    assert.equal(sent.body.hasAudio, true);
  } finally { await s.close(); }
});

test('снимок экрана прикладывается, а не-картинка отвергается', async () => {
  const s = await owner();
  try {
    const плохой = await send(s, {
      text: 'вот', shot: { bytes: Buffer.from('это не картинка'), mime: 'text/plain', name: 'a.txt' },
    });
    assert.equal(плохой.status, 400);

    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const sent = await send(s, { text: 'вот так', shot: { bytes: png, mime: 'image/png', name: 'snimok.png' } });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.hasShot, true);
    assert.equal(sent.body.shotBytes, png.length);

    const file = await fetch(`${s.url}/api/v1/reports/${sent.body.id}/shot`, { headers: { cookie: s.cookie } });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
  } finally { await s.close(); }
});

test('чужие сообщения читать нельзя, а писать свои — можно', async () => {
  const s = await owner();
  try {
    const гость = await stranger(s);
    const sent = await send(s, { cookie: гость, text: 'у меня тоже не работает' });
    assert.equal(sent.status, 201, 'сообщить о проблеме вправе любой вошедший');

    const список = await api(s.url, гость, 'GET', '/api/v1/reports', undefined, {}, true);
    assert.equal(список.status, 403);
    const одно = await api(s.url, гость, 'GET', `/api/v1/reports/${sent.body.id}`, undefined, {}, true);
    assert.equal(одно.status, 403);
    const файл = await fetch(`${s.url}/api/v1/reports/${sent.body.id}/audio`, { headers: { cookie: гость } });
    assert.equal(файл.status, 403);

    const мой = await getJson(s.url, s.cookie, '/api/v1/reports');
    assert.equal(мой.reports[0].from.email, 'guest@example.com', 'владелец видит, кто написал');
  } finally { await s.close(); }
});

test('разобранное помечается и удаляется вместе с файлами', async () => {
  const s = await owner();
  try {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const sent = await send(s, { text: 'проверка', shot: { bytes: png, mime: 'image/png', name: 's.png' } });
    const id = sent.body.id;

    const seen = await api(s.url, s.cookie, 'PATCH', `/api/v1/reports/${id}`, { status: 'done' });
    assert.equal(seen.status, 'done');
    const done = await getJson(s.url, s.cookie, '/api/v1/reports?status=done');
    assert.equal(done.reports.length, 1);

    const dir = path.join(s.config.reportsDir, String(id));
    assert.ok(fs.existsSync(dir), 'файл лежит на диске');
    await api(s.url, s.cookie, 'DELETE', `/api/v1/reports/${id}`, undefined, {}, true);
    assert.ok(!fs.existsSync(dir), 'удалили сообщение — унесли и файлы');

    const пусто = await getJson(s.url, s.cookie, '/api/v1/reports');
    assert.equal(пусто.reports.length, 0);
  } finally { await s.close(); }
});
