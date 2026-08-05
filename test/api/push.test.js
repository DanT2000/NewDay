const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson } = require('../helpers/client');
const { inQuietHours } = require('../../server/services/notificationService');

const VAPID = {
  // тестовая пара, наружу ничего не уходит: push.send в NODE_ENV=test не шлёт
  VAPID_PUBLIC_KEY: 'BDA9gPQ1b8cc-SifnADg6vs4tOQKsLCY3uLNz4TSqAg4inEucDSqCRsuvuUXcFzx48kRzTp186D9l4OI0Al_fMU',
  VAPID_PRIVATE_KEY: 'DmFl4f9dWbd9OgU9m0L6797qkFWYvBQ7DtiUPRgOOPY',
  VAPID_SUBJECT: 'mailto:test@example.com',
};

const SUB = {
  endpoint: 'https://push.example.com/sub/abc123',
  keys: { p256dh: 'BFakeP256dhKeyForTestsOnly0000000000000000000', auth: 'FakeAuthSecret00000' },
};

const withPush = extra => ({ env: { ...VAPID, ...extra } });

test('без VAPID push выключен, но приложение работает', async () => {
  const s = await loggedIn();
  try {
    const key = await getJson(s.url, s.cookie, '/api/v1/push/key');
    assert.strictEqual(key.enabled, false);
    assert.strictEqual(key.publicKey, null);
  } finally { await s.close(); }
});

test('с VAPID отдаётся публичный ключ', async () => {
  const s = await loggedIn(withPush());
  try {
    const key = await getJson(s.url, s.cookie, '/api/v1/push/key');
    assert.strictEqual(key.enabled, true);
    assert.strictEqual(key.publicKey, VAPID.VAPID_PUBLIC_KEY);
  } finally { await s.close(); }
});

test('подписка сохраняется и не дублируется', async () => {
  const s = await loggedIn(withPush());
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/push/subscribe', { subscription: SUB });
    await api(s.url, s.cookie, 'POST', '/api/v1/push/subscribe', { subscription: SUB });
    const status = await getJson(s.url, s.cookie, '/api/v1/push/status');
    assert.strictEqual(status.subscriptions.length, 1);
  } finally { await s.close(); }
});

test('строка с будильником планирует уведомление заранее', async () => {
  const s = await loggedIn(withPush());
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/push/subscribe', { subscription: SUB });
    // ставим на завтра, чтобы время точно было в будущем
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${tomorrow}/schedule`,
      { time: '09:00-10:00', title: 'Совещание', alarmMode: 'notify', remindBeforeMin: 15 });

    const status = await getJson(s.url, s.cookie, '/api/v1/push/status');
    assert.strictEqual(status.pending.length, 1, 'напоминание запланировано');
    const p = status.pending[0];
    assert.match(p.payload.body, /Совещание/);
    assert.match(p.payload.body, /через 15 мин/);
    // 09:00 минус 15 минут по Москве = 08:45 = 05:45 UTC
    assert.strictEqual(new Date(p.fireAt).toISOString(), `${tomorrow}T05:45:00.000Z`);
  } finally { await s.close(); }
});

test('строка без будильника ничего не планирует', async () => {
  const s = await loggedIn(withPush());
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/push/subscribe', { subscription: SUB });
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${tomorrow}/schedule`,
      { time: '09:00-10:00', title: 'Просто дело' });
    const status = await getJson(s.url, s.cookie, '/api/v1/push/status');
    assert.strictEqual(status.pending.length, 0);
  } finally { await s.close(); }
});

test('перенос строки двигает уведомление, а не плодит второе', async () => {
  const s = await loggedIn(withPush());
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/push/subscribe', { subscription: SUB });
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const row = await api(s.url, s.cookie, 'POST', `/api/v1/days/${tomorrow}/schedule`,
      { time: '09:00-10:00', title: 'Совещание', alarmMode: 'notify', remindBeforeMin: 10 });

    await api(s.url, s.cookie, 'PATCH', `/api/v1/days/${tomorrow}/schedule/${row.id}`, { startMin: 11 * 60 });

    const status = await getJson(s.url, s.cookie, '/api/v1/push/status');
    assert.strictEqual(status.pending.length, 1, 'дубля нет');
    assert.strictEqual(new Date(status.pending[0].fireAt).toISOString(), `${tomorrow}T07:50:00.000Z`);
  } finally { await s.close(); }
});

