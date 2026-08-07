/**
 * Отметка версии в service worker по содержимому оболочки.
 *
 *   node tools/stamp-sw.mjs [--check]
 *
 * Зачем: браузер обновляет service worker, только если изменился сам его файл.
 * Версия стояла числом и правилась руками, а руками её забывают — и после
 * выкладки человек продолжал сидеть на старом CSS, потому что кеш не сменился.
 * Здесь версия считается из содержимого всех файлов оболочки: поменялся любой
 * из них — поменялась версия, и обновление доезжает само.
 *
 * `--check` ничего не пишет, только говорит, совпадает ли отметка. Этим удобно
 * ловить забытый прогон перед коммитом.
 */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SW = path.join(ROOT, 'public/service-worker.js');
const CHECK = process.argv.includes('--check');

const source = await fs.readFile(SW, 'utf8');

/*
 * Список файлов берём из самого service worker, а не пишем второй раз: два
 * списка одного и того же однажды разошлись бы, и отметка перестала бы
 * зависеть от файла, который на самом деле поменялся.
 */
const shellBlock = /const SHELL = \[([\s\S]*?)\];/.exec(source);
if (!shellBlock) {
  console.error('Не нашёл список SHELL в service-worker.js');
  process.exit(2);
}
const files = [...shellBlock[1].matchAll(/'([^']+)'/g)].map(m => m[1]);

/*
 * Переносы строк выравниваем до хеширования: на Windows рабочая копия живёт
 * с CRLF, чекаут CI — с LF, и один и тот же текстовый файл давал два разных
 * хеша. Отметка, поставленная на одной системе, на другой выглядела
 * устаревшей — CI краснел на дереве, которое локально было зелёным.
 * Бинарные файлы не трогаем: git их не перекодирует, они одинаковы везде,
 * а «нормализация» через utf8 их бы только исказила.
 */
const TEXT = /\.(js|css|html|json|webmanifest|svg|txt)$/i;
const lf = buf => Buffer.from(buf.toString('utf8').replaceAll('\r\n', '\n'));

const hash = crypto.createHash('sha256');
let missing = 0;
for (const url of files.sort()) {
  const file = path.join(ROOT, 'public', url.replace(/^\//, ''));
  try {
    hash.update(url);
    const raw = await fs.readFile(file);
    hash.update(TEXT.test(url) ? lf(raw) : raw);
  } catch {
    missing += 1;
    console.warn(`  нет файла: ${url}`);
  }
}
// сам обработчик fetch тоже часть поведения: правка стратегии кеша должна
// приводить к новой версии, даже если файлы оболочки не тронуты
hash.update(source.replaceAll('\r\n', '\n').replace(/const VERSION = '[^']*';/, ''));

const stamp = 'newday-' + hash.digest('hex').slice(0, 12);
const current = /const VERSION = '([^']*)';/.exec(source)?.[1] ?? '';

if (CHECK) {
  if (current === stamp) {
    console.log(`отметка на месте: ${stamp}`);
    process.exit(0);
  }
  console.error(`отметка устарела: в файле ${current}, должна быть ${stamp}`);
  console.error('прогоните: node tools/stamp-sw.mjs');
  process.exit(1);
}

if (current === stamp) {
  console.log(`отметка уже верная: ${stamp}${missing ? ` (файлов не найдено: ${missing})` : ''}`);
  process.exit(0);
}
await fs.writeFile(SW, source.replace(/const VERSION = '[^']*';/, `const VERSION = '${stamp}';`));
console.log(`отметка обновлена: ${current} → ${stamp}${missing ? ` (файлов не найдено: ${missing})` : ''}`);
