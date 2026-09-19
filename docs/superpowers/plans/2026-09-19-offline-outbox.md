# Местная копия дня и очередь правок — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Цель:** правка дня применяется на устройстве мгновенно и уезжает на сервер
фоном — в том числе после того, как связь вернулась.

**Устройство:** то, что на экране, — последний ответ сервера плюс ещё не
уехавшие правки, наложенные по порядку. Наложение (`apply.js`) и описание
запроса (`ops.js`) — чистые функции; очередь (`outbox.js`) хранит правки в
localStorage и отправляет их строго по одной; `store.js` связывает это с
экраном, `app.js` перестаёт ждать сеть. На сервере — ключ идемпотентности,
чтобы повтор создания не сделал вторую строку.

**Технологии:** те же, что в проекте. Клиент — ESM без сборщика
(`public/js/**`), сервер — Express 4 + better-sqlite3, тесты — встроенный
`node:test` в CommonJS. Новых зависимостей нет.

**Спецификация:** [docs/superpowers/specs/2026-09-19-offline-outbox-design.md](../specs/2026-09-19-offline-outbox-design.md)

## Общие требования

Действуют в каждой задаче:

- Комментарии и имена — по-русски, как во всём проекте. Комментарий
  объясняет «почему так», а не пересказывает код.
- Клиентские модули — ESM (`export`), тесты — CommonJS и подключают их
  через динамический `await import(...)`. Поэтому модули не должны трогать
  `localStorage`, `fetch` и DOM на верхнем уровне — только внутри функций.
- Новых зависимостей не добавлять.
- Имена полей строки дня — ровно как в `FIELD_MAP` репозиториев
  (`server/repos/schedule.js`, `tasks.js`, `meals.js`, `sport.js`):
  `start_min`, `end_min`, `time_min`, `remind_before_json`, `reps_max`,
  `schedule_item_id`, `carried_from`. Флажок `done` в строке — `1`/`0`.
- `remindBefore` сервер хранит текстом JSON (`entities.js:82`), значит и
  местная строка хранит его строкой.
- Прогон: `npm test`. Перед ним срабатывает `pretest`, который сверяет
  штамп service worker: после правки любого файла в `public/` нужен
  `node tools/stamp-sw.mjs`, иначе прогон не начнётся.
- Каждая задача заканчивается коммитом. Сообщение по-русски, в конце строка
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Ничего из существующих проверок не отключать и не ослаблять.

---

### Задача 1: наложение правки на день

Чистая функция, из которой растёт всё остальное: пока её нет, очередь
некуда применять.

**Файлы:**
- Создать: `public/js/web/apply.js`
- Тест: `test/web/apply.test.js`

**Интерфейсы:**
- Отдаёт наружу: `наложить(день, оп) → день` (новый объект, исходный не
  меняется), `наложитьВсе(день, ops) → день`, `вСтроку(поля) → объект с
  именами колонок`, `РАЗДЕЛЫ = ['schedule','tasks','meals','sport']`.
- Вид операции (им пользуются задачи 2, 3, 5):

```js
{
  id: 'op-abc123',        // он же ключ идемпотентности
  at: 1758270000000,
  вид: 'строка.создать' | 'строка.изменить' | 'строка.удалить'
     | 'привычка.отметить' | 'день.поля' | 'настройки',
  дата: '2026-09-19',
  цель: 'tmp-t7x-1' | 17 | null,   // id строки или привычки
  данные: { раздел, поля } | { дата, статус } | { поля } | { поля, rev },
  попытки: 0,
  ошибка: null,
}
```

- [ ] **Шаг 1: написать падающий тест**

Создать `test/web/apply.test.js`:

```js
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
    данные: { раздел: 'schedule', поля: { title: 'Обед', startMin: 720, endMin: 780, remindBefore: [15, 0], done: true } },
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
  const с = наложить(день(), оп('день.поля', { цель: null, данные: { поля: { notes: 'купить хлеб', weight: 72.5 } } }));
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
```

- [ ] **Шаг 2: прогнать тест и убедиться, что он падает**

Команда: `node --test test/web/apply.test.js`
Ожидаем: падение с «Cannot find module .../public/js/web/apply.js».

- [ ] **Шаг 3: написать модуль**

Создать `public/js/web/apply.js`:

```js
/**
 * Наложение ещё не уехавшей правки на день.
 *
 * Правило одно: на экране — последний ответ сервера плюс правки из очереди,
 * наложенные по порядку. Здесь вторая половина этого правила, и только она:
 * ни сети, ни хранилища, ни DOM. Функция чистая, её зовут заново после
 * каждой загрузки дня — поэтому накопиться ошибке негде.
 */

/** Разделы дня со строками. Имя раздела — оно же кусок адреса API. */
export const РАЗДЕЛЫ = ['schedule', 'tasks', 'meals', 'sport'];

/*
 * Сервер принимает camelCase, а в строке дня лежат имена колонок. Карта
 * повторяет FIELD_MAP репозиториев (server/repos/*.js): пока правка не
 * уехала, строка обязана выглядеть ровно так же, как будущий ответ сервера,
 * иначе после отправки она на экране дёрнется.
 */
const В_КОЛОНКУ = {
  startMin: 'start_min', endMin: 'end_min', timeMin: 'time_min',
  alarmMode: 'alarm_mode', alarmProfile: 'alarm_profile',
  remindBeforeMin: 'remind_before_min', remindBefore: 'remind_before_json',
  scheduleItemId: 'schedule_item_id', seriesId: 'series_id',
  sortOrder: 'sort_order', carriedFrom: 'carried_from', repsMax: 'reps_max',
  externalId: 'external_id', lastModifiedBy: 'last_modified_by',
};

/** Поля, которые сервер хранит текстом JSON. */
const ТЕКСТОМ = new Set(['remindBefore']);
/** Флажки: в API это true/false, в строке — 1/0. */
const ФЛАЖКИ = new Set(['done']);

/** Тело запроса → поля строки дня. */
export function вСтроку(поля) {
  const out = {};
  for (const [k, знач] of Object.entries(поля ?? {})) {
    const имя = В_КОЛОНКУ[k] ?? k;
    if (ТЕКСТОМ.has(k)) {
      out[имя] = Array.isArray(знач) && знач.length ? JSON.stringify(знач) : null;
    } else if (ФЛАЖКИ.has(k)) {
      out[имя] = знач ? 1 : 0;
    } else {
      out[имя] = знач;
    }
  }
  return out;
}

/*
 * Чего сервер дописывает сам при создании. Без этого новая строка приходит
 * на экран без `done` и без `kind`, и разметка спотыкается о undefined ещё
 * до того, как правка уехала.
 */
const ЗАГОТОВКА = {
  schedule: {
    start_min: 0, end_min: null, title: '', note: '', done: 0, kind: 'normal',
    alarm_mode: 'none', alarm_profile: 'gentle', remind_before_json: null,
    remind_before_min: null, series_id: null, color: null,
  },
  tasks: { bucket: 'work', text: '', done: 0, carried_from: null },
  meals: {
    slot: 'other', time_min: null, end_min: null, title: '', note: '',
    calories: null, done: 0, schedule_item_id: null, remind_before_json: null,
  },
  sport: { exercise: '', sets: null, reps: null, reps_max: null, weight: null, done: 0 },
};

/** Строки раздела одним списком: задачи лежат по двум корзинам. */
const строки = (день, раздел) => (раздел === 'tasks'
  ? [...(день.tasks?.work ?? []), ...(день.tasks?.home ?? [])]
  : (день[раздел] ?? []));

/** Положить список обратно — задачи разложив по корзинам. */
function записать(день, раздел, список) {
  if (раздел !== 'tasks') { день[раздел] = список; return; }
  день.tasks = {
    work: список.filter(t => (t.bucket ?? 'work') === 'work'),
    home: список.filter(t => (t.bucket ?? 'work') !== 'work'),
  };
}

/** Сравнение id: временный — строка, настоящий — число. */
const тот = (a, b) => String(a) === String(b);

export function наложить(день, оп) {
  if (!день || !оп) return день;
  const d = structuredClone(день);
  const раздел = оп.данные?.раздел;
  switch (оп.вид) {
    case 'строка.создать':
      записать(d, раздел, [...строки(d, раздел),
        { ...ЗАГОТОВКА[раздел], ...вСтроку(оп.данные.поля), id: оп.цель }]);
      break;
    case 'строка.изменить':
      записать(d, раздел, строки(d, раздел)
        .map(r => (тот(r.id, оп.цель) ? { ...r, ...вСтроку(оп.данные.поля) } : r)));
      break;
    case 'строка.удалить':
      записать(d, раздел, строки(d, раздел).filter(r => !тот(r.id, оп.цель)));
      break;
    case 'привычка.отметить':
      // отметка за другую дату к этому дню отношения не имеет
      if (оп.данные.дата !== d.date) break;
      d.habits = (d.habits ?? []).map(h => (тот(h.id, оп.цель)
        ? { ...h, status: оп.данные.статус } : h));
      break;
    case 'день.поля':
      if (оп.дата === d.date) Object.assign(d, оп.данные.поля);
      break;
    default:
      break;   // настройки и всё незнакомое день не меняют
  }
  return d;
}

export const наложитьВсе = (день, ops) =>
  (ops ?? []).reduce((d, оп) => наложить(d, оп), день);
```

