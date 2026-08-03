/**
 * Выбор времени и длительности без клавиатуры.
 *
 * На телефоне вызов клавиатуры ради «09:30» — это лишние движения и промахи,
 * поэтому основной путь здесь: тап по часу, тап по минутам, тап по длительности.
 * Три касания вместо набора. Клавиатурный ввод при этом никуда не делся —
 * на компьютере в строке по-прежнему можно просто напечатать «930».
 *
 * Длительность выбирается, а не второе время: в голове человек думает
 * «на час», а не «до 10:30», и окончание считается само.
 */

import { h, replace, add } from '../dom.js';
import { formatMinutes, formatDuration } from '../dates.js';
import { openSheet } from './sheet.js';

const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240, 480];
const NUDGES = [-15, -5, 5, 15, 30, 60];

/**
 * @param options.startMin   текущее начало
 * @param options.endMin     текущее окончание или null
 * @param options.prevEndMin окончание предыдущей строки — для «продолжить за предыдущей»
 * @param options.title      что за строка, для заголовка
 * @param onPick             ({ startMin, endMin }) => void
 */
export function openTimePicker({ startMin = 9 * 60, endMin = null, prevEndMin = null, title = '' }, onPick) {
  let start = startMin;
  let end = endMin;

  const preview = h('div.tp-preview');
  const hourGrid = h('div.tp-hours');
  const minRow = h('div.tp-mins');
  const durRow = h('div.tp-durs');

  const duration = () => (end === null ? null : end - start);

  function drawPreview() {
    const d = duration();
    replace(preview,
      h('span.tp-time', { text: formatMinutes(start) }),
      h('span.tp-dash', { text: '–' }),
      h('span.tp-time', { class: end === null ? 'muted' : '', text: end === null ? '··:··' : formatMinutes(end) }),
      d !== null ? h('span.pill', { text: formatDuration(d) }) : h('span.micro', { text: 'без окончания' }));
  }

  /** Сдвигаем начало, сохраняя длительность: обычно человек переносит дело целиком. */
  function setStart(v, { keepDuration = true } = {}) {
    const d = duration();
    start = Math.max(0, Math.min(1439, v));
    if (keepDuration && d !== null) end = Math.min(1439, start + d);
    else if (end !== null && end < start) end = null;
    drawAll();
  }

  function setDuration(min) {
    end = min === null ? null : Math.min(1439, start + min);
    drawAll();
  }

  function drawHours() {
    replace(hourGrid, ...Array.from({ length: 24 }, (_, hour) =>
      h('button.tp-cell', {
        type: 'button',
        'aria-pressed': Math.floor(start / 60) === hour ? 'true' : 'false',
        text: String(hour).padStart(2, '0'),
        onclick: () => setStart(hour * 60 + (start % 60)),
      })));
  }

  function drawMinutes() {
    replace(minRow, ...MINUTES.map(m =>
      h('button.tp-cell.tp-cell-sm', {
        type: 'button',
        'aria-pressed': start % 60 === m ? 'true' : 'false',
        text: String(m).padStart(2, '0'),
        onclick: () => setStart(Math.floor(start / 60) * 60 + m),
      })));
  }

  function drawDurations() {
    const d = duration();
    replace(durRow,
      ...DURATIONS.map(min => h('button.tp-cell.tp-cell-wide', {
        type: 'button',
        'aria-pressed': d === min ? 'true' : 'false',
        text: formatDuration(min),
        onclick: () => setDuration(min),
      })),
      h('button.tp-cell.tp-cell-wide', {
        type: 'button',
        'aria-pressed': end === null ? 'true' : 'false',
        text: 'без конца',
        onclick: () => setDuration(null),
      }));
  }

  function drawAll() {
    drawPreview();
    drawHours();
    drawMinutes();
    drawDurations();
  }

  openSheet(title ? `Время: ${title}` : 'Время', (body) => {
    add(body, h('div.stack',
      preview,

      // «Продолжить за предыдущей» — самый частый случай при добавлении строки
      prevEndMin !== null
        ? h('button.btn.btn-block', {
            text: `Начать сразу после предыдущей, в ${formatMinutes(prevEndMin)}`,
            onclick: () => setStart(prevEndMin),
          })
        : null,

      h('div',
        h('span.eyebrow', { text: 'час' }),
        hourGrid),
      h('div',
        h('span.eyebrow', { text: 'минуты' }),
        minRow),
      h('div',
        h('span.eyebrow', { text: 'длительность' }),
        durRow),
      h('div',
        h('span.eyebrow', { text: 'подвинуть начало' }),
        h('div.row', { style: { gap: '4px', marginTop: '6px', flexWrap: 'wrap' } },
          ...NUDGES.map(n => h('button.btn.btn-sm', {
            text: `${n > 0 ? '+' : ''}${n}`,
            onclick: () => setStart(start + n),
          })))),
    ));
    drawAll();
  },
  close => [
    h('button.btn', { text: 'Отмена', onclick: close }),
    h('button.btn.btn-primary', {
      text: 'Готово',
      onclick: () => { close(); onPick({ startMin: start, endMin: end }); },
    }),
  ]);
}
