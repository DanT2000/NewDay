/**
 * Данные веб-версии: чтение и запись.
 *
 * Слой между экраном и API. Экран не знает ни про адреса, ни про формат
 * ответов: он просит «день такой-то» и получает то же, что раньше лежало
 * в `data.js` примерами. Поэтому подключение и вышло подстановкой, а не
 * переписыванием разметки.
 *
 * Правки уходят на сервер сразу, а на экране применяются не дожидаясь
 * ответа: галочка, которая ставится через полсекунды, ощущается как
 * сломанная. Если сервер отказал — возвращаем как было и говорим об этом.
 */

import * as api from '../api.js';

const pad2 = n => String(n).padStart(2, '0');
export const keyOf = dt => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;

/** Понедельник недели, в которую попадает дата. */
export function mondayOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return dt;
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return keyOf(dt);
}

/** Сегодня в часовом поясе человека, а не браузера. */
export function todayFor(timezone) {
  return new Date().toLocaleDateString('en-CA', timezone ? { timeZone: timezone } : undefined);
}

// ── Что лежит в памяти ───────────────────────────────────────

export const store = {
  user: null,
  settings: null,
  day: null,          // полный день: расписание, задачи, еда, привычки, прогресс
  range: null,        // { from, to, days: [...] } — для сетки недели и месяца
  habits: [],
  notes: [],
  devices: [],
  template: null,     // именованное правило-шаблон, применяется вручную
  series: [],         // правила повторов без имени: ими живут повторяющиеся напоминания
  ai: { ready: false, voice: false },
};

/** Один раз при запуске: кто мы и что настроено. */
export async function boot() {
  const settings = await api.getSettings();
  store.settings = settings;
  store.user = { email: settings.email, username: settings.username, isAdmin: settings.isAdmin };
  store.ai = await api.GET('/ai/status').catch(() => ({ ready: false, voice: false }));
  return settings;
}

export async function loadDay(date) {
  store.day = await api.getDay(date);
  return store.day;
}

/**
 * Период для сетки. Неделя — семь дней от понедельника, месяц — вся сетка
 * вместе с хвостами соседних месяцев: клетки соседей тоже показывают дела.
 */
export async function loadRange(date, view) {
  let from;
  let to;
  if (view === 'month') {
    const [y, m] = date.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    from = keyOf(mondayOf(keyOf(first)));
    to = addDays(from, 41);            // шесть недель — максимум для любого месяца
  } else {
    from = keyOf(mondayOf(date));
    to = addDays(from, 6);
  }
  store.range = await api.GET(`/days/range?from=${from}&to=${to}`);
  return store.range;
}

export async function loadNotes() {
  const rows = await api.GET('/notes');
  store.notes = Array.isArray(rows) ? rows : (rows.days ?? []);
  return store.notes;
}

// ── Шаблон дня ───────────────────────────────────────────────

/*
 * Шаблон — это правило с именем. Повтор сам достраивает дни, шаблон ждёт
 * нажатия: набор строк, которым можно заполнить любой день. Имя одно, и
 * шаблон в веб-версии тоже один — «общее расписание» человек держит в
 * голове в единственном числе.
 */
export const TEMPLATE_NAME = 'Общее расписание';

export async function loadTemplate() {
  const rows = await api.series.list({ templates: true });
  const list = Array.isArray(rows) ? rows : [];
  store.template = list.find(r => r.name === TEMPLATE_NAME) ?? list[0] ?? null;
  return store.template;
}

/** Сохраняем целиком: правка строки — это новая версия всего набора. */
export async function saveTemplate(rows) {
  if (!rows.length) return removeTemplate();
  const body = { name: TEMPLATE_NAME, target: 'schedule', rows, forceRows: true };
  store.template = store.template
    ? await api.series.update(store.template.id, body)
    : await api.series.create(body);
  return store.template;
}

export async function removeTemplate() {
  if (!store.template) return null;
  await api.series.remove(store.template.id);
  store.template = null;
  return null;
}

/**
 * Повтор — правило без имени: сервер сам достраивает им дни. Так живут
 * «ежедневно», «еженедельно», «ежемесячно» и «ежегодно» у напоминаний.
 */
export const createRepeat = ({ freq, startDate, row, byweekday }) =>
  api.series.create({
    target: 'schedule', freq, startDate, rows: [row],
    ...(byweekday ? { byweekday } : {}),
  });

