/**
 * Снимки экрана будильника для карточек магазинов — ровно 1080×1920.
 *
 *   node tools/store-alarm-shots.mjs [--api 34] [--from 9]
 *
 * Зачем отдельно от tools/store-shots.mjs: экран будильника нативный. Он живёт
 * поверх локскрина, в вебе его нет вовсе, и снять его можно только на
 * устройстве, дождавшись звонка. А показать его в карточке надо — это то, чем
 * приложение отличается от любого другого планировщика.
 *
 * Почему профиль устройства «pixel», а не «pixel_6»: у Pixel 6 экран
 * 1080×2400, это 9:20, и магазин обрезал бы снимок сам. У профиля «pixel»
 * ровно 1080×1920 — те самые 9:16, которые просят и Play, и RuStore.
 *
 * Почему сборка debug, а не release: чтобы поставить будильник на восемь секунд
 * вперёд, нужен мост в вебвью (Capacitor.Plugins.NewDayAlarm.testAlarm), а в
 * релизе отладка вебвью выключена намеренно — иначе через неё виден токен
 * устройства. Сам экран будильника от типа сборки не зависит: он на Kotlin и
 * пиксель в пиксель тот же.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import tmp from './lib/tmp.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const API = arg('api', '34');
const FROM = Number(arg('from', '9'));
const OUT = arg('out', 'store/screens');
const SDK = `${process.env.LOCALAPPDATA}/Android/Sdk`;
const ADB = `${SDK}/platform-tools/adb.exe`;
const EMU = `${SDK}/emulator/emulator.exe`;
const AVDMAN = `${SDK}/cmdline-tools/latest/bin/avdmanager.bat`;
const AVD = `newday_store_api${API}`;
const PKG = 'ru.appswire.newday';
const APK = 'android/app/build/outputs/apk/rustore/debug/app-rustore-debug.apk';
const CDP_PORT = 9381;

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const adb = (...args) => sh(ADB, args).stdout?.trim() ?? '';
/**
 * Запуск .bat — только через оболочку.
 *
 * spawnSync на Windows не умеет исполнять батники напрямую: возвращает ошибку
 * и пустой stdout. Проверка `stdout?.includes(...)` на этом молча давала «нет»,
 * создание AVD так же молча не срабатывало, и прогон уходил поднимать
 * эмулятор с несуществующим устройством. Путь берём в кавычки: оболочка иначе
 * разорвёт его по пробелам.
 */
const bat = (file, args, opts = {}) =>
  spawnSync(`"${file}"`, args, { encoding: 'utf8', shell: true, ...opts });
const wait = ms => new Promise(r => setTimeout(r, ms));

