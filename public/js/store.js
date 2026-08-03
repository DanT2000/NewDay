/**
 * Состояние приложения.
 *
 * Один источник правды на день. Правки применяются оптимистично и
 * откатываются, если сервер отказал: пользователь не должен видеть,
 * как галочка ставится и через секунду сама снимается без объяснений.
 */

import * as api from './api.js';
import { todayFor } from './dates.js';
import { toast } from './toast.js';

export const state = {
  user: null,
  settings: {},
  date: null,
  day: null,          // ответ /days/:date/full
  habitsAll: [],      // список привычек для экрана управления
  daysIndex: [],      // краткие сводки для полоски дат
  loading: false,
  error: null,
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) fn(state);
}

export function today() {
  return todayFor(state.user?.timezone || 'Europe/Moscow');
}

// ── Загрузка ─────────────────────────────────────────────────

export async function loadUser() {
  state.user = await api.me();
  state.settings = state.user.settings || {};
  return state.user;
}

export async function loadDay(date) {
  state.date = date;
  state.loading = true;
  state.error = null;
  emit();
  try {
    state.day = await api.getDay(date);
  } catch (e) {
    // Ошибку показываем, но день НЕ подменяем пустышкой:
    // именно эта подмена в старом клиенте затирала данные.
    state.error = e.message;
    toast(e.message, 'error');
  } finally {
    state.loading = false;
    emit();
  }
}

export async function reloadDay() {
  if (!state.date) return;
  state.day = await api.getDay(state.date);
  emit();
}

export async function loadDaysIndex(from, to) {
  try {
    state.daysIndex = await api.listDays(from, to);
    emit();
  } catch { /* полоска дат не критична */ }
}

export async function loadHabits() {
  state.habitsAll = await api.habits.list(true);
  emit();
}

// ── Оптимистичные правки ─────────────────────────────────────

/**
 * Применяет изменение локально, отправляет на сервер и откатывает при отказе.
 * @param apply    (day) => void         — как изменить состояние сразу
 * @param send     () => Promise         — запрос к серверу
 * @param options.refresh  перечитать день после успеха (когда сервер меняет больше, чем мы)
 */
export async function optimistic(apply, send, { refresh = false } = {}) {
  if (!state.day) return;
  const backup = structuredClone(state.day);
  apply(state.day);
  emit();
  try {
    await send();
    if (refresh) await reloadDay();
    else { state.day.rev += 1; emit(); }
  } catch (e) {
    state.day = backup;
    emit();
    toast(e.message, 'error');
    throw e;
  }
}

/** Дебаунс на поле ввода: сохраняем по паузе, а не по каждому символу. */
export function debounce(fn, ms = 600) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}
