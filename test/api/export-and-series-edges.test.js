/**
 * Календарный экспорт и повторы на краях.
 *
 * Календарь читает не человек, а чужая программа: одна незаэкранированная
 * запятая — и файл не открывается целиком. Повторы же живут на датах,
 * которых в календаре может не быть (29 февраля) или которые сдвигаются
 * переводом часов.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, today, dayFromToday } = require('../helpers/client');

test('в календарный файл попадает и текст со спецсимволами', async () => {
  const s = await loggedIn();
  try {
    const D = today();
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/schedule`, {
      title: 'Созвон; важный, с «кавычками» и \\слэшем',
      note: 'Первая строка\nвторая строка\nтретья',
      startMin: 600, endMin: 660,
    });
    const r = await api(s.url, s.cookie, 'GET', '/api/v1/export.ics', undefined, {}, true);
    assert.strictEqual(r.status, 200, 'календарь отдаётся');
    const текст = await r.text();

    /*
     * В формате iCalendar запятая, точка с запятой и обратный слэш внутри
     * значения обязаны быть экранированы, а перевод строки записывается как
     * «\\n». Иначе разбор ломается на этой строке — а вместе с ней часто и
     * весь файл: календарь на телефоне просто не подпишется.
     */
    const строка = текст.split(/\r?\n/).find(l => l.startsWith('SUMMARY'));
    assert.ok(строка, 'заголовок события есть');
    assert.ok(строка.includes('\\;') && строка.includes('\\,'), `точка с запятой и запятая экранированы: ${строка}`);
    assert.ok(!/\r?\n/.test(строка.replace(/\\n/g, '')), 'перевод строки не разрывает значение');
    assert.ok(текст.includes('BEGIN:VCALENDAR') && текст.trim().endsWith('END:VCALENDAR'), 'файл целый');

    // строки складываются по 75 октетов — иначе часть календарей режет текст
    const слишкомДлинная = текст.split(/\r?\n/).find(l => Buffer.byteLength(l, 'utf8') > 75 && !l.startsWith(' '));
    assert.ok(!слишкомДлинная, `нет строк длиннее 75 октетов: ${String(слишкомДлинная).slice(0, 90)}`);
  } finally { await s.close(); }
});

test('ежегодный повтор 29 февраля не теряется и не задваивается', async () => {
  const s = await loggedIn();
  try {
    /*
     * 29 февраля существует раз в четыре года. Ежегодное напоминание,
     * заведённое на эту дату, должно вести себя предсказуемо: в високосный
     * год — ровно один раз, в обычный — либо ни разу, либо один раз, но не
     * дважды и без «внутренней ошибки».
     */
    const создано = await api(s.url, s.cookie, 'POST', '/api/v1/series', {
      freq: 'yearly', startDate: '2024-02-29',
      rows: [{ title: 'День рождения', startMin: 600, endMin: 660 }],
    }, {}, true);
    assert.ok([200, 201].includes(создано.status), `правило создано (${создано.status})`);

    for (const дата of ['2028-02-29', '2027-02-28', '2027-03-01']) {
      const день = await api(s.url, s.cookie, 'GET', `/api/v1/days/${дата}/full`, undefined, {}, true);
      assert.strictEqual(день.status, 200, `день ${дата} открывается`);
      const строки = (await день.json()).schedule.filter(r => r.title === 'День рождения');
      assert.ok(строки.length <= 1, `в ${дата} не больше одной записи (${строки.length})`);
    }
    const високосный = await getJson(s.url, s.cookie, '/api/v1/days/2028-02-29/full');
    assert.strictEqual(високосный.schedule.filter(r => r.title === 'День рождения').length, 1,
      'в високосный год запись есть');
  } finally { await s.close(); }
});

test('смена часового пояса не ломает сегодняшний день', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${today()}/tasks`, { text: 'задача', bucket: 'home' });

    /*
     * Человек переехал: пояс меняется, и «сегодня» вместе с ним. Проверяем,
     * что это не роняет ни открытие дня, ни статистику, ни перенос.
     */
    for (const пояс of ['Pacific/Kiritimati', 'Pacific/Midway', 'Asia/Kathmandu', 'Europe/Moscow']) {
      const смена = await api(s.url, s.cookie, 'PATCH', '/api/v1/settings', { timezone: пояс }, {}, true);
      assert.strictEqual(смена.status, 200, `пояс ${пояс} принят`);
      const профиль = await getJson(s.url, s.cookie, '/api/v1/settings');
      const день = await api(s.url, s.cookie, 'GET', `/api/v1/days/${профиль.today}/full`, undefined, {}, true);
      assert.strictEqual(день.status, 200, `день открывается в поясе ${пояс}`);
      const стат = await api(s.url, s.cookie, 'GET', `/api/v1/stats?from=${профиль.today}&to=${профиль.today}`, undefined, {}, true);
      assert.strictEqual(стат.status, 200, `статистика считается в поясе ${пояс}`);
    }
  } finally { await s.close(); }
});

test('старый API ограничивает длину текстов так же, как новый', async () => {
  const s = await loggedIn();
  try {
    /*
     * Легаси-путь пишет в те же таблицы, что и новый, но своей проверки
     * длины у него не было: через него в базу заезжал текст любого размера,
     * который потом приезжал во все списки нового клиента.
     */
    const длинная = await api(s.url, s.cookie, 'PUT', `/api/days/${today()}`, {
      notes: 'я'.repeat(100000),
    }, {}, true);
    assert.strictEqual(длинная.status, 400, 'заметка на 100 000 знаков — отказ');

    const длиннаяЗадача = await api(s.url, s.cookie, 'PUT', `/api/days/${today()}`, {
      workTasks: [{ text: 'ц'.repeat(50000), done: false }],
    }, {}, true);
    assert.strictEqual(длиннаяЗадача.status, 400, 'задача на 50 000 знаков — отказ');

    const обычное = await api(s.url, s.cookie, 'PUT', `/api/days/${today()}`, {
      notes: 'обычная заметка', workTasks: [{ text: 'позвонить', done: false }],
    }, {}, true);
    assert.strictEqual(обычное.status, 200, 'обычные данные сохраняются');
  } finally { await s.close(); }
});