- [ ] **Шаг 4: прогнать тест и убедиться, что он проходит**

Команда: `node --test test/web/apply.test.js`
Ожидаем: 7 тестов пройдено.

- [ ] **Шаг 5: коммит**

```bash
git add public/js/web/apply.js test/web/apply.test.js
git commit -m "Наложение неуехавшей правки на день"
```

---

### Задача 2: описание запроса по правке

**Файлы:**
- Создать: `public/js/web/ops.js`
- Тест: `test/web/ops.test.js`

**Интерфейсы:**
- Потребляет: вид операции из задачи 1.
- Отдаёт: `запрос(оп) → { метод, путь, тело?, ключ?, ревизия? }`,
  `временный(id) → boolean`.
  `ключ` — значение заголовка `Idempotency-Key` (только у создания);
  `ревизия` — что положить в `If-Match` (только у полей дня).

- [ ] **Шаг 1: написать падающий тест**

Создать `test/web/ops.test.js`:

```js
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
```

- [ ] **Шаг 2: прогнать тест и убедиться, что он падает**

Команда: `node --test test/web/ops.test.js`
Ожидаем: падение с «Cannot find module .../public/js/web/ops.js».

- [ ] **Шаг 3: написать модуль**

Создать `public/js/web/ops.js`:

```js
/**
 * Правка из очереди → запрос к API.
 *
 * Отдельно от очереди, потому что очередь не должна знать адресов, и
 * отдельно от api.js, потому что это знание нужно проверять тестом, а не
 * живым сервером.
 */

/** Строка, которую ещё не создали на сервере, носит временный id. */
export const временный = id => typeof id === 'string' && id.startsWith('tmp-');

export function запрос(оп) {
  const { дата, цель, данные = {} } = оп;
  switch (оп.вид) {
    case 'строка.создать':
      /*
       * Ключ идемпотентности — номер самой правки. Ответ мог потеряться по
       * дороге, а повтор без ключа сделал бы вторую строку: человек увидел
       * бы две одинаковые задачи и не понял, откуда.
       */
      return { метод: 'POST', путь: `/days/${дата}/${данные.раздел}`, тело: данные.поля, ключ: оп.id };
    case 'строка.изменить':
      return { метод: 'PATCH', путь: `/days/${дата}/${данные.раздел}/${цель}`, тело: данные.поля };
    case 'строка.удалить':
      return { метод: 'DELETE', путь: `/days/${дата}/${данные.раздел}/${цель}` };
    case 'привычка.отметить':
      return данные.статус
        ? { метод: 'PUT', путь: `/habits/${цель}/log/${данные.дата}`, тело: { status: данные.статус } }
        : { метод: 'DELETE', путь: `/habits/${цель}/log/${данные.дата}` };
    case 'день.поля':
      /*
       * День требует If-Match. Везём ту ревизию, которая была в момент
       * правки: обычно она и окажется верной, а если нет — api.withRev
       * перечитает день и повторит один раз, и побеждает тот, кто позже.
       */
      return { метод: 'PATCH', путь: `/days/${дата}`, тело: данные.поля, ревизия: данные.rev ?? 0 };
    case 'настройки':
      return { метод: 'PATCH', путь: '/settings', тело: { settings: данные.поля } };
    default:
      throw new Error(`Неизвестный вид правки: ${оп.вид}`);
  }
}
```

- [ ] **Шаг 4: прогнать тест и убедиться, что он проходит**

Команда: `node --test test/web/ops.test.js`
Ожидаем: 7 тестов пройдено.

- [ ] **Шаг 5: коммит**

```bash
git add public/js/web/ops.js test/web/ops.test.js
git commit -m "Правка из очереди превращается в запрос"
```

---

### Задача 3: очередь правок

**Файлы:**
- Создать: `public/js/outbox.js`
- Тест: `test/web/outbox.test.js`

**Интерфейсы:**
- Потребляет: вид операции (задача 1), `временный` (задача 2).
- Отдаёт:
  - `настроить({ отправитель, автоповтор = true })` — `отправитель(оп)`
    возвращает промис с ответом сервера либо бросает ошибку вида
    `{ status, code, message }` (это `ApiError` из `api.js`);
  - `добавить({ вид, дата, цель, данные }) → оп` (сам проставит `id` и `at`);
  - `новыйId() → 'tmp-…'` — временный id для создаваемой строки;
  - `список() → оп[]`, `ожидает() → number`, `конфликты() → оп[]`;
  - `отправить() → Promise<void>` — прогнать очередь;
  - `подписаться(fn) → отписаться`; `fn({ вид, оп, ответ })`, где `вид` —
    `'счёт'` (число правок изменилось), `'подстановка'`
    (`{ было, стало }` — временный id заменён настоящим), `'конфликт'`;
  - `забыть(id)`, `повторить(id)` — для шторки «не доехали»;
  - `очистить()` — при выходе из аккаунта.

- [ ] **Шаг 1: написать падающий тест**

Создать `test/web/outbox.test.js`:

```js
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
    _map: map,
  };
}

/** Свежий модуль на каждый тест: у очереди есть своё состояние в памяти. */
async function свежая() {
  globalThis.localStorage = хранилище();
  const мод = await import(`../../public/js/outbox.js?${Math.random()}`);
  return мод;
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
```

- [ ] **Шаг 2: прогнать тест и убедиться, что он падает**

Команда: `node --test test/web/outbox.test.js`
Ожидаем: падение с «Cannot find module .../public/js/outbox.js».

- [ ] **Шаг 3: написать модуль**

Создать `public/js/outbox.js`:

