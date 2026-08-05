/**
 * Вендорит иконки Phosphor в репозиторий: node tools/vendor-icons.mjs
 *
 * Зачем не CDN: веб-часть вшита в APK и должна открываться без интернета.
 * Ссылка на unpkg работала бы только в браузере с сетью, а в приложении
 * иконки просто не нарисовались бы.
 *
 * Зачем не весь шрифт иконок: в наборе Phosphor больше девяти тысяч глифов,
 * это сотни килобайт. Нам нужно 56 — они умещаются в несколько килобайт
 * как готовые пути SVG.
 *
 * Список берётся из макета: если добавили иконку в интерфейс — добавьте её
 * сюда и перезапустите. Скрипт падает, если иконки нет в наборе: молча
 * получить пустой квадрат хуже, чем узнать об опечатке сразу.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const VERSION = '2.1.1';
const OUT = path.join(import.meta.dirname, '..', 'public', 'js', 'vendor', 'icons.js');

// weight → имена. regular — основной, fill — активное состояние, bold — галочки.
const WANTED = {
  regular: [
    'arrow-line-down', 'arrow-line-up', 'arrows-clockwise', 'arrows-down-up',
    'arrows-in-line-vertical', 'arrows-out-line-horizontal', 'battery-high',
    'bell', 'bell-ringing', 'bell-slash', 'browser', 'cake', 'calendar-blank',
    'envelope-simple', 'lock-simple', 'sign-out',
    'calendar-check', 'caret-left', 'caret-right', 'cell-signal-full',
    'chart-bar', 'check-circle', 'clock',
    'clock-clockwise', 'device-mobile', 'dots-six-vertical', 'dots-three-vertical',
    'file', 'file-arrow-down', 'file-arrow-up', 'gear', 'hand-tap', 'key',
    'laptop', 'list-checks', 'list-dashes', 'magic-wand', 'math-operations',
    'moon', 'music-note-simple', 'note', 'pencil-simple', 'plus', 'printer', 'puzzle-piece',
    'qr-code', 'scan', 'shuffle', 'sign-in', 'sneaker-move', 'stack-simple',
    'sun', 'sun-horizon', 'trash', 'user', 'wifi-high', 'x',
  ],
  // fill — активный раздел в боковой колонке. Нужен для каждой иконки NAV:
  // без него активный пункт оставался без значка вовсе
  fill: [
    'alarm', 'check-circle', 'microphone', 'play', 'sparkle', 'warning-circle',
    'waveform', 'sun-horizon', 'note', 'list-checks', 'gear', 'circle',
    'calendar-blank', 'chart-bar',
  ],
  bold: ['check'],
};

/** Из файла иконки нужен только внутренний путь: остальное задаёт наш <svg>. */
function extractInner(svg, name) {
  const m = svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/);
  if (!m) throw new Error(`${name}: не похоже на SVG`);
  return m[1]
    .replace(/\s+fill="currentColor"/g, '')
    .replace(/>\s+</g, '><')
    .trim();
}

async function fetchIcon(weight, name) {
  const suffix = weight === 'regular' ? '' : `-${weight}`;
  const url = `https://unpkg.com/@phosphor-icons/core@${VERSION}/assets/${weight}/${name}${suffix}.svg`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${weight}/${name}: HTTP ${res.status} — проверьте имя иконки`);
  return extractInner(await res.text(), name);
}

const icons = {};
let count = 0;
for (const [weight, names] of Object.entries(WANTED)) {
  for (const name of names) {
    const key = weight === 'regular' ? name : `${name}-${weight}`;
    icons[key] = await fetchIcon(weight, name);
    count += 1;
  }
}

const body = `/**
 * Иконки Phosphor, вшитые в проект. Сгенерировано tools/vendor-icons.mjs —
 * правьте список там, а не здесь.
 *
 * Набор: ${count} иконок, версия @phosphor-icons/core ${VERSION}, лицензия MIT.
 * Вшиты, потому что веб-часть работает внутри APK без интернета.
 */

export const ICONS = ${JSON.stringify(icons, null, 0)};

/**
 * Иконка как <svg>. Размер задаётся шрифтом родителя (1em), цвет наследуется —
 * иконка ведёт себя как буква и не требует отдельной подгонки.
 */
export function icon(name, { size = '1em', label = null, cls = '' } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 256 256');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'currentColor');
  if (cls) svg.setAttribute('class', cls);
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); }
  else svg.setAttribute('aria-hidden', 'true');
  svg.style.flex = 'none';
  svg.innerHTML = ICONS[name] ?? ICONS['circle-fill'] ?? '';
  return svg;
}
`;

await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, body, 'utf8');
const kb = (Buffer.byteLength(body, 'utf8') / 1024).toFixed(1);
console.log(`Вшито иконок: ${count}, файл ${kb} КБ → ${path.relative(process.cwd(), OUT)}`);
