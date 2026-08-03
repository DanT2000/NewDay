# NewDay Этап 1 — Фундамент. План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Переписать бэкенд NewDay так, чтобы данные нельзя было потерять: нормализованная схема вместо JSON-блоба, пер-сущностные эндпоинты, корректные таймзоны, аккаунты по email и публичное API с токенами.

**Architecture:** Express-приложение собирается фабрикой `createApp({ db, config })`, база открывается фабрикой `createDb(path)` — это нужно, чтобы тесты поднимали изолированный экземпляр на временном файле. Схема эволюционирует через нумерованные миграции, применяемые ранером при старте. Данные разложены по таблицам; каждый HTTP-эндпоинт правит одну сущность. Слои: `routes → services → repos → db`, без обращений к `db` из роутов.

**Tech Stack:** Node.js 20 (прод) / 22 (локально), Express 4, better-sqlite3 9, bcryptjs, nodemailer, встроенный `node --test`. Без сборщика, без ORM, без TypeScript.

## Global Constraints

- Даты в БД — строки `YYYY-MM-DD` в таймзоне пользователя. Время — целые минуты от полуночи (`start_min`, `end_min`).
- Получать текущую дату разрешено **только** через `todayFor(timezone)` из `server/lib/dates.js`. Прямой `new Date().toISOString().split('T')[0]` в коде сервера запрещён.
- Каждый эндпоинт правит одну сущность. `PUT /days/:date/full` — единственное исключение, оно для API-клиентов.
- `days.rev` увеличивается на 1 при любом изменении внутри дня, включая вложенные сущности.
- `If-Match: <rev>` обязателен для `PUT /days/:date/full` и `PATCH /days/:date`. Для операций над строками — не требуется.
- Все ошибки в формате `{ "error": { "code": "...", "message": "...", "details": {...} } }`. Коды — `SCREAMING_SNAKE_CASE`.
- Все новые пути — под префиксом `/api/v1`. Старые `/api/auth/*`, `/api/days/*`, `/api/habits/*` остаются алиасами до этапа 5.
- Сообщения об ошибках, видимые пользователю, — на русском.
- Новых зависимостей ровно одна: `nodemailer`. Ничего больше не добавляем.
- Тесты запускаются командой `npm test` (`node --test test/`), работают без сети и без SMTP.
- Каждая задача заканчивается коммитом в ветку `develop`.

---

### Task 1: Ветка, гигиена репозитория, health-эндпоинт

**Files:**
- Modify: `.gitignore`
- Create: `server/routes/health.js`
- Modify: `server/index.js:96-118`
- Test: `test/health.test.js`

**Interfaces:**
- Produces: роутер `GET /api/health` → `{ ok: true, schemaVersion: number, dbWritable: boolean, version: string }`

- [ ] **Step 1: Завести ветку и закоммитить спеку**

```bash
cd /d/Project/NewDay
git checkout -b develop
git add docs/superpowers/specs/2026-08-03-newday-production-design.md docs/superpowers/plans/2026-08-03-stage1-foundation.md
git commit -m "docs: спецификация продакшн-доработки и план этапа 1"
```

- [ ] **Step 2: Починить `.gitignore`**

Сейчас правила для базы закомментированы — локальная база с хешами паролей может уехать в репозиторий. Записать файл целиком:

```gitignore
node_modules/
data/*.db
data/*.db-wal
data/*.db-shm
data/backups/
public/downloads/*.apk
.env
*.log
.DS_Store

# Android: исходники коммитим, сборочный мусор — нет
android/.gradle/
android/.idea/
android/build/
android/app/build/
android/capacitor-cordova-android-plugins/build/
android/local.properties
android/*.keystore
android/*.jks
```

- [ ] **Step 3: Убрать `.env` из индекса**

Файл отслеживается и содержит `SESSION_SECRET`. Из истории он вычищается на этапе 5, сейчас достаточно перестать его отслеживать:

```bash
git rm --cached .env
```

- [ ] **Step 4: Написать падающий тест health-эндпоинта**

Создать `test/health.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { startTestServer } = require('./helpers/server');

test('GET /api/health отдаёт ok и версию схемы', async () => {
  const srv = await startTestServer();
  try {
    const res = await fetch(`${srv.url}/api/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.dbWritable, true);
    assert.strictEqual(typeof body.schemaVersion, 'number');
  } finally {
    await srv.close();
  }
});
```

Хелпера `test/helpers/server.js` ещё нет — он появится в Task 2. Тест сейчас упадёт на `require`, это ожидаемо.

- [ ] **Step 5: Убедиться, что тест падает**

Добавить в `package.json` в `scripts`: `"test": "node --test test/"`.

Run: `npm test`
Expected: FAIL, `Cannot find module './helpers/server'`

- [ ] **Step 6: Реализовать роутер**

Создать `server/routes/health.js`:

```js
const express = require('express');
const pkg = require('../../package.json');

