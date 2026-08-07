/**
 * Помощник: подключение, разбор, причёсывание, распознавание, расход.
 *
 * Проверяем не «эндпоинт отвечает 200», а то, ради чего он написан: что
 * ключ не утекает наружу, что длинный текст не пересказывается, что
 * уточняющий вопрос доходит до приложения и что расход виден владельцу.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, post, extractCookie, today } = require('../helpers/client');

const KEY = 'sk-test-cloud-key';
const ADMIN = 'admin@example.com';

/**
 * Поддельный провайдер. Настоящий в тестах не трогаем: он стоит денег,
 * ограничивает частоту и однажды ответит иначе, чем сегодня.
 */
function fakeProvider(options = {}) {
  const state = {
    reply: 'Готово.',
    heard: 'Встреча переносится на пятницу.',
    status: 200,
    ...options,
  };
  const calls = [];

  const impl = async (url, init) => {
    const voice = url.includes('/audio/transcriptions');
    calls.push({
      url,
      voice,
      auth: init.headers?.Authorization ?? null,
      body: voice ? null : JSON.parse(init.body),
      form: voice ? Object.fromEntries([...init.body].filter(([, v]) => typeof v === 'string')) : null,
    });

    if (state.status !== 200) {
      return {
        ok: false, status: state.status,
        json: async () => ({ error: { message: 'провайдер недоволен' } }),
      };
    }
    const answer = typeof state.reply === 'function' ? state.reply(calls.length) : state.reply;
    return {
      ok: true, status: 200,
      json: async () => (voice
        ? { text: state.heard, usage: { seconds: 12, cost_rub: 0.02 } }
        : {
          choices: [{ message: { content: answer } }],
          usage: { prompt_tokens: 200, completion_tokens: 90, cost_rub: 0.03 },
        }),
    };
  };

  impl.calls = calls;
  impl.set = patch => Object.assign(state, patch);
  return impl;
}

/** Владелец экземпляра: он один задаёт подключение. */
async function withAdmin(provider, patch = {}) {
  const s = await loggedIn({
    email: ADMIN,
    env: { ADMIN_EMAILS: ADMIN },
    fetchImpl: provider,
  });
  await api(s.url, s.cookie, 'PATCH', '/api/v1/admin/ai', {
    baseUrl: 'https://provider.test/v1',
    model: 'быстрая',
    smartModel: 'умная',
    voiceModel: 'голосовая',
    apiKey: KEY,
    enabled: true,
    ...patch,
  });
  return s;
}

// ── Подключение ──────────────────────────────────────────────

test('ключ провайдера наружу не отдаётся — только хвост', async () => {
  const s = await withAdmin(fakeProvider());
  try {
    const cfg = await getJson(s.url, s.cookie, '/api/v1/admin/ai');
    assert.strictEqual(cfg.hasKey, true);
    assert.strictEqual(cfg.keyTail, KEY.slice(-4));
    assert.ok(!JSON.stringify(cfg).includes(KEY), 'ключ не должен возвращаться целиком');
    assert.strictEqual(cfg.ready, true);
    assert.strictEqual(cfg.voiceReady, true);
  } finally { await s.close(); }
});

test('пустой ключ в форме означает «не менять», а не «стереть»', async () => {
  const s = await withAdmin(fakeProvider());
  try {
    await api(s.url, s.cookie, 'PATCH', '/api/v1/admin/ai', { model: 'другая', apiKey: '' });
    const cfg = await getJson(s.url, s.cookie, '/api/v1/admin/ai');
    assert.strictEqual(cfg.model, 'другая');
    assert.strictEqual(cfg.hasKey, true, 'ключ должен был остаться');
  } finally { await s.close(); }
});

test('обычный пользователь не видит и не меняет подключение', async () => {
  const s = await withAdmin(fakeProvider());
  try {
    const other = await loggedIn({ email: 'gost@example.com', server: s.srv });
    for (const [method, path, body] of [
      ['GET', '/api/v1/admin/ai', undefined],
      ['PATCH', '/api/v1/admin/ai', { model: 'своя' }],
      ['GET', '/api/v1/admin/ai/usage', undefined],
    ]) {
      const r = await api(s.url, other.cookie, method, path, body, {}, true);
      assert.strictEqual(r.status, 403, `${method} ${path}`);
    }
  } finally { await s.close(); }
});

test('без подключения помощник честно говорит, что выключен', async () => {
  const s = await loggedIn();
  try {
    assert.deepStrictEqual(
      await getJson(s.url, s.cookie, '/api/v1/ai/status'),
      // Помимо подключения статус говорит про доступ этого человека:
      // рубильник, тариф и остаток дневного лимита
      { ready: false, voice: false, model: '', enabled: true, tier: 'unlimited', usedToday: 0, dailyLimit: null },
    );
    const r = await api(s.url, s.cookie, 'POST', '/api/v1/ai/parse', { text: 'что-нибудь' }, {}, true);
    assert.strictEqual(r.status, 503);
    assert.strictEqual((await r.json()).error.code, 'AI_OFF');
  } finally { await s.close(); }
});

// ── Разбор речи в план дня ───────────────────────────────────

