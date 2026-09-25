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

/*
 * Номер запроса: отвечает только последний.
 *
 * Без него быстрое листание дней оставляло на экране не тот день — ответ
 * медленного запроса приходил позже и перезаписывал уже показанный. В
 * веб-версии такая защита есть, здесь её не было.
 */
let поколение = 0;

export async function loadDay(date) {
  const мой = ++поколение;
  const прежняяДата = state.date;
  state.date = date;
  state.loading = true;
  state.error = null;
  emit();
  try {
    const день = await api.getDay(date);
    if (мой !== поколение) return;   // нас уже обогнали: молчим
    state.day = день;
  } catch (e) {
    if (мой !== поколение) return;
    /*
     * День не подменяем пустышкой — именно эта подмена в старом клиенте
     * затирала данные. Но и оставлять прежний нельзя: на экране оказывался
     * чужой день под новым числом, со своими номерами строк и своей версией,
     * и первая же правка уезжала не туда. Убираем его и говорим, что не
     * загрузилось.
     */
    if (прежняяДата !== date) state.day = null;
    state.error = e.message;
    toast(e.message, 'error');
  } finally {
    if (мой === поколение) {
      state.loading = false;
      emit();
    }
  }
}

export async function reloadDay() {
  if (!state.date) return;
  const мой = ++поколение;
  const день = await api.getDay(state.date);
  if (мой !== поколение) return;
  state.day = день;
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
