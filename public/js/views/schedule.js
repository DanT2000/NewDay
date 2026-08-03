/**
 * Расписание дня — список.
 *
 * Сигнатурная часть интерфейса: слева вертикальный рельс, по которому
 * движется настоящее. Текущая строка подсвечена и показывает остаток
 * времени, прошедшие приглушены по контрасту (но остаются кликабельными).
 */

import { h, svg, checkbox, clear } from '../dom.js';
import { formatMinutes, parseTimeToMinutes, nowMinutes, formatDuration } from '../dates.js';
import { state, optimistic, today } from '../store.js';
import * as api from '../api.js';
import { toast } from '../toast.js';
import { attachDrag } from '../components/drag.js';
import { openSheet } from '../components/sheet.js';

const ALARM_CYCLE = ['none', 'notify', 'alarm'];
const ALARM_TITLE = {
  none: 'Без напоминания',
  notify: 'Уведомление перед началом',
  alarm: 'Будильник',
};

/**
 * Иконки монохромные и рисуются штрихом: цвет в интерфейсе закреплён за данными,
 * а разноцветные эмодзи это правило ломали.
 */
function alarmIcon(mode) {
  if (mode === 'none') {
    return svg('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true' },
      svg('circle', { cx: 10, cy: 10, r: 1.6, fill: 'currentColor', stroke: 'none' }));
  }
  if (mode === 'notify') {
    return svg('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true' },
      svg('path', { d: 'M6 8.5a4 4 0 0 1 8 0c0 3 .9 4.2 1.4 4.7H4.6C5.1 12.7 6 11.5 6 8.5Z' }),
      svg('path', { d: 'M8.4 15.6a1.8 1.8 0 0 0 3.2 0' }));
  }
  return svg('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true' },
    svg('circle', { cx: 10, cy: 11, r: 5.6 }),
    svg('path', { d: 'M10 8.4V11l1.8 1.1' }),
    svg('path', { d: 'M3.6 5.4 6 3.4M16.4 5.4 14 3.4' }));
}

function shiftIcon() {
  return svg('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true',
    style: 'width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round' },
    svg('path', { d: 'M4 10h9' }),
    svg('path', { d: 'M10.5 6.8 13.8 10l-3.3 3.2' }),
    svg('path', { d: 'M16.4 6v8' }));
}

/** Какая строка идёт прямо сейчас: последняя начавшаяся и ещё не закончившаяся. */
function currentRowId(rows, minutes) {
  let candidate = null;
  for (const r of rows) {
    if (r.start_min > minutes) break;
    const end = r.end_min ?? r.start_min;
    if (minutes <= end || end <= r.start_min) candidate = r;
  }
  return candidate?.id ?? null;
}

export function renderSchedule(root) {
  const day = state.day;
  if (!day) return;
  const rows = day.schedule;
  const isToday = state.date === today();
  const minutes = isToday ? nowMinutes(state.user?.timezone) : null;
  const nowId = isToday ? currentRowId(rows, minutes) : null;

  const list = h('div.sched', { class: isToday ? 'dim-past' : '' });

  for (const row of rows) {
    const end = row.end_min ?? null;
    const isPast = isToday && row.id !== nowId && (end ?? row.start_min) < minutes;
    const isNow = row.id === nowId;
    const left = isNow && end !== null ? end - minutes : null;

    const el = h('div.srow', {
      class: [row.done ? 'done' : '', isPast ? 'past' : '', isNow ? 'now' : ''].filter(Boolean).join(' '),
      dataset: { id: row.id },
    },
      h('span.srail'),
      h('span.sdrag', { text: '⠿', title: 'Перетащить', 'aria-hidden': 'true' }),
      h('input.bare.stime', {
        value: formatMinutes(row.start_min),
        'aria-label': 'Время начала',
        onchange: e => setTime(row, 'startMin', e.target.value, e.target),
      }),
      h('input.bare.stime.end', {
        value: end === null ? '' : formatMinutes(end),
        placeholder: '—',
        'aria-label': 'Время окончания',
        onchange: e => setTime(row, 'endMin', e.target.value, e.target),
      }),
      h('div.stitle',
        h('input.bare', {
          value: row.title,
          placeholder: 'Что делаем',
          'aria-label': 'Название',
          onchange: e => patch(row, { title: e.target.value.trim() }),
        })),
      h('div.row',
        left !== null && left >= 0 ? h('span.sleft', { text: `${formatDuration(left)}` }) : null,
        h('button.icon-btn.sbell', {
          dataset: { mode: row.alarm_mode },
          title: ALARM_TITLE[row.alarm_mode],
          'aria-label': ALARM_TITLE[row.alarm_mode],
          onclick: () => cycleAlarm(row),
        }, alarmIcon(row.alarm_mode)),
        h('button.icon-btn.sshift', {
          title: 'Сдвинуть время', 'aria-label': 'Сдвинуть время',
          onclick: () => openShift(row),
        }, shiftIcon())),
      checkbox(row.done === 1, v => patch(row, { done: v }), 'Выполнено'),
      h('button.row-del', {
        title: 'Удалить строку', 'aria-label': 'Удалить строку', text: '×',
        onclick: () => remove(row),
      }));

    list.append(el);
  }

  if (!rows.length) {
    list.append(h('p.empty', { text: 'Расписание пустое. Добавьте первую строку — например, подъём.' }));
  }

  list.append(h('button.add-row', {
    onclick: () => addRow(rows),
  }, '+ строка'));

  attachDrag(list, '.srow', ids => reorder(ids));
  clear(root).append(list);
}

