/**
 * Правка → запрос. Отдельный модуль, потому что это единственное место, где
 * знание об адресах API встречается с очередью: ошибку здесь видно только
 * на живом сервере, а так — обычным тестом.
 */

const test = require('node:test');
const assert = require('node:assert');

const оп = (вид, поля) => ({ id: 'op-9', at: 1, вид, дата: '2026-09-19', ...поля });

test('создание строки: POST в раздел дня с ключом идемпотентности', async () => {
  const { запрос } = await import('../../public/js/web/ops.js');
  const r = запрос(оп('строка.создать',
    { цель: 'tmp-1', данные: { раздел: 'tasks', поля: { text: 'хлеб' } } }));
  assert.strictEqual(r.метод, 'POST');
  assert.strictEqual(r.путь, '/days/2026-09-19/tasks');
  assert.deepStrictEqual(r.тело, { text: 'хлеб' });
  assert.strictEqual(r.ключ, 'op-9', 'ключ идемпотентности — сам номер правки');
});

test('изменение и удаление строки адресуются по id', async () => {
  const { запрос } = await import('../../public/js/web/ops.js');
  assert.deepStrictEqual(
    запрос(оп('строка.изменить', { цель: 12, данные: { раздел: 'schedule', поля: { done: true } } })),
    { метод: 'PATCH', путь: '/days/2026-09-19/schedule/12', тело: { done: true } });
  assert.deepStrictEqual(
    запрос(оп('строка.удалить', { цель: 12, данные: { раздел: 'meals' } })),
    { метод: 'DELETE', путь: '/days/2026-09-19/meals/12' });
});

test('привычка: отметка ставится PUT, снимается DELETE', async () => {
  const { запрос } = await import('../../public/js/web/ops.js');
  assert.deepStrictEqual(
    запрос(оп('привычка.отметить', { цель: 3, данные: { дата: '2026-09-19', статус: 'done' } })),
    { метод: 'PUT', путь: '/habits/3/log/2026-09-19', тело: { status: 'done' } });
  assert.deepStrictEqual(
    запрос(оп('привычка.отметить', { цель: 3, данные: { дата: '2026-09-19', статус: null } })),
    { метод: 'DELETE', путь: '/habits/3/log/2026-09-19' });
});

test('поля дня везут ревизию: сервер требует If-Match', async () => {
  const { запрос } = await import('../../public/js/web/ops.js');
  const r = запрос(оп('день.поля', { цель: null, данные: { поля: { notes: 'а' }, rev: 7 } }));
  assert.strictEqual(r.метод, 'PATCH');
  assert.strictEqual(r.путь, '/days/2026-09-19');
  assert.strictEqual(r.ревизия, 7);
});

test('настройки уходят одним PATCH под ключом settings', async () => {
  const { запрос } = await import('../../public/js/web/ops.js');
  assert.deepStrictEqual(
    запрос(оп('настройки', { цель: null, данные: { поля: { theme: 'dark' } } })),
    { метод: 'PATCH', путь: '/settings', тело: { settings: { theme: 'dark' } } });
});

test('незнакомый вид — исключение, а не тихая отправка не туда', async () => {
  const { запрос } = await import('../../public/js/web/ops.js');
  assert.throws(() => запрос(оп('чепуха', {})), /Неизвестный вид правки/);
});

test('временный id отличается от настоящего', async () => {
  const { временный } = await import('../../public/js/web/ops.js');
  assert.strictEqual(временный('tmp-t7x-1'), true);
  assert.strictEqual(временный(17), false);
  assert.strictEqual(временный(null), false);
});

test('настройки: поля человека и свободные переключатели уезжают вместе', async () => {
  const { запрос } = await import('../../public/js/web/ops.js');
  const профиль = запрос({
    вид: 'настройки', дата: '2026-09-25', цель: null, данные: { профиль: { theme: 'dark' } },
  });
  assert.strictEqual(профиль.путь, '/settings');
  assert.deepStrictEqual(профиль.тело, { theme: 'dark' },
    'тема — поле человека, а не запись в мешке настроек');

  const переключатель = запрос({
    вид: 'настройки', дата: '2026-09-25', цель: null, данные: { поля: { accent: 'green' } },
  });
  assert.deepStrictEqual(переключатель.тело, { settings: { accent: 'green' } });

  const оба = запрос({
    вид: 'настройки', дата: '2026-09-25', цель: null,
    данные: { профиль: { weekStart: 7 }, поля: { accent: 'red' } },
  });
  assert.deepStrictEqual(оба.тело, { weekStart: 7, settings: { accent: 'red' } });
});
