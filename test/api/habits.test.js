const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, today, dayFromToday, nextWeekday } = require('../helpers/client');

test('пресет «30 дней подряд» разворачивается в правильные поля', async () => {
  const s = await loggedIn();
  try {
    const h = await api(s.url, s.cookie, 'POST', '/api/v1/habits',
      { title: 'Пресс', emoji: '💪', preset: 'challenge30' });
    assert.strictEqual(h.mode, 'challenge');
    assert.strictEqual(h.challenge_target_days, 30);
    assert.strictEqual(h.break_policy, 'reset');
    assert.strictEqual(h.polarity, 'do');
    assert.ok(h.challenge_start_date, 'старт проставлен автоматически');
  } finally { await s.close(); }
});

test('пресет «Марафон 300» — накопительный', async () => {
  const s = await loggedIn();
  try {
    const h = await api(s.url, s.cookie, 'POST', '/api/v1/habits',
      { title: 'Читать', preset: 'marathon300' });
    assert.strictEqual(h.break_policy, 'keep');
    assert.strictEqual(h.challenge_target_days, 300);
  } finally { await s.close(); }
});

test('пресет «Бросаю» ставит polarity=avoid и reset', async () => {
  const s = await loggedIn();
  try {
    const h = await api(s.url, s.cookie, 'POST', '/api/v1/habits',
      { title: 'Не курить', emoji: '🚭', preset: 'quit', challengeTargetDays: 300 });
    assert.strictEqual(h.polarity, 'avoid');
    assert.strictEqual(h.break_policy, 'reset');
    assert.strictEqual(h.challenge_target_days, 300);
  } finally { await s.close(); }
});

test('явные поля перекрывают пресет', async () => {
  const s = await loggedIn();
  try {
    const h = await api(s.url, s.cookie, 'POST', '/api/v1/habits',
      { title: 'Зал', preset: 'challenge30', breakPolicy: 'keep', challengeTargetDays: 66 });
    assert.strictEqual(h.break_policy, 'keep');
    assert.strictEqual(h.challenge_target_days, 66);
  } finally { await s.close(); }
});

test('название обязательно, неизвестный пресет отвергается', async () => {
  const s = await loggedIn();
  try {
    const noTitle = await api(s.url, s.cookie, 'POST', '/api/v1/habits', { title: '  ' }, {}, true);
    assert.strictEqual(noTitle.status, 400);
    const badPreset = await api(s.url, s.cookie, 'POST', '/api/v1/habits',
      { title: 'X', preset: 'выдумка' }, {}, true);
    assert.strictEqual(badPreset.status, 400);
  } finally { await s.close(); }
});

test('привычка вне schedule_mask помечена activeToday = false', async () => {
  const s = await loggedIn();
  try {
    const MON = 1 << 0;
    await api(s.url, s.cookie, 'POST', '/api/v1/habits', { title: 'Зал', scheduleMask: MON });
    // Дни берём начиная с сегодня: в днях до создания привычки теперь нет вовсе
    const tue = await getJson(s.url, s.cookie, `/api/v1/days/${nextWeekday(2)}/full`);
    assert.strictEqual(tue.habits[0].activeToday, false, 'вторник не в маске');
    const mon = await getJson(s.url, s.cookie, `/api/v1/days/${nextWeekday(1)}/full`);
    assert.strictEqual(mon.habits[0].activeToday, true, 'понедельник в маске');
  } finally { await s.close(); }
});

test('привычки нет в днях до её создания — её там не было', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/habits', { title: 'Вода' });
    const before = await getJson(s.url, s.cookie, `/api/v1/days/${dayFromToday(-1)}/full`);
    assert.deepStrictEqual(before.habits, [], 'вчера привычки не существовало');
    assert.strictEqual(before.progress.habits.possible, 0, 'и в прогресс вчера она не входит');

    const now = await getJson(s.url, s.cookie, `/api/v1/days/${today()}/full`);
    assert.strictEqual(now.habits.length, 1, 'а сегодня есть');
  } finally { await s.close(); }
});

test('отметка привычки попадает в день и в прогресс', async () => {
  const s = await loggedIn();
  try {
    const h = await api(s.url, s.cookie, 'POST', '/api/v1/habits', { title: 'Вода', emoji: '💧' });
    await api(s.url, s.cookie, 'PUT', `/api/v1/habits/${h.id}/log/${today()}`, { status: 'done' });
    const full = await getJson(s.url, s.cookie, `/api/v1/days/${today()}/full`);
    assert.strictEqual(full.habits[0].status, 'done');
    assert.strictEqual(full.progress.habits.done, 1);
    assert.strictEqual(full.progress.habits.possible, 1);
  } finally { await s.close(); }
});

