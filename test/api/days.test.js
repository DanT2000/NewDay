const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson } = require('../helpers/client');

test('PUT /full без If-Match отвергается', async () => {
  const s = await loggedIn();
  try {
    const res = await api(s.url, s.cookie, 'PUT', '/api/v1/days/2026-08-03/full',
      { title: 'X' }, {}, true);
    assert.strictEqual(res.status, 428);
    assert.strictEqual((await res.json()).error.code, 'IF_MATCH_REQUIRED');
  } finally { await s.close(); }
});

test('PUT /full с устаревшим If-Match даёт 409 и отдаёт актуальный день', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'PATCH', '/api/v1/days/2026-08-03',
      { title: 'A' }, { 'If-Match': '"0"' });
    const res = await api(s.url, s.cookie, 'PUT', '/api/v1/days/2026-08-03/full',
      { title: 'B' }, { 'If-Match': '"0"' }, true);
    assert.strictEqual(res.status, 409);
    const body = await res.json();
    assert.strictEqual(body.error.code, 'REV_MISMATCH');
    assert.ok(body.error.details.current.rev >= 1);
    assert.strictEqual(body.error.details.current.title, 'A');
  } finally { await s.close(); }
});

test('GET несуществующего дня отдаёт пустой день и НЕ создаёт его', async () => {
  const s = await loggedIn();
  try {
    const body = await getJson(s.url, s.cookie, '/api/v1/days/2026-09-09/full');
    assert.strictEqual(body.rev, 0);
    assert.deepStrictEqual(body.schedule, []);
    assert.deepStrictEqual(body.tasks, { work: [], home: [] });
    assert.strictEqual(s.db.prepare('SELECT COUNT(*) AS c FROM days').get().c, 0,
      'чтение не создаёт день');
  } finally { await s.close(); }
});

test('добавление строки расписания создаёт день лениво', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-09-09/schedule',
      { startMin: 540, endMin: 600, title: 'Работа' });
    assert.strictEqual(s.db.prepare('SELECT COUNT(*) AS c FROM days').get().c, 1);
  } finally { await s.close(); }
});

test('PATCH пустым телом ничего не стирает', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/schedule',
      { startMin: 540, title: 'Работа' });
    const before = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
    await api(s.url, s.cookie, 'PATCH', '/api/v1/days/2026-08-03', {},
      { 'If-Match': `"${before.rev}"` });
    const after = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
    assert.strictEqual(after.schedule.length, 1, 'расписание на месте');
  } finally { await s.close(); }
});

test('два клиента правят разные строки одного дня — ничего не теряется', async () => {
  const s = await loggedIn();
  try {
    const a = await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/schedule',
      { startMin: 540, title: 'A' });
    const b = await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/schedule',
      { startMin: 600, title: 'B' });

    await Promise.all([
      api(s.url, s.cookie, 'PATCH', `/api/v1/days/2026-08-03/schedule/${a.id}`, { done: true }),
      api(s.url, s.cookie, 'PATCH', `/api/v1/days/2026-08-03/schedule/${b.id}`, { title: 'B изменено' }),
    ]);

    const full = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
    assert.strictEqual(full.schedule.find(r => r.id === a.id).done, 1);
    assert.strictEqual(full.schedule.find(r => r.id === b.id).title, 'B изменено');
  } finally { await s.close(); }
});

test('время принимается строкой и нормализуется в минуты', async () => {
  const s = await loggedIn();
  try {
    const row = await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/schedule',
      { time: '9:30-13', title: 'Работа' });
    assert.strictEqual(row.start_min, 570);
    assert.strictEqual(row.end_min, 780);
  } finally { await s.close(); }
});

test('список расписания всегда отсортирован по времени', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/schedule', { startMin: 780, title: 'Позже' });
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/schedule', { startMin: 540, title: 'Раньше' });
    const full = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
    assert.deepStrictEqual(full.schedule.map(r => r.title), ['Раньше', 'Позже']);
  } finally { await s.close(); }
});

test('сдвиг обеда двигает всё, что после', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/schedule', { time: '9-13', title: 'Работа' });
    const lunch = await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/schedule', { time: '13-14', title: 'Обед' });
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/schedule', { time: '14-18', title: 'Работа 2' });

    const rows = await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/schedule/shift',
      { fromId: lunch.id, minutes: 15, cascade: true });
    assert.deepStrictEqual(rows.map(r => r.start_min), [540, 795, 855]);
  } finally { await s.close(); }
});

test('расписание не входит в прогресс дня, но остаётся отдельным счётчиком', async () => {
  const s = await loggedIn();
  try {
    // две строки расписания, одна отмечена — на прогресс влиять не должны
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/schedule', { startMin: 540, title: 'A', done: true });
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/schedule', { startMin: 600, title: 'B' });
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/tasks', { bucket: 'work', text: 'T', done: true });
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/tasks', { bucket: 'home', text: 'H' });

    const full = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
    assert.strictEqual(full.progress.total.done, 1, 'только выполненная задача');
    assert.strictEqual(full.progress.total.possible, 2, 'две задачи, расписание не считается');
    assert.strictEqual(full.progress.total.percent, 50);

    assert.strictEqual(full.progress.schedule.done, 1, 'счётчик расписания живёт сам по себе');
    assert.strictEqual(full.progress.schedule.possible, 2);
  } finally { await s.close(); }
});

