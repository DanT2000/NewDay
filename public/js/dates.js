/**
 * Даты на клиенте. Тот же контракт, что на сервере:
 * дата — строка YYYY-MM-DD, время — минуты от полуночи.
 */

const DOW_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const DOW_LONG = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const MONTH_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
                   'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export function todayFor(timeZone = 'Europe/Moscow', now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
  }
}

/** Минуты, прошедшие с полуночи в таймзоне пользователя. */
export function nowMinutes(timeZone = 'Europe/Moscow', now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const h = +parts.find(p => p.type === 'hour').value;
  const m = +parts.find(p => p.type === 'minute').value;
  return h * 60 + m;
}

export function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, 12));
  t.setUTCDate(t.getUTCDate() + n);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

export function diffDays(from, to) {
  const p = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d, 12); };
  return Math.round((p(to) - p(from)) / 86400000);
}

export function rangeDates(from, to) {
  if (!isValidDate(from) || !isValidDate(to) || from > to) return [];
  const out = [];
  for (let cur = from; cur <= to; cur = addDays(cur, 1)) out.push(cur);
  return out;
}

/** 1 = понедельник … 7 = воскресенье */
export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const js = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return js === 0 ? 7 : js;
}

export const weekdayShort = dateStr => DOW_SHORT[weekdayOf(dateStr) - 1];
export const weekdayLong  = dateStr => DOW_LONG[weekdayOf(dateStr) - 1];
export const dayNumber    = dateStr => +dateStr.slice(8, 10);

/** «Понедельник, 3 августа» */
export function formatLong(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${weekdayLong(dateStr)}, ${d} ${MONTH_GEN[m - 1]}`;
}

/** «3 авг» */
export function formatShort(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTH_GEN[m - 1].slice(0, 3)}`;
}

/** Понимает 9, 9:30, 930, 9.30. Возвращает минуты или null. */
export function parseTimeToMinutes(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  let h, min, m;
  if ((m = s.match(/^(\d{1,2})[:.\s](\d{2})$/))) { h = +m[1]; min = +m[2]; }
  else if ((m = s.match(/^(\d{3,4})$/))) { h = +m[1].slice(0, m[1].length - 2); min = +m[1].slice(-2); }
  else if ((m = s.match(/^(\d{1,2})$/))) { h = +m[1]; min = 0; }
  else return null;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function formatMinutes(min) {
  if (min === null || min === undefined) return '';
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** «23 мин», «1 ч 05», «—» */
export function formatDuration(min) {
  if (min === null || min === undefined || min < 0) return '—';
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} ч ${String(m).padStart(2, '0')}` : `${h} ч`;
}

/** Русское склонение: 1 день, 2 дня, 5 дней */
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export const days = n => `${n} ${plural(n, 'день', 'дня', 'дней')}`;