test('удаление строки снимает уведомление', async () => {
  const s = await loggedIn(withPush());
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/push/subscribe', { subscription: SUB });
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const row = await api(s.url, s.cookie, 'POST', `/api/v1/days/${tomorrow}/schedule`,
      { time: '09:00', title: 'Совещание', alarmMode: 'alarm' });
    await api(s.url, s.cookie, 'DELETE', `/api/v1/days/${tomorrow}/schedule/${row.id}`);
    const status = await getJson(s.url, s.cookie, '/api/v1/push/status');
    assert.strictEqual(status.pending.length, 0);
  } finally { await s.close(); }
});

test('выполненная строка не будит', async () => {
  const s = await loggedIn(withPush());
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/push/subscribe', { subscription: SUB });
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const row = await api(s.url, s.cookie, 'POST', `/api/v1/days/${tomorrow}/schedule`,
      { time: '09:00', title: 'Совещание', alarmMode: 'notify' });
    await api(s.url, s.cookie, 'PATCH', `/api/v1/days/${tomorrow}/schedule/${row.id}`, { done: true });
    const status = await getJson(s.url, s.cookie, '/api/v1/push/status');
    assert.strictEqual(status.pending.length, 0);
  } finally { await s.close(); }
});

test('глобальный выключатель снимает всё запланированное', async () => {
  const s = await loggedIn(withPush());
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/push/subscribe', { subscription: SUB });
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${tomorrow}/schedule`,
      { time: '09:00', title: 'Совещание', alarmMode: 'notify' });
    assert.strictEqual((await getJson(s.url, s.cookie, '/api/v1/push/status')).pending.length, 1);

    await api(s.url, s.cookie, 'PATCH', '/api/v1/settings', { settings: { notifyEnabled: false } });
    await api(s.url, s.cookie, 'POST', '/api/v1/push/replan');
    assert.strictEqual((await getJson(s.url, s.cookie, '/api/v1/push/status')).pending.length, 0);
  } finally { await s.close(); }
});

test('тихие часы отбрасывают ночные напоминания', async () => {
  const s = await loggedIn(withPush());
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/push/subscribe', { subscription: SUB });
    // тишина с 23:00 до 07:00
    await api(s.url, s.cookie, 'PATCH', '/api/v1/settings',
      { settings: { quietFrom: 23 * 60, quietTo: 7 * 60 } });

    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${tomorrow}/schedule`,
      { time: '06:00', title: 'Подъём', alarmMode: 'alarm', remindBeforeMin: 0 });
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${tomorrow}/schedule`,
      { time: '09:00', title: 'Работа', alarmMode: 'notify', remindBeforeMin: 0 });

    const status = await getJson(s.url, s.cookie, '/api/v1/push/status');
    assert.strictEqual(status.pending.length, 1, 'ночное отброшено, дневное осталось');
    assert.match(status.pending[0].payload.body, /Работа/);
  } finally { await s.close(); }
});

test('тихие часы через полночь считаются как два интервала', () => {
  const from = 23 * 60, to = 7 * 60;
  assert.strictEqual(inQuietHours(23 * 60 + 30, from, to), true);
  assert.strictEqual(inQuietHours(2 * 60, from, to), true);
  assert.strictEqual(inQuietHours(6 * 60 + 59, from, to), true);
  assert.strictEqual(inQuietHours(7 * 60, from, to), false);
  assert.strictEqual(inQuietHours(12 * 60, from, to), false);
  assert.strictEqual(inQuietHours(12 * 60, null, null), false);
});

test('таймзона пользователя влияет на момент отправки', async () => {
  const s = await loggedIn(withPush());
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/push/subscribe', { subscription: SUB });
    await api(s.url, s.cookie, 'PATCH', '/api/v1/settings', { timezone: 'Asia/Kamchatka' }); // UTC+12
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${tomorrow}/schedule`,
      { time: '15:00', title: 'Созвон', alarmMode: 'notify', remindBeforeMin: 0 });

    const status = await getJson(s.url, s.cookie, '/api/v1/push/status');
    const iso = new Date(status.pending[0].fireAt).toISOString();
    assert.strictEqual(iso.slice(11, 16), '03:00', '15:00 на Камчатке — это 03:00 UTC');
  } finally { await s.close(); }
});

/*
 * На это опирается шторка «Уведомления» в веб-версии: она рисует состояние
 * из `settings`, а после правки зовёт `replan`. Без пересчёта новое «за
 * сколько предупреждать» начало бы действовать только со следующего дня.
 */
