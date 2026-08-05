const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, dayFromToday } = require('../helpers/client');

const daily = (extra = {}) => ({
  freq: 'daily', startDate: '2026-08-03',
  rows: [{ time: '06:00-06:30', title: 'Подъём', alarmMode: 'alarm', alarmProfile: 'wakeup' }],
  ...extra,
});

test('ежедневный повтор появляется в каждом дне', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/series', daily());
    for (const d of ['2026-08-03', '2026-08-04', '2026-08-05']) {
      const day = await getJson(s.url, s.cookie, `/api/v1/days/${d}/full`);
      assert.strictEqual(day.schedule.length, 1, `нет строки на ${d}`);
      assert.strictEqual(day.schedule[0].title, 'Подъём');
      assert.strictEqual(day.schedule[0].start_min, 360);
      assert.strictEqual(day.schedule[0].alarm_mode, 'alarm');
    }
  } finally { await s.close(); }
});

test('повтор не появляется раньше даты начала и после окончания', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/series', daily({ endDate: '2026-08-05' }));
    const before = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-02/full');
    const after = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-06/full');
    assert.deepStrictEqual(before.schedule, []);
    assert.deepStrictEqual(after.schedule, []);
  } finally { await s.close(); }
});

test('материализация идемпотентна: повторное чтение не плодит строки', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/series', daily());
    await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
    await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
    const day = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
    assert.strictEqual(day.schedule.length, 1);
  } finally { await s.close(); }
});

test('«по будням» пропускает выходные', async () => {
  const s = await loggedIn();
  try {
    const WEEKDAYS = 0b0011111; // пн-пт
    await api(s.url, s.cookie, 'POST', '/api/v1/series',
      daily({ freq: 'weekly', byweekday: WEEKDAYS }));
    const mon = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
    const sat = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-08/full');
    const sun = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-09/full');
    assert.strictEqual(mon.schedule.length, 1);
    assert.strictEqual(sat.schedule.length, 0);
    assert.strictEqual(sun.schedule.length, 0);
  } finally { await s.close(); }
});

test('каждые две недели — через неделю пусто', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/series',
      daily({ freq: 'weekly', interval: 2, byweekday: 1 /* пн */ }));
    const w0 = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
    const w1 = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-10/full');
    const w2 = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-17/full');
    assert.strictEqual(w0.schedule.length, 1);
    assert.strictEqual(w1.schedule.length, 0, 'нечётная неделя пропускается');
    assert.strictEqual(w2.schedule.length, 1);
  } finally { await s.close(); }
});

test('каждый интервал через день', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/series', daily({ interval: 2 }));
    const d0 = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
    const d1 = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-04/full');
    const d2 = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-05/full');
    assert.strictEqual(d0.schedule.length, 1);
    assert.strictEqual(d1.schedule.length, 0);
    assert.strictEqual(d2.schedule.length, 1);
  } finally { await s.close(); }
});

test('удаление строки убирает её только из этого дня', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/series', daily());
    const day = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-04/full');
    await api(s.url, s.cookie, 'DELETE', `/api/v1/days/2026-08-04/schedule/${day.schedule[0].id}`);

    const again = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-04/full');
    assert.strictEqual(again.schedule.length, 0, 'удалённый день остаётся пустым');

    const other = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-05/full');
    assert.strictEqual(other.schedule.length, 1, 'серия жива в остальные дни');
  } finally { await s.close(); }
});

test('правка одного дня не переписывается серией обратно', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/series', daily());
    const day = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-04/full');
    await api(s.url, s.cookie, 'PATCH',
      `/api/v1/days/2026-08-04/schedule/${day.schedule[0].id}`, { title: 'Подъём попозже', startMin: 420 });

    const again = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-04/full');
    assert.strictEqual(again.schedule.length, 1, 'дубликат не создан');
    assert.strictEqual(again.schedule[0].title, 'Подъём попозже');
    assert.strictEqual(again.schedule[0].start_min, 420);
  } finally { await s.close(); }
});

test('отметка «выполнено» не считается правкой серии', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/series', daily());
    const day = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-04/full');
    await api(s.url, s.cookie, 'PATCH',
      `/api/v1/days/2026-08-04/schedule/${day.schedule[0].id}`, { done: true });
    const rows = s.db.prepare('SELECT COUNT(*) AS c FROM series_overrides').get().c;
    assert.strictEqual(rows, 0);
  } finally { await s.close(); }
});

test('завершение серии с даты чистит будущее и оставляет прошлое', async () => {
  const s = await loggedIn();
  try {
    const rule = await api(s.url, s.cookie, 'POST', '/api/v1/series', daily());
    await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
    await getJson(s.url, s.cookie, '/api/v1/days/2026-08-06/full');

    await api(s.url, s.cookie, 'DELETE', `/api/v1/series/${rule.id}?from=2026-08-05`);

    const past = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
    const future = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-06/full');
    assert.strictEqual(past.schedule.length, 1, 'прожитый день не тронут');
    assert.strictEqual(future.schedule.length, 0, 'будущее очищено');
  } finally { await s.close(); }
});