module.exports = function healthRouter(db) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    let schemaVersion = 0;
    let dbWritable = false;
    try {
      const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
      schemaVersion = row?.v ?? 0;
      db.prepare('CREATE TABLE IF NOT EXISTS _write_probe (x INTEGER)').run();
      db.prepare('DROP TABLE IF EXISTS _write_probe').run();
      dbWritable = true;
    } catch {
      dbWritable = false;
    }
    res.status(dbWritable ? 200 : 503).json({
      ok: dbWritable,
      schemaVersion,
      dbWritable,
      version: pkg.version,
    });
  });

  return router;
};
```

- [ ] **Step 7: Не запускать тест — он ждёт Task 2**

Тест останется красным до конца Task 2. Это единственное место в плане, где такое допускается, потому что харнесс и первый использующий его тест разделены намеренно: харнесс без потребителя нечем проверить.

- [ ] **Step 8: Коммит**

```bash
git add .gitignore package.json server/routes/health.js test/health.test.js
git commit -m "chore: гигиена репозитория, скрипт тестов, заготовка /api/health"
```

---

### Task 2: Фабрики `createDb`/`createApp`, ранер миграций, тестовый харнесс

**Files:**
- Create: `server/config.js`
- Create: `server/db/index.js`
- Create: `server/db/migrations/index.js`
- Create: `server/db/migrations/001-baseline.js`
- Create: `server/app.js`
- Create: `test/helpers/server.js`
- Create: `test/migrations.test.js`
- Modify: `server/index.js` (сводится к запуску)
- Delete: `server/db.js`

**Interfaces:**
- Produces:
  - `createDb(dbPath) → Database` — открывает SQLite, ставит pragma, **не** применяет миграции
  - `runMigrations(db) → { from: number, to: number, applied: string[] }`
  - `createApp({ db, config }) → express.Application`
  - `loadConfig(env = process.env) → config` с полями `port, dbPath, sessionSecret, appUrl, nodeEnv, smtp: {host, port, user, pass, from} | null`
  - `startTestServer({ seed } = {}) → { url, db, config, close() }`

- [ ] **Step 1: Написать падающий тест миграций**

Создать `test/migrations.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createDb } = require('../server/db');
const { runMigrations } = require('../server/db/migrations');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newday-test-'));
  return { file: path.join(dir, 'test.db'), dir };
}

test('миграции применяются с нуля и поднимают schema_version', () => {
  const { file } = tmpDb();
  const db = createDb(file);
  const result = runMigrations(db);
  assert.strictEqual(result.from, 0);
  assert.ok(result.to >= 1);
  const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
  assert.strictEqual(v, result.to);
  db.close();
});

test('повторный запуск миграций ничего не меняет', () => {
  const { file } = tmpDb();
  const db = createDb(file);
  const first = runMigrations(db);
  const second = runMigrations(db);
  assert.strictEqual(second.from, first.to);
  assert.strictEqual(second.to, first.to);
  assert.deepStrictEqual(second.applied, []);
  db.close();
});

