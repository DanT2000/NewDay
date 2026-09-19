/**
 * Очередь правок: порядок, живучесть и отсутствие дублей.
 *
 * Это единственное место, где правка человека существует сама по себе, без
 * сервера. Потерять её здесь — значит потерять молча: человек уже увидел,
 * что дело отмечено.
 */

const test = require('node:test');
const assert = require('node:assert');

/** Хранилище как в браузере, но своё: node не даёт localStorage по умолчанию. */
function хранилище() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    key: i => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}

/** Свежий модуль на каждый тест: у очереди есть своё состояние в памяти. */
async function свежая() {
  globalThis.localStorage = хранилище();
  return import(`../../public/js/outbox.js?${Math.random()}`);
}

const правка = (вид = 'строка.изменить', цель = 1) =>
  ({ вид, дата: '2026-09-19', цель, данные: { раздел: 'tasks', поля: { done: true } } });

test('правки уезжают по одной и в том порядке, в котором их сделали', async () => {
  const q = await свежая();
  const ушли = [];
  q.настроить({ отправитель: async оп => { ушли.push(оп.цель); return { id: оп.цель }; }, автоповтор: false });
  q.добавить(правка('строка.изменить', 1));
  q.добавить(правка('строка.изменить', 2));
  q.добавить(правка('строка.изменить', 3));
  assert.strictEqual(q.ожидает(), 3);
  await q.отправить();
  assert.deepStrictEqual(ушли, [1, 2, 3]);
  assert.strictEqual(q.ожидает(), 0);
});

test('нет связи — очередь стоит целиком и ничего не теряет', async () => {
  const q = await свежая();
  let звали = 0;
  q.настроить({
    отправитель: async () => { звали += 1; throw { status: 0, code: 'NETWORK', message: 'Нет связи' }; },
    автоповтор: false,
  });
  q.добавить(правка('строка.изменить', 1));
  q.добавить(правка('строка.изменить', 2));
  await q.отправить();
  assert.strictEqual(звали, 1, 'вторую не пробовали: порядок важнее');
  assert.strictEqual(q.ожидает(), 2);
  assert.strictEqual(q.конфликты().length, 0, 'отсутствие связи — не конфликт');
});

test('очередь переживает перезапуск приложения', async () => {
  const q = await свежая();
  q.настроить({ отправитель: async () => ({}), автоповтор: false });
  q.добавить(правка());
  const сохранённое = globalThis.localStorage.getItem('newday.outbox.v1');
  assert.ok(сохранённое?.includes('строка.изменить'), 'правка лежит в хранилище');

  // «перезапуск»: тот же localStorage, заново загруженный модуль
  const второй = await import(`../../public/js/outbox.js?${Math.random()}`);
  assert.strictEqual(второй.ожидает(), 1);
});

test('отказ сервера уводит правку в «не доехали», остальные едут дальше', async () => {
  const q = await свежая();
  const ушли = [];
  q.настроить({
    отправитель: async оп => {
      if (оп.цель === 1) throw { status: 404, code: 'NOT_FOUND', message: 'Запись не найдена' };
      ушли.push(оп.цель); return {};
    },
    автоповтор: false,
  });
  q.добавить(правка('строка.изменить', 1));
  q.добавить(правка('строка.изменить', 2));
  await q.отправить();
  assert.deepStrictEqual(ушли, [2], 'вторая правка не заложница первой');
  assert.strictEqual(q.ожидает(), 0);
  assert.strictEqual(q.конфликты().length, 1);
  assert.strictEqual(q.конфликты()[0].ошибка, 'Запись не найдена');
});

test('удаление того, чего уже нет, — не конфликт', async () => {
  const q = await свежая();
  q.настроить({
    отправитель: async () => { throw { status: 404, code: 'NOT_FOUND', message: 'Запись не найдена' }; },
    автоповтор: false,
  });
  q.добавить({ вид: 'строка.удалить', дата: '2026-09-19', цель: 7, данные: { раздел: 'tasks' } });
  await q.отправить();
  assert.strictEqual(q.ожидает(), 0);
  assert.strictEqual(q.конфликты().length, 0, 'цель достигнута: записи нет');
});

test('сбой сервера повторяется трижды, потом уходит в «не доехали»', async () => {
  const q = await свежая();
  let звали = 0;
  q.настроить({
    отправитель: async () => { звали += 1; throw { status: 500, code: 'ERROR', message: 'Сервер упал' }; },
    автоповтор: false,
  });
  q.добавить(правка());
  await q.отправить();
  await q.отправить();
  assert.strictEqual(q.ожидает(), 1, 'после двух попыток правка ещё в очереди');
  await q.отправить();
  assert.strictEqual(звали, 3);
  assert.strictEqual(q.ожидает(), 0);
  assert.strictEqual(q.конфликты().length, 1);
});

