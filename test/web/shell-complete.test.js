/**
 * Офлайн-оболочка должна быть полной.
 *
 * Список файлов в service-worker.js пишется руками, а страницы меняются
 * сами: добавили стиль или модуль — и без сети страница открывается голой
 * или вовсе не собирается, причём видно это только на телефоне в метро.
 *
 * Здесь список не сверяется с другим списком (это ничего не сторожит):
 * тест сам обходит страницы оболочки, идёт по их ссылкам и импортам и
 * требует, чтобы каждый найденный файл был в кеше.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const КОРЕНЬ = path.join(__dirname, '../../public');
const исходник = fs.readFileSync(path.join(КОРЕНЬ, 'service-worker.js'), 'utf8');

const SHELL = [...исходник.match(/const SHELL = \[[\s\S]*?\n\];/)[0].matchAll(/'([^']+)'/g)]
  .map(m => m[1]);

/** Диагностика по `?diag=1` — в офлайне не нужна, кешировать её нечего. */
const НЕ_НУЖНО = new Set(['/js/dev-overflow.js']);

/*
 * «/» в списке — это адрес запуска приложения, а на диске ему отвечает
 * index.html: тот же файл, другой адрес.
 */
const кФайлу = (p) => {
  const чистый = p.split(/[?#]/)[0];
  if (чистый === '/') return path.join(КОРЕНЬ, 'index.html');
  return path.join(КОРЕНЬ, чистый.replace(/^\//, ''));
};

/** Ссылки страницы и импорты модуля — только свои, внешние адреса не трогаем. */
function ссылкиИз(p, текст) {
  const найдено = [];
  const свой = s => s.startsWith('/') || s.startsWith('./') || s.startsWith('../');
  const разрешить = s => (s.startsWith('/') ? s : path.posix.normalize(path.posix.join(path.posix.dirname(p), s)));

  if (p.endsWith('.html') || p === '/') {
    for (const m of текст.matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (свой(m[1])) найдено.push(разрешить(m[1]));
    }
  }
  if (p.endsWith('.js')) {
    // import ... from '…', import('…') — только с записанным в коде адресом
    for (const m of текст.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      if (свой(m[1])) найдено.push(разрешить(m[1]));
    }
  }
  if (p.endsWith('.css')) {
    for (const m of текст.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      if (свой(m[1])) найдено.push(разрешить(m[1]));
    }
  }
  return найдено;
}

test('в офлайн-кеше есть всё, из чего собираются его страницы', () => {
  const вКеше = new Set(SHELL);
  const пройдено = new Set();
  const пропало = [];

  const обойти = (p) => {
    if (пройдено.has(p)) return;
    пройдено.add(p);
    const файл = кФайлу(p);
    if (!fs.existsSync(файл)) return;
    for (const ссылка of ссылкиИз(p, fs.readFileSync(файл, 'utf8'))) {
      if (/^\/(api|downloads)\//.test(ссылка) || НЕ_НУЖНО.has(ссылка)) continue;
      if (!вКеше.has(ссылка)) пропало.push(`${ссылка} ← ${p}`);
      обойти(ссылка);
    }
  };
  for (const p of SHELL) обойти(p);

  assert.deepStrictEqual(пропало, [],
    `эти файлы нужны страницам оболочки, но их нет в SHELL:\n  ${пропало.join('\n  ')}`);
});

test('каждый файл из офлайн-кеша существует на диске', () => {
  const нет = SHELL.filter(p => !fs.existsSync(кФайлу(p)));
  assert.deepStrictEqual(нет, [], `в SHELL записаны несуществующие файлы: ${нет.join(', ')}`);
});
