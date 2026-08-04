/**
 * Печать дня.
 *
 * По умолчанию один лист A4. Если день не помещается, приложение не режет
 * его молча, а спрашивает: уплотнить или разложить на два листа.
 */

import { h, replace, add } from '../dom.js';
import { state } from '../store.js';
import { formatLong } from '../dates.js';
import { openSheet } from '../components/sheet.js';

const A4_HEIGHT_MM = 297;
const MARGINS_MM = 22;
const MM_TO_PX = 96 / 25.4;
const PAGE_PX = (A4_HEIGHT_MM - MARGINS_MM) * MM_TO_PX;

/*
 * Лист печатают утром, чтобы заполнять его в течение дня. Поэтому по умолчанию
 * на бумагу идёт план и место под отметки, а не итоги: прогресс дня на момент
 * печати всегда нулевой, печатать его незачем. Включить всё равно можно.
 */
const SECTIONS = [
  { id: 'schedule', label: 'Расписание', on: true },
  { id: 'tasks',    label: 'Задачи',     on: true },
  { id: 'meals',    label: 'Питание',    on: true },
  { id: 'sport',    label: 'Спорт',      on: true },
  { id: 'habits',   label: 'Привычки',   on: true },
  { id: 'lines',    label: 'Линейки для заметок', on: true },
  { id: 'progress', label: 'Кольца прогресса', on: false },
];

/**
 * Шапка листа — дата, и только она.
 * Заголовок дня и «фокус» из интерфейса убраны: дату видно в навигации,
 * а главное дело дня — это задача или строка расписания.
 */
function printHead() {
  return h('div.print-head',
    h('div', h('div.d', { text: formatLong(state.date) })),
    h('div.m', { text: state.date.split('-').reverse().join('.') }));
}

/**
 * Прячет то, что пользователь не выбрал, и меряет высоту.
 * Возвращает, сколько листов займёт день.
 */
function applySelection(selected) {
  const map = {
    schedule: '[data-print="schedule"]',
    tasks: '[data-print="tasks"]',
    meals: '[data-print="meals"]',
    sport: '[data-print="sport"]',
    habits: '[data-print="habits"]',
    progress: '[data-print="progress"]',
    lines: '.print-lines',
  };
  for (const [id, sel] of Object.entries(map)) {
    for (const el of document.querySelectorAll(sel)) {
      el.classList.toggle('no-print', !selected.has(id));
    }
  }
}

function measurePages() {
  const body = document.body;
  const wasDense = body.classList.contains('print-dense');
  body.classList.remove('print-dense');
  const height = document.querySelector('.app-body')?.scrollHeight ?? 0;
  if (wasDense) body.classList.add('print-dense');
  return Math.max(1, Math.ceil(height / PAGE_PX));
}

export function openPrintDialog() {
  const selected = new Set(SECTIONS.filter(s => s.on).map(s => s.id));
  let fit = 'dense';   // dense — уместить на лист; two — разрешить два листа

  openSheet('Печать дня', (body, { close }) => {
    const verdict = h('p.small');

    const refresh = () => {
      applySelection(selected);
      const pages = measurePages();
      verdict.textContent = pages <= 1
        ? 'Помещается на один лист.'
        : `Сейчас не помещается: примерно ${pages} листа. Выберите, что делать.`;
      fitBox.style.display = pages <= 1 ? 'none' : '';
    };

    const fitBox = h('div',
      h('span.eyebrow', { text: 'если не помещается' }),
      h('div.row', { style: { gap: '4px', marginTop: '6px' } },
        ...[['dense', 'Уменьшить шрифт'], ['two', 'Разложить на два листа']].map(([v, t]) =>
          h('button.tab', {
            type: 'button', text: t,
            'aria-selected': fit === v ? 'true' : 'false',
            onclick: e => {
              fit = v;
              [...e.currentTarget.parentNode.children].forEach(n => n.setAttribute('aria-selected', 'false'));
              e.currentTarget.setAttribute('aria-selected', 'true');
            },
          }))));

    add(body, h('div.stack',
      h('span.eyebrow', { text: 'что печатать' }),
      h('div.row', { style: { flexWrap: 'wrap', gap: '4px' } },
        ...SECTIONS.map(s => h('button.tab', {
          type: 'button', text: s.label,
          'aria-selected': selected.has(s.id) ? 'true' : 'false',
          onclick: e => {
            if (selected.has(s.id)) selected.delete(s.id); else selected.add(s.id);
            e.currentTarget.setAttribute('aria-selected', selected.has(s.id) ? 'true' : 'false');
            refresh();
          },
        }))),
      verdict,
      fitBox,
      h('p.small', {
        text: 'Лист печатается чёрно-белым: галочки — пустые квадраты, справа от каждой строки колонка «факт».',
      })));

    refresh();
  },
  close => [
    h('button.btn', {
      text: 'Отмена',
      onclick: () => { restore(); close(); },
    }),
    h('button.btn.btn-primary', {
      text: 'Печать',
      onclick: () => {
        close();
        document.body.classList.toggle('print-dense', fit === 'dense' && measurePages() > 1);
        document.body.classList.toggle('print-two-pages', fit === 'two');
        window.addEventListener('afterprint', restore, { once: true });
        window.print();
      },
    }),
  ]);
}

function restore() {
  document.body.classList.remove('print-dense', 'print-two-pages');
  // возвращаем набор по умолчанию, а не «печатать всё»: иначе прогресс,
  // скрытый в разметке, после первой печати начинал бы попадать на лист
  applySelection(new Set(SECTIONS.filter(s => s.on).map(s => s.id)));
}

/**
 * Линейки под рукописные заметки — только на печати.
 * Рисуются бордерами, а не фоновым градиентом: фоны в печати браузер вправе выбросить.
 */
export function printLines(count = 5) {
  return h('div.print-lines', { 'aria-hidden': 'true' },
    ...Array.from({ length: count }, () => h('div.pline')));
}

export { printHead };
