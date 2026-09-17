/**
 * Выгрузка и восстановление — последняя линия обороны.
 *
 * Проверяем не «эндпоинт отвечает», а то, ради чего он существует: свои
 * данные должны вернуться целиком и ровно в одном экземпляре. Ошибка здесь
 * обнаруживается в худший момент — когда восстанавливаются после потери.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, today, dayFromToday } = require('../helpers/client');

async function наполнить(s) {
  const D = today();
  await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/schedule`,
    { title: 'Подъём', startMin: 540, endMin: 550, alarmMode: 'alarm', alarmProfile: 'wakeup' });
  await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/schedule`,
    { title: 'Работа', startMin: 600, endMin: 780, kind: 'work', remindBefore: [15, 0] });
  await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/tasks`, { text: 'позвонить маме', bucket: 'home' });
  await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/meals`,
    { title: 'Обед', slot: 'lunch', timeMin: 720, endMin: 780, calories: 800, note: 'гречка 80 г' });
  await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/sport`,
    { exercise: 'Отжимания', sets: 4, reps: 10, repsMax: 12 });
  const h = await api(s.url, s.cookie, 'POST', '/api/v1/habits', { title: 'Вода', scheduleMask: 31 });
  await api(s.url, s.cookie, 'PUT', `/api/v1/habits/${h.id}/log/${dayFromToday(-1)}`, { status: 'done' });
  await api(s.url, s.cookie, 'POST', '/api/v1/series', {
    freq: 'weekly', startDate: D, byweekday: 31, rows: [{ title: 'Планёрка', startMin: 600, endMin: 630 }],
  });
  const день = await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`);
  await api(s.url, s.cookie, 'PATCH', `/api/v1/days/${D}`,
    { notes: 'заметка дня', weight: 72.5, foodPlan: 'Итого: примерно 1700–2150 ккал' },
    { 'If-Match': `"${день.rev}"` });
}

const слепок = async s => {
  const d = await getJson(s.url, s.cookie, `/api/v1/days/${today()}/full`);
  return {
    расписание: d.schedule.map(r => `${r.start_min}-${r.end_min} ${r.title} ${r.alarm_mode}`).sort(),
    задачи: [...d.tasks.work, ...d.tasks.home].map(t => t.text).sort(),
    питание: d.meals.map(m => `${m.title} ${m.calories} ${m.note}`).sort(),
    спорт: d.sport.map(x => `${x.exercise} ${x.sets}x${x.reps}-${x.reps_max}`).sort(),
    заметка: d.notes,
    планПитания: d.foodPlan,
    вес: d.weight,
    привычки: d.habits.map(h => h.title).sort(),
  };
};

test('своя выгрузка восстанавливается целиком и без дублей', async () => {
  const s = await loggedIn();
  try {
    await наполнить(s);
    const было = await слепок(s);
    const выгрузка = await getJson(s.url, s.cookie, '/api/v1/export');

    // восстановление поверх существующих данных в режиме замены
    const r = await api(s.url, s.cookie, 'POST', '/api/v1/import',
      { data: выгрузка, mode: 'replace' }, {}, true);
    assert.strictEqual(r.status, 200, `восстановление прошло (${r.status})`);

    const стало = await слепок(s);
    assert.deepStrictEqual(стало.расписание, было.расписание, 'расписание совпадает');
    assert.deepStrictEqual(стало.задачи, было.задачи, 'задачи совпадают');
    assert.deepStrictEqual(стало.питание, было.питание, 'питание совпадает');
    assert.deepStrictEqual(стало.спорт, было.спорт, 'тренировка совпадает');
    assert.deepStrictEqual(стало.привычки, было.привычки, 'привычки совпадают');
    assert.strictEqual(стало.заметка, было.заметка, 'заметка на месте');
    assert.strictEqual(стало.вес, было.вес, 'вес на месте');
    assert.strictEqual(стало.планПитания, было.планПитания, 'план питания на месте');
  } finally { await s.close(); }
});

test('повторное восстановление той же выгрузки ничего не задваивает', async () => {
  const s = await loggedIn();
  try {
    await наполнить(s);
    const выгрузка = await getJson(s.url, s.cookie, '/api/v1/export');
    await api(s.url, s.cookie, 'POST', '/api/v1/import', { data: выгрузка, mode: 'replace' });
    const первое = await слепок(s);
    await api(s.url, s.cookie, 'POST', '/api/v1/import', { data: выгрузка, mode: 'replace' });
    const второе = await слепок(s);
    assert.deepStrictEqual(второе, первое, 'второй прогон дал тот же день');

    // и в режиме добавления свои же данные не удваиваются
    await api(s.url, s.cookie, 'POST', '/api/v1/import', { data: выгрузка, mode: 'merge' });
    const третье = await слепок(s);
    assert.deepStrictEqual(третье.привычки, первое.привычки, 'привычки не задвоились');
    assert.deepStrictEqual(третье.расписание, первое.расписание, 'расписание не задвоилось');
  } finally { await s.close(); }
});