// ── Действия ─────────────────────────────────────────────────

function patch(row, fields) {
  return optimistic(
    day => Object.assign(day.schedule.find(r => r.id === row.id), toLocal(fields)),
    () => api.schedule.update(state.date, row.id, fields),
    { refresh: fields.done !== undefined },  // прогресс пересчитывает сервер
  );
}

function toLocal(fields) {
  const map = { title: 'title', note: 'note', startMin: 'start_min', endMin: 'end_min' };
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'done') out.done = v ? 1 : 0;
    else if (k === 'alarmMode') out.alarm_mode = v;
    else if (map[k]) out[map[k]] = v;
  }
  return out;
}

function setTime(row, field, raw, input) {
  const trimmed = raw.trim();
  if (field === 'endMin' && !trimmed) return patch(row, { endMin: null });
  const min = parseTimeToMinutes(trimmed);
  if (min === null) {
    input.value = formatMinutes(field === 'startMin' ? row.start_min : row.end_min);
    toast('Не понял время. Примеры: 9:30, 930, 9', 'error');
    return;
  }
  input.value = formatMinutes(min);
  return patch(row, { [field]: min }).then(() => reloadOrder());
}

/** Сервер держит расписание отсортированным, поэтому после смены времени перечитываем. */
async function reloadOrder() {
  const { reloadDay } = await import('../store.js');
  return reloadDay();
}

function cycleAlarm(row) {
  const next = ALARM_CYCLE[(ALARM_CYCLE.indexOf(row.alarm_mode) + 1) % ALARM_CYCLE.length];
  return patch(row, { alarmMode: next });
}

function remove(row) {
  return optimistic(
    day => { day.schedule = day.schedule.filter(r => r.id !== row.id); },
    () => api.schedule.remove(state.date, row.id),
    { refresh: true },
  );
}

async function addRow(rows) {
  const last = rows[rows.length - 1];
  const startMin = last ? Math.min((last.end_min ?? last.start_min) || 0, 1380) : 9 * 60;
  try {
    await api.schedule.create(state.date, { startMin, endMin: Math.min(startMin + 60, 1439), title: '' });
    await reloadOrder();
    // фокус в название только что добавленной строки
    const inputs = document.querySelectorAll('.srow .stitle input');
    inputs[inputs.length - 1]?.focus();
  } catch (e) { toast(e.message, 'error'); }
}

function reorder(ids) {
  return optimistic(
    day => {
      const byId = new Map(day.schedule.map(r => [String(r.id), r]));
      day.schedule = ids.map(id => byId.get(id)).filter(Boolean);
    },
    () => api.schedule.reorder(state.date, ids.map(Number)),
    { refresh: true },
  );
}

/** Сдвиг времени: главный сценарий — «задержался на обеде на 15 минут». */
function openShift(row) {
  let cascade = true;
  const apply = async minutes => {
    try {
      await api.schedule.shift(state.date, row.id, minutes, cascade);
      await reloadOrder();
      toast(`Сдвинуто на ${minutes > 0 ? '+' : ''}${minutes} мин`);
    } catch (e) { toast(e.message, 'error'); }
  };

  openSheet('Сдвинуть время', body => {
    body.append(
      h('p.small', { text: `«${row.title || 'Без названия'}», начало ${formatMinutes(row.start_min)}` }),
      h('div.row', { style: { flexWrap: 'wrap', gap: '8px' } },
        ...[-30, -15, -5, 5, 15, 30, 60].map(m =>
          h('button.btn.btn-sm', { text: `${m > 0 ? '+' : ''}${m}`, onclick: () => apply(m) }))),
      h('label.row', { style: { cursor: 'pointer', marginTop: '4px' } },
        h('input', {
          type: 'checkbox', checked: true,
          onchange: e => { cascade = e.target.checked; },
        }),
        h('span.small', { text: 'и все следующие строки' })),
    );
  });
}
