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

/** Метка «предупредить»: сервер держит одно число минут, экран — набор. */
function leadsOf(row) {
  const m = row.remind_before_min;
  if (m === null || m === undefined) return ['at'];
  if (m === 0) return ['at'];
  if (m >= 1440) return ['day'];
  return [String(m)];
}

const LEAD_MIN = { at: 0, 5: 5, 15: 15, 30: 30, 60: 60, day: 1440 };

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

export const meals = day => (day?.meals ?? []).map(m => ({
  id: m.id,
  title: m.title || 'Без названия',
  kcal: m.calories ?? null,
  done: m.done === 1,
  alarm: 'off',
  meta: mealMeta(m),
  raw: m,
}));

function mealMeta(m) {
  const parts = [];
  parts.push(m.time_min === null || m.time_min === undefined ? 'без времени' : hhmm(m.time_min));
  if (m.slot && m.slot !== 'other') parts.push(SLOT_LABEL[m.slot] ?? m.slot);
  return parts.join(' · ');
}

const SLOT_LABEL = { breakfast: 'завтрак', lunch: 'обед', dinner: 'ужин', snack: 'перекус' };

/**
 * Спорт. Показывается таблицей: подходы, повторы и вес — числа, и в
 * колонках они сравниваются глазом, а в строке «4×12, 60 кг» нет.
 */
export const sport = day => (day?.sport ?? []).map(x => ({
  id: x.id,
  title: x.exercise || 'Без названия',
  sets: x.sets ?? null,
  reps: x.reps ?? null,
  weight: x.weight ?? null,
  done: x.done === 1,
  raw: x,
}));

export const sportToServer = ({ title, sets, reps, weight }) => ({
  exercise: String(title ?? '').trim(),
  sets: Number.isFinite(sets) ? sets : null,
  reps: Number.isFinite(reps) ? reps : null,
  weight: Number.isFinite(weight) ? weight : null,
});

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
  else if (h.streak) parts.push(`подряд ${h.streak} ${plural(h.streak, 'день', 'дня', 'дней')}`);
  if (h.bestStreak) parts.push(`лучшая серия ${h.bestStreak}`);
  return parts.join(' · ') || 'ещё не отмечалась';
}

/**
 * Напоминания. Отдельной сущности пока нет, и придумывать её здесь нельзя.
 * Но в текущей модели напоминание — это и есть момент без длительности,
 * у которого включён сигнал; их и показываем.
 */
export const reminders = rows => rows
  .filter(r => r.end === null && r.alarm !== 'off')
  .map(r => ({
    id: r.id,
    title: r.title,
    meta: `${hhmm(r.start)} · ${LEAD_LABEL[r.leads[0]] ?? 'вовремя'}`,
    icon: r.alarm === 'alarm' ? 'alarm-fill' : 'bell',
    raw: r,
  }));

const LEAD_LABEL = {
  at: 'вовремя', 5: 'за 5 минут', 15: 'за 15 минут',
  30: 'за 30 минут', 60: 'за час', day: 'за день',
};

/** Заметки: сервер отдаёт по одной на день, заголовок — первая строка. */
export const notes = (rows, todayKey) => rows.map(n => {
  const text = String(n.text || '');
  const firstLine = text.split('\n')[0].trim();
  return {
    id: n.date,
    date: n.date === todayKey ? 'сегодня' : shortDate(n.date),
    on: true,
    title: firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : (firstLine || 'Без заголовка'),
    text,
    raw: n,
  };
});

// ── Обратный перевод ─────────────────────────────────────────

/** Что уходит на сервер из редактора строки. */
export const rowToServer = ({ title, start, end, alarm, lead }) => ({
  title: String(title ?? '').trim(),
  startMin: start,
  endMin: end ?? null,
  ...FROM_ALARM[alarm ?? 'off'],
  remindBeforeMin: LEAD_MIN[lead ?? 'at'] ?? 0,
});

export const taskToServer = ({ title, cat }) => ({
  text: String(title ?? '').trim(),
  bucket: cat === 'work' ? 'work' : 'home',
});

export const mealToServer = ({ title, kcal, timeMin, slot }) => ({
  title: String(title ?? '').trim(),
  calories: Number.isFinite(kcal) ? kcal : null,
  timeMin: Number.isFinite(timeMin) ? timeMin : null,
  slot: slot ?? 'other',
});

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
