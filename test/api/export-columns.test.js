/**
 * Ни одна колонка не теряется при восстановлении из выгрузки.
 *
 * Выгрузка перечисляет колонки руками, и это ловушка: миграция добавляет
 * поле, а список забывают. Так уже случилось дважды — «reps_max» (верх
 * вилки «3×8–12») и «food_plan» (план питания дня) не переживали
 * восстановление собственной резервной копии, и заметить это можно было
 * только по памяти, уже после потери.
 *
 * Тест сверяет схему базы со списками в маршруте выгрузки, поэтому ловит
 * следующий такой промах в день его появления.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createDb } = require('../../server/db');
const { runMigrations } = require('../../server/db/migrations');
const { tmpDatabase } = require('../helpers/server');

/** Поля, которые переносить не нужно: их выдаёт сама база при вставке. */
const СЛУЖЕБНЫЕ = new Set([
  'id', 'user_id', 'created_at', 'updated_at',
  'source', 'external_id', 'last_modified_by',
  'data_json', 'legacy_json', 'rev',
]);

/** Колонки, для которых отсутствие в выгрузке — осознанное решение. */
const НАРОЧНО = {
  // «done» у отметки привычки заменён на «status» ещё миграцией 002
  habit_logs: new Set(['done']),
};

const ТАБЛИЦЫ = ['days', 'schedule_items', 'tasks', 'meals', 'sport_sets',
  'habits', 'habit_logs', 'series', 'series_overrides'];

test('каждая колонка попадает и в выгрузку, и в восстановление', () => {
  const { file, cleanup } = tmpDatabase();
  const db = createDb(file);
  try {
    runMigrations(db);
    const src = fs.readFileSync(path.join(__dirname, '../../server/routes/v1/export.js'), 'utf8');

    for (const таблица of ТАБЛИЦЫ) {
      const выбор = [...src.matchAll(new RegExp(`SELECT([\\s\\S]*?)FROM ${таблица}\\b`, 'g'))]
        .map(m => m[1]).join(' ');
      const вставка = [...src.matchAll(new RegExp(`INSERT(?: OR REPLACE)? INTO ${таблица}\\s*\\(([\\s\\S]*?)\\)`, 'g'))]
        .map(m => m[1]).join(' ');
      const колонки = db.prepare(`PRAGMA table_info(${таблица})`).all()
        .map(c => c.name)
        .filter(c => !СЛУЖЕБНЫЕ.has(c) && !(НАРОЧНО[таблица]?.has(c)));

      for (const колонка of колонки) {
        const есть = т => new RegExp(`\\b${колонка}\\b`).test(т);
        assert.ok(есть(выбор), `${таблица}.${колонка} не попадает в выгрузку`);
        assert.ok(есть(вставка), `${таблица}.${колонка} не восстанавливается из выгрузки`);
      }
    }
  } finally {
    db.close();
    try { cleanup(); } catch { /* каталог занят — уберётся при следующем запуске */ }
  }
});
