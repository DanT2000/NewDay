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
 * устройстве. Для карточки магазина его снимает tools/store-alarm-shots.mjs
 * (кадры 09 и 10), для разбора всех его состояний — tools/alarm-shots.sh.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import tmp from './lib/tmp.js';

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
// Профиль браузера — в .tmp проекта; модуль уберёт его и при раннем выходе
const profile = tmp.tempDir('store-shots');
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

  /*
   * Вид прибиваем явно: тёмная тема и фиолетовый акцент.
   *
   * Стенд один, и проверки по нему ходят: обход переполнений заглядывает в
   * «Оформление» и оставляет там тот цвет, на который нажал последним. Один
   * раз из-за этого десять снимков ушли зелёными, а графическое изображение
   * осталось фиолетовым — карточка выглядела собранной из двух приложений.
   * Фиолетовый — то, что видит человек без настроек (public/js/boot-theme.js).
   */
  await js(`fetch('/api/v1/settings', { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: 'dark', settings: { accent: 'violet' } }) }).then(r => r.status)`);

  /*
   * Помощника на стенде подключаем.
   *
   * Иначе шторка честно пишет «Помощник не подключён» — и в карточке магазина
   * это читается как «функция не работает». Снимок должен показывать, что
   * приложение умеет, а не как настроен конкретный стенд. Обращения к модели
   * тут не будет: снимается пустое поле ввода до нажатия, поэтому адрес и ключ
   * заведомо нерабочие и никуда не уходят.
   */
  await js(`fetch('/api/v1/admin/ai', { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, baseUrl: 'https://example.invalid/v1',
      model: 'gpt-4o-mini', voiceModel: 'whisper-1', apiKey: 'снимок-для-карточки' }) })
    .then(r => r.status)`);

  /*
   * Досеиваем две заметки без даты.
   *
   * В засеве стенда заметка одна, и на экране «Заметки» половина места
   * оставалась пустой — в карточке магазина это читается как «раздел ещё не
   * сделан». Заметки без даты нигде, кроме своего экрана, не показываются,
   * поэтому остальным снимкам они не мешают. Создаём до загрузки экрана, чтобы
   * не перезагружать страницу, и убираем в конце прогона: стенд общий, по нему
   * ходят проверки, и оставлять в нём свой мусор нельзя.
   */
  const заметки = JSON.parse(await js(`(async () => {
    const создать = (title, text) => fetch('/api/v1/notes', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, text }) }).then(r => r.json());
    const a = await создать('Подарок на годовщину',
      'Посмотреть тот набор для кофе. Спросить у Лены, что она думает.');
    const b = await создать('Идеи для отпуска',
      'Карелия на машине — четыре дня. Или Дагестан, но тогда самолёт.');
    return JSON.stringify([a.id, b.id].filter(Boolean));
  })()`));

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

  /*
   * 4. Редактор строки — обязательно уже заполненной.
   *
   * Порядок важен: сначала открыть расписание, потом нажать строку в нём.
   * Наоборот не работает — шторка «Новый блок» закрывает список, нажимать
   * становится некуда, и в карточку уезжал снимок пустой формы с пустым полем
   * «что делаем». Поэтому здесь же проверяем, что в заголовке не «Новый блок».
   */
  await js(`[...document.querySelectorAll('.wbtn-dashed, .wlink')]
    .find(b => b.textContent.includes('расписание'))?.click()`);
  await wait(900);
  // Строка с будильником: в её редакторе видно то, чем приложение отличается
  await js(`[...document.querySelectorAll('.wmodal .wsheet-row')]
    .find(r => r.textContent.includes('06:40'))?.click()`);
  await wait(1200);
  const поле = await js(`document.querySelector('.wmodal .winput')?.value?.trim() ?? ''`);
  if (!поле) {
    const где = await js(`document.querySelector('.wmodal-hd b')?.textContent?.trim() ?? 'шторки нет'`);
    console.error(`редактор не открылся на заполненной строке — на экране «${где}»`);
    process.exitCode = 1;
  }
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

  /*
   * 7. Редактор привычки — существующей, у которой идёт челлендж.
   *
   * Открывается кнопкой «⋮» внутри карточки (.whabit-more), а не нажатием на
   * саму карточку: по карточке отмечается выполнение. Прежние селекторы
   * (.whabit-card и прочие) не существуют, поэтому срабатывал запасной путь и
   * в карточку магазина уезжала пустая форма «Новая привычка».
   */
  await nav('Привычки');
  await wait(700);
  await js(`(() => {
    const карточки = [...document.querySelectorAll('.wcard')];
    const цель = карточки.find(c => c.textContent.includes('челлендж')) ?? карточки[0];
    цель?.querySelector('.whabit-more')?.click();
  })()`);
  await wait(1200);
  const шапка = await js(`document.querySelector('.wmodal-hd b')?.textContent?.trim() ?? ''`);
  if (шапка !== 'Привычка') {
    console.error(`редактор привычки открылся не на существующей: «${шапка}»`);
    process.exitCode = 1;
  }
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
   * Раньше здесь снимались ещё два кадра — «Задачи пробуждения» и «Звуки
   * будильника». Оба из настроек, а в карточке магазина настройки не нужны:
   * человек смотрит, чем он будет пользоваться, а не что сможет покрутить.
   *
   * Их место заняли два снимка настоящего экрана будильника — того, чем это
   * приложение отличается. Он нативный, в вебе его нет, снимается отдельно:
   * node tools/store-alarm-shots.mjs (кадры 09 и 10).
   */
  // Убираем за собой досеянные заметки — стенд остаётся как был
  if (заметки.length) {
    await js(`(async () => {
      for (const id of ${JSON.stringify(заметки)}) {
        await fetch('/api/v1/notes/' + id, { method: 'DELETE' });
      }
      return 'ок';
    })()`);
  }

  console.log(`\nГотово: ${n} снимков в ${OUT}`);
  console.log('Кадры 09 и 10 (экран будильника) — node tools/store-alarm-shots.mjs');
} finally {
  try { ws?.close(); } catch { /* уже закрыт */ }
  chrome.kill();
  await tmp.release(profile);
}