test('надиктованное превращается в дела с временем', async () => {
  const provider = fakeProvider({
    reply: JSON.stringify({
      items: [
        { kind: 'schedule', title: 'Созвон с Андреем', start: '09:00', end: '10:30', category: 'work' },
        { kind: 'task', title: 'Купить молоко', category: 'buy' },
      ],
      question: null,
    }),
  });
  const s = await withAdmin(provider);
  try {
    const r = await api(s.url, s.cookie, 'POST', '/api/v1/ai/parse',
      { text: 'В девять созвон с Андреем на полтора часа, и купить молоко' });

    assert.strictEqual(r.items.length, 2);
    assert.strictEqual(r.items[0].start, '09:00');
    assert.strictEqual(r.question, null);

    // Сегодняшняя дата и часовой пояс уходят модели: без них «завтра»
    // ей не с чем сопоставить
    const system = provider.calls[0].body.messages[0].content;
    assert.match(system, new RegExp(today()));
    assert.match(system, /Europe\/Moscow/);
    assert.strictEqual(provider.calls[0].auth, `Bearer ${KEY}`);
  } finally { await s.close(); }
});

test('уточняющий вопрос доходит вместе с вариантами ответа', async () => {
  const provider = fakeProvider({
    reply: JSON.stringify({
      items: [{ kind: 'task', title: 'Позвонить Андрею' }],
      question: 'Во сколько вечером позвонить?',
      options: ['18:00', '20:00', '21:00'],
    }),
  });
  const s = await withAdmin(provider);
  try {
    const r = await api(s.url, s.cookie, 'POST', '/api/v1/ai/parse',
      { text: 'Надо вечером как-нибудь позвонить Андрею' });

    assert.strictEqual(r.question, 'Во сколько вечером позвонить?');
    assert.deepStrictEqual(r.options, ['18:00', '20:00', '21:00']);
  } finally { await s.close(); }
});

test('ответ на вопрос продолжает тот же разбор, а не начинает новый', async () => {
  const provider = fakeProvider({
    reply: JSON.stringify({ items: [{ kind: 'schedule', title: 'Позвонить', start: '20:00' }], question: null }),
  });
  const s = await withAdmin(provider);
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/ai/parse', {
      text: 'Надо вечером позвонить Андрею',
      history: [
        { role: 'assistant', content: '{"question":"Во сколько?"}' },
        { role: 'user', content: '20:00' },
      ],
    });

    const sent = provider.calls[0].body.messages.map(m => m.role);
    assert.deepStrictEqual(sent, ['system', 'user', 'assistant', 'user'],
      'модель должна увидеть весь разговор целиком');
  } finally { await s.close(); }
});

test('модель ответила не-JSON — отдаём, что было, а не пустоту', async () => {
  const s = await withAdmin(fakeProvider({ reply: 'Извините, я не понял.' }));
  try {
    const r = await api(s.url, s.cookie, 'POST', '/api/v1/ai/parse', { text: 'бубубу' });
    assert.deepStrictEqual(r.items, []);
    assert.match(r.unparsed, /не понял/);
  } finally { await s.close(); }
});

test('умная модель берётся только для длинного текста', async () => {
  const provider = fakeProvider({ reply: '{"items":[]}' });
  const s = await withAdmin(provider);
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/ai/parse', { text: 'коротко' });
    assert.strictEqual(provider.calls[0].body.model, 'быстрая');

    await api(s.url, s.cookie, 'POST', '/api/v1/ai/parse', { text: 'д'.repeat(2000) });
    assert.strictEqual(provider.calls[1].body.model, 'умная');
  } finally { await s.close(); }
});

// ── Причёсывание ─────────────────────────────────────────────

test('длинный текст причёсывается частями, а не пересказывается', async () => {
  // Настоящая причина проверки: gpt-4o-mini на 2135 токенах входа выдал
  // 121 токен ответа — молча сократил текст вместо того, чтобы почистить
  const provider = fakeProvider({ reply: n => `часть ${n}` });
  const s = await withAdmin(provider);
  try {
    const абзац = 'Значит смотри, тут такая ситуация получается, ну и вот. '.repeat(30);
    const текст = [абзац, абзац, абзац].join('\n\n');

    const r = await api(s.url, s.cookie, 'POST', '/api/v1/ai/improve', { text: текст });

    assert.ok(r.parts > 1, `текст ${текст.length} знаков должен был разбиться, а ушёл одним куском`);
    assert.strictEqual(provider.calls.length, r.parts);
    assert.strictEqual(r.text, Array.from({ length: r.parts }, (_, i) => `часть ${i + 1}`).join('\n\n'));

    // Выход должен вмещать вход, иначе ответ обрежется на середине фразы
    for (const call of provider.calls) {
      assert.ok(call.body.max_tokens >= call.body.messages[1].content.length / 2,
        'запаса на ответ не хватит');
    }
  } finally { await s.close(); }
});