test('недопустимый статус отвергается', async () => {
  const s = await loggedIn();
  try {
    const h = await api(s.url, s.cookie, 'POST', '/api/v1/habits', { title: 'Вода' });
    const res = await api(s.url, s.cookie, 'PUT', `/api/v1/habits/${h.id}/log/2026-08-03`,
      { status: 'может быть' }, {}, true);
    assert.strictEqual(res.status, 400);
  } finally { await s.close(); }
});

test('удаление привычки по умолчанию архивирует, логи сохраняются', async () => {
  const s = await loggedIn();
  try {
    const h = await api(s.url, s.cookie, 'POST', '/api/v1/habits', { title: 'Вода' });
    await api(s.url, s.cookie, 'PUT', `/api/v1/habits/${h.id}/log/2026-08-03`, { status: 'done' });
    await api(s.url, s.cookie, 'DELETE', `/api/v1/habits/${h.id}`);

    assert.strictEqual(s.db.prepare('SELECT COUNT(*) AS c FROM habit_logs').get().c, 1);
    assert.ok(s.db.prepare('SELECT archived_at FROM habits WHERE id = ?').get(h.id).archived_at);
    assert.strictEqual((await getJson(s.url, s.cookie, '/api/v1/habits')).length, 0);
    assert.strictEqual((await getJson(s.url, s.cookie, '/api/v1/habits?archived=1')).length, 1);
  } finally { await s.close(); }
});

test('восстановление из архива возвращает привычку в список', async () => {
  const s = await loggedIn();
  try {
    const h = await api(s.url, s.cookie, 'POST', '/api/v1/habits', { title: 'Вода' });
    await api(s.url, s.cookie, 'DELETE', `/api/v1/habits/${h.id}`);
    await api(s.url, s.cookie, 'POST', `/api/v1/habits/${h.id}/restore`);
    assert.strictEqual((await getJson(s.url, s.cookie, '/api/v1/habits')).length, 1);
  } finally { await s.close(); }
});

test('DELETE ?hard=1 удаляет привычку и её логи', async () => {
  const s = await loggedIn();
  try {
    const h = await api(s.url, s.cookie, 'POST', '/api/v1/habits', { title: 'Вода' });
    await api(s.url, s.cookie, 'PUT', `/api/v1/habits/${h.id}/log/2026-08-03`, { status: 'done' });
    await api(s.url, s.cookie, 'DELETE', `/api/v1/habits/${h.id}?hard=1`);
    assert.strictEqual(s.db.prepare('SELECT COUNT(*) AS c FROM habit_logs').get().c, 0);
    assert.strictEqual(s.db.prepare('SELECT COUNT(*) AS c FROM habits').get().c, 0);
  } finally { await s.close(); }
});

test('чужую привычку не отметить', async () => {
  const a = await loggedIn({ email: 'a@b.ru' });
  try {
    const b = await loggedIn({ email: 'c@d.ru', server: a.srv });
    const h = await api(a.url, a.cookie, 'POST', '/api/v1/habits', { title: 'Моя' });
    const res = await api(b.url, b.cookie, 'PUT', `/api/v1/habits/${h.id}/log/2026-08-03`,
      { status: 'done' }, {}, true);
    assert.strictEqual(res.status, 404);
  } finally { await a.close(); }
});

test('/api/v1/stats отдаёт сводку по дням и привычкам', async () => {
  const s = await loggedIn();
  try {
    const h = await api(s.url, s.cookie, 'POST', '/api/v1/habits', { title: 'Вода' });
    await api(s.url, s.cookie, 'PUT', `/api/v1/habits/${h.id}/log/2026-08-03`, { status: 'done' });
    const overview = await getJson(s.url, s.cookie, '/api/v1/stats?from=2026-08-01&to=2026-08-05');
    assert.strictEqual(overview.days.length, 5);
    assert.strictEqual(overview.habits.length, 1);
    assert.ok(overview.summary);
  } finally { await s.close(); }
});

/*
 * Свободный график: «три раза в неделю». Отличается от графика по дням тем,
 * что неотмеченный день ничего не нарушает — обещание считается за неделю.
 * До правки половина расчётов про это не знала, и числа противоречили друг
 * другу: текущая серия больше «лучшей за всё время», срывы при нулевых
 * пропусках, челлендж «пять дней подряд», закрытый пятью отметками за месяц.
 */
