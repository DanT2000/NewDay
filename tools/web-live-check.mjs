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
await js(`document.querySelectorAll('.wnav-item')[1].click()`);
проба('сетка недели загрузилась', await waitFor('document.querySelectorAll(".wplan-col").length === 7'));
await wait(600);

const geom = await js(`(() => {
  const col = document.querySelectorAll('.wplan-col')[2];
  const b = col.getBoundingClientRect();
  return { x: Math.round(b.left + b.width / 2), top: Math.round(b.top) };
})()`);

/*
 * 18:00–18:45. В засеянном дне занято 06:00–07:30, 09:00–14:00, 14:00–18:00,
 * 19:00–20:00 и 21:00–22:00 — свободно ровно здесь. Прошлый прогон целился
 * в 16:00 и попал в «Работу, вторую половину»: нажатие на блок открывает
 * его правку, и проверка молча проверяла не то.
 */
const y1 = geom.top + 12 * 44;
const y2 = geom.top + 12.75 * 44;
const mouse = (type, y) => rpc(ws, 'Input.dispatchMouseEvent', {
  type, x: geom.x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
});

await mouse('mousePressed', y1);
await wait(120);
await mouse('mouseMoved', y2);
await wait(150);
проба('след протягивания показывает время', (await js(`document.querySelector('.wsel')?.textContent`)) === '18:00–18:45',
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
  saved?.[0] === '1080-1125/notify', JSON.stringify(saved));

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
await js(`document.querySelectorAll('.wnav-item')[4].click()`);
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

// ── Спорт ──
await js(`document.querySelectorAll('.wnav-item')[0].click()`);
await waitFor('Boolean(document.querySelector(".wsport"))');
await wait(400);
проба('спорт показан таблицей',
  (await js(`document.querySelectorAll('.wsport-head span').length`)) === 5,
  `${await js('document.querySelectorAll(".wsport-row").length')} упражнений`);

const sportCount = () => js(`fetch('/api/v1/days/${DAY}/full').then(r=>r.json()).then(d => d.sport.length)`, true);
const sportBefore = await sportCount();
await js(`document.querySelectorAll('.wsport-row')[0].click()`);
проба('шторка упражнения открылась',
  await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Упражнение'`));

await js(`(() => {
  const nums = document.querySelectorAll('.wmodal .wnum');
  nums[2].value = '62,5';
  nums[2].dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await js(`document.querySelector('.wmodal .wbtn-wide').click()`);
await waitFor('!document.querySelector(".wveil")');
await wait(900);

const weight = await js(`fetch('/api/v1/days/${DAY}/full').then(r=>r.json()).then(d => d.sport[0].weight)`, true);
проба('вес с запятой сохранился числом', weight === 62.5, String(weight));
const sportAfter = await sportCount();
проба('правка не создала лишнюю строку', sportAfter === sportBefore, `${sportBefore} → ${sportAfter}`);

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

// ── Шаблон дня ──
/*
 * База стенда живёт между прогонами, поэтому начинаем с чистого места:
 * иначе вторая проверка считала бы строки, оставшиеся от первой.
 */
await js(`(async () => {
  const list = await (await fetch('/api/v1/series?templates=1')).json();
  for (const t of list) await fetch('/api/v1/series/' + t.id, { method: 'DELETE' });
})()`, true);

const свободный = '2026-08-20';
const очиститьДень = () => js(`(async () => {
  const day = await (await fetch('/api/v1/days/${свободный}/full')).json();
  for (const r of day.schedule) await fetch('/api/v1/days/${свободный}/schedule/' + r.id, { method: 'DELETE' });
})()`, true);
await очиститьДень();

await js(`document.querySelectorAll('.wnav-item')[4].click()`);
await waitFor('Boolean(document.querySelector(".wsettings"))');
await wait(700);

const строкаНастроек = имя => js(`[...document.querySelectorAll('.wrow-link')]
  .find(r => r.textContent.includes(${JSON.stringify(имя)}))?.querySelector('.wrow-link-val')?.textContent`);

проба('в настройках честно сказано, что шаблона нет',
  (await строкаНастроек('Общее расписание')) === 'не создан', await строкаНастроек('Общее расписание'));

await js(`[...document.querySelectorAll('.wrow-link')].find(r => r.textContent.includes('Общее расписание')).click()`);
проба('шторка шаблона открылась',
  await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Общее расписание'`));
await wait(600);

await js(`[...document.querySelectorAll('.wmodal .wbtn-dashed')].find(b => b.textContent.includes('Взять из этого дня')).click()`);
проба('шаблон собрался из дня', await waitFor(`document.querySelectorAll('.wmodal .wsheet-row').length >= 8`),
  `${await js(`document.querySelectorAll('.wmodal .wsheet-row').length`)} строк`);

const шаблон = () => js(`fetch('/api/v1/series?templates=1').then(r=>r.json())
  .then(l => l.map(t => ({ name: t.name, rows: JSON.parse(t.payload_json).rows?.length ?? 1 })))`, true);
проба('шаблон сохранён на сервере набором строк',
  (await шаблон()).length === 1 && (await шаблон())[0].rows === 8, JSON.stringify(await шаблон()));

