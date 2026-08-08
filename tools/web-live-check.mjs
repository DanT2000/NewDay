/**
 * Веб-версия на настоящих данных: читает и пишет.
 *
 * Проверяем путь целиком: протянул по сетке — назвал — сохранил — блок
 * появился и в сетке, и в дне на сервере. Плюс галочки, акцент, настройки.
 *
 * Нужен потому, что снимок показывает вид, но не поведение. Три ошибки
 * нашлись именно здесь: локальная переменная перекрывала модуль данных и
 * настройки молча не сохранялись; переключение вида не перечитывало период,
 * и месяц рисовался по неделе; клетки соседних месяцев считали дату в
 * текущем, и «5 сентября» показывало дела пятого августа.
 *
 * Запуск: поднять стенд `node tools/dev-preview.js`, затем
 * `node tools/web-live-check.mjs`. Пишет в базу стенда, не в прод.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9337;
const BASE = 'http://127.0.0.1:4010';
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const EDGE = BROWSERS.find(b => { try { fsSync.accessSync(b); return true; } catch { return false; } });
if (!EDGE) { console.error('Не нашёл ни Edge, ни Chrome'); process.exit(1); }
const OUT = path.join(import.meta.dirname, '.shots');

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'newday-web2-'));
const proc = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1440,900', '--hide-scrollbars', '--no-first-run', 'about:blank',
], { stdio: 'ignore' });

const rpc = (ws, method, params) => new Promise(resolve => {
  const id = ++rpc.n;
  const on = e => {
    const m = JSON.parse(e.data);
    if (m.id === id) { ws.removeEventListener('message', on); resolve(m.result ?? m); }
  };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
});
rpc.n = 0;

let list;
for (let i = 0; i < 60; i++) {
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); break; }
  catch { await new Promise(r => setTimeout(r, 250)); }
}
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
await rpc(ws, 'Page.enable');
await rpc(ws, 'Runtime.enable');
await rpc(ws, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const js = async (expression, awaitPromise = false) => {
  const r = await rpc(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r?.result?.value;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const shot = async name => {
  const s = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(OUT, `${name}.png`), Buffer.from(s.data, 'base64'));
};
/** Раздел по названию: номера съезжают, стоит добавить один пункт. */
const nav = label => js(
  `[...document.querySelectorAll('.wnav-item')].find(b => b.textContent.includes(${JSON.stringify(label)})).click()`,
);

const waitFor = async (expr, n = 60) => {
  for (let i = 0; i < n; i++) { if (await js(expr)) return true; await wait(200); }
  return false;
};

/*
 * День, который засеян на стенде, — сегодняшний в часовом поясе стенда.
 *
 * Считаем, а не пишем числом: раньше здесь стояла дата, и в первую же
 * полночь весь прогон становился красным — не потому что что-то сломалось,
 * а потому что проверка смотрела в прошлое.
 */
const TZ = 'Europe/Moscow';
const dayIn = (offset = 0) => new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(Date.now() + offset * 86400000));

const DAY = dayIn(0);
/** «6 августа» — как это подписано в шапке. */
const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const DAY_LABEL = (() => {
  const [, m, d] = DAY.split('-').map(Number);
  return `${d} ${MONTHS_RU[m - 1]}`;
})();
/** Тот же день через год: им проверяется ежегодный повтор. */
const NEXT_YEAR = `${Number(DAY.slice(0, 4)) + 1}${DAY.slice(4)}`;

const пробы = [];
const проба = (что, ok, деталь = '') => { пробы.push([что, ok]); console.log(`  ${ok ? '✔' : '✖'} ${что}${деталь ? ' — ' + деталь : ''}`); };

// ── Вход ──
await rpc(ws, 'Page.navigate', { url: `${BASE}/login.html` });
await wait(1200);
await js(`fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({emailOrUsername:'demo@newday.local',password:'demo1234'})}).then(r=>r.status)`, true);

await rpc(ws, 'Page.navigate', { url: `${BASE}/web.html` });
проба('экран поднялся', await waitFor('Boolean(document.querySelector(".wside"))'));
await wait(700);

// ── Читает настоящий день ──
const rows = await js(`[...document.querySelectorAll('.wsched-title')].map(e => e.textContent)`);
проба('расписание пришло с сервера', rows.length > 0, `${rows.length} строк: ${rows.slice(0, 3).join(', ')}`);
проба('дата из профиля, а не из браузера',
  (await js(`document.querySelector('.wtop-num').textContent`)) === DAY_LABEL,
  await js(`document.querySelector('.wtop-num').textContent`));

/*
 * Галочка задачи. Считаем не «стало больше», а «изменилось»: база стенда
 * живёт между прогонами, и второй раз та же галочка снимается.
 */
const doneCount = () => js(`fetch('/api/v1/days/${DAY}/full').then(r=>r.json()).then(d => Object.values(d.tasks).flat().filter(t=>t.done).length)`, true);
const before = await doneCount();
await js(`document.querySelectorAll('.wlist-row .wbox')[0].click()`);
await wait(900);
const after = await doneCount();
проба('галочка задачи сохранилась на сервере', Math.abs(after - before) === 1, `было ${before}, стало ${after}`);

/*
 * Фильтр категорий меняет только свой список.
 *
 * Раньше он шёл через полную перерисовку: экран моргал, прокрутка прыгала
 * наверх — на глаз это выглядело как перезагрузка страницы. Проверяем по
 * живучести соседнего узла: если экран перестроили целиком, прежний узел
 * выбрасывается из документа.
 */
/*
 * Прокрутку проверяем на нарочно низком окне: на высоком содержимое влезает
 * целиком, прокручивать нечего, и проверка ничего не проверяет.
 */
await rpc(ws, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 560, deviceScaleFactor: 1, mobile: false });
await wait(600);
const прокрутка = await js(`(() => {
  window.__side = document.querySelector('.wside');
  window.__tasks = document.querySelector('.wtasks');
  const b = document.querySelector('.wbody');
  b.scrollTop = 120;
  return b.scrollTop;
})()`);
проба('на низком окне есть что прокручивать', прокрутка > 0, `прокрутилось на ${прокрутка}`);
await js(`[...document.querySelectorAll('.wchips .wchip')].find(c => c.textContent === 'Дом').click()`);
await wait(500);
проба('фильтр не перерисовывает весь экран',
  await js(`document.body.contains(window.__side) && !document.body.contains(window.__tasks)`),
  await js(`'меню живо: ' + document.body.contains(window.__side)
    + ', задачи заменены: ' + !document.body.contains(window.__tasks)`));
проба('прокрутка на месте после фильтра',
  (await js(`document.querySelector('.wbody').scrollTop`)) === прокрутка,
  `${прокрутка} → ${await js(`document.querySelector('.wbody').scrollTop`)}`);
await rpc(ws, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await wait(500);
проба('фильтр действительно отфильтровал',
  await js(`[...document.querySelectorAll('.wtasks .wtag')].every(t => t.textContent === 'Дом')`));
await js(`[...document.querySelectorAll('.wchips .wchip')].find(c => c.textContent === 'Все').click()`);
await wait(300);

// ── Создание блока протягиванием ──
await nav("Расписание");
await wait(500);
// вид запоминается между входами, поэтому нужный выбираем явно
await js(`[...document.querySelectorAll('.wseg button')].find(b => b.textContent === 'Неделя')?.click()`);
проба('сетка недели загрузилась', await waitFor('document.querySelectorAll(".wplan-col").length === 7'));
await wait(600);

/*
 * Тянем по колонке открытого дня, а не по третьей по счёту: номер колонки
 * зависит от того, какой сегодня день недели, и в четверг третья колонка —
 * это среда. Прогон тогда создавал блок в другом дне и не находил его.
 */
const geom = await js(`(() => {
  const col = document.querySelector('.wplan-col.on') ?? document.querySelectorAll('.wplan-col')[0];
  const b = col.getBoundingClientRect();
  return { x: Math.round(b.left + b.width / 2), top: Math.round(b.top) };
})()`);

/*
 * 17:00–17:45. В засеянном дне занято 06:40–07:50, 08:10–12:30, 13:00–17:00,
 * 18:00–19:00, 19:30–20:30 — свободно ровно здесь. Прошлые прогоны целились
 * в 16:00 и в 18:00 и попадали в блок: нажатие по блоку открывает его
 * правку, и проверка молча проверяла не то.
 */
const y1 = geom.top + 11 * 44;
const y2 = geom.top + 11.75 * 44;
const mouse = (type, y) => rpc(ws, 'Input.dispatchMouseEvent', {
  type, x: geom.x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
});

await mouse('mousePressed', y1);
await wait(120);
await mouse('mouseMoved', y2);
await wait(150);
проба('след протягивания показывает время', (await js(`document.querySelector('.wsel')?.textContent`)) === '17:00–17:45',
  await js(`document.querySelector('.wsel')?.textContent ?? 'нет'`));
await mouse('mouseReleased', y2);
await wait(500);

проба('открылся редактор нового блока',
  (await js(`document.querySelector('.wmodal-hd b')?.textContent`)) === 'Новый блок');

await js(`(() => {
  const i = document.querySelector('.wmodal .winput');
  i.value = 'Разбор задач за неделю';
  i.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await js(`document.querySelectorAll('.wmodal .wopt')[1].click()`);   // уведомление
await wait(300);
await shot('web-live-row-editor');
await js(`document.querySelector('.wmodal .wbtn-wide').click()`);
проба('шторка закрылась после сохранения', await waitFor('!document.querySelector(".wveil")'));
await wait(900);

const saved = await js(`fetch('/api/v1/days/${DAY}/full').then(r=>r.json()).then(d =>
  d.schedule.filter(r => r.title === 'Разбор задач за неделю').map(r => r.start_min + '-' + r.end_min + '/' + r.alarm_mode))`, true);
проба('блок записан на сервер с временем и сигналом',
  saved?.[0] === '1020-1065/notify', JSON.stringify(saved));

проба('блок виден в сетке',
  await js(`[...document.querySelectorAll('.wblock-title')].some(e => e.textContent === 'Разбор задач за неделю')`));
await shot('web-live-plan');

// ── Правка блока ──
await js(`[...document.querySelectorAll('.wblock')].find(b => b.textContent.includes('Разбор задач')).click()`);
проба('клик по блоку открыл его правку',
  await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Строка расписания'`));