test('удаление серии целиком не стирает уже прожитые дни', async () => {
  const s = await loggedIn();
  try {
    const rule = await api(s.url, s.cookie, 'POST', '/api/v1/series', daily());
    await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
    await api(s.url, s.cookie, 'DELETE', `/api/v1/series/${rule.id}`);
    const past = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
    assert.strictEqual(past.schedule.length, 1);
    assert.strictEqual(past.schedule[0].series_id, null, 'строка отвязана от серии');
  } finally { await s.close(); }
});

test('шаблон применяется и вручную', async () => {
  const s = await loggedIn();
  try {
    const tpl = await api(s.url, s.cookie, 'POST', '/api/v1/series', {
      name: 'Рабочий день',
      rows: [
        { time: '09:00-13:00', title: 'Работа' },
        { time: '13:00-14:00', title: 'Обед' },
      ],
    });
    // прошлый день сам не заполняется — переписывать прожитое нельзя
    const past = await getJson(s.url, s.cookie, '/api/v1/days/2020-08-11/full');
    assert.strictEqual(past.schedule.length, 0);

    await api(s.url, s.cookie, 'POST', `/api/v1/series/${tpl.id}/apply`, { date: '2020-08-11' });
    const after = await getJson(s.url, s.cookie, '/api/v1/days/2020-08-11/full');
    assert.deepStrictEqual(after.schedule.map(r => r.title), ['Работа', 'Обед']);
  } finally { await s.close(); }
});

/*
 * Шаблон заполняет пустой день сам — это то, что обещает подпись под ним.
 * Три ограничения делают обещание безопасным, и каждое проверяется здесь.
 */
test('шаблон сам заполняет пустой будущий день', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/series', {
      name: 'Общее расписание', forceRows: true,
      rows: [{ time: '07:00-07:30', title: 'Подъём' }],
    });
    const future = dayFromToday(3);
    const day = await getJson(s.url, s.cookie, `/api/v1/days/${future}/full`);
    assert.deepStrictEqual(day.schedule.map(r => r.title), ['Подъём']);
  } finally { await s.close(); }
});

test('шаблон не переписывает прошлое', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/series', {
      name: 'Общее расписание', forceRows: true,
      rows: [{ time: '07:00-07:30', title: 'Подъём' }],
    });
    const past = dayFromToday(-3);
    const day = await getJson(s.url, s.cookie, `/api/v1/days/${past}/full`);
    assert.strictEqual(day.schedule.length, 0, 'прожитый день не трогаем');
  } finally { await s.close(); }
});

