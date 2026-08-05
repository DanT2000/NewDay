/**
 * Выгрузка расписания в iCalendar (.ics) — RFC 5545.
 *
 * Зачем помимо своего JSON: свой формат понимает только NewDay, а .ics
 * открывают все календари. Это путь наружу — посмотреть свой день в Google
 * Calendar или на часах, не дожидаясь, пока появится синхронизация.
 *
 * Выгружается расписание: у задач и привычек нет ни начала, ни конца, и
 * событиями они не являются. Приёмы пищи попадают, только если у них есть
 * время — иначе это чек-лист, а не событие.
 */

const { formatMinutes } = require('./dates');

/**
 * Перевод строк по RFC — CRLF, и длинные строки складываются.
 * Складывать обязательно: строки длиннее 75 октетов часть календарей
 * молча обрезает.
 */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 73) return line;
  const out = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + (start === 0 ? 73 : 72), bytes.length);
    // не разрываем многобайтовый символ
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    out.push((start === 0 ? '' : ' ') + bytes.slice(start, end).toString('utf8'));
    start = end;
  }
  return out.join('\r\n');
}

/** Точка с запятой, запятая, обратный слэш и перевод строки экранируются. */
function esc(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

const stamp = iso => iso.replace(/[-:]/g, '').replace(/\.\d+/, '');

/** 2026-08-04 + 390 мин → 20260804T063000 (местное время календаря). */
function localStamp(date, minutes) {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${date.replace(/-/g, '')}T${hh}${mm}00`;
}

/**
 * @param rows   строки расписания: { date, start_min, end_min, title, note, kind }
 * @param meals  приёмы пищи со временем
 * @param opts   { timeZone, calendarName, now }
 */
function buildIcs({ schedule = [], meals = [] }, opts = {}) {
  const tz = opts.timeZone || 'Europe/Moscow';
  const name = opts.calendarName || 'NewDay';
  const nowStamp = stamp(opts.now || new Date().toISOString());

  const events = [];

  const push = (row, prefix, minutes, endMinutes) => {
    const start = minutes;
    // Событие без конца длится полчаса: нулевая длительность в календарях
    // выглядит как точка и часто просто не рисуется.
    const end = endMinutes !== null && endMinutes !== undefined && endMinutes > start
      ? endMinutes : start + 30;
    events.push([
      'BEGIN:VEVENT',
      `UID:${prefix}-${row.date}-${start}-${row.sort_order ?? 0}@newday`,
      `DTSTAMP:${nowStamp}Z`,
      `DTSTART;TZID=${tz}:${localStamp(row.date, start)}`,
      `DTEND;TZID=${tz}:${localStamp(row.date, Math.min(end, 24 * 60 - 1))}`,
      `SUMMARY:${esc(row.title || row.exercise || 'Без названия')}`,
      row.note ? `DESCRIPTION:${esc(row.note)}` : null,
      row.done ? 'STATUS:CONFIRMED' : null,
      'END:VEVENT',
    ].filter(Boolean));
  };

  for (const row of schedule) {
    if (row.start_min === null || row.start_min === undefined) continue;
    push(row, 'sched', row.start_min, row.end_min);
  }
  for (const row of meals) {
    if (row.time_min === null || row.time_min === undefined) continue;
    /*
     * У окна конец задан («обед с 12:00 до 14:00»), у точного времени — нет,
     * и тогда полчаса это разумная догадка. Без учёта конца окно уезжало в
     * календарь получасовой точкой.
     */
    const end = row.end_min === null || row.end_min === undefined ? row.time_min + 30 : row.end_min;
    push({ ...row, title: row.title || 'Приём пищи' }, 'meal', row.time_min, end);
  }

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//NewDay//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`,
    `X-WR-TIMEZONE:${tz}`,
    ...events.flat(),
    'END:VCALENDAR',
  ];

  return lines.map(fold).join('\r\n') + '\r\n';
}

module.exports = { buildIcs, esc, fold, localStamp, formatMinutes };
