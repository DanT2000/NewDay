/**
 * Простые списки дня: задачи (работа / дом), питание, спорт.
 *
 * План предполагал три отдельных файла, но строки отличаются только набором
 * полей — держу их вместе, чтобы правка поведения не расползалась по трём местам.
 */

import { h, checkbox, clear, replace, add } from '../dom.js';
import { formatMinutes, parseTimeToMinutes } from '../dates.js';
import { state, optimistic } from '../store.js';
import * as api from '../api.js';
import { toast } from '../toast.js';

const SLOT_LABEL = {
  breakfast: 'Завтрак', lunch: 'Обед', dinner: 'Ужин', snack: 'Перекус', other: 'Ещё',
};

// ── Общее ────────────────────────────────────────────────────

function mutate(collection, id, fields, send, refresh = false) {
  return optimistic(
    day => {
      const list = collection(day);
      const row = list.find(r => r.id === id);
      if (row) Object.assign(row, fields);
    },
    send,
    { refresh },
  );
}

function removeFrom(collection, id, send) {
  return optimistic(
    day => {
      const list = collection(day);
      const i = list.findIndex(r => r.id === id);
      if (i >= 0) list.splice(i, 1);
    },
    send,
    { refresh: true },
  );
}

async function addAndFocus(create, selector) {
  try {
    await create();
    const { reloadDay } = await import('../store.js');
    await reloadDay();
    const inputs = document.querySelectorAll(selector);
    inputs[inputs.length - 1]?.focus();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Задачи ───────────────────────────────────────────────────

export function renderTasks(root, bucket) {
  const rows = state.day?.tasks?.[bucket] ?? [];
  const list = h('div');
  const get = day => day.tasks[bucket];

  for (const row of rows) {
    add(list, h('div.trow', { class: row.done ? 'done' : '', dataset: { id: row.id } },
      checkbox(row.done === 1,
        v => mutate(get, row.id, { done: v ? 1 : 0 },
          () => api.tasks.update(state.date, row.id, { done: v }), true)),
      h('input.bare', {
        value: row.text, placeholder: 'Задача', 'aria-label': 'Текст задачи',
        onchange: e => mutate(get, row.id, { text: e.target.value.trim() },
          () => api.tasks.update(state.date, row.id, { text: e.target.value.trim() })),
      }),
      row.carried_from ? h('span.carried', { text: `↩ с ${row.carried_from.slice(8)}.${row.carried_from.slice(5, 7)}` }) : null,
      h('button.row-del', {
        text: '×', title: 'Удалить задачу', 'aria-label': 'Удалить задачу',
        onclick: () => removeFrom(get, row.id, () => api.tasks.remove(state.date, row.id)),
      })));
  }

  if (!rows.length) {
    list.append(h('p.empty', {
      text: bucket === 'work' ? 'Рабочих задач нет.' : 'Домашних задач нет.',
    }));
  }

  list.append(h('button.add-row', {
    text: '+ задача',
    onclick: () => addAndFocus(
      () => api.tasks.create(state.date, { bucket, text: '' }),
      '.trow .bare'),
  }));

  replace(root, list);
}

// ── Питание ──────────────────────────────────────────────────

export function renderMeals(root) {
  const rows = state.day?.meals ?? [];
  const timed = state.user?.foodMode === 'timed';
  const list = h('div');
  const get = day => day.meals;
  // Поле калорий видно всегда: иначе первое значение просто некуда ввести.
  // Оно узкое, с приглушённой подсказкой — тем, кто не считает, не мешает.
  const total = rows.reduce((sum, r) => sum + (r.calories || 0), 0);

  for (const row of rows) {
    add(list, h('div.trow', {
      class: row.done ? 'done' : '',
      style: {
        gridTemplateColumns: [
          '20px', timed ? '6.2ch' : null, 'minmax(0,1fr)', '5.5ch', 'auto', '18px',
        ].filter(Boolean).join(' '),
      },
      dataset: { id: row.id },
    },
      checkbox(row.done === 1,
        v => mutate(get, row.id, { done: v ? 1 : 0 },
          () => api.meals.update(state.date, row.id, { done: v }), true)),
      timed ? h('input.bare.stime', {
        value: row.time_min === null ? '' : formatMinutes(row.time_min),
        placeholder: '—', 'aria-label': 'Время',
        onchange: e => {
          const raw = e.target.value.trim();
          const min = raw ? parseTimeToMinutes(raw) : null;
          if (raw && min === null) { toast('Не понял время', 'error'); e.target.value = formatMinutes(row.time_min); return; }
          e.target.value = min === null ? '' : formatMinutes(min);
          mutate(get, row.id, { time_min: min }, () => api.meals.update(state.date, row.id, { timeMin: min }), true);
        },
      }) : null,
      h('input.bare', {
        value: row.title, placeholder: 'Что едим', 'aria-label': 'Название',
        onchange: e => mutate(get, row.id, { title: e.target.value.trim() },
          () => api.meals.update(state.date, row.id, { title: e.target.value.trim() })),
      }),
      h('input.bare.num', {
        value: row.calories ?? '', placeholder: 'ккал', inputMode: 'numeric',
        'aria-label': 'Калории', style: { textAlign: 'right' },
        onchange: e => {
          const val = e.target.value === '' ? null : Number(e.target.value);
          mutate(get, row.id, { calories: val },
            () => api.meals.update(state.date, row.id, { calories: val }));
        },
      }),
      h('select.bare', {
        value: row.slot, 'aria-label': 'Приём пищи',
        style: { width: 'auto', color: 'var(--ink-3)', fontSize: '13px' },
        onchange: e => mutate(get, row.id, { slot: e.target.value },
          () => api.meals.update(state.date, row.id, { slot: e.target.value })),
      }, ...Object.entries(SLOT_LABEL).map(([v, t]) =>
        h('option', { value: v, text: t, selected: v === row.slot }))),
      h('button.row-del', {
        text: '×', title: 'Удалить', 'aria-label': 'Удалить',
        onclick: () => removeFrom(get, row.id, () => api.meals.remove(state.date, row.id)),
      })));
  }

  if (!rows.length) list.append(h('p.empty', { text: 'Приёмы пищи не запланированы.' }));

  if (total > 0) {
    add(list, h('div.trow', { style: { gridTemplateColumns: 'minmax(0,1fr) auto' } },
      h('span.eyebrow', { text: 'всего за день' }),
      h('span.num', { text: `${total} ккал` })));
  }

  list.append(h('button.add-row', {
    text: '+ приём пищи',
    onclick: () => addAndFocus(
      () => api.meals.create(state.date, { slot: nextSlot(rows), title: '' }),
      '.trow .bare'),
  }));

  replace(root, list);
}

function nextSlot(rows) {
  const order = ['breakfast', 'lunch', 'dinner', 'snack'];
  const used = new Set(rows.map(r => r.slot));
  return order.find(s => !used.has(s)) || 'other';
}

// ── Спорт ────────────────────────────────────────────────────

export function renderSport(root) {
  const rows = state.day?.sport ?? [];
  const list = h('div');
  const get = day => day.sport;

  for (const row of rows) {
    add(list, h('div.trow', {
      class: row.done ? 'done' : '',
      style: { gridTemplateColumns: '20px minmax(0,1fr) 3.5ch 3.5ch 18px' },
      dataset: { id: row.id },
    },
      checkbox(row.done === 1,
        v => mutate(get, row.id, { done: v ? 1 : 0 },
          () => api.sport.update(state.date, row.id, { done: v }), true)),
      h('input.bare', {
        value: row.exercise, placeholder: 'Упражнение', 'aria-label': 'Упражнение',
        onchange: e => mutate(get, row.id, { exercise: e.target.value.trim() },
          () => api.sport.update(state.date, row.id, { exercise: e.target.value.trim() })),
      }),
      h('input.bare.mono', {
        value: row.sets ?? '', placeholder: 'x', inputMode: 'numeric',
        'aria-label': 'Подходы', style: { textAlign: 'center' },
        onchange: e => {
          const v = e.target.value === '' ? null : Number(e.target.value);
          mutate(get, row.id, { sets: v }, () => api.sport.update(state.date, row.id, { sets: v }));
        },
      }),
      h('input.bare.mono', {
        value: row.reps ?? '', placeholder: 'x', inputMode: 'numeric',
        'aria-label': 'Повторы', style: { textAlign: 'center' },
        onchange: e => {
          const v = e.target.value === '' ? null : Number(e.target.value);
          mutate(get, row.id, { reps: v }, () => api.sport.update(state.date, row.id, { reps: v }));
        },
      }),
      h('button.row-del', {
        text: '×', title: 'Удалить', 'aria-label': 'Удалить',
        onclick: () => removeFrom(get, row.id, () => api.sport.remove(state.date, row.id)),
      })));
  }

  if (!rows.length) list.append(h('p.empty', { text: 'Тренировка не запланирована.' }));

  list.append(h('button.add-row', {
    text: '+ упражнение',
    onclick: () => addAndFocus(
      () => api.sport.create(state.date, { exercise: '' }),
      '.trow .bare'),
  }));

  replace(root, list);
}