проба('в поле подставлено название',
  (await js(`document.querySelector('.wmodal .winput')?.value`)) === 'Разбор задач за неделю');

await js(`document.querySelector('.wmodal .wbtn-quiet').click()`);   // Удалить
await waitFor('!document.querySelector(".wveil")');
await wait(900);
const gone = await js(`fetch('/api/v1/days/${DAY}/full').then(r=>r.json()).then(d =>
  d.schedule.some(r => r.title === 'Разбор задач за неделю'))`, true);
проба('удаление дошло до сервера', gone === false);

// ── Месяц ──
await js(`document.querySelectorAll('.wseg button')[2].click()`);
проба('месяц собрался', await waitFor('document.querySelectorAll(".wcell").length >= 35'),
  `клеток: ${await js('document.querySelectorAll(".wcell").length')}`);
проба('в клетке дня видны настоящие дела',
  await js(`[...document.querySelectorAll('.wcell-item')].some(e => e.textContent.includes('Подъём'))`),
  await js(`document.querySelectorAll('.wcell-item').length + ' строк в клетках'`));
// Клетки соседних месяцев не должны повторять дела текущего
/*
 * Сверяем каждую клетку с тем, что на сервере за её дату. Прежняя проверка
 * требовала, чтобы клетки соседних месяцев были пустыми, — а они законно
 * показывают свои дела, и любая запись в конец июля роняла проверку.
 */
const клеткиПоДатам = await js(`(async () => {
  const cells = [...document.querySelectorAll('.wcell')];
  const from = cells[0].dataset.date, to = cells[cells.length - 1].dataset.date;
  const range = await (await fetch('/api/v1/days/range?from=' + from + '&to=' + to)).json();
  const было = {};
  for (const d of range.days) было[d.date] = d.schedule.length;
  return cells
    .map(c => ({ date: c.dataset.date, видно: c.querySelectorAll('.wcell-item').length,
                 всего: было[c.dataset.date] ?? 0 }))
    .filter(x => x.видно > Math.min(3, x.всего) || x.видно > x.всего)
    .map(x => x.date + ': видно ' + x.видно + ', на сервере ' + x.всего);
})()`, true);
проба('в клетках месяца показаны дела именно их даты',
  клеткиПоДатам.length === 0, клеткиПоДатам.join(' | ') || 'все сходятся');
await shot('web-live-month');

// ── Настройки сохраняются ──
// Настройки теперь разделами: сначала оглавление, из него — в раздел.
await nav("Настройки");
await wait(500);
const открытьРаздел = async title => {
  await js(`[...document.querySelectorAll('.wrow-link')]
    .find(r => r.textContent.includes(${JSON.stringify(title)})).click()`);
  await wait(500);
};
// на компьютере раздел открывается сбоку и «назад» нет — тогда это no-op
const назадВОглавление = async () => {
  await js(`document.querySelector('.wset-back')?.click()`);
  await wait(400);
};

await открытьРаздел('Оформление');
await js(`document.querySelectorAll('.wswatch')[2].click()`);
await wait(900);
const accent = await js(`fetch('/api/v1/settings').then(r=>r.json()).then(s => s.settings.accent)`, true);
проба('акцент сохранён в профиле', accent === 'green', String(accent));
await назадВОглавление();

// База между прогонами живёт, поэтому проверяем не значение, а что оно
// изменилось: иначе второй прогон падал бы на том же переключателе
await открытьРаздел('День и питание');
const flagBefore = await js(`fetch('/api/v1/settings').then(r=>r.json()).then(s => Boolean(s.settings.carryOver))`, true);
await js(`document.querySelectorAll('.wrow-sw')[0].click()`);
await wait(900);
const flag = await js(`fetch('/api/v1/settings').then(r=>r.json()).then(s => Boolean(s.settings.carryOver))`, true);
проба('переключатель дня сохранён', flag === !flagBefore, `${flagBefore} → ${flag}`);

await назадВОглавление();
await shot('web-live-settings');

// ── Печать ──
await js('window.__wopen("print")');
await waitFor('Boolean(document.querySelector(".wveil"))');
await wait(300);
await js(`document.querySelector('.wmodal .wbtn-wide').click()`);
проба('лист на печать собран', await waitFor('Boolean(document.querySelector(".psheet"))', 40));

const sheet = await js(`(() => {
  const s = document.querySelector('.psheet');
  if (!s) return null;
  return {
    boxes: s.querySelectorAll('.pbox').length,
    rows: s.querySelectorAll('.prow').length,
    squares: s.querySelectorAll('.psq').length,
    head: s.querySelector('.phead h1')?.textContent,
  };
})()`);
проба('на листе есть разделы и строки', sheet?.boxes >= 3 && sheet?.rows > 5, JSON.stringify(sheet));
проба('у каждой строки квадрат под галочку', sheet?.squares === sheet?.rows);
проба('на листе стоит дата дня', String(sheet?.head).includes('августа'), sheet?.head);
await js(`document.querySelector('.psheet')?.remove()`);

// ── Выгрузка и загрузка ──
const exportOk = await js(`fetch('/api/v1/export').then(r => r.ok && r.headers.get('content-type').includes('json'))`, true);
проба('выгрузка отвечает JSON', exportOk === true);

const icsOk = await js(`fetch('/api/v1/export.ics').then(r => r.ok && r.headers.get('content-type').includes('calendar'))`, true);
проба('календарь отвечает .ics', icsOk === true);

// Своя же выгрузка должна вливаться обратно: если формат разошёлся,
// человек узнает об этом при восстановлении, когда уже поздно
const roundtrip = await js(`(async () => {
  const dump = await (await fetch('/api/v1/export')).json();
  const r = await fetch('/api/v1/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: dump, mode: 'merge' }),
  });
  return r.ok;
})()`, true);
проба('загрузка своей же выгрузки проходит', roundtrip === true);

// ── Разделы и шторки эталона ──
/*
 * Состав экрана проверяем отдельно: эталон задаёт, что на нём есть, и
 * лишний раздел — такая же ошибка, как недостающий.
 */
проба('в колонке ровно пять разделов эталона',
  (await js(`[...document.querySelectorAll('.wnav-item span:first-of-type')].map(e => e.textContent).join(',')`))
    === 'Сейчас,Расписание,Привычки,Заметки,Настройки',
  await js(`[...document.querySelectorAll('.wnav-item span:first-of-type')].map(e => e.textContent).join(',')`));

await nav('Сейчас');
await waitFor('Boolean(document.querySelector(".wsched"))');
await wait(600);
/*
 * Разделов пять, и «напоминаний» среди них нет нарочно: напоминание — это
 * строка расписания без конца, и живёт оно в расписании. Отдельный список
 * заставлял бы помнить, куда записана мысль.
 */
проба('на «Сейчас» пять разделов и ни одного лишнего',
  (await js(`[...document.querySelectorAll('.wcap')].map(e => e.textContent).join(',')`))
    === 'расписание,задачи,питание,привычки сегодня,заметки дня',
  await js(`[...document.querySelectorAll('.wcap')].map(e => e.textContent).join(',')`));
/*
 * Кнопок «Блок» и «Напоминание» под расписанием на компьютере больше нет:
 * пришитые снизу, они выбивались из колонки. Всё добавляется через «изменить».
 */
/*
 * Расписание выглядит одинаково любой день: карточка у каждой строки, рельс
 * с полоской между точками, место под колокольчик даже там, где его нет.
 * Раньше день с вложенными блоками был набором серых карточек, а соседний —
 * голым списком.
 */
