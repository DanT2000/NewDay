/**
 * Наложение ещё не уехавшей правки на день.
 *
 * Это половина главного правила: на экране — последний ответ сервера плюс
 * очередь. Если наложение врёт, человек увидит одно, а сервер получит
 * другое, и заметит он это уже расхождением.
 */

const test = require('node:test');
const assert = require('node:assert');

const день = () => ({
  date: '2026-09-19', rev: 3, notes: '', weight: null, foodPlan: '',
  schedule: [{ id: 5, start_min: 540, end_min: 600, title: 'Подъём', done: 0 }],
  tasks: { work: [{ id: 11, text: 'отчёт', done: 0, bucket: 'work' }], home: [] },
  meals: [], sport: [],
  habits: [{ id: 2, title: 'Вода', status: null }],
});

const оп = (вид, поля) => ({ id: 'op-1', at: 1, вид, дата: '2026-09-19', попытки: 0, ...поля });

test('создание строки появляется в своём разделе с временным id', async () => {
  const { наложить } = await import('../../public/js/web/apply.js');
  const было = день();
  const стало = наложить(было, оп('строка.создать',
    { цель: 'tmp-1', данные: { раздел: 'tasks', поля: { text: 'хлеб', bucket: 'home' } } }));
  assert.strictEqual(стало.tasks.home.length, 1, 'задача попала в свою корзину');
  assert.strictEqual(стало.tasks.home[0].id, 'tmp-1');
  assert.strictEqual(стало.tasks.home[0].text, 'хлеб');
  assert.strictEqual(стало.tasks.home[0].done, 0, 'у новой задачи есть значения по умолчанию');
  assert.strictEqual(было.tasks.home.length, 0, 'исходный день не тронут');
});

test('имена полей приводятся к виду строки дня', async () => {
  const { наложить } = await import('../../public/js/web/apply.js');
  const стало = наложить(день(), оп('строка.создать', {
    цель: 'tmp-2',
    данные: {
      раздел: 'schedule',
      поля: { title: 'Обед', startMin: 720, endMin: 780, remindBefore: [15, 0], done: true },
    },
  }));
  const r = стало.schedule.at(-1);
  assert.strictEqual(r.start_min, 720);
  assert.strictEqual(r.end_min, 780);
  assert.strictEqual(r.remind_before_json, '[15,0]', 'напоминания хранятся текстом JSON');
  assert.strictEqual(r.done, 1, 'флажок в строке — число');
});

test('изменение и удаление находят строку по id', async () => {
  const { наложить } = await import('../../public/js/web/apply.js');
  const после = наложить(день(), оп('строка.изменить',
    { цель: 11, данные: { раздел: 'tasks', поля: { done: true } } }));
  assert.strictEqual(после.tasks.work[0].done, 1);

  const без = наложить(день(), оп('строка.удалить', { цель: 5, данные: { раздел: 'schedule' } }));
  assert.strictEqual(без.schedule.length, 0);
});

test('отметка привычки меняет статус только в своём дне', async () => {
  const { наложить } = await import('../../public/js/web/apply.js');
  const свой = наложить(день(), оп('привычка.отметить',
    { цель: 2, данные: { дата: '2026-09-19', статус: 'done' } }));
  assert.strictEqual(свой.habits[0].status, 'done');

  const чужой = наложить(день(), оп('привычка.отметить',
    { цель: 2, дата: '2026-09-18', данные: { дата: '2026-09-18', статус: 'done' } }));
  assert.strictEqual(чужой.habits[0].status, null, 'вчерашняя отметка сегодняшний день не красит');
});

test('поля дня ложатся прямо в день, настройки его не трогают', async () => {
  const { наложить } = await import('../../public/js/web/apply.js');
  const с = наложить(день(), оп('день.поля',
    { цель: null, данные: { поля: { notes: 'купить хлеб', weight: 72.5 } } }));
  assert.strictEqual(с.notes, 'купить хлеб');
  assert.strictEqual(с.weight, 72.5);

  const без = наложить(день(), оп('настройки', { цель: null, данные: { поля: { theme: 'dark' } } }));
  assert.deepStrictEqual(без, день(), 'настройки — не про день');
});

test('несколько правок подряд дают тот же результат, что и по очереди', async () => {
  const { наложитьВсе } = await import('../../public/js/web/apply.js');
  const ops = [
    оп('строка.создать', { id: 'op-1', цель: 'tmp-1', данные: { раздел: 'tasks', поля: { text: 'хлеб', bucket: 'home' } } }),
    оп('строка.изменить', { id: 'op-2', цель: 'tmp-1', данные: { раздел: 'tasks', поля: { done: true } } }),
    оп('строка.удалить', { id: 'op-3', цель: 11, данные: { раздел: 'tasks' } }),
  ];
  const стало = наложитьВсе(день(), ops);
  assert.strictEqual(стало.tasks.work.length, 0, 'старая задача удалена');
  assert.strictEqual(стало.tasks.home[0].done, 1, 'новая задача создана и отмечена');
});

test('день без данных наложение переживает', async () => {
  const { наложить, наложитьВсе } = await import('../../public/js/web/apply.js');
  assert.strictEqual(наложить(null, оп('день.поля', { данные: { поля: { notes: 'а' } } })), null);
  assert.strictEqual(наложитьВсе(null, []), null);
});
