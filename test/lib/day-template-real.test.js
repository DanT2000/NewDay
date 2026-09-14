/**
 * Настоящий день, присланный человеком, — а не образец из приложения.
 *
 * Образец пишет тот, кто писал разбор, и он поневоле пишет так, как разбор
 * умеет. Живой текст другой: поля разделены длинными тире, повторы вилкой
 * «3×8–12», вес словами «свой вес», калории вилкой «~450–600», строки без
 * дефисов, примечание прямо посреди тренировки и «Итого» посреди питания.
 * Первый же такой день дал на сервере пять привычек-дублей с тире на конце,
 * упражнения с «–12 — свой вес» в названии и «~450–» в составе завтрака.
 * Здесь проверяется ровно то, что тогда пошло не так.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { looksLikeTemplate, parseDayTemplate } = require('../../server/lib/dayTemplate');

const ТЕКСТ = fs.readFileSync(path.join(__dirname, '../fixtures/day-template-real.txt'), 'utf8');
const { items, date } = parseDayTemplate(ТЕКСТ, { date: '2026-09-14' });
const вида = kind => items.filter(i => i.kind === kind);

test('живой текст узнаётся как шаблон, и дата берётся из него', () => {
  assert.equal(looksLikeTemplate(ТЕКСТ), true);
  assert.equal(date, '2026-09-15');
});

test('всё расписание на месте, «Сон» — точка', () => {
  assert.equal(вида('schedule').length, 19);
  const сон = вида('reminder');
  assert.equal(сон.length, 1);
  assert.equal(сон[0].title, 'Сон');
  assert.equal(вида('schedule').find(r => r.title === 'Тренировка').block, 'sport');
});

test('упражнения: чистые названия, вилка повторов, «свой вес» — это без веса', () => {
  assert.deepEqual(вида('sport').map(x => [x.title, x.sets, x.reps, x.repsMax, x.weight]), [
    ['Отжимания от стены', 3, 8, 12, null],
    ['Вставания со стула', 3, 5, 8, null],
    ['Сгибание рук с гантелями', 3, 10, 15, 3],
    ['Жим гантелей вверх сидя', 3, 8, 12, 1.5],
  ]);
});

test('примечание посреди тренировки — заметка, а не пятое упражнение', () => {
  const notes = вида('note');
  assert.equal(notes.length, 1);
  assert.match(notes[0].details, /Отдых между подходами — 60–90 секунд/);
  assert.match(notes[0].details, /вставания со стула прекращаешь/);
});

test('еда: состав без хвоста калорий, калории — верх вилки', () => {
  const meals = вида('meal');
  assert.deepEqual(meals.map(m => [m.slot, m.kcal]), [['breakfast', 600], ['lunch', 800], ['dinner', 750]]);
  for (const m of meals) {
    assert.doesNotMatch(m.details, /ккал|~|[–—-]\s*$/, `в составе «${m.title}» остался хвост: ${m.details}`);
  }
  assert.equal(meals[0].details,
    '2–4 яйца; овсянка/геркулес 50–70 г сухого; помидоры/огурцы 200–300 г; чай/кофе без сахара');
});

test('«Итого» посреди питания уходит в план питания дня', () => {
  const plan = вида('foodPlan');
  assert.equal(plan.length, 1);
  assert.equal(plan[0].details, 'Итого: примерно 1700–2150 ккал без большого количества масла.');
});

test('задачи без дефисов разбираются так же, как с ними', () => {
  const tasks = вида('task');
  assert.equal(tasks.length, 4);
  assert.ok(tasks.every(t => t.category === 'work'));
  assert.equal(tasks[0].title, 'Агрофарм — разобраться с текущим состоянием проекта',
    'тире внутри задачи — часть её текста, а не разделитель');
});

test('привычки: без тире на конце, «Не курить» — отказ, а не дело', () => {
  assert.deepEqual(вида('habit').map(h => [h.title, h.days, h.polarity]), [
    ['Не курить', 'daily', 'avoid'],
    ['Душ', 'daily', 'do'],
    ['Чтение Библии', 'daily', 'do'],
    ['Прогулка', 'daily', 'do'],
    ['Питание по плану', 'daily', 'do'],
  ]);
});

test('итог по видам — ничего не потеряно и ничего не выдумано', () => {
  const счёт = {};
  for (const i of items) счёт[i.kind] = (счёт[i.kind] ?? 0) + 1;
  assert.deepEqual(счёт, {
    schedule: 19, reminder: 1, meal: 3, foodPlan: 1, sport: 4, note: 1, task: 4, habit: 5,
  });
});