проба('у каждой строки расписания своя карточка',
  await js(`(() => { const b = [...document.querySelectorAll('.wsched-body')];
    if (!b.length) return false;
    return b.every(x => getComputedStyle(x).backgroundColor !== 'rgba(0, 0, 0, 0)'); })()`));
проба('точки соединены полоской',
  await js(`(() => { const m = document.querySelector('.wsched-mark');
    if (!m) return false;
    const s = getComputedStyle(m, '::before');
    return s.content !== 'none' && parseFloat(s.width) > 0; })()`));
проба('колонка под колокольчик держит ширину и без напоминаний',
  await js(`(() => { const rows = [...document.querySelectorAll('.wsched-row')];
    if (rows.length < 2) return false;
    const cols = rows.map(r => getComputedStyle(r).gridTemplateColumns.split(' ').pop());
    return new Set(cols).size === 1; })()`),
  await js(`[...document.querySelectorAll('.wsched-row')].map(r => getComputedStyle(r).gridTemplateColumns.split(' ').pop()).join(' | ')`));
проба('«внутри блока» словами не пишется',
  await js(`![...document.querySelectorAll('.wsched-sub')].some(e => e.textContent.includes('внутри блока'))`));

проба('под расписанием нет пришитых кнопок добавления',
  await js(`![...document.querySelectorAll('.wadd')].some(b => b.textContent.includes('Напоминание'))`));

await nav('Настройки');
await waitFor('Boolean(document.querySelector(".wsettings"))');
await wait(700);
/*
 * Настройки — разделами. На компьютере список слева, открытый раздел справа
 * (master-detail); на телефоне — переходами. Оглавление из семи строк, выход
 * живёт внутри «Аккаунта»: выходят из аккаунта, а не из настроек.
 */
const оглавление = `[...document.querySelectorAll('.wset-cols > .wpanel-list .wrow-link, .wsettings > .wpanel-list .wrow-link')]
  .map(e => e.querySelector('span').textContent).join(',')`;
проба('в настройках семь разделов',
  (await js(оглавление)) === 'Аккаунт,Оформление,Будильник,Звуки,День и питание,Данные,Устройства',
  await js(оглавление));
проба('на компьютере раздел открыт сбоку, без перехода',
  await js(`Boolean(document.querySelector('.wset-cols .wset-detail')) && !document.querySelector('.wset-back')`));
проба('выход — внутри аккаунта',
  await js(`[...document.querySelectorAll('.wset-detail .wrow-link')]
    .some(r => r.textContent.includes('Выйти из аккаунта'))`));
await открытьРаздел('Будильник');
проба('в панели будильника сказано, что он звонит на телефоне',
  await js(`[...document.querySelectorAll('.wpanel-note')]
    .some(e => e.textContent.includes('звонит на телефоне'))`));
проба('в браузере вместо разрешений — объяснение, что они на телефоне',
  await js(`[...document.querySelectorAll('.wclock-cap')]
    .some(e => e.textContent.includes('проверяются в приложении'))`));
// описания задач видны в продвинутом режиме — включаем его
await js(`[...document.querySelectorAll('.wsegline button')].find(b => b.textContent === 'Продвинутый').click()`);
await wait(800);
проба('у задач пробуждения есть описания',
  await js(`[...document.querySelectorAll('.wrow-sw-hint')]
    .some(e => e.textContent.includes('шагомер'))`));
/*
 * Подписи сроков, а не слова: «Сразу / 15 с / 30 с / 1 мин». Слова
 * («Медленное», «Выключено») на телефоне в 360 пикселей налезали друг на
 * друга, и четыре кнопки не помещались в строку.
 */
проба('нарастание громкости настраивается сроками',
  await js(`(() => { const seg = [...document.querySelectorAll('.wsegline')]
    .find(s => s.previousElementSibling?.textContent === 'Пробуждение');
    return seg ? [...seg.children].map(b => b.textContent).join(',') : 'нет'; })()`) === 'Сразу,15 с,30 с,1 мин',
  await js(`(() => { const seg = [...document.querySelectorAll('.wsegline')]
    .find(s => s.previousElementSibling?.textContent === 'Пробуждение');
    return seg ? [...seg.children].map(b => b.textContent).join(',') : 'нет'; })()`));

/*
 * Переключатель не должен уводить экран вверх: раньше каждый щелчок
 * перерисовывал настройки с нулевой прокруткой, и до следующего пункта
 * приходилось доезжать заново. Раздел будильника в продвинутом режиме
 * длинный — прокрутке здесь есть куда сброситься.
 */
await js(`document.querySelector('.wbody').scrollTo(0, 120)`);
await wait(200);
const скроллДо = await js(`document.querySelector('.wbody').scrollTop`, true);
await js(`[...document.querySelectorAll('.wsegline button')].find(b => b.textContent === 'Сложная').click()`);
await wait(900);
const скроллПосле = await js(`document.querySelector('.wbody').scrollTop`, true);
проба('переключение не сбрасывает прокрутку',
  Number(скроллДо) > 0 && Number(скроллПосле) === Number(скроллДо),
  `${скроллДо} → ${скроллПосле}`);
await js(`[...document.querySelectorAll('.wsegline button')].find(b => b.textContent === 'Простая').click()`);
await wait(600);

await js(`[...document.querySelectorAll('.wsegline button')].find(b => b.textContent === 'Простой').click()`);
await wait(600);
await назадВОглавление();
/*
 * Крупный текст — класс, а не zoom: увеличивается только читаемое (названия,
 * заметки, подписи), кнопки и меню остаются на месте. Прежний zoom на 125 %
 * ломал телефонную раскладку и складывал почту вертикально.
 */
await открытьРаздел('Оформление');
проба('размеров текста два: 100 % и 110 %',
  (await js(`(() => { const seg = [...document.querySelectorAll('.wsegline')]
    .find(s => s.previousElementSibling?.textContent === 'Крупный текст');
    return seg ? [...seg.children].map(b => b.textContent).join(',') : 'нет'; })()`)) === '100%,110%');

await js(`[...document.querySelectorAll('.wsegline')]
  .find(s => s.previousElementSibling?.textContent === 'Крупный текст')
  .children[1].click()`);
await wait(900);
const приКрупном = await js(`(() => {
  const root = document.querySelector('.wroot');
  const r = root.getBoundingClientRect();
  const foot = document.querySelector('.wside-foot')?.getBoundingClientRect();
  return { класс: root.classList.contains('wbig'),
           увеличение: getComputedStyle(root).zoom,
           корень: Math.round(r.height), экран: innerHeight,
           низКолонкиВиден: foot ? foot.bottom <= innerHeight + 1 : null };
})()`);
проба('крупный текст — класс wbig, без zoom, раскладка цела',
  приКрупном.класс && приКрупном.увеличение === '1'
    && Math.abs(приКрупном.корень - приКрупном.экран) <= 1 && приКрупном.низКолонкиВиден,
  JSON.stringify(приКрупном));
await js(`[...document.querySelectorAll('.wsegline')]
  .find(s => s.previousElementSibling?.textContent === 'Крупный текст')
  .children[0].click()`);
await wait(700);
await назадВОглавление();

/*
 * Боковая колонка стоит на месте: она прокручивается сама, а не вместе с
 * содержимым — иначе «Помощник» и профиль уезжают под сгиб на длинном месяце.
 */
проба('боковая колонка занимает всю высоту и не уезжает',
  await js(`(() => { const s = document.querySelector('.wside'); const r = s.getBoundingClientRect();
    return getComputedStyle(s).position === 'sticky'
      && Math.abs(r.height - innerHeight) <= 1 && Math.round(r.top) === 0; })()`),
  await js(`(() => { const s = document.querySelector('.wside'); const r = s.getBoundingClientRect();
    return getComputedStyle(s).position + ' ' + Math.round(r.top) + '…' + Math.round(r.bottom)
      + ' при ' + innerHeight; })()`));

