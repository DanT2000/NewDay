const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson } = require('../helpers/client');

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
    const tue = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-04/full'); // вторник
    assert.strictEqual(tue.habits[0].activeToday, false);
    const mon = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full'); // понедельник
    assert.strictEqual(mon.habits[0].activeToday, true);
  } finally { await s.close(); }
});

test('отметка привычки попадает в день и в прогресс', async () => {
  const s = await loggedIn();
  try {
    const h = await api(s.url, s.cookie, 'POST', '/api/v1/habits', { title: 'Вода', emoji: '💧' });
    await api(s.url, s.cookie, 'PUT', `/api/v1/habits/${h.id}/log/2026-08-03`, { status: 'done' });
    const full = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
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
