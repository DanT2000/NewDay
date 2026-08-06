/**
 * Перевод ответов сервера в то, чем рисует экран.
 *
 * Сервер отдаёт строки как они лежат в базе: `start_min`, `alarm_mode`,
 * `done: 1`. Экран нарисован по эталону и ждёт `start`, `alarm`, `done: true`.
 * Здесь один слой перевода — вместо того чтобы разбирать snake_case в
 * тридцати местах разметки.
 *
 * Обратный перевод тоже здесь: что уходит на сервер, когда человек нажал
 * «Готово» в редакторе строки.
 */

/** Четыре степени напоминания у модели против трёх у сервера плюс профиль. */
const TO_ALARM = {
  none: 'off',
  notify: 'notify',
  alarm: 'alarm',
};

const FROM_ALARM = {
  off: { alarmMode: 'none', alarmProfile: 'gentle' },
  notify: { alarmMode: 'notify', alarmProfile: 'gentle' },
  sound: { alarmMode: 'alarm', alarmProfile: 'gentle' },
  alarm: { alarmMode: 'alarm', alarmProfile: 'wakeup' },
};

/** «Со звуком» — это будильник с мягким профилем; так они и различаются. */
function alarmOf(row) {
  if (row.alarm_mode === 'alarm') return row.alarm_profile === 'wakeup' ? 'alarm' : 'sound';
  return TO_ALARM[row.alarm_mode] ?? 'off';
}

/*
 * `end` — не срок, а отметка «к концу окна»: у окна «обед с 12:00 до 14:00»
 * это 14:00. В минутах «до начала» такое число зависело бы от ширины окна и
 * уезжало при её правке, поэтому храним отметку, а момент считает сервер.
 */
const LEAD_MIN = { at: 0, 5: 5, 15: 15, 30: 30, 60: 60, day: 1440, week: 10080, end: -1 };
const MIN_LEAD = Object.fromEntries(Object.entries(LEAD_MIN).map(([k, v]) => [v, k]));

/**
 * Метки «предупредить». Сроков может быть несколько, и лежат они списком в
 * `remind_before_json`; прежнее одиночное число остаётся запасным путём —
 * строки, созданные до списка, и повторы читаются им же.
 */
function leadsOf(row) {
  const list = parseLeads(row.remind_before_json);
  if (list) return list.map(m => MIN_LEAD[m] ?? String(m));

  const m = row.remind_before_min;
  if (m === null || m === undefined || m === 0) return ['at'];
  return [MIN_LEAD[m] ?? String(m)];
}

function parseLeads(raw) {
  if (!raw) return null;
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) && list.length ? list : null;
  } catch { return null; }
}

/**
 * Строка расписания. `past` и `now` считаются от текущей минуты — но только
 * для сегодняшнего дня: «сейчас» во вчерашнем расписании не существует.
 */
export function scheduleRow(row, { isToday, minutes }) {
  const end = row.end_min ?? null;
  const now = isToday && row.start_min <= minutes && (end ?? row.start_min + 1) > minutes;
  const past = isToday && !now && (end ?? row.start_min) <= minutes;
  return {
    id: row.id,
    start: row.start_min,
    end,
    title: row.title || 'Без названия',
    done: row.done === 1,
    alarm: alarmOf(row),
    leads: leadsOf(row),
    kind: row.kind,
    fromFood: row.kind === 'meal',
    /*
     * Напоминание — момент, а не отрезок. Признак берём по типу, а не по
     * пустому концу: блок без конца («момент, о котором просто помню») и
     * напоминание выглядят и красятся по-разному.
     */
    isReminder: row.kind === 'reminder',
    color: row.color || null,
    note: row.note || '',
    seriesId: row.series_id ?? null,
    past,
    now,
    raw: row,
  };
}

export const schedule = (day, { minutes, todayKey }) =>
  (day?.schedule ?? []).map(r => scheduleRow(r, { isToday: day?.date === todayKey, minutes }));

/** Задачи приходят разложенными по разделам; экрану нужен один список. */
export function tasks(day) {
  const out = [];
  for (const [bucket, rows] of Object.entries(day?.tasks ?? {})) {
    for (const t of rows) {
      out.push({
        id: t.id,
        title: t.text || 'Без названия',
        done: t.done === 1,
        cat: bucket,
        meta: t.carried_from ? `↩ с ${shortDate(t.carried_from)}` : '',
        raw: t,
      });
    }
  }
  return out;
}

