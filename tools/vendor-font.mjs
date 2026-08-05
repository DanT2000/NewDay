/**
 * Вендорит шрифт Inter: node tools/vendor-font.mjs
 *
 * Макет собран на Inter, а веб-часть живёт внутри APK без интернета —
 * ссылка на Google Fonts там просто не сработает, и приложение поедет
 * системным шрифтом, теряя всю типографику макета.
 *
 * Берём подмножество с кириллицей и латиницей: полный Inter со всеми
 * письменностями — это мегабайты, нам нужны два блока.
 *
 * Google Fonts отдаёт под каждый запрошенный вес один и тот же переменный
 * файл, поэтому файлы дедуплицируются по содержимому: иначе один и тот же
 * шрифт лёг бы в репозиторий четырьмя копиями. На одинаковые файлы
 * выписывается один @font-face с диапазоном веса — переменный шрифт
 * умеет всё между 400 и 700 сам.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const OUT_DIR = path.join(import.meta.dirname, '..', 'public', 'fonts');
const CSS_OUT = path.join(import.meta.dirname, '..', 'public', 'css', 'fonts.css');

// С современным User-Agent приходит woff2 — он втрое меньше ttf.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const API = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'
  + '&subset=cyrillic,latin';

// greek, vietnamese и latin-ext в русском интерфейсе не нужны
const KEEP = ['cyrillic', 'latin'];

const css = await (await fetch(API, { headers: { 'User-Agent': UA } })).text();
const blocks = css.split('/*').filter(Boolean).map(b => '/*' + b);

await fs.mkdir(OUT_DIR, { recursive: true });
// hash → { file, subset, range, weights: Set }
const byHash = new Map();
let bytes = 0;

for (const block of blocks) {
  const subset = block.match(/^\/\*\s*([a-z-]+)\s*\*\//)?.[1];
  if (!subset || !KEEP.includes(subset)) continue;

  const weight = block.match(/font-weight:\s*(\d+)/)?.[1];
  const url = block.match(/url\((https:[^)]+\.woff2)\)/)?.[1];
  const range = block.match(/unicode-range:\s*([^;]+);/)?.[1];
  if (!weight || !url) continue;

  const bin = Buffer.from(await (await fetch(url, { headers: { 'User-Agent': UA } })).arrayBuffer());
  const hash = crypto.createHash('sha256').update(bin).digest('hex').slice(0, 8);

  if (!byHash.has(hash)) {
    const file = `inter-${subset}-${hash}.woff2`;
    await fs.writeFile(path.join(OUT_DIR, file), bin);
    bytes += bin.length;
    byHash.set(hash, { file, subset, range, weights: new Set() });
  }
  byHash.get(hash).weights.add(Number(weight));
}

if (!byHash.size) throw new Error('Не удалось разобрать ответ Google Fonts');

// Старые копии убираем: иначе в репозитории копится мусор от прошлых запусков
for (const f of await fs.readdir(OUT_DIR)) {
  if (f.endsWith('.woff2') && ![...byHash.values()].some(v => v.file === f)) {
    await fs.unlink(path.join(OUT_DIR, f));
  }
}

const faces = [...byHash.values()].map(({ file, subset, range, weights }) => {
  const list = [...weights].sort((a, b) => a - b);
  const w = list.length > 1 ? `${list[0]} ${list.at(-1)}` : String(list[0]);
  return `/* ${subset}, вес ${w} */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: ${w};
  font-display: swap;
  src: url('/fonts/${file}') format('woff2');${range ? `\n  unicode-range: ${range};` : ''}
}`;
});

await fs.writeFile(CSS_OUT, `/**
 * Inter, вшитый в проект. Сгенерировано tools/vendor-font.mjs.
 *
 * Своя копия, а не Google Fonts: веб-часть открывается внутри APK без сети,
 * и внешняя ссылка молча уронила бы типографику до системного шрифта.
 * Подмножества — только кириллица и латиница; файл переменный, поэтому
 * один @font-face покрывает весь диапазон веса.
 */

${faces.join('\n\n')}
`, 'utf8');

console.log(`Файлов шрифта: ${byHash.size}, вместе ${(bytes / 1024).toFixed(0)} КБ`);