test('у свободного графика неотмеченный день не пропуск и не срыв', async () => {
  const s = await loggedIn();
  try {
    const h = await api(s.url, s.cookie, 'POST', '/api/v1/habits',
      { title: 'Медитация', emoji: '🧘', timesPerWeek: 3 });
    // одна отметка три дня назад, остальные дни пустые
    await api(s.url, s.cookie, 'PUT', `/api/v1/habits/${h.id}/log/${dayFromToday(-3)}`, { status: 'done' });

    const stats = await getJson(s.url, s.cookie, `/api/v1/habits/${h.id}/stats`);
    assert.strictEqual(stats.missed, 0, 'пропусков нет: дни никто не обещал');
    assert.strictEqual(stats.currentStreak, 0, 'серии у свободного графика нет');
    assert.strictEqual(stats.bestStreak, 0, 'и лучшей серии тоже');
    assert.strictEqual(stats.timesPerWeek, 3);
    assert.strictEqual(stats.week.target, 3, 'норма недели');
    assert.strictEqual(stats.week.done, 1, 'сделано за неделю');
  } finally { await s.close(); }
});

test('свободная привычка не тянет прогресс дня, пока её не отметили', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/habits',
      { title: 'Медитация', emoji: '🧘', timesPerWeek: 3 });
    const day = await getJson(s.url, s.cookie, `/api/v1/days/${today()}/full`);
    assert.strictEqual(day.progress.habits.possible, 0,
      'в дне, на который ничего не обещано, привычки в знаменатель не идут');
  } finally { await s.close(); }
});

test('челлендж у свободного графика копит выполненные дни, а не серию', async () => {
  const s = await loggedIn();
  try {
    const h = await api(s.url, s.cookie, 'POST', '/api/v1/habits', {
      title: 'Бассейн', emoji: '🏊', timesPerWeek: 2,
      mode: 'challenge', challengeTargetDays: 5, breakPolicy: 'reset',
    });
    /*
     * Привычку заводим «месяц назад»: до создания её не было, и прошлые
     * отметки не считаются вовсе — это правильно. А проверить нужно то, что
     * раньше давало ложное «челлендж закрыт»: пять отметок раз в неделю при
     * цели «пять дней подряд».
     */
    s.db.prepare('UPDATE habits SET created_at = ?, challenge_start_date = ? WHERE id = ?')
      .run(`${dayFromToday(-35)} 00:00:00`, dayFromToday(-35), h.id);
    for (const back of [28, 21, 14, 7, 1]) {
      await api(s.url, s.cookie, 'PUT', `/api/v1/habits/${h.id}/log/${dayFromToday(-back)}`, { status: 'done' });
    }

    const stats = await getJson(s.url, s.cookie, `/api/v1/habits/${h.id}/stats`);
    assert.strictEqual(stats.missed, 0, 'неотмеченные дни не пропуски');
    assert.strictEqual(stats.challenge.breaks, 0, 'и не срывы');
    assert.strictEqual(stats.challenge.day, 5, 'пять отметок — пять дней челленджа');
    assert.strictEqual(stats.challenge.complete, true,
      'цель достигнута накоплением, а не серией подряд');
  } finally { await s.close(); }
});

/*
 * Дата создания сравнивается в поясе человека, а не в UTC.
 *
 * Поймалось само: в те часы, когда даты не совпадают (в Москве уже шестое, по
 * UTC ещё пятое), привычка, созданная минуту назад, выглядела существовавшей
 * вчера — и вчерашний день считал её пропущенной.
 */
test('привычка, созданная в UTC-вчера, не появляется во вчерашнем дне человека', async () => {
  const s = await loggedIn();
  try {
    const h = await api(s.url, s.cookie, 'POST', '/api/v1/habits', { title: 'Вода' });
    // момент создания — вчерашний по UTC, а сегодняшний по московскому времени
    s.db.prepare('UPDATE habits SET created_at = ? WHERE id = ?')
      .run(`${dayFromToday(-1)} 22:30:00`, h.id);

    const yesterday = await getJson(s.url, s.cookie, `/api/v1/days/${dayFromToday(-1)}/full`);
    assert.deepStrictEqual(yesterday.habits, [],
      'по московскому времени привычки вчера ещё не было');
    const now = await getJson(s.url, s.cookie, `/api/v1/days/${today()}/full`);
    assert.strictEqual(now.habits.length, 1, 'а сегодня есть');
  } finally { await s.close(); }
});
