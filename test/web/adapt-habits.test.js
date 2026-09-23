/**
 * Подпись под привычкой.
 *
 * Она — единственное, по чему человек понимает, как его считают, поэтому
 * врать ей нельзя: «челлендж 0 из 300» при сорока отмеченных днях читается
 * как поломка, а не как «серия прервалась».
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
  assert.strictEqual(habitMeta(привычка({ kind: 'goal', total: 2 })), 'сделано 2 раза');
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
