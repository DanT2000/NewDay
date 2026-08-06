/**
 * Что не влезает: обход всего интерфейса с поиском переполнений.
 *
 *   node tools/overflow-check.mjs [--base http://127.0.0.1:4010] [--scale 1,1.25]
 *
 * Проверять «на глаз, где вспомнилось» бесполезно: элементов сотни, и вылезет
 * ровно тот, который не посмотрели. Здесь браузер сам обходит все разделы и все
 * шторки в двух раскладках и двух масштабах и сравнивает у каждого узла его
 * содержимое с его рамкой. Что не влезло — то и печатается, с путём до узла.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const BASE = arg('base', 'http://127.0.0.1:4010');
const SCALES = arg('scale', '1,1.25').split(',').map(Number);
const MAIL = arg('mail', 'demo@newday.local');
const PASS = arg('pass', 'demo1234');
const PORT = 9401;
const OUT = 'd:/Project/NewDay/tools/.shots';
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const EDGE = BROWSERS.find(b => { try { fsSync.accessSync(b); return true; } catch { return false; } });

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'newday-overflow-'));
const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1440,900', '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore' });

let list;
for (let i = 0; i < 60; i++) {
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); break; }
  catch { await new Promise(r => setTimeout(r, 250)); }
}
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
const rpc = (method, params) => new Promise(resolve => {
  const id = ++rpc.n;
  const on = e => { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener('message', on); resolve(m.result ?? m); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
});
rpc.n = 0;
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    console.log('  [исключение]', m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  }
});
const js = async (expr, awaitPromise = false) => {
  const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r?.exceptionDetails) return `ИСКЛЮЧЕНИЕ: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`;
  return r?.result?.value;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const size = (w, h, mobile) => rpc('Emulation.setDeviceMetricsOverride',
  { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });

/*
 * Как считаем переполнение.
 *
 * Узел не влез, если его содержимое шире рамки (`scrollWidth > clientWidth`)
 * и при этом он не прокручивается сам и не обрезает текст многоточием — то
 * есть переполнение видно человеку. Отдельно ловим выезд за правый край
 * родителя: так вылезают кнопки и плитки, у которых своё содержимое влезло,
 * а сами они шире места.
 */
const FINDER = `(() => {
  const bad = [];
  const seen = new Set();
  const nameOf = el => {
    const cls = (el.className || '').toString().split(/\\s+/).filter(Boolean).slice(0, 2).join('.');
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
  };
  const label = el => (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 42);

  for (const el of document.querySelectorAll('.wroot *')) {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;

    const scrolls = /auto|scroll/.test(s.overflowX);
    const clips = s.textOverflow === 'ellipsis' || s.overflowX === 'hidden';

    // 1. содержимое шире рамки и никак не спрятано
    if (!scrolls && !clips && el.scrollWidth - el.clientWidth > 2) {
      const key = 'w:' + nameOf(el) + ':' + label(el);
      if (!seen.has(key)) { seen.add(key); bad.push({ вид: 'содержимое шире рамки',
        узел: nameOf(el), текст: label(el), лишнего: el.scrollWidth - el.clientWidth }); }
    }

    /*
     * 2. Вылез за правый или левый край родителя.
     *
     * Кроме тех, кого туда поставили нарочно: точка на линии «сейчас» сидит на
     * left: -4px, потому что должна оседлать начало линии. Отрицательный
     * сдвиг в собственных стилях — это решение, а не промах, и сообщать о нём
     * значит приучать не смотреть на отчёт.
     */
    const placed = s.position === 'absolute' &&
      [s.left, s.right, s.top, s.bottom, s.marginLeft, s.marginRight]
        .some(v => parseFloat(v) < 0);
    const p = placed ? null : el.parentElement;
    if (p && p.classList && !/auto|scroll/.test(getComputedStyle(p).overflowX)) {
      const pr = p.getBoundingClientRect();
      const over = Math.round(Math.max(r.right - pr.right, pr.left - r.left));
      if (over > 2 && getComputedStyle(p).overflowX !== 'hidden') {
        const key = 'p:' + nameOf(el) + ':' + label(el);
        if (!seen.has(key)) { seen.add(key); bad.push({ вид: 'вылез за край родителя',
          узел: nameOf(el), текст: label(el), лишнего: over }); }
      }
    }

    /*
     * 3. nowrap-строка занимает две строки высоты.
     *
     * Порог 1.6, а не 1.2: у надписи с letter-spacing и своим шрифтом
     * фактическая высота строки на несколько пикселей больше вычисленной, и
     * при 1.2 проверка сыпала «на 3px» там, где всё в порядке. Настоящее
     * переполнение — это когда влезла вторая строка, то есть высота почти
     * вдвое больше.
     */
    /*
     * Третьей проверки — «nowrap-строка занимает две строки высоты» — здесь
     * нет нарочно. Она ловила не то: у кнопки высота задана под палец и вдвое
     * больше строки, и проверка ругалась на каждый чип, где всё в порядке. А
     * поймать настоящий случай ею нельзя: текст с nowrap на две строки не
     * ложится по определению. Проверка, которая не может сработать, хуже
     * отсутствующей — она создаёт вид, что этот случай посмотрели.
     */
  }
  // страница целиком не должна ехать по горизонтали
  const de = document.documentElement;
  if (de.scrollWidth > innerWidth + 2) {
    bad.push({ вид: 'страница шире экрана', узел: 'html', текст: '',
      лишнего: de.scrollWidth - innerWidth });
  }
  return bad;
})()`;