test('настоящий id подставляется во все правки той же строки', async () => {
  const q = await свежая();
  const пути = [];
  q.настроить({
    отправитель: async оп => { пути.push(оп.цель); return { id: 42 }; },
    автоповтор: false,
  });
  const tmp = q.новыйId();
  const замены = [];
  q.подписаться(с => { if (с.вид === 'подстановка') замены.push(с); });
  q.добавить({ вид: 'строка.создать', дата: '2026-09-19', цель: tmp, данные: { раздел: 'tasks', поля: { text: 'хлеб' } } });
  q.добавить({ вид: 'строка.изменить', дата: '2026-09-19', цель: tmp, данные: { раздел: 'tasks', поля: { done: true } } });
  await q.отправить();
  assert.deepStrictEqual(пути, [tmp, 42], 'вторая правка уехала уже с настоящим id');
  assert.deepStrictEqual(замены, [{ вид: 'подстановка', было: tmp, стало: 42 }]);
});

test('настоящий id подставляется и в ссылки внутри полей', async () => {
  const q = await свежая();
  const тела = [];
  q.настроить({
    отправитель: async оп => { тела.push(оп.данные.поля); return { id: 9 }; },
    автоповтор: false,
  });
  const блок = q.новыйId();
  q.добавить({ вид: 'строка.создать', дата: '2026-09-19', цель: блок, данные: { раздел: 'schedule', поля: { title: 'Обед' } } });
  // приём пищи помнит свой блок расписания полем, а не адресом правки
  q.добавить({ вид: 'строка.изменить', дата: '2026-09-19', цель: 3, данные: { раздел: 'meals', поля: { scheduleItemId: блок } } });
  await q.отправить();
  assert.strictEqual(тела[1].scheduleItemId, 9, 'на сервер уехал настоящий номер блока');
});

test('401 останавливает отправку и ничего не выбрасывает', async () => {
  const q = await свежая();
  q.настроить({
    отправитель: async () => { throw { status: 401, code: 'UNAUTHORIZED', message: 'Требуется вход' }; },
    автоповтор: false,
  });
  q.добавить(правка());
  await q.отправить();
  assert.strictEqual(q.ожидает(), 1, 'правка дождётся входа');
  assert.strictEqual(q.конфликты().length, 0);
});

test('очередь не растёт без предела', async () => {
  const q = await свежая();
  q.настроить({ отправитель: async () => ({}), автоповтор: false });
  for (let i = 0; i < 500; i++) q.добавить(правка('строка.изменить', i));
  assert.strictEqual(q.ожидает(), 500);
  assert.throws(() => q.добавить(правка()), /слишком много/i);
});

test('вторая вкладка не отправляет то же самое одновременно', async () => {
  const q = await свежая();
  // чужая вкладка держит аренду
  globalThis.localStorage.setItem('newday.outbox.lock',
    JSON.stringify({ tab: 'другая', until: Date.now() + 20000 }));
  let звали = 0;
  q.настроить({ отправитель: async () => { звали += 1; return {}; }, автоповтор: false });
  q.добавить(правка());
  await q.отправить();
  assert.strictEqual(звали, 0, 'пока аренда чужая — не лезем');
  assert.strictEqual(q.ожидает(), 1);

  // аренда протухла — можно
  globalThis.localStorage.setItem('newday.outbox.lock',
    JSON.stringify({ tab: 'другая', until: Date.now() - 1 }));
  await q.отправить();
  assert.strictEqual(звали, 1);
});

test('«повторить» возвращает правку из «не доехали» в очередь', async () => {
  const q = await свежая();
  let падать = true;
  q.настроить({
    отправитель: async () => {
      if (падать) throw { status: 409, code: 'REV_MISMATCH', message: 'День изменён в другом месте' };
      return {};
    },
    автоповтор: false,
  });
  q.добавить(правка());
  await q.отправить();
  assert.strictEqual(q.конфликты().length, 1);

  падать = false;
  q.повторить(q.конфликты()[0].id);
  assert.strictEqual(q.ожидает(), 1);
  assert.strictEqual(q.конфликты().length, 0);
  await q.отправить();
  assert.strictEqual(q.ожидает(), 0);
});
