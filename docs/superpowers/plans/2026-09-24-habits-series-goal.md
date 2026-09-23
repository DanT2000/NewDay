# Привычки «Серия» и «Цель» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Цель:** привычка считается так, как человек её задумал: Серия — сколько раз
подряд (пропуск обнуляет), Цель — сколько раз всего (пропуск не в зачёт).

**Устройство:** новых колонок нет. Вид выводится из имеющихся полей
(`break_policy`, `times_per_week`), сервер отдаёт его явным полем `kind`, а
подсчёт срывов, процентов и полоски за 14 дней ветвится по этому виду. Клиент
получает готовый вид и не повторяет правило у себя.

**Технологии:** те же. Сервер — Express 4 + better-sqlite3, клиент — ESM без
сборщика, тесты — `node:test` в CommonJS.

**Спецификация:** [docs/superpowers/specs/2026-09-24-habits-series-goal-design.md](../specs/2026-09-24-habits-series-goal-design.md)

## Общие требования

- Комментарии и имена — по-русски, как во всём проекте; комментарий объясняет
  «почему так», а не пересказывает код.
- Новых колонок в базе и переноса данных нет. `polarity` в базе и API
  остаётся, из веб-версии уходит.
- Правило вида — одно, на сервере:
  `kind = (break_policy === 'keep' || times_per_week > 0) ? 'goal' : 'series'`.
- Клиентские модули — ESM, тесты — CommonJS с динамическим `import()`.
- Прогон: `npm test` (перед ним `pretest` сверяет штамп service worker —
  после правки файлов в `public/` нужен `node tools/stamp-sw.mjs`),
  живая проверка — `node tools/web-live-check.mjs` при поднятом
  `node tools/dev-preview.js`.
- Каждая задача заканчивается коммитом по-русски со строкой
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

### Задача 1: вид привычки и подсчёт Цели

**Файлы:**
- Изменить: `server/services/statsService.js` (`habitStats`, `currentStreak`, `bestStreak`, `habitsForDate`)
- Тест: `test/services/stats.test.js`

**Интерфейсы:**
- Производит: `habitStats(...)` дополнительно возвращает `kind: 'series' | 'goal'`,
  `target: number | null`, `total: number`; `habitsForDate(...)` отдаёт у каждой
  привычки `kind` и `total`. Ими пользуются задачи 2, 3 и 4.

- [ ] **Шаг 1: написать падающие тесты**

Дописать в конец `test/services/stats.test.js` (помощники `fixture`, `mkHabit`,
`log`, `stats`, `USER` уже есть в начале файла):

