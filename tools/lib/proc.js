'use strict';

/**
 * Закрыть браузер проверки — целиком, вместе с его детьми.
 *
 * `proc.kill()` убивает только родителя. Chromium держит отдельные процессы на
 * каждую вкладку, на отрисовку и на служебные задачи; после смерти родителя они
 * остаются сиротами и продолжают держать файлы профиля. Каталог профиля из-за
 * этого не удаляется, а уборка старых каталогов ждёт сутки — за один день
 * прогонов набралось 362 сироты и 2,8 ГБ профилей.
 *
 * Дерево процессов на Windows валит taskkill /T: своего способа у Node нет,
 * process.kill умеет только один процесс. На остальных системах хватает группы.
 */

const { spawnSync } = require('child_process');
const path = require('path');

/** Столько система отпускает файлы профиля после смерти процессов. */
const RELEASE_MS = 800;

function alive(proc) {
  return Boolean(proc) && proc.exitCode === null && proc.signalCode === null;
}

/**
 * Валит всё, что относится к этому браузеру, и ждёт, пока файлы отпустят.
 *
 * `profileDir` — каталог `--user-data-dir` этого прогона. Он обязателен, и вот
 * почему. На Windows `msedge.exe`, который мы запустили, — только пускатель: он
 * поднимает настоящий браузер и сразу заканчивается сам. К моменту уборки
 * дерево процессов ему уже не принадлежит, `taskkill /T` валит пустоту, а
 * `proc.once('exit')` срабатывает мгновенно и обманывает нас: браузер жив.
 *
 * Поэтому ищем по каталогу профиля — он уникален для прогона, и всё, что его
 * упоминает, наше. Чужие окна браузера, открытые человеком, так не задеть:
 * пути к их профилям другие.
 */
async function killTree(proc, profileDir) {
  const метка = profileDir ? path.basename(profileDir) : '';

  if (alive(proc)) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
    } else {
      // группа процессов: минус перед pid. Запускали без detached — группы
      // нет, валим хотя бы сам процесс
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch { /* уже мёртв */ } }
    }
  }

  if (метка) killByProfile(метка);

  /*
   * Дать системе отпустить файлы: процесс исчезает раньше, чем закрываются
   * его дескрипторы, и удаление сразу следом падало бы с «файл занят».
   */
  await new Promise(resolve => { setTimeout(resolve, RELEASE_MS); });
  return true;
}

/** Все процессы браузера, чья команда упоминает этот профиль. */
function killByProfile(метка) {
  if (process.platform === 'win32') {
    /*
     * Через PowerShell, а не wmic: wmic из Windows 11 убран, и вызов молча
     * ничего не делал бы. Имя процесса не сужаем: Edge и Chrome называются
     * по-разному, а признак наш — путь к профилю.
     */
    const script = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '
      + `'*${метка}*' } | ForEach-Object { `
      + 'if ($_.ProcessId -ne $PID) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }';
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore', windowsHide: true,
    });
    return;
  }
  spawnSync('pkill', ['-9', '-f', метка], { stdio: 'ignore' });
}

module.exports = { killTree };
