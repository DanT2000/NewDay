/**
 * Клиент API v1.
 *
 * Три вещи, которых не делал старый клиент и из-за которых терялись данные:
 *  - ошибка чтения дня НЕ подменяется пустым объектом, она всплывает наверх;
 *  - на 409 REV_MISMATCH день перечитывается, а не перезаписывается;
 *  - на 401 уходим на вход, а не пишем в пустоту.
 */

/**
 * База API и токен.
 *
 * В браузере на самом сайте всё относительное и работает на cookie-сессии.
 * В приложении ассеты вшиты в APK, origin — https://localhost, поэтому нужен
 * абсолютный адрес сервера и device-токен в заголовке: cookie кросс-доменно
 * не пройдут, и полагаться на них было бы самообманом.
 */
const KEY_BASE = 'newday.apiBase';
const KEY_TOKEN = 'newday.deviceToken';

export const isNative = () => Boolean(globalThis.Capacitor?.isNativePlatform?.());

export function apiBase() {
  const stored = localStorage.getItem(KEY_BASE);
  if (stored) return stored.replace(/\/+$/, '') + '/api/v1';
  return '/api/v1';
}

export const deviceToken = () => localStorage.getItem(KEY_TOKEN);
export function setApiBase(url) {
  if (url) localStorage.setItem(KEY_BASE, url.replace(/\/+$/, ''));
  else localStorage.removeItem(KEY_BASE);
}
export function setDeviceToken(token) {
  if (token) localStorage.setItem(KEY_TOKEN, token);
  else localStorage.removeItem(KEY_TOKEN);
}

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let onUnauthorized = () => {
  if (isNative()) setDeviceToken(null);
  location.replace('/login.html');
};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

async function request(method, path, body, headers = {}) {
  const token = deviceToken();
  let res;
  try {
    res = await fetch(apiBase() + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Нет связи с сервером');
  }

  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'UNAUTHORIZED', 'Требуется вход');
  }
  if (res.status === 204) return null;

  // Локальный сервер Capacitor отдаёт index.html на неизвестные пути.
  // Без этой проверки такой ответ выглядел бы как успешный вызов API.
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    throw new ApiError(res.status, 'BAD_RESPONSE',
      'Сервер ответил не по-JSON. Проверьте адрес сервера в настройках входа.');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error || {};
    throw new ApiError(res.status, e.code || 'ERROR', e.message || `Ошибка ${res.status}`, e.details);
  }
  return data;
}

export const GET    = (p, h)    => request('GET', p, undefined, h);
export const POST   = (p, b, h) => request('POST', p, b, h);

/**
 * Отправка формы: нужна только там, где везут файл, — сейчас это запись
 * голоса. Content-Type не ставим руками: браузер сам допишет границу
 * multipart, а заданный вручную заголовок эту границу потеряет и сервер
 * получит нечитаемое тело.
 */