```js
test('цель: пропуск не обнуляет счёт и не считается срывом', () => {
  const { db, cleanup } = fixture();
  try {
    const id = mkHabit(db, {
      mode: 'challenge', break_policy: 'keep',
      challenge_target_days: 30, challenge_start_date: '2026-08-01',
    });
    log(db, id, '2026-08-01', 'done');
    log(db, id, '2026-08-02', 'done');
    // 3 августа человек просто не отметился — по новым правилам это законно
    log(db, id, '2026-08-04', 'done');
    const s = stats(db).habitStats(USER, id, null, '2026-08-05');
    assert.strictEqual(s.kind, 'goal');
    assert.strictEqual(s.total, 3, 'счёт равен числу отметок');
    assert.strictEqual(s.challenge.day, 3);
    assert.strictEqual(s.challenge.breaks, 0, 'у цели срывов не бывает');
    assert.strictEqual(s.missed, 0, 'пропущенный день не пропуск');
    assert.strictEqual(s.bestStreak, 0, 'лучшей серии у цели нет');
    assert.strictEqual(s.currentStreak, 0, 'серии у цели нет');
  } finally { cleanup(); }
});

test('цель без числа — просто счётчик, без процентов', () => {
  const { db, cleanup } = fixture();
  try {
    const id = mkHabit(db, { mode: 'ongoing', break_policy: 'keep' });
    for (const d of ['2026-08-01', '2026-08-03', '2026-08-07']) log(db, id, d, 'done');
    const s = stats(db).habitStats(USER, id, null, '2026-08-09');
    assert.strictEqual(s.kind, 'goal');
    assert.strictEqual(s.target, null);
    assert.strictEqual(s.total, 3, 'счётчик растёт от каждой отметки');
    assert.strictEqual(s.percent, null, 'без цели процентам не от чего считаться');
    assert.strictEqual(s.challenge, null, 'челленджа без числа не бывает');
  } finally { cleanup(); }
});

test('цель: перевыполнение — «цель взята», а не 137 %', () => {
  const { db, cleanup } = fixture();
  try {
    const id = mkHabit(db, {
      mode: 'challenge', break_policy: 'keep',
      challenge_target_days: 2, challenge_start_date: '2026-08-01',
    });
    for (const d of ['2026-08-01', '2026-08-02', '2026-08-03']) log(db, id, d, 'done');
    const s = stats(db).habitStats(USER, id, null, '2026-08-05');
    assert.strictEqual(s.percent, 100);
    assert.strictEqual(s.challenge.complete, true);
    assert.strictEqual(s.challenge.day, 2, 'счётчик не перерастает цель');
    assert.strictEqual(s.total, 3, 'а всего отметок видно честно');
  } finally { cleanup(); }
});

test('серия: пропуск обнуляет, выходной по маске — нет', () => {
  const { db, cleanup } = fixture();
  try {
    // только будни: маска 31 = пн-пт
    const id = mkHabit(db, { break_policy: 'reset', schedule_mask: 31 });
    // 6 и 7 августа — чт и пт, 8 и 9 — сб и вс (выходные по маске)
    log(db, id, '2026-08-06', 'done');
    log(db, id, '2026-08-07', 'done');
    log(db, id, '2026-08-10', 'done');
    const s = stats(db).habitStats(USER, id, null, '2026-08-10');
    assert.strictEqual(s.kind, 'series');
    assert.strictEqual(s.currentStreak, 3, 'суббота с воскресеньем серию не рвут');

    const другая = mkHabit(db, { break_policy: 'reset', schedule_mask: 127 });
    log(db, другая, '2026-08-06', 'done');
    log(db, другая, '2026-08-07', 'done');
    log(db, другая, '2026-08-09', 'done');
    const s2 = stats(db).habitStats(USER, другая, null, '2026-08-09');
    assert.strictEqual(s2.currentStreak, 1, 'пропущенное 8-е обнулило счёт');
  } finally { cleanup(); }
});

test('свободный график читается как цель', () => {
  const { db, cleanup } = fixture();
  try {
    const id = mkHabit(db, { break_policy: 'reset', times_per_week: 3 });
    log(db, id, '2026-08-03', 'done');
    log(db, id, '2026-08-06', 'done');
    const s = stats(db).habitStats(USER, id, null, '2026-08-09');
    assert.strictEqual(s.kind, 'goal', 'подряд считать нечего — дней никто не обещал');
    assert.strictEqual(s.missed, 0);
    assert.strictEqual(s.total, 2);
  } finally { cleanup(); }
});

test('у цели прошедший неотмеченный день в полоске пустой, а не красный', () => {
  const { db, cleanup } = fixture();
  try {
    const id = mkHabit(db, { mode: 'ongoing', break_policy: 'keep' });
    log(db, id, '2026-08-08', 'done');
    const s = stats(db).habitStats(USER, id, null, '2026-08-10');
    const было = s.last14.find(d => d.date === '2026-08-07');
    assert.strictEqual(было.status, null, 'срыва там нет');
  } finally { cleanup(); }
});
```

- [ ] **Шаг 2: прогнать и убедиться, что падает**

Команда: `node --test test/services/stats.test.js`
Ожидаем: падают шесть новых тестов — `s.kind` сейчас `undefined`.

- [ ] **Шаг 3: правка `statsService.js`**

Рядом с `freeSchedule` (около строки 45) добавить:

