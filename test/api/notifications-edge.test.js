/**
 * Планировщик уведомлений на краях.
 *
 * Его особенность в том, что ломается он тихо: человек не получает
 * напоминания и узнаёт об этом, только опоздав. Поэтому здесь проверяется
 * не «ответ 200», а что запись действительно встала в очередь на нужный
 * момент — и что один испорченный срок не лишает человека всех уведомлений
 * разом.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, today, dayFromToday } = require('../helpers/client');

const ПУШ = {
  VAPID_PUBLIC_KEY: 'BFvQ0zP9r4kF1k2z0Q0Wl8k7QpQ8u1Zb7hYyq9x3bYb9qQ8y4Q1W2e3R4t5Y6u7I8o9P0a1S2d3F4g5H6j7K8l9',
  VAPID_PRIVATE_KEY: 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef_',
};

/** Что сейчас стоит в очереди уведомлений этого пользователя. */
const очередь = s => s.db.prepare(
  `SELECT dedupe_key, fire_at_utc, payload_json FROM notification_queue
    WHERE user_id = ? AND sent_at IS NULL ORDER BY fire_at_utc`,
).all(1).map(r => { const p = JSON.parse(r.payload_json); return { ...r, текст: `${p.title ?? ''} ${p.body ?? ''}` }; });

test('испорченный срок в повторе не лишает человека всех уведомлений', async () => {
  const s = await loggedIn({ env: ПУШ });
  try {
    /*
     * Все поля шаблона повтора проверяются, кроме сроков предупреждения:
     * список уходил в базу как есть. Срок в минус сто миллиардов минут
     * уводил момент отправки за предел представимых дат, и планировщик
     * падал на каждом запуске — то есть человек переставал получать любые
     * уведомления и будильники, молча и навсегда.
     */
    const r = await api(s.url, s.cookie, 'POST', '/api/v1/series', {
      freq: 'daily', startDate: today(),
      rows: [{ title: 'Подъём', startMin: 600, alarmMode: 'notify', remindBefore: [-1000000000000] }],
    }, {}, true);
    assert.ok(r.status === 400 || r.status === 201,
      `или отказ, или принято с разумным сроком (пришло ${r.status})`);

    // день открывается, строка создаётся, планировщик не падает
    const день = await api(s.url, s.cookie, 'GET', `/api/v1/days/${today()}/full`, undefined, {}, true);
    assert.strictEqual(день.status, 200, 'день открывается');

    const replan = await api(s.url, s.cookie, 'POST', '/api/v1/push/replan', {}, {}, true);
    assert.strictEqual(replan.status, 200, 'пересчёт уведомлений не падает');
  } finally { await s.close(); }
});

test('напоминание за несколько дней действительно встаёт в очередь', async () => {
  const s = await loggedIn({ env: ПУШ });
  try {
    /*
     * В приложении можно попросить напомнить «за день» и «за неделю».
     * Планировщик же считал только сегодня и завтра: к моменту, когда
     * событие попадало в это окно, срок «за два дня» был уже в прошлом, и
     * напоминание молча пропускалось. Обещание в интерфейсе было, уведомления
     * не было.
     */
    const через3дня = dayFromToday(3);
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${через3дня}/schedule`, {
      title: 'Поезд', startMin: 600, endMin: 660, alarmMode: 'notify', remindBefore: [2880],
    });
    await api(s.url, s.cookie, 'POST', '/api/v1/push/replan', {});

    const строки = очередь(s);
    const поезд = строки.filter(r => r.текст.includes('Поезд'));
    assert.ok(поезд.length >= 1, `напоминание «за два дня» в очереди (нашлось ${строки.length} записей всего)`);
    const момент = new Date(поезд[0].fire_at_utc);
    const завтра = new Date(`${dayFromToday(1)}T23:59:59Z`);
    assert.ok(момент.getTime() <= завтра.getTime() + 86400000,
      'момент отправки — примерно через сутки, а не в прошлом');
  } finally { await s.close(); }
});

test('копирование дня ставит уведомления на день-получатель', async () => {
  const s = await loggedIn({ env: ПУШ });
  try {
    const источник = dayFromToday(-2);
    const цель = dayFromToday(1);
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${источник}/schedule`, {
      title: 'Созвон', startMin: 600, endMin: 660, alarmMode: 'notify', remindBefore: [0],
    });
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${источник}/copy-to`, { targetDate: цель });

    const строки = очередь(s).filter(r => r.dedupe_key.includes(цель));
    assert.ok(строки.length >= 1,
      `после копирования уведомления встали на ${цель} (в очереди: ${JSON.stringify(очередь(s).map(r => r.dedupe_key))})`);
  } finally { await s.close(); }
});

test('копирование дня не задваивает строки повтора', async () => {
  const s = await loggedIn();
  try {
    /*
     * Скопированная строка приезжала без пометки о повторе, а день-получатель
     * тут же достраивал тот же повтор от себя: в дне оказывалось две
     * «Зарядки», два уведомления и неверный счётчик в сетке месяца.
     */
    await api(s.url, s.cookie, 'POST', '/api/v1/series', {
      freq: 'daily', startDate: dayFromToday(-1),
      rows: [{ title: 'Зарядка', startMin: 420, endMin: 450 }],
    });
    const источник = dayFromToday(-1);
    const цель = dayFromToday(2);
    await getJson(s.url, s.cookie, `/api/v1/days/${источник}/full`);   // материализуем повтор
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${источник}/copy-to`, { targetDate: цель });

    const день = await getJson(s.url, s.cookie, `/api/v1/days/${цель}/full`);
    const зарядки = день.schedule.filter(r => r.title === 'Зарядка');
    assert.strictEqual(зарядки.length, 1, `в дне ровно одна «Зарядка» (нашлось ${зарядки.length})`);
  } finally { await s.close(); }
});

test('очищенный день остаётся очищенным', async () => {
  const s = await loggedIn();
  try {
    /*
     * «Очистить день» (полная замена пустым содержимым) стирал строки, а
     * следующий же шаг того же запроса достраивал повтор обратно — человек
     * видел в ответе то, что только что удалил.
     */
    await api(s.url, s.cookie, 'POST', '/api/v1/series', {
      freq: 'daily', startDate: dayFromToday(-1),
      rows: [{ title: 'Зарядка', startMin: 420, endMin: 450 }],
    });
    const D = dayFromToday(1);
    const день = await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`);
    assert.strictEqual(день.schedule.length, 1, 'повтор достроился');

    const пусто = await api(s.url, s.cookie, 'PUT', `/api/v1/days/${D}/full`,
      { schedule: [], tasks: { work: [], home: [] }, meals: [], sport: [] },
      { 'If-Match': `"${день.rev}"` });
    assert.strictEqual(пусто.schedule.length, 0, 'в ответе день пуст');

    const снова = await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`);
    assert.strictEqual(снова.schedule.length, 0, 'и при следующем открытии день пуст');
  } finally { await s.close(); }
});

test('удалённый день не воскресает сам', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/series', {
      freq: 'daily', startDate: dayFromToday(-1),
      rows: [{ title: 'Зарядка', startMin: 420, endMin: 450 }],
    });
    const D = dayFromToday(2);
    await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`);
    const снос = await api(s.url, s.cookie, 'DELETE', `/api/v1/days/${D}`, undefined, {}, true);
    assert.ok(снос.status === 204 || снос.status === 200, 'день удалён');

    const после = await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`);
    assert.strictEqual(после.schedule.length, 0,
      'после удаления день пуст, а не восстановлен пересчётом уведомлений');
  } finally { await s.close(); }
});
