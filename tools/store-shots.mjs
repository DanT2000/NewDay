/**
 * Скриншоты для карточки приложения в RuStore и Google Play.
 *
 *   node tools/store-shots.mjs [--base http://127.0.0.1:4010] [--out store/screens]
 *
 * Требования магазинов: пропорции 9:16, рекомендуется 1080×1920 JPG, до 5 МБ.
 * Другие размеры магазин обрежет сам — поэтому снимаем ровно 1080×1920.
 *
 * Как получается 1080×1920: окно 360×640 в CSS-пикселях (это телефон, и
 * веб-часть раскладывается по-телефонному) с плотностью 3. Снимать сразу в
 * 1080 нельзя — при такой ширине включилась бы раскладка для компьютера,
 * и в магазине висели бы скриншоты с боковой колонкой.
 *
 * Экран будильника здесь не снимается: он нативный и живёт только на
 * устройстве — для него есть tools/alarm-shots.sh.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const BASE = arg('base', 'http://127.0.0.1:4010');
const OUT = arg('out', 'store/screens');
const MAIL = process.env.NEWDAY_SHOT_MAIL || arg('mail', 'demo@newday.local');
const PASS = process.env.NEWDAY_SHOT_PASS || arg('pass', 'demo1234');
const PORT = 9361;
const CHROME = process.env.CHROME
  || `${process.env['ProgramFiles']}\\Google\\Chrome\\Application\\chrome.exe`;

mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'newday-store-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

let ws;
async function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMsg = e => {
      const m = JSON.parse(e.data);
      if (m.id === id) {
        ws.removeEventListener('message', onMsg);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const js = async expr => {
  const r = await cdp('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result?.value;
};
const wait = ms => new Promise(r => setTimeout(r, ms));

let n = 0;
async function shot(name) {
  n += 1;
  const num = String(n).padStart(2, '0');
  // JPEG качеством 92: разница с 100 не видна, а вес втрое меньше лимита
  const s = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
  const file = join(OUT, `${num}-${name}.jpg`);
  const buf = Buffer.from(s.data, 'base64');
  writeFileSync(file, buf);
  console.log(`${file}  ${(buf.length / 1024).toFixed(0)} КБ`);
}

/** Нажать по кнопке нижней полосы разделов. */
async function nav(label) {
  await js(`[...document.querySelectorAll('.wpnav-item, .wnav-item')]
    .find(b => b.textContent.includes(${JSON.stringify(label)}))?.click()`);
  await wait(900);
}

try {
  let list;
  for (let i = 0; i < 60; i += 1) {
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); break; }
    catch { await wait(250); }
  }
  const page = list.find(t => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 360, height: 640, deviceScaleFactor: 3, mobile: true,
  });

  await cdp('Page.navigate', { url: `${BASE}/login.html` });
  await wait(900);
  await js(`fetch('/api/v1/auth/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailOrUsername: ${JSON.stringify(MAIL)}, password: ${JSON.stringify(PASS)} }) })
    .then(r => r.status)`);
  await cdp('Page.navigate', { url: `${BASE}/web.html` });
  await wait(3000);

  // 1. День — главный экран, с него начинают
  await shot('день');

  // 2. Расписание днём: рельс, вложенные блоки, напоминания
  await nav('Дела');
  await wait(700);
  await shot('дела-и-питание');

  await nav('Сейчас');
  await wait(700);
  // 3. Шторка «всё расписание» — виден весь день списком
  await js(`[...document.querySelectorAll('.wbtn-dashed, .wlink')]
    .find(b => b.textContent.includes('расписание'))?.click()`);
  await wait(1000);
  await shot('расписание-дня');
  await js(`document.querySelector('.wmodal-x')?.click()`);
  await wait(600);

  // 4. Редактор строки: время, сигнал, повтор
  await js(`window.__wopen && window.__wopen('row')`);
  await wait(400);
  await js(`[...document.querySelectorAll('.wsched-row')][3]?.click()
    ?? [...document.querySelectorAll('.wsched-row')][0]?.click()`);
  await wait(1100);
  await shot('редактор-дела');
  await js(`document.querySelector('.wmodal-x')?.click()`);
  await wait(600);

  // 5. Привычки с сериями и челленджами
  await nav('Привычки');
  await wait(900);
  await shot('привычки');

  // 6. Заметки
  await nav('Заметки');
  await wait(900);
  await shot('заметки');

  // 7. Редактор привычки: челлендж, график, что именно отмечается
  await nav('Привычки');
  await wait(700);
  await js(`[...document.querySelectorAll('.whabit-card, .whabit, .whabit-row')][0]?.click()
    ?? window.__wopen('habit')`);
  await wait(1200);
  await shot('привычка-челлендж');
  await js(`document.querySelector('.wmodal-x')?.click()`);
  await wait(600);

  /*
   * 8. Помощник. Кнопки нет, когда ИИ не подключён, — открываем шторку
   * напрямую: на снимке важно, что умеет приложение, а не состояние стенда.
   */
  await nav('Сейчас');
  await wait(500);
  await js(`window.__wopen('ai')`);
  await wait(1100);
  await shot('помощник');
  await js(`document.querySelector('.wmodal-x')?.click()`);
  await wait(600);

  /*
   * 9. Задачи пробуждения. Формально раздел настроек, но показывает не
   * настройку, а то, чем приложение отличается: будильник, который не
   * выключить, не проснувшись.
   *
   * Два шага, а не один: заход на экран настроек нарочно сбрасывает открытый
   * раздел (позавчерашний раздел читался бы как чужой экран), поэтому раздел
   * задаём вторым вызовом, когда экран уже открыт.
   */
  await js(`window.__wgo('settings')`);
  await wait(500);
  await js(`window.__wgo('settings', 'alarm')`);
  await wait(700);
  await js(`[...document.querySelectorAll('.wsegline button')]
    .find(b => b.textContent === 'Продвинутый')?.click()`);
  await wait(1100);
  await shot('задачи-пробуждения');

  // 10. Подборка звуков: слышно до выбора, свои можно добавить
  await js(`window.__wgo('settings', 'sounds')`);
  await wait(700);
  await js(`[...document.querySelectorAll('.wrow-link')]
    .find(r => r.textContent.includes('Звук будильника'))?.click()`);
  await wait(1300);
  await shot('звуки-будильника');


  console.log(`\nГотово: ${n} снимков в ${OUT}`);
} finally {
  try { ws?.close(); } catch { /* уже закрыт */ }
  chrome.kill();
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* занят */ } }, 1500);
}