```js
/**
 * Вид привычки: серия или цель.
 *
 * Серия — сколько раз подряд: пропуск обещанного дня обнуляет счёт. Цель —
 * сколько раз всего: пропуск не в зачёт, но и не сбрасывает. Правило одно и
 * живёт здесь, чтобы клиенту не пришлось повторять его у себя.
 *
 * Свободный график («N раз в неделю») — всегда цель: конкретных дней он не
 * обещает, и «подряд» для него ничего не значит.
 */
const kindOf = habit => (habit.break_policy === 'keep' || freeSchedule(habit) ? 'goal' : 'series');
```

В `currentStreak` заменить первую строку `if (freeSchedule(habit)) return 0;` на:

```js
    // у цели серии нет вовсе: её счёт — число отметок, а не дни подряд
    if (kindOf(habit) === 'goal') return 0;
```

То же в `bestStreak`: заменить `if (freeSchedule(habit)) return 0;` на
`if (kindOf(habit) === 'goal') return 0;`.

В `habitStats` заменить блок подсчёта `done/missed/skipped` и всё, что ниже,
до `return`, на:

```js
    const kind = kindOf(habit);
    let done = 0, missed = 0, skipped = 0;
    for (const d of rangeDates(rangeFrom, rangeTo)) {
      if (!habitActiveOn(habit, d)) continue;
      const status = logsMap[d];
      if (status === 'done') done += 1;
      else if (status === 'skipped') skipped += 1;
      else if (status === 'missed') missed += 1;
      /*
       * Прошедший активный день без отметки — пропуск, но только у серии:
       * цель ничего на конкретный день не обещала, и наказывать за него не
       * за что.
       */
      else if (d < today && kind === 'series') missed += 1;
    }
    // у цели явная отметка «не сделал» тоже не срыв: считать нечего
    if (kind === 'goal') missed = 0;

    const streak = currentStreak(habit, logsMap, rangeTo, today);

    /** Всего отметок «сделано» за всю жизнь привычки — счёт цели. */
    const total = Object.values(logsMap).filter(s => s === 'done').length;

    const target = habit.challenge_target_days ?? null;

    let challenge = null;
    if (target) {
      const start = habit.challenge_start_date || rangeFrom;
      let сделано = 0;
      let срывов = 0;
      for (const d of rangeDates(start, rangeTo)) {
        if (!habitActiveOn(habit, d)) continue;
        const status = logsMap[d];
        if (status === 'done') сделано += 1;
        else if (kind === 'series' && (status === 'missed' || (status === undefined && d < today))) срывов += 1;
      }
      /*
       * У серии счёт — это текущая серия подряд: сорвался, и счётчик снова
       * с нуля. У цели — накопленное число отметок, оно не убывает.
       */
      const счёт = kind === 'series' ? streak : сделано;
      challenge = {
        day: Math.min(счёт, target),
        target,
        breaks: срывов,
        complete: счёт >= target,
        startDate: start,
      };
    }

    /*
     * Полоска за 14 дней. У серии пропущенный день красный — он и правда
     * сорвал счёт. У цели пустой: там нечего было срывать.
     */
    const gap = kind === 'series' ? 'missed' : null;
    const last14 = rangeDates(addDays(rangeTo, -13), rangeTo).map(d => ({
      date: d,
      status: habitActiveOn(habit, d) ? (logsMap[d] ?? (d < today ? gap : null)) : 'inactive',
    }));

    /*
     * Норма недели у свободного графика: сколько сделано за последние семь
     * дней против обещанного. Без этого «3 раза в неделю» нечем измерить.
     */
    const week = freeSchedule(habit)
      ? {
        target: habit.times_per_week,
        done: rangeDates(addDays(rangeTo, -6), rangeTo)
          .filter(d => logsMap[d] === 'done').length,
      }
      : null;

    /*
     * Проценты: у серии — доля сделанного из обещанного, у цели с числом —
     * насколько она набрана (перевыполнение — это «цель взята», а не 137 %),
     * у цели без числа процентам не от чего считаться.
     */
    const percent = kind === 'series'
      ? pct(done, done + missed)
      : (target ? Math.min(100, Math.round((total / target) * 100)) : null);

    return {
      id: habit.id,
      title: habit.title,
      emoji: habit.emoji || '',
      color: habit.color,
      from: rangeFrom,
      to: rangeTo,
      kind,
      target,
      total,
      currentStreak: streak,
      bestStreak: bestStreak(habit, logsMap, rangeFrom, rangeTo),
      done, missed, skipped,
      percent,
      challenge,
      timesPerWeek: habit.times_per_week ?? null,
      week,
      last14,
    };
```

