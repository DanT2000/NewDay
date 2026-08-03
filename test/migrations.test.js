const test = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../server/db');
const { runMigrations } = require('../server/db/migrations');
const { tmpDatabase } = require('./helpers/server');

test('миграции применяются с нуля и поднимают schema_version', () => {
  const t = tmpDatabase();
  const db = createDb(t.file);
  try {
    const result = runMigrations(db);
    assert.strictEqual(result.from, 0);
    assert.ok(result.to >= 1);
    const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
    assert.strictEqual(v, result.to);
  } finally { db.close(); t.cleanup(); }
});

test('повторный запуск миграций ничего не меняет', () => {
  const t = tmpDatabase();
  const db = createDb(t.file);
  try {
    const first = runMigrations(db);
    const second = runMigrations(db);
    assert.strictEqual(second.from, first.to);
    assert.strictEqual(second.to, first.to);
    assert.deepStrictEqual(second.applied, []);
  } finally { db.close(); t.cleanup(); }
});

test('baseline создаёт таблицы users и days', () => {
  const t = tmpDatabase();
  const db = createDb(t.file);
  try {
    runMigrations(db);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map(r => r.name);
    assert.ok(names.includes('users'));
    assert.ok(names.includes('days'));
    assert.ok(names.includes('schema_version'));
  } finally { db.close(); t.cleanup(); }
});
