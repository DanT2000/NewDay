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
    challenge_start_date: null, schedule_mask: 127, times_per_week: null, ...over,
  };
  const info = db.prepare(`INSERT INTO habits
    (user_id, title, mode, polarity, break_policy, challenge_target_days,
     challenge_start_date, schedule_mask, times_per_week, created_at)
    VALUES (@user_id,@title,@mode,@polarity,@break_policy,@challenge_target_days,
            @challenge_start_date,@schedule_mask,@times_per_week,'2026-07-01 00:00:00')`).run(f);
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

/*
 * Раньше этот тест требовал, чтобы у накопительной цели считались срывы.
 * Теперь так нельзя: у цели пропуск — законное «не в зачёт», а не срыв, и
 * показывать человеку «срывов 1» там, где он ничего не обещал на этот день,
 * значит наказывать за разрешённое. Счёт по-прежнему не обнуляется.
 */
test('цель: срыв не обнуляет счёт и срывом не считается', () => {
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
    assert.strictEqual(s.challenge.breaks, 0, 'у цели срывов не бывает');
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

/*
 * Ниже — два вида привычек.
 *
 * Серия — сколько раз подряд: пропуск обещанного дня обнуляет счёт. Цель —
 * сколько раз всего: пропуск не в зачёт, но счёт не сбрасывает. Раньше
 * способ был один на всех, и «Спартанец» с сорока отбеганными днями и одним
 * пропуском показывал «0 из 300» — счёт серии вместо счёта сделанного.
 */

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

test('цель, поставленная давно ведомой привычке: счёт и проценты про одно и то же', () => {
  const { db, cleanup } = fixture();
  try {
    /*
     * Привычку вели с июля, а цель «30 раз» поставили 1 августа. Счётчик
     * считает от постановки цели — и проценты обязаны считать то же самое.
     * Иначе выходит «0 из 30» рядом со «100 %», и оба числа про эту же
     * привычку.
     */
    const id = mkHabit(db, {
      mode: 'challenge', break_policy: 'keep',
      challenge_target_days: 30, challenge_start_date: '2026-08-01',
    });
    for (const d of ['2026-07-10', '2026-07-11', '2026-07-12']) log(db, id, d, 'done');
    log(db, id, '2026-08-02', 'done');
    const s = stats(db).habitStats(USER, id, null, '2026-08-05');
    assert.strictEqual(s.challenge.day, 1, 'к цели идёт только то, что после её постановки');
    assert.strictEqual(s.total, 4, 'а всего отметок видно честно');
    assert.strictEqual(s.percent, 3, 'проценты — про цель, а не про всю жизнь привычки');
  } finally { cleanup(); }
});

test('у цели дни недели ничего не запрещают', () => {
  const { db, cleanup } = fixture();
  try {
    /*
     * «Бегать по понедельникам, средам и пятницам» у цели — это план, а не
     * обязательство: пропустил среду, добежал в субботу — всё в зачёт.
     * Раньше суббота считалась чужим днём: галочка была мёртвой, а если
     * отметка всё же появлялась, счёт её не видел.
     */
    const MON_WED_FRI = (1 << 0) | (1 << 2) | (1 << 4);
    const id = mkHabit(db, {
      schedule_mask: MON_WED_FRI, break_policy: 'keep',
      mode: 'challenge', challenge_target_days: 30, challenge_start_date: '2026-08-01',
    });
    log(db, id, '2026-08-03', 'done');  // пн — по плану
    log(db, id, '2026-08-08', 'done');  // сб — вне плана, но сделал
    const s = stats(db).habitStats(USER, id, null, '2026-08-09');
    assert.strictEqual(s.total, 2, 'обе отметки в счёте');
    assert.strictEqual(s.challenge.day, 2, 'и обе идут к цели');
    const сб = s.last14.find(d => d.date === '2026-08-08');
    assert.strictEqual(сб.status, 'done', 'суббота показана сделанной, а не «не её день»');

    const наСегодня = stats(db).habitsForDate(USER, '2026-08-09').find(h => h.id === id);
    assert.strictEqual(наСегодня.activeToday, true, 'отметить цель можно в любой день');
  } finally { cleanup(); }
});

test('серии дни недели по-прежнему задают, где она живёт', () => {
  const { db, cleanup } = fixture();
  try {
    const MON_WED_FRI = (1 << 0) | (1 << 2) | (1 << 4);
    const id = mkHabit(db, { schedule_mask: MON_WED_FRI, break_policy: 'reset' });
    const наСубботу = stats(db).habitsForDate(USER, '2026-08-08').find(h => h.id === id);
    assert.strictEqual(наСубботу.activeToday, false, 'суббота у серии — законный выходной');
  } finally { cleanup(); }
});

test('неотмеченная цель не портит прогресс дня', () => {
  const { db, cleanup } = fixture();
  try {
    const серия = mkHabit(db, { break_policy: 'reset' });
    mkHabit(db, { break_policy: 'keep' });   // цель, сегодня не отмечена
    log(db, серия, '2026-08-09', 'done');
    const p = stats(db).dayProgress(USER, '2026-08-09');
    assert.strictEqual(p.habits.possible, 1, 'в знаменателе только серия');
    assert.strictEqual(p.habits.percent, 100, 'пропуск цели не роняет прогресс дня');
  } finally { cleanup(); }
});

test('у цели нет красных дней: срыва там не бывает', () => {
  const { db, cleanup } = fixture();
  try {
    /*
     * Отметку «не сделал» можно поставить со старых экранов и по API. У
     * серии это честный срыв, у цели — ничто: срывов у неё не бывает по
     * определению, и красный квадрат в полоске противоречит числу «срывов 0».
     */
    const id = mkHabit(db, { break_policy: 'keep' });
    log(db, id, '2026-08-08', 'missed');
    const s = stats(db).habitStats(USER, id, null, '2026-08-09');
    assert.strictEqual(s.missed, 0);
    const день = s.last14.find(d => d.date === '2026-08-08');
    assert.strictEqual(день.status, null, 'в полоске пусто, а не красное');

    const наДень = stats(db).habitsForDate(USER, '2026-08-08').find(h => h.id === id);
    assert.strictEqual(наДень.week.find(d => d.date === '2026-08-08').status, null,
      'и в недельных точках тоже');
  } finally { cleanup(); }
});

test('сводка сравнивает сравнимое: цели в «лучшую привычку» не лезут', () => {
  const { db, cleanup } = fixture();
  try {
    /*
     * У серии процент — доля сделанного из обещанного за период, у цели —
     * насколько набрана цель за всё время. Сравнивать их в одном списке
     * нельзя: добранный марафон объявлялся «лучшей привычкой недели», в
     * которую человек не сделал ничего, а свежая цель — «самой слабой»,
     * и к ней выдавался совет сузить дни недели, для цели бессмысленный.
     */
    const серия = mkHabit(db, { break_policy: 'reset' });
    const цель = mkHabit(db, {
      break_policy: 'keep', mode: 'challenge',
      challenge_target_days: 2, challenge_start_date: '2026-07-01',
    });
    for (const d of ['2026-07-02', '2026-07-03']) log(db, цель, d, 'done');  // цель добрана давно
    log(db, серия, '2026-08-08', 'done');

    const o = stats(db).overview(USER, '2026-08-08', '2026-08-09');
    assert.strictEqual(o.summary.bestHabit?.id, серия, 'лучшая — та, у которой процент про этот период');
    assert.ok(!o.habits.find(h => h.id === цель && h.percent === null),
      'сама цель из списка не исчезает — у неё свой счёт');
  } finally { cleanup(); }
});
