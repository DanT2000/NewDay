const test = require('node:test');
const assert = require('node:assert');
const { loggedIn, api, getJson, today } = require('../helpers/client');
const { buildIcs } = require('../../server/lib/ical');

test('строки .ics заканчиваются CRLF и складываются по 75 октетов', () => {
  const long = 'Очень длинное название события, которое заведомо не влезает в одну строку календаря';
  const ics = buildIcs({
    schedule: [{ date: '2026-08-04', start_min: 390, end_min: 420, title: long, sort_order: 0 }],
  }, { now: '2026-08-04T00:00:00.000Z' });

  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'), 'перевод строки по RFC — CRLF');
  assert.ok(ics.trimEnd().endsWith('END:VCALENDAR'));
  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `строка длиннее 75 октетов: ${line}`);
  }
  // продолжение сложенной строки начинается с пробела
  assert.match(ics, /\r\n [^\r\n]/);
});

test('точка с запятой и запятая в названии экранируются', () => {
  const ics = buildIcs({
    schedule: [{ date: '2026-08-04', start_min: 60, end_min: 90, title: 'Зал; ноги, спина', sort_order: 0 }],
  }, { now: '2026-08-04T00:00:00.000Z' });
  assert.match(ics, /SUMMARY:Зал\\; ноги\\, спина/);
});

test('событие без конца длится полчаса, а не ноль', () => {
  const ics = buildIcs({
    schedule: [{ date: '2026-08-04', start_min: 600, end_min: null, title: 'Созвон', sort_order: 0 }],
  }, { now: '2026-08-04T00:00:00.000Z' });
  assert.match(ics, /DTSTART;TZID=Europe\/Moscow:20260804T100000/);
  assert.match(ics, /DTEND;TZID=Europe\/Moscow:20260804T103000/);
});

test('приём пищи без времени в календарь не попадает: это чек-лист, а не событие', () => {
  const ics = buildIcs({
    schedule: [],
    meals: [
      { date: '2026-08-04', time_min: null, title: 'Овсянка', sort_order: 0 },
      { date: '2026-08-04', time_min: 780, title: 'Обед', sort_order: 1 },
    ],
  }, { now: '2026-08-04T00:00:00.000Z' });
  assert.ok(!ics.includes('Овсянка'), 'без времени — не событие');
  assert.match(ics, /SUMMARY:Обед/);
});

test('GET /export.ics отдаёт календарь с расписанием', async () => {
  const s = await loggedIn();
  const D = today();
  try {
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/schedule`,
      { time: '9-13', title: 'Работа' });
    await api(s.url, s.cookie, 'POST', `/api/v1/days/${D}/meals`,
      { slot: 'lunch', title: 'Обед', timeMin: 780 });

    const res = await fetch(`${s.url}/api/v1/export.ics`, { headers: { cookie: s.cookie } });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/calendar/);
    assert.match(res.headers.get('content-disposition'), /newday\.ics/);

    const body = await res.text();
    assert.match(body, /SUMMARY:Работа/);
    assert.match(body, /SUMMARY:Обед/);
    assert.match(body, /DTSTART;TZID=Europe\/Moscow:/);
  } finally { await s.close(); }
});

test('период .ics можно ограничить, и чужие дни в него не попадают', async () => {
  const s = await loggedIn();
  try {
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-03-01/schedule', { time: '9-10', title: 'Март' });
    await api(s.url, s.cookie, 'POST', '/api/v1/days/2026-09-01/schedule', { time: '9-10', title: 'Сентябрь' });

    const only = await (await fetch(
      `${s.url}/api/v1/export.ics?from=2026-08-01&to=2026-12-31`,
      { headers: { cookie: s.cookie } })).text();
    assert.ok(!only.includes('Март'), 'до начала периода не попало');
    assert.match(only, /SUMMARY:Сентябрь/);
  } finally { await s.close(); }
});

test('без входа календарь не отдаётся', async () => {
  const s = await loggedIn();
  try {
    const res = await fetch(`${s.url}/api/v1/export.ics`);
    assert.strictEqual(res.status, 401);
  } finally { await s.close(); }
});