/**
 * Режим времени приёма пищи читается из пары времён, а не из отдельного поля:
 * пусто — пункт плана, оба заполнены — окно, только начало — точное время.
 */
export const mealMode = m => {
  if (m.time_min === null || m.time_min === undefined) return 'none';
  return m.end_min === null || m.end_min === undefined ? 'exact' : 'window';
};

export const meals = day => (day?.meals ?? []).map(m => ({
  id: m.id,
  title: m.title || 'Без названия',
  kcal: m.calories ?? null,
  done: m.done === 1,
  alarm: parseLeads(m.remind_before_json) ? 'notify' : 'off',
  mode: mealMode(m),
  start: m.time_min ?? null,
  end: m.end_min ?? null,
  leads: leadsOf(m),
  scheduled: Boolean(m.schedule_item_id),
  meta: mealMeta(m),
  raw: m,
}));

function mealMeta(m) {
  const parts = [];
  const mode = mealMode(m);
  if (mode === 'none') parts.push('без времени');
  else if (mode === 'window') parts.push(`окно ${hhmm(m.time_min)}–${hhmm(m.end_min)}`);
  else parts.push(hhmm(m.time_min));
  if (m.slot && m.slot !== 'other') parts.push(SLOT_LABEL[m.slot] ?? m.slot);
  if (m.schedule_item_id) parts.push('в расписании');
  return parts.join(' · ');
}

const SLOT_LABEL = { breakfast: 'завтрак', lunch: 'обед', dinner: 'ужин', snack: 'перекус' };

/**
 * Привычки. Неделя приходит списком дней со статусом — переводим в те же
 * четыре состояния, которыми рисуются полоски: сделано, пропущено,
 * отложено, выходной.
 */
export const habits = day => (day?.habits ?? []).map(h => ({
  id: h.id,
  emoji: h.emoji || '•',
  title: h.title,
  done: h.status === 'done',
  status: h.status,
  active: h.activeToday !== false,
  meta: habitMeta(h),
  week: (h.week ?? []).map(d => (!d.active ? 'off' : d.status === 'done' ? 'done' : d.status === 'skipped' ? 'skip' : d.status === 'missed' ? 'miss' : 'none')),
  raw: h,
}));

function habitMeta(h) {
  if (h.activeToday === false) return 'сегодня по графику выходной';
  const parts = [];
  if (h.challenge) parts.push(`челлендж ${h.challenge.done ?? 0} из ${h.challenge.target ?? 0} дней`);
  /*
   * У свободного графика серия подряд ничего не значит: обещание считается
   * за неделю. Поэтому вместо серии — норма недели.
   */
  else if (h.weekNorm) parts.push(`${h.weekNorm.done} из ${h.weekNorm.target} за неделю`);
  else if (h.streak) parts.push(`подряд ${h.streak} ${plural(h.streak, 'день', 'дня', 'дней')}`);
  if (h.bestStreak && !h.weekNorm) parts.push(`лучшая серия ${h.bestStreak}`);
  return parts.join(' · ') || 'ещё не отмечалась';
}

/**
 * Заметки: сервер отдаёт по одной на день, заголовок — первая строка.
 * `on` — «относится к открытому дню»: по нему разделяются фильтры и
 * набирается список заметок дня на экране «Сейчас».
 */
export const notes = (rows, todayKey, openDate = todayKey) => rows.map(n => {
  const text = String(n.text || '');
  const title = String(n.title || '').trim();
  return {
    id: n.id ?? n.date,
    dated: Boolean(n.date),
    dateKey: n.date ?? null,
    date: n.date ? (n.date === todayKey ? 'сегодня' : shortDate(n.date)) : 'без даты',
    on: Boolean(n.date) && n.date === openDate,
    title: title.length > 48 ? `${title.slice(0, 48)}…` : (title || 'Без заголовка'),
    text,
    raw: n,
  };
});

// ── Обратный перевод ─────────────────────────────────────────

/**
 * Что уходит на сервер из редактора строки. Сроков предупреждения может
 * быть несколько — уходят списком минут; сервер сам оставит первым самый
 * ранний.
 */