// ── эмулятор ──────────────────────────────────────────────────────────
if (!existsSync(APK)) {
  console.log('Собираю отладочную сборку — без неё нечем поставить проверочный будильник');
  // Полный путь, а не имя: cmd не ищет в текущем каталоге, и «gradlew.bat»
  // из cwd:'android' не находился вовсе
  const gradlew = resolve('android', process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  const r = sh(gradlew, ['assembleRustoreDebug'], { cwd: 'android', stdio: 'inherit', shell: true });
  if (r.status !== 0 || !existsSync(APK)) { console.error('сборка не получилась'); process.exit(1); }
}

adb('emu', 'kill');
await wait(3000);
sh('taskkill', ['/F', '/IM', 'qemu-system-x86_64.exe']);
await wait(2000);

if (!bat(AVDMAN, ['list', 'avd']).stdout?.includes(`Name: ${AVD}`)) {
  console.log(`создаю ${AVD} с экраном 1080×1920`);
  bat(AVDMAN, ['create', 'avd', '-n', AVD, '-k',
    `system-images;android-${API};google_apis;x86_64`, '-d', 'pixel', '--force'], { input: 'no\n' });
}
/*
 * Проверяем, что устройство действительно создалось и экран у него тот самый.
 * Без этой проверки прогон once уже ушёл поднимать эмулятор с несуществующим
 * AVD и закончился двумя строчками в логе, ничего не сняв и ни на что не
 * пожаловавшись.
 */
const AVD_INI = `${process.env.USERPROFILE}/.android/avd/${AVD}.avd/config.ini`;
if (!existsSync(AVD_INI)) {
  console.error(`не создалось устройство ${AVD}: нет ${AVD_INI}`);
  console.error('проверьте, что установлен образ system-images;android-' + API + ';google_apis;x86_64');
  process.exit(1);
}
{
  const ini = readFileSync(AVD_INI, 'utf8');
  const w = ini.match(/^hw\.lcd\.width=(\d+)/m)?.[1];
  const h = ini.match(/^hw\.lcd\.height=(\d+)/m)?.[1];
  if (w !== '1080' || h !== '1920') {
    console.error(`у ${AVD} экран ${w}×${h}, а магазину нужны ровно 1080×1920 (9:16)`);
    process.exit(1);
  }
  console.log(`устройство готово: экран ${w}×${h}`);
}

/*
 * Камера — виртуальная сцена, а не «none»: иначе hasCamera() честно отвечает
 * «камеры нет», задача QR подменяется примером ещё до показа, и снимать
 * видоискатель не с чего.
 */
const avdDir = `${process.env.USERPROFILE}/.android/avd/${AVD}.avd`;
const ini = `${avdDir}/config.ini`;
if (existsSync(ini)) {
  let cfg = readFileSync(ini, 'utf8');
  cfg = /^hw\.camera\.back=/m.test(cfg)
    ? cfg.replace(/^hw\.camera\.back=.*$/m, 'hw.camera.back=virtualscene')
    : `${cfg}\nhw.camera.back=virtualscene\n`;
  writeFileSync(ini, cfg);
}
for (const lock of ['hardware-qemu.ini.lock', 'multiinstance.lock', 'userdata-qemu.img.lock', 'snapshot.lock']) {
  try { rmSync(`${avdDir}/${lock}`, { recursive: true, force: true }); } catch { /* нет замка */ }
}

console.log('поднимаю эмулятор');
const emu = spawn(EMU, ['-avd', AVD, '-no-snapshot-save', '-no-boot-anim', '-no-audio',
  '-gpu', 'swiftshader_indirect'], { stdio: 'ignore', detached: true });
adb('wait-for-device');
for (let w = 0; adb('shell', 'getprop', 'sys.boot_completed') !== '1'; w += 5) {
  if (w > 300) { console.error('эмулятор не загрузился'); process.exit(1); }
  await wait(5000);
}
await wait(8000);

// Прошлая сборка могла быть подписана другим ключом — обновление поверх такой
// Android запрещает, поэтому при отказе ставим заново
if (sh(ADB, ['install', '-r', '-g', APK]).status !== 0) {
  adb('uninstall', PKG);
  if (sh(ADB, ['install', '-g', APK]).status !== 0) { console.error('APK не встал'); process.exit(1); }
}
adb('shell', 'appops', 'set', PKG, 'SYSTEM_ALERT_WINDOW', 'allow');
adb('shell', 'appops', 'set', PKG, 'SCHEDULE_EXACT_ALARM', 'allow');

/*
 * Переводим часы эмулятора на утро.
 *
 * На снимке будет крупное время, и «Подъём» в 16:01 читается как ошибка. Часы
 * ставим ДО постановки будильника: приёмник смены времени пересчитывает уже
 * стоящие будильники на то же местное время, и если поменять часы после, снимок
 * поймает этот пересчёт вместо звонка.
 *
 * Права на смену времени есть только у root, и на google_apis-образах `adb root`
 * проходит. Не прошло — не беда: снимок выйдет с той датой, что есть, и об этом
 * сказано вслух, а не проглочено.
 */
{
  sh(ADB, ['root']);
  await wait(2500);
  adb('wait-for-device');
  const утро = '06:38:00';
  adb('shell', 'su', '0', 'toybox', 'date', '-s', утро);
  const стало = adb('shell', 'date', '+%H:%M');
  if (/^0?6:3/.test(стало)) console.log(`часы эмулятора переведены на ${стало}`);
  else console.log(`СТЕНД: часы перевести не удалось (на телефоне ${стало || 'неизвестно'}), снимаю как есть`);
  sh(ADB, ['unroot']);
  await wait(2500);
  adb('wait-for-device');
}

// ── мост в вебвью ─────────────────────────────────────────────────────
function forward() {
  const pid = adb('shell', 'pidof', PKG);
  adb('forward', '--remove-all');
  adb('forward', 'tcp:9222', `localabstract:webview_devtools_remote_${pid}`);
}
const evalJs = expr => sh(process.execPath, ['tools/webview-eval.js', expr], { encoding: 'utf8' });

async function startApp() {
  adb('shell', 'am', 'force-stop', PKG);
  adb('shell', 'am', 'start', '-n', `${PKG}/ru.appswire.newday.MainActivity`);
  await wait(6000);
  for (let w = 0; w < 20; w += 2) {
    if (adb('logcat', '-d', '-s', 'NewDayAlarm').includes('SYNCED')) break;
    await wait(2000);
  }
  forward();
}

async function awaitScreen() {
  for (let w = 0; w < 60; w += 2) {
    if (adb('shell', 'dumpsys', 'activity', 'activities').includes('AlarmActivity')) {
      await wait(2500);
      return true;
    }
    await wait(2000);
  }
  return false;
}

// ── превращение снимка в JPEG нужного веса ────────────────────────────
// Профиль браузера-конвертера и вытянутые снимки — в .tmp проекта
const chromeDir = tmp.tempDir('shot-convert');
const chrome = spawn(
  process.env.CHROME || `${process.env['ProgramFiles']}\\Google\\Chrome\\Application\\chrome.exe`,
  ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${chromeDir}`,
    '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' },
);
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

let n = FROM - 1;
/**
 * Снять экран телефона и положить кадром 1080×1920 JPEG.
 *
 * `окно` — прямоугольник в долях кадра, яркость которого надо проверить. Нужен
 * для видоискателя QR: первый прогон снял его чёрным с подписью «Открываю
 * камеру…» — камера открывается не мгновенно, а по числам такой кадр ничем не
 * отличается от нормального и молча уехал бы в магазин.
 */
async function shot(name, окно = null) {
  n += 1;
  adb('shell', 'screencap', '-p', '/sdcard/shot.png');
  const raw = join(chromeDir, 'shot.png');
  sh(ADB, ['pull', '/sdcard/shot.png', raw]);
  const b64 = readFileSync(raw).toString('base64');
  const page = join(chromeDir, 'wrap.html');
  writeFileSync(page, `<!DOCTYPE html><style>*{margin:0;padding:0}
    img{display:block;width:1080px;height:1920px}</style>
    <img src="data:image/png;base64,${b64}">`);
  await cdp('Page.navigate', { url: `file:///${page.replace(/\\/g, '/')}` });
  await wait(900);

  if (окно) {
    const r = await cdp('Runtime.evaluate', {
      expression: `(() => {
        const img = document.querySelector('img');
        const c = document.createElement('canvas');
        c.width = 1080; c.height = 1920;
        c.getContext('2d').drawImage(img, 0, 0, 1080, 1920);
        const [x, y, w, h] = [${окно.join(',')}].map((v, i) => Math.round(v * (i % 2 ? 1920 : 1080)));
        const d = c.getContext('2d').getImageData(x, y, w, h).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
        return Math.round(sum / (d.length / 4));
      })()`,
      returnByValue: true,
    });
    const яркость = r.result?.value ?? -1;
    if (яркость < 12) {
      console.error(`  ${name}: видоискатель почти чёрный (яркость ${яркость}) — камера не успела открыться`);
      process.exitCode = 1;
    } else {
      console.log(`  ${name}: яркость видоискателя ${яркость} — картинка есть`);
    }
  }

  const s = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
  const file = join(OUT, `${String(n).padStart(2, '0')}-${name}.jpg`);
  const buf = Buffer.from(s.data, 'base64');
  mkdirSync(OUT, { recursive: true });
  writeFileSync(file, buf);
  console.log(`${file}  ${(buf.length / 1024).toFixed(0)} КБ`);
}

try {
  let list;
  for (let i = 0; i < 60; i += 1) {
    try { list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); break; }
    catch { await wait(250); }
  }
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1080, height: 1920, deviceScaleFactor: 1, mobile: false,
  });

  const base = "timeoutSec: 120, snoozeAllowed: false, volumeRamp: true, graceEnabled: false";

  /*
   * Ставим НАСТОЯЩИЙ будильник, а не проверочный.
   *
   * testAlarm показывает «⏰ Проверка будильника / Если вы это видите и слышите
   * — будильник работает»: это текст диагностики из настроек, и в карточке
   * магазина он читается как тестовая сборка. Метод schedule — тот самый путь,
   * которым расписание приходит из веб-части, так что на снимке будет ровно то,
   * что человек увидит утром. Менять текст в testAlarm ради снимка нельзя:
   * приложение от этого не должно меняться.
   */
  const настоящий = (подпись, задержкаСек = 9) => `
    Capacitor.Plugins.NewDayAlarm.schedule({
      enabled: true,
      alarms: [{
        id: 900001,
        fireAt: Date.now() + ${задержкаСек * 1000},
        title: 'Подъём',
        body: ${JSON.stringify(подпись)},
        kind: 'alarm',
        profile: 'wakeup',
        date: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
      }],
    }).then(r => JSON.stringify(r))`;

  // 1. Математика — то, чем будильник держит человека, пока он не проснётся
  await startApp();
  evalJs(`Capacitor.Plugins.NewDayAlarm.setConfig({ config: { types: ['math'], count: 2, difficulty: 2, ${base} } }).then(() => 'ok')`);
  adb('logcat', '-c');
  evalJs(настоящий('Зарядка и душ'));
  adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP');
  if (await awaitScreen()) await shot('будильник-задача');
  else console.log('  экран будильника не поднялся');

  // 2. QR — код наклеен там, куда придётся дойти
  await startApp();
  evalJs(`Capacitor.Plugins.NewDayAlarm.setConfig({ config: { types: ['qr'], count: 1, ${base}, qrValue: 'кухня', qrLabel: 'на чайнике', rescueAfterSec: 300 } }).then(() => 'ok')`);
  adb('logcat', '-c');
  evalJs(настоящий('Зарядка и душ'));
  adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP');
  if (await awaitScreen()) {
    // Камере нужно время открыться: сразу после появления экрана видоискатель
    // ещё чёрный, и подпись под ним честно говорит «Открываю камеру…»
    await wait(8000);
    // Окно проверки — сам видоискатель: доли кадра x, y, ширина, высота
    await shot('будильник-qr', [0.12, 0.48, 0.76, 0.28]);
  } else console.log('  экран QR не поднялся');

  adb('shell', 'am', 'force-stop', PKG);
} finally {
  try { ws?.close(); } catch { /* уже закрыт */ }
  chrome.kill();
  adb('emu', 'kill');
  await wait(3000);
  sh('taskkill', ['/F', '/IM', 'qemu-system-x86_64.exe']);
  try { emu.unref(); } catch { /* уже мёртв */ }
  await tmp.release(chromeDir);
}