test('короткий текст идёт одним куском', async () => {
  const provider = fakeProvider({ reply: 'Встреча переносится на пятницу.' });
  const s = await withAdmin(provider);
  try {
    const r = await api(s.url, s.cookie, 'POST', '/api/v1/ai/improve',
      { text: 'ну это самое, короче, встреча вроде как переносится на пятницу' });
    assert.strictEqual(r.parts, 1);
    assert.strictEqual(r.text, 'Встреча переносится на пятницу.');
  } finally { await s.close(); }
});

// ── Речь в текст ─────────────────────────────────────────────

test('запись распознаётся, и язык передаётся явно', async () => {
  const provider = fakeProvider();
  const s = await withAdmin(provider);
  try {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('поддельный звук')]), 'zapis.webm');
    form.append('language', 'ru');

    const res = await fetch(`${s.url}/api/v1/ai/transcribe`, {
      method: 'POST', headers: { cookie: s.cookie }, body: form,
    });
    const body = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.text, 'Встреча переносится на пятницу.');
    assert.strictEqual(provider.calls[0].form.model, 'голосовая');
    // Без языка модель угадывает и пишет русскую речь латиницей —
    // проверено на живом ключе, поэтому это защита от повторения
    assert.strictEqual(provider.calls[0].form.language, 'ru');
  } finally { await s.close(); }
});

test('без модели распознавания говорим об этом, а не пробуем текстовой', async () => {
  const provider = fakeProvider();
  const s = await withAdmin(provider, { voiceModel: '' });
  try {
    const status = await getJson(s.url, s.cookie, '/api/v1/ai/status');
    assert.strictEqual(status.ready, true);
    assert.strictEqual(status.voice, false);

    const form = new FormData();
    form.append('file', new Blob([Buffer.from('звук')]), 'z.webm');
    const res = await fetch(`${s.url}/api/v1/ai/transcribe`, {
      method: 'POST', headers: { cookie: s.cookie }, body: form,
    });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(provider.calls.length, 0);
  } finally { await s.close(); }
});

// ── Отказы ───────────────────────────────────────────────────

test('отказ провайдера объясняется по-человечески', async () => {
  const provider = fakeProvider({ status: 401 });
  const s = await withAdmin(provider);
  try {
    const r = await api(s.url, s.cookie, 'POST', '/api/v1/ai/parse', { text: 'что-нибудь' }, {}, true);
    assert.strictEqual(r.status, 502);
    assert.strictEqual((await r.json()).error.message, 'Ключ не принят');
  } finally { await s.close(); }
});

test('кончились деньги — так и сказано', async () => {
  const s = await withAdmin(fakeProvider({ status: 402 }));
  try {
    const r = await api(s.url, s.cookie, 'POST', '/api/v1/ai/parse', { text: 'что-нибудь' }, {}, true);
    assert.match((await r.json()).error.message, /закончились деньги/);
  } finally { await s.close(); }
});

// ── Расход ───────────────────────────────────────────────────

test('расход виден владельцу: обращения, токены, рубли', async () => {
  const provider = fakeProvider({ reply: '{"items":[]}' });
  const s = await withAdmin(provider);
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/ai/parse', { text: 'раз' });
    await api(s.url, s.cookie, 'POST', '/api/v1/ai/parse', { text: 'два' });

    const form = new FormData();
    form.append('file', new Blob([Buffer.from('звук')]), 'z.webm');
    await fetch(`${s.url}/api/v1/ai/transcribe`, { method: 'POST', headers: { cookie: s.cookie }, body: form });

    const u = await getJson(s.url, s.cookie, '/api/v1/admin/ai/usage');
    assert.strictEqual(u.total, 3);
    assert.strictEqual(u.ok, 3);
    assert.strictEqual(u.rub, 0.08, '0.03 + 0.03 + 0.02');
    assert.strictEqual(u.byKind.parse.requests, 2);
    assert.strictEqual(u.byKind.transcribe.requests, 1);
    assert.strictEqual(u.byUser[ADMIN].requests, 3);
    assert.strictEqual(u.tokens, 580, 'по 290 токенов на каждый разбор');
    assert.strictEqual(u.daily.length, 1);
  } finally { await s.close(); }
});

test('неудачи считаются отдельно от удач', async () => {
  const provider = fakeProvider({ status: 429 });
  const s = await withAdmin(provider);
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/ai/parse', { text: 'раз' }, {}, true);
    provider.set({ status: 200, reply: '{"items":[]}' });
    await api(s.url, s.cookie, 'POST', '/api/v1/ai/parse', { text: 'два' });

    const u = await getJson(s.url, s.cookie, '/api/v1/admin/ai/usage');
    assert.strictEqual(u.total, 2);
    assert.strictEqual(u.ok, 1);
    assert.strictEqual(u.failed, 1);
  } finally { await s.close(); }
});

test('в счётчиках нет содержания запросов', async () => {
  const provider = fakeProvider({ reply: '{"items":[]}' });
  const s = await withAdmin(provider);
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/ai/parse', { text: 'пароль от сейфа семь семь три' });

    const rows = s.db.prepare('SELECT * FROM ai_usage').all();
    assert.strictEqual(rows.length, 1);
    assert.ok(!JSON.stringify(rows).includes('сейфа'), 'счётчики — не переписка');
  } finally { await s.close(); }
});