test('день из одного расписания даёт пустой прогресс, а не ноль процентов', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/schedule', { startMin: 540, title: 'A' });
    const full = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
    // отмечать нечего — процента нет; иначе день с одним расписанием
    // выглядел бы как проваленный
    assert.strictEqual(full.progress.total.possible, 0);
    assert.strictEqual(full.progress.total.percent, null);
  } finally { await s.close(); }
});

test('пустая секция даёт percent = null и не тянет общий вниз', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/tasks', { bucket: 'work', text: 'T', done: true });
    const full = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
    assert.strictEqual(full.progress.sport.percent, null);
    assert.strictEqual(full.progress.total.percent, 100);
  } finally { await s.close(); }
});

test('PUT /full заменяет день целиком', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-05/schedule', { startMin: 100, title: 'Старое' });
    const cur = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-05/full');
    const after = await api(s.url, s.cookie, 'PUT', '/api/v1/days/2026-08-05/full', {
      title: 'План от бота',
      schedule: [{ time: '06:00-06:30', title: 'Подъём', alarmMode: 'alarm', alarmProfile: 'wakeup' }],
      tasks: { work: [{ text: 'Созвон' }], home: [] },
      meals: [{ slot: 'breakfast', title: 'Овсянка' }],
    }, { 'If-Match': `"${cur.rev}"` });

    assert.strictEqual(after.title, 'План от бота');
    assert.strictEqual(after.schedule.length, 1);
    assert.strictEqual(after.schedule[0].start_min, 360, 'строковое время разобрано');
    assert.strictEqual(after.schedule[0].end_min, 390);
    assert.strictEqual(after.schedule[0].alarm_mode, 'alarm');
    assert.strictEqual(after.schedule[0].alarm_profile, 'wakeup');
    assert.strictEqual(after.tasks.work.length, 1);
    assert.strictEqual(after.meals[0].slot, 'breakfast');
  } finally { await s.close(); }
});

test('PUT /full разбирает время во всех строках, а не только в первой', async () => {
  const s = await loggedIn();
  try {
    const cur = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-06/full');
    const after = await api(s.url, s.cookie, 'PUT', '/api/v1/days/2026-08-06/full', {
      schedule: [
        { time: '06:00-06:30', title: 'Подъём' },
        { time: '09:00-13:00', title: 'Работа' },
        { time: '13:00-14:00', title: 'Обед' },
      ],
    }, { 'If-Match': `"${cur.rev}"` });
    assert.deepStrictEqual(after.schedule.map(r => r.start_min), [360, 540, 780]);
    assert.deepStrictEqual(after.schedule.map(r => r.end_min), [390, 780, 840]);
  } finally { await s.close(); }
});

/*
 * Массовая запись дня проходит те же проверки, что и запись по одной строке.
 *
 * Раньше тело уходило в репозиторий как есть, и список сроков предупреждения
 * ронял запрос в «внутреннюю ошибку»: массив упирался в драйвер базы. Заодно
 * проверяем цвет, тип «напоминание» и окно у приёма пищи — все они появились
 * позже самого PUT и легко остались бы необработанными.
 */
test('PUT /full принимает список сроков, цвет, напоминание и окно питания', async () => {
  const s = await loggedIn();
  try {
    const cur = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-09/full');
    const after = await api(s.url, s.cookie, 'PUT', '/api/v1/days/2026-08-09/full', {
      schedule: [
        { time: '09:00-13:00', title: 'Работа', alarmMode: 'notify', remindBefore: [15, 0], color: 'green' },
        { time: '19:00', title: 'Забрать документы', kind: 'reminder', alarmMode: 'notify', remindBefore: [1440] },
      ],
      meals: [{ slot: 'lunch', timeMin: 720, endMin: 840, title: 'Обед окном' }],
    }, { 'If-Match': `"${cur.rev}"` });

    const [work, rem] = after.schedule;
    assert.strictEqual(work.remind_before_json, '[15,0]', 'список сроков сохранён');
    assert.strictEqual(work.remind_before_min, 15, 'первым остаётся самый ранний');
    assert.strictEqual(work.color, 'green');
    assert.strictEqual(rem.kind, 'reminder');
    assert.strictEqual(rem.end_min, null, 'у напоминания конца нет');
    assert.strictEqual(after.meals[0].end_min, 840, 'окно приёма пищи сохранено');
  } finally { await s.close(); }
});

