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

/** День, который засеян на стенде. */
const DAY = '2026-08-05';

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
  (await js(`document.querySelector('.wtop-num').textContent`)) === '5 августа',
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

// ── Создание блока протягиванием ──
await nav("Расписание");
проба('сетка недели загрузилась', await waitFor('document.querySelectorAll(".wplan-col").length === 7'));
await wait(600);

const geom = await js(`(() => {
  const col = document.querySelectorAll('.wplan-col')[2];
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
проба('чужой месяц не показывает дела этого',
  await js(`[...document.querySelectorAll('.wcell.out')].every(c => !c.querySelector('.wcell-item'))`));
await shot('web-live-month');

// ── Настройки сохраняются ──
await nav("Настройки");
await wait(500);
await js(`document.querySelectorAll('.wswatch')[2].click()`);
await wait(900);
const accent = await js(`fetch('/api/v1/settings').then(r=>r.json()).then(s => s.settings.accent)`, true);
проба('акцент сохранён в профиле', accent === 'green', String(accent));

// База между прогонами живёт, поэтому проверяем не значение, а что оно
// изменилось: иначе второй прогон падал бы на том же переключателе
const flagBefore = await js(`fetch('/api/v1/settings').then(r=>r.json()).then(s => Boolean(s.settings.carryOver))`, true);
await js(`document.querySelectorAll('.wrow-sw')[0].click()`);
await wait(900);
const flag = await js(`fetch('/api/v1/settings').then(r=>r.json()).then(s => Boolean(s.settings.carryOver))`, true);
проба('переключатель дня сохранён', flag === !flagBefore, `${flagBefore} → ${flag}`);
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
проба('на «Сейчас» пять разделов эталона и ни одного лишнего',
  (await js(`[...document.querySelectorAll('.wcap')].map(e => e.textContent).join(',')`))
    === 'расписание,задачи,питание,привычки сегодня,напоминания,заметки дня',
  await js(`[...document.querySelectorAll('.wcap')].map(e => e.textContent).join(',')`));

await nav('Настройки');
await waitFor('Boolean(document.querySelector(".wsettings"))');
await wait(700);
/*
 * Панелей пять: четыре эталонных плюс «аккаунт». В эталоне веб-версии её нет,
 * но она есть в описании функционала, и без неё имя и пароль поменять нечем.
 */
проба('в настройках пять панелей: аккаунт и четыре эталонных',
  (await js(`[...document.querySelectorAll('.wsettings .wcap')].map(e => e.textContent).join(',')`))
    === 'аккаунт,оформление,день и питание,звуки и данные,устройства',
  await js(`[...document.querySelectorAll('.wsettings .wcap')].map(e => e.textContent).join(',')`));
const строкиДанных = `(() => {
  const panel = [...document.querySelectorAll('.wsettings .wpanel-list')]
    .find(p => p.querySelector('.wcap')?.textContent === 'звуки и данные');
  return panel ? panel.querySelectorAll('.wrow-link').length : -1;
})()`;
проба('в «звуках и данных» пять строк',
  (await js(строкиДанных)) === 5, `${await js(строкиДанных)}`);

// Звук: выбор сохраняется в настройках человека
await js(`[...document.querySelectorAll('.wrow-link')].find(r => r.textContent.includes('Звук будильника')).click()`);
проба('шторка звука открылась',
  await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Звук будильника'`));
await js(`[...document.querySelectorAll('.wmodal .wopt')].find(b => b.textContent.includes('Колокол')).click()`);
await wait(1000);
проба('звук сохранён в профиле',
  (await js(`fetch('/api/v1/settings').then(r=>r.json()).then(s => s.settings.sound)`, true)) === 'Колокол');
await js(`document.querySelector('.wmodal-x').click()`);
await waitFor('!document.querySelector(".wveil")');

