/**
 * Снимки экранов со стенда — чтобы смотреть на вёрстку, а не воображать её.
 *
 * Поднимает безголовый браузер, входит на стенд и снимает нужные страницы
 * в заданном размере. Проверять раскладку рабочего стола иначе нечем:
 * на глаз в коде ширины колонок не сходятся.
 *
 *   node tools/dev-preview.js &
 *   node tools/shots.mjs                    # 1440×900, все экраны
 *   node tools/shots.mjs 390 844            # телефон
 *
 * Снимки лежат в tools/.shots и в git не уезжают.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const WIDTH = Number(process.argv[2]) || 1440;
const HEIGHT = Number(process.argv[3]) || 900;
const STAND = process.env.STAND || 'http://127.0.0.1:4010';
const OUT = path.join(import.meta.dirname, '.shots');
const PORT = 9333;

const PAGES = process.env.SHOT_WEB
  // Веб-версия — одна страница с разделами внутри; переключаем их кликом
  ? [['web', '/web.html']]
  : [
    ['now', '/now.html'],
    ['dela', '/app.html'],
    ['habits', '/habits.html'],
    ['notes', '/notes.html'],
    ['settings', '/settings.html'],
  ];

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

async function findBrowser() {
  for (const b of BROWSERS) {
    try { await fs.access(b); return b; } catch { /* пробуем следующий */ }
  }
  throw new Error('Не нашёл ни Edge, ни Chrome');
}

const rpc = (ws, method, params, sessionId) => new Promise(resolve => {
  const id = ++rpc.n;
  const on = e => {
    const m = JSON.parse(e.data);
    if (m.id === id) { ws.removeEventListener('message', on); resolve(m.result ?? m); }
  };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
rpc.n = 0;

const browser = await findBrowser();
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'newday-shots-'));
await fs.mkdir(OUT, { recursive: true });