test('битое время в PUT /full отвергается, а не молча превращается в полночь', async () => {
  const s = await loggedIn();
  try {
    const cur = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-06/full');
    const res = await api(s.url, s.cookie, 'PUT', '/api/v1/days/2026-08-06/full', {
      schedule: [{ time: 'после обеда', title: 'Что-то' }],
    }, { 'If-Match': `"${cur.rev}"` }, true);
    assert.strictEqual(res.status, 400);
  } finally { await s.close(); }
});

test('копирование дня переносит план, но не отметки', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/schedule',
      { time: '9-13', title: 'Работа', done: true });
    const copy = await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/copy-to',
      { targetDate: '2026-08-04' });
    assert.strictEqual(copy.schedule.length, 1);
    assert.strictEqual(copy.schedule[0].title, 'Работа');
    assert.strictEqual(copy.schedule[0].done, 0, 'галочка не переносится');
  } finally { await s.close(); }
});

test('чужой день недоступен', async () => {
  const a = await loggedIn({ email: 'a@b.ru' });
  try {
    const b = await loggedIn({ email: 'c@d.ru', server: a.srv });
    await api(a.url, a.cookie, 'POST', '/api/v1/days/2026-08-03/schedule',
      { startMin: 540, title: 'Секрет' });
    const seen = await getJson(b.url, b.cookie, '/api/v1/days/2026-08-03/full');
    assert.deepStrictEqual(seen.schedule, []);
  } finally { await a.close(); }
});

test('битая дата отвергается', async () => {
  const s = await loggedIn();
  try {
    const res = await api(s.url, s.cookie, 'GET', '/api/v1/days/2026-13-99/full', undefined, {}, true);
    assert.strictEqual(res.status, 400);
  } finally { await s.close(); }
});

/*
 * Удаление блока расписания отпускает приём пищи, который его занимал.
 *
 * Ссылка двусторонняя, и без этого она оставалась висячей: приём пищи
 * продолжал показывать «в расписании», а правка и даже удаление упирались
 * в «запись не найдена» — из интерфейса он не лечился вовсе.
 */
test('удаление блока расписания снимает ссылку с приёма пищи', async () => {
  const s = await loggedIn();
  const date = '2026-08-11';
  try {
    const block = await api(s.url, s.cookie, 'POST', `/api/v1/days/${date}/schedule`, {
      time: '13:00-13:30', title: 'Обед', kind: 'meal',
    });
    const meal = await api(s.url, s.cookie, 'POST', `/api/v1/days/${date}/meals`, {
      title: 'Обед', timeMin: 780, scheduleItemId: block.id,
    });
    assert.strictEqual(meal.schedule_item_id, block.id);

    await api(s.url, s.cookie, 'DELETE', `/api/v1/days/${date}/schedule/${block.id}`);

    const day = await getJson(s.url, s.cookie, `/api/v1/days/${date}/full`);
    assert.strictEqual(day.schedule.length, 0, 'блока больше нет');
    assert.strictEqual(day.meals[0].schedule_item_id, null, 'и ссылки на него тоже');
  } finally { await s.close(); }
});

/*
 * Сдвиг двигает и то, что начинается в ту же минуту. Раньше сравнение было
 * строгим: два дела на одно время разъезжались, первое уходило, второе
 * оставалось — и пересечение, ради которого сдвиг вызвали, никуда не девалось.
 */
test('сдвиг двигает блок, начинающийся в ту же минуту', async () => {
  const s = await loggedIn();
  const date = '2026-08-12';
  try {
    const a = await api(s.url, s.cookie, 'POST', `/api/v1/days/${date}/schedule`,
      { time: '12:00-14:00', title: 'Обед A' });
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${date}/schedule`,
      { time: '12:00-13:30', title: 'Обед B' });

    await api(s.url, s.cookie, 'POST', `/api/v1/days/${date}/schedule/shift`,
      { fromId: a.id, minutes: 60, cascade: true });

    const day = await getJson(s.url, s.cookie, `/api/v1/days/${date}/full`);
    const byTitle = Object.fromEntries(day.schedule.map(r => [r.title, r.start_min]));
    assert.strictEqual(byTitle['Обед A'], 780, 'первый уехал на час');
    assert.strictEqual(byTitle['Обед B'], 780, 'и второй вместе с ним');
  } finally { await s.close(); }
});

/*
 * Период длиннее предела отдаётся урезанным — и говорит об этом. Раньше в
 * ответе подтверждался запрошенный конец, и снаружи это выглядело как
 * «в ноябре ничего не запланировано».
 */
test('слишком длинный период честно сообщает, что урезан', async () => {
  const s = await loggedIn();
  try {
    const range = await getJson(s.url, s.cookie, '/api/v1/days/range?from=2026-08-05&to=2026-11-13');
    assert.ok(range.days.length <= 62, 'предел соблюдён');
    assert.strictEqual(range.truncated, true, 'урезание не скрыто');
    assert.strictEqual(range.requestedTo, '2026-11-13', 'запрошенный конец виден');
    assert.strictEqual(range.to, range.days[range.days.length - 1].date, 'to — конец отданного');
  } finally { await s.close(); }
});
