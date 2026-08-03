const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { loggedIn, api, getJson } = require('../helpers/client');
const { startTestServer } = require('../helpers/server');
const { runBackup } = require('../../server/lib/backup');

test('таймзона сохраняется и меняет «сегодня»', async () => {
  const s = await loggedIn();
  try {
    const before = await getJson(s.url, s.cookie, '/api/v1/settings');
    assert.strictEqual(before.timezone, 'Europe/Moscow');

    const after = await api(s.url, s.cookie, 'PATCH', '/api/v1/settings',
      { timezone: 'Asia/Kamchatka' });
    assert.strictEqual(after.timezone, 'Asia/Kamchatka');
    assert.match(after.today, /^\d{4}-\d{2}-\d{2}$/);
  } finally { await s.close(); }
});

test('невалидная таймзона отвергается', async () => {
  const s = await loggedIn();
  try {
    const res = await api(s.url, s.cookie, 'PATCH', '/api/v1/settings',
      { timezone: 'Марс/Олимп' }, {}, true);
    assert.strictEqual(res.status, 400);
  } finally { await s.close(); }
});

test('тема, вид расписания и режим питания сохраняются', async () => {
  const s = await loggedIn();
  try {
    const r = await api(s.url, s.cookie, 'PATCH', '/api/v1/settings',
      { theme: 'dark', scheduleView: 'timeline', foodMode: 'timed' });
    assert.strictEqual(r.theme, 'dark');
    assert.strictEqual(r.scheduleView, 'timeline');
    assert.strictEqual(r.foodMode, 'timed');
  } finally { await s.close(); }
});

test('произвольные настройки кладутся в user_settings', async () => {
  const s = await loggedIn();
  try {
    const r = await api(s.url, s.cookie, 'PATCH', '/api/v1/settings',
      { settings: { notifyDefaultBeforeMin: 15, alarmEnabled: true } });
    assert.strictEqual(r.settings.notifyDefaultBeforeMin, 15);
    assert.strictEqual(r.settings.alarmEnabled, true);
  } finally { await s.close(); }
});

test('экспорт и импорт в режиме replace восстанавливают состояние', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/schedule',
      { time: '9-13', title: 'Работа' });
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/tasks',
      { bucket: 'home', text: 'Посуда' });
    const h = await api(s.url, s.cookie, 'POST', '/api/v1/habits', { title: 'Вода', emoji: '💧' });
    await api(s.url, s.cookie, 'PUT', `/api/v1/habits/${h.id}/log/2026-08-03`, { status: 'done' });

    const dump = await getJson(s.url, s.cookie, '/api/v1/export');
    assert.strictEqual(dump.formatVersion, 1);

    await api(s.url, s.cookie, 'DELETE', '/api/v1/days/2026-08-03');
    await api(s.url, s.cookie, 'DELETE', `/api/v1/habits/${h.id}?hard=1`);

    await api(s.url, s.cookie, 'POST', '/api/v1/import', { data: dump, mode: 'replace' });

    const full = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
    assert.strictEqual(full.schedule[0].title, 'Работа');
    assert.strictEqual(full.tasks.home[0].text, 'Посуда');
    const habits = await getJson(s.url, s.cookie, '/api/v1/habits');
    assert.strictEqual(habits.length, 1);
    assert.strictEqual(full.habits[0].status, 'done', 'лог привычки перепривязан к новому id');
  } finally { await s.close(); }
});

test('импорт в режиме merge не трогает существующие дни', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-08-03/schedule', { time: '9-13', title: 'Оригинал' });
    const dump = await getJson(s.url, s.cookie, '/api/v1/export');
    dump.days[0].title = 'Из бэкапа';
    dump.scheduleItems[0].title = 'Из бэкапа';
    dump.habits = [];
    dump.habitLogs = [];

    await api(s.url, s.cookie, 'POST', '/api/v1/import', { data: dump, mode: 'merge' });
    const full = await getJson(s.url, s.cookie, '/api/v1/days/2026-08-03/full');
    assert.strictEqual(full.schedule.length, 1);
    assert.strictEqual(full.schedule[0].title, 'Оригинал');
  } finally { await s.close(); }
});

test('импорт чужой версии формата отвергается', async () => {
  const s = await loggedIn();
  try {
    const res = await api(s.url, s.cookie, 'POST', '/api/v1/import',
      { data: { formatVersion: 99 } }, {}, true);
    assert.strictEqual(res.status, 400);
  } finally { await s.close(); }
});

test('бэкап создаёт файл и соблюдает ротацию', async () => {
  const srv = await startTestServer();
  try {
    const first = runBackup(srv.db, srv.config.dbPath, '2026-08-01');
    assert.ok(fs.existsSync(first));
    for (let i = 2; i <= 18; i++) {
      runBackup(srv.db, srv.config.dbPath, `2026-08-${String(i).padStart(2, '0')}`);
    }
    const dir = require('node:path').dirname(first);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.db'));
    assert.strictEqual(files.length, 14, 'старые снимки удаляются');
  } finally { await srv.close(); }
});