```js
/**
 * Очередь правок, которые ещё не уехали на сервер.
 *
 * Приложение больше не ждёт сеть: правка применяется на устройстве и
 * ложится сюда, а отсюда уезжает сама — когда получится. Поэтому у очереди
 * две обязанности, и обе важнее скорости: ничего не потерять и ничего не
 * задвоить.
 *
 * Хранится в localStorage: правка обязана пережить и закрытие приложения, и
 * перезагрузку страницы. Читается синхронно, потому что счётчик в шапке
 * нужен до первой отрисовки.
 */

import { временный } from './web/ops.js';

const КЛЮЧ = 'newday.outbox.v1';
const КЛЮЧ_БЕДА = 'newday.outbox.bad.v1';
const КЛЮЧ_ЗАМОК = 'newday.outbox.lock';

/** Дольше этого одна вкладка очередь не держит: вдруг её усыпили посреди прогона. */
const АРЕНДА_МС = 20000;
/** Больше пятисот неотправленных — это не «нет связи», это беда посерьёзнее. */
const ПРЕДЕЛ = 500;
/** Сбой сервера бывает мгновенным; три попытки отделяют его от настоящей поломки. */
const ПОПЫТОК = 3;
const ПАУЗЫ = [2000, 4000, 8000, 15000, 30000, 60000];

const вкладка = `t${Math.random().toString(36).slice(2, 7)}`;
let счётчик = 0;
let отправитель = null;
let автоповтор = true;
let идёт = false;
let таймер = null;
let пауза = 0;
const слушатели = new Set();

// ── Хранилище ────────────────────────────────────────────────

/*
 * Любое обращение к localStorage обёрнуто: в приватном режиме оно бросает,
 * а очередь, падающая от режима браузера, хуже очереди без памяти.
 */
function прочитать(ключ) {
  try {
    const raw = globalThis.localStorage?.getItem(ключ);
    const val = raw ? JSON.parse(raw) : null;
    return Array.isArray(val?.ops) ? val.ops : [];
  } catch { return []; }
}

function записать(ключ, ops) {
  try { globalThis.localStorage?.setItem(ключ, JSON.stringify({ v: 1, ops })); }
  catch { /* переполнение: правка останется только в памяти этой вкладки */ }
}

const очередь = () => прочитать(КЛЮЧ);
const беды = () => прочитать(КЛЮЧ_БЕДА);

// ── Наружу ───────────────────────────────────────────────────

export function настроить(opts = {}) {
  if (opts.отправитель) отправитель = opts.отправитель;
  if (opts.автоповтор !== undefined) автоповтор = opts.автоповтор;
}

export const список = () => очередь();
export const ожидает = () => очередь().length;
export const конфликты = () => беды();

export function подписаться(fn) {
  слушатели.add(fn);
  return () => слушатели.delete(fn);
}

function сообщить(весть) {
  for (const fn of слушатели) {
    try { fn(весть); } catch { /* слушатель не должен ронять очередь */ }
  }
}

/** Временный id новой строки. Вкладка в имени — чтобы две не совпали. */
export const новыйId = () => `tmp-${вкладка}-${++счётчик}`;

export function добавить(правка) {
  const ops = очередь();
  if (ops.length >= ПРЕДЕЛ) {
    throw new Error('Накопилось слишком много несохранённых правок — нужна связь с сервером');
  }
  const оп = {
    id: `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    попытки: 0,
    ошибка: null,
    ...правка,
  };
  записать(КЛЮЧ, [...ops, оп]);
  сообщить({ вид: 'счёт' });
  if (автоповтор) отправить();
  return оп;
}

export function забыть(id) {
  записать(КЛЮЧ_БЕДА, беды().filter(о => о.id !== id));
  сообщить({ вид: 'счёт' });
}

export function повторить(id) {
  const оп = беды().find(о => о.id === id);
  if (!оп) return;
  записать(КЛЮЧ_БЕДА, беды().filter(о => о.id !== id));
  записать(КЛЮЧ, [...очередь(), { ...оп, попытки: 0, ошибка: null }]);
  сообщить({ вид: 'счёт' });
  if (автоповтор) отправить();
}

export function очистить() {
  записать(КЛЮЧ, []);
  записать(КЛЮЧ_БЕДА, []);
  сообщить({ вид: 'счёт' });
}

// ── Замок между вкладками ────────────────────────────────────

/*
 * Очередь общая на все вкладки, а отправлять её должна одна. Аренда с
 * временем жизни, а не «занято/свободно»: вкладку могли усыпить или закрыть
 * посреди прогона, и вечный замок остановил бы синхронизацию навсегда.
 */
function взятьЗамок() {
  try {
    const raw = globalThis.localStorage?.getItem(КЛЮЧ_ЗАМОК);
    const замок = raw ? JSON.parse(raw) : null;
    if (замок && замок.tab !== вкладка && замок.until > Date.now()) return false;
    globalThis.localStorage?.setItem(КЛЮЧ_ЗАМОК,
      JSON.stringify({ tab: вкладка, until: Date.now() + АРЕНДА_МС }));
    return true;
  } catch { return true; }   // нет хранилища — значит, вкладка и так одна
}

function отдатьЗамок() {
  try {
    const raw = globalThis.localStorage?.getItem(КЛЮЧ_ЗАМОК);
    if (raw && JSON.parse(raw).tab === вкладка) globalThis.localStorage.removeItem(КЛЮЧ_ЗАМОК);
  } catch { /* уже некому отдавать */ }
}

// ── Отправка ─────────────────────────────────────────────────

function снять(id) {
  записать(КЛЮЧ, очередь().filter(о => о.id !== id));
}

function вБеду(оп, ошибка) {
  записать(КЛЮЧ_БЕДА, [...беды(), { ...оп, ошибка: ошибка?.message || 'Не сохранилось' }]);
  сообщить({ вид: 'конфликт', оп });
}

/** Настоящий id вместо временного — и в очереди, и у того, кто слушает. */
function подставить(было, стало) {
  записать(КЛЮЧ, очередь().map(о => (String(о.цель) === String(было) ? { ...о, цель: стало } : о)));
  сообщить({ вид: 'подстановка', было, стало });
}

function позже() {
  if (!автоповтор) return;
  clearTimeout(таймер);
  const мс = ПАУЗЫ[Math.min(пауза, ПАУЗЫ.length - 1)];
  пауза += 1;
  таймер = setTimeout(() => отправить(), мс);
  таймер?.unref?.();
}

