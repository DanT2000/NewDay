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
import * as diag from './diag.js';

const KEY_BASE = 'newday.apiBase';
const KEY_TOKEN = 'newday.deviceToken';
/** Дольше этого — уже заметно человеку, и в дневнике этому место. */
const SLOW_MS = 2000;

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

/*
 * У каждого запроса есть предел ожидания.
 *
 * Без него «Сохраняю…», «Разбираю…» и «Распознаю…» висели столько, сколько
 * браузер решит держать соединение: в гостиничном вайфае это минуты, а на
 * экране всё это время ни ответа, ни кнопки. Отказ по времени — тоже ответ,
 * и очередь правок с ним работает как с любым отсутствием связи.
 *
 * Помощник и выгрузка честно долгие: у них свой предел, иначе разбор дня
 * обрывался бы на середине.
 */
const ЖДЁМ_МС = 20000;
const ЖДЁМ_ДОЛГО_МС = 120000;
const долгийПуть = p => /^\/(ai|import|export|reports)\b/.test(p);

/** fetch с пределом ожидания: по истечении — понятный отказ, а не вечное ожидание. */
async function сПределом(url, init, мс) {
  // AbortSignal.timeout есть не везде, где работает приложение
  const ctrl = new AbortController();
  const таймер = setTimeout(() => ctrl.abort(), мс);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(таймер);
  }
}

async function request(method, path, body, headers = {}) {
  const token = deviceToken();
  const started = Date.now();
  const предел = долгийПуть(path) ? ЖДЁМ_ДОЛГО_МС : ЖДЁМ_МС;
  let res;
  try {
    res = await сПределом(apiBase() + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, предел);
  } catch (e) {
    const мс = Date.now() - started;
    if (e?.name === 'AbortError') {
      diag.note('сеть', `${method} ${path} — не дождались ответа`, { мс });
      throw new ApiError(0, 'TIMEOUT', 'Сервер не ответил вовремя');
    }
    diag.note('сеть', `${method} ${path} — не дозвонились`, { мс });
    throw new ApiError(0, 'NETWORK', 'Нет связи с сервером');
  }
  /*
   * Долгие запросы — в дневник. «Приложение тормозит» почти всегда значит
   * «сервер отвечал четыре секунды», и без отметок это не отличить от
   * медленной отрисовки.
   */
  const ms = Date.now() - started;
  if (ms > SLOW_MS) diag.note('медленно', `${method} ${path}`, { мс: ms });

  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'UNAUTHORIZED', 'Требуется вход');
  }
  if (res.status === 204) return null;

  const type = res.headers.get('content-type') || '';
  const поJson = type.includes('application/json');
  const data = поJson ? await res.json().catch(() => ({})) : null;

  /*
   * Отказ разбираем раньше, чем тип ответа.
   *
   * Обратный порядок означал, что любой HTML от прокси — 502 от шлюза, 413
   * «тело слишком велико» — читался человеку как «Сервер ответил не по-JSON.
   * Проверьте адрес сервера в настройках входа». Адрес был верным, и совет
   * уводил в сторону; а очередь правок считала такой ответ отсутствием связи
   * и повторяла запрос без конца.
   */
  if (!res.ok) {
    const e = (data && data.error) || {};
    diag.note('отказ', `${method} ${path} → ${res.status} ${e.message || e.code || ''}`.trim(), { мс: ms });
    throw new ApiError(res.status, e.code || 'HTTP_ERROR',
      e.message || сообщениеПоСтатусу(res.status), e.details);
  }

  // Локальный сервер Capacitor отдаёт index.html на неизвестные пути.
  // Без этой проверки такой ответ выглядел бы как успешный вызов API.
  if (!поJson) {
    diag.note('отказ', `${method} ${path} → ответ не JSON (${res.status}, ${type || 'без типа'})`);
    throw new ApiError(res.status, 'BAD_RESPONSE',
      'Сервер ответил не по-JSON. Проверьте адрес сервера в настройках входа.');
  }
  return data;
}

