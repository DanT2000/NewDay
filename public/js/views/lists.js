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
      h('input.bare.rowname', {
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
      '.trow .rowname'),
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
      h('input.bare.rowname', {
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
      '.trow .rowname'),
  }));

  replace(root, list);
}

function nextSlot(rows) {
  const order = ['breakfast', 'lunch', 'dinner', 'snack'];
  const used = new Set(rows.map(r => r.slot));
  return order.find(s => !used.has(s)) || 'other';
}

// ── Спорт ────────────────────────────────────────────────────

/**
 * Таблица, а не строка из цифр.
 *
 * Раньше подходы, повторы и вес шли тремя безымянными числами подряд, и
 * понять, где что, было нельзя. Теперь у каждого столбца есть подпись:
 * на широком экране — общей шапкой сверху, на узком — у каждого поля,
 * потому что шапка там не влезает. Одна разметка, два вида.
 *
 * Цифры не перечёркиваются, когда упражнение отмечено: 4×12 с весом 60 —
 * это запись сделанного, а не «отменено». Перечёркивается только название.
 */
const SPORT_FIELDS = [
  { key: 'sets', label: 'подходы', short: 'подх.', hint: '4' },
  { key: 'reps', label: 'повторы', short: 'повт.', hint: '12' },
  { key: 'weight', label: 'вес, кг', short: 'кг', hint: '60' },
];

export function renderSport(root) {
  const rows = state.day?.sport ?? [];
  const list = h('div');
  const get = day => day.sport;

  if (rows.length) {
    add(list, h('div.sport-head',
      h('span'),
      h('span.eyebrow', { text: 'упражнение' }),
      ...SPORT_FIELDS.map(f => h('span.eyebrow', { text: f.label })),
      h('span')));
  }

  for (const row of rows) {
    add(list, h('div.sportrow', { class: row.done ? 'done' : '', dataset: { id: row.id } },
      checkbox(row.done === 1,
        v => mutate(get, row.id, { done: v ? 1 : 0 },
          () => api.sport.update(state.date, row.id, { done: v }), true)),
      h('input.bare.rowname', {
        value: row.exercise, placeholder: 'Упражнение', 'aria-label': 'Упражнение',
        onchange: e => mutate(get, row.id, { exercise: e.target.value.trim() },
          () => api.sport.update(state.date, row.id, { exercise: e.target.value.trim() })),
      }),
      ...SPORT_FIELDS.map(f => h('label.snum',
        h('span.snum-l', { text: f.short }),
        h('input.bare.mono', {
          value: row[f.key] ?? '', placeholder: f.hint, inputMode: 'decimal',
          'aria-label': f.label,
          onchange: e => {
            const raw = e.target.value.trim().replace(',', '.');
            const v = raw === '' ? null : Number(raw);
            if (v !== null && !Number.isFinite(v)) { e.target.value = row[f.key] ?? ''; return; }
            mutate(get, row.id, { [f.key]: v },
              () => api.sport.update(state.date, row.id, { [f.key]: v }));
          },
        }))),
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
      '.sportrow .rowname'),
  }));

  add(list, weightBlock());
  replace(root, list);
}

/**
 * Контроль веса живёт в спорте, а не в шапке дня: это часть той же истории
 * про тело, и смотрят на него вместе с тренировкой. Пусто — значит пусто:
 * ни на экране лишнего, ни на бумаге.
 */
function weightBlock() {
  const d = state.day;
  if (!d) return null;

  const prev = state.daysIndex
    .filter(x => x.date < state.date && x.weight !== null)
    .sort((a, b) => b.date.localeCompare(a.date))[0]?.weight ?? null;
  const delta = prev !== null && d.weight !== null ? +(d.weight - prev).toFixed(1) : null;

  const input = h('input.bare.num.mono', {
    value: d.weight ?? '', placeholder: '—', inputMode: 'decimal',
    'aria-label': 'Вес, кг', style: { width: '6ch', textAlign: 'right' },
    onchange: e => {
      const raw = e.target.value.trim().replace(',', '.');
      const v = raw === '' ? null : Number(raw);
      if (v !== null && !Number.isFinite(v)) { e.target.value = d.weight ?? ''; return; }
      state.day.weight = v;
      pushWeight(v);
    },
  });

  return h('div.wrow', { class: d.weight === null ? 'no-print' : '' },
    h('span.eyebrow', { text: 'контроль веса' }),
    h('span.grow'),
    input,
    h('span.small', { text: 'кг' }),
    delta !== null && delta !== 0
      ? h('span.micro', {
          text: `${delta > 0 ? '↑' : '↓'}${Math.abs(delta)}`,
          style: { color: delta > 0 ? 'var(--c-warn)' : 'var(--c-success)' },
        })
      : null);
}

async function pushWeight(value) {
  try {
    const updated = await api.patchDay(state.date, { weight: value }, state.day.rev);
    state.day.rev = updated.rev;
  } catch (e) { toast(e.message, 'error'); }
}
