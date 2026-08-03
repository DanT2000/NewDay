/**
 * Расписание — таймлайн.
 *
 * Те же данные, что в списке, но высота блока пропорциональна длительности:
 * так видно дыры в дне и наложения, которых в списке не разглядеть.
 * Диапазон часов подстраивается под день, чтобы не листать пустую ночь.
 */

import { h, checkbox, replace } from '../dom.js';
import { formatMinutes, nowMinutes, formatDuration } from '../dates.js';
import { state, today } from '../store.js';
import { openRowMenu, patchRow, alarmIcon } from './schedule-actions.js';

const PX_PER_HOUR = 56;
const PAD_HOURS = 1;

/** Полосы для строк, которые перекрываются по времени, чтобы они не наезжали. */
function assignLanes(rows) {
  const lanes = [];
  const placed = new Map();
  for (const r of rows) {
    const start = r.start_min;
    const end = Math.max(r.end_min ?? r.start_min + 15, start + 15);
    let lane = lanes.findIndex(endOfLane => endOfLane <= start);
    if (lane === -1) { lanes.push(end); lane = lanes.length - 1; }
    else lanes[lane] = end;
    placed.set(r.id, { lane, start, end });
  }
  return { placed, laneCount: Math.max(lanes.length, 1) };
}

export function renderTimeline(root) {
  const day = state.day;
  if (!day) return;
  const rows = day.schedule;
  const isToday = state.date === today();
  const minutes = isToday ? nowMinutes(state.user?.timezone) : null;

  if (!rows.length) {
    replace(root, h('p.empty', { text: 'Расписание пустое. Переключитесь в список, чтобы добавить строку.' }));
    return;
  }

  const firstHour = Math.max(0, Math.floor(Math.min(...rows.map(r => r.start_min)) / 60) - PAD_HOURS);
  const lastHour = Math.min(24, Math.ceil(
    Math.max(...rows.map(r => (r.end_min ?? r.start_min + 30))) / 60) + PAD_HOURS);
  const hours = Math.max(lastHour - firstHour, 1);
  const height = hours * PX_PER_HOUR;
  const topOf = min => ((min - firstHour * 60) / 60) * PX_PER_HOUR;

  const { placed, laneCount } = assignLanes(rows);

  const gutter = h('div.tl-gutter',
    ...Array.from({ length: hours + 1 }, (_, i) =>
      h('span.tl-hour', {
        text: `${String(firstHour + i).padStart(2, '0')}`,
        style: { top: `${i * PX_PER_HOUR}px` },
      })));

  const grid = h('div.tl-grid', { style: { height: `${height}px` } },
    ...Array.from({ length: hours + 1 }, (_, i) =>
      h('span.tl-line', { style: { top: `${i * PX_PER_HOUR}px` } })));

  for (const row of rows) {
    const pos = placed.get(row.id);
    const top = topOf(pos.start);
    // минус 2px — чтобы соседние блоки не сливались в один
    const blockH = Math.max(topOf(pos.end) - top - 2, 22);
    const isNow = isToday && minutes >= pos.start && minutes < pos.end;
    const isPast = isToday && pos.end <= minutes;

    grid.append(h('div.tl-block', {
      class: [row.done ? 'done' : '', isPast ? 'past' : '', isNow ? 'now' : ''].filter(Boolean).join(' '),
      dataset: { id: row.id },
      style: {
        top: `${top}px`, height: `${blockH}px`,
        left: `calc(${(pos.lane / laneCount) * 100}% + 2px)`,
        width: `calc(${100 / laneCount}% - 4px)`,
      },
      onclick: e => { if (!e.target.closest('.chk, .row-del')) openRowMenu(row); },
    },
      h('div.tl-block-hd',
        checkbox(row.done === 1, v => patchRow(row, { done: v }), 'Выполнено'),
        h('b.tl-title', { text: row.title || 'Без названия' }),
        row.alarm_mode !== 'none'
          ? h('span.tl-bell', { dataset: { mode: row.alarm_mode } }, alarmIcon(row.alarm_mode))
          : null),
      blockH > 34
        ? h('div.tl-time', {
            text: `${formatMinutes(pos.start)}–${formatMinutes(pos.end)}` +
                  (blockH > 52 ? ` · ${formatDuration(pos.end - pos.start)}` : ''),
          })
        : null));
  }

  if (isToday && minutes >= firstHour * 60 && minutes <= lastHour * 60) {
    grid.append(h('div.tl-now', { style: { top: `${topOf(minutes)}px` } },
      h('span.tl-now-label', { text: formatMinutes(minutes) })));
  }

  replace(root, h('div.tl', gutter, grid));
}
