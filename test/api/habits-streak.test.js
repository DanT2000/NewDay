/**
 * Серия по всем привычкам сразу — число на третьей плитке «Сейчас».
 *
 * Раньше там стоял процент за неделю: 56 % — это и «через день», и «три дня
 * подряд, потом бросил». Серия отвечает ровно на тот вопрос, ради которого
 * привычки и ведут, поэтому проверяем её правила: день засчитан, когда
 * закрыт весь список; сегодняшний незакрытый день серию не рвёт; заморозка
 * не считается ни выполнением, ни срывом; день, на который ничего не
 * обещано, пропускается.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, today, dayFromToday } = require('../helpers/client');

const серия = async s => (await getJson(s.url, s.cookie, `/api/v1/days/${today()}/full`)).habitsStreak;
/*
 * Привычка, заведённая минуту назад, в прошлых днях не существовала, и серия
 * по ним честно не считается. Для проверки правил сдвигаем дату рождения
 * назад — так же, как у человека, который ведёт привычку не первый месяц.
 */
const давняя = async (s, body) => {
  const h = await api(s.url, s.cookie, 'POST', '/api/v1/habits', body);
  s.db.prepare("UPDATE habits SET created_at = datetime('now', '-60 days') WHERE id = ?").run(h.id);
  return h;
};
const отметить = (s, id, date, status = 'done') =>
  api(s.url, s.cookie, 'PUT', `/api/v1/habits/${id}/log/${date}`, { status });

test('серия — это дни подряд, когда закрыты все привычки', async () => {
  const s = await loggedIn();
  try {
    const вода = await давняя(s, { title: 'Вода' });
    const зарядка = await давняя(s, { title: 'Зарядка' });

    for (const d of [dayFromToday(-2), dayFromToday(-1)]) {
      await отметить(s, вода.id, d);
      await отметить(s, зарядка.id, d);
    }
    assert.strictEqual(await серия(s), 2, 'два прошедших дня закрыты полностью');

    // сегодня отмечена только одна — день ещё идёт, серия не рвётся и не растёт
    await отметить(s, вода.id, today());
    assert.strictEqual(await серия(s), 2);

    await отметить(s, зарядка.id, today());
    assert.strictEqual(await серия(s), 3, 'сегодня закрыт весь список — плюс день');
  } finally { await s.close(); }
});

test('незакрытый прошлый день рвёт серию, заморозка — нет', async () => {
  const s = await loggedIn();
  try {
    const вода = await давняя(s, { title: 'Вода' });
    const зарядка = await давняя(s, { title: 'Зарядка' });

    await отметить(s, вода.id, dayFromToday(-3));
    await отметить(s, зарядка.id, dayFromToday(-3));
    // позавчера зарядку заморозили — это не срыв
    await отметить(s, вода.id, dayFromToday(-2));
    await отметить(s, зарядка.id, dayFromToday(-2), 'skipped');
    await отметить(s, вода.id, dayFromToday(-1));
    await отметить(s, зарядка.id, dayFromToday(-1));
    assert.strictEqual(await серия(s), 3, 'заморозка не прерывает и не выпадает из счёта');

    // а вчера зарядку просто не сделали — дальше вчера серия не идёт
    await отметить(s, зарядка.id, dayFromToday(-1), 'missed');
    assert.strictEqual(await серия(s), 0);
  } finally { await s.close(); }
});

test('день, на который ничего не обещано, серию не рвёт', async () => {
  const s = await loggedIn();
  try {
    // только по будням: понедельник — младший бит, значит 1+2+4+8+16 = 31
    const будни = await давняя(s, { title: 'Планёрка', scheduleMask: 31 });
    const дни = [dayFromToday(-6), dayFromToday(-5), dayFromToday(-4), dayFromToday(-3),
      dayFromToday(-2), dayFromToday(-1)];
    for (const d of дни) {
      const рабочий = ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay());
      if (рабочий) await отметить(s, будни.id, d);
    }
    const рабочихПодряд = дни.filter(d => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())).length;
    assert.strictEqual(await серия(s), рабочихПодряд,
      'выходные пропущены, а не засчитаны и не срыв');
  } finally { await s.close(); }
});

test('без привычек серии нет', async () => {
  const s = await loggedIn();
  try {
    assert.strictEqual(await серия(s), 0);
  } finally { await s.close(); }
});
