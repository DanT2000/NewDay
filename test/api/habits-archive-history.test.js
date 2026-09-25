/**
 * Архив привычки не переписывает её прошлое.
 *
 * «Убрать с глаз» и «этого не было» — разные вещи. Человек, убравший привычку
 * в архив, ждёт, что месяцы отметок останутся в сводке: это его сделанная
 * работа, а не мусор. Раньше архив выключал привычку сразу для всех дат, и
 * прошлое исчезало целиком — вместе с процентами и лучшей серией.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, today, dayFromToday } = require('../helpers/client');
const { addDays } = require('../../server/lib/dates');

/** Привычка с историей: заведена давно и отмечена десять дней подряд. */
async function сИсторией(s) {
  const h = await api(s.url, s.cookie, 'POST', '/api/v1/habits',
    { title: 'Зарядка', breakPolicy: 'reset' });
  s.db.prepare("UPDATE habits SET created_at = datetime('now', '-60 days') WHERE id = ?").run(h.id);
  for (let i = 1; i <= 10; i++) {
    await api(s.url, s.cookie, 'PUT', `/api/v1/habits/${h.id}/log/${dayFromToday(-i)}`, { status: 'done' });
  }
  return h;
}

const сводка = (s, дней) => getJson(s.url, s.cookie,
  `/api/v1/stats?from=${addDays(today(), -дней)}&to=${today()}`);

test('после архивации прошлые отметки остаются в сводке', async () => {
  const s = await loggedIn();
  try {
    const h = await сИсторией(s);
    const до = await сводка(s, 30);
    const былоDone = до.habits?.find(x => x.id === h.id)?.done
      ?? до.habits?.find(x => x.title === 'Зарядка')?.done;
    assert.strictEqual(былоDone, 10, `до архива ждали 10 отметок, видим ${былоDone}`);

    // в архив: это `DELETE` без hard=1 — логи и статистика прошлого остаются
    await api(s.url, s.cookie, 'DELETE', `/api/v1/habits/${h.id}`);

    const после = await сводка(s, 30);
    const строка = после.habits?.find(x => x.id === h.id);
    assert.ok(строка, 'привычка, жившая в этом периоде, из сводки не исчезает');
    assert.strictEqual(строка.done, 10,
      `после архива ждали те же 10 отметок, видим ${строка.done}`);
    assert.ok(строка.archived_at, 'и видно, что она уже в архиве');
    const записей = s.db.prepare('SELECT COUNT(*) n FROM habit_logs WHERE habit_id = ?').get(h.id).n;
    assert.strictEqual(записей, 10, 'сами отметки никуда не деваются');
  } finally { await s.close(); }
});

test('архивная привычка не считается пропуском в будущих днях', async () => {
  const s = await loggedIn();
  try {
    const h = await сИсторией(s);
    await api(s.url, s.cookie, 'DELETE', `/api/v1/habits/${h.id}`);
    const день = await getJson(s.url, s.cookie, `/api/v1/days/${today()}/full`);
    const есть = (день.habits ?? []).some(x => x.id === h.id);
    assert.strictEqual(есть, false, 'в сегодняшнем дне архивной привычки нет');
  } finally { await s.close(); }
});

test('выключенная привычка тоже не стирает прошлое', async () => {
  const s = await loggedIn();
  try {
    const h = await сИсторией(s);
    // выключение без архива: даты у него нет, и раньше оно обнуляло всю историю
    await api(s.url, s.cookie, 'PATCH', `/api/v1/habits/${h.id}`, { isActive: false });
    const после = await сводка(s, 30);
    const строка = после.habits?.find(x => x.id === h.id);
    if (строка) {
      assert.strictEqual(строка.done, 10, `ждали 10 отметок, видим ${строка.done}`);
    }
    const записей = s.db.prepare('SELECT COUNT(*) n FROM habit_logs WHERE habit_id = ?').get(h.id).n;
    assert.strictEqual(записей, 10);
  } finally { await s.close(); }
});