/*
 * Сроков предупреждения может быть несколько — «за день» и «за час» вместе.
 * Каждый получает свою запись: с одним ключом второй затирал бы первый, и
 * из двух напоминаний приходило бы одно.
 */
test('несколько сроков дают несколько напоминаний', async () => {
  const s = await loggedIn(withPush());
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/push/subscribe', { subscription: SUB });
    const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${soon}/schedule`,
      { time: '12:00', title: 'Приём у врача', alarmMode: 'notify', remindBefore: [60, 1440] });

    const status = await getJson(s.url, s.cookie, '/api/v1/push/status');
    const fires = status.pending.map(p => new Date(p.fireAt).toISOString()).sort();
    assert.strictEqual(fires.length, 2, JSON.stringify(status.pending));
    // 12:00 по Москве минус час = 08:00 UTC; минус сутки = 09:00 UTC днём раньше
    assert.ok(fires.some(f => f.endsWith('T09:00:00.000Z')), fires.join(' '));
    assert.ok(fires.some(f => f.endsWith('T08:00:00.000Z')), fires.join(' '));
  } finally { await s.close(); }
});

test('первым сроком остаётся самый ранний', async () => {
  const s = await loggedIn(withPush());
  try {
    const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const row = await api(s.url, s.cookie, 'POST', `/api/v1/days/${soon}/schedule`,
      { time: '12:00', title: 'Приём у врача', alarmMode: 'notify', remindBefore: [15, 1440, 60] });
    // прежнее одиночное поле остаётся заполненным — им живёт всё, что не
    // знает про список: выгрузка, приложение, шаблоны
    assert.strictEqual(row.remind_before_min, 1440);
    assert.deepStrictEqual(JSON.parse(row.remind_before_json), [1440, 60, 15]);
  } finally { await s.close(); }
});

test('уведомление ведёт в тот день, о котором оно', async () => {
  const s = await loggedIn(withPush());
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/push/subscribe', { subscription: SUB });
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${tomorrow}/schedule`,
      { time: '09:00', title: 'Совещание', alarmMode: 'notify' });

    const status = await getJson(s.url, s.cookie, '/api/v1/push/status');
    // Без даты в адресе нажатие открывало бы сегодняшний день, а напоминание
    // было про завтрашний
    assert.strictEqual(status.pending[0].payload.url, `/web.html#${tomorrow}`);
  } finally { await s.close(); }
});

test('статус несёт настройки уведомлений со значениями по умолчанию', async () => {
  const s = await loggedIn(withPush());
  try {
    const status = await getJson(s.url, s.cookie, '/api/v1/push/status');
    assert.deepStrictEqual(status.settings, {
      notifyEnabled: true, notifyDefaultBeforeMin: 10, quietFrom: null, quietTo: null,
    });
  } finally { await s.close(); }
});