- [ ] **Шаг 4: отдать вид клиенту**

В `habitsForDate` заменить строку
`const challenge = (h.mode === 'challenge' && h.challenge_target_days) ? s.challenge : null;`
на:

```js
      // челлендж живёт числом, а не режимом: цель без числа — просто счётчик
      const challenge = h.challenge_target_days ? s.challenge : null;
```

и в возвращаемом объекте после `breakPolicy: h.break_policy,` добавить:

```js
        kind: s.kind,
        total: s.total,
```

- [ ] **Шаг 5: прогнать тесты**

Команда: `node --test test/services/stats.test.js test/api/habits.test.js test/api/habits-streak.test.js`
Ожидаем: всё зелёное. Если старый тест ждёт `missed > 0` у привычки с
`break_policy: 'keep'` — это ожидание и меняем, потому что оно и было тем
поведением, на которое жаловались; но сперва прочитайте тест целиком и
убедитесь, что речь именно о цели.

- [ ] **Шаг 6: коммит**

```bash
git add server/services/statsService.js test/services/stats.test.js
git commit -m "Привычки считаются по виду: серия подряд, цель накопительно"
```

---

### Задача 2: плитка «серия привычек» считает только серии

**Файлы:**
- Изменить: `server/services/statsService.js` (`habitsStreak`, около строки 304)
- Тест: `test/services/stats.test.js`

**Интерфейсы:**
- Потребляет: `kindOf` из задачи 1.

- [ ] **Шаг 1: написать падающий тест**

```js
test('серия привычек не рвётся из-за неотмеченной цели', () => {
  const { db, cleanup } = fixture();
  try {
    const серия = mkHabit(db, { break_policy: 'reset' });
    const цель = mkHabit(db, { break_policy: 'keep' });
    for (const d of ['2026-08-07', '2026-08-08', '2026-08-09']) log(db, серия, d, 'done');
    // цель отмечена только однажды — по новым правилам это законно
    log(db, цель, '2026-08-08', 'done');
    assert.strictEqual(stats(db).habitsStreak(USER, '2026-08-09'), 3);
  } finally { cleanup(); }
});
```

- [ ] **Шаг 2: прогнать и убедиться, что падает**

Команда: `node --test test/services/stats.test.js`
Ожидаем: серия 0 или 1 вместо 3 — неотмеченная цель рвёт общий счёт.

- [ ] **Шаг 3: правка**

В `habitsStreak` заменить строку `.filter(h => !freeSchedule(h));` на:

```js
      /*
       * Только серии. Непроставленная цель законна — пропуск у неё не срыв,
       * и рвать ею общую серию значит наказывать человека за то, что ему
       * прямо разрешено.
       */
      .filter(h => kindOf(h) === 'series');
```

- [ ] **Шаг 4: прогнать тесты**

Команда: `node --test test/services/stats.test.js test/api/habits-streak.test.js`
Ожидаем: зелёное.

- [ ] **Шаг 5: коммит**

```bash
git add server/services/statsService.js test/services/stats.test.js
git commit -m "Общая серия привычек не рвётся неотмеченной целью"
```

---

### Задача 3: подписи в списке привычек

**Файлы:**
- Изменить: `public/js/web/adapt.js` (`habitMeta`, около строки 228)
- Создать: `test/web/adapt-habits.test.js`

**Интерфейсы:**
- Потребляет: `kind`, `total`, `target`, `challenge`, `streak`, `bestStreak`,
  `weekNorm`, `activeToday` из задачи 1.
- Производит: `habitMeta(h) → string`, вывезенный из `adapt.js` наружу
  (`export function habitMeta`), чтобы его можно было проверить тестом.

