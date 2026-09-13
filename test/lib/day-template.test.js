/**
 * Разбор заполненного шаблона дня.
 *
 * Смысл механики — ничего не потерять и ничего не выдумать. Человек пишет
 * день по образцу, который приложение само предложило; каждая строка должна
 * доехать до своего места, а граммы в составе обеда — остаться граммами.
 * Модель на этом тексте сбивалась и съедала разделы целиком, поэтому здесь
 * проверяется именно то, что тогда пропало.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { looksLikeTemplate, parseDayTemplate } = require('../../server/lib/dayTemplate');

const DATE = '2026-09-15';

const ПОЛНЫЙ = `День: ${DATE}

Расписание:
09:00–09:10 — Подъём, вода, туалет [будильник]
09:10–09:30 — Душ, зубы, заправить кровать
09:50–10:20 — Завтрак [еда]
10:20–13:00 — Основной рабочий блок [работа]
21:45–22:30 — Прогулка 40–45 минут [спорт]
23:59 — Сон [напоминание]

Питание:
Завтрак 09:50–10:20 — 2–4 яйца; овсянка 50–70 г сухого; овощи 200–300 г; чай без сахара ~700 ккал
Обед 14:30–15:00 — гречка/рис 70–80 г сухого; мясо 200–250 г; овощи 200–300 г ~800 ккал
Ужин 19:00–19:30 — гречка/рис 60–80 г сухого; мясо 200–250 г; овощи 200–300 г ~750 ккал

Задачи:
- работа: разобрать почту
- дом: купить хлеб и молоко

Привычки:
- Вода 8 стаканов, каждый день
- Зарядка, по будням

Заметки:
- Купить билеты до конца недели`;

const видов = items => items.reduce((acc, it) => {
  acc[it.kind] = (acc[it.kind] ?? 0) + 1;
  return acc;
}, {});

test('шаблон узнаётся по заголовкам, а живая речь — нет', () => {
  assert.equal(looksLikeTemplate(ПОЛНЫЙ), true);
  assert.equal(looksLikeTemplate('завтра в девять созвон с командой, потом купить хлеб'), false);
  // одного заголовка мало: так человек мог просто начать предложение
  assert.equal(looksLikeTemplate('Расписание:\n09:00 подъём'), false);
});

test('день разбирается целиком, ни один раздел не теряется', () => {
  const { items, date } = parseDayTemplate(ПОЛНЫЙ, { date: '2026-01-01' });
  assert.equal(date, DATE, 'дата берётся из строки «День», а не из открытого дня');
  assert.deepEqual(видов(items), { schedule: 5, reminder: 1, meal: 3, task: 2, habit: 2, note: 1 });
  assert.ok(items.every(i => i.date === DATE), 'у каждого пункта своя дата проставлена');
});

test('строка расписания: время, название, вид блока и сигнал', () => {
  const { items } = parseDayTemplate(ПОЛНЫЙ, { date: DATE });
  const подъём = items.find(i => i.title.startsWith('Подъём'));
  assert.equal(подъём.start, '09:00');
  assert.equal(подъём.end, '09:10');
  assert.equal(подъём.alarm, 'alarm', 'метка [будильник] — это звонок, а не уведомление');
  assert.equal(подъём.title, 'Подъём, вода, туалет', 'метка из названия убрана');

  assert.equal(items.find(i => i.title === 'Основной рабочий блок').block, 'work');
  assert.equal(items.find(i => i.title.startsWith('Прогулка')).block, 'sport');
  assert.equal(items.find(i => i.title === 'Завтрак' && i.kind === 'schedule').block, 'meal');

  const сон = items.find(i => i.title === 'Сон');
  assert.equal(сон.kind, 'reminder');
  assert.equal(сон.start, '23:59');
  assert.equal(сон.end, null, 'у момента конца нет по определению');
});

test('состав еды сохраняется дословно, с граммами и калориями', () => {
  const { items } = parseDayTemplate(ПОЛНЫЙ, { date: DATE });
  const meals = items.filter(i => i.kind === 'meal');
  assert.deepEqual(meals.map(m => m.slot), ['breakfast', 'lunch', 'dinner']);

  const обед = meals[1];
  assert.equal(обед.title, 'Обед');
  assert.equal(обед.start, '14:30');
  assert.equal(обед.end, '15:00');
  assert.equal(обед.kcal, 800);
  assert.equal(обед.details, 'гречка/рис 70–80 г сухого; мясо 200–250 г; овощи 200–300 г',
    'ни один грамм не потерян и калории из состава вычищены');
  assert.equal(meals[0].details.includes('2–4 яйца'), true);
});

test('задачи попадают в свои разделы', () => {
  const { items } = parseDayTemplate(ПОЛНЫЙ, { date: DATE });
  const tasks = items.filter(i => i.kind === 'task');
  assert.deepEqual(tasks.map(t => [t.category, t.title]), [
    ['work', 'разобрать почту'],
    ['home', 'купить хлеб и молоко'],
  ]);
});

test('двоеточие внутри задачи не принимается за раздел', () => {
  const { items } = parseDayTemplate('Задачи:\n- Позвонить: уточнить сроки\nЗаметки:\n- всё', { date: DATE });
  const task = items.find(i => i.kind === 'task');
  assert.equal(task.title, 'Позвонить: уточнить сроки');
});

test('привычки: как часто, и хвост не попадает в название', () => {
  const { items } = parseDayTemplate(ПОЛНЫЙ, { date: DATE });
  const habits = items.filter(i => i.kind === 'habit');
  assert.deepEqual(habits.map(h => [h.title, h.days]), [
    ['Вода 8 стаканов', 'daily'],
    ['Зарядка', 'weekdays'],
  ]);
});

test('дата словами и «завтра» тоже понятны', () => {
  const словами = parseDayTemplate('День: 20 сентября\nЗадачи:\n- раз\nЗаметки:\n- два', { date: '2026-09-15' });
  assert.equal(словами.date, '2026-09-20');
  const завтра = parseDayTemplate('День: завтра\nЗадачи:\n- раз\nЗаметки:\n- два', { date: '2026-09-15' });
  assert.equal(завтра.date, '2026-09-16');
});

test('без строки «День» берётся открытый день', () => {
  const { date, items } = parseDayTemplate('Задачи:\n- раз\nЗаметки:\n- два', { date: '2026-03-07' });
  assert.equal(date, '2026-03-07');
  assert.ok(items.every(i => i.date === '2026-03-07'));
});

test('дефисы, точки во времени и разные тире — всё это одно и то же', () => {
  const { items } = parseDayTemplate(
    'Расписание:\n9.00-9.30 - Зарядка [спорт]\n10:00 — Звонок [напоминание]\nЗадачи:\n- раз',
    { date: DATE });
  const зарядка = items.find(i => i.title === 'Зарядка');
  assert.equal(зарядка.start, '09:00');
  assert.equal(зарядка.end, '09:30');
  assert.equal(зарядка.block, 'sport');
  assert.equal(items.find(i => i.title === 'Звонок').kind, 'reminder');
});

test('пустые строки и мусор между разделами ничего не ломают', () => {
  const { items } = parseDayTemplate(
    `Расписание:\n\n  \n09:00–10:00 — Дело\n\nЗадачи:\n\n- одна\n\nЗаметки:\n`,
    { date: DATE });
  assert.deepEqual(видов(items), { schedule: 1, task: 1 });
});