let всего = 0;
const найдено = [];

const обход = async (подпись, шаги) => {
  /*
   * Сначала убеждаемся, что перед нами приложение, а не пустая страница.
   *
   * Без этой проверки прогон по чужому стенду, где нет тестового аккаунта,
   * честно сообщал «переполнений не нашлось» — потому что искать было негде.
   * Проверка, которая проходит на пустоте, хуже отсутствующей.
   */
  const узлов = await js(`document.querySelectorAll('.wroot *').length`);
  if (!узлов || узлов < 20) {
    console.error(`  ✖ ${подпись}: интерфейс не собрался (узлов ${узлов}) — проверять нечего`);
    process.exitCode = 2;
    return;
  }
  for (const [имя, действие] of шаги) {
    if (действие) { await js(действие); await wait(900); }
    const bad = await js(FINDER);
    if (Array.isArray(bad) && bad.length) {
      всего += bad.length;
      найдено.push({ где: `${подпись} · ${имя}`, что: bad });
      console.log(`  ✖ ${подпись} · ${имя}`);
      for (const b of bad.slice(0, 8)) {
        console.log(`      ${b.вид}: ${b.узел} «${b.текст}» на ${b.лишнего}px`);
      }
      if (bad.length > 8) console.log(`      … и ещё ${bad.length - 8}`);
    } else {
      console.log(`  ✔ ${подпись} · ${имя}`);
    }
  }
};

await rpc('Page.enable'); await rpc('Runtime.enable');
await size(1440, 900, false);
await rpc('Page.navigate', { url: `${BASE}/login.html` });
await wait(1500);
const вошли = await js(`fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({emailOrUsername:${JSON.stringify(MAIL)},password:${JSON.stringify(PASS)}})}).then(r=>r.status)`, true);
if (вошли !== 200) {
  console.error(`Не удалось войти как ${MAIL}: ответ ${вошли}`);
  console.error('Проверка без входа прошла бы по пустой странице и соврала бы «переполнений нет».');
  console.error('Задайте --mail и --pass для этого стенда.');
  proc.kill();
  process.exit(2);
}

const nav = name => `[...document.querySelectorAll('.wnav-item, .wpnav-item')].find(b => b.textContent.includes(${JSON.stringify(name)}))?.click()`;
const closeSheet = `document.querySelector('.wmodal-x')?.click()`;
const openRowLike = `[...document.querySelectorAll('.wsched-row')][0]?.click()`;

/* Разделы и шторки: то, что человек действительно открывает. */
const ЭКРАНЫ = [
  ['Сейчас', nav('Сейчас')],
  ['Расписание · неделя', `${nav('Расписание')};setTimeout(()=>[...document.querySelectorAll('.wseg button')].find(b=>b.textContent==='Неделя')?.click(),300)`],
  ['Расписание · день', `[...document.querySelectorAll('.wseg button')].find(b=>b.textContent==='День')?.click()`],
  ['Расписание · месяц', `[...document.querySelectorAll('.wseg button')].find(b=>b.textContent==='Месяц')?.click()`],
  ['Привычки', nav('Привычки')],
  ['Заметки', nav('Заметки')],
  ['Настройки', nav('Настройки')],
];

