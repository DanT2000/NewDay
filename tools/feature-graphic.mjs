/**
 * Графическое изображение для карточки Google Play — ровно 1024×500.
 *
 *   node tools/feature-graphic.mjs [--out store/feature-1024x500.png]
 *
 * Play показывает эту картинку крупно в самом верху карточки и иногда
 * накрывает её центр кнопкой воспроизведения — поэтому смысловая нагрузка
 * разведена по краям, а середина оставлена спокойной.
 *
 * Шрифт и логотип вшиваются в страницу как data: URI: рендер идёт с file://,
 * где обычные пути от корня сайта не работают, а без своего шрифта Chrome
 * подставил бы системный и картинка перестала бы быть похожей на приложение.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import tmp from './lib/tmp.js';
import { pathToFileURL } from 'node:url';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const OUT = resolve(arg('out', 'store/feature-1024x500.png'));
const PORT = 9372;
const CHROME = process.env.CHROME
  || `${process.env['ProgramFiles']}\\Google\\Chrome\\Application\\chrome.exe`;

const b64 = p => readFileSync(p).toString('base64');
const font = b64('public/fonts/inter-cyrillic-71d5ee93.woff2');
const fontLat = b64('public/fonts/inter-latin-3100e775.woff2');
const logo = b64('public/icons/logo-light-256.png');

/*
 * Цвета взяты из public/css/tokens.css, тёмная тема: это не «тёмный фон с
 * ярким акцентом вообще», а ровно та палитра, которую человек увидит,
 * открыв приложение.
 */
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Inter; font-weight: 100 900; font-display: block;
  src: url(data:font/woff2;base64,${font}) format('woff2');
  unicode-range: U+0400-04FF, U+2116; }