/** Правила повторов нужны редактору напоминания: по ним видно, что за повтор. */
export async function loadSeries() {
  const rows = await api.series.list({ templates: false });
  store.series = Array.isArray(rows) ? rows : [];
  return store.series;
}

export const removeSeries = id => api.series.remove(id);
/*
 * «Не напоминать с этого дня» — это конец правила, а не удаление: прошлые дни
 * остаются как были. Сервер сам обрезает правило датой окончания.
 */
export const endSeries = (id, date) => api.series.endFrom(id, date);

// ── Правки ───────────────────────────────────────────────────

/**
 * Применить на экране сразу, отправить на сервер, при отказе вернуть как
 * было. `apply` меняет то, что уже лежит в памяти; `send` возвращает промис.
 */
export async function optimistic(apply, send, onError) {
  const undo = apply();
  try {
    await send();
  } catch (e) {
    undo?.();
    onError?.(e.message || 'Не удалось сохранить');
    throw e;
  }
}

const dateOf = () => store.day?.date;

/** Галочка у строки расписания. */
export function toggleScheduleRow(row, done) {
  const before = row.done;
  return optimistic(
    () => { row.done = done ? 1 : 0; return () => { row.done = before; }; },
    () => api.schedule.update(dateOf(), row.id, { done }),
  );
}

export function toggleTask(task, done) {
  const before = task.done;
  return optimistic(
    () => { task.done = done ? 1 : 0; return () => { task.done = before; }; },
    () => api.tasks.update(dateOf(), task.id, { done }),
  );
}

export function toggleSport(row, done) {
  const before = row.done;
  return optimistic(
    () => { row.done = done ? 1 : 0; return () => { row.done = before; }; },
    () => api.sport.update(dateOf(), row.id, { done }),
  );
}

export function toggleMeal(meal, done) {
  const before = meal.done;
  return optimistic(
    () => { meal.done = done ? 1 : 0; return () => { meal.done = before; }; },
    () => api.meals.update(dateOf(), meal.id, { done }),
  );
}

/**
 * Привычка отмечается не полем `done`, а записью в журнале за дату:
 * привычки живут отдельно от дня и считают серии по этим записям.
 */
export function toggleHabit(habit, done) {
  const date = dateOf();
  const before = habit.status;
  return optimistic(
    () => { habit.status = done ? 'done' : null; return () => { habit.status = before; }; },
    () => (done ? api.habits.setLog(habit.id, date, 'done') : api.habits.clearLog(habit.id, date)),
  );
}

export const createRow = (date, body) => api.schedule.create(date, body);
export const updateRow = (date, id, body) => api.schedule.update(date, id, body);
export const removeRow = (date, id) => api.schedule.remove(date, id);
/** Сдвиг блока вместе со всем, что начинается позже: способ разойтись при пересечении. */
export const shiftRows = (date, fromId, minutes) => api.schedule.shift(date, fromId, minutes, true);

export const createTask = (date, body) => api.tasks.create(date, body);
export const updateTask = (date, id, body) => api.tasks.update(date, id, body);
export const removeTask = (date, id) => api.tasks.remove(date, id);

export const createMeal = (date, body) => api.meals.create(date, body);
export const updateMeal = (date, id, body) => api.meals.update(date, id, body);
export const removeMeal = (date, id) => api.meals.remove(date, id);

/*
 * Заметка с датой — это заметка дня, поэтому пишется в день. Заметка без даты
 * живёт своим списком. Вид определяется датой, и других правил тут нет.
 */
export const saveDayNote = (date, text) => api.patchDay(date, { notes: text }, store.day?.rev);
export const createFreeNote = body => api.POST('/notes', body);
export const updateFreeNote = (id, body) => api.PATCH(`/notes/${id}`, body);
export const removeFreeNote = id => api.DELETE(`/notes/${id}`);

export const createHabit = body => api.habits.create(body);
export const updateHabit = (id, body) => api.habits.update(id, body);
/*
 * Убираем в архив, а не стираем: журнал отметок — это история, и удалить её
 * вместе с привычкой значит переписать прошлое. Архивная привычка исчезает
 * из списка, но дни, в которые она была выполнена, остаются правдой.
 */
export const removeHabit = id => api.habits.archive(id);

/** Настройки приложения: тема, акцент, масштаб, переключатели дня. */
export async function saveSettings(patch) {
  const before = { ...store.settings?.settings };
  return optimistic(
    () => {
      store.settings.settings = { ...store.settings.settings, ...patch };
      return () => { store.settings.settings = before; };
    },
    () => api.saveSettings({ settings: patch }),
  );
}
