/**
 * Что приложение умеет без сети.
 *
 *   node tools/offline-check.mjs [--base http://127.0.0.1:4010]
 *
 * Обещание «работает офлайн» проверяется только выключением сети. Здесь это
 * делается по-настоящему: браузеру задаётся режим без доступа к сети, и дальше
 * смотрим, что открылось, что видно и что произошло с правкой. Без такого
 * прогона легко считать, что офлайн работает, потому что вкладка была открыта
 * заранее и всё лежало в памяти.
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
const MAIL = arg('mail', 'demo@newday.local');
const PASS = arg('pass', 'demo1234');
const PORT = 9415;
const OUT = 'd:/Project/NewDay/tools/.shots';
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const EDGE = BROWSERS.find(b => { try { fsSync.accessSync(b); return true; } catch { return false; } });

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'newday-offline-'));
const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=390,844', '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore' });

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
const js = async (expr, awaitPromise = false) => {
  const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r?.exceptionDetails) return `ИСКЛЮЧЕНИЕ: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`;
  return r?.result?.value;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
let всего = 0; let сошлось = 0;
const проба = (имя, ок, деталь = '') => {
  всего++; if (ок) сошлось++;
  console.log(`  ${ок ? '\u2714' : '\u2716'} ${имя}${деталь ? ` — ${деталь}` : ''}`);
};
const waitFor = async (expr, tries = 40) => {
  for (let i = 0; i < tries; i++) { if (await js(expr)) return true; await wait(300); }
  return false;
};
const сеть = on => rpc('Network.emulateNetworkConditions', {
  offline: !on, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
});

await rpc('Page.enable'); await rpc('Runtime.enable'); await rpc('Network.enable');
await rpc('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

// ── Со связью: вход и первое открытие, чтобы всё легло в кеш ──
await rpc('Page.navigate', { url: `${BASE}/login.html` });
await wait(1500);
const вошли = await js(`fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({emailOrUsername:${JSON.stringify(MAIL)},password:${JSON.stringify(PASS)}})}).then(r=>r.status)`, true);
проба('вход со связью', вошли === 200, `ответ ${вошли}`);
if (вошли !== 200) { proc.kill(); process.exit(2); }

await rpc('Page.navigate', { url: `${BASE}/web.html` });
await wait(3500);
проба('со связью интерфейс собрался', (await js(`document.querySelectorAll('.wroot *').length`)) > 50);
// ждём, пока service worker возьмёт управление: без него офлайн не откроется вовсе
const подхватил = await waitFor(`Boolean(navigator.serviceWorker.controller)`, 60);
проба('service worker взял управление', подхватил);
const день = await js(`document.querySelector('.wphead-num')?.textContent ?? ''`);
const строк = await js(`document.querySelectorAll('.wsched-row').length`);
console.log(`    до отключения: день «${день}», строк расписания ${строк}`);

// ── Выключаем сеть ──
await сеть(false);
await wait(500);
проба('браузер считает, что связи нет', (await js(`navigator.onLine`)) === false);

// перезагрузка без сети — самый честный случай: человек открыл приложение в метро
await rpc('Page.reload', { ignoreCache: false });
await wait(4000);
const узлов = await js(`document.querySelectorAll('.wroot *').length`);
проба('без сети приложение открывается', узлов > 50, `узлов ${узлов}`);
if (узлов <= 50) {
  // Разбираться в «не открылось» по одному числу нельзя: печатаем, что на
  // странице вообще есть и что сказал сам браузер.
  console.log('    адрес:', await js(`location.href`));
  console.log('    заголовок:', await js(`document.title`));
  console.log('    начало body:', await js(`(document.body.innerText || '').slice(0, 160)`));
  console.log('    есть ли корень:', await js(`Boolean(document.querySelector('#wapp'))`));
  console.log('    в кеше лежит:', await js(`caches.keys().then(async ks => {
    const out = [];
    for (const k of ks) {
      const c = await caches.open(k);
      const rs = await c.keys();
      out.push(k + ': ' + rs.length + ' записей');
    }
    return out.join(' | ');
  })`, true));
  console.log('    web.html в кеше:', await js(`caches.match('/web.html').then(r => Boolean(r))`, true));
  console.log('    app.js в кеше:', await js(`caches.match('/js/web/app.js').then(r => Boolean(r))`, true));
  console.log('    native.js в кеше:', await js(`caches.match('/js/native.js').then(r => Boolean(r))`, true));
}
проба('полоса «нет связи» показана и она спокойная',
  await js(`Boolean(document.querySelector('.wnotice.calm'))`),
  await js(`document.querySelector('.wnotice')?.className ?? 'полосы нет'`));

/*
 * Проверяем не число строк на «Сейчас»: телефонный экран показывает только
 * ближайшие дела, и к вечеру их честно ноль. Проверяем то, что важно, — что
 * данные дня уцелели в копии и экран собран из них.
 */
