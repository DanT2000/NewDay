/**
 * Навигация по дням.
 *
 * Главная беда прошлой версии: полоска была центрирована на выбранном дне,
 * поэтому каждый шаг сдвигал все числа — человек нажимал на «5», а под
 * пальцем оказывалось «6». Теперь окно привязано к неделям и стоит на месте:
 * пока выбранный день внутри показанного блока, ничего не двигается. Окно
 * меняется только при переходе через границу недели — то есть там, где это
 * ожидаемо.
 *
 * Раскладка: слева день словами, по центру числа, стрелки по бокам от них,
 * «Сегодня» отдельной кнопкой. На узком экране то же самое в две строки,
 * и стрелки становятся большими: попасть в иконку 30×30 пальцем нельзя.
 *
 * Подпись слева — кнопка: она открывает календарь месяца. Стрелками до
 * даты через два месяца не дойти, а полоска показывает максимум четыре
 * недели. Кнопка там же, где человек и так читает текущую дату.
 *
 * Числа не прокручиваются, а делят ширину между собой — сколько недель
 * влезло, столько и показано, от одной до четырёх.
 */

import { h, add, replace } from '../dom.js';
import { icon } from '../vendor/icons.js';
import {
  addDays, weekdayShort, dayNumber, formatLong, formatShort,
  rangeDates, weekdayLong, weekdayOf,
} from '../dates.js';
import { state, today } from '../store.js';

const CHIP_MIN = 40;     // ниже этого палец уже не попадает
let observed = null;

/** Понедельник недели, в которую попадает дата. */
function weekStart(date) {
  return addDays(date, -(weekdayOf(date) - 1));
}

/** Сколько недель показываем при такой ширине. */
function weeksFor(width) {
  if (!width) return 1;
  const forChips = width - 24;             // отступы карточки
  const weeks = Math.floor(forChips / (7 * CHIP_MIN));
  return Math.max(1, Math.min(4, weeks));
}

export function renderDateStrip(root, onPick) {
  const cur = state.date;
  const t = today();
  const index = new Map(state.daysIndex.map(d => [d.date, d]));

  const weeks = weeksFor(root.clientWidth || root.parentElement?.clientWidth || 0);
  const from = weekStart(cur);
  const to = addDays(from, weeks * 7 - 1);

  const label = h('button.daynav-label', {
    type: 'button',
    title: 'Выбрать дату в календаре',
    onclick: () => openDatePicker(cur, onPick),
  },
    h('span.daynav-label-text',
      h('b', { text: weekdayLong(cur) }),
      h('span.small', { text: formatShort(cur) })),
    icon('calendar-blank', { size: '15px', cls: 'daynav-label-ico' }));

  const arrow = (dir, title) => h('button.daynav-arrow', {
    text: dir < 0 ? '‹' : '›', title, 'aria-label': title,
    onclick: () => onPick(addDays(cur, dir)),
  });

  const grid = h('div.daynav-grid', {
    style: { gridTemplateColumns: `repeat(7, minmax(0, 1fr))` },
  }, ...rangeDates(from, to).map(d => {
    const info = index.get(d);
    return h('button.dchip', {
      class: [d === t ? 'is-today' : '', info ? 'has-data' : ''].filter(Boolean).join(' '),
      'aria-current': d === cur ? 'date' : null,
      title: info?.title ? `${formatLong(d)} — ${info.title}` : formatLong(d),
      onclick: () => onPick(d),
    },
      h('span.dow', { text: weekdayShort(d) }),
      h('span.dnum', { text: dayNumber(d) }));
  }));

  const todayBtn = h('button.btn.btn-sm', {
    class: cur === t ? 'btn-ghost' : '',
    text: 'Сегодня',
    disabled: cur === t,
    title: cur === t ? 'Вы и так на сегодня' : 'Вернуться к сегодняшнему дню',
    onclick: () => onPick(t),
  });

  replace(root, h('div.daynav-in',
    label,
    arrow(-1, 'Предыдущий день'),
    grid,
    arrow(1, 'Следующий день'),
    todayBtn));

  // Ширина меняется — меняется и число недель. Пересчитываем один раз
  // на изменение, а не на каждый кадр.
  if (!observed && typeof ResizeObserver !== 'undefined') {
    let last = weeks;
    observed = new ResizeObserver(() => {
      const now = weeksFor(root.clientWidth);
      if (now !== last) { last = now; renderDateStrip(root, onPick); }
    });
    observed.observe(root);
  }
}

/**
 * Календарь месяца. Загружается по нажатию, а не вместе со страницей:
 * большинство дней человек листает стрелками, и держать разметку
 * календаря наготове незачем.
 */
async function openDatePicker(current, onPick) {
  const [{ openSheet }, { renderCalendar }] = await Promise.all([
    import('../components/sheet.js'),
    import('../components/calendar.js'),
  ]);
  openSheet('Выберите дату', (body, { close }) => {
    add(body, renderCalendar(current, date => { close(); onPick(date); }));
  });
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
    if (e.target.closest('input, textarea, select, .daynav')) return;
    (dx > 0 ? onPrev : onNext)();
  }, { passive: true });
}