export async function отправить() {
  if (идёт || !отправитель) return;
  if (!очередь().length) { пауза = 0; return; }
  if (!взятьЗамок()) return;
  идёт = true;
  try {
    for (;;) {
      // перечитываем каждый раз: соседняя вкладка могла что-то добавить
      const оп = очередь()[0];
      if (!оп) { пауза = 0; break; }
      взятьЗамок();                     // продлеваем аренду на длинной очереди
      let ответ;
      try {
        ответ = await отправитель(оп);
      } catch (e) {
        const код = e?.status ?? 0;
        // связи нет — стоим целиком: порядок правок дороже скорости
        if (код === 0 || e?.code === 'NETWORK') { позже(); break; }
        // вход разберёт api.js; очередь ждёт, а не теряет
        if (код === 401) break;
        // удалять то, чего нет, не нужно: цель достигнута
        if (код === 404 && оп.вид === 'строка.удалить') { снять(оп.id); continue; }
        if (код >= 500) {
          const попытки = (оп.попытки ?? 0) + 1;
          if (попытки < ПОПЫТОК) {
            записать(КЛЮЧ, очередь().map(о => (о.id === оп.id ? { ...о, попытки, ошибка: e?.message ?? null } : о)));
            позже();
            break;
          }
          вБеду({ ...оп, попытки }, e);
          снять(оп.id);
          continue;
        }
        вБеду(оп, e);                   // 4xx: сервер отказал по существу
        снять(оп.id);
        continue;
      }
      снять(оп.id);
      пауза = 0;
      if (оп.вид === 'строка.создать' && временный(оп.цель) && ответ?.id) подставить(оп.цель, ответ.id);
      сообщить({ вид: 'уехала', оп, ответ });
    }
  } finally {
    идёт = false;
    отдатьЗамок();
    сообщить({ вид: 'счёт' });
  }
}
```

- [ ] **Шаг 4: прогнать тест и убедиться, что он проходит**

Команда: `node --test test/web/outbox.test.js`
Ожидаем: 11 тестов пройдено.

- [ ] **Шаг 5: коммит**

```bash
git add public/js/outbox.js test/web/outbox.test.js
git commit -m "Очередь правок на устройстве"
```

---

### Задача 4: ключ идемпотентности на сервере

Без него повтор потерянного создания делает вторую строку — и это
единственный способ получить дубли при офлайн-работе.

**Файлы:**
- Создать: `server/db/migrations/015-op-keys.js`
- Создать: `server/lib/idempotency.js`
- Изменить: `server/db/migrations/index.js:15` (добавить миграцию в список)
- Изменить: `server/routes/v1/_entityRouter.js:22-25` (POST создания)
- Изменить: `server/index.js:80-84` (уборка старых ключей)
- Тест: `test/api/idempotency.test.js`

**Интерфейсы:**
- Отдаёт: `opKeys(db)` → `{ повтор(userId, key), запомнить(userId, key, status, body), убратьСтарые(часов) }`.

- [ ] **Шаг 1: написать падающий тест**

Создать `test/api/idempotency.test.js`:

```js
/**
 * Повтор создания не делает вторую строку.
 *
 * Офлайн-очередь повторяет запрос, когда не дождалась ответа, — а ответ мог
 * и потеряться уже после того, как сервер всё записал. Без ключа человек
 * получил бы две одинаковые задачи и не понял, откуда.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, today } = require('../helpers/client');

test('два создания с одним ключом дают одну строку и один ответ', async () => {
  const s = await loggedIn();
  try {
    const D = today();
    const h = { 'Idempotency-Key': 'op-abc-123' };
    const первый = await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/tasks`, { text: 'хлеб' }, h);
    const второй = await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/tasks`, { text: 'хлеб' }, h);
    assert.strictEqual(второй.id, первый.id, 'ответ тот же самый');
    const день = await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`);
    const свои = [...день.tasks.work, ...день.tasks.home].filter(t => t.text === 'хлеб');
    assert.strictEqual(свои.length, 1, 'строка одна');
  } finally { await s.close(); }
});

test('разные ключи создают разные строки', async () => {
  const s = await loggedIn();
  try {
    const D = today();
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/tasks`, { text: 'молоко' }, { 'Idempotency-Key': 'op-1' });
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/tasks`, { text: 'молоко' }, { 'Idempotency-Key': 'op-2' });
    const день = await getJson(s.url, s.cookie, `/api/v1/days/${D}/full`);
    const свои = [...день.tasks.work, ...день.tasks.home].filter(t => t.text === 'молоко');
    assert.strictEqual(свои.length, 2);
  } finally { await s.close(); }
});

test('ключ живёт внутри аккаунта, а не на весь сервер', async () => {
  const первый = await loggedIn();
  // тот же сервер и та же база: иначе ключи просто не встретятся
  const второй = await loggedIn({ server: первый.srv, email: 'other@example.com' });
  try {
    const D = today();
    const h = { 'Idempotency-Key': 'op-общий' };
    await api(первый.url, первый.cookie, 'POST', `/api/v1/days/${D}/tasks`, { text: 'моё' }, h);
    const чужой = await api(второй.url, второй.cookie, 'POST', `/api/v1/days/${D}/tasks`, { text: 'чужое' }, h, true);
    assert.strictEqual(чужой.status, 201, 'чужой ключ не мешает');
    const день = await getJson(второй.url, второй.cookie, `/api/v1/days/${D}/full`);
    const свои = [...день.tasks.work, ...день.tasks.home];
    assert.strictEqual(свои.length, 1);
    assert.strictEqual(свои[0].text, 'чужое');
  } finally { await первый.close(); }
});

test('создание без ключа работает по-прежнему', async () => {
  const s = await loggedIn();
  try {
    const D = today();
    const r = await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/tasks`, { text: 'без ключа' }, {}, true);
    assert.strictEqual(r.status, 201);
  } finally { await s.close(); }
});

test('слишком длинный ключ отвергается, а не пишется в базу', async () => {
  const s = await loggedIn();
  try {
    const D = today();
    const r = await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/tasks`,
      { text: 'длинный ключ' }, { 'Idempotency-Key': 'x'.repeat(200) }, true);
    assert.strictEqual(r.status, 400);
  } finally { await s.close(); }
});
```

Примечание для исполнителя: посмотрите сигнатуру `loggedIn`/`api` в
`test/helpers/client.js` — второй аккаунт заводится так же, как в
`test/api/access-and-cleanup.test.js`. Если `loggedIn` не принимает почту,
используйте тот способ, каким второй пользователь заводится там.

- [ ] **Шаг 2: прогнать тест и убедиться, что он падает**

Команда: `node --test test/api/idempotency.test.js`
Ожидаем: падение первого теста — вторая строка создалась, `свои.length === 2`.

- [ ] **Шаг 3: миграция**

Создать `server/db/migrations/015-op-keys.js`:

```js
/**
 * Ключи повторных запросов.
 *
 * Приложение больше не ждёт ответа сервера: правка ложится в очередь на
 * устройстве и уезжает сама. Значит, случится и такое — сервер записал, а
 * ответ не доехал. Очередь повторит запрос, и без ключа в дне появится
 * вторая такая же строка.
 *
 * Только для создания: PATCH с готовыми значениями и DELETE безопасны сами
 * по себе. Ключ хранится вместе с ответом, чтобы повтор получил ровно то
 * же, что и первый запрос, — включая номер созданной строки.
 */

module.exports = {
  version: 15,
  name: 'op-keys',
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS op_keys (
      user_id    INTEGER NOT NULL,
      key        TEXT    NOT NULL,
      status     INTEGER NOT NULL,
      body       TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, key)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_op_keys_created ON op_keys(created_at)');
  },
};
```

В `server/db/migrations/index.js` добавить в список после строки
`require('./014-sport-reps-range'),`:

```js
  require('./015-op-keys'),
```

- [ ] **Шаг 4: модуль ключей**

Создать `server/lib/idempotency.js`:

```js
const { badRequest } = require('./errors');

/** Дольше суток повтор не приходит: очередь на устройстве живёт часами, не днями. */
const ХРАНИТЬ_ЧАСОВ = 24;
const МАКС_ДЛИНА = 100;

/**
 * Ключ повторного запроса.
 *
 * Хранится вместе с ответом: повтор обязан получить то же самое, включая
 * номер созданной записи, — иначе очередь на устройстве не сможет заменить
 * временный id настоящим.
 */
function opKeys(db) {
  return {
    /** Проверка и приведение заголовка. Пусто — значит, ключа нет. */
    ключИз(raw) {
      if (raw === undefined || raw === null || raw === '') return null;
      const key = String(raw).trim();
      if (!key) return null;
      if (key.length > МАКС_ДЛИНА) throw badRequest(`Слишком длинный Idempotency-Key: максимум ${МАКС_ДЛИНА}`);
      if (!/^[\w.:-]+$/.test(key)) throw badRequest('Idempotency-Key: допустимы буквы, цифры, «-», «_», «.» и «:»');
      return key;
    },

    повтор(userId, key) {
      const row = db.prepare('SELECT status, body FROM op_keys WHERE user_id = ? AND key = ?').get(userId, key);
      if (!row) return null;
      try { return { status: row.status, body: row.body ? JSON.parse(row.body) : null }; }
      catch { return null; }
    },

    запомнить(userId, key, status, body) {
      db.prepare(`INSERT INTO op_keys (user_id, key, status, body) VALUES (?, ?, ?, ?)
                  ON CONFLICT(user_id, key) DO NOTHING`)
        .run(userId, key, status, body === undefined ? null : JSON.stringify(body));
    },

    убратьСтарые(часов = ХРАНИТЬ_ЧАСОВ) {
      return db.prepare(`DELETE FROM op_keys WHERE created_at < datetime('now', ?)`)
        .run(`-${Number(часов) || ХРАНИТЬ_ЧАСОВ} hours`).changes;
    },
  };
}

