/**
 * Временные каталоги проверок — рядом с проектом и с уборкой при любом исходе.
 *
 * Зачем не os.tmpdir(). Проверки поднимают одноразовый профиль браузера — это
 * сотни мегабайт на прогон (Cache, ShaderCache, Default). Профили создавались
 * в системном %TEMP% на диске C и не удалялись: за три дня накопилось 353
 * каталога на 34,8 ГБ, по 11,6 ГБ в день, и системный диск подошёл к концу,
 * пока рядом на диске проекта было свободно 618 ГБ. Теперь всё пишется в
 * <корень проекта>/.tmp — на тот же диск, где лежит проект.
 *
 * Системную переменную TEMP при этом не трогаем: в неё пишут все среды
 * разработки сразу, и подмена ударила бы по чужим инструментам.
 *
 * Зачем полторы секунды. Chromium отпускает файлы профиля не в момент kill, а
 * спустя доли секунды. Удаление сразу после kill падает с EBUSY, и если ошибку
 * проглотить — от профиля остаётся половина, а утечка становится невидимой.
 *
 * Зачем синхронная уборка на выходе. Половина скриптов заканчивается вызовом
 * process.exit(), и отложенный setTimeout до уборки просто не доживает —
 * ровно так и накапливались каталоги. Хук на 'exit' обязан быть синхронным,
 * поэтому пауза здесь через Atomics.wait, а не через таймер.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const TMP_ROOT = path.join(ROOT, '.tmp');

/** Столько Chromium отпускает файлы профиля после kill. */
const HOLD_MS = 1500;
/**
 * Старше суток — заведомо брошенный: прогонов такой длины не бывает, а вот
 * свежий каталог может принадлежать соседнему прогону, идущему прямо сейчас.
 */
const STALE_MS = 24 * 60 * 60 * 1000;

/** Каталоги, за которые этот процесс отвечает и ещё не убрал. */
const held = new Set();
let hooked = false;
let sweptOnce = false;

/** Настоящий синхронный сон: нужен в хуке 'exit', где таймеры уже не работают. */
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function tmpRoot() {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return TMP_ROOT;
}

/**
 * Удаление, которое доживает до конца на профилях Chromium.
 *
 * maxRetries закрывает EBUSY и EPERM от ещё не отпущенных файлов. Если и это
 * не помогло — в дело идёт robocopy: у профилей очень длинные пути, и обычное
 * рекурсивное удаление на них спотыкается, а зеркалирование пустым каталогом
 * укорачивает путь на каждом шаге.
 */
function hardRemove(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch { /* пробуем следующим способом */ }
  if (!fs.existsSync(dir)) return true;

  if (process.platform === 'win32') {
    let empty;
    try {
      // Имя латиницей: путь уходит в robocopy аргументом командной строки
      empty = fs.mkdtempSync(path.join(tmpRoot(), 'empty-'));
      spawnSync('robocopy', [empty, dir, '/MIR', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'],
        { stdio: 'ignore', windowsHide: true });
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch { /* ниже честно скажем, что не вышло */ } finally {
      if (empty) { try { fs.rmSync(empty, { recursive: true, force: true }); } catch { /* и он подождёт уборки */ } }
    }
  }
  return !fs.existsSync(dir);
}

/**
 * Сказать вслух, если убрать не удалось.
 *
 * Пустой catch — то, из-за чего утечка жила три дня незамеченной: скрипт
 * заканчивался нулевым кодом, а на диске оставались гигабайты.
 */
function warnLeft(dir) {
  process.stderr.write(
    `ВНИМАНИЕ: не удалось убрать временный каталог ${dir}\n`
    + '  Он занимает место и останется до следующего запуска — удалите вручную.\n',
  );
}

/** Убрать брошенные прогонами каталоги: старше суток и не занятые сейчас. */
function sweepStale() {
  let items;
  try { items = fs.readdirSync(TMP_ROOT, { withFileTypes: true }); } catch { return 0; }
  const now = Date.now();
  let gone = 0;
  for (const item of items) {
    if (!item.isDirectory()) continue;
    const dir = path.join(TMP_ROOT, item.name);
    if (held.has(dir)) continue;
    let age;
    try { age = now - fs.statSync(dir).mtimeMs; } catch { continue; }
    if (age < STALE_MS) continue;
    if (hardRemove(dir)) gone += 1; else warnLeft(dir);
  }
  return gone;
}

/** Синхронная уборка всего, за что отвечает процесс: хук на выход и сигналы. */
function releaseAllSync() {
  if (!held.size) return;
  sleepSync(HOLD_MS);
  for (const dir of [...held]) {
    held.delete(dir);
    if (!hardRemove(dir)) warnLeft(dir);
  }
}

function installHooks() {
  if (hooked) return;
  hooked = true;
  // 'exit' приходит и при process.exit(), и при необработанном исключении
  process.on('exit', releaseAllSync);
  /*
   * Прерванный руками прогон — один из способов, которым каталоги копились.
   * Убираем и передаём сигнал дальше: слушатель одноразовый, поэтому повторная
   * доставка сработает штатно и процесс завершится как положено.
   */
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      releaseAllSync();
      try { process.kill(process.pid, signal); } catch { process.exit(130); }
    });
  }
}

/**
 * Создать временный каталог для прогона.
 *
 * `prefix` — понятное имя без «newday-»: каталоги и так лежат в .tmp проекта.
 */
function tempDir(prefix) {
  const root = tmpRoot();
  if (!sweptOnce) { sweptOnce = true; sweepStale(); }
  installHooks();
  const dir = fs.mkdtempSync(path.join(root, `${prefix}-`));
  held.add(dir);
  return dir;
}

/**
 * Убрать каталог, дав браузеру отпустить файлы. Зовётся в finally.
 *
 * Если не позвать — уберёт хук на выходе, но лучше звать: тогда о неудаче
 * будет сказано до того, как процесс закончится.
 */
async function release(dir) {
  if (!dir) return true;
  held.delete(dir);
  await new Promise(resolve => setTimeout(resolve, HOLD_MS));
  const ok = hardRemove(dir);
  if (!ok) warnLeft(dir);
  return ok;
}

/** Синхронный вариант для тестов и мест, где await негде поставить. */
function releaseSync(dir) {
  if (!dir) return true;
  held.delete(dir);
  const ok = hardRemove(dir);
  if (!ok) warnLeft(dir);
  return ok;
}

/**
 * Путь к .tmp с гарантией, что каталог существует.
 *
 * Нужен там, где временный файл один и подкаталог заводить незачем — например
 * база локального стенда. Возвращать одну строку-константу нельзя: SQLite не
 * создаёт каталог сам и падает на несуществующем пути.
 */
function root() { return tmpRoot(); }

module.exports = { tempDir, release, releaseSync, sweepStale, root, TMP_ROOT, HOLD_MS };