const proc = spawn(browser, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--window-size=${WIDTH},${HEIGHT}`,
  '--hide-scrollbars',
  '--no-first-run',
  '--disable-extensions',
  'about:blank',
], { stdio: 'ignore' });

/** Ждём, пока браузер откроет порт: сразу после запуска он ещё не слушает. */
async function targets() {
  for (let i = 0; i < 60; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); }
    catch { await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error('Браузер не отозвался');
}

const list = await targets();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));

await rpc(ws, 'Page.enable');
await rpc(ws, 'Runtime.enable');
await rpc(ws, 'Emulation.setDeviceMetricsOverride', {
  width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: WIDTH < 700,
});

async function go(url) {
  await rpc(ws, 'Page.navigate', { url });
  // Ждём не события загрузки, а появления содержимого: страницы рисуются
  // модулями уже после load, и снимок пустого каркаса бесполезен
  for (let i = 0; i < 80; i++) {
    const r = await rpc(ws, 'Runtime.evaluate', {
      expression: 'document.readyState === "complete" && (document.querySelector("#app")?.children.length > 0 || document.querySelector("#wapp")?.children.length > 0)',
      returnByValue: true,
    });
    if (r?.result?.value) break;
    await new Promise(r2 => setTimeout(r2, 150));
  }
  await new Promise(r => setTimeout(r, 700));
}

// Вход: без него все страницы покажут форму входа
await go(`${STAND}/login.html`);
await rpc(ws, 'Runtime.evaluate', {
  expression: `(async () => {
    await fetch('/api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailOrUsername: 'demo@newday.local', password: 'demo1234' }),
    });
  })()`,
  awaitPromise: true,
});

const made = [];
for (const [name, url] of (process.env.SHOT_ONLY_AI ? [] : PAGES)) {
  await go(STAND + url);
  const shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(OUT, `${name}-${WIDTH}.png`);
  await fs.writeFile(file, Buffer.from(shot.data, 'base64'));
  made.push(file);
  console.log(`  ${name} → ${path.relative(process.cwd(), file)}`);
}

/*
 * Помощник — окно, а не страница, поэтому его надо открыть. Снимаем два
 * состояния: пустой ввод и разобранный список. Второй требует живой
 * модели, поэтому если она не отвечает, снимок будет с ошибкой — это
 * тоже полезно увидеть.
 */
if (process.env.SHOT_AI) {
  await go(`${STAND}/now.html`);
  await rpc(ws, 'Runtime.evaluate', { expression: 'document.querySelector(".sb-ai")?.click()' });
  await new Promise(r => setTimeout(r, 900));
  let shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(OUT, `ai-vvod-${WIDTH}.png`), Buffer.from(shot.data, 'base64'));
  console.log('  помощник: ввод');

  await rpc(ws, 'Runtime.evaluate', {
    expression: `(() => {
      const t = document.querySelector('.ai-input');
      t.value = ${JSON.stringify(process.env.SHOT_AI)};
      t.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.btn-sheet')?.click();
    })()`,
  });
  // Модель отвечает три-пять секунд; ждём появления списка или ошибки
  for (let i = 0; i < 60; i++) {
    const r = await rpc(ws, 'Runtime.evaluate', {
      expression: 'Boolean(document.querySelector(".ai-plan, .ai-error, .ai-options"))',
      returnByValue: true,
    });
    if (r?.result?.value) break;
    await new Promise(r2 => setTimeout(r2, 400));
  }
  await new Promise(r => setTimeout(r, 400));
  shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(OUT, `ai-razbor-${WIDTH}.png`), Buffer.from(shot.data, 'base64'));
  console.log('  помощник: разбор');
}

/*
 * Разделы веб-версии: щёлкаем по колонке слева и снимаем каждый. Плюс
 * шторки — они и есть половина макета, а увидеть их иначе нечем.
 */
if (process.env.SHOT_WEB) {
  const SECTIONS = ['today', 'plan', 'habits', 'notes', 'settings'];
  for (let i = 0; i < SECTIONS.length; i++) {
    await rpc(ws, 'Runtime.evaluate', { expression: `document.querySelectorAll('.wnav-item')[${i}].click()` });
    await new Promise(r => setTimeout(r, 450));
    const shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(OUT, `web-${SECTIONS[i]}-${WIDTH}.png`), Buffer.from(shot.data, 'base64'));
    console.log(`  раздел ${SECTIONS[i]}`);
  }

  // Месяц и день расписания — отдельные виды одного раздела
  await rpc(ws, 'Runtime.evaluate', { expression: `document.querySelectorAll('.wnav-item')[1].click()` });
  await new Promise(r => setTimeout(r, 350));
  for (const [n, label] of [[2, 'month'], [0, 'day']]) {
    await rpc(ws, 'Runtime.evaluate', { expression: `document.querySelectorAll('.wseg button')[${n}].click()` });
    await new Promise(r => setTimeout(r, 400));
    const shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(OUT, `web-plan-${label}-${WIDTH}.png`), Buffer.from(shot.data, 'base64'));
    console.log(`  расписание: ${label}`);
  }

  const MODALS = ['row', 'schedule', 'ai', 'habit', 'note', 'task', 'meal', 'reminder', 'sound', 'file', 'template', 'print'];
  for (const m of MODALS) {
    await rpc(ws, 'Runtime.evaluate', {
      expression: `(() => {
        const mod = document.querySelector('.wveil'); if (mod) mod.remove();
        window.__wopen && window.__wopen(${JSON.stringify(m)});
      })()`,
    });
    await new Promise(r => setTimeout(r, 400));
    const shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(OUT, `web-modal-${m}-${WIDTH}.png`), Buffer.from(shot.data, 'base64'));
    console.log(`  шторка ${m}`);
  }
}

ws.close();
proc.kill();
await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
console.log(`\nСнимков: ${made.length}, размер ${WIDTH}×${HEIGHT}`);