module.exports = { opKeys, ХРАНИТЬ_ЧАСОВ };
```

- [ ] **Шаг 5: подключить к созданию строк**

В `server/routes/v1/_entityRouter.js` добавить к импортам:

```js
const { opKeys } = require('../../lib/idempotency');
```

внутри `entityRouter({ db, ... })` рядом с `const repo = repoFor(db);`:

```js
  const ключи = opKeys(db);
```

и заменить обработчик создания (сейчас `_entityRouter.js:22-25`):

```js
  router.post('/', wrap((req, res) => {
    /*
     * Повтор создания не должен делать вторую строку: очередь на устройстве
     * повторяет запрос, когда не дождалась ответа, — а ответ мог потеряться
     * уже после записи.
     */
    const ключ = ключи.ключИз(req.get('idempotency-key'));
    const был = ключ && ключи.повтор(req.user.id, ключ);
    if (был) { res.status(был.status).json(был.body); return; }
    const row = repo.create(req.user.id, dateOf(req), sanitize(req.body, { partial: false }));
    if (ключ) ключи.запомнить(req.user.id, ключ, 201, row);
    res.status(201).json(row);
  }));
```

- [ ] **Шаг 6: уборка старых ключей**

В `server/index.js`, рядом с `purgeBlocked` (после строки
`const purgeTimer = setInterval(purgeBlocked, 24 * 60 * 60 * 1000);`
и до неё — см. как оформлен `purgeBlocked`), добавить:

```js
/**
 * Ключи повторных запросов живут сутки: дольше повтор не приходит, а
 * таблица без уборки растёт с каждой созданной строкой.
 */
const purgeOpKeys = () => {
  try { require('./lib/idempotency').opKeys(app.locals.db).убратьСтарые(); }
  catch (e) { console.error('[newday] уборка ключей повторов:', e.message); }
};
purgeOpKeys();
const opKeysTimer = setInterval(purgeOpKeys, 60 * 60 * 1000);
opKeysTimer.unref?.();
```

Если `app.locals.db` в `server/index.js` называется иначе, взять тот способ
доступа к базе, каким пользуется соседний `app.locals.userCleanup`.

- [ ] **Шаг 7: прогнать тесты**

Команда: `node --test test/api/idempotency.test.js test/db/migrations-idempotent.test.js test/api/days.test.js`
Ожидаем: всё зелёное. Если `migrations-idempotent` ругается — миграция 015
должна переживать повторный проход (в ней для этого `IF NOT EXISTS`).

- [ ] **Шаг 8: коммит**

```bash
git add server/db/migrations/015-op-keys.js server/db/migrations/index.js \
        server/lib/idempotency.js server/routes/v1/_entityRouter.js \
        server/index.js test/api/idempotency.test.js
