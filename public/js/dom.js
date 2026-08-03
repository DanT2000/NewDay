/** Минимальный хелпер разметки. Никакого шаблонизатора — только элементы. */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h('div.card', { onclick }, child, child)
 * Тег может нести классы через точку: 'button.btn.btn-sm'
 */
/** Второй аргумент — props только если это обычный объект. Узел или текст там — уже ребёнок. */
function isProps(v) {
  return v !== null && typeof v === 'object' && !(v instanceof Node) && !Array.isArray(v);
}

export function h(spec, props = null, ...children) {
  const [tag, ...classes] = String(spec).split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (isProps(props)) apply(el, props);
  else if (props !== null && props !== undefined) children.unshift(props);
  append(el, children);
  return el;
}

export function svg(tag, props = null, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  if (!isProps(props)) { if (props) children.unshift(props); props = null; }
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

function apply(el, props) {
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = el.className ? `${el.className} ${v}` : v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
}

function append(el, children) {
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }
export function replace(el, ...children) { clear(el); append(el, children); return el; }

/** Дописывает детей, пропуская null и false. Родной append превращает их в текст «null». */
export function add(el, ...children) { append(el, children); return el; }

/** Чекбокс: кнопка с aria-checked, галочка рисуется штрихом */
export function checkbox(checked, onToggle, label = 'Выполнено') {
  return h('button.chk', {
    type: 'button', role: 'checkbox',
    'aria-checked': checked ? 'true' : 'false',
    'aria-label': label,
    onclick: e => { e.stopPropagation(); onToggle(!checked); },
  }, svg('svg', { viewBox: '0 0 14 14' },
      svg('path', { d: 'M2 7.5 L5.5 11 L12 3.5' })));
}

/** Кольцо прогресса. pct === null означает «нечего считать» */
export function ring(pct, { size = 76, stroke = 7, color = 'var(--c-day)', label = null } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const value = pct === null || pct === undefined ? 0 : Math.max(0, Math.min(100, pct));
  const wrap = h('div.ring', { style: { width: `${size}px`, height: `${size}px` } },
    svg('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true' },
      svg('circle', { class: 'track', cx: size / 2, cy: size / 2, r, 'stroke-width': stroke }),
      svg('circle', {
        class: 'prog', cx: size / 2, cy: size / 2, r, 'stroke-width': stroke,
        stroke: color, 'stroke-dasharray': c.toFixed(2),
        'stroke-dashoffset': (c * (1 - value / 100)).toFixed(2),
      })),
    h('span.val', {
      text: pct === null || pct === undefined ? '—' : `${Math.round(pct)}`,
      style: { fontSize: size < 56 ? '13px' : '15px' },
    }));
  if (label) wrap.append(h('span.sr-only', { text: label }));
  return wrap;
}

/** Экранирование не нужно — везде используется textContent, но пусть будет для html-вставок */
export const esc = s => String(s ?? '').replace(/[&<>"]/g, ch =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
