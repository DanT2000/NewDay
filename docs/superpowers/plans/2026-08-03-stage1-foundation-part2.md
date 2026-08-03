# NewDay Этап 1 — Фундамент. План, часть 2 (задачи 5-14)

> Продолжение `2026-08-03-stage1-foundation.md`. Global Constraints оттуда действуют и здесь.

---

### Task 5: Ошибки, валидация, репозитории дня и вложенных сущностей

**Files:**
- Create: `server/lib/errors.js`, `server/lib/validate.js`
- Create: `server/repos/days.js`, `server/repos/schedule.js`, `server/repos/tasks.js`, `server/repos/meals.js`, `server/repos/sport.js`
- Test: `test/repos/days.test.js`

**Interfaces:**
- Produces:
  - `class ApiError extends Error { constructor(status, code, message, details) }` и `errorHandler(err, req, res, next)`
  - `bumpRev(db, userId, date) → number` — создаёт день, если его нет, увеличивает `rev`, возвращает новое значение
  - `daysRepo(db)` → `{ get(userId, date), ensure(userId, date), patch(userId, date, fields), remove(userId, date), list(userId, from, to) }`
  - `scheduleRepo(db)` → `{ list(userId, date), create(userId, date, data), update(userId, id, data), remove(userId, id), reorder(userId, date, ids), shift(userId, date, fromId, minutes, cascade) }`
  - `tasksRepo(db)`, `mealsRepo(db)`, `sportRepo(db)` → `{ list, create, update, remove, reorder }` с той же формой
  - Все `create`/`update` возвращают полную строку; `update` бросает `ApiError(409, 'STALE_ROW')`, если передан `updatedAt` и он не совпал

- [ ] **Step 1: Тест на `bumpRev` и защиту от чужих данных**

`test/repos/days.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { startTestServer } = require('../helpers/server');
const { daysRepo, bumpRev } = require('../../server/repos/days');
const { scheduleRepo } = require('../../server/repos/schedule');

function seedUsers(db) {
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (1, ?, ?)').run('a', 'x');
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (2, ?, ?)').run('b', 'x');
}

test('bumpRev создаёт день и увеличивает rev', async () => {
  const srv = await startTestServer();
  try {
    seedUsers(srv.db);
    const r1 = bumpRev(srv.db, 1, '2026-08-03');
    assert.strictEqual(r1, 2);          // ensure создал с rev=1, bump сделал 2
    const r2 = bumpRev(srv.db, 1, '2026-08-03');
    assert.strictEqual(r2, 3);
  } finally { await srv.close(); }
});

test('правка вложенной сущности поднимает rev дня', async () => {
  const srv = await startTestServer();
  try {
    seedUsers(srv.db);
    const days = daysRepo(srv.db);
    const sched = scheduleRepo(srv.db);
    days.ensure(1, '2026-08-03');
    const before = days.get(1, '2026-08-03').rev;
    sched.create(1, '2026-08-03', { startMin: 540, title: 'Работа' });
    const after = days.get(1, '2026-08-03').rev;
    assert.strictEqual(after, before + 1);
  } finally { await srv.close(); }
});

test('нельзя тронуть чужую строку', async () => {
  const srv = await startTestServer();
  try {
    seedUsers(srv.db);
    const sched = scheduleRepo(srv.db);
    const row = sched.create(1, '2026-08-03', { startMin: 540, title: 'Моё' });
    assert.throws(() => sched.update(2, row.id, { title: 'Взлом' }), /NOT_FOUND/);
    assert.throws(() => sched.remove(2, row.id), /NOT_FOUND/);
  } finally { await srv.close(); }
});

test('update с устаревшим updatedAt даёт STALE_ROW', async () => {
  const srv = await startTestServer();
  try {
    seedUsers(srv.db);
    const sched = scheduleRepo(srv.db);
    const row = sched.create(1, '2026-08-03', { startMin: 540, title: 'Работа' });
    sched.update(1, row.id, { title: 'Работа 2' });
    assert.throws(
      () => sched.update(1, row.id, { title: 'Гонка', updatedAt: row.updated_at }),
      /STALE_ROW/
    );
  } finally { await srv.close(); }
});

test('shift сдвигает строку и все последующие', async () => {
  const srv = await startTestServer();
  try {
    seedUsers(srv.db);
    const sched = scheduleRepo(srv.db);
    const a = sched.create(1, '2026-08-03', { startMin: 540, endMin: 600, title: 'A' });
    const b = sched.create(1, '2026-08-03', { startMin: 600, endMin: 660, title: 'B' });
    const c = sched.create(1, '2026-08-03', { startMin: 660, endMin: 720, title: 'C' });
    sched.shift(1, '2026-08-03', b.id, 15, true);
    const rows = sched.list(1, '2026-08-03');
    assert.deepStrictEqual(rows.map(r => r.start_min), [540, 615, 675]);
    assert.deepStrictEqual(rows.map(r => r.end_min), [600, 675, 735]);
  } finally { await srv.close(); }
});

test('shift без cascade двигает только одну строку', async () => {
  const srv = await startTestServer();
  try {
    seedUsers(srv.db);
    const sched = scheduleRepo(srv.db);
    sched.create(1, '2026-08-03', { startMin: 540, endMin: 600, title: 'A' });
    const b = sched.create(1, '2026-08-03', { startMin: 600, endMin: 660, title: 'B' });
    sched.create(1, '2026-08-03', { startMin: 660, endMin: 720, title: 'C' });
    sched.shift(1, '2026-08-03', b.id, 15, false);
    assert.deepStrictEqual(sched.list(1, '2026-08-03').map(r => r.start_min), [540, 615, 660]);
  } finally { await srv.close(); }
});

test('сдвиг не может уехать за границы суток', async () => {
  const srv = await startTestServer();
  try {
    seedUsers(srv.db);
    const sched = scheduleRepo(srv.db);
    const a = sched.create(1, '2026-08-03', { startMin: 1430, endMin: 1439, title: 'Поздно' });
    assert.throws(() => sched.shift(1, '2026-08-03', a.id, 60, false), /OUT_OF_RANGE/);
  } finally { await srv.close(); }
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node --test test/repos/days.test.js`
Expected: FAIL, `Cannot find module '../../server/repos/days'`