/** Что сказать человеку, когда сервер отказал без своего объяснения. */
function сообщениеПоСтатусу(status) {
  if (status === 413) return 'Слишком большой запрос — сервер его не принял';
  if (status === 429) return 'Слишком часто — подождите немного';
  if (status === 502 || status === 503 || status === 504) return 'Сервер сейчас недоступен';
  if (status >= 500) return 'Сервер ответил ошибкой';
  return `Ошибка ${status}`;
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
    res = await сПределом(apiBase() + path, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    }, ЖДЁМ_ДОЛГО_МС);   // здесь везут запись голоса — по мобильной сети это долго
  } catch (e) {
    if (e?.name === 'AbortError') {
      diag.note('сеть', `форма ${path} — не дождались ответа`);
      throw new ApiError(0, 'TIMEOUT', 'Сервер не ответил вовремя');
    }
    diag.note('сеть', `форма ${path} — не дозвонились`);
    throw new ApiError(0, 'NETWORK', 'Нет связи с сервером');
  }

  if (res.status === 401) { onUnauthorized(); throw new ApiError(401, 'UNAUTHORIZED', 'Требуется вход'); }
  if (res.status === 204) return {};
  /*
   * Тип ответа проверяем и здесь. Раньше `postForm` брал любой ответ: HTML от
   * прокси со статусом 200 становился пустым `{}` и уходил дальше как успех —
   * в поле диктовки появлялось слово «undefined», а следующее нажатие падало.
   */
  const поJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = поJson ? await res.json().catch(() => ({})) : null;
  if (!res.ok) {
    const e = (data && data.error) || {};
    diag.note('отказ', `форма ${path} → ${res.status} ${e.message || e.code || ''}`.trim());
    throw new ApiError(res.status, e.code || 'HTTP_ERROR',
      e.message || сообщениеПоСтатусу(res.status));
  }
  if (!поJson) {
    diag.note('отказ', `форма ${path} → ответ не JSON (${res.status})`);
    throw new ApiError(res.status, 'BAD_RESPONSE', 'Сервер ответил не по-JSON');
  }
  return data;
}
export const PATCH  = (p, b, h) => request('PATCH', p, b, h);
export const PUT    = (p, b, h) => request('PUT', p, b, h);
export const DELETE = (p, h)    => request('DELETE', p, undefined, h);
/**
 * DELETE с телом — редкость, но подписку на уведомления снимают именно так:
 * адрес подписки слишком длинный для строки запроса.
 *
 * Отдельным именем, а не третьим аргументом у DELETE: там второй аргумент —
 * заголовки, и объект с телом, переданный на его место, уезжал заголовком.
 * Ровно так и вышло с отключением уведомлений: сервер получал запрос без
 * тела, не находил подписку, отвечал отказом — а отказ проглатывался, и
 * экран продолжал писать «этот браузер подписан».
 */
export const DELETE_BODY = (p, b, h) => request('DELETE', p, b, h);

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
  // Привязать строку к повтору или отвязать: seriesId = null снимает связь
  setSeries: (date, id, seriesId) =>
    POST(`/days/${date}/schedule/${id}/series`, { seriesId }),
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
/*
 * Объявление для всех вошедших. `rev` растёт только при смене текста, поэтому
 * по нему видно, что объявление именно новое: включение и выключение того же
 * текста закрытую человеком полосу обратно не вытаскивает.
 */
export const announce = () => GET('/announce');
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

export const sounds = {
  list:   () => GET('/sounds'),
  upload: (file, name) => {
    const form = new FormData();
    form.append('file', file);
    if (name) form.append('name', name);
    return postForm('/sounds', form);
  },
  remove: id => DELETE(`/sounds/${id}`),
  /**
   * Сам файл — как blob, с токеном в заголовке: тег audio заголовков не
   * умеет, а в приложении доступ живёт именно на токене устройства.
   */
  async fileBlob(id) {
    const token = deviceToken();
    const res = await fetch(`${apiBase()}/sounds/${id}/file`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, 'ERROR', 'Звук не скачался');
    return res.blob();
  },
};
export const exportAll = () => GET('/export');
export const importAll = (data, mode) => POST('/import', { data, mode });
