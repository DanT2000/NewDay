/**
 * Даты и время в таймзоне пользователя.
 *
 * В приложении «день» — календарное понятие, а не момент времени, поэтому в базе
 * лежат строки YYYY-MM-DD. Единственный способ узнать текущую дату — todayFor():
 * прямой new Date().toISOString() даёт UTC и ломает всё между полуночью и утром.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MASK_ALL = 127;

const fmtCache = new Map();
function formatter(timeZone) {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; }
  catch { return false; }
}

function isValidDate(str) {
  if (typeof str !== 'string' || !DATE_RE.test(str)) return false;
  const [y, m, d] = str.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y
      && probe.getUTCMonth() === m - 1
      && probe.getUTCDate() === d;
}

/** Текущая календарная дата в указанной таймзоне. Локаль en-CA даёт YYYY-MM-DD. */
function todayFor(timeZone, now = new Date()) {
  try {
    return formatter(timeZone || 'UTC').format(now);
  } catch {
    return formatter('UTC').format(now);
  }
}

/** Арифметика ведётся в UTC-полдень: переход на летнее время не может сдвинуть дату. */
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, 12));
  t.setUTCDate(t.getUTCDate() + n);
  const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(t.getUTCDate()).padStart(2, '0');
  return `${t.getUTCFullYear()}-${mm}-${dd}`;
}

function diffDays(fromStr, toStr) {
  const p = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d, 12); };
  return Math.round((p(toStr) - p(fromStr)) / 86400000);
}

/** Включительно с обоих концов. Пустой массив, если from > to или дата невалидна. */
function rangeDates(from, to) {
  if (!isValidDate(from) || !isValidDate(to) || from > to) return [];
  const out = [];
  let cur = from;
  while (cur <= to) { out.push(cur); cur = addDays(cur, 1); }
  return out;
}

/** 1 = понедельник … 7 = воскресенье. */
function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const js = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0 = воскресенье
  return js === 0 ? 7 : js;
}

function weekdayInMask(dateStr, mask) {
  const m = (mask === undefined || mask === null) ? MASK_ALL : mask;
  return ((m & (1 << (weekdayOf(dateStr) - 1))) !== 0);
}

/** Понимает 9, 9:30, 930, 9.30, 09:05. Возвращает минуты от полуночи или null. */
function parseTimeToMinutes(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;

  let h, min, m;
  if ((m = s.match(/^(\d{1,2})[:.\s](\d{2})$/))) { h = +m[1]; min = +m[2]; }
  else if ((m = s.match(/^(\d{3,4})$/))) {
    h = +m[1].slice(0, m[1].length - 2);
    min = +m[1].slice(-2);
  }
  else if ((m = s.match(/^(\d{1,2})$/))) { h = +m[1]; min = 0; }
  else return null;

  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function formatMinutes(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Диапазон «9:00-13:00» или одиночное «9:00».
 * Старая эвристика «6-9 значит 18:00–21:00» намеренно не переносится: она угадывала.
 */
function parseTimeRange(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const parts = input.trim().split(/\s*[–—-]\s*/);
  const startMin = parseTimeToMinutes(parts[0]);
  if (startMin === null) return null;

  if (parts.length === 1) {
    return { startMin, endMin: null, display: formatMinutes(startMin) };
  }
  const endMin = parseTimeToMinutes(parts[1]);
  if (endMin === null) return null;
  return {
    startMin, endMin,
    display: `${formatMinutes(startMin)}–${formatMinutes(endMin)}`,
  };
}

module.exports = {
  MASK_ALL,
  isValidDate, isValidTimezone, todayFor, addDays, diffDays, rangeDates,
  weekdayOf, weekdayInMask, parseTimeToMinutes, formatMinutes, parseTimeRange,
};