git commit -m "Повтор создания не делает вторую строку"
```

---

### Задача 5: правки дня идут через очередь

**Файлы:**
- Изменить: `public/js/web/store.js` (раздел «Правки», `loadDay`, `forgetLocal`)
- Тест: `test/web/store-offline.test.js`

**Интерфейсы:**
- Потребляет: `apply.наложить/наложитьВсе` (задача 1), `ops.запрос` (задача 2),
  `outbox.*` (задача 3), `api.*`.
- Отдаёт наружу (ими пользуется `app.js` в задаче 6):
  - прежние имена правок сохраняются: `toggleTask(task, done)`,
    `toggleScheduleRow`, `toggleMeal`, `toggleSport`, `toggleHabit`,
    `createTask(date, body)`, `updateTask(date, id, body)`,
    `removeTask(date, id)`, те же тройки для `Row`, `Meal`, `Sport`,
    `saveDayNote(date, text)`, `saveDayField(date, patch)`,
    `saveSettings(patch)`. Все они теперь **синхронные**: возвращают
    созданную строку (у `create*`) или `undefined`, ничего не ждут и не
    бросают из-за сети;
  - `подписаться(fn) → отписаться` — зовут после каждой местной правки и
    после каждого изменения очереди;
  - `ожидает()` — сколько правок не уехало; `конфликты()`, `забыть(id)`,
    `повторить(id)` — проброшены из очереди;
  - `запуститьОчередь()` — подключить отправителя и прогнать очередь
    (зовётся один раз при старте).

- [ ] **Шаг 1: написать падающий тест**

Создать `test/web/store-offline.test.js`:

```js
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
    вызовы.push({ url: String(url), метод: opts.method ?? 'GET', тело: opts.body ? JSON.parse(opts.body) : null, заголовки: opts.headers ?? {} });
    if (!связь) throw new TypeError('Failed to fetch');
    const тело = следующий ?? {};
    return {
      ok: true, status: 200,
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

async function стенд() {
  globalThis.localStorage = хранилище();
  const соль = Math.random();
  const data = await import(`../../public/js/web/store.js?${соль}`);
  const q = await import(`../../public/js/outbox.js?${соль}`);
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

test('о каждой правке сообщают подписчику: экран перерисуется сам', async () => {
  const { data } = await стенд();
  сеть().обрыв();
  let вестей = 0;
  data.подписаться(() => { вестей += 1; });
  data.createTask('2026-09-19', { text: 'хлеб' });
  assert.ok(вестей >= 1, 'экран узнал о правке');
});
```

- [ ] **Шаг 2: прогнать тест и убедиться, что он падает**

Команда: `node --test test/web/store-offline.test.js`
Ожидаем: падение — `data.createTask` пока возвращает промис и без сети
ничего не меняет в `store.day`; `data.запуститьОчередь` не существует.

- [ ] **Шаг 3: переписать раздел «Правки» в store.js**

В начало `public/js/web/store.js` к импортам добавить:

```js
import * as очередь from '../outbox.js';
import { наложить, наложитьВсе } from './apply.js';
import { запрос } from './ops.js';
```

Заменить блок от комментария `// ── Правки ─────` и до конца файла на:

```js
// ── Правки ───────────────────────────────────────────────────

/*
 * Правка применяется на устройстве и ложится в очередь. Сеть в этот момент
 * никого не интересует: человек нажал — человек увидел. Отправкой занимается
 * очередь, и она же расскажет, если сервер откажет.
 */

const слушатели = new Set();
export function подписаться(fn) { слушатели.add(fn); return () => слушатели.delete(fn); }
function сообщить() {
  for (const fn of слушатели) { try { fn(); } catch { /* экран не должен ронять правку */ } }
}

/** Наложить правку на открытый день, сохранить копию и сказать экрану. */
function местно(оп) {
  if (store.day && store.day.date === оп.дата) {
    store.day = наложить(store.day, оп);
    keep(`day.${store.day.date}`, store.day);
  }
  сообщить();
}

/** Положить правку в очередь. Переполнение — единственная причина отказа. */
function вОчередь(правка) {
  try {
    const оп = очередь.добавить(правка);
    местно(оп);
    return оп;
  } catch (e) {
    сообщить();
    throw e;
  }
}

/*
 * Отправитель для очереди: превращает правку в запрос и зовёт api.
 * Заводится один раз при старте, чтобы очередь не знала ни про адреса, ни
 * про заголовки.
 */
export function запуститьОчередь() {
  очередь.настроить({
    отправитель: оп => {
      const r = запрос(оп);
      if (r.ревизия !== undefined) return api.withRev(r.метод, r.путь, r.тело, r.ревизия);
      const заголовки = r.ключ ? { 'Idempotency-Key': r.ключ } : undefined;
      if (r.метод === 'DELETE') return api.DELETE(r.путь, заголовки);
      if (r.метод === 'POST') return api.POST(r.путь, r.тело, заголовки);
      if (r.метод === 'PUT') return api.PUT(r.путь, r.тело, заголовки);
      return api.PATCH(r.путь, r.тело, заголовки);
    },
  });
  /*
   * Временный номер строки заменяется настоящим и в местной копии: иначе
   * следующая правка той же строки ушла бы в никуда, а на экране остался бы
   * «tmp-…», который не переживёт перечитывание дня.
   */
  очередь.подписаться(весть => {
    if (весть.вид === 'подстановка' && store.day) {
      store.day = подменитьId(store.day, весть.было, весть.стало);
      keep(`day.${store.day.date}`, store.day);
    }
    сообщить();
  });
  очередь.отправить();
}

/** Замена номера строки во всех разделах дня. */
function подменитьId(день, было, стало) {
  const d = structuredClone(день);
  const правь = список => (список ?? []).map(r => (String(r.id) === String(было) ? { ...r, id: стало } : r));
  d.schedule = правь(d.schedule);
  d.meals = правь(d.meals);
  d.sport = правь(d.sport);
  d.tasks = { work: правь(d.tasks?.work), home: правь(d.tasks?.home) };
  return d;
}

export const ожидает = () => очередь.ожидает();
export const конфликты = () => очередь.конфликты();
export const забыть = id => очередь.забыть(id);
export const повторитьПравку = id => очередь.повторить(id);
export const отправитьОчередь = () => очередь.отправить();

const dateOf = () => store.day?.date;

/** Строка раздела: общая обвязка для четырёх одинаковых троек. */
const разделСтрок = раздел => ({
  создать(дата, поля) {
    const цель = очередь.новыйId();
    вОчередь({ вид: 'строка.создать', дата, цель, данные: { раздел, поля } });
    return { id: цель };
  },
  изменить(дата, id, поля) {
    вОчередь({ вид: 'строка.изменить', дата, цель: id, данные: { раздел, поля } });
  },
  удалить(дата, id) {
    вОчередь({ вид: 'строка.удалить', дата, цель: id, данные: { раздел } });
  },
});

const строкиРасписания = разделСтрок('schedule');
const строкиЗадач = разделСтрок('tasks');
const строкиЕды = разделСтрок('meals');
const строкиСпорта = разделСтрок('sport');

export const createRow = (date, body) => строкиРасписания.создать(date, body);
export const updateRow = (date, id, body) => строкиРасписания.изменить(date, id, body);
export const removeRow = (date, id) => строкиРасписания.удалить(date, id);

export const createTask = (date, body) => строкиЗадач.создать(date, body);
export const updateTask = (date, id, body) => строкиЗадач.изменить(date, id, body);
export const removeTask = (date, id) => строкиЗадач.удалить(date, id);

export const createMeal = (date, body) => строкиЕды.создать(date, body);
export const updateMeal = (date, id, body) => строкиЕды.изменить(date, id, body);
export const removeMeal = (date, id) => строкиЕды.удалить(date, id);

export const createSport = (date, body) => строкиСпорта.создать(date, body);
export const updateSport = (date, id, body) => строкиСпорта.изменить(date, id, body);
export const removeSport = (date, id) => строкиСпорта.удалить(date, id);

export const toggleScheduleRow = (row, done) => строкиРасписания.изменить(dateOf(), row.id, { done });
export const toggleTask = (task, done) => строкиЗадач.изменить(dateOf(), task.id, { done });
export const toggleMeal = (meal, done) => строкиЕды.изменить(dateOf(), meal.id, { done });
export const toggleSport = (row, done) => строкиСпорта.изменить(dateOf(), row.id, { done });

/**
 * Привычка отмечается не полем `done`, а записью в журнале за дату: привычки
 * живут отдельно от дня и считают серии по этим записям.
 */
export function toggleHabit(habit, done) {
  const дата = dateOf();
  вОчередь({
    вид: 'привычка.отметить', дата, цель: habit.id,
    данные: { дата, статус: done ? 'done' : null },
  });
}

export const saveDayNote = (date, text) => saveDayField(date, { notes: text });

/** Поля самого дня: заметка, вес, план питания. Вложенные строки не трогает. */
export function saveDayField(date, patch) {
  вОчередь({
    вид: 'день.поля', дата: date, цель: null,
    данные: { поля: patch, rev: store.day?.date === date ? (store.day.rev ?? 0) : 0 },
  });
}

/** Настройки приложения: тема, акцент, масштаб, переключатели дня. */
export function saveSettings(patch) {
  if (store.settings) {
    store.settings.settings = { ...store.settings.settings, ...patch };
    keep('settings', store.settings);
  }
  вОчередь({ вид: 'настройки', дата: todayFor(store.settings?.timezone), цель: null, данные: { поля: patch } });
}

/*
 * Остальное требует связи и уходит на сервер сразу: повторы и шаблоны
 * достраивает сервер, привычки как сущности человек трогает редко. Класть
 * это в очередь значило бы повторять серверную логику на клиенте — и
 * заводить вторую правду.
 */
export const attachRow = (date, id, seriesId) => api.schedule.setSeries(date, id, seriesId);
export const detachRow = (date, id) => api.schedule.setSeries(date, id, null);
export const shiftRows = (date, fromId, minutes) => api.schedule.shift(date, fromId, minutes, true);
export const createFreeNote = body => api.POST('/notes', body);
export const updateFreeNote = (id, body) => api.PATCH(`/notes/${id}`, body);
export const removeFreeNote = id => api.DELETE(`/notes/${id}`);
export const createHabit = body => api.habits.create(body);
export const updateHabit = (id, body) => api.habits.update(id, body);
/*
 * Убираем в архив, а не стираем: журнал отметок — это история, и удалить её
 * вместе с привычкой значит переписать прошлое.
 */
export const removeHabit = id => api.habits.archive(id);
```

Функцию `optimistic` удалить: её работу делает очередь.

- [ ] **Шаг 4: проекция после загрузки дня**

В `loadDay` (`public/js/web/store.js`) обе ветки — и успех, и копия — должны
отдавать день с наложенной очередью. Заменить тело:

```js
export async function loadDay(date) {
  const gen = ++dayGen;
  /*
   * Наложить неуехавшие правки. Без этого ответ сервера, в котором правки
   * ещё нет, стирал бы её с экрана до тех пор, пока очередь не доедет:
   * человек видел бы, как только что отмеченное дело «отскакивает».
   */
  const сОчередью = день => наложитьВсе(день, очередь.список().filter(о => о.дата === date));
  try {
    const day = await api.getDay(date);
    keep(`day.${date}`, day);
    if (gen !== dayGen) return store.day;
    store.day = сОчередью(day);
    store.offline = false;
    return store.day;
  } catch (e) {
    if (e?.status === 401) throw e;
    const saved = kept(`day.${date}`);
    if (!saved) throw e;
    if (gen !== dayGen) return store.day;
    store.day = сОчередью(saved.value);
    store.offline = true;
    return store.day;
  }
}
```

В `keep(\`day.${date}\`, day)` кладём **ответ сервера**, а не проекцию:
местная копия — это последнее известное с сервера, очередь лежит отдельно и
накладывается заново при каждом чтении.

В `forgetLocal()` добавить строку `очередь.очистить();` — при выходе из
аккаунта чужие правки отправлять некуда и незачем.

- [ ] **Шаг 5: вписать новые модули в офлайн-кеш**

`public/service-worker.js` перечисляет каждый модуль поимённо (`SHELL`,
строки 10-35). Не вписать новые файлы — значит получить приложение, которое
не открывается без сети: ровно та беда, ради которой всё и делается.

В `public/service-worker.js:13` дописать к строке веб-версии:

```js
  '/js/web/app.js', '/js/web/store.js', '/js/web/adapt.js', '/js/web/data.js', '/js/web/sheet.js',
  '/js/web/apply.js', '/js/web/ops.js',
```

и в строку 24, к остальным общим модулям, — `'/js/outbox.js',`.

- [ ] **Шаг 6: прогнать тесты**

Команда: `node --test test/web/`
Ожидаем: все тесты задач 1, 2, 3, 5 зелёные.

Затем проверить, что офлайн-кеш полон:

```bash
node -e "const s=require('fs').readFileSync('public/service-worker.js','utf8'); for (const f of ['/js/outbox.js','/js/web/apply.js','/js/web/ops.js']) if(!s.includes(f)) { console.error('нет в SHELL:', f); process.exit(1); } console.log('все новые модули в офлайн-кеше');"
```

- [ ] **Шаг 7: коммит**

```bash
node tools/stamp-sw.mjs
git add public/js/web/store.js public/service-worker.js test/web/store-offline.test.js
git commit -m "Правки дня идут через очередь, а не через ожидание сети"
```

---

### Задача 6: экран не ждёт сеть

**Файлы:**
- Изменить: `public/js/web/app.js` — `toggle()` (≈400-430), `busy()` (≈4188),
  места правок дня (список ниже), полоса «Нет связи» (≈6970), запуск (конец файла)
- Изменить: `public/css/web.css` — стиль значка рядом с `.wnotice` (≈1816)
- Проверка: ручной прогон в браузере + задача 7

**Интерфейсы:**
- Потребляет из `store.js`: `подписаться`, `ожидает`, `конфликты`, `забыть`,
  `повторитьПравку`, `отправитьОчередь`, `запуститьОчередь` и правки дня,
  ставшие синхронными.

- [ ] **Шаг 1: перевести правки дня на мгновенный путь**

Добавить рядом с `busy()` в `public/js/web/app.js`:

```js
/**
 * Правка, которая не ждёт сеть.
 *
 * `busy` остаётся там, где без ответа сервера нельзя: повторы, шаблоны,
 * помощник. Всё, что умеет очередь, проходит здесь — и человек видит
 * результат в то же мгновение, когда нажал.
 */
function сразу(действие) {
  try {
    действие();
  } catch (e) {
    fail(e);
    return;
  }
  state.modal = null;
  state.notice = null;
  state.noticeBad = false;
  fill();
  render();
}
```

Перевести на `сразу(...)` вызовы правок дня. Это (номера строк — на момент
написания плана, искать по содержимому):

- `app.js:1910` и `app.js:2083` — `busy(api.tasks.update(...))` → `сразу(() => data.toggleTask(t, !t.done))`;
- `app.js:3722-3737` — сохранение строки расписания (создание, правка,
  перенос на другую дату);
- `app.js:3785` — удаление строки расписания;
- `app.js:3856` — подход в тренировке;
- `app.js:3984-4006` и `app.js:4013-4015` — приём пищи вместе с его блоком
  в расписании;
- `app.js:4021` — удаление блока;
- `app.js:4070-4080`, `app.js:4087` — заметка дня (свободные заметки
  остаются на `busy`: они не часть дня);
- `app.js:5291`, `app.js:5312` — задача из шторки;
- `app.js:1229-1231` — план питания и цель по калориям.

Повторы (`data.createRepeat`, `updateSeries`, `removeSeries`, `endSeries`,
`attachRow`, `detachRow`), шаблон, помощник, копирование дня, сдвиг и
привычки-сущности (`app.js:3835`, `app.js:5220`) остаются на `busy`.

Там, где код брал id из ответа сервера (приём пищи с блоком —
`app.js:3993-3994`), теперь берёт его из возврата `data.createRow(...)`:
`{ id: 'tmp-…' }` годится так же, как настоящий, — подстановку сделает
очередь.

В `toggle()` (`app.js:414-429`) убрать `.then(() => reload())` и откат в
`catch`: правка не падает, а очередь сама сообщит об отказе.

- [ ] **Шаг 2: значок связи и очереди вместо полосы**

Заменить блок `const offline = noNet ? h('div.wnotice.calm', …) : null;`
(`app.js:6970-6976`) на:

```js
  /*
   * Состояние связи — маленьким значком, а не полосой во весь экран.
   *
   * Полоса занимала место постоянно и пугала: «правки не уходят» человек
   * читал как «правки потеряются». Теперь правки не теряются, и сказать
   * нужно другое и короче: сколько их ещё в пути.
   */
  const вОчереди = data.ожидает();
  const беды = data.конфликты().length;
  const значок = (!noNet && !вОчереди && !беды) ? null : h('button.wsync',
    {
      type: 'button',
      class: беды ? 'bad' : (noNet ? 'off' : ''),
      title: беды ? 'Есть правки, которые не сохранились'
        : noNet ? 'Связи нет: правки сохранены на устройстве и уедут сами'
          : 'Правки уезжают на сервер',
      onclick: () => (беды ? set({ modal: 'sync' }) : data.отправитьОчередь()),
    },
    ico(беды ? 'warning-circle-fill' : (noNet ? 'wifi-high' : 'arrows-clockwise'), '13px'),
    h('span', { text: беды ? `${беды} не сохранилось` : (вОчереди ? String(вОчереди) : 'Нет связи') }));
  const offline = значок;
```

Все три значка уже есть в наборе (`public/js/vendor/icons.js`): новых не
добавлять — генератор набора требует пакета, которого в проекте нет.
Перечёркнутого вайфая в наборе тоже нет, и смысл несут слова «Нет связи»,
а значок только приглушён.

- [ ] **Шаг 3: шторка «не доехали»**

Добавить в набор шторок (`modal` / `screens` — рядом с остальными `case`
внутри функции `modal()`), по образцу любой простой существующей шторки:

```js
/**
 * Что не сохранилось. Список короткий и почти всегда пустой; он нужен в тот
 * единственный раз, когда сервер отказал, — чтобы правка не пропала молча.
 */
function syncSheet() {
  const список = data.конфликты();
  return sheet('Не сохранилось', [
    ...(список.length ? [] : [h('p.wdim', { text: 'Всё сохранено.' })]),
    ...список.map(о => h('div.wrow',
      h('div.wrow-main',
        h('b', { text: описаниеПравки(о) }),
        h('span.wdim', { text: о.ошибка ?? 'Не сохранилось' })),
      h('div.wrow-side',
        h('button.wbtn', { type: 'button', text: 'Повторить', onclick: () => сразу(() => data.повторитьПравку(о.id)) }),
        h('button.wbtn', { type: 'button', text: 'Забыть', onclick: () => сразу(() => data.забыть(о.id)) })))),
  ]);
}

/** Человеческое имя правки: «Задача», «Блок расписания», «Привычка». */
const описаниеПравки = о => ({
  'строка.создать': 'Новая запись',
  'строка.изменить': 'Правка записи',
  'строка.удалить': 'Удаление записи',
  'привычка.отметить': 'Отметка привычки',
  'день.поля': 'Заметка дня',
  'настройки': 'Настройка',
}[о.вид] ?? 'Правка') + ` · ${о.дата}`;
```

Разметку (`sheet`, `h('div.wrow', …)`) привести к тому, как устроены соседние
шторки в этом файле, — новых классов не изобретать, кроме `.wsync`.

- [ ] **Шаг 4: запуск очереди и перерисовка по её вестям**

Рядом с существующими `addEventListener('online', …)` (`app.js:7093`)
добавить:

```js
/*
 * Экран следит за очередью: её счётчик виден в шапке, а подстановка
 * настоящего номера строки меняет то, что уже нарисовано.
 */
data.подписаться(() => { fill(); render(); });
data.запуститьОчередь();
```

И в обработчике `online` вместо одного `reload()` — сперва
`data.отправитьОчередь()`, затем `reload()`: сначала отдать своё, потом
забирать чужое.

- [ ] **Шаг 5: стиль значка**

В `public/css/web.css` рядом с блоком «Служебные сообщения» (≈1816) добавить:

```css
/*
 * Значок связи. Маленький и в потоке: состояние, а не событие. Полоса во
 * весь экран занимала место постоянно и читалась тревожнее, чем есть.
 */
.wsync {
  display: inline-flex; align-items: center; gap: 6px;
  margin-bottom: 12px; padding: 5px 10px; border-radius: 999px;
  border: none; background: var(--raise); color: var(--dim);
  font: 400 12px/1 var(--ui); cursor: pointer;
}
.wsync.off { color: var(--dim); }
.wsync.bad { color: var(--warn); box-shadow: inset 0 0 0 1px var(--warn); }
```

- [ ] **Шаг 6: проверить вручную в браузере**

```bash
node server/index.js
```

Открыть сайт, войти, затем:
1. добавить задачу — она появляется мгновенно, без «Сохраняю…»;
2. в инструментах разработчика включить offline, отметить дело, добавить
   задачу, поправить время блока — всё видно, в шапке «⟳ 3»;
3. перезагрузить страницу в offline — правки на месте, счётчик тот же;
4. вернуть сеть — счётчик уходит, `GET /days/…/full` показывает те же данные.

- [ ] **Шаг 7: штамп и полный прогон**

```bash
node tools/stamp-sw.mjs
npm test
```

Ожидаем: все тесты зелёные (было 431 + новые из задач 1-5).

- [ ] **Шаг 8: коммит**

```bash
git add public/js/web/app.js public/css/web.css public/service-worker.js
git commit -m "Экран не ждёт сеть: правки видны сразу, связь — значком"
```

---

### Задача 7: живые пробы и выкладка

**Файлы:**
- Изменить: `tools/web-live-check.mjs`
- Прогон: `npm test`, `node tools/web-live-check.mjs`

- [ ] **Шаг 1: добавить пробы**

Пробы в этом файле — верхнеуровневый код: `await js(...)`, затем
`проба(имя, булево, деталь)`. Помощники уже есть: `js`, `wait`, `waitFor`,
`rpc(ws, ...)`, `DAY`. Добавить в конец, перед итогом:

```js
// ── Офлайн-правки ──
/*
 * Главное обещание новой механики: правка видна сразу, переживает
 * перезагрузку и уезжает сама. Проверяем всё три раза подряд на одном
 * тексте, чтобы было видно не только «появилось», но и «доехало именно то».
 */
const МЕТКА = `офлайн ${Date.now().toString(36)}`;
const задачНаСервере = () => js(
  `fetch('/api/v1/days/${DAY}/full').then(r=>r.json())
     .then(d => Object.values(d.tasks).flat().filter(t => t.text.includes(${JSON.stringify(МЕТКА)})).length)`, true);

await rpc(ws, 'Network.emulateNetworkConditions',
  { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
await wait(300);

// добавляем задачу тем же путём, каким это делает человек: шторка задачи
await js(`window.__wgo && window.__wgo('today')`);
await wait(400);
await js(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => /Добавить задачу|\\+ Задача/.test(x.textContent));
  b?.click(); return Boolean(b);
})()`);
await wait(500);
await js(`(() => {
  const i = document.querySelector('.wmodal .winput');
  if (!i) return false;
  i.value = ${JSON.stringify(МЕТКА)};
  i.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('.wmodal button')].find(x => /Готово|Сохранить/.test(x.textContent))?.click();
  return true;
})()`);
await wait(600);

проба('офлайн: задача видна сразу',
  await js(`[...document.querySelectorAll('.wlist-row')].some(e => e.textContent.includes(${JSON.stringify(МЕТКА)}))`));
проба('офлайн: значок показывает неотправленное',
  Boolean(await js(`document.querySelector('.wsync') ? 1 : 0`)),
  await js(`document.querySelector('.wsync')?.textContent ?? 'значка нет'`));
проба('офлайн: на сервере её ещё нет', (await задачНаСервере()) === 0);

// перезагрузка страницы в офлайне: правка лежит в хранилище, а не в памяти
await rpc(ws, 'Page.reload');
await wait(2000);
проба('офлайн: правка пережила перезагрузку',
  await js(`[...document.querySelectorAll('.wlist-row')].some(e => e.textContent.includes(${JSON.stringify(МЕТКА)}))`));

await rpc(ws, 'Network.emulateNetworkConditions',
  { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await js(`window.dispatchEvent(new Event('online'))`);
await wait(2500);
проба('связь вернулась: правка уехала на сервер', (await задачНаСервере()) === 1);
проба('связь вернулась: значок ушёл', (await js(`document.querySelector('.wsync') ? 1 : 0`)) === 0);
```

Селекторы (`.wlist-row`, `.wmodal .winput`, подписи кнопок) сверить с тем,
как это делают соседние пробы: подпись кнопки могла измениться. Если в
файле есть строка с общим числом проб — увеличить её на шесть.

- [ ] **Шаг 2: полный прогон**

```bash
node tools/stamp-sw.mjs
npm test
node tools/web-live-check.mjs
```

Ожидаем: все тесты и все пробы зелёные.

- [ ] **Шаг 3: коммит**

```bash
git add tools/web-live-check.mjs public/service-worker.js
git commit -m "Живые пробы офлайн-правок"
```

- [ ] **Шаг 4: выложить и проверить на живом сервере**

Выкладка — как описано в памяти проекта (Coolify по API). После выкладки
повторить проверку из задачи 6 шаг 6 на живом адресе, затем собрать и
поставить APK на телефон по серийному номеру и повторить то же в приложении:
включить авиарежим, отметить дело, добавить задачу, выключить авиарежим,
убедиться, что всё уехало.

---

## Самопроверка плана

**Покрытие спецификации.** Принцип «сервер + очередь» — задачи 1 и 5
(проекция в `loadDay`). Части 1-5 спецификации — задачи 3, 1, 5, 6, 4
соответственно. Список «что офлайн, а что требует связи» — задача 5 (шаг 3,
последний блок) и задача 6 (шаг 1). Конфликты — задача 3 (разбор ответа) и
задача 6 (шторка). Проверки — задачи 1-5 (node), 4 (API), 7 (живые пробы).
Раздел «чего не делаем» ни одной задачей не реализуется — так и задумано.

**Заглушек нет:** в каждом шаге либо готовый код, либо точное место правки с
указанием, по какому образцу её сделать.

**Согласованность имён:** вид операции одинаков в задачах 1, 2, 3, 5;
`наложить/наложитьВсе/вСтроку` — задача 1 и её потребители в задаче 5;
`запрос/временный` — задача 2 и задача 3; `добавить/отправить/подписаться/
новыйId/конфликты/забыть/повторить/очистить/настроить/ожидает/список` —
задача 3 и её потребители в задаче 5; `подписаться/ожидает/конфликты/забыть/
повторитьПравку/отправитьОчередь/запуститьОчередь` — задача 5 и задача 6.