- [ ] **Шаг 1: написать падающий тест**

Создать `test/web/adapt-habits.test.js`:

```js
/**
 * Подпись под привычкой. Она — единственное, по чему человек понимает, как
 * его считают, поэтому врать ей нельзя: «челлендж 0 из 300» при сорока
 * отмеченных днях читается как поломка.
 */

const test = require('node:test');
const assert = require('node:assert');

const привычка = over => ({
  activeToday: true, kind: 'series', streak: 0, bestStreak: 0,
  challenge: null, weekNorm: null, total: 0, target: null, ...over,
});

test('серия: дни подряд и лучшая серия', async () => {
  const { habitMeta } = await import('../../public/js/web/adapt.js');
  assert.strictEqual(
    habitMeta(привычка({ streak: 12, bestStreak: 30 })),
    'подряд 12 дней · лучшая серия 30');
});

test('серия с целью: сколько дней подряд из скольких', async () => {
  const { habitMeta } = await import('../../public/js/web/adapt.js');
  assert.strictEqual(
    habitMeta(привычка({ streak: 12, bestStreak: 30, target: 30, challenge: { day: 12, target: 30 } })),
    '12 из 30 подряд · лучшая серия 30');
});

test('цель с числом: без слова «подряд» и без лучшей серии', async () => {
  const { habitMeta } = await import('../../public/js/web/adapt.js');
  assert.strictEqual(
    habitMeta(привычка({ kind: 'goal', total: 46, target: 300, challenge: { day: 46, target: 300 } })),
    '46 из 300');
});

test('цель без числа: просто счётчик', async () => {
  const { habitMeta } = await import('../../public/js/web/adapt.js');
  assert.strictEqual(habitMeta(привычка({ kind: 'goal', total: 17 })), 'сделано 17 раз');
});

test('цель взята — так и написано', async () => {
  const { habitMeta } = await import('../../public/js/web/adapt.js');
  assert.strictEqual(
    habitMeta(привычка({ kind: 'goal', total: 30, target: 30, challenge: { day: 30, target: 30, complete: true } })),
    '30 из 30 · цель взята');
});

test('свободный график: норма недели', async () => {
  const { habitMeta } = await import('../../public/js/web/adapt.js');
  assert.strictEqual(
    habitMeta(привычка({ kind: 'goal', weekNorm: { done: 2, target: 3 }, total: 9 })),
    '2 из 3 за неделю');
});

test('выходной и пустая привычка', async () => {
  const { habitMeta } = await import('../../public/js/web/adapt.js');
  assert.strictEqual(habitMeta(привычка({ activeToday: false })), 'сегодня по графику выходной');
  assert.strictEqual(habitMeta(привычка({})), 'ещё не отмечалась');
});
```

- [ ] **Шаг 2: прогнать и убедиться, что падает**

Команда: `node --test test/web/adapt-habits.test.js`
Ожидаем: падает на импорте — `habitMeta` не вывезен наружу.

- [ ] **Шаг 3: переписать `habitMeta`**

В `public/js/web/adapt.js` заменить функцию `habitMeta` целиком на:

```js
/**
 * Подпись под привычкой — короткий ответ на «как у меня дела».
 *
 * У серии счёт идёт днями подряд, у цели — отметками. Раньше подпись была
 * одна на оба случая и говорила «челлендж 0 из 300 дней» человеку, который
 * отбегал сорок дней с одним пропуском: показывался не счёт, а текущая
 * серия. Теперь вид определяет и слова, и число.
 */
export function habitMeta(h) {
  if (h.activeToday === false) return 'сегодня по графику выходной';
  const parts = [];
  if (h.kind === 'goal') {
    /*
     * У свободного графика обещание считается за неделю — её и показываем:
     * «сделано 9 раз» ничего не говорит о том, держится ли человек ритма.
     */
    if (h.weekNorm) parts.push(`${h.weekNorm.done} из ${h.weekNorm.target} за неделю`);
    else if (h.challenge) parts.push(`${h.challenge.day ?? 0} из ${h.challenge.target ?? 0}`);
    else if (h.total) parts.push(`сделано ${h.total} ${plural(h.total, 'раз', 'раза', 'раз')}`);
    if (h.challenge?.complete) parts.push('цель взята');
  } else {
    if (h.challenge) parts.push(`${h.challenge.day ?? 0} из ${h.challenge.target ?? 0} подряд`);
    else if (h.streak) parts.push(`подряд ${h.streak} ${plural(h.streak, 'день', 'дня', 'дней')}`);
    if (h.bestStreak) parts.push(`лучшая серия ${h.bestStreak}`);
  }
  return parts.join(' · ') || 'ещё не отмечалась';
}
```

