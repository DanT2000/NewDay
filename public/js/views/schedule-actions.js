/**
 * Действия над строкой расписания — общие для списка и таймлайна.
 * Держатся отдельно, чтобы два вида не разошлись по возможностям,
 * как когда-то разошлись десктопная и мобильная версии старого клиента.
 */

import { h, svg } from '../dom.js';
import { formatMinutes, parseTimeToMinutes } from '../dates.js';
import { state, optimistic, reloadDay } from '../store.js';
import * as api from '../api.js';
import { toast } from '../toast.js';
import { openSheet, confirmSheet } from '../components/sheet.js';

export const ALARM_CYCLE = ['none', 'notify', 'alarm'];
export const ALARM_TITLE = {
  none: 'Без напоминания',
  notify: 'Уведомление перед началом',
  alarm: 'Будильник',
};

/**
 * Иконки монохромные и рисуются штрихом: цвет в интерфейсе закреплён за данными,
 * а разноцветные эмодзи это правило ломали.
 */
export function alarmIcon(mode) {
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

const FIELD_TO_ROW = {
  title: 'title', note: 'note', startMin: 'start_min', endMin: 'end_min',
  kind: 'kind', alarmProfile: 'alarm_profile', remindBeforeMin: 'remind_before_min',
};

function toRow(fields) {
  const out = {};
  for (const [k, val] of Object.entries(fields)) {
    if (k === 'done') out.done = val ? 1 : 0;
    else if (k === 'alarmMode') out.alarm_mode = val;
    else if (FIELD_TO_ROW[k]) out[FIELD_TO_ROW[k]] = val;
  }
  return out;
}

export function patchRow(row, fields) {
  return optimistic(
    day => {
      const target = day.schedule.find(r => r.id === row.id);
      if (target) Object.assign(target, toRow(fields));
    },
    () => api.schedule.update(state.date, row.id, fields),
    { refresh: true },   // прогресс и порядок пересчитывает сервер
  );
}

export function removeRow(row) {
  return optimistic(
    day => { day.schedule = day.schedule.filter(r => r.id !== row.id); },
    () => api.schedule.remove(state.date, row.id),
    { refresh: true },
  );
}

export function cycleAlarm(row) {
  const next = ALARM_CYCLE[(ALARM_CYCLE.indexOf(row.alarm_mode) + 1) % ALARM_CYCLE.length];
  return patchRow(row, { alarmMode: next });
}

export function setRowTime(row, field, raw, input) {
  const trimmed = String(raw).trim();
  if (field === 'endMin' && !trimmed) return patchRow(row, { endMin: null });
  const min = parseTimeToMinutes(trimmed);
  if (min === null) {
    if (input) input.value = formatMinutes(field === 'startMin' ? row.start_min : row.end_min);
    toast('Не понял время. Примеры: 9:30, 930, 9', 'error');
    return Promise.resolve();
  }
  if (input) input.value = formatMinutes(min);
  return patchRow(row, { [field]: min });
}

export async function addRow(rows) {
  const last = rows[rows.length - 1];
  const startMin = last ? Math.min((last.end_min ?? last.start_min) || 0, 1380) : 9 * 60;
  try {
    await api.schedule.create(state.date, {
      startMin, endMin: Math.min(startMin + 60, 1439), title: '',
    });
    await reloadDay();
    const inputs = document.querySelectorAll('.srow .stitle input');
    inputs[inputs.length - 1]?.focus();
  } catch (e) { toast(e.message, 'error'); }
}

export function reorderRows(ids) {
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
export function openShift(row) {
  let cascade = true;
  const apply = async minutes => {
    try {
      await api.schedule.shift(state.date, row.id, minutes, cascade);
      await reloadDay();
      toast(`Сдвинуто на ${minutes > 0 ? '+' : ''}${minutes} мин`);
    } catch (e) { toast(e.message, 'error'); }
  };

  openSheet('Сдвинуть время', (body, { close }) => {
    body.append(
      h('p.small', { text: `«${row.title || 'Без названия'}», начало ${formatMinutes(row.start_min)}` }),
      h('div.row', { style: { flexWrap: 'wrap', gap: '8px' } },
        ...[-30, -15, -5, 5, 15, 30, 60].map(m =>
          h('button.btn.btn-sm', {
            text: `${m > 0 ? '+' : ''}${m}`,
            onclick: () => { close(); apply(m); },
          }))),
      h('label.row', { style: { cursor: 'pointer', marginTop: '4px' } },
        h('input', {
          type: 'checkbox', checked: true,
          onchange: e => { cascade = e.target.checked; },
        }),
        h('span.small', { text: 'и все следующие строки' })));
  });
}

/** Полное меню строки. На таймлайне это единственный способ её править. */
export function openRowMenu(row) {
  openSheet(row.title || 'Строка расписания', (body, { close }) => {
    const timeStart = h('input.input.mono', {
      value: formatMinutes(row.start_min), 'aria-label': 'Начало',
    });
    const timeEnd = h('input.input.mono', {
      value: row.end_min === null ? '' : formatMinutes(row.end_min),
      placeholder: '—', 'aria-label': 'Окончание',
    });
    const title = h('input.input', { value: row.title, placeholder: 'Что делаем' });

    body.append(h('div.stack',
      h('label.stack', { style: { gap: '4px' } },
        h('span.eyebrow', { text: 'название' }), title),
      h('div.row',
        h('label.stack', { style: { gap: '4px', flex: 1 } },
          h('span.eyebrow', { text: 'начало' }), timeStart),
        h('label.stack', { style: { gap: '4px', flex: 1 } },
          h('span.eyebrow', { text: 'окончание' }), timeEnd)),
      h('div',
        h('span.eyebrow', { text: 'напоминание' }),
        h('div.row', { style: { gap: '4px', marginTop: '6px' } },
          ...ALARM_CYCLE.map(mode => h('button.tab', {
            type: 'button', text: ALARM_TITLE[mode],
            'aria-selected': row.alarm_mode === mode ? 'true' : 'false',
            onclick: e => {
              [...e.currentTarget.parentNode.children].forEach(n => n.setAttribute('aria-selected', 'false'));
              e.currentTarget.setAttribute('aria-selected', 'true');
              row.alarm_mode = mode;
            },
          })))),
      h('div.divider'),
      h('button.btn.btn-block', {
        text: 'Сдвинуть время', style: { justifyContent: 'flex-start' },
        onclick: () => { close(); openShift(row); },
      }),
      h('button.btn.btn-danger.btn-block', {
        text: 'Удалить строку', style: { justifyContent: 'flex-start' },
        onclick: async () => {
          close();
          const ok = await confirmSheet('Удалить строку?',
            `«${row.title || 'Без названия'}» исчезнет из этого дня.`);
          if (ok) removeRow(row);
        },
      })));

    body.dataset.collect = '1';
    body._collect = () => ({
      title: title.value.trim(),
      startMin: parseTimeToMinutes(timeStart.value),
      endMin: timeEnd.value.trim() ? parseTimeToMinutes(timeEnd.value) : null,
      alarmMode: row.alarm_mode,
    });
  },
  close => [
    h('button.btn', { text: 'Отмена', onclick: close }),
    h('button.btn.btn-primary', {
      text: 'Сохранить',
      onclick: e => {
        const body = e.currentTarget.closest('.modal').querySelector('.modal-bd');
        const data = body._collect();
        if (data.startMin === null) { toast('Не понял время начала', 'error'); return; }
        close();
        patchRow(row, data);
      },
    }),
  ]);
}
