/**
 * Привычки на текущий день.
 *
 * Для «Бросаю» (polarity = avoid) отметка называется «Сорвался», а не
 * «Не выполнил»: это разные события, и человек должен видеть именно своё.
 */

import { h, checkbox, clear } from '../dom.js';
import { state, reloadDay } from '../store.js';
import * as api from '../api.js';
import { toast } from '../toast.js';
import { openSheet } from '../components/sheet.js';

export function renderHabitsToday(root) {
  const list = state.day?.habits ?? [];
  const box = h('div');

  const active = list.filter(x => x.activeToday);
  const resting = list.filter(x => !x.activeToday);

  for (const x of active) box.append(row(x));

  if (!list.length) {
    box.append(h('p.empty', { text: 'Привычек пока нет. Заведите первую — например, «Вода».' }));
  } else if (!active.length) {
    box.append(h('p.empty', { text: 'Сегодня по графику привычек нет.' }));
  }

  if (resting.length) {
    box.append(h('div.divider', { style: { margin: '8px 12px' } }));
    for (const x of resting) box.append(row(x));
  }

  clear(root).append(box);
}

function row(x) {
  const done = x.status === 'done';
  const label = x.polarity === 'avoid' ? 'Удержался' : 'Выполнено';

  return h('div.hrow', { class: x.activeToday ? '' : 'inactive' },
    x.activeToday
      ? checkbox(done, v => setStatus(x, v ? 'done' : (x.polarity === 'avoid' ? 'missed' : 'missed')), label)
      : h('span', { style: { width: '20px' } }),
    h('span.hemoji', { text: x.emoji || '•' }),
    h('div', { style: { minWidth: 0 } },
      h('div', { text: x.title, style: { fontWeight: 500 } }),
      h('div.hmeta', ...meta(x))),
    h('div.row',
      x.activeToday && !done && x.polarity === 'avoid'
        ? h('button.btn.btn-sm.btn-danger', { text: 'Сорвался', onclick: () => setStatus(x, 'missed') })
        : null,
      h('button.icon-btn', {
        text: '⋯', title: 'Ещё', 'aria-label': 'Действия с привычкой',
        onclick: () => openMenu(x),
      })));
}

function meta(x) {
  const parts = [];
  if (!x.activeToday) {
    parts.push(h('span', { text: 'сегодня выходной' }));
    return parts;
  }
  if (x.challenge) {
    const c = x.challenge;
    parts.push(h('span.hchal', { text: `${c.day} / ${c.target}` }));
    if (c.breaks > 0 && x.breakPolicy === 'keep') {
      parts.push(h('span', { text: ` · срывов ${c.breaks}` }));
    }
    if (c.complete) parts.push(h('span', { text: ' · цель взята' }));
  } else if (x.status === 'skipped') {
    parts.push(h('span', { text: 'пропуск не в счёт' }));
  } else if (x.status === 'missed') {
    parts.push(h('span.danger', { text: x.polarity === 'avoid' ? 'срыв' : 'не сделано' }));
  }
  return parts.length ? parts : [h('span', { text: ' ' })];
}

async function setStatus(x, status) {
  try {
    await api.habits.setLog(x.id, state.date, status);
    await reloadDay();
  } catch (e) { toast(e.message, 'error'); }
}

function openMenu(x) {
  openSheet(x.title, (body, { close }) => {
    const act = (text, fn, cls = 'btn') => h('button', {
      class: `${cls} btn-block`, text,
      style: { justifyContent: 'flex-start' },
      onclick: async () => { close(); await fn(); },
    });
    body.append(h('div.stack',
      act('Отметить выполненной', () => setStatus(x, 'done')),
      act(x.polarity === 'avoid' ? 'Отметить срыв' : 'Отметить невыполненной', () => setStatus(x, 'missed')),
      act('Заморозить день (не считать)', () => setStatus(x, 'skipped')),
      act('Снять отметку', async () => {
        try { await api.habits.clearLog(x.id, state.date); await reloadDay(); }
        catch (e) { toast(e.message, 'error'); }
      }, 'btn btn-ghost'),
      h('div.divider'),
      h('a.btn.btn-ghost.btn-block', {
        href: '#habits', text: 'Настроить привычки',
        style: { justifyContent: 'flex-start' },
        onclick: close,
      })));
  });
}
