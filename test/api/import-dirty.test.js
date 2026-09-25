/**
 * Загрузка испорченной выгрузки.
 *
 * Файл приходит от человека: правленный руками, склеенный из двух, собранный
 * прежней версией. Дата в нём проверяется целиком — с невозможной датой файл
 * не берут вовсе. А вот значения полей отказывать во всей копии не должны:
 * человек восстанавливает данные, и «не вернули ничего» — худший ответ.
 *
 * Поэтому здесь сторожим другое: что мусор не доезжает до базы. Цвет не из
 * палитры однажды гасил весь экран дня — и перезагрузка не помогала, строка
 * приезжала с сервера снова.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, today } = require('../helpers/client');

const грязнаяВыгрузка = (d) => ({
  formatVersion: 1,
  days: [{ date: d, title: 'x'.repeat(5000), weight: 'ой' }],
  scheduleItems: [{
    id: 1, date: d, title: 'Подъём', start_min: 99999, end_min: -5,
    kind: 'взлёт', alarm_mode: 'сирена', alarm_profile: 'что-то',
    color: 'blue', done: 'ага', sort_order: 'первый',
    remind_before_json: 'не json', remind_before_min: 999999,
  }],
  tasks: [{ date: d, bucket: 'гараж', text: 'Отчёт', done: 2 }],
  meals: [{ date: d, slot: 'полдник', title: 'Обед', calories: -40, time_min: 5000 }],
  sportSets: [{ date: d, exercise: 'Жим', sets: 'три', weight: 'тяжело' }],
  habits: [{ id: 7, title: 'Вода', color: 'кислотный', type: 'странный',
             polarity: 'может', mode: 'вечно', break_policy: 'как-нибудь',
             schedule_mask: 999, times_per_week: 70 }],
  habitLogs: [{ habit_id: 7, date: d, status: 'наверное', value: 'много' }],
  series: [{ id: 3, name: 'Зарядка', freq: 'иногда', interval: 0,
             byweekday: 500, start_date: d, payload_json: '<<<' }],
  freeNotes: [{ title: 'z'.repeat(1000), text: 'ладно' }],
});

test('испорченную выгрузку берут, но мусор до базы не доезжает', async () => {
  const s = await loggedIn();
  try {
    const d = today();
    const r = await api(s.url, s.cookie, 'POST', '/api/v1/import',
      { data: грязнаяВыгрузка(d), mode: 'replace' }, {}, true);
    assert.strictEqual(r.status, 200, `копию должны принять, получили ${r.status}`);

    // ── экран дня собирается и показывает разумные значения
    const день = await getJson(s.url, s.cookie, `/api/v1/days/${d}/full`);
    const блок = день.schedule[0];
    assert.ok(блок, 'строка расписания на месте');
    assert.strictEqual(блок.color, null, 'цвет не из палитры не сохранён');
    assert.strictEqual(блок.kind, 'normal', 'неизвестный вид стал обычным');
    assert.strictEqual(блок.alarm_mode, 'none', 'неизвестный будильник выключен');
    assert.strictEqual(блок.alarm_profile, 'gentle', 'неизвестный профиль стал обычным');
    assert.ok(блок.start_min >= 0 && блок.start_min <= 1439, `начало в сутках: ${блок.start_min}`);
    assert.ok(блок.end_min === null || (блок.end_min >= 0 && блок.end_min <= 1439),
      `конец в сутках: ${блок.end_min}`);
    assert.strictEqual(блок.remind_before_json, null, 'неразбираемый список сроков не сохранён');
    assert.strictEqual(блок.remind_before_min, null, 'и одиночный срок вместе с ним');

    const задача = [...день.tasks.work, ...день.tasks.home][0];
    assert.ok(['work', 'home'].includes(задача.bucket), `раздел из списка: ${задача.bucket}`);
    assert.ok([0, 1].includes(задача.done), `отметка это 0 или 1, а не ${задача.done}`);

    const еда = день.meals[0];
    assert.ok(['breakfast', 'lunch', 'dinner', 'snack', 'other'].includes(еда.slot));
    assert.ok(еда.calories === null || еда.calories >= 0, `калории не бывают меньше нуля: ${еда.calories}`);
    assert.ok(еда.time_min === null || (еда.time_min >= 0 && еда.time_min <= 1439),
      `время в сутках: ${еда.time_min}`);

    // ── привычка и её отметка тоже читаются
    const привычки = await getJson(s.url, s.cookie, '/api/v1/habits');
    assert.strictEqual(привычки.length, 1);
    assert.strictEqual(привычки[0].color, 'blue', 'неизвестный цвет привычки заменён');
    assert.ok(привычки[0].schedule_mask >= 0 && привычки[0].schedule_mask <= 127,
      `маска дней в пределах недели: ${привычки[0].schedule_mask}`);
    assert.ok(привычки[0].times_per_week === null || привычки[0].times_per_week <= 7,
      `раз в неделю не больше семи: ${привычки[0].times_per_week}`);

    // ── и сводка считается, а не падает на мусоре
    const сводка = await api(s.url, s.cookie, 'GET', `/api/v1/stats?from=${d}&to=${d}`, undefined, {}, true);
    assert.strictEqual(сводка.status, 200, 'сводка по восстановленному дню собирается');
  } finally { await s.close(); }
});

test('невозможная дата отвергает всю копию целиком', async () => {
  const s = await loggedIn();
  try {
    const r = await api(s.url, s.cookie, 'POST', '/api/v1/import',
      { data: { formatVersion: 1, days: [{ date: '2025-99-99', title: 'Никогда' }] }, mode: 'merge' },
      {}, true);
    assert.strictEqual(r.status, 400, 'половина копии хуже честного отказа');
  } finally { await s.close(); }
});

test('«заменить всё» возвращает и человека: пояс, тему, переключатели', async () => {
  const откуда = await loggedIn();
  let копия;
  try {
    await api(откуда.url, откуда.cookie, 'PATCH', '/api/v1/settings', {
      displayName: 'Дан', timezone: 'Asia/Novosibirsk', theme: 'dark',
      weekStart: 7, scheduleView: 'timeline', foodMode: 'timed',
      settings: { accent: 'green', carryOver: true },
    });
    копия = await getJson(откуда.url, откуда.cookie, '/api/v1/export');
  } finally { await откуда.close(); }

  const куда = await loggedIn();
  try {
    await api(куда.url, куда.cookie, 'POST', '/api/v1/import', { data: копия, mode: 'replace' });
    const я = await getJson(куда.url, куда.cookie, '/api/v1/settings');
    assert.strictEqual(я.timezone, 'Asia/Novosibirsk', 'часовой пояс — это сдвиг «сегодня»');
    assert.strictEqual(я.theme, 'dark');
    assert.strictEqual(я.weekStart, 7);
    assert.strictEqual(я.scheduleView, 'timeline');
    assert.strictEqual(я.foodMode, 'timed');
    assert.strictEqual(я.displayName, 'Дан');
    assert.strictEqual(я.settings.accent, 'green', 'свободные настройки тоже');
    assert.strictEqual(я.settings.carryOver, true);
  } finally { await куда.close(); }
});

test('чужая тема из файла не приходит в режиме «добавить»', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'PATCH', '/api/v1/settings', { theme: 'light' });
    await api(s.url, s.cookie, 'POST', '/api/v1/import',
      { data: { formatVersion: 1, user: { theme: 'dark', timezone: 'Asia/Tokyo' } }, mode: 'merge' });
    const я = await getJson(s.url, s.cookie, '/api/v1/settings');
    assert.strictEqual(я.theme, 'light', 'при «добавить» свои настройки сильнее файла');
  } finally { await s.close(); }
});
