const test = require('node:test');
const assert = require('node:assert');
const d = require('../../server/lib/dates');

test('todayFor учитывает таймзону, а не UTC', () => {
  const at = new Date('2026-08-03T22:30:00Z');
  assert.strictEqual(d.todayFor('Europe/Moscow', at), '2026-08-04');
  assert.strictEqual(d.todayFor('America/Los_Angeles', at), '2026-08-03');
  assert.strictEqual(d.todayFor('UTC', at), '2026-08-03');
});

test('todayFor: полночь по Москве — уже новый день', () => {
  const at = new Date('2026-08-03T21:00:00Z'); // 04:00... нет, 00:00 МСК 4-го
  assert.strictEqual(d.todayFor('Europe/Moscow', at), '2026-08-04');
});

test('todayFor на битой таймзоне откатывается в UTC, а не падает', () => {
  const at = new Date('2026-08-03T22:30:00Z');
  assert.strictEqual(d.todayFor('Марс/Олимп', at), '2026-08-03');
});

test('isValidTimezone', () => {
  assert.strictEqual(d.isValidTimezone('Europe/Moscow'), true);
  assert.strictEqual(d.isValidTimezone('Asia/Kamchatka'), true);
  assert.strictEqual(d.isValidTimezone('Марс/Олимп'), false);
  assert.strictEqual(d.isValidTimezone(''), false);
});

test('addDays переходит через границы месяца и года', () => {
  assert.strictEqual(d.addDays('2026-08-31', 1), '2026-09-01');
  assert.strictEqual(d.addDays('2026-01-01', -1), '2025-12-31');
  assert.strictEqual(d.addDays('2024-02-28', 1), '2024-02-29');
  assert.strictEqual(d.addDays('2026-08-03', 0), '2026-08-03');
});

test('addDays переживает переход на летнее время', () => {
  // в Европе перевод часов в ночь на 29 марта 2026
  assert.strictEqual(d.addDays('2026-03-28', 1), '2026-03-29');
  assert.strictEqual(d.addDays('2026-03-29', 1), '2026-03-30');
});

test('diffDays', () => {
  assert.strictEqual(d.diffDays('2026-08-01', '2026-08-04'), 3);
  assert.strictEqual(d.diffDays('2026-08-04', '2026-08-01'), -3);
  assert.strictEqual(d.diffDays('2026-08-01', '2026-08-01'), 0);
});

test('rangeDates включает оба конца и пуст при from > to', () => {
  assert.deepStrictEqual(d.rangeDates('2026-08-01', '2026-08-03'),
    ['2026-08-01', '2026-08-02', '2026-08-03']);
  assert.deepStrictEqual(d.rangeDates('2026-08-03', '2026-08-03'), ['2026-08-03']);
  assert.deepStrictEqual(d.rangeDates('2026-08-04', '2026-08-03'), []);
  assert.deepStrictEqual(d.rangeDates('мусор', '2026-08-03'), []);
});

test('weekdayOf: понедельник = 1, воскресенье = 7', () => {
  assert.strictEqual(d.weekdayOf('2026-08-03'), 1);
  assert.strictEqual(d.weekdayOf('2026-08-09'), 7);
});

test('weekdayInMask', () => {
  const MON = 1 << 0, SUN = 1 << 6;
  assert.strictEqual(d.weekdayInMask('2026-08-03', MON), true);
  assert.strictEqual(d.weekdayInMask('2026-08-03', SUN), false);
  assert.strictEqual(d.weekdayInMask('2026-08-03', d.MASK_ALL), true);
  assert.strictEqual(d.weekdayInMask('2026-08-03', null), true);
});

test('parseTimeToMinutes принимает бытовые форматы', () => {
  assert.strictEqual(d.parseTimeToMinutes('9'), 540);
  assert.strictEqual(d.parseTimeToMinutes('9:30'), 570);
  assert.strictEqual(d.parseTimeToMinutes('930'), 570);
  assert.strictEqual(d.parseTimeToMinutes('9.30'), 570);
  assert.strictEqual(d.parseTimeToMinutes('09:05'), 545);
  assert.strictEqual(d.parseTimeToMinutes('23:59'), 1439);
  assert.strictEqual(d.parseTimeToMinutes('0'), 0);
});

test('parseTimeToMinutes отвергает мусор', () => {
  assert.strictEqual(d.parseTimeToMinutes('24:00'), null);
  assert.strictEqual(d.parseTimeToMinutes('9:60'), null);
  assert.strictEqual(d.parseTimeToMinutes('абв'), null);
  assert.strictEqual(d.parseTimeToMinutes(''), null);
  assert.strictEqual(d.parseTimeToMinutes(null), null);
  assert.strictEqual(d.parseTimeToMinutes('99999'), null);
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
  assert.deepStrictEqual(d.parseTimeRange('9:00'),
    { startMin: 540, endMin: null, display: '09:00' });
  assert.strictEqual(d.parseTimeRange(''), null);
  assert.strictEqual(d.parseTimeRange('9:00-мусор'), null);
});