export const rowToServer = ({ title, start, end, alarm, leads, color, kind, note }) => ({
  title: String(title ?? '').trim(),
  // комментарий к активности: коротко, чтобы влезал в блок и не рос в статью
  note: String(note ?? '').slice(0, 300),
  startMin: start,
  // У напоминания конца нет по определению: это момент, а не отрезок
  endMin: kind === 'reminder' ? null : (end ?? null),
  ...FROM_ALARM[alarm ?? 'off'],
  remindBefore: (leads?.length ? leads : ['at']).map(k => LEAD_MIN[k] ?? 0),
  color: color ?? null,
  kind: kind ?? 'normal',
});

/**
 * Что уходит на сервер из редактора приёма пищи. Режим времени в запрос не
 * попадает — он и есть пара времён: без времени оба пусты, у окна заполнены
 * оба, у точного времени только начало.
 */
export const mealToServer = ({ title, slot, mode, start, end, kcal, leads }) => ({
  title: String(title ?? '').trim(),
  slot: slot || 'other',
  timeMin: mode === 'none' ? null : (start ?? null),
  endMin: mode === 'window' ? (end ?? null) : null,
  calories: kcal === '' || kcal === null || kcal === undefined ? null : Number(kcal),
  remindBefore: mode === 'none' ? [] : (leads?.length ? leads : ['at']).map(k => LEAD_MIN[k] ?? 0),
});

/**
 * Шаблон дня. Правило с именем хранит набор строк в `payload_json` теми же
 * полями, что и строка расписания, — поэтому редактор строки подошёл без
 * переделки, а `applyTemplate` на сервере кладёт их в день как есть.
 */
export function templateRows(rule) {
  if (!rule) return [];
  let payload;
  try { payload = JSON.parse(rule.payload_json ?? '{}'); } catch { return []; }
  const rows = Array.isArray(payload.rows) ? payload.rows : [payload];
  return rows
    .filter(r => r && typeof r === 'object')
    .map(r => ({
      start: r.startMin ?? 0,
      end: r.endMin ?? null,
      title: r.title || 'Без названия',
      // В шаблоне поля camelCase, у строки дня — snake_case; переводим
      // в общий вид, чтобы обе читались одним кодом
      alarm: alarmOf({ alarm_mode: r.alarmMode, alarm_profile: r.alarmProfile }),
      /*
       * Сроки читаем из списка, а одиночное число — только как запас. Раньше
       * список не читался вовсе, и заданное «за 30 минут» при следующем
       * открытии шаблона показывалось как «вовремя».
       */
      leads: leadsOf({
        remind_before_json: Array.isArray(r.remindBefore) ? JSON.stringify(r.remindBefore) : null,
        remind_before_min: r.remindBeforeMin,
      }),
      color: r.color ?? null,
      /*
       * Тип и комментарий тоже. Сервер их в шаблоне хранит и переносит, а
       * клиент не читал и не отправлял — и напоминание уезжало в общее
       * расписание обычным блоком. Хуже того, шаблон пишется набором целиком,
       * поэтому правка одной строки обнуляла тип и комментарий у всех.
       */
      kind: r.kind ?? 'normal',
      note: r.note ?? '',
      isReminder: r.kind === 'reminder',
    }))
    .sort((a, b) => a.start - b.start);
}

/**
 * Обратно: то, что уходит в `POST /series` и `PATCH /series/:id`.
 *
 * Поле называется `leads`, а не `lead`: из-за опечатки сроки не доезжали
 * никогда, и каждая строка шаблона сохранялась как «вовремя».
 */
export const templateToServer = rows => rows.map(r => rowToServer({
  title: r.title, start: r.start, end: r.end,
  alarm: r.alarm, leads: r.leads, color: r.color,
  kind: r.kind, note: r.note,
}));

export const taskToServer = ({ title, cat }) => ({
  text: String(title ?? '').trim(),
  bucket: cat === 'work' ? 'work' : 'home',
});

/** Сроки предупреждения в минутах — тем же словарём, что и у строки. */
export const leadMinutes = leads => (leads?.length ? leads : ['at']).map(k => LEAD_MIN[k] ?? 0);

// ── Мелочи ───────────────────────────────────────────────────

const pad2 = n => String(n).padStart(2, '0');
export const hhmm = min => `${pad2(Math.floor(((min % 1440) + 1440) % 1440 / 60))}:${pad2(min % 60)}`;

const SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
export function shortDate(date) {
  const [, m, d] = String(date).split('-').map(Number);
  return `${d} ${SHORT[m - 1] ?? ''}`;
}

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
