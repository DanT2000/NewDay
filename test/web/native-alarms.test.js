/**
 * Мост в нативные будильники.
 *
 * Список, который уезжает в плагин, заменяет на устройстве всё: это
 * единственное место, где ошибка веб-части выключает будильник, о котором
 * человек просил. Проверять такое на телефоне поздно — тут проверяется
 * ровно то, что уезжает.
 */

const test = require('node:test');
const assert = require('node:assert');

/** Хранилище как в браузере: node своего не даёт. */
function хранилище() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    key: i => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}

/**
 * Телефон целиком: подменённый плагин, подменённая сеть.
 * @param {(date: string) => object|Error} день — что отвечает сервер на дату
 */
async function телефон(день) {
  globalThis.localStorage = хранилище();
  const уехало = [];
  const настройки = [];
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      NewDayAlarm: {
        schedule: async (arg) => { уехало.push(arg); return { scheduled: arg.alarms.length }; },
        setConfig: async (arg) => { настройки.push(arg); return { ok: true }; },
      },
    },
  };
  globalThis.fetch = async (url) => {
    const дата = String(url).match(/days\/([\d-]+)\/full/)?.[1];
    const ответ = день(дата);
    if (ответ instanceof Error) throw ответ;
    return {
      ok: true, status: 200,
      headers: { get: h => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => ответ,
    };
  };
  const native = await import(`../../public/js/native.js?${Math.random()}`);
  return { native, уехало, настройки };
}

const профиль = { timezone: 'Europe/Moscow', settings: { notifyDefaultBeforeMin: 10 } };

/** Строка расписания в том виде, в каком её отдаёт сервер. */
const строка = (поля) => ({
  id: 1, start_min: 600, end_min: 660, title: 'Созвон', done: 0,
  alarm_mode: 'notify', alarm_profile: 'gentle',
  remind_before_min: null, remind_before_json: null, ...поля,
});

const пустойДень = { schedule: [], tasks: { work: [], home: [] }, meals: [], sport: [] };

/**
 * Минута внутри суток по Москве прямо сейчас.
 *
 * Нужна, чтобы сроки в тестах всегда оказывались в будущем: срок «за день» у
 * строки на завтра приходится на сегодня в то же время, и с числом,
 * записанным в коде, тест зеленел утром и падал вечером.
 */
function московскаяМинута() {
  const ч = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date()).split(':').map(Number);
  return ч[0] * 60 + ч[1];
}

test('нет связи — список будильников не отправляется вовсе', async () => {
  const { native, уехало, настройки } = await телефон(() => new Error('сеть недоступна'));
  const r = await native.syncAlarms(профиль);
  assert.strictEqual(r, null);
  assert.deepStrictEqual(уехало, [],
    'пустой список снял бы с устройства все будильники: утром не прозвонит ничего');
  assert.strictEqual(настройки.length, 1, 'настройки отправить можно — они список не трогают');
});

test('один день из двух не дочитан — тоже не отправляем', async () => {
  const сегодня = new Date().toLocaleDateString('en-CA');
  const { native, уехало } = await телефон(
    d => (d === сегодня ? { ...пустойДень, schedule: [строка({})] } : new Error('сеть')),
  );
  await native.syncAlarms(профиль);
  assert.deepStrictEqual(уехало, [], 'иначе будильники второго дня были бы сняты');
});

test('пара сроков «за день и за час» даёт два будильника, а не ни одного', async () => {
  // время начала — на полтора часа вперёд от текущего: тогда и «за день»
  // (сегодня в это же время), и «за час» ещё не наступили
  const начало = Math.min(1380, московскаяМинута() + 90);
  const завтра = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const { native, уехало } = await телефон(d => ({
    ...пустойДень,
    schedule: d === завтра
      ? [строка({ start_min: начало, end_min: начало + 60,
        remind_before_json: '[1440,60]', remind_before_min: 1440 })]
      : [],
  }));
  await native.syncAlarms(профиль);
  const моменты = уехало[0].alarms;
  assert.strictEqual(моменты.length, 2, `ожидали два срока, уехало ${моменты.length}`);
  assert.strictEqual(new Set(моменты.map(a => a.id)).size, 2,
    'номер уходит в код запроса Android — два одинаковых заменили бы друг друга');
  assert.ok(моменты.every(a => a.id < 2147483647), 'номер должен уместиться в Int');
});

test('«к концу» звонит по концу блока, а не за десять минут до начала', async () => {
  const завтра = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const { native, уехало } = await телефон(d => ({
    ...пустойДень,
    schedule: d === завтра ? [строка({ remind_before_json: '[-1]', remind_before_min: null })] : [],
  }));
  await native.syncAlarms(профиль);
  const [a] = уехало[0].alarms;
  assert.ok(a, 'будильник поставлен');
  // конец блока 660 = 11:00 по Москве; за десять минут до начала было бы 9:50
  const час = new Date(a.fireAt).toISOString().slice(11, 16);
  assert.strictEqual(час, '08:00', `ждали конец блока (11:00 МСК), получили ${час} UTC`);
});

test('«к концу» у блока без конца не ставит ничего вместо неверного времени', async () => {
  const завтра = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const { native, уехало } = await телефон(d => ({
    ...пустойДень,
    schedule: d === завтра ? [строка({ end_min: null, remind_before_json: '[-1]' })] : [],
  }));
  await native.syncAlarms(профиль);
  assert.strictEqual(уехало[0].alarms.length, 0);
});

test('отмеченная и выключенная строка будильника не получают', async () => {
  const завтра = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const { native, уехало } = await телефон(d => ({
    ...пустойДень,
    schedule: d === завтра
      ? [строка({ id: 1, done: 1 }), строка({ id: 2, alarm_mode: 'none' })]
      : [],
  }));
  await native.syncAlarms(профиль);
  assert.strictEqual(уехало[0].alarms.length, 0);
});