test('baseline создаёт таблицы users и days', () => {
  const { file } = tmpDb();
  const db = createDb(file);
  runMigrations(db);
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map(r => r.name);
  assert.ok(names.includes('users'));
  assert.ok(names.includes('days'));
  assert.ok(names.includes('schema_version'));
  db.close();
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm test`
Expected: FAIL, `Cannot find module '../server/db'` (сейчас модуль называется `server/db.js` и экспортирует готовый экземпляр, а не фабрику)

- [ ] **Step 3: Реализовать `server/config.js`**

```js
function loadConfig(env = process.env) {
  const smtpHost = env.SMTP_HOST || '';
  return {
    nodeEnv: env.NODE_ENV || 'development',
    port: Number(env.PORT || 3000),
    dbPath: env.DB_PATH || require('node:path').join(__dirname, '../data/newday.db'),
    sessionSecret: env.SESSION_SECRET || 'newday-dev-secret-change-in-production',
    appUrl: (env.APP_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    trustProxy: env.TRUST_PROXY !== '0',
    smtp: smtpHost
      ? {
          host: smtpHost,
          port: Number(env.SMTP_PORT || 465),
          secure: env.SMTP_SECURE !== '0',
          user: env.SMTP_USER || '',
          pass: env.SMTP_PASS || '',
          from: env.SMTP_FROM || env.SMTP_USER || '',
        }
      : null,
  };
}

module.exports = { loadConfig };
```

`smtp: null` — это штатное состояние для self-host без почты, а не ошибка. Подтверждение email в этом режиме отключается (Task 10).

- [ ] **Step 4: Реализовать `server/db/index.js`**

```js
const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

function createDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (dir && dir !== ':memory:' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

module.exports = { createDb };
```

- [ ] **Step 5: Реализовать `server/db/migrations/001-baseline.js`**

Это текущая схема один в один — чтобы на существующей базе миграция 001 отметилась как применённая, ничего не сломав, а на пустой создала то же самое.

```js
module.exports = {
  version: 1,
  name: 'baseline',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT    UNIQUE NOT NULL,
        password_hash TEXT    NOT NULL,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS days (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        date       TEXT    NOT NULL,
        data_json  TEXT    NOT NULL DEFAULT '{}',
        created_at TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, date),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS habits (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,
        title       TEXT    NOT NULL,
        description TEXT    NOT NULL DEFAULT '',
        emoji       TEXT    NOT NULL DEFAULT '',
        is_active   INTEGER NOT NULL DEFAULT 1,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS habit_logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        habit_id   INTEGER NOT NULL,
        date       TEXT    NOT NULL,
        done       INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, habit_id, date),
        FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
        FOREIGN KEY (habit_id) REFERENCES habits(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS sessions (
        sid     TEXT    PRIMARY KEY,
        sess    TEXT    NOT NULL,
        expired INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_days_user_date       ON days(user_id, date);
      CREATE INDEX IF NOT EXISTS idx_habit_logs_user_date ON habit_logs(user_id, date);
      CREATE INDEX IF NOT EXISTS idx_habit_logs_habit     ON habit_logs(habit_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expired     ON sessions(expired);
    `);
  },
};
```

- [ ] **Step 6: Реализовать ранер `server/db/migrations/index.js`**

```js
const MIGRATIONS = [
  require('./001-baseline'),
];

function currentVersion(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  return row?.v ?? 0;
}

function runMigrations(db) {
  const from = currentVersion(db);
  const pending = MIGRATIONS.filter(m => m.version > from).sort((a, b) => a.version - b.version);
  const applied = [];

  for (const m of pending) {
    const tx = db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(m.version, m.name);
    });
    tx();
    applied.push(`${m.version}-${m.name}`);
  }

  return { from, to: currentVersion(db), applied };
}

module.exports = { runMigrations, MIGRATIONS };
```

Каждая миграция идёт в своей транзакции: если одна упала, предыдущие остаются применёнными и повторный запуск продолжит с неё.

- [ ] **Step 7: Реализовать `server/app.js`**

Перенести сюда всё из `server/index.js`, кроме `listen`. `SQLiteStore` вынести в `server/lib/session-store.js` и параметризовать экземпляром базы.

```js
const express = require('express');
const session = require('express-session');
const path = require('node:path');
const createSessionStore = require('./lib/session-store');
const healthRouter = require('./routes/health');

function createApp({ db, config }) {
  const app = express();

  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  const SQLiteStore = createSessionStore(session, db);
  app.use(session({
    store: new SQLiteStore(),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  }));

  app.use('/api/health', healthRouter(db));
  app.use(express.static(path.join(__dirname, '../public')));

  app.locals.db = db;
  app.locals.config = config;
  return app;
}

module.exports = { createApp };
```

`secure: config.nodeEnv === 'production'` вместе с `trust proxy` — это починка текущего `secure: false` за HTTPS-прокси.

- [ ] **Step 8: Свести `server/index.js` к запуску**

```js
require('dotenv').config();
const { loadConfig } = require('./config');
const { createDb } = require('./db');
const { runMigrations } = require('./db/migrations');
const { createApp } = require('./app');

const config = loadConfig();
const db = createDb(config.dbPath);
const migrated = runMigrations(db);
console.log(`NewDay schema ${migrated.from} → ${migrated.to}` +
  (migrated.applied.length ? ` (${migrated.applied.join(', ')})` : ''));

const app = createApp({ db, config });
app.listen(config.port, '0.0.0.0', () => {
  console.log(`NewDay listening on port ${config.port}`);
});
```

Удалить `server/db.js`. Все модули, которые делали `require('../db')` и получали экземпляр, будут переписаны на приём `db` параметром в Task 5-6; до тех пор старые роуты из `server/routes/` не подключены в `createApp` — они возвращаются как legacy-алиасы в Task 14.

- [ ] **Step 9: Реализовать `test/helpers/server.js`**

```js
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createDb } = require('../../server/db');
const { runMigrations } = require('../../server/db/migrations');
const { createApp } = require('../../server/app');
const { loadConfig } = require('../../server/config');

async function startTestServer({ env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newday-test-'));
  const dbPath = path.join(dir, 'test.db');
  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: '0',
    DB_PATH: dbPath,
    SESSION_SECRET: 'test-secret-not-used-in-production-000',
    APP_URL: 'http://127.0.0.1',
    TRUST_PROXY: '0',
    ...env,
  });

  const db = createDb(dbPath);
  runMigrations(db);
  const app = createApp({ db, config });

  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url, db, config, app,
    async close() {
      await new Promise(r => server.close(r));
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { startTestServer };
```

- [ ] **Step 10: Прогнать тесты**

Run: `npm test`
Expected: PASS — `test/migrations.test.js` (3 теста) и `test/health.test.js` (1 тест)

- [ ] **Step 11: Коммит**

```bash
git add server/ test/ package.json
git rm server/db.js
git commit -m "refactor: фабрики createDb/createApp, ранер миграций, тестовый харнесс"
```

---

### Task 3: `server/lib/dates.js` — даты и время в таймзоне пользователя

**Files:**
- Create: `server/lib/dates.js`
- Test: `test/lib/dates.test.js`

**Interfaces:**
- Produces:
  - `todayFor(timezone, now = new Date()) → 'YYYY-MM-DD'`
  - `addDays(dateStr, n) → 'YYYY-MM-DD'`
  - `rangeDates(fromStr, toStr) → string[]` (включительно с обоих концов, пусто если `from > to`)
  - `weekdayOf(dateStr) → 1..7` (1 = понедельник)
  - `isValidDate(str) → boolean`
  - `parseTimeToMinutes(str) → number | null` — понимает `9`, `9:30`, `930`, `9.30`, `09:05`
  - `formatMinutes(min) → 'HH:MM'`
  - `parseTimeRange(str) → { startMin, endMin, display } | null`
  - `MASK_ALL = 127`, `weekdayInMask(dateStr, mask) → boolean`

Это тот самый модуль, который закрывает баг №4 из спеки. Вся серверная логика «сегодня» ходит только сюда.

- [ ] **Step 1: Написать падающие тесты**

Создать `test/lib/dates.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const d = require('../../server/lib/dates');

test('todayFor учитывает таймзону, а не UTC', () => {
  // 2026-08-03T22:30:00Z — в Москве уже 4 августа, в Лос-Анджелесе ещё 3-е
  const at = new Date('2026-08-03T22:30:00Z');
  assert.strictEqual(d.todayFor('Europe/Moscow', at), '2026-08-04');
  assert.strictEqual(d.todayFor('America/Los_Angeles', at), '2026-08-03');
  assert.strictEqual(d.todayFor('UTC', at), '2026-08-03');
});

test('todayFor: полночь по Москве — это уже новый день', () => {
  // 2026-08-03T21:00:00Z = 2026-08-04 00:00 МСК
  const at = new Date('2026-08-03T21:00:00Z');
  assert.strictEqual(d.todayFor('Europe/Moscow', at), '2026-08-04');
});

test('addDays переходит через границы месяца и года', () => {
  assert.strictEqual(d.addDays('2026-08-31', 1), '2026-09-01');
  assert.strictEqual(d.addDays('2026-01-01', -1), '2025-12-31');
  assert.strictEqual(d.addDays('2024-02-28', 1), '2024-02-29');
  assert.strictEqual(d.addDays('2026-08-03', 0), '2026-08-03');
});

test('rangeDates включает оба конца и пуст при from > to', () => {
  assert.deepStrictEqual(d.rangeDates('2026-08-01', '2026-08-03'),
    ['2026-08-01', '2026-08-02', '2026-08-03']);
  assert.deepStrictEqual(d.rangeDates('2026-08-03', '2026-08-03'), ['2026-08-03']);
  assert.deepStrictEqual(d.rangeDates('2026-08-04', '2026-08-03'), []);
});

test('weekdayOf: понедельник = 1, воскресенье = 7', () => {
  assert.strictEqual(d.weekdayOf('2026-08-03'), 1); // понедельник
  assert.strictEqual(d.weekdayOf('2026-08-09'), 7); // воскресенье
});

test('weekdayInMask', () => {
  const MON = 1 << 0, SUN = 1 << 6;
  assert.strictEqual(d.weekdayInMask('2026-08-03', MON), true);
  assert.strictEqual(d.weekdayInMask('2026-08-03', SUN), false);
  assert.strictEqual(d.weekdayInMask('2026-08-03', d.MASK_ALL), true);
});

test('parseTimeToMinutes принимает бытовые форматы', () => {
  assert.strictEqual(d.parseTimeToMinutes('9'), 540);
  assert.strictEqual(d.parseTimeToMinutes('9:30'), 570);
  assert.strictEqual(d.parseTimeToMinutes('930'), 570);
  assert.strictEqual(d.parseTimeToMinutes('9.30'), 570);
  assert.strictEqual(d.parseTimeToMinutes('09:05'), 545);
  assert.strictEqual(d.parseTimeToMinutes('23:59'), 1439);
  assert.strictEqual(d.parseTimeToMinutes('24:00'), null);
  assert.strictEqual(d.parseTimeToMinutes('9:60'), null);
  assert.strictEqual(d.parseTimeToMinutes('абв'), null);
  assert.strictEqual(d.parseTimeToMinutes(''), null);
});

test('formatMinutes', () => {
  assert.strictEqual(d.formatMinutes(0), '00:00');
  assert.strictEqual(d.formatMinutes(545), '09:05');
  assert.strictEqual(d.formatMinutes(1439), '23:59');
});

test('parseTimeRange понимает дефис и тире', () => {
  assert.deepStrictEqual(d.parseTimeRange('9:00-13:00'),
    { startMin: 540, endMin: 780, display: '09:00–13:00' });
  assert.deepStrictEqual(d.parseTimeRange('6–6:30'),
    { startMin: 360, endMin: 390, display: '06:00–06:30' });
  assert.strictEqual(d.parseTimeRange('9:00').endMin, null);
  assert.strictEqual(d.parseTimeRange('').startMin ?? null, null);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node --test test/lib/dates.test.js`
Expected: FAIL, `Cannot find module '../../server/lib/dates'`

- [ ] **Step 3: Реализовать модуль**

Создать `server/lib/dates.js`:

```js
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MASK_ALL = 127;

const fmtCache = new Map();
function formatter(timeZone) {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

function isValidDate(str) {
  if (typeof str !== 'string' || !DATE_RE.test(str)) return false;
  const [y, m, d] = str.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function todayFor(timeZone, now = new Date()) {
  try {
    return formatter(timeZone || 'UTC').format(now); // en-CA даёт YYYY-MM-DD
  } catch {
    return formatter('UTC').format(now);
  }
}

// Арифметика ведётся в UTC-полдень: DST не может сдвинуть дату.
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, 12));
  t.setUTCDate(t.getUTCDate() + n);
  const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(t.getUTCDate()).padStart(2, '0');
  return `${t.getUTCFullYear()}-${mm}-${dd}`;
}

function rangeDates(from, to) {
  if (!isValidDate(from) || !isValidDate(to) || from > to) return [];
  const out = [];
  let cur = from;
  while (cur <= to) { out.push(cur); cur = addDays(cur, 1); }
  return out;
}

function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const js = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0 = воскресенье
  return js === 0 ? 7 : js;
}

function weekdayInMask(dateStr, mask) {
  return ((mask ?? MASK_ALL) & (1 << (weekdayOf(dateStr) - 1))) !== 0;
}

function parseTimeToMinutes(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  let h, min;
  let m = s.match(/^(\d{1,2})[:.\s](\d{2})$/);
  if (m) { h = +m[1]; min = +m[2]; }
  else if ((m = s.match(/^(\d{3,4})$/))) {
    const v = m[1];
    h = +v.slice(0, v.length - 2);
    min = +v.slice(-2);
  }
  else if ((m = s.match(/^(\d{1,2})$/))) { h = +m[1]; min = 0; }
  else return null;
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function formatMinutes(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseTimeRange(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const parts = input.trim().split(/\s*[–—\-]\s*/);
  const startMin = parseTimeToMinutes(parts[0]);
  if (startMin === null) return null;
  if (parts.length === 1) {
    return { startMin, endMin: null, display: formatMinutes(startMin) };
  }
  const endMin = parseTimeToMinutes(parts[1]);
  if (endMin === null) return null;
  return { startMin, endMin, display: `${formatMinutes(startMin)}–${formatMinutes(endMin)}` };
}

module.exports = {
  MASK_ALL, isValidDate, todayFor, addDays, rangeDates,
  weekdayOf, weekdayInMask, parseTimeToMinutes, formatMinutes, parseTimeRange,
};
```

Старое эвристическое «доопределение» вечернего часа (`6-9` → `18:00–21:00`) из `server/routes/days.js:68-77` **не переносится**: оно угадывало и иногда угадывало неверно. Пользователь вводит время явно.

- [ ] **Step 4: Прогнать тесты**

Run: `node --test test/lib/dates.test.js`
Expected: PASS, 10 тестов

- [ ] **Step 5: Коммит**

```bash
git add server/lib/dates.js test/lib/dates.test.js
git commit -m "feat: модуль дат с корректной таймзоной пользователя"
```

---

### Task 4: Миграция 002 — нормализация схемы и перенос `data_json`

**Files:**
- Create: `server/db/migrations/002-normalize.js`
- Modify: `server/db/migrations/index.js:1-3` (добавить в список)
- Test: `test/migrations-002.test.js`

**Interfaces:**
- Produces: полная схема из §4.1 спеки. Таблицы `users` (расширена), `email_tokens`, `api_tokens`, `devices`, `pair_codes`, `days` (расширена), `schedule_items`, `tasks`, `meals`, `sport_sets`, `series`, `series_overrides`, `habits` (расширена), `habit_logs` (`status` вместо `done`), `user_settings`, `push_subscriptions`, `notification_queue`.

- [ ] **Step 1: Написать падающий тест переноса данных**

Создать `test/migrations-002.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createDb } = require('../server/db');
const { runMigrations, MIGRATIONS } = require('../server/db/migrations');
const m001 = require('../server/db/migrations/001-baseline');

function dbWithLegacyData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newday-mig-'));
  const db = createDb(path.join(dir, 'test.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  m001.up(db);
  db.prepare('INSERT INTO schema_version (version, name) VALUES (1, ?)').run('baseline');

  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (1, ?, ?)')
    .run('dan', 'hash');
  db.prepare('INSERT INTO days (user_id, date, data_json) VALUES (1, ?, ?)').run(
    '2026-08-03',
    JSON.stringify({
      date: '2026-08-03',
      title: 'Понедельник',
      focus: 'Закрыть отчёт',
      weight: 78.4,
      notes: 'заметка',
      schedule: [
        { time: '09:00–13:00', action: 'Работа', done: true },
        { time: '13:00–14:00', action: 'Обед', done: false },
      ],
      workTasks: [{ text: 'Созвон', done: false, carriedFrom: '2026-08-02' }],
      homeTasks: [{ text: 'Посуда', done: true }],
      sport: [{ exercise: 'Приседания', sets: 3, reps: 15, done: true }],
    })
  );
  db.prepare('INSERT INTO habits (id, user_id, title, emoji) VALUES (1, 1, ?, ?)')
    .run('Вода', '💧');
  db.prepare('INSERT INTO habit_logs (user_id, habit_id, date, done) VALUES (1, 1, ?, 1)')
    .run('2026-08-03');
  db.prepare('INSERT INTO habit_logs (user_id, habit_id, date, done) VALUES (1, 1, ?, 0)')
    .run('2026-08-02');
  return db;
}

test('002 раскладывает data_json по таблицам', () => {
  const db = dbWithLegacyData();
  runMigrations(db);

  const day = db.prepare('SELECT * FROM days WHERE user_id = 1 AND date = ?').get('2026-08-03');
  assert.strictEqual(day.title, 'Понедельник');
  assert.strictEqual(day.focus, 'Закрыть отчёт');
  assert.strictEqual(day.weight, 78.4);
  assert.strictEqual(day.notes, 'заметка');
  assert.ok(day.legacy_json, 'исходный блоб сохранён');
  assert.strictEqual(day.rev, 1);

  const sched = db.prepare(
    'SELECT * FROM schedule_items WHERE user_id = 1 AND date = ? ORDER BY start_min'
  ).all('2026-08-03');
  assert.strictEqual(sched.length, 2);
  assert.strictEqual(sched[0].start_min, 540);
  assert.strictEqual(sched[0].end_min, 780);
  assert.strictEqual(sched[0].title, 'Работа');
  assert.strictEqual(sched[0].done, 1);
  assert.strictEqual(sched[0].alarm_mode, 'none');

  const work = db.prepare(
    "SELECT * FROM tasks WHERE user_id = 1 AND date = ? AND bucket = 'work'"
  ).all('2026-08-03');
  assert.strictEqual(work.length, 1);
  assert.strictEqual(work[0].text, 'Созвон');
  assert.strictEqual(work[0].carried_from, '2026-08-02');

  const home = db.prepare(
    "SELECT * FROM tasks WHERE user_id = 1 AND date = ? AND bucket = 'home'"
  ).all('2026-08-03');
  assert.strictEqual(home.length, 1);
  assert.strictEqual(home[0].done, 1);

  const sport = db.prepare('SELECT * FROM sport_sets WHERE user_id = 1').all();
  assert.strictEqual(sport.length, 1);
  assert.strictEqual(sport[0].exercise, 'Приседания');
  assert.strictEqual(sport[0].sets, 3);
  db.close();
});

test('002 переводит habit_logs.done в status', () => {
  const db = dbWithLegacyData();
  runMigrations(db);
  const logs = db.prepare('SELECT date, status FROM habit_logs ORDER BY date').all();
  assert.deepStrictEqual(logs, [
    { date: '2026-08-02', status: 'missed' },
    { date: '2026-08-03', status: 'done' },
  ]);
  db.close();
});

test('002 добавляет пользователю таймзону и настройки по умолчанию', () => {
  const db = dbWithLegacyData();
  runMigrations(db);
  const u = db.prepare('SELECT * FROM users WHERE id = 1').get();
  assert.strictEqual(u.timezone, 'Europe/Moscow');
  assert.strictEqual(u.theme, 'system');
  assert.strictEqual(u.food_mode, 'checklist');
  assert.strictEqual(u.schedule_view, 'list');
  assert.strictEqual(u.email, null, 'legacy-пользователь остаётся без почты');
  assert.strictEqual(u.username, 'dan');
  db.close();
});

test('002 идемпотентна и не дублирует строки при повторном прогоне', () => {
  const db = dbWithLegacyData();
  runMigrations(db);
  runMigrations(db);
  const n = db.prepare('SELECT COUNT(*) AS c FROM schedule_items').get().c;
  assert.strictEqual(n, 2);
  db.close();
});

test('002 не падает на битом data_json', () => {
  const db = dbWithLegacyData();
  db.prepare('INSERT INTO days (user_id, date, data_json) VALUES (1, ?, ?)')
    .run('2026-08-04', '{не json');
  assert.doesNotThrow(() => runMigrations(db));
  const day = db.prepare('SELECT * FROM days WHERE date = ?').get('2026-08-04');
  assert.ok(day, 'день остался, просто без разбора');
  db.close();
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node --test test/migrations-002.test.js`
Expected: FAIL, `no such column: focus`

- [ ] **Step 3: Реализовать `002-normalize.js` — часть 1, новые колонки существующих таблиц**

```js
const { parseTimeRange } = require('../../lib/dates');

function addColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

module.exports = {
  version: 2,
  name: 'normalize',
  up(db) {
    // users
    addColumn(db, 'users', 'email',          "email TEXT");
    addColumn(db, 'users', 'email_verified', "email_verified INTEGER NOT NULL DEFAULT 0");
    addColumn(db, 'users', 'display_name',   "display_name TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'users', 'timezone',       "timezone TEXT NOT NULL DEFAULT 'Europe/Moscow'");
    addColumn(db, 'users', 'theme',          "theme TEXT NOT NULL DEFAULT 'system'");
    addColumn(db, 'users', 'week_start',     "week_start INTEGER NOT NULL DEFAULT 1");
    addColumn(db, 'users', 'schedule_view',  "schedule_view TEXT NOT NULL DEFAULT 'list'");
    addColumn(db, 'users', 'food_mode',      "food_mode TEXT NOT NULL DEFAULT 'checklist'");
    addColumn(db, 'users', 'is_admin',       "is_admin INTEGER NOT NULL DEFAULT 0");
    addColumn(db, 'users', 'updated_at',     "updated_at TEXT NOT NULL DEFAULT (datetime('now'))");
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL');

    // days
    addColumn(db, 'days', 'title',       "title TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'days', 'focus',       "focus TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'days', 'weight',      "weight REAL");
    addColumn(db, 'days', 'notes',       "notes TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'days', 'rev',         "rev INTEGER NOT NULL DEFAULT 1");
    addColumn(db, 'days', 'legacy_json', "legacy_json TEXT");

    // habits
    addColumn(db, 'habits', 'color',                 "color TEXT NOT NULL DEFAULT 'blue'");
    addColumn(db, 'habits', 'type',                  "type TEXT NOT NULL DEFAULT 'binary'");
    addColumn(db, 'habits', 'target_per_day',        "target_per_day INTEGER");
    addColumn(db, 'habits', 'unit',                  "unit TEXT");
    addColumn(db, 'habits', 'schedule_mask',         "schedule_mask INTEGER NOT NULL DEFAULT 127");
    addColumn(db, 'habits', 'polarity',              "polarity TEXT NOT NULL DEFAULT 'do'");
    addColumn(db, 'habits', 'mode',                  "mode TEXT NOT NULL DEFAULT 'ongoing'");
    addColumn(db, 'habits', 'challenge_target_days', "challenge_target_days INTEGER");
    addColumn(db, 'habits', 'challenge_start_date',  "challenge_start_date TEXT");
    addColumn(db, 'habits', 'break_policy',          "break_policy TEXT NOT NULL DEFAULT 'reset'");
    addColumn(db, 'habits', 'allowed_skips_per_week',"allowed_skips_per_week INTEGER NOT NULL DEFAULT 0");
    addColumn(db, 'habits', 'archived_at',           "archived_at TEXT");

    // habit_logs: done → status
    addColumn(db, 'habit_logs', 'status', "status TEXT NOT NULL DEFAULT 'done'");
    addColumn(db, 'habit_logs', 'value',  "value INTEGER");
    const hlCols = db.prepare('PRAGMA table_info(habit_logs)').all().map(c => c.name);
    if (hlCols.includes('done')) {
      db.exec("UPDATE habit_logs SET status = CASE WHEN done = 1 THEN 'done' ELSE 'missed' END");
    }
    // колонку done не удаляем: SQLite DROP COLUMN капризен, а лишний столбец безвреден
```

- [ ] **Step 4: Реализовать `002-normalize.js` — часть 2, новые таблицы**

Продолжение того же `up(db)`:

```js
    db.exec(`
      CREATE TABLE IF NOT EXISTS schedule_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, date TEXT NOT NULL,
        start_min INTEGER NOT NULL, end_min INTEGER,
        title TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
        done INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL DEFAULT 'normal',
        alarm_mode TEXT NOT NULL DEFAULT 'none',
        alarm_profile TEXT NOT NULL DEFAULT 'gentle',
        remind_before_min INTEGER,
        series_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, date TEXT NOT NULL,
        bucket TEXT NOT NULL DEFAULT 'work',
        text TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0, carried_from TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS meals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, date TEXT NOT NULL,
        slot TEXT NOT NULL DEFAULT 'other', time_min INTEGER,
        title TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
        done INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS sport_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, date TEXT NOT NULL,
        exercise TEXT NOT NULL DEFAULT '', sets INTEGER, reps INTEGER, weight REAL,
        done INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS series (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, target TEXT NOT NULL,
        freq TEXT NOT NULL DEFAULT 'daily', interval INTEGER NOT NULL DEFAULT 1,
        byweekday INTEGER NOT NULL DEFAULT 127,
        start_date TEXT, end_date TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}', name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS series_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, series_id INTEGER NOT NULL,
        date TEXT NOT NULL, action TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(series_id, date),
        FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS email_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, kind TEXT NOT NULL,
        token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS api_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '',
        prefix TEXT NOT NULL, token_hash TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'read',
        last_used_at TEXT, revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL DEFAULT '', prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS pair_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, code_hash TEXT NOT NULL,
        short_code TEXT NOT NULL, expires_at INTEGER NOT NULL, claimed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY (user_id, key),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS notification_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, dedupe_key TEXT NOT NULL,
        fire_at_utc INTEGER NOT NULL, payload_json TEXT NOT NULL,
        sent_at TEXT, failed_at TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        UNIQUE(user_id, dedupe_key),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sched_user_date ON schedule_items(user_id, date);
      CREATE INDEX IF NOT EXISTS idx_tasks_user_date ON tasks(user_id, date, bucket);
      CREATE INDEX IF NOT EXISTS idx_meals_user_date ON meals(user_id, date);
      CREATE INDEX IF NOT EXISTS idx_sport_user_date ON sport_sets(user_id, date);
      CREATE INDEX IF NOT EXISTS idx_series_user      ON series(user_id, target);
      CREATE INDEX IF NOT EXISTS idx_nq_fire          ON notification_queue(fire_at_utc, sent_at);
      CREATE INDEX IF NOT EXISTS idx_apitok_prefix    ON api_tokens(prefix);
      CREATE INDEX IF NOT EXISTS idx_dev_prefix       ON devices(prefix);
    `);
```

- [ ] **Step 5: Реализовать `002-normalize.js` — часть 3, перенос `data_json`**

Завершение `up(db)`:

```js
    const rows = db.prepare(
      "SELECT id, user_id, date, data_json FROM days WHERE legacy_json IS NULL AND data_json IS NOT NULL AND data_json != '{}'"
    ).all();

    const upDay = db.prepare(
      'UPDATE days SET title=?, focus=?, weight=?, notes=?, legacy_json=? WHERE id=?'
    );
    const insSched = db.prepare(`INSERT INTO schedule_items
      (user_id, date, start_min, end_min, title, note, done, sort_order)
      VALUES (?,?,?,?,?,?,?,?)`);
    const insTask = db.prepare(`INSERT INTO tasks
      (user_id, date, bucket, text, done, sort_order, carried_from) VALUES (?,?,?,?,?,?,?)`);
    const insSport = db.prepare(`INSERT INTO sport_sets
      (user_id, date, exercise, sets, reps, done, sort_order) VALUES (?,?,?,?,?,?,?)`);

    for (const row of rows) {
      let d;
      try { d = JSON.parse(row.data_json); } catch { continue; }
      if (!d || typeof d !== 'object') continue;

      upDay.run(
        String(d.title ?? ''), String(d.focus ?? ''),
        typeof d.weight === 'number' ? d.weight : null,
        String(d.notes ?? ''), row.data_json, row.id
      );

      if (Array.isArray(d.schedule)) {
        d.schedule.forEach((s, i) => {
          const r = parseTimeRange(String(s.time ?? ''));
          insSched.run(row.user_id, row.date,
            r ? r.startMin : 0, r ? r.endMin : null,
            String(s.action ?? s.title ?? ''), String(s.note ?? ''),
            s.done ? 1 : 0, i);
        });
      }
      for (const [field, bucket] of [['workTasks', 'work'], ['homeTasks', 'home']]) {
        if (!Array.isArray(d[field])) continue;
        d[field].forEach((t, i) => {
          insTask.run(row.user_id, row.date, bucket,
            String(t.text ?? ''), t.done ? 1 : 0, i, t.carriedFrom ?? null);
        });
      }
      if (Array.isArray(d.sport)) {
        d.sport.forEach((s, i) => {
          insSport.run(row.user_id, row.date, String(s.exercise ?? ''),
            Number.isFinite(+s.sets) ? +s.sets : null,
            Number.isFinite(+s.reps) ? +s.reps : null,
            s.done ? 1 : 0, i);
        });
      }
    }
  },
};
```

Условие `WHERE legacy_json IS NULL` — это и есть защита от повторного прогона: уже разобранные дни второй раз не берутся.

- [ ] **Step 6: Зарегистрировать миграцию**

В `server/db/migrations/index.js` заменить список:

```js
const MIGRATIONS = [
  require('./001-baseline'),
  require('./002-normalize'),
];
```

- [ ] **Step 7: Прогнать тесты**

Run: `npm test`
Expected: PASS — 5 тестов в `migrations-002.test.js` плюс всё, что было раньше

- [ ] **Step 8: Коммит**

```bash
git add server/db/migrations/ test/migrations-002.test.js
git commit -m "feat: миграция 002 — нормализация схемы и перенос data_json"
```

---

Оставшиеся задачи этапа 1 (5-14) описаны во второй половине плана: `docs/superpowers/plans/2026-08-03-stage1-foundation-part2.md`.
