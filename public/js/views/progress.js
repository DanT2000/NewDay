/**
 * Кольца прогресса. Единственное место в интерфейсе, где цвет несёт смысл
 * сам по себе: пять секций различаются оттенком, чтобы читаться с одного взгляда.
 *
 * Расписание в прогресс не входит — про время знают часы, а не галочки.
 * Зато большое кольцо теперь ровно равно сумме пяти маленьких: раньше в него
 * молча попадали ещё и строки расписания, и число «12 из 26» невозможно было
 * разложить по кольцам.
 */

import { h, ring, clear, replace} from '../dom.js';
import { state } from '../store.js';

const SECTIONS = [
  { key: 'work',   label: 'работа',   color: 'var(--c-work)' },
  { key: 'home',   label: 'дом',      color: 'var(--c-home)' },
  { key: 'food',   label: 'питание',  color: 'var(--c-food)' },
  { key: 'sport',  label: 'спорт',    color: 'var(--c-sport)' },
  { key: 'habits', label: 'привычки', color: 'var(--c-habits)' },
];

export function renderProgress(root) {
  const p = state.day?.progress;
  if (!p) { clear(root); return; }

  const total = p.total;
  const box = h('div.rings',
    h('div.ring-main',
      ring(total.percent, { size: 84, stroke: 8, color: 'var(--c-day)', label: 'Прогресс дня' }),
      h('div',
        h('div.eyebrow', { text: 'прогресс дня' }),
        h('div.title', {
          text: total.possible
            ? `${total.done} из ${total.possible}`
            : 'Отмечать пока нечего',
          style: { marginTop: '2px' },
        }),
        h('div.small', {
          // расписание сюда не входит намеренно, поэтому и подсказка про дела
          text: total.possible
            ? (total.percent === 100 ? 'Всё сделано' : `Осталось ${total.possible - total.done}`)
            : 'Дела, питание, спорт и привычки — то, что отмечаете вы',
          style: { marginTop: '2px' },
        }))),
    h('div.ring-mini-row',
      ...SECTIONS.map(s => h('div',
        ring(p[s.key]?.percent ?? null, { size: 46, stroke: 5, color: s.color, label: s.label }),
        h('div.ring-lbl', { text: s.label })))));

  replace(root, box);
}
