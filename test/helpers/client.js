const { startTestServer } = require('./server');
const { todayFor, addDays, weekdayOf } = require('../../server/lib/dates');

/*
 * Даты для тестов считаются от «сегодня», а не пишутся числом.
 *
 * Часть тестов раньше держала в себе 2026-08-03 — день, когда их написали.
 * Пока это был сегодняшний день, всё сходилось; на следующие сутки он стал
 * прошлым, и тесты про привычки посыпались. Дата, зашитая числом, — бомба
 * с часовым механизмом.
 */
const TZ = 'Europe/Moscow';                    // таймзона тестового пользователя
const today = () => todayFor(TZ);
const dayFromToday = n => addDays(today(), n);

/** Ближайшая дата не раньше сегодня с нужным днём недели (1 — понедельник). */
function nextWeekday(weekday) {
  let d = today();
  for (let i = 0; i < 7; i++) {
    if (weekdayOf(d) === weekday) return d;
    d = addDays(d, 1);
  }
  return d;
}

/** Достаёт значение cookie сессии из Set-Cookie, чтобы переиспользовать в следующих запросах. */
function extractCookie(res) {
  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);
  return raw.map(c => c.split(';')[0]).join('; ');
}

async function post(url, path, body, headers = {}) {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
    redirect: 'manual',
  });
}

/** Делает запрос и разбирает JSON. Бросает, если статус не 2xx — кроме raw: true. */
async function call(url, cookie, method, path, body, headers = {}, raw = false) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'manual',
  });
  if (raw) return res;
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
    e.status = res.status;
    e.body = data;
    throw e;
  }
  return data;
}

const api = (url, cookie, method, path, body, headers, raw) =>
  call(url, cookie, method, path, body, headers, raw);
const getJson = (url, cookie, path, headers) =>
  call(url, cookie, 'GET', path, undefined, headers);

/**
 * Поднимает сервер (или переиспользует переданный), регистрирует пользователя
 * и логинится. Без SMTP регистрация сразу подтверждена.
 */
async function loggedIn({ email = 'user@example.com', password = 'secret12', server, env, fetchImpl } = {}) {
  const srv = server ?? await startTestServer({ env, fetchImpl });
  await post(srv.url, '/api/v1/auth/register', { email, password });
  const login = await post(srv.url, '/api/v1/auth/login', { emailOrUsername: email, password });
  if (login.status !== 200) {
    throw new Error(`Не удалось войти: ${login.status} ${await login.text()}`);
  }
  const cookie = extractCookie(login);
  return {
    srv, url: srv.url, db: srv.db, app: srv.app, config: srv.config, cookie,
    close: () => srv.close(),
  };
}

module.exports = {
  loggedIn, post, api, getJson, call, extractCookie,
  today, dayFromToday, nextWeekday, TZ,
};