- [ ] **Step 3: Реализовать `server/lib/errors.js`**

```js
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(`${code}: ${message}`);
    this.status = status; this.code = code;
    this.publicMessage = message; this.details = details;
  }
}
const notFound   = (m = 'Не найдено')          => new ApiError(404, 'NOT_FOUND', m);
const badRequest = (m, d)                      => new ApiError(400, 'BAD_REQUEST', m, d);
const conflict   = (code, m, d)                => new ApiError(409, code, m, d);
const unauthorized = (m = 'Требуется вход')    => new ApiError(401, 'UNAUTHORIZED', m);
const forbidden  = (m = 'Недостаточно прав')   => new ApiError(403, 'FORBIDDEN', m);

function errorHandler(err, _req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.publicMessage, ...(err.details ? { details: err.details } : {}) },
    });
  }
  console.error('[newday] unhandled', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Внутренняя ошибка сервера' } });
}

module.exports = { ApiError, errorHandler, notFound, badRequest, conflict, unauthorized, forbidden };
```

- [ ] **Step 4: Реализовать `server/lib/validate.js`**

```js
const { badRequest } = require('./errors');
const { isValidDate } = require('./dates');

const str = (v, { max = 500, field = 'значение', trim = true } = {}) => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw badRequest(`Поле «${field}» должно быть строкой`);
  const s = trim ? v.trim() : v;
  if (s.length > max) throw badRequest(`Поле «${field}» длиннее ${max} символов`);
  return s;
};
const int = (v, { min = -1e9, max = 1e9, field = 'значение', nullable = false } = {}) => {
  if (v === undefined || v === null || v === '') { if (nullable) return null; throw badRequest(`Поле «${field}» обязательно`); }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`Поле «${field}» вне диапазона ${min}..${max}`);
  return n;
};
const num = (v, { min = -1e9, max = 1e9, field = 'значение', nullable = true } = {}) => {
  if (v === undefined || v === null || v === '') { if (nullable) return null; throw badRequest(`Поле «${field}» обязательно`); }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`Поле «${field}» вне диапазона ${min}..${max}`);
  return n;
};
const bool = v => (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;
const oneOf = (v, allowed, { field = 'значение', fallback } = {}) => {
  if (v === undefined || v === null) { if (fallback !== undefined) return fallback; throw badRequest(`Поле «${field}» обязательно`); }
  if (!allowed.includes(v)) throw badRequest(`Поле «${field}»: допустимо ${allowed.join(', ')}`);
  return v;
};
const date = (v, { field = 'дата' } = {}) => {
  if (!isValidDate(v)) throw badRequest(`Поле «${field}»: ожидается YYYY-MM-DD`);
  return v;
};

module.exports = { str, int, num, bool, oneOf, date };
```

- [ ] **Step 5: Реализовать `server/repos/days.js`**

```js
const { notFound } = require('../lib/errors');

function ensureStmt(db) {
  return db.prepare('INSERT OR IGNORE INTO days (user_id, date) VALUES (?, ?)');
}

function bumpRev(db, userId, date) {
  ensureStmt(db).run(userId, date);
  db.prepare("UPDATE days SET rev = rev + 1, updated_at = datetime('now') WHERE user_id = ? AND date = ?")
    .run(userId, date);
  return db.prepare('SELECT rev FROM days WHERE user_id = ? AND date = ?').get(userId, date).rev;
}

function daysRepo(db) {
  return {
    get(userId, date) {
      return db.prepare('SELECT * FROM days WHERE user_id = ? AND date = ?').get(userId, date) || null;
    },
    ensure(userId, date) {
      ensureStmt(db).run(userId, date);
      return this.get(userId, date);
    },
    patch(userId, date, fields) {
      this.ensure(userId, date);
      const cols = [], vals = [];
      for (const [k, v] of Object.entries(fields)) {
        if (!['title', 'focus', 'weight', 'notes'].includes(k)) continue;
        cols.push(`${k} = ?`); vals.push(v);
      }
      if (cols.length) {
        db.prepare(`UPDATE days SET ${cols.join(', ')} WHERE user_id = ? AND date = ?`)
          .run(...vals, userId, date);
      }
      bumpRev(db, userId, date);
      return this.get(userId, date);
    },
    remove(userId, date) {
      const tx = db.transaction(() => {
        for (const t of ['schedule_items', 'tasks', 'meals', 'sport_sets']) {
          db.prepare(`DELETE FROM ${t} WHERE user_id = ? AND date = ?`).run(userId, date);
        }
        const r = db.prepare('DELETE FROM days WHERE user_id = ? AND date = ?').run(userId, date);
        if (r.changes === 0) throw notFound('День не найден');
      });
      tx();
    },
    list(userId, from, to) {
      const where = ['user_id = ?'], args = [userId];
      if (from) { where.push('date >= ?'); args.push(from); }
      if (to)   { where.push('date <= ?'); args.push(to); }
      return db.prepare(
        `SELECT date, title, focus, weight, rev, updated_at FROM days
         WHERE ${where.join(' AND ')} ORDER BY date DESC`
      ).all(...args);
    },
  };
}

module.exports = { daysRepo, bumpRev };
```

