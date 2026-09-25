/**
 * Правка дня без сети: на экране сразу, на сервере — когда получится.
 *
 * Тест идёт через настоящий store и настоящий api.js, подменяя только
 * `fetch`: именно на стыке этих двух модулей раньше и терялись правки.
 */

const test = require('node:test');
const assert = require('node:assert');

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

const ДЕНЬ = {
  date: '2026-09-19', rev: 2, notes: '', weight: null, foodPlan: '',
  schedule: [], tasks: { work: [], home: [] }, meals: [], sport: [],
  habits: [{ id: 4, title: 'Вода', status: null }], progress: {}, habitsStreak: 0,
};

/** Подменённый fetch: либо «нет связи», либо заданный ответ. */
function сеть() {
  const вызовы = [];
  let связь = true;
  let следующий = null;
  globalThis.fetch = async (url, opts = {}) => {
    вызовы.push({
      url: String(url),
      метод: opts.method ?? 'GET',
      тело: opts.body ? JSON.parse(opts.body) : null,
      заголовки: opts.headers ?? {},
    });
    if (!связь) throw new TypeError('Failed to fetch');
    const тело = следующий ?? {};
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => тело,
    };
  };
  return {
    вызовы,
    обрыв() { связь = false; },
    починить(ответ = {}) { связь = true; следующий = ответ; },
  };
}

/*
 * Модули берём без добавки к адресу — те же самые, что подключает store.js.
 * Со «свежим» адресом получились бы две разные очереди: счётчик сходился бы
 * (он в хранилище), а отправкой управляла бы не та.
 *
 * Состояние между тестами сбрасываем руками: новое хранилище, пустая
 * очередь, свой день. Автоповтор выключаем — прогоном в тестах управляем
 * сами, иначе отложенная попытка выстрелит посреди соседнего теста.
 */
async function стенд() {
  globalThis.localStorage = хранилище();
  const data = await import('../../public/js/web/store.js');
  const q = await import('../../public/js/outbox.js');
  q.настроить({ автоповтор: false });
  q.очистить();
  data.store.day = structuredClone(ДЕНЬ);
  return { data, q };
}

test('задача видна сразу и без связи', async () => {
  const { data, q } = await стенд();
  const с = сеть();
  с.обрыв();
  data.createTask('2026-09-19', { text: 'хлеб', bucket: 'home' });
  assert.strictEqual(data.store.day.tasks.home.length, 1, 'на экране уже есть');
  assert.ok(String(data.store.day.tasks.home[0].id).startsWith('tmp-'), 'пока с временным номером');
  assert.strictEqual(q.ожидает(), 1, 'и лежит в очереди');
});

test('вернулась связь — правка уехала и получила настоящий номер', async () => {
  const { data, q } = await стенд();
  const с = сеть();
  с.обрыв();
  data.createTask('2026-09-19', { text: 'хлеб', bucket: 'home' });
  с.починить({ id: 77, text: 'хлеб', bucket: 'home', done: 0 });
  data.запуститьОчередь();
  await q.отправить();
  assert.strictEqual(q.ожидает(), 0);
  assert.strictEqual(data.store.day.tasks.home[0].id, 77, 'номер подставился в местную копию');
  const последний = с.вызовы.at(-1);
  assert.match(последний.url, /\/days\/2026-09-19\/tasks$/);
  assert.strictEqual(последний.метод, 'POST');
  assert.ok(последний.заголовки['Idempotency-Key'], 'ключ повтора на месте');
});

test('загрузка дня не съедает правку, которая ещё в очереди', async () => {
  const { data } = await стенд();
  const с = сеть();
  с.обрыв();
  data.createTask('2026-09-19', { text: 'хлеб', bucket: 'home' });
  // сервер отвечает днём, в котором этой задачи ещё нет
  с.починить(structuredClone(ДЕНЬ));
  await data.loadDay('2026-09-19');
  assert.strictEqual(data.store.day.tasks.home.length, 1,
    'неуехавшая правка пережила перечитывание дня');
});

test('отметка привычки без связи остаётся на экране', async () => {
  const { data, q } = await стенд();
  const с = сеть();
  с.обрыв();
  data.toggleHabit({ id: 4, status: null }, true);
  assert.strictEqual(data.store.day.habits[0].status, 'done');
  assert.strictEqual(q.ожидает(), 1);
});

test('отвергнутая сервером правка уходит с экрана, а не остаётся висеть', async () => {
  const { data, q } = await стенд();
  const с = сеть();
  // сервер отвечает отказом на правку и целым днём на перечитывание
  let первый = true;
  globalThis.fetch = async (url, opts = {}) => {
    const метод = opts.method ?? 'GET';
    if (метод === 'POST' && первый) {
      первый = false;
      return {
        ok: false, status: 400,
        headers: { get: () => 'application/json' },
        json: async () => ({ error: { code: 'BAD_REQUEST', message: 'Не приняли' } }),
      };
    }
    return {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => structuredClone(ДЕНЬ),
    };
  };
  data.createTask('2026-09-19', { text: 'не примут', bucket: 'home' });
  assert.strictEqual(data.store.day.tasks.home.length, 1, 'сперва видна');
  data.запуститьОчередь();
  await q.отправить();
  await new Promise(r => setTimeout(r, 50));   // перечитывание дня идёт следом
  assert.strictEqual(data.store.day.tasks.home.length, 0, 'после отказа с экрана ушла');
  assert.strictEqual(q.конфликты().length, 1, 'и человеку есть что показать');
  assert.strictEqual(с.вызовы.length >= 0, true);
});

test('список заметок не показывает старый текст, пока правка заметки в пути', async () => {
  const { data } = await стенд();
  const с = сеть();
  с.обрыв();
  data.saveDayNote('2026-09-19', 'Сервис ноутбука\nСпросить про сроки');
  // сервер ещё не получил правку и отдаёт прежнюю заметку дня
  с.починить([{ id: '2026-09-19', date: '2026-09-19', title: 'Позвонить в сервис', text: '', updated_at: null }]);
  await data.loadNotes();
  const н = data.store.notes.find(x => x.date === '2026-09-19');
  assert.strictEqual(н?.title, 'Сервис ноутбука', 'в списке — то, что человек только что сохранил');
  assert.strictEqual(н?.text, 'Спросить про сроки');
});

test('день без копии открывается пустым, и правка в нём видна', async () => {
  const { data, q } = await стенд();
  const с = сеть();
  с.обрыв();
  /*
   * Человек листает на день, которого на устройстве ещё нет: связи нет,
   * копии нет. Раньше загрузка просто падала, в store.day оставался прежний
   * день — и добавленная задача не появлялась на экране вовсе. Она уезжала
   * на сервер потом, но человек-то видел, что «ничего не произошло».
   */
  await data.loadDay('2026-09-26').catch(() => {});
  assert.strictEqual(data.store.day?.date, '2026-09-26', 'на экране именно этот день');
  assert.deepStrictEqual(data.store.day.tasks, { work: [], home: [] }, 'и он пустой');

  data.createTask('2026-09-26', { text: 'из метро', bucket: 'home' });
  assert.strictEqual(data.store.day.tasks.home.length, 1, 'правка видна сразу');
  assert.strictEqual(q.ожидает(), 1, 'и лежит в очереди');
});

test('о каждой правке сообщают подписчику: экран перерисуется сам', async () => {
  const { data } = await стенд();
  сеть().обрыв();
  let вестей = 0;
  data.подписаться(() => { вестей += 1; });
  data.createTask('2026-09-19', { text: 'хлеб' });
  assert.ok(вестей >= 1, 'экран узнал о правке');
});