Проверить, что `plural` объявлен в этом файле выше по тексту (он там есть,
около строки 375 — если ниже, объявление функции всё равно поднимается).

- [ ] **Шаг 4: прогнать тесты**

Команда: `node --test test/web/adapt-habits.test.js`
Ожидаем: 7 тестов пройдено.

- [ ] **Шаг 5: коммит**

```bash
node tools/stamp-sw.mjs
git add public/js/web/adapt.js public/service-worker.js test/web/adapt-habits.test.js
git commit -m "Подпись под привычкой говорит правду про её вид"
```

---

### Задача 4: выбор «Серия / Цель» в шторке

**Файлы:**
- Изменить: `public/js/web/app.js` — `openHabit` (около 3878), `saveHabit`
  (около 3898), тело шторки `habit` в `BODIES` (около 5262), начальное
  состояние (строки 61-62)
- Проверка: ручной прогон в браузере и задача 5

**Интерфейсы:**
- Потребляет: `kind` из задачи 1 (в `hb.raw.kind`).
- Производит: тело запроса привычки с полями `breakPolicy: 'reset' | 'keep'`,
  `mode`, `challengeTargetDays`, `scheduleMask`, `timesPerWeek`.

- [ ] **Шаг 1: начальное состояние**

В `public/js/web/app.js`, строки 61-62, заменить `habitKind: 'do'` на
`habitKind: 'series'`. Остальные поля состояния не трогать.

- [ ] **Шаг 2: открытие шторки**

В `openHabit` заменить строку
`habitKind: raw?.polarity === 'avoid' ? 'avoid' : 'do',` на:

```js
    // вид приходит с сервера готовым: правило одно и живёт там
    habitKind: raw?.kind === 'goal' ? 'goal' : 'series',
```

- [ ] **Шаг 3: сохранение**

В `saveHabit` заменить тело `body` на:

```js
  const цель = state.habitKind === 'goal';
  const body = {
    title, emoji: state.habitEmoji,
    /*
     * Вид — это способ считать: серия обнуляется при срыве, цель копит
     * отметки. В базе за это отвечает break_policy, и другого смысла у
     * поля нет.
     */
    breakPolicy: цель ? 'keep' : 'reset',
    /*
     * У серии график только по дням недели: «подряд» требует конкретных
     * дней, а при «N раз в неделю» серия молча показывала ноль.
     */
    scheduleMask: (цель && state.habitPlan === 'times') ? 127 : (mask || 127),
    timesPerWeek: (цель && state.habitPlan === 'times') ? state.habitTimes : null,
    mode: target > 0 ? 'challenge' : 'ongoing',
    challengeTargetDays: target > 0 ? target : null,
  };
```

(Строки выше — `const mask = …` и `const target = …` — остаются как есть.)

- [ ] **Шаг 4: тело шторки**

В `BODIES.habit` заменить строку выбора вида

```js
      ...[['do', 'Выполнять'], ['avoid', 'Бросаю']].map(([k, label]) =>
        sheetChip(label, state.habitKind === k, () => setIn({ habitKind: k }))));
```

на:

```js
      ...[['series', 'Серия'], ['goal', 'Цель']].map(([k, label]) =>
        sheetChip(label, state.habitKind === k, () => setIn({ habitKind: k }))));
```