`INSERT OR IGNORE` вместо проверки-и-вставки — это защита от гонки двух параллельных запросов, которые оба решили, что дня нет.

- [ ] **Step 6: Реализовать `server/repos/schedule.js`**

```js
const { notFound, conflict, badRequest } = require('../lib/errors');
const { bumpRev } = require('./days');

const FIELDS = {
  startMin: 'start_min', endMin: 'end_min', title: 'title', note: 'note',
  done: 'done', sortOrder: 'sort_order', kind: 'kind',
  alarmMode: 'alarm_mode', alarmProfile: 'alarm_profile',
  remindBeforeMin: 'remind_before_min', seriesId: 'series_id',
};

function scheduleRepo(db) {
  const own = (userId, id) => {
    const row = db.prepare('SELECT * FROM schedule_items WHERE id = ? AND user_id = ?').get(id, userId);
    if (!row) throw notFound('Строка расписания не найдена');
    return row;
  };

  return {
    list(userId, date) {
      return db.prepare(
        'SELECT * FROM schedule_items WHERE user_id = ? AND date = ? ORDER BY start_min ASC, sort_order ASC, id ASC'
      ).all(userId, date);
    },
    create(userId, date, data) {
      const maxOrder = db.prepare(
        'SELECT COALESCE(MAX(sort_order), -1) AS m FROM schedule_items WHERE user_id = ? AND date = ?'
      ).get(userId, date).m;
      const info = db.prepare(`INSERT INTO schedule_items
        (user_id, date, start_min, end_min, title, note, done, sort_order, kind,
         alarm_mode, alarm_profile, remind_before_min, series_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        userId, date,
        data.startMin ?? 0, data.endMin ?? null,
        data.title ?? '', data.note ?? '', data.done ? 1 : 0,
        data.sortOrder ?? maxOrder + 1, data.kind ?? 'normal',
        data.alarmMode ?? 'none', data.alarmProfile ?? 'gentle',
        data.remindBeforeMin ?? null, data.seriesId ?? null
      );
      bumpRev(db, userId, date);
      return db.prepare('SELECT * FROM schedule_items WHERE id = ?').get(info.lastInsertRowid);
    },
    update(userId, id, data) {
      const row = own(userId, id);
      if (data.updatedAt && data.updatedAt !== row.updated_at) {
        throw conflict('STALE_ROW', 'Строка изменена в другом месте', { current: row });
      }
      const cols = [], vals = [];
      for (const [k, col] of Object.entries(FIELDS)) {
        if (data[k] === undefined) continue;
        cols.push(`${col} = ?`);
        vals.push(k === 'done' ? (data[k] ? 1 : 0) : data[k]);
      }
      if (cols.length) {
        cols.push("updated_at = datetime('now')");
        db.prepare(`UPDATE schedule_items SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
      }
      bumpRev(db, userId, row.date);
      return db.prepare('SELECT * FROM schedule_items WHERE id = ?').get(id);
    },
    remove(userId, id) {
      const row = own(userId, id);
      db.prepare('DELETE FROM schedule_items WHERE id = ?').run(id);
      bumpRev(db, userId, row.date);
    },
    reorder(userId, date, ids) {
      const tx = db.transaction(() => {
        ids.forEach((id, i) => {
          const r = db.prepare(
            'UPDATE schedule_items SET sort_order = ?, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ? AND date = ?'
          ).run(i, id, userId, date);
          if (r.changes === 0) throw notFound(`Строка ${id} не найдена`);
        });
      });
      tx();
      bumpRev(db, userId, date);
      return this.list(userId, date);
    },
    shift(userId, date, fromId, minutes, cascade) {
      const from = own(userId, fromId);
      if (from.date !== date) throw notFound('Строка не принадлежит этому дню');
      const all = this.list(userId, date);
      const targets = cascade
        ? all.filter(r => r.start_min > from.start_min || r.id === from.id)
        : [from];

      for (const r of targets) {
        const s = r.start_min + minutes;
        const e = r.end_min === null ? null : r.end_min + minutes;
        if (s < 0 || s > 1439 || (e !== null && (e < 0 || e > 1439))) {
          throw badRequest('Сдвиг выходит за границы суток', { code: 'OUT_OF_RANGE', id: r.id });
        }
      }
      const tx = db.transaction(() => {
        for (const r of targets) {
          db.prepare(
            "UPDATE schedule_items SET start_min = ?, end_min = ?, updated_at = datetime('now') WHERE id = ?"
          ).run(r.start_min + minutes, r.end_min === null ? null : r.end_min + minutes, r.id);
        }
      });
      tx();
      bumpRev(db, userId, date);
      return this.list(userId, date);
    },
  };
}

module.exports = { scheduleRepo };
```

Ошибка `OUT_OF_RANGE` приходит внутри `details.code`, поэтому тест на `/OUT_OF_RANGE/` в сообщении не сработает. Чтобы тест из Step 1 прошёл, использовать вместо `badRequest` явный `new ApiError(400, 'OUT_OF_RANGE', 'Сдвиг выходит за границы суток', { id: r.id })` — код должен попадать в `err.code`, а не в детали.

- [ ] **Step 7: Реализовать `tasks.js`, `meals.js`, `sport.js`**

Три репозитория той же формы. Различаются только именем таблицы и картой полей:

```js
// server/repos/tasks.js
const { makeRowRepo } = require('./_rowRepo');
module.exports = { tasksRepo: db => makeRowRepo(db, 'tasks', {
  bucket: 'bucket', text: 'text', done: 'done',
  sortOrder: 'sort_order', carriedFrom: 'carried_from',
}, { bucket: 'work', text: '', done: 0 }) };
```

```js
// server/repos/meals.js
const { makeRowRepo } = require('./_rowRepo');
module.exports = { mealsRepo: db => makeRowRepo(db, 'meals', {
  slot: 'slot', timeMin: 'time_min', title: 'title', note: 'note',
  done: 'done', sortOrder: 'sort_order',
}, { slot: 'other', timeMin: null, title: '', note: '', done: 0 }) };
```

```js
// server/repos/sport.js
const { makeRowRepo } = require('./_rowRepo');
module.exports = { sportRepo: db => makeRowRepo(db, 'sport_sets', {
  exercise: 'exercise', sets: 'sets', reps: 'reps', weight: 'weight',
  done: 'done', sortOrder: 'sort_order',
}, { exercise: '', sets: null, reps: null, weight: null, done: 0 }) };
```

Общая фабрика `server/repos/_rowRepo.js` повторяет логику `scheduleRepo` (`list/create/update/remove/reorder`, проверка владельца, `STALE_ROW`, `bumpRev`) без `shift`, параметризованная именем таблицы, картой полей и значениями по умолчанию. Порядок в `list` — `ORDER BY sort_order ASC, id ASC`.

- [ ] **Step 8: Прогнать тесты**

Run: `npm test`
Expected: PASS, 7 новых тестов

- [ ] **Step 9: Коммит**

```bash
git add server/lib/errors.js server/lib/validate.js server/repos/ test/repos/
git commit -m "feat: репозитории дня и вложенных сущностей с rev и защитой от гонок"
```

---

### Task 6: `dayService` и роуты `/api/v1/days/*`

**Files:**
- Create: `server/services/dayService.js`
- Create: `server/routes/v1/days.js`
- Create: `server/middleware/auth.js` (заглушка сессии, полноценная — в Task 11)
- Modify: `server/app.js` (подключить роутер и `errorHandler`)
- Test: `test/api/days.test.js`

**Interfaces:**
- Produces:
  - `dayService(db)` → `{ getFull(user, date), replaceFull(user, date, body, ifMatch), patchDay(user, date, body, ifMatch), copyTo(user, date, targetDate, sections) }`
  - `getFull` возвращает `{ date, rev, title, focus, weight, notes, schedule: [...], tasks: { work: [...], home: [...] }, meals: [...], sport: [...], habits: [...], progress: {...} }`
  - Заголовок ответа `ETag: "<rev>"` на всех чтениях дня
- Consumes: репозитории из Task 5, `todayFor` из Task 3

- [ ] **Step 1: Тест на `If-Match` и на то, что день больше не создаётся молча**

`test/api/days.test.js` — ключевые проверки:

```js
test('PUT /full без If-Match отвергается', async () => {
  const { url, cookie } = await loggedIn();
  const res = await fetch(`${url}/api/v1/days/2026-08-03/full`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ title: 'X' }),
  });
  assert.strictEqual(res.status, 428);
  assert.strictEqual((await res.json()).error.code, 'IF_MATCH_REQUIRED');
});

test('PUT /full с устаревшим If-Match даёт 409 и отдаёт актуальный день', async () => {
  const { url, cookie } = await loggedIn();
  await api(url, cookie, 'PATCH', '/api/v1/days/2026-08-03', { title: 'A' }, { 'If-Match': '"1"' });
  const res = await fetch(`${url}/api/v1/days/2026-08-03/full`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie, 'If-Match': '"1"' },
    body: JSON.stringify({ title: 'B' }),
  });
  assert.strictEqual(res.status, 409);
  const body = await res.json();
  assert.strictEqual(body.error.code, 'REV_MISMATCH');
  assert.ok(body.error.details.current.rev >= 2);
});

test('GET несуществующего дня отдаёт пустой день и НЕ создаёт его', async () => {
  const { url, cookie, db } = await loggedIn();
  const res = await fetch(`${url}/api/v1/days/2026-09-09/full`, { headers: { cookie } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.rev, 0);
  assert.deepStrictEqual(body.schedule, []);
  const n = db.prepare('SELECT COUNT(*) AS c FROM days').get().c;
  assert.strictEqual(n, 0, 'чтение не создаёт день');
});

test('добавление строки расписания создаёт день лениво', async () => {
  const { url, cookie, db } = await loggedIn();
  await api(url, cookie, 'POST', '/api/v1/days/2026-09-09/schedule',
    { startMin: 540, endMin: 600, title: 'Работа' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM days').get().c, 1);
});

test('обрыв на клиенте не может стереть день: PATCH пустым телом ничего не трёт', async () => {
  const { url, cookie } = await loggedIn();
  await api(url, cookie, 'POST', '/api/v1/days/2026-08-03/schedule', { startMin: 540, title: 'Работа' });
  const before = await getJson(url, cookie, '/api/v1/days/2026-08-03/full');
  await api(url, cookie, 'PATCH', '/api/v1/days/2026-08-03', {}, { 'If-Match': `"${before.rev}"` });
  const after = await getJson(url, cookie, '/api/v1/days/2026-08-03/full');
  assert.strictEqual(after.schedule.length, 1, 'расписание на месте');
});
```

Хелперы `loggedIn()`, `api()`, `getJson()` вынести в `test/helpers/client.js`: `loggedIn` создаёт пользователя прямым `INSERT` с bcrypt-хешем, логинится через `POST /api/v1/auth/login` и возвращает `{ url, db, cookie, close }`.

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node --test test/api/days.test.js`
Expected: FAIL — роутов ещё нет, 404

- [ ] **Step 3: Реализовать `dayService.getFull`**

Ключевое: `getFull` для несуществующего дня возвращает `rev: 0` и пустые коллекции, **не создавая запись**. Это прямая починка бага №1 из спеки — клиенту больше не нужен «пустой фолбэк», сервер сам отдаёт валидный пустой день.

```js
function getFull(user, date) {
  const day = days.get(user.id, date);
  return {
    date, rev: day?.rev ?? 0,
    title: day?.title ?? '', focus: day?.focus ?? '',
    weight: day?.weight ?? null, notes: day?.notes ?? '',
    schedule: schedule.list(user.id, date),
    tasks: {
      work: tasks.list(user.id, date).filter(t => t.bucket === 'work'),
      home: tasks.list(user.id, date).filter(t => t.bucket === 'home'),
    },
    meals: meals.list(user.id, date),
    sport: sport.list(user.id, date),
    habits: habitService.forDate(user, date),
    progress: statsService.dayProgress(user, date),
  };
}
```

`habits` и `progress` до Task 8-9 возвращают `[]` и `null` — заглушки заменяются там же.

- [ ] **Step 4: Реализовать проверку `If-Match`**

```js
function checkIfMatch(ifMatch, currentRev, currentDay) {
  if (ifMatch === undefined || ifMatch === null || ifMatch === '') {
    throw new ApiError(428, 'IF_MATCH_REQUIRED', 'Требуется заголовок If-Match с версией дня');
  }
  const want = Number(String(ifMatch).replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(want) || want !== currentRev) {
    throw new ApiError(409, 'REV_MISMATCH', 'День изменён в другом месте', { current: currentDay });
  }
}
```

- [ ] **Step 5: Реализовать `replaceFull` и `patchDay`**

`replaceFull` в одной транзакции: проверить `If-Match`, удалить `schedule_items`/`tasks`/`meals`/`sport_sets` за дату, вставить переданные, обновить поля дня, поднять `rev` один раз. `patchDay` обновляет только `title/focus/weight/notes` через `daysRepo.patch`.

- [ ] **Step 6: Реализовать роутер `server/routes/v1/days.js`**

```
GET    /                  → days.list с ?from=&to=
GET    /:date             → короткий день
GET    /:date/full        → dayService.getFull, ETag
PUT    /:date/full        → dayService.replaceFull
PATCH  /:date             → dayService.patchDay
DELETE /:date             → daysRepo.remove
POST   /:date/copy-to     → dayService.copyTo
```

- [ ] **Step 7: Подключить в `app.js`**

```js
app.use('/api/v1/days', requireAuth, daysRouter(db));
// ...после всех роутов:
app.use(errorHandler);
```

- [ ] **Step 8: Прогнать тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 9: Коммит**

```bash
git add server/services/dayService.js server/routes/v1/days.js server/middleware/auth.js server/app.js test/api/ test/helpers/client.js
git commit -m "feat: /api/v1/days с ленивым созданием дня и If-Match"
```

---

### Task 7: Роуты вложенных сущностей — расписание, задачи, питание, спорт

**Files:**
- Create: `server/routes/v1/schedule.js`, `server/routes/v1/tasks.js`, `server/routes/v1/meals.js`, `server/routes/v1/sport.js`
- Modify: `server/app.js`
- Test: `test/api/schedule.test.js`, `test/api/entities.test.js`

**Interfaces:**
- Produces:
  ```
  POST   /api/v1/days/:date/schedule            → 201, строка
  PATCH  /api/v1/days/:date/schedule/:id        → 200, строка
  DELETE /api/v1/days/:date/schedule/:id        → 204
  POST   /api/v1/days/:date/schedule/reorder    { ids: number[] }   → 200, список
  POST   /api/v1/days/:date/schedule/shift      { fromId, minutes, cascade } → 200, список
  ```
  Те же четыре метода (без `shift`) для `tasks`, `meals`, `sport`.

- [ ] **Step 1: Тест на конкурентную правку двух разных строк**

Это главный сценарий, который сейчас ломается. Два «клиента» правят разные строки одного дня одновременно — оба должны выиграть.

```js
test('два клиента правят разные строки одного дня — ничего не теряется', async () => {
  const { url, cookie } = await loggedIn();
  const a = await api(url, cookie, 'POST', '/api/v1/days/2026-08-03/schedule', { startMin: 540, title: 'A' });
  const b = await api(url, cookie, 'POST', '/api/v1/days/2026-08-03/schedule', { startMin: 600, title: 'B' });

  await Promise.all([
    api(url, cookie, 'PATCH', `/api/v1/days/2026-08-03/schedule/${a.id}`, { done: true }),
    api(url, cookie, 'PATCH', `/api/v1/days/2026-08-03/schedule/${b.id}`, { title: 'B изменено' }),
  ]);

  const full = await getJson(url, cookie, '/api/v1/days/2026-08-03/full');
  const rowA = full.schedule.find(r => r.id === a.id);
  const rowB = full.schedule.find(r => r.id === b.id);
  assert.strictEqual(rowA.done, 1);
  assert.strictEqual(rowB.title, 'B изменено');
});

test('время принимается строкой и нормализуется в минуты', async () => {
  const { url, cookie } = await loggedIn();
  const row = await api(url, cookie, 'POST', '/api/v1/days/2026-08-03/schedule',
    { time: '9:30-13', title: 'Работа' });
  assert.strictEqual(row.start_min, 570);
  assert.strictEqual(row.end_min, 780);
});

test('список расписания всегда отсортирован по времени', async () => {
  const { url, cookie } = await loggedIn();
  await api(url, cookie, 'POST', '/api/v1/days/2026-08-03/schedule', { startMin: 780, title: 'Позже' });
  await api(url, cookie, 'POST', '/api/v1/days/2026-08-03/schedule', { startMin: 540, title: 'Раньше' });
  const full = await getJson(url, cookie, '/api/v1/days/2026-08-03/full');
  assert.deepStrictEqual(full.schedule.map(r => r.title), ['Раньше', 'Позже']);
});
```

Последний тест закрывает баг 2b: сервер — единственный источник порядка, и он же его отдаёт в ответе, поэтому клиент не может разойтись.

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node --test test/api/schedule.test.js`
Expected: FAIL, 404

- [ ] **Step 3: Реализовать роутер расписания**

Тело запроса принимает либо `startMin`/`endMin` числами, либо `time` строкой — во втором случае прогоняется через `parseTimeRange` из `dates.js`. Валидация: `title` до 200, `note` до 1000, `kind` из `normal|work|meal|sport|rest`, `alarmMode` из `none|notify|alarm`, `alarmProfile` из `wakeup|gentle`, `remindBeforeMin` 0..1440 или `null`.

- [ ] **Step 4: Реализовать остальные три роутера**

Общая фабрика `server/routes/v1/_entityRouter.js`, параметризованная репозиторием и функцией валидации тела. Валидация: `tasks.text` до 500, `bucket` из `work|home`; `meals.slot` из `breakfast|lunch|dinner|snack|other`, `timeMin` 0..1439 или `null`; `sport.sets`/`reps` 0..999, `weight` 0..999.

- [ ] **Step 5: Прогнать тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Коммит**

```bash
git add server/routes/v1/ server/app.js test/api/
git commit -m "feat: пер-сущностные роуты расписания, задач, питания и спорта"
```

---

### Task 8: Привычки — модель, репозиторий, роуты

**Files:**
- Create: `server/repos/habits.js`, `server/services/habitService.js`, `server/routes/v1/habits.js`
- Test: `test/api/habits.test.js`

**Interfaces:**
- Produces:
  - `habitsRepo(db)` → `{ list(userId, {includeArchived}), get(userId,id), create, update, archive, restore, remove, reorder }`
  - `habitService(db)` → `{ forDate(user, date), setLog(user, habitId, date, {status, value}), applyPreset(body) }`
  - `forDate` возвращает массив `{ id, title, emoji, color, type, unit, targetPerDay, status, value, activeToday, challenge: { day, target, breaks } | null }`
- Consumes: `weekdayInMask`, `todayFor` из Task 3

- [ ] **Step 1: Тесты на пресеты и на `schedule_mask`**

```js
test('пресет «30 дней подряд» разворачивается в правильные поля', async () => {
  const { url, cookie } = await loggedIn();
  const h = await api(url, cookie, 'POST', '/api/v1/habits',
    { title: 'Пресс', emoji: '💪', preset: 'challenge30' });
  assert.strictEqual(h.mode, 'challenge');
  assert.strictEqual(h.challenge_target_days, 30);
  assert.strictEqual(h.break_policy, 'reset');
  assert.strictEqual(h.polarity, 'do');
});

test('пресет «Бросаю» ставит polarity=avoid и reset', async () => {
  const { url, cookie } = await loggedIn();
  const h = await api(url, cookie, 'POST', '/api/v1/habits',
    { title: 'Не курить', emoji: '🚭', preset: 'quit', challengeTargetDays: 300 });
  assert.strictEqual(h.polarity, 'avoid');
  assert.strictEqual(h.break_policy, 'reset');
  assert.strictEqual(h.challenge_target_days, 300);
});

test('привычка вне schedule_mask помечена activeToday = false', async () => {
  const { url, cookie } = await loggedIn();
  const MON = 1 << 0;
  await api(url, cookie, 'POST', '/api/v1/habits', { title: 'Зал', scheduleMask: MON });
  // 2026-08-04 — вторник
  const full = await getJson(url, cookie, '/api/v1/days/2026-08-04/full');
  assert.strictEqual(full.habits[0].activeToday, false);
  const mon = await getJson(url, cookie, '/api/v1/days/2026-08-03/full');
  assert.strictEqual(mon.habits[0].activeToday, true);
});

test('удаление привычки по умолчанию архивирует, логи сохраняются', async () => {
  const { url, cookie, db } = await loggedIn();
  const h = await api(url, cookie, 'POST', '/api/v1/habits', { title: 'Вода' });
  await api(url, cookie, 'PUT', `/api/v1/habits/${h.id}/log/2026-08-03`, { status: 'done' });
  await api(url, cookie, 'DELETE', `/api/v1/habits/${h.id}`);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM habit_logs').get().c, 1);
  const row = db.prepare('SELECT archived_at FROM habits WHERE id = ?').get(h.id);
  assert.ok(row.archived_at);
});

test('DELETE ?hard=1 удаляет привычку и её логи', async () => {
  const { url, cookie, db } = await loggedIn();
  const h = await api(url, cookie, 'POST', '/api/v1/habits', { title: 'Вода' });
  await api(url, cookie, 'PUT', `/api/v1/habits/${h.id}/log/2026-08-03`, { status: 'done' });
  await api(url, cookie, 'DELETE', `/api/v1/habits/${h.id}?hard=1`);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM habit_logs').get().c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM habits').get().c, 0);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node --test test/api/habits.test.js`
Expected: FAIL, 404

- [ ] **Step 3: Реализовать таблицу пресетов**

```js
const PRESETS = {
  simple:      { mode: 'ongoing',   polarity: 'do',    break_policy: 'reset', challenge_target_days: null },
  challenge30: { mode: 'challenge', polarity: 'do',    break_policy: 'reset', challenge_target_days: 30 },
  marathon300: { mode: 'challenge', polarity: 'do',    break_policy: 'keep',  challenge_target_days: 300 },
  quit:        { mode: 'challenge', polarity: 'avoid', break_policy: 'reset', challenge_target_days: 300 },
};
```

Явно переданные поля перекрывают пресет — в тесте «Бросаю» так задаётся `challengeTargetDays: 300`. При `mode='challenge'` и пустом `challenge_start_date` он ставится в `todayFor(user.timezone)`.

- [ ] **Step 4: Реализовать репозиторий и сервис**

`archive` ставит `archived_at` и `is_active = 0`; `remove` с `hard` удаляет строку (логи уходят каскадом по FK). `setLog` — `INSERT ... ON CONFLICT DO UPDATE`, валидирует `status` из `done|missed|skipped`.

- [ ] **Step 5: Реализовать роутер**

```
GET    /api/v1/habits?archived=1
POST   /api/v1/habits
PATCH  /api/v1/habits/:id
DELETE /api/v1/habits/:id[?hard=1]
POST   /api/v1/habits/reorder
POST   /api/v1/habits/:id/restore
GET    /api/v1/habits/:id/logs?from=&to=
PUT    /api/v1/habits/:id/log/:date
```

- [ ] **Step 6: Подключить `habitService.forDate` в `dayService.getFull`**

Заменить заглушку из Task 6 Step 3.

- [ ] **Step 7: Прогнать тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Коммит**

```bash
git add server/repos/habits.js server/services/habitService.js server/routes/v1/habits.js server/services/dayService.js test/api/habits.test.js
git commit -m "feat: привычки с пресетами, графиком по дням недели и архивом"
```

---

### Task 9: `statsService` — прогресс дня, стрики, челленджи

**Files:**
- Create: `server/services/statsService.js`, `server/routes/v1/stats.js`
- Test: `test/services/stats.test.js`

**Interfaces:**
- Produces:
  - `statsService(db)` → `{ dayProgress(user, date), habitStats(user, habitId, from, to), overview(user, from, to) }`
  - `dayProgress` → `{ total: {done, possible, percent}, schedule: {...}, work: {...}, home: {...}, food: {...}, sport: {...}, habits: {...} }`; секция с `possible === 0` присутствует с `percent: null`
  - `habitStats` → `{ currentStreak, bestStreak, percent, done, missed, skipped, challenge: { day, target, breaks, complete } | null, last14: [{date, status}] }`

Это задача, где сосредоточена вся логика из §7.1 спеки. Тесты — самая важная её часть.

- [ ] **Step 1: Тесты расчёта челленджей**

```js
const test = require('node:test');
const assert = require('node:assert');
const { startTestServer } = require('../helpers/server');
const { statsService } = require('../../server/services/statsService');

function mkHabit(db, over = {}) {
  const f = {
    user_id: 1, title: 'H', mode: 'ongoing', polarity: 'do',
    break_policy: 'reset', challenge_target_days: null,
    challenge_start_date: null, schedule_mask: 127, ...over,
  };
  const info = db.prepare(`INSERT INTO habits
    (user_id, title, mode, polarity, break_policy, challenge_target_days,
     challenge_start_date, schedule_mask, created_at)
    VALUES (@user_id,@title,@mode,@polarity,@break_policy,@challenge_target_days,
            @challenge_start_date,@schedule_mask,'2026-07-01 00:00:00')`).run(f);
  return info.lastInsertRowid;
}
function log(db, habitId, date, status) {
  db.prepare('INSERT INTO habit_logs (user_id, habit_id, date, status) VALUES (1,?,?,?)')
    .run(habitId, date, status);
}
const USER = { id: 1, timezone: 'Europe/Moscow' };

test('challenge/reset: срыв обнуляет счётчик', async () => {
  const srv = await startTestServer();
  try {
    srv.db.prepare('INSERT INTO users (id, username, password_hash) VALUES (1,?,?)').run('a','x');
    const id = mkHabit(srv.db, {
      mode: 'challenge', break_policy: 'reset',
      challenge_target_days: 30, challenge_start_date: '2026-08-01',
    });
    log(srv.db, id, '2026-08-01', 'done');
    log(srv.db, id, '2026-08-02', 'done');
    log(srv.db, id, '2026-08-03', 'missed');
    log(srv.db, id, '2026-08-04', 'done');
    const s = statsService(srv.db).habitStats(USER, id, '2026-08-01', '2026-08-04');
    assert.strictEqual(s.challenge.day, 1, 'после срыва счётчик начался заново');
    assert.strictEqual(s.challenge.target, 30);
    assert.strictEqual(s.currentStreak, 1);
  } finally { await srv.close(); }
});

test('challenge/keep: срыв не обнуляет, но считается', async () => {
  const srv = await startTestServer();
  try {
    srv.db.prepare('INSERT INTO users (id, username, password_hash) VALUES (1,?,?)').run('a','x');
    const id = mkHabit(srv.db, {
      mode: 'challenge', break_policy: 'keep',
      challenge_target_days: 300, challenge_start_date: '2026-08-01',
    });
    log(srv.db, id, '2026-08-01', 'done');
    log(srv.db, id, '2026-08-02', 'missed');
    log(srv.db, id, '2026-08-03', 'done');
    log(srv.db, id, '2026-08-04', 'done');
    const s = statsService(srv.db).habitStats(USER, id, '2026-08-01', '2026-08-04');
    assert.strictEqual(s.challenge.day, 3, 'три выполненных дня');
    assert.strictEqual(s.challenge.breaks, 1);
    assert.strictEqual(s.challenge.complete, false);
  } finally { await srv.close(); }
});

test('skipped не разрывает стрик и не входит в знаменатель', async () => {
  const srv = await startTestServer();
  try {
    srv.db.prepare('INSERT INTO users (id, username, password_hash) VALUES (1,?,?)').run('a','x');
    const id = mkHabit(srv.db);
    log(srv.db, id, '2026-08-01', 'done');
    log(srv.db, id, '2026-08-02', 'skipped');
    log(srv.db, id, '2026-08-03', 'done');
    const s = statsService(srv.db).habitStats(USER, id, '2026-08-01', '2026-08-03');
    assert.strictEqual(s.currentStreak, 2);
    assert.strictEqual(s.percent, 100, 'знаменатель 2, а не 3');
    assert.strictEqual(s.skipped, 1);
  } finally { await srv.close(); }
});

test('дни вне schedule_mask не штрафуют и не рвут стрик', async () => {
  const srv = await startTestServer();
  try {
    srv.db.prepare('INSERT INTO users (id, username, password_hash) VALUES (1,?,?)').run('a','x');
    const MON_WED_FRI = (1 << 0) | (1 << 2) | (1 << 4);
    const id = mkHabit(srv.db, { schedule_mask: MON_WED_FRI });
    log(srv.db, id, '2026-08-03', 'done'); // пн
    log(srv.db, id, '2026-08-05', 'done'); // ср
    log(srv.db, id, '2026-08-07', 'done'); // пт
    const s = statsService(srv.db).habitStats(USER, id, '2026-08-03', '2026-08-07');
    assert.strictEqual(s.currentStreak, 3, 'вторник и четверг не в счёт');
    assert.strictEqual(s.percent, 100);
  } finally { await srv.close(); }
});

test('polarity=avoid: missed — это срыв, стрик обнуляется', async () => {
  const srv = await startTestServer();
  try {
    srv.db.prepare('INSERT INTO users (id, username, password_hash) VALUES (1,?,?)').run('a','x');
    const id = mkHabit(srv.db, { polarity: 'avoid' });
    log(srv.db, id, '2026-08-01', 'done');
    log(srv.db, id, '2026-08-02', 'done');
    log(srv.db, id, '2026-08-03', 'missed');
    const s = statsService(srv.db).habitStats(USER, id, '2026-08-01', '2026-08-03');
    assert.strictEqual(s.currentStreak, 0);
    assert.strictEqual(s.bestStreak, 2);
  } finally { await srv.close(); }
});
```

- [ ] **Step 2: Тесты прогресса дня**

```js
test('прогресс дня считается без весов по всем секциям', async () => {
  const { url, cookie } = await loggedIn();
  await api(url, cookie, 'POST', '/api/v1/days/2026-08-03/schedule', { startMin: 540, title: 'A', done: true });
  await api(url, cookie, 'POST', '/api/v1/days/2026-08-03/schedule', { startMin: 600, title: 'B' });
  await api(url, cookie, 'POST', '/api/v1/days/2026-08-03/tasks', { bucket: 'work', text: 'T', done: true });
  const full = await getJson(url, cookie, '/api/v1/days/2026-08-03/full');
  assert.strictEqual(full.progress.total.done, 2);
  assert.strictEqual(full.progress.total.possible, 3);
  assert.strictEqual(full.progress.total.percent, 67);
});

test('пустая секция даёт percent = null и не тянет общий вниз', async () => {
  const { url, cookie } = await loggedIn();
  await api(url, cookie, 'POST', '/api/v1/days/2026-08-03/tasks', { bucket: 'work', text: 'T', done: true });
  const full = await getJson(url, cookie, '/api/v1/days/2026-08-03/full');
  assert.strictEqual(full.progress.sport.percent, null);
  assert.strictEqual(full.progress.total.percent, 100);
});
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `node --test test/services/stats.test.js`
Expected: FAIL, `Cannot find module '../../server/services/statsService'`

- [ ] **Step 4: Реализовать расчёт стрика**

Идти назад от `to`, пропуская даты вне `schedule_mask` и со статусом `skipped`. `done` увеличивает счётчик, `missed` и отсутствие записи за прошедший активный день останавливают. Отсутствие записи за `today` не останавливает — день ещё не закончился.

- [ ] **Step 5: Реализовать расчёт челленджа**

`reset`: `day` = текущий стрик, ограниченный `target`. При срыве `challenge_start_date` сдвигается на день после срыва (пишется в базу при постановке `missed`, а не при чтении статистики).
`keep`: `day` = число `done` в диапазоне от `challenge_start_date` до `to`, `breaks` = число `missed` там же.
`complete` = `day >= target`.

- [ ] **Step 6: Реализовать `dayProgress`**

Считать по шести секциям; `total` — сумма числителей и знаменателей всех секций, `percent = Math.round(done / possible * 100)` или `null` при `possible === 0`. В `habits` попадают только привычки с `activeToday === true` и статусом не `skipped`.

- [ ] **Step 7: Подключить в `dayService.getFull`, добавить роутер `/api/v1/stats`**

- [ ] **Step 8: Прогнать тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 9: Коммит**

```bash
git add server/services/statsService.js server/routes/v1/stats.js server/services/dayService.js test/services/
git commit -m "feat: статистика привычек с челленджами, заморозками и графиком по дням"
```

---

Задачи 10-14 — в файле `2026-08-03-stage1-foundation-part3.md`.
