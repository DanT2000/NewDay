/**
 * Расписание дня — список.
 *
 * Сигнатурная часть интерфейса: слева вертикальный рельс, по которому
 * движется настоящее. Текущая строка подсвечена и показывает остаток
 * времени, прошедшие приглушены по контрасту (но остаются кликабельными).
 */

import { h, svg, checkbox, replace } from '../dom.js';
import { formatMinutes, nowMinutes, formatDuration } from '../dates.js';
import { state, today } from '../store.js';
import { attachDrag } from '../components/drag.js';
import { openTimePicker } from '../components/timepicker.js';
import {
  ALARM_TITLE, alarmIcon, patchRow, removeRow, cycleAlarm, setRowTime, addRow, reorderRows, openShift,
} from './schedule-actions.js';

/** Открывает выбор времени, подсказывая окончание предыдущей строки. */
function pickRange(row, rows) {
  const idx = rows.findIndex(r => r.id === row.id);
  const prev = idx > 0 ? rows[idx - 1] : null;
  const prevEnd = prev ? (prev.end_min ?? prev.start_min) : null;

  openTimePicker(
    { startMin: row.start_min, endMin: row.end_min, prevEndMin: prevEnd, title: row.title },
    ({ startMin, endMin }) => patchRow(row, { startMin, endMin }),
  );
}

function rangeIcon() {
  return svg('svg', {
    viewBox: '0 0 20 20', 'aria-hidden': 'true',
    style: 'width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round',
  },
    svg('path', { d: 'M4 6.5h12M4 13.5h12' }),
    svg('circle', { cx: 7, cy: 6.5, r: 1.8, fill: 'currentColor', stroke: 'none' }),
    svg('circle', { cx: 13, cy: 13.5, r: 1.8, fill: 'currentColor', stroke: 'none' }));
}

function shiftIcon() {
  return svg('svg', {
    viewBox: '0 0 20 20', 'aria-hidden': 'true',
    style: 'width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round',
  },
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

    list.append(h('div.srow', {
      class: [row.done ? 'done' : '', isPast ? 'past' : '', isNow ? 'now' : ''].filter(Boolean).join(' '),
      dataset: { id: row.id },
    },
      h('span.srail'),
      h('span.sdrag', { text: '⠿', title: 'Перетащить', 'aria-hidden': 'true' }),
      // Печатать по-прежнему можно, но на телефоне удобнее выбрать:
      // долгий тап и кнопка «диапазон» открывают выбор без клавиатуры
      h('input.bare.stime', {
        value: formatMinutes(row.start_min),
        'aria-label': 'Время начала',
        title: 'Введите время или нажмите дважды, чтобы выбрать',
        onchange: e => setRowTime(row, 'startMin', e.target.value, e.target),
        ondblclick: () => pickRange(row, rows),
      }),
      h('input.bare.stime.end', {
        value: end === null ? '' : formatMinutes(end),
        placeholder: '—',
        'aria-label': 'Время окончания',
        onchange: e => setRowTime(row, 'endMin', e.target.value, e.target),
        ondblclick: () => pickRange(row, rows),
      }),
      h('div.stitle',
        h('input.bare', {
          value: row.title,
          placeholder: 'Что делаем',
          'aria-label': 'Название',
          onchange: e => patchRow(row, { title: e.target.value.trim() }),
        })),
      h('div.row',
        left !== null && left >= 0 ? h('span.sleft', { text: formatDuration(left) }) : null,
        h('button.icon-btn.sbell', {
          dataset: { mode: row.alarm_mode },
          title: ALARM_TITLE[row.alarm_mode],
          'aria-label': ALARM_TITLE[row.alarm_mode],
          onclick: () => cycleAlarm(row),
        }, alarmIcon(row.alarm_mode)),
        h('button.icon-btn.stimepick', {
          title: 'Выбрать время и длительность',
          'aria-label': 'Выбрать время и длительность',
          onclick: () => pickRange(row, rows),
        }, rangeIcon()),
        h('button.icon-btn.sshift', {
          title: 'Сдвинуть время', 'aria-label': 'Сдвинуть время',
          onclick: () => openShift(row),
        }, shiftIcon())),
      checkbox(row.done === 1, v => patchRow(row, { done: v }), 'Выполнено'),
      h('button.row-del', {
        title: 'Удалить строку', 'aria-label': 'Удалить строку', text: '×',
        onclick: () => removeRow(row),
      })));
  }

  if (!rows.length) {
    list.append(h('p.empty', { text: 'Расписание пустое. Добавьте первую строку — например, подъём.' }));
  }

  list.append(h('button.add-row', { onclick: () => addRow(rows) }, '+ строка'));

  attachDrag(list, '.srow', ids => reorderRows(ids));
  replace(root, list);
}