// Правка строки шаблона: открыть, переименовать, сохранить
await js(`document.querySelectorAll('.wmodal .wsheet-row')[0].click()`);
проба('строка шаблона открылась', await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Строка шаблона'`));
await js(`(() => {
  const i = document.querySelector('.wmodal .winput');
  i.value = 'Ранний подъём';
  i.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await js(`document.querySelector('.wmodal .wbtn-wide').click()`);
проба('после сохранения вернулись к списку шаблона',
  await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Общее расписание'`));
await wait(500);

const названия = await js(`fetch('/api/v1/series?templates=1').then(r=>r.json())
  .then(l => JSON.parse(l[0].payload_json).rows.map(r => r.title))`, true);
проба('правка строки ушла на сервер', названия.includes('Ранний подъём'), названия.slice(0, 3).join(', '));
проба('правка не размножила строки', названия.length === 8, `${названия.length} строк`);

// Пустая строка не сохраняется, и человеку об этом говорят
await js(`[...document.querySelectorAll('.wmodal .wbtn-dashed')].find(b => b.textContent.includes('Строка шаблона')).click()`);
await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Строка шаблона'`);
await js(`document.querySelector('.wmodal .wbtn-wide').click()`);
await wait(400);
проба('строка без названия не сохраняется молча',
  (await js(`document.querySelector('.wmodal .wnotice')?.textContent`)) === 'Впишите, что делаем',
  await js(`document.querySelector('.wmodal .wnotice')?.textContent ?? 'нет сообщения'`));
await js(`document.querySelector('.wmodal .wbtn-quiet').click()`);
await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Общее расписание'`);

// Применение к дню: уходим на свободную дату и заполняем её шаблоном
await js(`document.querySelector('.wmodal-x').click()`);
await waitFor('!document.querySelector(".wveil")');
await js(`(() => {
  const i = document.querySelector('.wtop-pick input');
  i.value = '${свободный}';
  i.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
проба('кнопка выбора даты переводит день',
  await waitFor(`document.querySelector('.wtop-num')?.textContent === '20 августа'`),
  await js(`document.querySelector('.wtop-num')?.textContent`));
await wait(600);

await js(`[...document.querySelectorAll('.wrow-link')].find(r => r.textContent.includes('Общее расписание')).click()`);
await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Общее расписание'`);
await wait(500);
проба('в настройках видно, сколько строк в шаблоне',
  (await строкаНастроек('Общее расписание')) === '8 строк', await строкаНастроек('Общее расписание'));

await js(`document.querySelector('.wmodal .wbtn-wide').click()`);
await wait(1200);
const вДне = await js(`fetch('/api/v1/days/${свободный}/full').then(r=>r.json()).then(d => d.schedule.map(r => r.title))`, true);
проба('шаблон заполнил выбранный день', вДне.length === 8, `${вДне.length} строк: ${вДне.slice(0, 2).join(', ')}`);
проба('переименованная строка пришла из шаблона', вДне.includes('Ранний подъём'));

await очиститьДень();
await js(`(async () => {
  const list = await (await fetch('/api/v1/series?templates=1')).json();
  for (const t of list) await fetch('/api/v1/series/' + t.id, { method: 'DELETE' });
})()`, true);

// ── Уведомления ──
await js(`document.querySelector('.wmodal-x')?.click()`);
await waitFor('!document.querySelector(".wveil")');
await js(`[...document.querySelectorAll('.wrow-link')].find(r => r.textContent.includes('Уведомления')).click()`);
проба('шторка уведомлений открылась',
  await waitFor(`document.querySelector('.wmodal-hd b')?.textContent === 'Уведомления'`));
await wait(700);

проба('ключи стенда подхвачены, а не «не настроены»',
  !(await js(`document.querySelector('.wmodal').textContent.includes('не заданы VAPID')`)));

const настройки = () => js(`fetch('/api/v1/push/status').then(r=>r.json()).then(s => s.settings)`, true);
await js(`[...document.querySelectorAll('.wmodal .wchip-sheet')].find(c => c.textContent === 'за 30 мин').click()`);
await wait(1200);
проба('«предупреждать за» сохраняется', (await настройки()).notifyDefaultBeforeMin === 30,
  String((await настройки()).notifyDefaultBeforeMin));

await js(`[...document.querySelectorAll('.wmodal .wbtn-quiet')].find(b => b.textContent === 'Включить').click()`);
await wait(1200);
const тихие = await настройки();
проба('тихие часы включаются', тихие.quietFrom === 1380 && тихие.quietTo === 420,
  `${тихие.quietFrom}–${тихие.quietTo}`);

await js(`[...document.querySelectorAll('.wmodal .wbtn-quiet')].find(b => b.textContent === 'Выключить').click()`);
await wait(1200);
проба('тихие часы выключаются', (await настройки()).quietFrom === null);

// возвращаем стенд к значению по умолчанию, чтобы прогон был повторяемым
await js(`fetch('/api/v1/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ settings: { notifyDefaultBeforeMin: 10 } }) }).then(r => r.ok)`, true);

console.log('\n── Итог ──');
const плохо = пробы.filter(([, ok]) => !ok).length;
console.log(`${пробы.length - плохо} из ${пробы.length}`);

ws.close(); proc.kill();
await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(плохо ? 1 : 0);
