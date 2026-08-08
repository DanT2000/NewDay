/**
 * Проверка материалов для карточек магазинов.
 *
 *   node tools/store-assets-check.mjs
 *
 * Требования магазинов легко нарушить незаметно: пересняли скриншоты другим
 * скриптом — и пропорции уехали, вставили картинку побольше — и превысили вес.
 * Магазин об этом скажет уже при загрузке, а RuStore молча обрежет. Дешевле
 * проверять здесь.
 *
 * Размеры читаются из заголовков файлов напрямую, без библиотек: PNG хранит
 * ширину и высоту в IHDR, JPEG — в маркере SOFn.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SHOTS = 'store/screens';
const FEATURE = 'store/feature-1024x500.png';
const ICON = 'public/icons/icon-512.png';

let bad = 0;
const проба = (name, ok, got) => {
  console.log(`${ok ? '  ок  ' : 'ПЛОХО '} ${name}${ok ? '' : ` → ${got}`}`);
  if (!ok) bad += 1;
};

/** Размеры PNG из IHDR: он всегда первый чанк, сразу после 8-байтовой подписи. */
function pngSize(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/**
 * Размеры JPEG: идём по маркерам до SOFn. Маркеры C4/C8/CC — не SOF, это
 * таблицы Хаффмана и арифметического кодирования, их надо пропускать, иначе
 * размер читается из мусора.
 */
function jpegSize(buf) {
  if (buf.readUInt16BE(0) !== 0xffd8) return null;
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

const size = (path, buf) => (path.endsWith('.png') ? pngSize(buf) : jpegSize(buf));

console.log('Скриншоты телефона\n');

if (!existsSync(SHOTS)) {
  проба('каталог со скриншотами существует', false, `нет ${SHOTS}`);
} else {
  const files = readdirSync(SHOTS).filter(f => /\.(jpg|jpeg|png)$/i.test(f)).sort();
  проба(`штук не больше 10 (нашлось ${files.length})`, files.length > 0 && files.length <= 10,
    `${files.length}`);

  for (const f of files) {
    const buf = readFileSync(join(SHOTS, f));
    const s = size(f, buf);
    const мб = buf.length / 1024 / 1024;
    if (!s) { проба(f, false, 'не удалось прочитать размер'); continue; }

    // 9:16 с допуском в один пиксель на округление
    const ratio = s.w / s.h;
    const ok9x16 = Math.abs(ratio - 9 / 16) < 0.004;
    const влезает = s.w <= 2160 && s.h <= 3840;
    const вес = мб <= 5;
    проба(`${f} — ${s.w}×${s.h}, ${(мб * 1024).toFixed(0)} КБ`,
      ok9x16 && влезает && вес,
      [!ok9x16 && `пропорции ${ratio.toFixed(3)} вместо ${(9 / 16).toFixed(3)}`,
        !влезает && 'больше 2160×3840',
        !вес && `${мб.toFixed(1)} МБ, лимит 5`].filter(Boolean).join('; '));
  }
}

console.log('\nГрафическое изображение для Google Play\n');
if (!existsSync(FEATURE)) {
  проба('изображение существует', false, `нет ${FEATURE}`);
} else {
  const buf = readFileSync(FEATURE);
  const s = size(FEATURE, buf);
  проба(`${FEATURE} — ${s?.w}×${s?.h}, ${(buf.length / 1024).toFixed(0)} КБ`,
    s?.w === 1024 && s?.h === 500, `нужно ровно 1024×500, получено ${s?.w}×${s?.h}`);
}

console.log('\nЗначок\n');
if (!existsSync(ICON)) {
  проба('значок существует', false, `нет ${ICON}`);
} else {
  const buf = readFileSync(ICON);
  const s = size(ICON, buf);
  проба(`${ICON} — ${s?.w}×${s?.h}, ${(buf.length / 1024).toFixed(0)} КБ`,
    s?.w === 512 && s?.h === 512 && buf.length <= 1024 * 1024,
    `нужно 512×512 PNG до 1 МБ, получено ${s?.w}×${s?.h}, ${(buf.length / 1024).toFixed(0)} КБ`);
}

console.log(`\n${bad === 0 ? 'Все материалы годятся' : `Не годится: ${bad}`}`);
process.exit(bad === 0 ? 0 : 1);