// Звук: подборка с прослушиванием, выбор сохраняет и название, и файл
await открытьРаздел('Звуки');
await js(`[...document.querySelectorAll('.wrow-link')].find(r => r.textContent.includes('Звук будильника')).click()`);
проба('шторка звука открылась',
  await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Звук будильника'`));
await wait(800);
проба('в подборке есть злые звуки — сирена на месте',
  await js(`[...document.querySelectorAll('.wmodal .wopt-title')].some(e => e.textContent === 'Сирена')`));
проба('у каждого звука есть кнопка «послушать»',
  await js(`document.querySelectorAll('.wmodal .wplay').length >= 5`));
проба('свой звук добавляется с лимитом в 10 МБ',
  await js(`document.querySelector('.wmodal .wbtn-dashed')?.textContent.includes('10 МБ')`));
await js(`[...document.querySelectorAll('.wmodal .wopt')].find(b => b.textContent.includes('Петух')).click()`);
await wait(1000);
проба('звук сохранён в профиле',
  (await js(`fetch('/api/v1/settings').then(r=>r.json()).then(s => s.settings.sound)`, true)) === 'Петух');
проба('вместе с названием сохранено имя файла для телефона',
  (await js(`fetch('/api/v1/settings').then(r=>r.json()).then(s => s.settings.soundFile)`, true)) === 'rooster.ogg');
await js(`document.querySelector('.wmodal-x').click()`);
await waitFor('!document.querySelector(".wveil")');
await назадВОглавление();

/*
 * Напоминание: повтор уходит настоящим правилом.
 *
 * Отдельной шторки у напоминания больше нет — оно заводится тем же
 * редактором строки, и проверяем именно его: одна сущность, один экран.
 */
await nav('Сейчас');
await waitFor('Boolean(document.querySelector(".wsched-row"))', 40);
await wait(600);
const правил = () => js(`fetch('/api/v1/series?templates=0').then(r=>r.json()).then(l => l.length)`, true);
const былоПравил = await правил();
// кнопок под расписанием больше нет — напоминание открывается тем же
// редактором строки, что и из шторки «изменить»
await js(`window.__wopen('reminder')`);
проба('напоминание заводится редактором строки',
  await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Новое напоминание'`));
проба('у напоминания одна плитка времени — момент длительности не имеет',
  await js(`Boolean(document.querySelector('.wmodal .wgrid1')) && !document.querySelector('.wmodal .wgrid3')`));
await js(`(() => {
  const i = document.querySelector('.wmodal .winput');
  i.value = 'День рождения Ани';
  i.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await js(`[...document.querySelectorAll('.wmodal .wchip-sheet')].find(c => c.textContent === 'Ежегодно').click()`);
await js(`document.querySelector('.wmodal .wbtn-wide').click()`);
await waitFor('!document.querySelector(".wveil")', 40);
await wait(1000);
проба('ежегодный повтор создан правилом', (await правил()) === былоПравил + 1,
  `${былоПравил} → ${await правил()}`);
проба('через год напоминание на месте',
  (await js(`fetch('/api/v1/days/${NEXT_YEAR}/full').then(r=>r.json())
    .then(d => d.schedule.some(r => r.title === 'День рождения Ани'))`, true)) === true);

/*
 * Убираем за собой. Удалить правило недостаточно: уже созданные им строки
 * от него только отвязываются и остаются в дне — за пять прогонов в
 * расписании набралось пять «Дней рождения Ани».
 */
/*
 * Удаление правила забирает и будущие строки — это проверяем заодно: если
 * после него что-то осталось, значит «убрать повтор целиком» опять ничего
 * не делает, а именно так оно себя когда-то и вело.
 */
const убрано = await js(`(async () => {
  const list = await (await fetch('/api/v1/series')).json();
  for (const r of list) await fetch('/api/v1/series/' + r.id, { method: 'DELETE' });
  const day = await (await fetch('/api/v1/days/${DAY}/full')).json();
  return day.schedule.filter(x => x.title === 'День рождения Ани').length;
})()`, true);
проба('удаление правила забирает созданную им строку', убрано === 0, `осталось ${убрано}`);
/*
 * Пауза перед проверкой не для красоты: после каждой правки сервер
 * пересчитывает уведомления, и пересчёт достраивает день повторами уже после
 * ответа. Без паузы можно прочитать состояние на середине этой работы.
 */
await wait(900);
const осталосьНапоминаний = await js(`fetch('/api/v1/days/${DAY}/full').then(r=>r.json())
  .then(d => d.schedule.filter(x => x.title === 'День рождения Ани').length)`, true);
проба('прогон убрал за собой напоминание', осталосьНапоминаний === 0,
  `осталось ${осталосьНапоминаний}`);

/*
 * Повтор в редакторе строки: три перехода, каждый из которых однажды делал не
 * то, о чём просили.
 */
const открытьСтроку = async title => {
  await js(`[...document.querySelectorAll('.wsched-row')]
    .find(r => r.textContent.includes(${JSON.stringify(title)}))?.click()`);
  return waitFor(`document.querySelector('.wmodal-hd b')`, 30);
};
const выбратьПовтор = async label => {
  await js(`(() => { const blk = [...document.querySelectorAll('.wmodal .wfield-label')]
    .find(e => e.textContent === 'повтор')?.parentElement;
    [...blk.querySelectorAll('.wchip-sheet')].find(c => c.textContent === ${JSON.stringify(label)})?.click(); })()`);
  await wait(400);
};
const строкиС = async title => js(`fetch('/api/v1/days/${DAY}/full').then(r=>r.json())
  .then(d => d.schedule.filter(x => x.title === ${JSON.stringify(title)}))`, true);

await nav('Сейчас');
await waitFor('Boolean(document.querySelector(".wsched-row"))', 40);
await wait(600);
await js(`fetch('/api/v1/days/${DAY}/schedule', { method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ startMin: 1380, endMin: null, title: 'Проба повтора',
                         kind: 'reminder', alarmMode: 'notify' }) })`, true);
await nav('Расписание'); await wait(400); await nav('Сейчас');
await waitFor(`[...document.querySelectorAll('.wsched-row')].some(r => r.textContent.includes('Проба повтора'))`, 40);

/*
 * «Разово → Ежедневно» не должно давать близнеца. Раньше строка оставалась
 * ничьей, сервер считал день недостроенным и создавал вторую такую же.
 */
await открытьСтроку('Проба повтора');
await выбратьПовтор('Ежедневно');
await js(`document.querySelector('.wmodal .wbtn-wide').click()`);
await waitFor('!document.querySelector(".wveil")', 40);
await wait(1400);
const послеПовтора = await строкиС('Проба повтора');
проба('«Разово → Ежедневно» не плодит близнеца', послеПовтора.length === 1,
  `строк ${послеПовтора.length}`);
проба('строка привязалась к повтору', Boolean(послеПовтора[0]?.series_id),
  `series_id = ${послеПовтора[0]?.series_id}`);

/*
 * «Ежедневно → Разово» должно оставить эту строку и прекратить повтор. Раньше
 * оно стирало и её: удаление правила забирало все строки от сегодняшнего дня.
 */
await открытьСтроку('Проба повтора');
await выбратьПовтор('Разово');
await js(`document.querySelector('.wmodal .wbtn-wide').click()`);
await waitFor('!document.querySelector(".wveil")', 40);
await wait(1400);
const послеРазово = await строкиС('Проба повтора');
проба('«Ежедневно → Разово» оставляет строку в дне', послеРазово.length === 1,
  `строк ${послеРазово.length}`);
проба('и снимает с неё повтор', послеРазово[0]?.series_id === null,
  `series_id = ${послеРазово[0]?.series_id}`);
проба('назавтра повтор уже не достраивает',
  (await js(`fetch('/api/v1/days/${dayIn(1)}/full').then(r=>r.json())
    .then(d => d.schedule.filter(x => x.title === 'Проба повтора').length)`, true)) === 0);

/*
 * Правка строки из чужой колонки — это правка, а не перенос. Раньше «прежним
 * днём» считался открытый, и строка среды пересоздавалась с новым номером:
 * слетала галочка, терялся повтор, рвалась связь с приёмом пищи.
 */
await nav('Расписание');
await wait(600);
await js(`[...document.querySelectorAll('.wseg button')].find(b => b.textContent === 'Неделя').click()`);
await waitFor(`[...document.querySelectorAll('.wblock-title')].some(e => e.textContent === 'Проба повтора')`, 40);
const строкаДо = (await строкиС('Проба повтора'))[0];
await js(`[...document.querySelectorAll('.wblock-title')]
  .find(e => e.textContent === 'Проба повтора')?.closest('.wblock')?.click()`);
await waitFor(`document.querySelector('.wmodal-hd b')`, 30);
await js(`(() => { const i = document.querySelector('.wmodal [name=rowNote]');
  i.value = 'правка из колонки'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await js(`document.querySelector('.wmodal .wbtn-wide').click()`);
await waitFor('!document.querySelector(".wveil")', 40);
await wait(1200);
const строкаПосле = (await строкиС('Проба повтора'))[0];
проба('правка из недельной сетки не пересоздаёт строку',
  строкаПосле?.id === строкаДо?.id && строкаПосле?.note === 'правка из колонки',
  `${строкаДо?.id} → ${строкаПосле?.id}, комментарий «${строкаПосле?.note}»`);

await js(`(async () => { const d = await (await fetch('/api/v1/days/${DAY}/full')).json();
  for (const r of d.schedule.filter(x => x.title === 'Проба повтора'))
    await fetch('/api/v1/days/${DAY}/schedule/' + r.id, { method: 'DELETE' });
  const list = await (await fetch('/api/v1/series?templates=0')).json();
  for (const r of list) await fetch('/api/v1/series/' + r.id, { method: 'DELETE' }); })()`, true);
await wait(600);
проба('прогон убрал за собой пробу повтора', (await строкиС('Проба повтора')).length === 0);

// ── Заметка: заголовок и текст ──
/*
 * На эталоне у заметки два поля. В модели это один текст дня, где первая
 * строка — заголовок; проверяем, что разделение и склейка не теряют ничего.
 */
await nav('Заметки');
await waitFor('Boolean(document.querySelector(".wnotes"))', 40);
await wait(600);
/*
 * Заметка на день одна, поэтому вторая на тот же день отклоняется с
 * объяснением, а не затирает первую молча. Проверяем сначала это, потом правку
 * существующей — так выглядит настоящий путь.
 */
await js(`[...document.querySelectorAll('.wbtn')].find(b => b.textContent.includes('Новая заметка')).click()`);
проба('шторка заметки открылась',
  await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Заметка'`));
проба('в шторке два поля: заголовок и текст',
  (await js(`Boolean(document.querySelector('.wmodal .winput')) && Boolean(document.querySelector('.wmodal .wtextarea'))`)) === true);

await js(`(() => {
  const t = document.querySelector('.wmodal .winput');
  t.value = 'Вторая на тот же день';
  t.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await js(`document.querySelector('.wmodal .wbtn-wide').click()`);
await wait(900);
проба('вторая заметка на занятый день отклонена с объяснением',
  (await js(`document.querySelector('.wmodal .wnotice')?.textContent ?? ''`)).includes('уже есть заметка'),
  await js(`document.querySelector('.wmodal .wnotice')?.textContent ?? 'нет сообщения'`));
await js(`document.querySelector('.wmodal-x').click()`);
await waitFor('!document.querySelector(".wveil")', 40);

// правим заметку этого дня — она уже есть в списке
await wait(700);
// без учёта регистра: заголовок правится прогонами, и «Сервис» бывает с большой
await js(`([...document.querySelectorAll('.wnote')]
  .find(n => n.textContent.toLowerCase().includes('сервис'))
  ?? document.querySelector('.wnote'))?.click()`);
проба('заметка дня открывается из списка',
  await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Заметка'`),
  await js(`[...document.querySelectorAll('.wnote-title')].map(e => e.textContent).join('|') || 'список пуст'`));
await js(`(() => {
  const t = document.querySelector('.wmodal .winput');
  t.value = 'Сервис ноутбука';
  t.dispatchEvent(new Event('input', { bubbles: true }));
  const b = document.querySelector('.wmodal .wtextarea');
  b.value = 'Спросить про сроки и стоимость.';
  b.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await js(`document.querySelector('.wmodal .wbtn-wide').click()`);
await waitFor('!document.querySelector(".wveil")', 40);
await wait(1000);
проба('заголовок стал первой строкой заметки дня',
  (await js(`fetch('/api/v1/days/${DAY}/full').then(r=>r.json()).then(d => d.notes)`, true))
    === 'Сервис ноутбука\nСпросить про сроки и стоимость.');

// открыть снова: поля должны разделиться обратно
await js(`document.querySelector('.wnote').click()`);
await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Заметка'`);
await wait(400);
проба('при открытии поля разделяются обратно',
  (await js(`document.querySelector('.wmodal .winput').value`)) === 'Сервис ноутбука'
  && (await js(`document.querySelector('.wmodal .wtextarea').value`)) === 'Спросить про сроки и стоимость.',
  await js(`document.querySelector('.wmodal .winput').value`));
await js(`document.querySelector('.wmodal-x').click()`);
await waitFor('!document.querySelector(".wveil")');

// ── Несколько сроков предупреждения ──
/*
 * Подпись на эталоне обещает «можно несколько». Проверяем, что чипы
 * действительно набираются и что оба срока доезжают до сервера.
 */
await nav('Расписание');
await wait(500);
// вид мог остаться месяцем от прошлых проверок — блоков в нём нет
await js(`[...document.querySelectorAll('.wseg button')].find(b => b.textContent === 'День').click()`);
await waitFor('document.querySelectorAll(".wblock").length > 0', 40);
await wait(700);
await js(`[...document.querySelectorAll('.wblock')].find(b => b.textContent.includes('Ужин и дом')).click()`);
проба('редактор строки открылся',
  await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Строка расписания'`));
проба('подпись про несколько сроков на месте',
  await js(`[...document.querySelectorAll('.wmodal .wfield-label')].some(e => e.textContent === 'предупредить · можно несколько')`));

await js(`[...document.querySelectorAll('.wmodal .wleads .wchip-sheet')].find(c => c.textContent === 'за день').click()`);
await js(`[...document.querySelectorAll('.wmodal .wleads .wchip-sheet')].find(c => c.textContent === 'за час').click()`);
проба('два срока горят одновременно',
  (await js(`document.querySelectorAll('.wmodal .wleads .wchip-sheet.on').length`)) === 2,
  `${await js(`document.querySelectorAll('.wmodal .wleads .wchip-sheet.on').length`)} горит`);
await js(`document.querySelector('.wmodal .wbtn-wide').click()`);
await waitFor('!document.querySelector(".wveil")', 40);
await wait(1000);

const сроки = await js(`fetch('/api/v1/days/${DAY}/full').then(r=>r.json())
  .then(d => { const r = d.schedule.find(x => x.title === 'Ужин и дом');
    return { list: r.remind_before_json, first: r.remind_before_min }; })`, true);
проба('оба срока записаны, первым самый ранний',
  сроки.list === '[1440,60]' && сроки.first === 1440, JSON.stringify(сроки));

// возвращаем как было
await js(`(async () => {
  const day = await (await fetch('/api/v1/days/${DAY}/full')).json();
  const r = day.schedule.find(x => x.title === 'Ужин и дом');
  await fetch('/api/v1/days/${DAY}/schedule/' + r.id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remindBefore: [0] }),
  });
})()`, true);

/*
 * «Длится» — это длительность.
 *
 * Раньше плитка «длится» открывала ту же сетку часов, что «начало», и нажатие
 * на час меняло начало: выбрать длительность было нечем. Человек поймал это
 * руками, поэтому проверяем именно то, что он делал.
 */
await js(`[...document.querySelectorAll('.wblock')].find(b => b.textContent.includes('Зарядка')).click()`);
await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Строка расписания'`);
const плитки = () => js(`[...document.querySelectorAll('.wmodal .wtile')].map(t =>
  t.querySelector('.wtile-cap').textContent + '=' + t.querySelector('input').value).join(' ')`);
const доПравки = await плитки();
проба('три плитки времени на месте', /начало=.* длится=.* конец=/.test(доПравки), доПравки);

await js(`[...document.querySelectorAll('.wmodal .wtile')].find(t => t.textContent.includes('длится')).click()`);
проба('«длится» открывает длительности, а не часы',
  (await js(`Boolean([...document.querySelectorAll('.wmodal .wchip-dur')].length)`))
  && !(await js(`Boolean(document.querySelector('.wmodal .wclock-grid'))`)));

await js(`[...document.querySelectorAll('.wmodal .wchip-dur')].find(c => c.textContent === '45 мин').click()`);
const послеПравки = await плитки();
проба('выбор длительности меняет конец, а не начало',
  послеПравки.includes('длится=45 мин') && послеПравки.split(' ')[0] === доПравки.split(' ')[0],
  послеПравки);

await js(`[...document.querySelectorAll('.wmodal .wtile')].find(t => t.textContent.includes('начало')).click()`);
await js(`[...document.querySelectorAll('.wmodal .wclock-grid')][0].querySelectorAll('button')[9].click()`);
const послеНачала = await плитки();
проба('правка начала двигает конец, длительность держится',
  послеНачала.includes('начало=09:') && послеНачала.includes('длится=45 мин'), послеНачала);

// цвет блока: выбор есть и он запоминается
проба('в редакторе есть выбор цвета',
  (await js(`document.querySelectorAll('.wmodal .wpaint').length`)) === 5,
  `${await js(`document.querySelectorAll('.wmodal .wpaint').length`)}`);
await js(`document.querySelectorAll('.wmodal .wpaint')[3].click()`);
проба('цвет отметился', await js(`document.querySelectorAll('.wmodal .wpaint.on').length === 1
  && !document.querySelectorAll('.wmodal .wpaint')[0].classList.contains('on')`));
await js(`document.querySelector('.wmodal .wbtn-wide').click()`);
await waitFor('!document.querySelector(".wveil")', 40);
await wait(1200);

/*
 * Цвет доезжает до экрана, а не только до базы.
 *
 * Пользовательские свойства нельзя присвоить объектом стилей — присваивание
 * проходит впустую. Цвет лежал в базе, горел в редакторе, а блок оставался
 * цветом приложения; проверка «чип отметился» этого не видела.
 */
const цветБлока = await js(`(() => {
  const b = [...document.querySelectorAll('.wblock')].find(x => x.textContent.includes('Зарядка'));
  return b ? getComputedStyle(b).getPropertyValue('--pin').trim() : 'блока нет';
})()`);
проба('цвет блока виден на экране', /^#|rgb/.test(цветБлока), цветБлока);
const цветВБазе = await js(`fetch('/api/v1/days/${DAY}/full').then(r=>r.json())
  .then(d => d.schedule.find(x => x.title.includes('Зарядка'))?.color ?? 'нет')`, true);
проба('цвет сохранён на сервере', цветВБазе === 'green', String(цветВБазе));
// возвращаем как было
await js(`(async () => {
  const d = await (await fetch('/api/v1/days/${DAY}/full')).json();
  const r = d.schedule.find(x => x.title.includes('Зарядка'));
  if (r) await fetch('/api/v1/days/${DAY}/schedule/' + r.id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ color: null, startMin: 430, endMin: 470 }),
  });
})()`, true);

/*
 * Пересечение: конец, залезающий на соседний блок, должен предложить три
 * способа разойтись — и ничего не двигать до выбора.
 */
// «Обед» 13:00–13:30, за ним «Работа: второй блок» 13:30–17:00 — конец в 14:30 режет его
await js(`[...document.querySelectorAll('.wblock')].find(b => b.textContent.includes('Обед')).click()`);
await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Строка расписания'`);
await js(`[...document.querySelectorAll('.wmodal .wtile')].find(t => t.textContent.includes('конец')).click()`);
await js(`[...document.querySelectorAll('.wmodal .wclock-grid')][0].querySelectorAll('button')[14].click()`);
await wait(300);
проба('пересечение показано и предложены способы',
  (await js(`Boolean(document.querySelector('.wmodal .wconflict'))`))
  && (await js(`document.querySelectorAll('.wmodal .wconflict .wopt').length`)) >= 2,
  await js(`document.querySelector('.wmodal .wconflict-hd')?.textContent ?? 'нет'`));
await js(`document.querySelector('.wmodal-x').click()`);
await waitFor('!document.querySelector(".wveil")', 40);

/*
 * Комментарий к активности: сохраняется и виден в самом блоке. Иначе он
 * превращается в тайник — человек не узнает, что там что-то написано.
 */
await js(`[...document.querySelectorAll('.wblock')].find(b => b.textContent.includes('Работа: второй')).click()`);
await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Строка расписания'`);
проба('в редакторе есть поле комментария',
  await js(`Boolean(document.querySelector('.wmodal textarea[name=rowNote]'))`));
await js(`(() => { const t = document.querySelector('.wmodal textarea[name=rowNote]');
  t.value = 'Взять ноутбук и наушники'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await js(`document.querySelector('.wmodal .wbtn-wide').click()`);
await waitFor('!document.querySelector(".wveil")', 40);
await wait(1200);

const коммент = await js(`fetch('/api/v1/days/${DAY}/full').then(r=>r.json())
  .then(d => d.schedule.find(x => x.title.includes('Работа: второй'))?.note ?? '')`, true);
проба('комментарий сохранён на сервере', коммент === 'Взять ноутбук и наушники', коммент || 'пусто');
проба('комментарий виден в блоке расписания',
  await js(`[...document.querySelectorAll('.wblock-note')].some(e => e.textContent.includes('наушники'))`),
  await js(`[...document.querySelectorAll('.wblock-note')].map(e => e.textContent).join('|') || 'нет'`));

/* Окно питания встаёт в расписание окном, а не точкой в его начале. */
await nav('Сейчас');
await waitFor('Boolean(document.querySelector(".wfood"))');
await wait(700);
await js(`[...document.querySelectorAll('.wadd')].find(b => b.textContent.includes('приём пищи')).click()`);
await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Приём пищи'`);
await js(`(() => { const i = document.querySelector('.wmodal .winput');
  i.value = 'Обед окном в сетке'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await js(`[...document.querySelectorAll('.wmodal .wopt')].find(o => o.textContent.includes('Окно')).click()`);
await wait(300);
проба('у окна тоже есть «Добавить в расписание»',
  await js(`Boolean(document.querySelector('.wmodal .wtoggle-card'))`));
проба('подпись называет весь промежуток',
  /займёт \d\d:\d\d–\d\d:\d\d/.test(await js(`document.querySelector('.wmodal .wrow-sw-hint')?.textContent ?? ''`)),
  await js(`document.querySelector('.wmodal .wrow-sw-hint')?.textContent ?? 'нет'`));

/*
 * Промежуток у приёма пищи задаётся теми же тремя плитками, что и у строки
 * расписания: готовка бывает дольше еды, а привыкать к двум разным способам
 * задать время человек не должен.
 */
проба('у приёма пищи те же плитки, что и у строки: день и промежуток',
  (await js(`[...document.querySelectorAll('.wmodal .wtile .wtile-cap')].map(e => e.textContent).join(' · ')`))
    === 'день · начало · длится · конец',
  await js(`[...document.querySelectorAll('.wmodal .wtile .wtile-cap')].map(e => e.textContent).join(' · ')`));
await js(`[...document.querySelectorAll('.wmodal .wtile')].find(t => t.textContent.includes('день')).click()`);
проба('клик по дню приёма пищи открывает календарь',
  await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Выбор дня'`));
await js(`document.querySelector('.wmodal .wcal-day.today').click()`);
await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Приём пищи'`);
await wait(300);
await js(`[...document.querySelectorAll('.wmodal .wtile')].find(t => t.textContent.includes('длится')).click()`);
await wait(300);
проба('«длится» открывает длительности, а не часы',
  await js(`Boolean(document.querySelector('.wmodal [name=mealEndDur]'))`));
проба('длительность задаётся своим числом минут — хоть 100',
  await js(`(() => { const i = document.querySelector('.wmodal [name=mealEndDur]');
    i.value = '100'; i.dispatchEvent(new Event('input', { bubbles: true }));
    return [...document.querySelectorAll('.wmodal .wtile')]
      .find(t => t.textContent.includes('длится')).querySelector('input').value; })()`) === '1 ч 40 мин');
// возвращаем окно к 12:00–14:00, дальше проверка ждёт именно эти времена
await js(`(() => { const i = document.querySelector('.wmodal [name=mealEndDur]');
  i.value = '120'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await js(`document.querySelector('.wmodal .wtoggle-card').click()`);
await js(`document.querySelector('.wmodal .wbtn-wide').click()`);
await waitFor('!document.querySelector(".wveil")', 40);
await wait(1400);

const окно = await js(`fetch('/api/v1/days/${DAY}/full').then(r=>r.json()).then(d => {
  const m = d.meals.find(x => x.title === 'Обед окном в сетке');
  const row = d.schedule.find(x => x.title === 'Обед окном в сетке');
  return { связан: Boolean(m && m.schedule_item_id), начало: row?.start_min ?? null, конец: row?.end_min ?? null };
})`, true);
проба('окно встало в расписание своим временем',
  окно.связан && окно.начало === 720 && окно.конец === 840, JSON.stringify(окно));

// убираем за собой
await js(`(async () => {
  const d = await (await fetch('/api/v1/days/${DAY}/full')).json();
  const m = d.meals.find(x => x.title === 'Обед окном в сетке');
  const row = d.schedule.find(x => x.title === 'Обед окном в сетке');
  if (row) await fetch('/api/v1/days/${DAY}/schedule/' + row.id, { method: 'DELETE' });
  if (m) await fetch('/api/v1/days/${DAY}/meals/' + m.id, { method: 'DELETE' });
  const r2 = d.schedule.find(x => x.title.includes('Работа: второй'));
  if (r2) await fetch('/api/v1/days/${DAY}/schedule/' + r2.id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: '' }) });
})()`, true);

/*
 * Напоминание в недельной сетке — обычный блок с точкой, а не наклейка
 * поверх соседей.
 *
 * Раньше момент рисовался отдельным слоем поверх колонки: он ложился на
 * блок, под которым стоял, и того просто не было видно. Ставим напоминание
 * внутрь рабочего блока и смотрим, что прямоугольники не налезают.
 */
const внутри = await js(`(async () => {
  const d = await (await fetch('/api/v1/days/${DAY}/full')).json();
  // самый длинный блок дня: в его середине точно есть место для момента
  const host = d.schedule.filter(x => x.end_min !== null)
    .sort((a, b) => (b.end_min - b.start_min) - (a.end_min - a.start_min))[0];
  if (!host) return 'блоков в дне нет';
  const at = Math.round((host.start_min + host.end_min) / 2);
  await fetch('/api/v1/days/${DAY}/schedule', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startMin: at, endMin: null, title: 'Точка внутри блока',
                           kind: 'reminder', alarmMode: 'notify' }) });
  return host.title;
})()`, true);
console.log('    напоминание поставлено внутрь блока:', внутри);
await nav('Расписание');
await wait(600);
await js(`[...document.querySelectorAll('.wseg button')].find(b => b.textContent === 'Неделя')?.click()`);
await waitFor(`[...document.querySelectorAll('.wblock-title')].some(e => e.textContent === 'Точка внутри блока')`, 40);
await wait(500);

проба('в неделе напоминание нарисовано блоком с точкой',
  await js(`(() => { const t = [...document.querySelectorAll('.wblock-title')]
    .find(e => e.textContent === 'Точка внутри блока');
    const b = t?.closest('.wblock');
    return Boolean(b && b.classList.contains('moment') && b.querySelector('.wblock-dot')); })()`));
/*
 * Проверяем не отсутствие старого класса — такая проба сторожила бы пустоту, —
 * а то, что момент стоит в общей дорожке: у него есть сосед по колонке и
 * ненулевая ширина, полученная от раскладки.
 */
проба('момент стоит в дорожке, а не отдельным слоем',
  await js(`(() => { const t = [...document.querySelectorAll('.wblock-title')]
    .find(e => e.textContent === 'Точка внутри блока');
    const b = t?.closest('.wblock'); if (!b) return false;
    const s = getComputedStyle(b);
    return s.position === 'absolute' && b.getBoundingClientRect().width > 8; })()`));

const налезание = await js(`(() => {
  const t = [...document.querySelectorAll('.wblock-title')].find(e => e.textContent === 'Точка внутри блока');
  const me = t?.closest('.wblock');
  if (!me) return 'блока нет';
  const a = me.getBoundingClientRect();
  const col = me.parentElement;
  const плохие = [...col.querySelectorAll('.wblock')].filter(o => o !== me).filter(o => {
    const b = o.getBoundingClientRect();
    // перекрываются и по времени, и по ширине — значит один закрывает другой
    return a.top < b.bottom && b.top < a.bottom && a.left < b.right - 1 && b.left < a.right - 1;
  });
  return плохие.map(o => o.querySelector('.wblock-title')?.textContent).join('|');
})()`);
проба('напоминание не закрывает соседний блок', налезание === '', `налезает на: ${налезание}`);
проба('сосед под напоминанием остался виден',
  (await js(`(() => { const t = [...document.querySelectorAll('.wblock-title')]
    .find(e => e.textContent === 'Точка внутри блока');
    const col = t?.closest('.wblock')?.parentElement;
    return col ? col.querySelectorAll('.wblock').length : 0; })()`)) > 1);

await js(`(async () => { const d = await (await fetch('/api/v1/days/${DAY}/full')).json();
  for (const r of d.schedule.filter(x => x.title === 'Точка внутри блока'))
    await fetch('/api/v1/days/${DAY}/schedule/' + r.id, { method: 'DELETE' }); })()`, true);

/* Месяц: «+ ещё N» когда строк больше, чем влезает, и добавление по клику. */
await js(`[...document.querySelectorAll('.wseg button')].find(b => b.textContent === 'Месяц').click()`);
await waitFor('document.querySelectorAll(".wcell").length === 42', 40);
await wait(900);
проба('в месяце сказано, сколько строк не влезло',
  await js(`[...document.querySelectorAll('.wcell-more')].some(e => /\\+ ещё \\d+/.test(e.textContent))`),
  await js(`[...document.querySelectorAll('.wcell-more')].map(e => e.textContent).join('|') || 'нет'`));

await js(`[...document.querySelectorAll('.wcell:not(.out)')].find(c => !c.querySelector('.wcell-item')).click()`);
проба('клик по пустому месту в месяце открывает новый блок',
  await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Новый блок'`));