const деньБез = await js(`document.querySelector('.wphead-num')?.textContent ?? ''`);
const копия = await js(`(() => {
  const st = JSON.parse(localStorage.getItem('newday.local.settings') || 'null');
  if (!st) return 'копии настроек нет';
  const key = 'newday.local.day.' + st.value.today;
  const d = JSON.parse(localStorage.getItem(key) || 'null');
  if (!d) return 'копии дня нет';
  return 'строк в копии: ' + (d.value.schedule || []).length;
})()`);
проба('день собран из локальной копии', деньБез !== '' && /строк в копии: [1-9]/.test(копия),
  `день «${деньБез}», ${копия}`);
const расписание = await (async () => {
  const кнопки = await js(`[...document.querySelectorAll('.wbtn-dashed')].map(b => b.textContent.trim()).join(' | ')`);
  await js(`[...document.querySelectorAll('.wbtn-dashed')].find(b => b.textContent.includes('Всё расписание'))?.click()`);
  const ok = await waitFor(`document.querySelectorAll('.wmodal .wsheet-row').length > 0`, 20);
  const строк = await js(`document.querySelectorAll('.wmodal .wsheet-row').length`);
  const шапка = await js(`document.querySelector('.wmodal-hd b')?.textContent ?? 'шторки нет'`);
  await js(`document.querySelector('.wmodal-x')?.click()`);
  await wait(500);
  return { ok, кнопки, строк, шапка };
})();
проба('всё расписание доступно без сети', расписание.ok,
  `шторка «${расписание.шапка}», строк ${расписание.строк}; кнопки: ${расписание.кнопки}`);

// ── Что происходит с правкой без сети ──
await js(`[...document.querySelectorAll('.wbtn-dashed')].find(b => b.textContent.includes('Строка'))?.click()`);
const шторка = await waitFor(`Boolean(document.querySelector('.wmodal'))`);
проба('редактор открывается без сети', шторка);
if (шторка) {
  await js(`(() => { const i = document.querySelector('.wmodal .winput');
    i.value = 'Офлайн проба'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await js(`document.querySelector('.wmodal .wbtn-wide').click()`);
  await wait(2500);
  const сказали = await js(`document.querySelector('.wnotice')?.textContent ?? ''`);
  проба('о неудаче правки сказано прямо, а не молча',
    /связ|сохран/i.test(сказали), сказали ? сказали.slice(0, 90) : 'ничего не сказано');
}

const s1 = await rpc('Page.captureScreenshot', { format: 'png' });
await fs.writeFile(path.join(OUT, 'offline-phone.png'), Buffer.from(s1.data, 'base64'));

/*
 * Возвращаем сеть. Проверяем и то, что полоса уходит сама по событию, и то,
 * что она уходит при возврате к приложению: на части оболочек Android событие
 * `online` не приходит вовсе, и полагаться только на него нельзя.
 */
await сеть(true);
await wait(1500);
let ушла = await waitFor(`!document.querySelector('.wnotice.calm')`, 20);
if (!ушла) {
  console.log('    по событию `online` не ушла — проверяю возврат к приложению');
  await rpc('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }).catch(() => {});
  await js(`document.dispatchEvent(new Event('visibilitychange'))`);
  ушла = await waitFor(`!document.querySelector('.wnotice.calm')`, 25);
}
проба('со связью полоса уходит', ушла,
  await js(`document.querySelector('.wnotice')?.className ?? 'полосы нет'`));

// убираем за собой то, что могло всё же записаться
await js(`(async () => {
  const st = await (await fetch('/api/v1/settings')).json();
  const d = await (await fetch('/api/v1/days/' + st.today + '/full')).json();
  for (const r of d.schedule.filter(x => x.title === 'Офлайн проба'))
    await fetch('/api/v1/days/' + st.today + '/schedule/' + r.id, { method: 'DELETE' });
})()`, true);

console.log(`\n── Итог ──\n${сошлось} из ${всего}`);
proc.kill();
process.exit(сошлось === всего ? 0 : 1);