@font-face { font-family: Inter; font-weight: 100 900; font-display: block;
  src: url(data:font/woff2;base64,${fontLat}) format('woff2');
  unicode-range: U+0000-00FF, U+2000-206F, U+2212; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: 1024px; height: 500px; overflow: hidden;
  font-family: Inter, sans-serif; color: #f3f5fe;
  background: #161826; position: relative; }

/* Свечение ровно под точкой 6:00 — единственный источник света на картинке */
.glow { position: absolute; left: -60px; bottom: -190px; width: 620px; height: 430px;
  background: radial-gradient(closest-side, rgba(106,84,232,.5), rgba(106,84,232,0));
  filter: blur(6px); }

/*
 * Текст справа, а задача пробуждения слева — потому что на рельсе подъём
 * стоит первым делом дня, и карточка должна расти из своей точки. Обратный
 * порядок (текст слева) сажал карточку прямо на заголовок.
 */
.side { position: absolute; right: 60px; top: 52px; width: 526px; text-align: right; }

.brand { display: flex; align-items: center; justify-content: flex-end; gap: 18px; }
.brand img { width: 66px; height: 66px; border-radius: 17px; }
.brand span { font-size: 52px; font-weight: 700; letter-spacing: -1.2px; }

h1 { margin-top: 26px; font-size: 44px; font-weight: 650; line-height: 1.15;
  letter-spacing: -1.1px; }
h1 b { color: #b9abff; font-weight: 650; }
.sub { margin-top: 16px; font-size: 23px; color: #a8adc4; font-weight: 450; }

/*
 * Рельс со точками — то же изображение расписания, что и в самом приложении:
 * день идёт полосой, дела сидят на ней точками. Здесь он же служит подписью
 * к главному: подъём в 6:00 отмечен и подсвечен.
 */
.rail { position: absolute; left: 60px; right: 60px; bottom: 84px; height: 3px;
  background: linear-gradient(90deg, #6a54e8 0%, #6a54e8 14%, #333654 14%, #333654 100%);
  border-radius: 3px; }
.dot { position: absolute; top: 50%; transform: translate(-50%, -50%);
  width: 15px; height: 15px; border-radius: 50%;
  background: #232532; border: 3px solid #333654; }
.dot.on { width: 25px; height: 25px; border-color: #6a54e8; background: #6a54e8;
  box-shadow: 0 0 0 9px rgba(106,84,232,.22); }
.tick { position: absolute; top: 30px; transform: translateX(-50%);
  font-size: 19px; color: #7d84a3; font-weight: 500; white-space: nowrap; }
.tick.on { color: #f3f5fe; font-weight: 650; }

/* Задача пробуждения — то, чем это приложение отличается от будильника */
.task { position: absolute; left: 64px; bottom: 152px; width: 250px;
  background: #232532; border: 1px solid #3b3e58; border-radius: 18px;
  padding: 18px 20px; box-shadow: 0 18px 44px rgba(0,0,0,.5); }
.task .lbl { font-size: 15px; color: #8b91ad; font-weight: 550;
  text-transform: uppercase; letter-spacing: .7px; }
.task .q { margin-top: 8px; font-size: 34px; font-weight: 700; letter-spacing: -.5px; }
.task .keys { margin-top: 14px; display: flex; gap: 7px; }
.task .keys i { flex: 1; height: 30px; border-radius: 8px; background: #2c2f40; }
.task .keys i:nth-child(2) { background: #6a54e8; }
/* Ножка ведёт ровно в подсвеченную точку 6:00 (14% от ширины рельса) */
.task .tail { position: absolute; left: 123px; bottom: -68px; width: 3px; height: 68px;
  background: linear-gradient(#3b3e58, #6a54e8); }
</style></head><body>
  <div class="glow"></div>
  <div class="side">
    <div class="brand">
      <img src="data:image/png;base64,${logo}" alt="">
      <span>NewDay</span>
    </div>
    <h1>Будильник, который<br>не выключить,<br><b>не проснувшись</b></h1>
    <div class="sub">Расписание дня · привычки · заметки</div>
  </div>

  <div class="task">
    <!--
      Пример настоящий: задача второго уровня — двузначные, сложение или
      вычитание (DismissTasks.math). Умножения приложение не показывает
      никогда, и «6 × 7» на картинке обещало бы то, чего в нём нет.
    -->
    <div class="lbl">чтобы выключить</div>
    <div class="q">47 + 68 = ?</div>
    <div class="keys"><i></i><i></i><i></i></div>
    <div class="tail"></div>
  </div>

  <div class="rail">
    <div class="dot on" style="left: 14%"></div>
    <div class="dot" style="left: 40%"></div>
    <div class="dot" style="left: 62%"></div>
    <div class="dot" style="left: 84%"></div>
    <div class="tick on" style="left: 14%">6:00 · подъём</div>
    <div class="tick" style="left: 40%">9:00</div>
    <div class="tick" style="left: 62%">13:00</div>
    <div class="tick" style="left: 84%">19:00</div>
  </div>
</body></html>`;

// Страница и профиль браузера — в .tmp проекта, уборка на модуле
const dir = tmp.tempDir('feature');
const page = join(dir, 'feature.html');
writeFileSync(page, html, 'utf8');

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(dir, 'profile')}`,
  '--no-first-run', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

let ws;
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = Math.floor(Math.random() * 1e9);
  const onMsg = e => {
    const m = JSON.parse(e.data);
    if (m.id === id) {
      ws.removeEventListener('message', onMsg);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  };
  ws.addEventListener('message', onMsg);
  ws.send(JSON.stringify({ id, method, params }));
});
const wait = ms => new Promise(r => setTimeout(r, ms));

try {
  let list;
  for (let i = 0; i < 60; i += 1) {
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); break; }
    catch { await wait(250); }
  }
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1024, height: 500, deviceScaleFactor: 1, mobile: false,
  });
  await cdp('Page.navigate', { url: pathToFileURL(page).href });
  await wait(1200);
  // Шрифт вшит, но выложиться он всё равно должен до снимка
  await cdp('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true });
  await wait(300);

  const s = await cdp('Page.captureScreenshot', { format: 'png' });
  mkdirSync(dirname(OUT), { recursive: true });
  const buf = Buffer.from(s.data, 'base64');
  writeFileSync(OUT, buf);
  console.log(`${OUT}  ${(buf.length / 1024).toFixed(0)} КБ`);
} finally {
  try { ws?.close(); } catch { /* уже закрыт */ }
  chrome.kill();
  await tmp.release(dir);
}
