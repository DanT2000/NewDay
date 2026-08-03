const test = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../../server/db');
const { runMigrations } = require('../../server/db/migrations');
const { tmpDatabase } = require('../helpers/server');
const { daysRepo, bumpRev } = require('../../server/repos/days');
const { scheduleRepo } = require('../../server/repos/schedule');
const { tasksRepo } = require('../../server/repos/tasks');

function fixture() {
  const t = tmpDatabase();
  const db = createDb(t.file);
  runMigrations(db);
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (1, ?, ?)').run('a', 'x');
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (2, ?, ?)').run('b', 'x');
  return { db, cleanup: () => { try { db.close(); } catch {} t.cleanup(); } };
}

test('bumpRev создаёт день и увеличивает rev', () => {
  const { db, cleanup } = fixture();
  try {
    assert.strictEqual(bumpRev(db, 1, '2026-08-03'), 2);
    assert.strictEqual(bumpRev(db, 1, '2026-08-03'), 3);
  } finally { cleanup(); }
});

test('правка вложенной сущности поднимает rev дня', () => {
  const { db, cleanup } = fixture();
  try {
    const days = daysRepo(db);
    const sched = scheduleRepo(db);
    days.ensure(1, '2026-08-03');
    const before = days.get(1, '2026-08-03').rev;
    sched.create(1, '2026-08-03', { startMin: 540, title: 'Работа' });
    assert.strictEqual(days.get(1, '2026-08-03').rev, before + 1);
  } finally { cleanup(); }
});

test('нельзя тронуть чужую строку', () => {
  const { db, cleanup } = fixture();
  try {
    const sched = scheduleRepo(db);
    const row = sched.create(1, '2026-08-03', { startMin: 540, title: 'Моё' });
    assert.throws(() => sched.update(2, row.id, { title: 'Взлом' }), /NOT_FOUND/);
    assert.throws(() => sched.remove(2, row.id), /NOT_FOUND/);
    assert.strictEqual(sched.getById(1, row.id).title, 'Моё');
  } finally { cleanup(); }
});

test('update с устаревшим updatedAt даёт STALE_ROW', () => {
  const { db, cleanup } = fixture();
  try {
    const sched = scheduleRepo(db);
    const row = sched.create(1, '2026-08-03', { startMin: 540, title: 'Работа' });
    // сдвигаем updated_at вручную: datetime('now') в SQLite имеет секундную точность
    db.prepare("UPDATE schedule_items SET updated_at = '2030-01-01 00:00:00' WHERE id = ?").run(row.id);
    assert.throws(
      () => sched.update(1, row.id, { title: 'Гонка', updatedAt: row.updated_at }),
      /STALE_ROW/
    );
  } finally { cleanup(); }
});

test('shift сдвигает строку и все последующие', () => {
  const { db, cleanup } = fixture();
  try {
    const sched = scheduleRepo(db);
    sched.create(1, '2026-08-03', { startMin: 540, endMin: 600, title: 'A' });
    const b = sched.create(1, '2026-08-03', { startMin: 600, endMin: 660, title: 'B' });
    sched.create(1, '2026-08-03', { startMin: 660, endMin: 720, title: 'C' });
    sched.shift(1, '2026-08-03', b.id, 15, true);
    const rows = sched.list(1, '2026-08-03');
    assert.deepStrictEqual(rows.map(r => r.start_min), [540, 615, 675]);
    assert.deepStrictEqual(rows.map(r => r.end_min), [600, 675, 735]);
  } finally { cleanup(); }
});

test('shift без cascade двигает только одну строку', () => {
  const { db, cleanup } = fixture();
  try {
    const sched = scheduleRepo(db);
    sched.create(1, '2026-08-03', { startMin: 540, endMin: 600, title: 'A' });
    const b = sched.create(1, '2026-08-03', { startMin: 600, endMin: 660, title: 'B' });
    sched.create(1, '2026-08-03', { startMin: 660, endMin: 720, title: 'C' });
    sched.shift(1, '2026-08-03', b.id, 15, false);
    assert.deepStrictEqual(sched.list(1, '2026-08-03').map(r => r.start_min), [540, 615, 660]);
  } finally { cleanup(); }
});

test('сдвиг не может уехать за границы суток', () => {
  const { db, cleanup } = fixture();
  try {
    const sched = scheduleRepo(db);
    const a = sched.create(1, '2026-08-03', { startMin: 1430, endMin: 1439, title: 'Поздно' });
    assert.throws(() => sched.shift(1, '2026-08-03', a.id, 60, false), /OUT_OF_RANGE/);
    // ничего не изменилось
    assert.strictEqual(sched.getById(1, a.id).start_min, 1430);
  } finally { cleanup(); }
});

test('список расписания отсортирован по времени независимо от порядка вставки', () => {
  const { db, cleanup } = fixture();
  try {
    const sched = scheduleRepo(db);
    sched.create(1, '2026-08-03', { startMin: 780, title: 'Позже' });
    sched.create(1, '2026-08-03', { startMin: 540, title: 'Раньше' });
    assert.deepStrictEqual(sched.list(1, '2026-08-03').map(r => r.title), ['Раньше', 'Позже']);
  } finally { cleanup(); }
});

test('reorder переставляет задачи и не пускает чужие id', () => {
  const { db, cleanup } = fixture();
  try {
    const tasks = tasksRepo(db);
    const a = tasks.create(1, '2026-08-03', { bucket: 'work', text: 'A' });
    const b = tasks.create(1, '2026-08-03', { bucket: 'work', text: 'B' });
    const foreign = tasks.create(2, '2026-08-03', { bucket: 'work', text: 'Чужая' });
    tasks.reorder(1, '2026-08-03', [b.id, a.id]);
    assert.deepStrictEqual(tasks.list(1, '2026-08-03').map(r => r.text), ['B', 'A']);
    assert.throws(() => tasks.reorder(1, '2026-08-03', [foreign.id]), /NOT_FOUND/);
  } finally { cleanup(); }
});

test('удаление дня уносит вложенные сущности', () => {
  const { db, cleanup } = fixture();
  try {
    const days = daysRepo(db);
    const sched = scheduleRepo(db);
    const tasks = tasksRepo(db);
    sched.create(1, '2026-08-03', { startMin: 540, title: 'A' });
    tasks.create(1, '2026-08-03', { text: 'T' });
    days.remove(1, '2026-08-03');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM schedule_items').get().c, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c, 0);
    assert.throws(() => days.remove(1, '2026-08-03'), /NOT_FOUND/);
  } finally { cleanup(); }
});