test('шаблон не лезет в день, где уже что-то есть', async () => {
  const s = await loggedIn();
  try {
    const future = dayFromToday(4);
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${future}/schedule`, { title: 'Своё дело', startMin: 600 });
    await api(s.url, s.cookie, 'POST', '/api/v1/series', {
      name: 'Общее расписание', forceRows: true,
      rows: [{ time: '07:00-07:30', title: 'Подъём' }],
    });
    const day = await getJson(s.url, s.cookie, `/api/v1/days/${future}/full`);
    assert.deepStrictEqual(day.schedule.map(r => r.title), ['Своё дело']);
  } finally { await s.close(); }
});

test('очищенный день не заполняется шаблоном второй раз', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/series', {
      name: 'Общее расписание', forceRows: true,
      rows: [{ time: '07:00-07:30', title: 'Подъём' }],
    });
    const future = dayFromToday(5);
    const first = await getJson(s.url, s.cookie, `/api/v1/days/${future}/full`);
    assert.strictEqual(first.schedule.length, 1);

    for (const r of first.schedule) {
      await api(s.url, s.cookie, 'DELETE', `/api/v1/days/${future}/schedule/${r.id}`);
    }
    const again = await getJson(s.url, s.cookie, `/api/v1/days/${future}/full`);
    assert.strictEqual(again.schedule.length, 0, 'удалённое не возвращается');
  } finally { await s.close(); }
});

test('ежегодный повтор попадает в то же число следующего года', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/series', {
      freq: 'yearly', startDate: '2026-08-05',
      rows: [{ time: '10:00', title: 'День рождения Ани', alarmMode: 'notify' }],
    });
    for (const d of ['2026-08-05', '2027-08-05', '2030-08-05']) {
      const day = await getJson(s.url, s.cookie, `/api/v1/days/${d}/full`);
      assert.deepStrictEqual(day.schedule.map(r => r.title), ['День рождения Ани'], d);
    }
    const other = await getJson(s.url, s.cookie, '/api/v1/days/2027-08-06/full');
    assert.strictEqual(other.schedule.length, 0, 'соседнее число пустое');
  } finally { await s.close(); }
});

/*
 * Шаблон дня в веб-версии: один именованный набор строк, который пишется
 * целиком при каждой правке. Проверяем ровно то, на что она опирается.
 */
const template = (extra = {}) => ({
  name: 'Общее расписание', target: 'schedule', forceRows: true,
  rows: [{ startMin: 420, endMin: 450, title: 'Подъём', alarmMode: 'alarm', alarmProfile: 'wakeup' }],
  ...extra,
});

test('шаблоны и повторы в списке не смешиваются', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/series', daily());
    await api(s.url, s.cookie, 'POST', '/api/v1/series', template());

    const templates = await getJson(s.url, s.cookie, '/api/v1/series?templates=1');
    const repeats = await getJson(s.url, s.cookie, '/api/v1/series?templates=0');

    assert.deepStrictEqual(templates.map(r => r.name), ['Общее расписание']);
    assert.deepStrictEqual(repeats.map(r => r.name), [null]);
  } finally { await s.close(); }
});

test('правка шаблона заменяет набор строк, а не дописывает', async () => {
  const s = await loggedIn();
  try {
    const tpl = await api(s.url, s.cookie, 'POST', '/api/v1/series', template());
    await api(s.url, s.cookie, 'PATCH', `/api/v1/series/${tpl.id}`, template({
      rows: [
        { startMin: 420, endMin: 450, title: 'Подъём' },
        { startMin: 540, endMin: 780, title: 'Работа' },
      ],
    }));

    await api(s.url, s.cookie, 'POST', `/api/v1/series/${tpl.id}/apply`, { date: '2026-08-12' });
    const day = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-12/full');
    assert.deepStrictEqual(day.schedule.map(r => r.title), ['Подъём', 'Работа']);
  } finally { await s.close(); }
});

test('шаблон из одной строки остаётся шаблоном, а не повтором', async () => {
  const s = await loggedIn();
  try {
    const tpl = await api(s.url, s.cookie, 'POST', '/api/v1/series', template());
    // Одна строка без forceRows легла бы в payload как повтор — а веб-версия
    // всегда шлёт набор, и разбирать его должно одинаково
    assert.deepStrictEqual(JSON.parse(tpl.payload_json).rows.length, 1);

    // прошлое шаблон не трогает, поэтому проверяем разбор набора вручную
    await api(s.url, s.cookie, 'POST', `/api/v1/series/${tpl.id}/apply`, { date: '2020-08-12' });
    const after = await getJson(s.url, s.cookie, '/api/v1/days/2020-08-12/full');
    assert.deepStrictEqual(after.schedule.map(r => r.title), ['Подъём']);
    assert.strictEqual(after.schedule[0].alarm_mode, 'alarm');
  } finally { await s.close(); }
});

test('шаблон добавляет строки к тем, что в дне уже есть', async () => {
  const s = await loggedIn();
  try {
    const tpl = await api(s.url, s.cookie, 'POST', '/api/v1/series', template());
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-13/schedule', { title: 'Своё дело', startMin: 600 });
    await api(s.url, s.cookie, 'POST', `/api/v1/series/${tpl.id}/apply`, { date: '2026-08-13' });

    const day = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-13/full');
    // Кнопка так и называется — «Добавить в день»; своё дело не пропало
    assert.deepStrictEqual(day.schedule.map(r => r.title).sort(), ['Подъём', 'Своё дело']);
  } finally { await s.close(); }
});

test('удаление шаблона не трогает дни, куда его уже положили', async () => {
  const s = await loggedIn();
  try {
    const tpl = await api(s.url, s.cookie, 'POST', '/api/v1/series', template());
    await api(s.url, s.cookie, 'POST', `/api/v1/series/${tpl.id}/apply`, { date: '2026-08-14' });
    await api(s.url, s.cookie, 'DELETE', `/api/v1/series/${tpl.id}`);

    const day = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-14/full');
    assert.deepStrictEqual(day.schedule.map(r => r.title), ['Подъём']);
    assert.deepStrictEqual(await getJson(s.url, s.cookie, '/api/v1/series?templates=1'), []);
  } finally { await s.close(); }
});

test('повтор без даты начала отвергается', async () => {
  const s = await loggedIn();
  try {
    const res = await api(s.url, s.cookie, 'POST', '/api/v1/series',
      { freq: 'daily', rows: [{ time: '06:00', title: 'X' }] }, {}, true);
    assert.strictEqual(res.status, 400);
  } finally { await s.close(); }
});

test('чужой повтор недоступен', async () => {
  const a = await loggedIn({ email: 'a@b.ru' });
  try {
    const b = await loggedIn({ email: 'c@d.ru', server: a.srv });
    const rule = await api(a.url, a.cookie, 'POST', '/api/v1/series', daily());
    const res = await api(b.url, b.cookie, 'DELETE', `/api/v1/series/${rule.id}`, undefined, {}, true);
    assert.strictEqual(res.status, 404);
    const day = await getJson(b.url, b.cookie, '/api/v1/days/2026-08-03/full');
    assert.strictEqual(day.schedule.length, 0, 'чужой повтор не материализуется');
  } finally { await a.close(); }
});