Заменить подсказку под выбором (блок `h('div.wclock-cap', …)` с текстом про
«бросаю») на:

```js
        // Человек должен понимать, как его считают, ещё до первой отметки
        h('div.wclock-cap', {
          style: { marginTop: '9px' },
          text: state.habitKind === 'goal'
            ? 'цель: отмечаете, когда сделали. Пропуск не в зачёт, но счёт не обнуляет'
            : 'серия: отмечаете каждый выбранный день. Пропуск обнуляет счёт',
        })),
```

Заменить подпись блока цели `h('div.wfield-label', { text: 'челлендж' })` на:

```js
        h('div.wfield-label', { text: state.habitKind === 'goal' ? 'сколько раз' : 'сколько дней подряд' }),
```

и подпись у своего числа `h('span.wsmall', { text: 'дней подряд' })` на:

```js
            h('span.wsmall', { text: state.habitKind === 'goal' ? 'раз' : 'дней подряд' }))
```

Блок графика показывать по виду: заменить

```js
      h('div',
        h('div.wfield-label', { text: 'график' }), plan,
        h('div', { style: { marginTop: '10px' } }, state.habitPlan === 'times' ? times : days)),
```

на:

```js
      /*
       * У серии выбора графика нет — только дни: «подряд» без конкретных
       * дней не считается, и такое сочетание раньше молча давало ноль.
       */
      h('div',
        h('div.wfield-label', { text: 'график' }),
        state.habitKind === 'goal' ? plan : null,
        h('div', { style: { marginTop: '10px' } },
          (state.habitKind === 'goal' && state.habitPlan === 'times') ? times : days)),
```

- [ ] **Шаг 5: проверить руками в браузере**

```bash
node tools/dev-preview.js
```

Открыть стенд, зайти в «Привычки» → «Новая привычка»:
1. выбран «Серия», подсказка про обнуление, подпись цели «сколько дней
   подряд», выбора «N раз в неделю» нет;
2. нажать «Цель» — подсказка меняется, появляется выбор графика, подпись
   цели «сколько раз»;
3. создать Цель на 30 раз, отметить сегодня — в списке «1 из 30»;
4. открыть её заново — вид «Цель» сохранился.

- [ ] **Шаг 6: штамп, прогон, коммит**

```bash
node tools/stamp-sw.mjs
npm test
git add public/js/web/app.js public/service-worker.js
git commit -m "В шторке привычки выбирают вид: серия или цель"
```

---

### Задача 5: живые пробы и выкладка

**Файлы:**
- Изменить: `tools/web-live-check.mjs`

- [ ] **Шаг 1: добавить пробы**

Найти в файле блок проверок привычек (поиск по `Привычки`) и дописать после
него, в том же стиле (`js`, `wait`, `waitFor`, `проба(имя, булево, деталь)`):

