/**
 * Календарь месяца для выбора произвольной даты.
 *
 * Нужен там, где «вчера / завтра» уже не помогает: перескочить на дату
 * через месяц стрелками невозможно. Неделя начинается с понедельника —
 * так в макете и так привычнее.
 */

import { h, add, replace } from '../dom.js';
import { icon } from '../vendor/icons.js';
import { addDays, dayNumber } from '../dates.js';

const MONTHS = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];
const DOW = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

/**
 * @param selected YYYY-MM-DD — от него открывается месяц
 * @param onPick   (date) => void
 */
export function renderCalendar(selected, onPick) {
  const box = h('div.cal');
  let [year, month] = selected.split('-').map(Number);
  month -= 1;

  const draw = () => {
    // Смещение первого дня: getDay() даёт 0 для воскресенья, нам нужен пн = 0
    const lead = (new Date(year, month, 1).getDay() + 6) % 7;
    const inMonth = new Date(year, month + 1, 0).getDate();
    const todayIso = (() => {
      const n = new Date();
      return iso(n.getFullYear(), n.getMonth(), n.getDate());
    })();

    const grid = h('div.cal-grid');
    add(grid, ...DOW.map(d => h('span.cal-dow', { text: d })));
    // Пустые ячейки до первого числа: сетка должна совпадать с днями недели
    for (let i = 0; i < lead; i++) add(grid, h('span'));
    for (let d = 1; d <= inMonth; d++) {
      const date = iso(year, month, d);
      add(grid, h('button.cal-day', {
        type: 'button',
        text: String(d),
        class: [date === selected ? 'is-sel' : '', date === todayIso ? 'is-today' : ''].filter(Boolean).join(' '),
        onclick: () => onPick(date),
      }));
    }

    const shift = by => {
      month += by;
      if (month < 0) { month = 11; year -= 1; }
      if (month > 11) { month = 0; year += 1; }
      draw();
    };

    const prev = h('button.roundbtn', { type: 'button', title: 'Предыдущий месяц', 'aria-label': 'Предыдущий месяц', onclick: () => shift(-1) });
    add(prev, icon('caret-left', { size: '16px' }));
    const next = h('button.roundbtn', { type: 'button', title: 'Следующий месяц', 'aria-label': 'Следующий месяц', onclick: () => shift(1) });
    add(next, icon('caret-right', { size: '16px' }));

    replace(box,
      h('div.cal-hd',
        h('span.cal-title', { text: `${MONTHS[month]} ${year}` }),
        prev, next),
      grid,
      h('button.btn.btn-sm.btn-ghost', {
        type: 'button', text: 'Сегодня',
        onclick: () => onPick(todayIso),
      }));
  };

  draw();
  return box;
}

export { addDays, dayNumber };
