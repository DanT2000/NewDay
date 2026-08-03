/**
 * Полоска ближайших дней. Основной способ навигации — стрелки и свайп;
 * календарь спрятан за кнопкой, потому что для «вчера / завтра» он избыточен.
 */

import { h, clear, replace} from '../dom.js';
import { addDays, weekdayShort, dayNumber, formatLong, formatShort, rangeDates, weekdayLong } from '../dates.js';
import { state, today } from '../store.js';

const SPAN = 3; // сколько дней показывать в каждую сторону

export function renderDateStrip(root, onPick) {
  const cur = state.date;
  const t = today();
  const index = new Map(state.daysIndex.map(d => [d.date, d]));

  const strip = h('div.datestrip',
    h('button.icon-btn', {
      text: '‹', title: 'Предыдущий день', 'aria-label': 'Предыдущий день',
      onclick: () => onPick(addDays(cur, -1)),
    }),
    // Дата словами рядом со стрелками: без неё приходилось искать,
    // какой из номеров выделен
    h('div.daynav-label',
      h('b', { text: `${weekdayLong(cur)}, ${formatShort(cur)}` }),
      cur === t ? h('span.pill', { text: 'сегодня' }) : null),
    h('div.datestrip-scroll',
      ...rangeDates(addDays(cur, -SPAN), addDays(cur, SPAN)).map(d => {
        const info = index.get(d);
        return h('button.dchip', {
          class: d === t ? 'is-today' : '',
          'aria-current': d === cur ? 'date' : null,
          title: info?.title ? `${formatLong(d)} — ${info.title}` : formatLong(d),
          onclick: () => onPick(d),
        },
          h('span.dow', { text: weekdayShort(d) }),
          h('span.dnum', { text: dayNumber(d) }));
      })),
    h('button.icon-btn', {
      text: '›', title: 'Следующий день', 'aria-label': 'Следующий день',
      onclick: () => onPick(addDays(cur, 1)),
    }),
    cur !== t ? h('button.btn.btn-sm.btn-ghost', {
      text: 'Сегодня', onclick: () => onPick(t),
    }) : null);

  replace(root, strip);
}

/** Свайп влево-вправо по области дня — то же, что стрелки. */
export function attachSwipe(el, onPrev, onNext) {
  let x0 = null, y0 = null;
  el.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
  }, { passive: true });

  el.addEventListener('touchend', e => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    // горизонталь должна явно преобладать, иначе это обычная прокрутка
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 2) return;
    if (e.target.closest('input, textarea, select, .datestrip-scroll')) return;
    (dx > 0 ? onPrev : onNext)();
  }, { passive: true });
}
