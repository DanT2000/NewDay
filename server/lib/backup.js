const fs = require('node:fs');
const path = require('node:path');

const KEEP = 14;

function backupDir(dbPath) {
  return path.join(path.dirname(dbPath), 'backups');
}

/** Снимок базы средствами SQLite — консистентнее, чем копирование файла. */
function runBackup(db, dbPath, stamp) {
  const dir = backupDir(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const ts = stamp || new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `newday-${ts}.db`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

  rotate(dir);
  return target;
}

function rotate(dir, keep = KEEP) {
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('newday-') && f.endsWith('.db'))
    .sort()
    .reverse();
  for (const f of files.slice(keep)) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* уже удалён */ }
  }
}

/**
 * Ежедневный бэкап плюс снимок перед применением миграций.
 * Возвращает функцию остановки таймера.
 */
function scheduleDailyBackup(db, dbPath) {
  const снять = () => {
    try { runBackup(db, dbPath); }
    catch (e) { console.error('[newday] бэкап не удался:', e.message); }
  };

  /*
   * Сначала проверяем, когда снимали в прошлый раз.
   *
   * Таймер отсчитывает сутки от запуска процесса. Контейнер, который
   * перезапускается чаще раза в сутки — выкладка, перезагрузка хоста,
   * падение, — не снимал ежедневную копию НИ РАЗУ, и заметить это было
   * нельзя: каталог не пуст, в нём лежат старые файлы.
   */
  try {
    const свежая = fs.existsSync(backupDir(dbPath))
      ? fs.readdirSync(backupDir(dbPath))
        .filter(f => f.startsWith('newday-') && f.endsWith('.db'))
        .map(f => fs.statSync(path.join(backupDir(dbPath), f)).mtimeMs)
        .sort((a, b) => b - a)[0] ?? 0
      : 0;
    if (Date.now() - свежая > 24 * 60 * 60 * 1000) снять();
  } catch (e) {
    console.error('[newday] не удалось проверить прошлые бэкапы:', e.message);
  }

  const timer = setInterval(снять, 24 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = { runBackup, rotate, scheduleDailyBackup, backupDir };