```js
// ── Вид привычки: серия и цель ──
/*
 * Два вида считаются по-разному, и единственное, по чему человек это видит, —
 * подпись под привычкой. Поэтому проверяем не настройку, а слова на экране.
 */
const видПривычки = async (вид, название, цель) => {
  await js(`window.__wgo && window.__wgo('habits')`);
  await wait(500);
  await js(`[...document.querySelectorAll('button')].find(x => /Новая привычка/.test(x.textContent))?.click()`);
  await waitFor(`Boolean(document.querySelector('.wmodal .winput'))`, 30);
  await js(`(() => {
    const i = document.querySelector('.wmodal .winput');
    i.value = ${JSON.stringify(название)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.wmodal .wchip')].find(c => c.textContent === ${JSON.stringify(вид)})?.click();
    return true;
  })()`);
  await wait(300);
  await js(`[...document.querySelectorAll('.wmodal .wchip')].find(c => c.textContent === ${JSON.stringify(цель)})?.click()`);
  await wait(200);
  await js(`[...document.querySelectorAll('.wmodal button')].find(x => /Создать привычку/.test(x.textContent))?.click()`);
  await wait(1200);
};

await видПривычки('Серия', `серия ${МЕТКА}`, '30 дней');
await видПривычки('Цель', `цель ${МЕТКА}`, '30 дней');

// отметить обе и посмотреть, что написано под ними
await js(`[...document.querySelectorAll('.wcard')]
  .filter(e => e.textContent.includes(${JSON.stringify(МЕТКА)}))
  .forEach(e => e.querySelector('.wbox')?.click())`);
await wait(1500);

const подписи = await js(`Object.fromEntries([...document.querySelectorAll('.wcard')]
  .filter(e => e.textContent.includes(${JSON.stringify(МЕТКА)}))
  .map(e => [/серия /.test(e.textContent) ? 'серия' : 'цель', (e.textContent.match(/(подряд[^·]*|\\d+ из \\d+[^·]*)/) || [''])[0].trim()]))`);
проба('у серии счёт идёт подряд', /подряд/.test(подписи['серия'] ?? ''), JSON.stringify(подписи));
проба('у цели счёт без слова «подряд»',
  /1 из 30/.test(подписи['цель'] ?? '') && !/подряд/.test(подписи['цель'] ?? ''), JSON.stringify(подписи));

// уборка: привычки прогона не должны копиться в стенде
await js(`(async () => {
  const list = await (await fetch('/api/v1/habits')).json();
  for (const h of list) if ((h.title || '').includes(${JSON.stringify(МЕТКА)})) {
    await fetch('/api/v1/habits/' + h.id + '?hard=1', { method: 'DELETE' });
  }
  return true;
})()`, true);
проба('стенд убран за собой: привычки прогона удалены',
  (await js(`fetch('/api/v1/habits').then(r => r.json()).then(l => l.filter(h => (h.title||'').includes(${JSON.stringify(МЕТКА)})).length)`, true)) === 0);
```

Если константы `МЕТКА` в этом месте файла ещё нет — она объявляется ниже, в
блоке офлайн-правок; тогда завести свою: `const МЕТКА_П = 'вид-' + Date.now().toString(36);`
и подставить её вместо `МЕТКА` во все выражения выше. Селекторы строк
привычек (`.whabit`) сверить с разметкой: если класс другой, взять тот,
которым пользуются соседние пробы привычек.

- [ ] **Шаг 2: полный прогон**

```bash
node tools/stamp-sw.mjs
npm test
node tools/web-live-check.mjs
```

Ожидаем: тесты и все пробы зелёные.

- [ ] **Шаг 3: коммит и выкладка**

```bash
git add tools/web-live-check.mjs public/service-worker.js
git commit -m "Живые пробы: серия и цель считаются по-разному"
git push origin master
```

Выкладка — как в памяти проекта: deploy через Coolify API циклом с повтором
(GitHub с того хоста время от времени недоступен), затем сверить, что бой
отдаёт свежий штамп service worker. После этого собрать APK со следующим
номером версии и выложить его через `/api/v1/app/upload`.

---

## Самопроверка плана

**Покрытие спецификации.** Два вида и правило вывода — задача 1 (`kindOf`).
Подсчёт по таблице из спецификации (счёт, пропуск, лучшая серия, срывы,
проценты, полоска) — задача 1. Плитка «серия привычек» — задача 2. Что
отдаёт сервер (`kind`, `target`, `total`, `challenge`) — задача 1, шаги 3-4.
Что видно человеку: подписи — задача 3, шторка — задача 4. Раздел «чего не
делаем» задачами не покрывается намеренно: старые страницы и колонки базы не
трогаем. Проверки — задачи 1-3 (node) и 5 (живые пробы).

**Заглушек нет:** в каждом шаге либо готовый код, либо точное место правки с
указанием, что именно заменить.

**Согласованность имён:** `kindOf` объявляется в задаче 1 и используется в
задаче 2; `kind`/`target`/`total` появляются в ответе сервера в задаче 1 и
читаются в задачах 3 (`habitMeta`) и 4 (`openHabit`); `habitKind` в состоянии
экрана принимает те же значения `'series' | 'goal'`, что и `kind` сервера;
`breakPolicy` в теле запроса — то поле, из которого `kindOf` вид и выводит.