test('правка «предупреждать за» с пересчётом двигает уже запланированное', async () => {
  const s = await loggedIn(withPush());
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/push/subscribe', { subscription: SUB });
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    // без своего remindBeforeMin строка берёт время из настроек
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${tomorrow}/schedule`,
      { time: '09:00-10:00', title: 'Совещание', alarmMode: 'notify' });

    const before = await getJson(s.url, s.cookie, '/api/v1/push/status');
    assert.strictEqual(new Date(before.pending[0].fireAt).toISOString(), `${tomorrow}T05:50:00.000Z`);

    await api(s.url, s.cookie, 'PATCH', '/api/v1/settings', { settings: { notifyDefaultBeforeMin: 30 } });
    await api(s.url, s.cookie, 'POST', '/api/v1/push/replan');

    const after = await getJson(s.url, s.cookie, '/api/v1/push/status');
    assert.strictEqual(after.settings.notifyDefaultBeforeMin, 30);
    assert.strictEqual(after.pending.length, 1, 'дубля нет');
    assert.strictEqual(new Date(after.pending[0].fireAt).toISOString(), `${tomorrow}T05:30:00.000Z`);
  } finally { await s.close(); }
});

test('тихие часы включаются и выключаются настройками', async () => {
  const s = await loggedIn(withPush());
  try {
    await api(s.url, s.cookie, 'PATCH', '/api/v1/settings',
      { settings: { quietFrom: 23 * 60, quietTo: 7 * 60 } });
    let status = await getJson(s.url, s.cookie, '/api/v1/push/status');
    assert.strictEqual(status.settings.quietFrom, 1380);
    assert.strictEqual(status.settings.quietTo, 420);

    await api(s.url, s.cookie, 'PATCH', '/api/v1/settings', { settings: { quietFrom: null, quietTo: null } });
    status = await getJson(s.url, s.cookie, '/api/v1/push/status');
    assert.strictEqual(status.settings.quietFrom, null, 'выключение возвращает «в любое время»');
    assert.strictEqual(status.settings.quietTo, null);
  } finally { await s.close(); }
});

test('проверочное уведомление требует подписки', async () => {
  const s = await loggedIn(withPush());
  try {
    const res = await api(s.url, s.cookie, 'POST', '/api/v1/push/test', {}, {}, true);
    assert.strictEqual(res.status, 400);
    await api(s.url, s.cookie, 'POST', '/api/v1/push/subscribe', { subscription: SUB });
    const ok = await api(s.url, s.cookie, 'POST', '/api/v1/push/test');
    assert.strictEqual(ok.success, true);
  } finally { await s.close(); }
});

test('чужая подписка не видна', async () => {
  const a = await loggedIn({ email: 'a@b.ru', ...withPush() });
  try {
    const b = await loggedIn({ email: 'c@d.ru', server: a.srv });
    await api(a.url, a.cookie, 'POST', '/api/v1/push/subscribe', { subscription: SUB });
    const status = await getJson(b.url, b.cookie, '/api/v1/push/status');
    assert.strictEqual(status.subscriptions.length, 0);
  } finally { await a.close(); }
});

/*
 * Напоминания о еде. Раньше их не планировал никто: читались только строки
 * расписания, а колокольчик у приёма пищи в интерфейсе горел — обещал то,
 * чего не будет.
 */
test('приём пищи со сроком планирует напоминание', async () => {
  const s = await loggedIn(withPush());
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/push/subscribe', { subscription: SUB });
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${tomorrow}/meals`,
      { title: 'Обед', timeMin: 780, remindBefore: [15] });

    const status = await getJson(s.url, s.cookie, '/api/v1/push/status');
    assert.strictEqual(status.pending.length, 1, 'напоминание о еде запланировано');
    assert.match(status.pending[0].payload.body, /Обед/);
    // 13:00 минус 15 минут по Москве = 12:45 = 09:45 UTC
    assert.strictEqual(new Date(status.pending[0].fireAt).toISOString(), `${tomorrow}T09:45:00.000Z`);
  } finally { await s.close(); }
});

test('«к концу окна» считается от конца окна, а не от начала', async () => {
  const s = await loggedIn(withPush());
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/push/subscribe', { subscription: SUB });
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    // окно 12:00–14:00, отметка «к концу окна» — это −1, а не минус ширина окна
    const meal = await api(s.url, s.cookie, 'POST', `/api/v1/days/${tomorrow}/meals`,
      { title: 'Обед окном', timeMin: 720, endMin: 840, remindBefore: [-1] });
    assert.strictEqual(meal.remind_before_json, '[-1]', 'отметка хранится как отметка');

    let status = await getJson(s.url, s.cookie, '/api/v1/push/status');
    assert.strictEqual(status.pending.length, 1);
    assert.match(status.pending[0].payload.body, /окно закрывается в 14:00/);
    assert.strictEqual(new Date(status.pending[0].fireAt).toISOString(), `${tomorrow}T11:00:00.000Z`);

    // правка окна двигает и напоминание: момент считается от конца, а не хранится
    await api(s.url, s.cookie, 'PATCH', `/api/v1/days/${tomorrow}/meals/${meal.id}`, { endMin: 900 });
    status = await getJson(s.url, s.cookie, '/api/v1/push/status');
    assert.strictEqual(new Date(status.pending[0].fireAt).toISOString(), `${tomorrow}T12:00:00.000Z`);
  } finally { await s.close(); }
});

test('приём пищи со своим блоком в расписании не напоминает дважды', async () => {
  const s = await loggedIn(withPush());
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/push/subscribe', { subscription: SUB });
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const block = await api(s.url, s.cookie, 'POST', `/api/v1/days/${tomorrow}/schedule`,
      { time: '13:00-13:30', title: 'Обед', kind: 'meal', alarmMode: 'notify', remindBefore: [15] });
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${tomorrow}/meals`,
      { title: 'Обед', timeMin: 780, remindBefore: [15], scheduleItemId: block.id });

    const status = await getJson(s.url, s.cookie, '/api/v1/push/status');
    assert.strictEqual(status.pending.length, 1, 'напоминает блок, а не оба');
  } finally { await s.close(); }
});