export async function postForm(path, form) {
  const token = deviceToken();
  let res;
  try {
    res = await fetch(apiBase() + path, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Нет связи с сервером');
  }

  if (res.status === 401) { onUnauthorized(); throw new ApiError(401, 'UNAUTHORIZED', 'Требуется вход'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error || {};
    throw new ApiError(res.status, e.code || 'ERROR', e.message || `Ошибка ${res.status}`);
  }
  return data;
}
export const PATCH  = (p, b, h) => request('PATCH', p, b, h);
export const PUT    = (p, b, h) => request('PUT', p, b, h);
export const DELETE = (p, h)    => request('DELETE', p, undefined, h);

/**
 * Операции, переписывающие день целиком, требуют If-Match с его rev.
 * При расхождении сервер возвращает актуальный день — берём его rev
 * и повторяем один раз, вместо того чтобы затирать чужую правку.
 */
export async function withRev(method, path, body, rev) {
  try {
    return await request(method, path, body, { 'If-Match': `"${rev}"` });
  } catch (e) {
    if (e.code !== 'REV_MISMATCH' || !e.details?.current) throw e;
    return request(method, path, body, { 'If-Match': `"${e.details.current.rev}"` });
  }
}

// ── Дни ──────────────────────────────────────────────────────
export const getDay     = date => GET(`/days/${date}/full`);
export const listDays   = (from, to) => GET(`/days?from=${from}&to=${to}`);
export const patchDay   = (date, fields, rev) => withRev('PATCH', `/days/${date}`, fields, rev);
export const replaceDay = (date, body, rev) => withRev('PUT', `/days/${date}/full`, body, rev);
export const deleteDay  = date => DELETE(`/days/${date}`);
export const copyDay    = (date, targetDate, sections) =>
  POST(`/days/${date}/copy-to`, { targetDate, sections });

// ── Строки дня ───────────────────────────────────────────────
const entity = seg => ({
  create:  (date, data)      => POST(`/days/${date}/${seg}`, data),
  update:  (date, id, data)  => PATCH(`/days/${date}/${seg}/${id}`, data),
  remove:  (date, id)        => DELETE(`/days/${date}/${seg}/${id}`),
  reorder: (date, ids)       => POST(`/days/${date}/${seg}/reorder`, { ids }),
});

export const schedule = { ...entity('schedule'),
  shift: (date, fromId, minutes, cascade) =>
    POST(`/days/${date}/schedule/shift`, { fromId, minutes, cascade }),
};
export const tasks = entity('tasks');
export const meals = entity('meals');
export const sport = entity('sport');

// ── Повторы и шаблоны ────────────────────────────────────────
/*
 * Одна таблица, два смысла: правило без имени — повтор, он сам достраивает
 * дни; правило с именем — шаблон, он применяется вручную. Разделяет их
 * `?templates=1`, поэтому список шаблонов и список повторов не смешиваются.
 */
export const series = {
  list:      ({ templates = null } = {}) =>
    GET(`/series${templates === null ? '' : `?templates=${templates ? 1 : 0}`}`),
  create:    data       => POST('/series', data),
  update:    (id, data) => PATCH(`/series/${id}`, data),
  remove:    id         => DELETE(`/series/${id}`),
  endFrom:   (id, date) => DELETE(`/series/${id}?from=${date}`),
  applyTo:   (id, date) => POST(`/series/${id}/apply`, { date }),
};

// ── Привычки ─────────────────────────────────────────────────
export const habits = {
  list:    (archived = false) => GET(`/habits${archived ? '?archived=1' : ''}`),
  create:  data       => POST('/habits', data),
  update:  (id, data) => PATCH(`/habits/${id}`, data),
  archive: id         => DELETE(`/habits/${id}`),
  restore: id         => POST(`/habits/${id}/restore`),
  destroy: id         => DELETE(`/habits/${id}?hard=1`),
  reorder: ids        => POST('/habits/reorder', { ids }),
  stats:   (id, from, to) => GET(`/habits/${id}/stats?from=${from || ''}&to=${to || ''}`),
  setLog:  (id, date, status, value) => PUT(`/habits/${id}/log/${date}`, { status, value }),
  clearLog:(id, date) => DELETE(`/habits/${id}/log/${date}`),
};

// ── Прочее ───────────────────────────────────────────────────
export const stats      = (from, to) => GET(`/stats?from=${from}&to=${to}`);
export const getSettings = () => GET('/settings');
export const saveSettings = fields => PATCH('/settings', fields);
export const me         = () => GET('/auth/me');
export const logout     = () => POST('/auth/logout');
export const changePassword = (currentPassword, newPassword) =>
  POST('/auth/password', { currentPassword, newPassword });

export const tokens = {
  list:   () => GET('/tokens'),
  create: (name, scope) => POST('/tokens', { name, scope }),
  revoke: id => DELETE(`/tokens/${id}`),
};
export const devices = {
  list:   () => GET('/devices'),
  revoke: id => DELETE(`/devices/${id}`),
  pair:   () => POST('/auth/pair/create'),
};
export const exportAll = () => GET('/export');
export const importAll = (data, mode) => POST('/import', { data, mode });