// Напоминание: повтор уходит настоящим правилом
await nav('Сейчас');
await waitFor('Boolean(document.querySelector(".wrem"))', 40);
await wait(600);
const правил = () => js(`fetch('/api/v1/series?templates=0').then(r=>r.json()).then(l => l.length)`, true);
const былоПравил = await правил();
await js(`[...document.querySelectorAll('.wadd')].find(b => b.textContent.includes('Напоминание')).click()`);
проба('шторка напоминания открылась',
  await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Напоминание'`));
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
  (await js(`fetch('/api/v1/days/2027-08-05/full').then(r=>r.json())
    .then(d => d.schedule.some(r => r.title === 'День рождения Ани'))`, true)) === true);

/*
 * Убираем за собой. Удалить правило недостаточно: уже созданные им строки
 * от него только отвязываются и остаются в дне — за пять прогонов в
 * расписании набралось пять «Дней рождения Ани».
 */
await js(`(async () => {
  const list = await (await fetch('/api/v1/series?templates=0')).json();
  for (const r of list) await fetch('/api/v1/series/' + r.id, { method: 'DELETE' });
  const day = await (await fetch('/api/v1/days/${DAY}/full')).json();
  for (const r of day.schedule.filter(x => x.title === 'День рождения Ани')) {
    await fetch('/api/v1/days/${DAY}/schedule/' + r.id, { method: 'DELETE' });
  }
})()`, true);
проба('прогон убрал за собой напоминание',
  (await js(`fetch('/api/v1/days/${DAY}/full').then(r=>r.json())
    .then(d => d.schedule.filter(x => x.title === 'День рождения Ани').length)`, true)) === 0);

// ── Заметка: заголовок и текст ──
/*
 * На эталоне у заметки два поля. В модели это один текст дня, где первая
 * строка — заголовок; проверяем, что разделение и склейка не теряют ничего.
 */
await nav('Заметки');
await waitFor('Boolean(document.querySelector(".wnotes"))', 40);
await wait(600);
await js(`[...document.querySelectorAll('.wbtn')].find(b => b.textContent.includes('Новая заметка')).click()`);
проба('шторка заметки открылась',
  await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Заметка'`));
проба('в шторке два поля: заголовок и текст',
  (await js(`Boolean(document.querySelector('.wmodal .winput')) && Boolean(document.querySelector('.wmodal .wtextarea'))`)) === true);

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
await js(`document.querySelector('.wmodal-x').click()`);
await waitFor('!document.querySelector(".wveil")', 40);

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
await js(`document.querySelectorAll('.wtop-strip .wsq')[1].click()`);
await wait(900);
const шапкаПосле = await js(`document.querySelector('.wtop-num').textContent`);
проба('на месяце стрелка листает месяц', шапкаДо !== шапкаПосле, `${шапкаДо} → ${шапкаПосле}`);
проба('в шапке месяца написан месяц, а не число', /^[а-я]+ \d{4}$/.test(шапкаПосле), шапкаПосле);

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
  (await js(`document.querySelector('.wtop-num').textContent`)) === '5 августа',
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
проба('у окна два времени и подпись про рамку',
  (await js(`document.querySelectorAll('.wmodal .wtime').length`)) === 2
  && (await js(`[...document.querySelectorAll('.wmodal .wclock-cap')].some(e => e.textContent.includes('внутри окна'))`)));
await js(`[...document.querySelectorAll('.wmodal .wopt')].find(o => o.textContent.includes('Точное время')).click()`);
проба('у точного времени есть выбор длительности и переключатель расписания',
  (await js(`document.querySelectorAll('.wmodal .wchip-dur').length`)) >= 4
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
проба('правка привычки открывается из карточки',
  await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Новая привычка'`));
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
await js(`[...document.querySelectorAll('.wrow-link')][0].click()`);
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

console.log('\n── Итог ──');
const плохо = пробы.filter(([, ok]) => !ok).length;
console.log(`${пробы.length - плохо} из ${пробы.length}`);

ws.close(); proc.kill();
await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(плохо ? 1 : 0);