проба('в новом блоке можно выбрать напоминание вместо блока',
  await js(`[...document.querySelectorAll('.wmodal .wchip-sheet')].some(c => c.textContent === 'Напоминание')`));
await js(`document.querySelector('.wmodal-x').click()`);
await waitFor('!document.querySelector(".wveil")', 40);

/* Календарь: выбор дня из шапки и листание месяцев. */
await js(`[...document.querySelectorAll('.wtop .wbtn-ghost')].find(b => b.textContent.includes('Календарь')).click()`);
проба('календарь открылся',
  await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Выбор дня'`));
const месяцДо = await js(`document.querySelector('.wcal-title').textContent`);
await js(`document.querySelectorAll('.wmodal .wsq')[1].click()`);
проба('календарь листает месяцы',
  (await js(`document.querySelector('.wcal-title').textContent`)) !== месяцДо,
  `${месяцДо} → ${await js(`document.querySelector('.wcal-title').textContent`)}`);
await js(`document.querySelector('.wmodal-x').click()`);
await waitFor('!document.querySelector(".wveil")', 40);

/* Стрелки листают выбранный период, а не всегда день. */
await js(`[...document.querySelectorAll('.wseg button')].find(b => b.textContent === 'Месяц').click()`);
await wait(600);
const шапкаДо = await js(`document.querySelector('.wtop-num').textContent`);
await js(`document.querySelectorAll('.wtop-nav .wsq')[1].click()`);
await wait(900);
const шапкаПосле = await js(`document.querySelector('.wtop-num').textContent`);
проба('на месяце стрелка листает месяц', шапкаДо !== шапкаПосле, `${шапкаДо} → ${шапкаПосле}`);
проба('в шапке месяца написан месяц, а не число', /^[а-я]+ \d{4}$/.test(шапкаПосле), шапкаПосле);

/*
 * Кнопки в шапке не ездят при смене вида. Подпись меняется вместе с ним —
 * «6 августа», «3–9 августа», «август 2026», — и всё, что правее, съезжало:
 * человек целился в «Сегодня» и попадал в «Календарь».
 */
const где = () => js(`(() => {
  const b = [...document.querySelectorAll('.wtop-nav .wchip')].find(c => c.textContent === 'Сегодня');
  return b ? Math.round(b.getBoundingClientRect().left) : -1;
})()`);
const места = [];
for (const вид of ['День', 'Неделя', 'Месяц']) {
  await js(`[...document.querySelectorAll('.wseg button')].find(b => b.textContent === '${вид}').click()`);
  await wait(700);
  места.push(await где());
}
проба('кнопка «Сегодня» стоит на месте во всех видах',
  места.every(x => x === места[0] && x > 0), места.join(' / '));

/*
 * Возвращаемся на сегодня. Иначе всё, что проверки создают дальше, ложится в
 * пролистанный месяц — и следующий прогон видит это в клетках чужого месяца.
 * Один раз уже поймались: приём пищи создавался пятого сентября.
 */
await js(`[...document.querySelectorAll('.wtop-nav .wchip')].find(c => c.textContent === 'Сегодня').click()`);
await wait(900);
await js(`[...document.querySelectorAll('.wseg button')].find(b => b.textContent === 'День').click()`);
await wait(700);
проба('«Сегодня» возвращает на сегодняшний день',
  (await js(`document.querySelector('.wtop-num').textContent`)) === DAY_LABEL,
  await js(`document.querySelector('.wtop-num').textContent`));

/*
 * Питание: окно и точное время — это разные вещи, и «Добавить в расписание»
 * должен действительно добавлять блок. Раньше он был нарисован и молчал.
 */
await nav('Сейчас');
await waitFor('Boolean(document.querySelector(".wfood"))');
await wait(600);
await js(`[...document.querySelectorAll('.wadd')].find(b => b.textContent.includes('приём пищи')).click()`);
проба('шторка приёма пищи открылась',
  await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Приём пищи'`));
await js(`(() => { const i = document.querySelector('.wmodal .winput');
  i.value = 'Обед проверкой'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await js(`[...document.querySelectorAll('.wmodal .wopt')].find(o => o.textContent.includes('Окно')).click()`);
проба('у окна день, три плитки времени и подпись про рамку',
  (await js(`document.querySelectorAll('.wmodal .wtile').length`)) === 4
  && (await js(`[...document.querySelectorAll('.wmodal .wclock-cap')].some(e => e.textContent.includes('внутри окна'))`)));
await js(`[...document.querySelectorAll('.wmodal .wopt')].find(o => o.textContent.includes('Точное время')).click()`);
проба('у точного времени тот же диапазон и переключатель расписания',
  (await js(`document.querySelectorAll('.wmodal .wtile').length`)) === 4
  && (await js(`Boolean(document.querySelector('.wmodal .wtoggle-card'))`)));
await js(`document.querySelector('.wmodal .wtoggle-card').click()`);
await js(`document.querySelector('.wmodal .wbtn-wide').click()`);
await wait(1500);
const отказПитания = await js(`document.querySelector('.wnotice')?.textContent ?? ''`);
if (отказПитания) console.log('    отказ:', отказПитания);
await waitFor('!document.querySelector(".wveil")', 40);
await wait(600);
const питание = await js(`fetch('/api/v1/days/${DAY}/full').then(r=>r.json()).then(d => {
  const m = d.meals.find(x => x.title === 'Обед проверкой');
  const row = d.schedule.find(x => x.title === 'Обед проверкой');
  return { есть: Boolean(m), связан: Boolean(m && m.schedule_item_id), блок: Boolean(row),
           окно: m ? m.end_min : null };
})`, true);
проба('приём пищи сохранён и появился блоком в расписании',
  питание.есть && питание.блок && питание.связан, JSON.stringify(питание));

// убираем за собой
await js(`(async () => {
  const d = await (await fetch('/api/v1/days/${DAY}/full')).json();
  const m = d.meals.find(x => x.title === 'Обед проверкой');
  const row = d.schedule.find(x => x.title === 'Обед проверкой');
  if (row) await fetch('/api/v1/days/${DAY}/schedule/' + row.id, { method: 'DELETE' });
  if (m) await fetch('/api/v1/days/${DAY}/meals/' + m.id, { method: 'DELETE' });
})()`, true);
const питаниеУбрано = await js(`fetch('/api/v1/days/${DAY}/full').then(r=>r.json())
  .then(d => d.meals.filter(x => x.title === 'Обед проверкой').length
    + d.schedule.filter(x => x.title === 'Обед проверкой').length)`, true);
проба('прогон убрал за собой приём пищи и его блок', питаниеУбрано === 0, `осталось ${питаниеУбрано}`);

/* Привычка: значок, тип и график — и правка существующей, а не только создание. */
await nav('Привычки');
await waitFor('Boolean(document.querySelector(".whabits"))');
await wait(600);
await js(`document.querySelector('.whabit-more').click()`);
// заголовок честный: у существующей — «Привычка», «Новая» только у новой
проба('правка привычки открывается из карточки',
  await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Привычка'`),
  await js(`document.querySelector('.wmodal-hd b')?.textContent ?? 'шторка не открылась'`));
проба('в шторке привычки есть плюсик на все смайлики',
  await js(`Boolean(document.querySelector('.wmodal .wemoji-more'))`));
проба('график — выбор между днями недели и разами в неделю',
  await js(`[...document.querySelectorAll('.wmodal .wchip-sheet')].some(c => c.textContent === 'Сколько раз в неделю')`));
await js(`[...document.querySelectorAll('.wmodal .wchip-sheet')].find(c => c.textContent === 'Сколько раз в неделю').click()`);
проба('свободный график показывает число раз, а не дни недели',
  (await js(`Boolean(document.querySelector('.wmodal input[name=habitTimes]'))`))
  && !(await js(`Boolean(document.querySelector('.wmodal .wdays7'))`)));
await js(`document.querySelector('.wmodal-x').click()`);
await waitFor('!document.querySelector(".wveil")', 40);

/* Заметка без даты — настоящая: она сохраняется и видна в фильтре «Без даты». */
await nav('Заметки');
await waitFor('Boolean(document.querySelector(".wnotes"))');
await wait(600);
await js(`[...document.querySelectorAll('.wbtn')].find(b => b.textContent.includes('Новая заметка')).click()`);
await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Заметка'`);
await js(`(() => { const i = document.querySelector('.wmodal input[name=noteTitle]');
  i.value = 'Книги на осень'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await js(`[...document.querySelectorAll('.wmodal .wchip-sheet')].find(c => c.textContent === 'Просто заметка').click()`);
await js(`(() => { const t = document.querySelector('.wmodal textarea');
  t.value = 'Без привязки к дню'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await js(`document.querySelector('.wmodal .wbtn-wide').click()`);
await waitFor('!document.querySelector(".wveil")', 40);
await wait(1200);
const безДаты = await js(`fetch('/api/v1/notes').then(r=>r.json())
  .then(l => l.filter(n => !n.date && n.title === 'Книги на осень').length)`, true);
проба('заметка без даты сохранена как заметка без даты', безДаты === 1, `нашлось ${безДаты}`);

await js(`[...document.querySelectorAll('.wchip')].find(c => c.textContent === 'Без даты').click()`);
await wait(500);
проба('фильтр «Без даты» её показывает',
  await js(`[...document.querySelectorAll('.wnote-title')].some(e => e.textContent === 'Книги на осень')`));

// убираем за собой
await js(`(async () => {
  const list = await (await fetch('/api/v1/notes')).json();
  for (const n of list.filter(x => !x.date && x.title === 'Книги на осень')) {
    await fetch('/api/v1/notes/' + n.id, { method: 'DELETE' });
  }
})()`, true);
проба('прогон убрал за собой заметку без даты',
  (await js(`fetch('/api/v1/notes').then(r=>r.json())
    .then(l => l.filter(n => !n.date && n.title === 'Книги на осень').length)`, true)) === 0);

/* Настройки пользователя: имя правится и доезжает до профиля. */
await nav('Настройки');
await waitFor('Boolean(document.querySelector(".wsettings"))');
await wait(600);
await открытьРаздел('Аккаунт');
await js(`[...document.querySelectorAll('.wrow-link')]
  .find(r => r.querySelector('span')?.textContent === 'Имя').click()`);
проба('шторка аккаунта открылась',
  await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Аккаунт'`));
await js(`(() => { const i = document.querySelector('.wmodal input[name=accName]');
  i.value = 'Проверка имени'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await js(`[...document.querySelectorAll('.wmodal .wbtn-wide')].find(b => b.textContent.includes('имя')).click()`);
await wait(1200);
проба('имя сохранено в профиле',
  (await js(`fetch('/api/v1/settings').then(r=>r.json()).then(s => s.displayName)`, true)) === 'Проверка имени');
await js(`fetch('/api/v1/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ displayName: '' }) })`, true);

/*
 * Токен для интеграций живёт в той же шторке, внизу. Секрет показывается один
 * раз: сервер хранит только хеш, и «показать ещё раз» невозможно даже ему.
 */
await js(`(async () => { const list = await (await fetch('/api/v1/tokens')).json();
  for (const t of list) await fetch('/api/v1/tokens/' + t.id, { method: 'DELETE' }); })()`, true);
await js(`document.querySelector('.wmodal-x')?.click()`);
await waitFor('!document.querySelector(".wveil")');
await js(`[...document.querySelectorAll('.wrow-link')]
  .find(r => r.querySelector('span')?.textContent === 'Имя').click()`);
await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Аккаунт'`);
await wait(900);

проба('без токена шторка предлагает его выпустить',
  await js(`[...document.querySelectorAll('.wmodal .wtoken button')].some(b => b.textContent.includes('Выпустить'))`),
  await js(`[...document.querySelectorAll('.wmodal .wtoken button')].map(b => b.textContent).join(' | ') || 'блока нет'`));

await js(`[...document.querySelectorAll('.wmodal .wtoken button')].find(b => b.textContent.includes('Выпустить')).click()`);
await waitFor(`Boolean(document.querySelector('.wmodal [name=tokenValue]'))`, 40);
const секрет = await js(`document.querySelector('.wmodal [name=tokenValue]')?.value ?? ''`);
проба('секрет показан целиком и один раз', /^nd_[a-z0-9]+_.+/.test(секрет),
  секрет ? `${секрет.slice(0, 12)}…` : 'пусто');
проба('рядом сказано, что второй раз он не покажется',
  await js(`Boolean(document.querySelector('.wmodal .wtoken-warn'))`));
проба('токен появился в списке аккаунта',
  (await js(`fetch('/api/v1/tokens').then(r=>r.json()).then(l => l.length)`, true)) === 1);

/*
 * Токен должен работать как ключ: тем же запросом, но без cookie. Проверяем
 * из отдельного контекста, чтобы браузерная сессия не подменяла собой доступ.
 */
const поТокену = await js(`fetch('/api/v1/days/${DAY}/full', {
  headers: { Authorization: 'Bearer ${секрет}' }, credentials: 'omit',
}).then(r => r.status)`, true);
проба('по токену день читается', поТокену === 200, `ответ ${поТокену}`);

// Перевыпуск: старый перестаёт действовать, новый приходит другим
await js(`[...document.querySelectorAll('.wmodal .wtoken button')].find(b => b.textContent.includes('Перевыпустить')).click()`);
await wait(1600);
const второй = await js(`document.querySelector('.wmodal [name=tokenValue]')?.value ?? ''`);
проба('перевыпуск даёт другой токен', второй && второй !== секрет, `${второй.slice(0, 12)}…`);
проба('токен остаётся один', (await js(`fetch('/api/v1/tokens').then(r=>r.json()).then(l => l.length)`, true)) === 1);
const старый = await js(`fetch('/api/v1/days/${DAY}/full', {
  headers: { Authorization: 'Bearer ${секрет}' }, credentials: 'omit',
}).then(r => r.status)`, true);
проба('старый токен больше не действует', старый === 401, `ответ ${старый}`);

await js(`[...document.querySelectorAll('.wmodal .wtoken button')].find(b => b.textContent === 'Удалить').click()`);
await wait(1400);
проба('удаление убирает токен', (await js(`fetch('/api/v1/tokens').then(r=>r.json()).then(l => l.length)`, true)) === 0);

/* Машинное описание API отдаётся и покрывает все настоящие пути. */
const спека = await js(`fetch('/api/v1/openapi.json').then(r=>r.json())`, true);
проба('openapi.json отдаётся и назван', спека?.info?.title === 'NewDay API');
проба('в описании есть путь токенов и путь привязки к повтору',
  Boolean(спека?.paths?.['/tokens']) && Boolean(спека?.paths?.['/days/{date}/schedule/{id}/series']));
проба('в описании больше шестидесяти путей',
  Object.keys(спека?.paths ?? {}).length >= 60, `${Object.keys(спека?.paths ?? {}).length}`);

console.log('\n── Итог ──');
const плохо = пробы.filter(([, ok]) => !ok).length;
console.log(`${пробы.length - плохо} из ${пробы.length}`);

ws.close(); proc.kill();
await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(плохо ? 1 : 0);