const ШТОРКИ = [
  ['строка расписания', `${nav('Сейчас')};setTimeout(()=>${openRowLike},600)`],
  ['строка расписания · закрыть', closeSheet],
  ['приём пищи', `[...document.querySelectorAll('.wadd')].find(b=>b.textContent.includes('приём пищи'))?.click()`],
  ['приём пищи · окно', `[...document.querySelectorAll('.wmodal .wopt')].find(o=>o.textContent.includes('Окно'))?.click()`],
  ['приём пищи · точное время', `[...document.querySelectorAll('.wmodal .wopt')].find(o=>o.textContent.includes('Точное'))?.click()`],
  ['приём пищи · закрыть', closeSheet],
  ['задача', `[...document.querySelectorAll('.wadd')].find(b=>b.textContent.includes('задачу'))?.click()`],
  ['задача · закрыть', closeSheet],
  ['помощник', `document.querySelector('.wbtn-ai, .wpbtn-ai')?.click()`],
  ['помощник · закрыть', closeSheet],
  ['привычка', `${nav('Привычки')};setTimeout(()=>document.querySelector('.whead .wbtn-line, .whabit-menu')?.click(),600)`],
  ['привычка · закрыть', closeSheet],
  ['аккаунт', `${nav('Настройки')};setTimeout(()=>[...document.querySelectorAll('.wrow-link')][0]?.click(),600)`],
  ['аккаунт · закрыть', closeSheet],
  ['печать', `[...document.querySelectorAll('.wtop .wbtn-ghost, .wpbtn')].find(b=>b.textContent.includes('Печать'))?.click()`],
  ['печать · закрыть', closeSheet],
];

for (const scale of SCALES) {
  for (const [подпись, w, h, mobile] of [['компьютер', 1440, 900, false], ['телефон', 390, 844, true]]) {
    console.log(`\n──── ${подпись}, масштаб ${Math.round(scale * 100)} %`);
    await size(w, h, mobile);
    await js(`fetch('/api/v1/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { scale: ${scale} } }) })`, true);
    await rpc('Page.navigate', { url: `${BASE}/web.html` });
    await wait(3000);
    await обход(`${подпись} ${Math.round(scale * 100)}%`, ЭКРАНЫ);
    await обход(`${подпись} ${Math.round(scale * 100)}%`, ШТОРКИ);
  }
}

await js(`fetch('/api/v1/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ settings: { scale: 1 } }) })`, true);

/*
 * Свод по узлам, а не по экранам: одна и та же карточка вылезает на всех
 * экранах, где она есть, и список «46 мест» ничего не говорит о том, что
 * править. Правится узел — и уходит сразу десяток замечаний.
 */
console.log(`\n════ Что править ════`);
const поУзлам = new Map();
for (const место of найдено) {
  for (const b of место.что) {
    const key = `${b.узел}|${b.вид}`;
    const rec = поУзлам.get(key) ?? { узел: b.узел, вид: b.вид, макс: 0, раз: 0, где: new Set(), текст: b.текст };
    rec.макс = Math.max(rec.макс, b.лишнего);
    rec.раз += 1;
    rec.где.add(место.где.split(' · ')[0]);
    поУзлам.set(key, rec);
  }
}
const свод = [...поУзлам.values()].sort((a, b) => b.макс - a.макс);
for (const r of свод) {
  console.log(`  ${String(r.макс).padStart(4)}px  ${r.узел}  (${r.вид}; встретилось ${r.раз}× в: ${[...r.где].join(', ')})`);
  if (r.текст) console.log(`         «${r.текст}»`);
}

console.log(`\n════ Итог ════`);
console.log(найдено.length ? `Мест с переполнением: ${найдено.length}, узлов к правке: ${свод.length}, всего замечаний: ${всего}`
  : 'Переполнений не нашлось.');
await fs.writeFile(path.join(OUT, 'overflow.json'), JSON.stringify(найдено, null, 2));
console.log('Подробности: tools/.shots/overflow.json');

proc.kill();
process.exit(найдено.length ? 1 : 0);
