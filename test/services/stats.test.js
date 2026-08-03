const test = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../../server/db');
const { runMigrations } = require('../../server/db/migrations');
const { tmpDatabase } = require('../helpers/server');
const { statsService } = require('../../server/services/statsService');

const USER = { id: 1, timezone: 'Europe/Moscow' };
// «Сегодня» фиксируем, иначе граница «прошедший день / ещё не наступил» плавает
const NOW = new Date('2026-08-10T09:00:00Z');
const stats = db => statsService(db, { now: NOW });

function fixture() {
  const t = tmpDatabase();
  const db = createDb(t.file);
  runMigrations(db);
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (1, ?, ?)').run('a', 'x');
  return { db, cleanup: () => { try { db.close(); } catch {} t.cleanup(); } };
}

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

test('challenge/reset: срыв обнуляет счётчик', () => {
  const { db, cleanup } = fixture();
  try {
    const id = mkHabit(db, {
      mode: 'challenge', break_policy: 'reset',
      challenge_target_days: 30, challenge_start_date: '2026-08-01',
    });
    log(db, id, '2026-08-01', 'done');
    log(db, id, '2026-08-02', 'done');
    log(db, id, '2026-08-03', 'missed');
    log(db, id, '2026-08-04', 'done');

    const s = stats(db).habitStats(USER, id, '2026-08-01', '2026-08-04');
    assert.strictEqual(s.challenge.day, 1, 'после срыва счётчик начался заново');
    assert.strictEqual(s.challenge.target, 30);
    assert.strictEqual(s.currentStreak, 1);
    assert.strictEqual(s.bestStreak, 2);
  } finally { cleanup(); }
});

test('challenge/keep: срыв не обнуляет, но считается', () => {
  const { db, cleanup } = fixture();
  try {
    const id = mkHabit(db, {
      mode: 'challenge', break_policy: 'keep',
      challenge_target_days: 300, challenge_start_date: '2026-08-01',
    });
    log(db, id, '2026-08-01', 'done');
    log(db, id, '2026-08-02', 'missed');
    log(db, id, '2026-08-03', 'done');
    log(db, id, '2026-08-04', 'done');

    const s = stats(db).habitStats(USER, id, '2026-08-01', '2026-08-04');
    assert.strictEqual(s.challenge.day, 3, 'три выполненных дня');
    assert.strictEqual(s.challenge.breaks, 1);
    assert.strictEqual(s.challenge.complete, false);
  } finally { cleanup(); }
});

test('challenge завершается при достижении цели', () => {
  const { db, cleanup } = fixture();
  try {
    const id = mkHabit(db, {
      mode: 'challenge', break_policy: 'keep',
      challenge_target_days: 3, challenge_start_date: '2026-08-01',
    });
    for (const d of ['2026-08-01', '2026-08-02', '2026-08-03']) log(db, id, d, 'done');
    const s = stats(db).habitStats(USER, id, '2026-08-01', '2026-08-03');
    assert.strictEqual(s.challenge.complete, true);
    assert.strictEqual(s.challenge.day, 3);
  } finally { cleanup(); }
});

test('skipped не разрывает стрик и не входит в знаменатель', () => {
  const { db, cleanup } = fixture();
  try {
    const id = mkHabit(db);
    log(db, id, '2026-08-01', 'done');
    log(db, id, '2026-08-02', 'skipped');
    log(db, id, '2026-08-03', 'done');
    const s = stats(db).habitStats(USER, id, '2026-08-01', '2026-08-03');
    assert.strictEqual(s.currentStreak, 2);
    assert.strictEqual(s.percent, 100, 'знаменатель 2, а не 3');
    assert.strictEqual(s.skipped, 1);
  } finally { cleanup(); }
});

test('дни вне schedule_mask не штрафуют и не рвут стрик', () => {
  const { db, cleanup } = fixture();
  try {
    const MON_WED_FRI = (1 << 0) | (1 << 2) | (1 << 4);
    const id = mkHabit(db, { schedule_mask: MON_WED_FRI });
    log(db, id, '2026-08-03', 'done'); // пн
    log(db, id, '2026-08-05', 'done'); // ср
    log(db, id, '2026-08-07', 'done'); // пт
    const s = stats(db).habitStats(USER, id, '2026-08-03', '2026-08-07');
    assert.strictEqual(s.currentStreak, 3, 'вторник и четверг не в счёт');
    assert.strictEqual(s.percent, 100);
    assert.strictEqual(s.missed, 0);
  } finally { cleanup(); }
});

test('polarity=avoid: missed — это срыв, стрик обнуляется', () => {
  const { db, cleanup } = fixture();
  try {
    const id = mkHabit(db, { polarity: 'avoid' });
    log(db, id, '2026-08-01', 'done');
    log(db, id, '2026-08-02', 'done');
    log(db, id, '2026-08-03', 'missed');
    const s = stats(db).habitStats(USER, id, '2026-08-01', '2026-08-03');
    assert.strictEqual(s.currentStreak, 0);
    assert.strictEqual(s.bestStreak, 2);
  } finally { cleanup(); }
});

test('прошедший активный день без отметки считается пропуском', () => {
  const { db, cleanup } = fixture();
  try {
    const id = mkHabit(db);
    log(db, id, '2026-08-01', 'done');
    // 02 и 03 без записи, оба в прошлом
    const s = stats(db).habitStats(USER, id, '2026-08-01', '2026-08-03');
    assert.strictEqual(s.done, 1);
    assert.strictEqual(s.missed, 2);
    assert.strictEqual(s.percent, 33);
  } finally { cleanup(); }
});

test('last14 помечает неактивные дни отдельным статусом', () => {
  const { db, cleanup } = fixture();
  try {
    const MON = 1 << 0;
    const id = mkHabit(db, { schedule_mask: MON });
    const s = stats(db).habitStats(USER, id, '2026-08-01', '2026-08-07');
    const tue = s.last14.find(x => x.date === '2026-08-04');
    assert.strictEqual(tue.status, 'inactive');
  } finally { cleanup(); }
});
