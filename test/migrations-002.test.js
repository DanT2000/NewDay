const test = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../server/db');
const { runMigrations } = require('../server/db/migrations');
const m001 = require('../server/db/migrations/001-baseline');
const { tmpDatabase } = require('./helpers/server');

/** База в состоянии «до нормализации», с реальными данными старого формата. */
function dbWithLegacyData() {
  const t = tmpDatabase();
  const db = createDb(t.file);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  m001.up(db);
  db.prepare('INSERT INTO schema_version (version, name) VALUES (1, ?)').run('baseline');

  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (1, ?, ?)').run('dan', 'hash');
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
  db.prepare('INSERT INTO habits (id, user_id, title, emoji) VALUES (1, 1, ?, ?)').run('Вода', '💧');
  db.prepare('INSERT INTO habit_logs (user_id, habit_id, date, done) VALUES (1, 1, ?, 1)').run('2026-08-03');
  db.prepare('INSERT INTO habit_logs (user_id, habit_id, date, done) VALUES (1, 1, ?, 0)').run('2026-08-02');

  return { db, cleanup: () => { try { db.close(); } catch {} t.cleanup(); } };
}

test('002 раскладывает data_json по таблицам', () => {
  const { db, cleanup } = dbWithLegacyData();
  try {
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
    assert.strictEqual(sport[0].reps, 15);
  } finally { cleanup(); }
});

test('002 переводит habit_logs.done в status', () => {
  const { db, cleanup } = dbWithLegacyData();
  try {
    runMigrations(db);
    const logs = db.prepare('SELECT date, status FROM habit_logs ORDER BY date').all();
    assert.deepStrictEqual(logs, [
      { date: '2026-08-02', status: 'missed' },
      { date: '2026-08-03', status: 'done' },
    ]);
  } finally { cleanup(); }
});

test('002 добавляет пользователю таймзону и настройки по умолчанию', () => {
  const { db, cleanup } = dbWithLegacyData();
  try {
    runMigrations(db);
    const u = db.prepare('SELECT * FROM users WHERE id = 1').get();
    assert.strictEqual(u.timezone, 'Europe/Moscow');
    assert.strictEqual(u.theme, 'system');
    assert.strictEqual(u.food_mode, 'checklist');
    assert.strictEqual(u.schedule_view, 'list');
    assert.strictEqual(u.email, null, 'legacy-пользователь остаётся без почты');
    assert.strictEqual(u.username, 'dan');
  } finally { cleanup(); }
});

test('002 идемпотентна и не дублирует строки при повторном прогоне', () => {
  const { db, cleanup } = dbWithLegacyData();
  try {
    runMigrations(db);
    runMigrations(db);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM schedule_items').get().c, 2);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c, 2);
  } finally { cleanup(); }
});

test('002 не падает на битом data_json', () => {
  const { db, cleanup } = dbWithLegacyData();
  try {
    db.prepare('INSERT INTO days (user_id, date, data_json) VALUES (1, ?, ?)')
      .run('2026-08-04', '{не json');
    assert.doesNotThrow(() => runMigrations(db));
    const day = db.prepare('SELECT * FROM days WHERE date = ?').get('2026-08-04');
    assert.ok(day, 'день остался, просто без разбора');
  } finally { cleanup(); }
});

test('002 создаёт все таблицы новой схемы', () => {
  const t = tmpDatabase();
  const db = createDb(t.file);
  try {
    runMigrations(db);
    const names = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    );
    for (const table of [
      'schedule_items', 'tasks', 'meals', 'sport_sets', 'series', 'series_overrides',
      'email_tokens', 'api_tokens', 'devices', 'pair_codes', 'user_settings',
      'push_subscriptions', 'notification_queue',
    ]) {
      assert.ok(names.has(table), `нет таблицы ${table}`);
    }
  } finally { db.close(); t.cleanup(); }
});
